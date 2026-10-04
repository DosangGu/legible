use std::fs;
use std::path::Path;

use legible_daemon::sessions::{PersistedChatRequest, PersistedSessionRecord, SessionStore};
use legible_protocol::{AgentBackendKind, ChatStatus};
use serde_json::{Value, json};

fn fixtures() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/session-records.json")).unwrap()
}

fn record(index: usize) -> PersistedSessionRecord {
    serde_json::from_value(fixtures()[index].clone()).unwrap()
}

fn store(root: &Path) -> SessionStore {
    SessionStore::new(root).unwrap()
}

#[test]
fn loads_current_records_without_changing_their_contents() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    assert!(store.load_all().unwrap().is_empty());
    let fixtures = fixtures();
    for fixture in &fixtures {
        fs::write(
            store
                .path_for(fixture["session"]["id"].as_str().unwrap())
                .unwrap(),
            serde_json::to_vec(fixture).unwrap(),
        )
        .unwrap();
    }
    let loaded = store.load_all().unwrap();
    let mut expected = fixtures.clone();
    expected.sort_by(|a, b| {
        a["session"]["id"]
            .as_str()
            .cmp(&b["session"]["id"].as_str())
    });
    assert_eq!(serde_json::to_value(loaded).unwrap(), json!(expected));
    for fixture in fixtures {
        let path = store
            .path_for(fixture["session"]["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            fs::read(path).unwrap(),
            serde_json::to_vec(&fixture).unwrap()
        );
    }
}

#[test]
fn saves_the_current_format_with_an_explicit_initial_revision() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let draft = record(0);
    assert_eq!(draft.version(), 1);
    assert_eq!(draft.session.review_revision, 0);
    store.save(&draft).unwrap();
    let bytes = fs::read(store.path_for(&draft.session.id).unwrap()).unwrap();
    assert!(bytes.ends_with(b"\n"));
    let saved: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(saved["version"], 1);
    assert_eq!(saved["session"]["reviewRevision"], 0);
    assert!(saved.get("chat").is_none());
    assert_eq!(store.load_all().unwrap(), vec![draft]);
}

#[test]
fn round_trips_drafts_receipts_and_chat_for_both_backends() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    for index in 0..3 {
        let record = record(index);
        store.save(&record).unwrap();
        let stored: Value =
            serde_json::from_slice(&fs::read(store.path_for(&record.session.id).unwrap()).unwrap())
                .unwrap();
        assert_eq!(stored, fixtures()[index]);
    }
    assert_eq!(
        record(1).chat.unwrap().snapshot.backend,
        AgentBackendKind::Claude
    );
    assert_eq!(
        record(2).chat.unwrap().snapshot.backend,
        AgentBackendKind::Codex
    );
}

#[test]
fn loading_an_active_request_does_not_start_or_rewrite_a_turn() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let active = record(2);
    store.save(&active).unwrap();
    let loaded = store.load_all().unwrap().pop().unwrap();
    assert_eq!(loaded, active);
    let chat = loaded.chat.unwrap();
    assert_eq!(chat.snapshot.status, ChatStatus::Running);
    assert!(matches!(
        chat.active,
        Some(PersistedChatRequest::Message {
            item_id: Some(_),
            ..
        })
    ));
    assert!(matches!(
        record(1).chat.unwrap().retry,
        Some(PersistedChatRequest::Review)
    ));
}

#[test]
fn replacing_a_record_leaves_no_temporary_files() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let mut record = record(0);
    store.save(&record).unwrap();
    record.session.comments[0].body = "수정된 초안".into();
    store.save(&record).unwrap();
    assert_eq!(store.load_all().unwrap(), vec![record]);
    assert_eq!(
        fs::read_dir(root.path().join("sessions")).unwrap().count(),
        1
    );
}

