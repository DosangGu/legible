mod common;

use std::fs;

use legible_daemon::sessions::{SessionError, SessionService, SessionStore};
use legible_protocol::{ChatStatus, DaemonEvent};

use common::record;

#[test]
fn additions_and_replacements_are_visible_only_after_a_successful_save() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    let mut service = SessionService::open(store.clone()).unwrap();
    let original = record(0);
    let mut outside = original.clone();
    let event = service.add(original.clone()).unwrap();
    assert_eq!(
        event,
        DaemonEvent::SessionAdded(Box::new(original.session.clone()))
    );
    assert_eq!(store.load_all().unwrap(), vec![original.clone()]);
    assert_eq!(
        service.registry().record(&original.session.id),
        Some(&original)
    );
    outside.session.comments.clear();
    assert_eq!(
        service.registry().record(&original.session.id),
        Some(&original)
    );

    let mut next = original;
    next.session.comments[0].body = "changed".into();
    let event = service.update_draft(next.clone(), 0).unwrap();
    assert_eq!(
        event,
        DaemonEvent::SessionUpdated(Box::new(next.session.clone()))
    );
    assert_eq!(store.load_all().unwrap(), vec![next.clone()]);
    assert_eq!(service.registry().record(&next.session.id), Some(&next));
}

#[test]
fn duplicate_additions_and_missing_replacements_do_not_write_records() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    let mut service = SessionService::open(store.clone()).unwrap();
    service.add(record(0)).unwrap();
    let path = store.path_for("draft-review").unwrap();
    let original = fs::read(&path).unwrap();
    assert!(matches!(
        service.add(record(0)),
        Err(SessionError::DuplicateSession { .. })
    ));
    assert!(matches!(
        service.replace(record(1), 0),
        Err(SessionError::SessionNotFound { .. })
    ));
    assert_eq!(fs::read(path).unwrap(), original);
    assert!(!store.path_for("claude-review").unwrap().exists());
    assert_eq!(service.registry().list().len(), 1);
}

#[test]
fn rejects_stale_and_backwards_review_revisions_before_writing() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    let mut service = SessionService::open(store.clone()).unwrap();
    service.add(record(0)).unwrap();
    let mut refreshed = record(0);
    refreshed.session.review_revision = 1;
    service.replace(refreshed.clone(), 0).unwrap();
    let path = store.path_for("draft-review").unwrap();
    let saved = fs::read(&path).unwrap();
    assert!(matches!(
        service.update_draft(refreshed.clone(), 0),
        Err(SessionError::StaleReviewRevision {
            expected: 0,
            current: 1,
            ..
        })
    ));
    assert!(matches!(
        service.replace(record(0), 1),
        Err(SessionError::RevisionWentBackwards {
            current: 1,
            next: 0,
            ..
        })
    ));
    assert!(matches!(
        service.remove_record("draft-review", 0),
        Err(SessionError::StaleReviewRevision { .. })
    ));
    assert_eq!(fs::read(path).unwrap(), saved);
    assert_eq!(service.registry().record("draft-review"), Some(&refreshed));
}

#[test]
fn draft_mutations_reject_archived_and_deleting_reviews_but_metadata_can_restore_them() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    let mut service = SessionService::open(store).unwrap();
    let mut archived = record(0);
    archived.session.archived_at = Some("2026-10-03T01:00:00.000Z".into());
    service.add(archived.clone()).unwrap();
    assert!(matches!(
        service.update_draft(archived.clone(), 0),
        Err(SessionError::ReviewArchived { .. })
    ));
    archived.session.deletion_requested_at = archived.session.archived_at.clone();
    service.replace(archived.clone(), 0).unwrap();
    assert!(matches!(
        service.update_draft(archived, 0),
        Err(SessionError::ReviewDeleting { .. })
    ));
    service.replace(record(0), 0).unwrap();
    service
        .registry()
        .assert_mutable("draft-review", 0)
        .unwrap();
    assert!(matches!(
        service.registry().assert_mutable("missing", 0),
        Err(SessionError::SessionNotFound { .. })
    ));
}

#[test]
fn invalid_or_failed_saves_preserve_the_registry_and_return_no_lifecycle_event() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    let mut service = SessionService::open(store.clone()).unwrap();
    let original = record(0);
    service.add(original.clone()).unwrap();
    let path = store.path_for("draft-review").unwrap();
    let bytes = fs::read(&path).unwrap();
    let mut malformed = original.clone();
    malformed.session.archived_at = Some("not a date".into());
    assert!(matches!(
        service.replace(malformed, 0),
        Err(SessionError::Store(_))
    ));
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(service.registry().record("draft-review"), Some(&original));

    let backup = root.path().join("previous-record.bak");
    fs::rename(&path, &backup).unwrap();
    fs::create_dir(&path).unwrap();
    let mut changed = original.clone();
    changed.session.comments.clear();
    assert!(matches!(
        service.update_draft(changed, 0),
        Err(SessionError::Store(_))
    ));
    assert_eq!(service.registry().record("draft-review"), Some(&original));
    assert_eq!(fs::read(backup).unwrap(), bytes);
    assert!(path.is_dir());
}

