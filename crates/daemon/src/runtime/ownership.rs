use std::{
    fs::{self, DirBuilder, File, Metadata, OpenOptions},
    io,
    net::{SocketAddr, TcpListener as StdTcpListener},
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        net::UnixListener as StdUnixListener,
    },
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use rustix::{
    fs::{FlockOperation, flock},
    process::geteuid,
};
use tokio::{
    net::{TcpListener, UnixListener, UnixStream},
    time::timeout,
};

use crate::api::bind_loopback;

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Stable lock inode plus pinned listener descriptors survive until storage work is finished.
/// The lock file is deliberately retained: unlinking a held lock can create two lock domains.
pub(super) struct Ownership {
    _http: StdTcpListener,
    _control: StdUnixListener,
    socket: SocketGuard,
    pub(super) root: PathBuf,
    pub(super) address: SocketAddr,
    // Fields drop in declaration order: retain the lock through listener/socket guard cleanup.
    _lock: File,
}

impl Ownership {
    pub(super) async fn claim(
        root: PathBuf,
        port: u16,
    ) -> io::Result<(Arc<Self>, TcpListener, UnixListener)> {
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let http = bind_loopback(address).await?.into_std()?;
        let address = http.local_addr()?;
        let (root, lock) = tokio::task::spawn_blocking(move || claim_directory(root))
            .await
            .map_err(io::Error::other)??;
        let path = socket_path(&root)?;

        reclaim_stale_socket(&path).await?;
        let control = StdUnixListener::bind(&path)?;
        let identity = fs::symlink_metadata(&path)?;
        let socket = SocketGuard { path, identity };
        fs::set_permissions(&socket.path, fs::Permissions::from_mode(0o600))?;
        control.set_nonblocking(true)?;

        let served_http = TcpListener::from_std(http.try_clone()?)?;
        let served_control = UnixListener::from_std(control.try_clone()?)?;
        let ownership = Self {
            _lock: lock,
            _http: http,
            _control: control,
            socket,
            root,
            address,
        };

        Ok((Arc::new(ownership), served_http, served_control))
    }

    pub(super) fn release_socket(&self) -> io::Result<()> {
        self.socket.release()
    }
}

pub(super) fn socket_path(root: &Path) -> io::Result<PathBuf> {
    let path = root.join("daemon.sock");

    if path.as_os_str().len() > 103 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "State path is too long for a Unix socket",
        ));
    }

    Ok(path)
}

fn claim_directory(root: PathBuf) -> io::Result<(PathBuf, File)> {
    inspect_existing_parents(&root)?;
    let mut builder = DirBuilder::new();
    builder.recursive(true).mode(0o700).create(&root)?;
    private_directory(&root)?;
    let root = root.canonicalize()?;
    let path = root.join("daemon.lock");

    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)?;
    let metadata = lock.metadata()?;

    if !metadata.is_file() || metadata.uid() != current_uid() || metadata.mode() & 0o777 != 0o600 {
        return Err(unsafe_path(
            "Daemon lock must be a private regular file owned by the current user",
        ));
    }

    flock(&lock, FlockOperation::NonBlockingLockExclusive).map_err(|error| {
        if error == rustix::io::Errno::WOULDBLOCK {
            io::Error::new(
                io::ErrorKind::AddrInUse,
                "A daemon already owns this state directory",
            )
        } else {
            io::Error::from(error)
        }
    })?;

    if !same_inode(&metadata, &fs::symlink_metadata(&path)?) {
        return Err(unsafe_path("Daemon lock changed during startup"));
    }

    Ok((root, lock))
}

fn inspect_existing_parents(root: &Path) -> io::Result<()> {
    if root.parent().is_none() {
        return Err(unsafe_path(
            "A filesystem root cannot be a daemon state directory",
        ));
    }

    for path in root.ancestors() {
        match fs::symlink_metadata(path) {
            Ok(metadata) => {
                if path == root && !metadata.is_dir() {
                    return Err(unsafe_path(
                        "State directory cannot be a symlink or regular file",
                    ));
                }

                let existing = path.canonicalize()?;
                for parent in existing.ancestors() {
                    let metadata = fs::metadata(parent)?;
                    let owner = metadata.uid();
                    let writable = metadata.mode() & 0o022 != 0;
                    let sticky_root = owner == 0 && metadata.mode() & 0o1000 != 0;

                    if (owner != 0 && owner != current_uid()) || (writable && !sticky_root) {
                        return Err(unsafe_path("State directory has an unsafe parent"));
                    }
                }

                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        }
    }

    Err(unsafe_path("State directory has no existing parent"))
}

pub(super) fn private_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;

    if !metadata.is_dir() || metadata.uid() != current_uid() || metadata.mode() & 0o777 != 0o700 {
        return Err(unsafe_path(
            "State directory must be a private directory (0700) owned by the current user",
        ));
    }

    Ok(())
}

pub(super) fn inspect_socket(path: &Path) -> io::Result<Option<Metadata>> {
    private_directory(
        path.parent()
            .ok_or_else(|| unsafe_path("Invalid socket parent"))?,
    )?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    if !metadata.file_type().is_socket()
        || metadata.uid() != current_uid()
        || metadata.mode() & 0o777 != 0o600
    {
        return Err(unsafe_path("Refusing an unsafe daemon socket"));
    }

    Ok(Some(metadata))
}

async fn reclaim_stale_socket(path: &Path) -> io::Result<()> {
    let Some(previous) = inspect_socket(path)? else {
        return Ok(());
    };
    let probe = timeout(PROBE_TIMEOUT, UnixStream::connect(path)).await;

    match probe {
        Ok(Err(error)) if error.kind() == io::ErrorKind::ConnectionRefused => {}
        Ok(Err(error)) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Ok(Err(error)) => return Err(error),
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "A live or unresponsive control socket owns this state directory",
            ));
        }
    }

    let Some(current) = inspect_socket(path)? else {
        return Ok(());
    };
    if !same_inode(&previous, &current) {
        return Err(unsafe_path("Control socket changed during startup"));
    }

    fs::remove_file(path)
}

struct SocketGuard {
    path: PathBuf,
    identity: Metadata,
}

impl SocketGuard {
    fn release(&self) -> io::Result<()> {
        private_directory(
            self.path
                .parent()
                .ok_or_else(|| unsafe_path("Invalid socket parent"))?,
        )?;
        let current = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };

        if !current.file_type().is_socket()
            || current.uid() != current_uid()
            || !same_inode(&self.identity, &current)
        {
            return Err(unsafe_path(
                "Control socket was replaced; leaving it untouched",
            ));
        }

        fs::remove_file(&self.path)
    }
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

pub(super) fn current_uid() -> u32 {
    geteuid().as_raw()
}

fn same_inode(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

fn unsafe_path(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cleanup_preserves_a_replacement_at_the_owned_socket_path() {
        let root = tempfile::Builder::new().prefix("lg").tempdir().unwrap();
        let directory = root.path().canonicalize().unwrap().join("state");
        let (ownership, http, control) = Ownership::claim(directory.clone(), 0).await.unwrap();
        let path = socket_path(&directory).unwrap();
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"contributor replacement").unwrap();

        assert_eq!(
            ownership.release_socket().unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        drop(http);
        drop(control);
        drop(ownership);

        assert_eq!(fs::read(path).unwrap(), b"contributor replacement");
    }
}