#[test]
fn concurrent_readers_only_observe_complete_records_during_replacement() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let initial = record(0);
    store.save(&initial).unwrap();
    let replacement = "updated".repeat(1024);
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let mut record = initial.clone();
            barrier.wait();
            for index in 0..40 {
                record.session.comments[0].body = if index % 2 == 0 {
                    replacement.clone()
                } else {
                    initial.session.comments[0].body.clone()
                };
                store.save(&record).unwrap();
            }
        });
        barrier.wait();
        for _ in 0..40 {
            let records = store.load_all().unwrap();
            assert_eq!(records.len(), 1);
            let body = &records[0].session.comments[0].body;
            assert!(body == &initial.session.comments[0].body || body == &replacement);
        }
    });
}

#[test]
fn ignores_abandoned_temporary_files_and_sorts_by_filename() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    store.save(&record(1)).unwrap();
    store.save(&record(2)).unwrap();
    store.save(&record(0)).unwrap();
    fs::write(
        root.path().join("sessions/.legible-abandoned.tmp"),
        b"not json",
    )
    .unwrap();
    fs::write(root.path().join("sessions/notes.txt"), b"not json").unwrap();
    let ids: Vec<_> = store
        .load_all()
        .unwrap()
        .into_iter()
        .map(|record| record.session.id)
        .collect();
    assert_eq!(ids, ["claude-review", "codex-review", "draft-review"]);
}

#[test]
fn rejects_corrupt_and_non_current_records_with_the_offending_path() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    store.save(&record(0)).unwrap();
    let path = store.path_for("broken").unwrap();
    for bytes in [b"{".as_slice(), b"{\"version\":1}".as_slice()] {
        fs::write(&path, bytes).unwrap();
        let error = store.load_all().unwrap_err();
        assert_eq!(error.path(), path);
        assert!(error.to_string().contains(path.to_str().unwrap()));
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    for version in [0, 2, 3, 255] {
        let mut unsupported = fixtures()[0].clone();
        unsupported["version"] = json!(version);
        fs::write(&path, serde_json::to_vec(&unsupported).unwrap()).unwrap();
        assert_eq!(store.load_all().unwrap_err().path(), path);
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
            unsupported
        );
    }
}

#[test]
fn rejects_unknown_fields_instead_of_silently_dropping_them() {
    for pointer in [
        "",
        "/session",
        "/session/config/main",
        "/chat",
        "/chat/snapshot",
        "/chat/active",
        "/session/comments/0",
    ] {
        let mut fixture = fixtures()[2].clone();
        fixture
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("futureField".into(), json!(true));
        let error = serde_json::from_value::<PersistedSessionRecord>(fixture).unwrap_err();
        assert!(error.to_string().contains("unsupported fields"));
    }
}

#[test]
fn rejects_invalid_archival_revision_and_request_metadata() {
    let mutations = [
        ("/session/archivedAt", json!("")),
        ("/session/archivedAt", json!("not a date")),
        ("/session/deletionRequestedAt", json!("not a date")),
        ("/session/reviewRevision", json!(-1)),
        ("/session/reviewRevision", json!(9_007_199_254_740_992_u64)),
        (
            "/session/comments/0/anchorRevision",
            json!(9_007_199_254_740_992_u64),
        ),
        (
            "/session/submissionHistory/0/reviewRevision",
            json!(9_007_199_254_740_992_u64),
        ),
        ("/session/worktreeGeneration", json!("generation-2")),
        (
            "/session/worktreeGeneration",
            json!("12345678-1234-1234-1234-123456789ABC"),
        ),
        ("/session/config/main/backend", json!("other")),
        ("/chat/snapshot/sessionId", json!("different-session")),
        ("/chat/snapshot/status", json!("unknown")),
        ("/chat/snapshot/revision", json!(9_007_199_254_740_992_u64)),
        ("/chat/active/kind", json!("unknown")),
        ("/chat/active/message", Value::Null),
        ("/chat/retry", Value::Null),
    ];
    for (pointer, value) in mutations {
        let mut fixture = fixtures()[2].clone();
        *fixture.pointer_mut(pointer).unwrap() = value;
        assert!(
            serde_json::from_value::<PersistedSessionRecord>(fixture).is_err(),
            "accepted {pointer}"
        );
    }
    let mut fixture = fixtures()[2].clone();
    fixture["session"]
        .as_object_mut()
        .unwrap()
        .remove("archivedAt");
    assert!(serde_json::from_value::<PersistedSessionRecord>(fixture).is_err());
    let mut fixture = fixtures()[0].clone();
    fixture["session"]
        .as_object_mut()
        .unwrap()
        .remove("reviewRevision");
    assert!(serde_json::from_value::<PersistedSessionRecord>(fixture).is_err());
}