#[test]
fn failed_additions_never_take_registry_ownership() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    let mut service = SessionService::open(store.clone()).unwrap();
    fs::create_dir(store.path_for("draft-review").unwrap()).unwrap();
    assert!(matches!(
        service.add(record(0)),
        Err(SessionError::Store(_))
    ));
    assert!(service.registry().get("draft-review").is_none());
}

#[test]
fn metadata_removal_finishes_on_disk_before_releasing_registry_ownership() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    let mut service = SessionService::open(store.clone()).unwrap();
    service.add(record(0)).unwrap();
    let path = store.path_for("draft-review").unwrap();
    let backup = root.path().join("previous-record.bak");
    fs::rename(&path, &backup).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(matches!(
        service.remove_record("draft-review", 0),
        Err(SessionError::Store(_))
    ));
    assert!(service.registry().get("draft-review").is_some());
    fs::remove_dir(&path).unwrap();
    fs::rename(&backup, &path).unwrap();
    assert!(matches!(
        service.remove_record("draft-review", 0),
        Ok(DaemonEvent::SessionRemoved(_))
    ));
    assert!(!path.exists());
    assert!(service.registry().get("draft-review").is_none());
    assert!(matches!(
        service.remove_record("draft-review", 0),
        Err(SessionError::SessionNotFound { .. })
    ));
}

#[test]
fn restores_all_records_in_id_order_and_recovers_active_chat_without_rewriting_files() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    for index in [2, 0, 1] {
        store.save(&record(index)).unwrap();
    }
    let active_path = store.path_for("codex-review").unwrap();
    let original = fs::read(&active_path).unwrap();
    let service = SessionService::open(store).unwrap();
    let ids: Vec<_> = service
        .registry()
        .list()
        .map(|session| session.id.as_str())
        .collect();
    assert_eq!(ids, ["claude-review", "codex-review", "draft-review"]);
    assert_eq!(service.registry().record("draft-review"), Some(&record(0)));
    assert_eq!(service.registry().record("claude-review"), Some(&record(1)));
    let chat = service.registry().chat("codex-review").unwrap();
    assert_eq!(chat.snapshot.status, ChatStatus::Failed);
    assert_eq!(chat.snapshot.revision, 10);
    assert_eq!(chat.active, None);
    assert_eq!(chat.retry, record(2).chat.unwrap().active);
    assert_eq!(fs::read(active_path).unwrap(), original);
}

#[test]
fn failed_initialization_does_not_publish_or_rewrite_partially_restored_state() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    store.save(&record(2)).unwrap();
    let active_path = store.path_for("codex-review").unwrap();
    let original = fs::read(&active_path).unwrap();
    let broken_path = store.path_for("zzz-broken").unwrap();
    fs::write(&broken_path, b"{\"version\":1}").unwrap();
    assert!(matches!(
        SessionService::open(store),
        Err(SessionError::Store(_))
    ));
    assert_eq!(fs::read(active_path).unwrap(), original);
    assert_eq!(fs::read(broken_path).unwrap(), b"{\"version\":1}");
}

#[test]
fn recovery_failure_does_not_rewrite_any_loaded_record() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    let mut exhausted = record(2);
    exhausted.chat.as_mut().unwrap().snapshot.revision = 9_007_199_254_740_991;
    store.save(&record(1)).unwrap();
    store.save(&exhausted).unwrap();
    let path = store.path_for("codex-review").unwrap();
    let original = fs::read(&path).unwrap();
    assert!(matches!(
        SessionService::open(store),
        Err(SessionError::Recovery(_))
    ));
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn explicit_flush_checkpoints_recovery_so_next_open_does_not_add_another_notice() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    store.save(&record(2)).unwrap();
    let first = SessionService::open(store.clone()).unwrap();
    let recovered = first.registry().record("codex-review").unwrap().clone();
    first.flush().unwrap();
    assert_eq!(store.load_all().unwrap(), vec![recovered.clone()]);
    let second = SessionService::open(store).unwrap();
    assert_eq!(second.registry().record("codex-review"), Some(&recovered));
}

#[test]
fn flush_attempts_other_records_and_reports_all_failures() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    for index in [0, 1, 2] {
        store.save(&record(index)).unwrap();
    }
    let service = SessionService::open(store.clone()).unwrap();
    for id in ["claude-review", "draft-review"] {
        let path = store.path_for(id).unwrap();
        fs::rename(&path, root.path().join(format!("{id}.bak"))).unwrap();
        fs::create_dir(&path).unwrap();
    }
    let SessionError::Flush(errors) = service.flush().unwrap_err() else {
        panic!("expected aggregated save errors")
    };
    assert_eq!(errors.len(), 2);
    assert!(
        errors
            .iter()
            .any(|error| error.path() == store.path_for("claude-review").unwrap())
    );
    assert!(
        errors
            .iter()
            .any(|error| error.path() == store.path_for("draft-review").unwrap())
    );
    let saved: legible_daemon::sessions::PersistedSessionRecord =
        serde_json::from_slice(&fs::read(store.path_for("codex-review").unwrap()).unwrap())
            .unwrap();
    assert_eq!(saved, *service.registry().record("codex-review").unwrap());
    assert_eq!(saved.chat.unwrap().snapshot.status, ChatStatus::Failed);
}