#[test]
fn requires_completed_receipts_in_submission_history() {
    let mut fixture = fixtures()[2].clone();
    fixture["session"]["submissionHistory"][0]["submission"]["status"] = json!("submitting");
    assert!(serde_json::from_value::<PersistedSessionRecord>(fixture).is_err());
}

#[test]
fn invalid_saves_preserve_the_previous_record() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let mut record = record(2);
    store.save(&record).unwrap();
    let path = store.path_for(&record.session.id).unwrap();
    let original = fs::read(&path).unwrap();
    record.session.archived_at = Some("not a date".into());
    assert_eq!(store.save(&record).unwrap_err().path(), path);
    assert_eq!(fs::read(path).unwrap(), original);
    assert_eq!(
        fs::read_dir(root.path().join("sessions")).unwrap().count(),
        1
    );
}

#[test]
fn rejects_path_traversal_for_every_operation() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    for id in [
        "",
        ".",
        "..",
        "../escape",
        "nested/id",
        "nested\\id",
        "/absolute",
        "한글",
        "id.json",
    ] {
        assert!(store.path_for(id).is_err());
        assert!(store.remove(id).is_err());
        let mut record = record(0);
        record.session.id = id.into();
        assert!(store.save(&record).is_err());
    }
    assert!(!root.path().join("sessions").exists());
    assert!(store.path_for("Valid_ID-123").is_ok());
}

#[test]
fn rejects_a_record_whose_id_does_not_match_its_filename() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    store.load_all().unwrap();
    let path = store.path_for("different").unwrap();
    fs::write(&path, serde_json::to_vec(&fixtures()[0]).unwrap()).unwrap();
    assert_eq!(store.load_all().unwrap_err().path(), path);
}

#[test]
fn removal_is_idempotent_and_does_not_touch_other_records() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    store.remove("absent").unwrap();
    assert!(!root.path().join("sessions").exists());
    store.save(&record(0)).unwrap();
    store.save(&record(1)).unwrap();
    store.remove("draft-review").unwrap();
    store.remove("draft-review").unwrap();
    assert_eq!(store.load_all().unwrap(), vec![record(1)]);
}

#[cfg(unix)]
#[test]
fn restricts_directory_and_record_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let directory = root.path().join("sessions");
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    store.save(&record(0)).unwrap();
    assert_eq!(
        fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(store.path_for("draft-review").unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[cfg(unix)]
#[test]
fn refuses_linked_directories_without_changing_their_permissions() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::set_permissions(outside.path(), fs::Permissions::from_mode(0o755)).unwrap();
    symlink(outside.path(), root.path().join("sessions")).unwrap();
    let store = store(root.path());
    assert!(store.load_all().is_err());
    assert!(store.save(&record(0)).is_err());
    assert!(store.remove("draft-review").is_err());
    assert_eq!(
        fs::metadata(outside.path()).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn refuses_linked_records_without_reading_overwriting_or_removing_them() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    let original = serde_json::to_vec(&fixtures()[0]).unwrap();
    fs::write(outside.path(), &original).unwrap();
    let store = store(root.path());
    store.load_all().unwrap();
    let target = store.path_for("draft-review").unwrap();
    symlink(outside.path(), &target).unwrap();
    assert_eq!(store.load_all().unwrap_err().path(), target);
    assert!(store.save(&record(0)).is_err());
    assert!(store.remove("draft-review").is_err());
    assert!(
        fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read(outside.path()).unwrap(), original);
}
