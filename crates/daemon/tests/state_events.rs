mod common;

use std::{fs, time::Duration};

use legible_daemon::{
    sessions::{SessionError, SessionService, SessionStore},
    state::{DaemonState, EventSubscription, StateError},
};
use legible_protocol::{ChatStatus, DaemonEvent, DaemonStatus, PreflightReport};
use tempfile::TempDir;
use tokio::{sync::broadcast::error::TryRecvError, time::timeout};

const TEST_TIMEOUT: Duration = Duration::from_secs(5);

struct Fixture {
    _root: TempDir,
    store: SessionStore,
    state: DaemonState,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let store = SessionStore::new(root.path()).unwrap();
        let service = SessionService::open(store.clone()).unwrap();
        let state = DaemonState::start(service, report()).unwrap();

        Self {
            _root: root,
            store,
            state,
        }
    }
}

fn report() -> PreflightReport {
    PreflightReport {
        status: DaemonStatus::Ready,
        checked_at: "2026-10-04T00:00:00.000Z".into(),
        checks: Vec::new(),
    }
}

async fn next_event(subscription: &mut EventSubscription) -> DaemonEvent {
    timeout(TEST_TIMEOUT, subscription.events.recv())
        .await
        .unwrap()
        .unwrap()
        .event
        .clone()
}

#[tokio::test]
async fn successful_changes_are_durable_and_readable_before_their_events() {
    let fixture = Fixture::new();
    let mut subscription = fixture.state.subscribe().await.unwrap();
    let original = common::record(0);

    fixture.state.add(original.clone()).await.unwrap();
    let event = next_event(&mut subscription).await;

    assert_eq!(
        event,
        DaemonEvent::SessionAdded(Box::new(original.session.clone()))
    );
    assert_eq!(fixture.store.load_all().unwrap(), vec![original.clone()]);
    assert_eq!(
        fixture.state.sessions().await.unwrap(),
        vec![original.session.clone()]
    );

    let mut changed = original;
    changed.session.comments[0].body = "수정한 초안".into();
    fixture
        .state
        .update_draft(changed.clone(), 0)
        .await
        .unwrap();

    let envelope = subscription.events.recv().await.unwrap();

    assert_eq!(envelope.sequence, 2);
    assert_eq!(
        envelope.event,
        DaemonEvent::SessionUpdated(Box::new(changed.session.clone()))
    );
    assert_eq!(fixture.store.load_all().unwrap(), vec![changed]);
    assert!(chrono::DateTime::parse_from_rfc3339(&envelope.emitted_at).is_ok());
}

#[tokio::test]
async fn failed_saves_do_not_change_state_publish_events_or_consume_sequence_numbers() {
    let fixture = Fixture::new();
    fixture.state.add(common::record(0)).await.unwrap();
    let mut subscription = fixture.state.subscribe().await.unwrap();
    let path = fixture.store.path_for("draft-review").unwrap();
    let backup = fixture._root.path().join("previous-record.bak");
    fs::rename(&path, &backup).unwrap();
    fs::create_dir(&path).unwrap();

    let mut changed = common::record(0);
    changed.session.comments.clear();
    let result = fixture.state.update_draft(changed.clone(), 0).await;

    assert!(matches!(
        result,
        Err(StateError::Session(SessionError::Store(_)))
    ));
    assert!(matches!(
        subscription.events.try_recv(),
        Err(TryRecvError::Empty)
    ));
    assert_eq!(
        fixture.state.sessions().await.unwrap(),
        vec![common::record(0).session]
    );
    assert_eq!(
        fixture.state.subscribe().await.unwrap().snapshot.sequence,
        1
    );

    fs::remove_dir(&path).unwrap();
    fs::rename(&backup, &path).unwrap();
    fixture.state.update_draft(changed, 0).await.unwrap();

    assert_eq!(subscription.events.recv().await.unwrap().sequence, 2);
}

#[tokio::test]
async fn failed_removals_keep_ownership_and_successful_removals_publish_after_disk_cleanup() {
    let fixture = Fixture::new();
    fixture.state.add(common::record(0)).await.unwrap();
    let mut subscription = fixture.state.subscribe().await.unwrap();
    let path = fixture.store.path_for("draft-review").unwrap();
    let backup = fixture._root.path().join("previous-record.bak");
    fs::rename(&path, &backup).unwrap();
    fs::create_dir(&path).unwrap();

    let result = fixture.state.remove_record("draft-review", 0).await;

    assert!(matches!(
        result,
        Err(StateError::Session(SessionError::Store(_)))
    ));
    assert!(
        fixture
            .state
            .session("draft-review")
            .await
            .unwrap()
            .is_some()
    );
    assert!(matches!(
        subscription.events.try_recv(),
        Err(TryRecvError::Empty)
    ));

    fs::remove_dir(&path).unwrap();
    fs::rename(&backup, &path).unwrap();
    fixture
        .state
        .remove_record("draft-review", 0)
        .await
        .unwrap();

    assert!(matches!(
        next_event(&mut subscription).await,
        DaemonEvent::SessionRemoved(_)
    ));
    assert!(!path.exists());
    assert!(
        fixture
            .state
            .session("draft-review")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn revision_and_archive_guards_still_apply_on_the_async_owner() {
    let fixture = Fixture::new();
    fixture.state.add(common::record(0)).await.unwrap();
    let mut changed = common::record(0);
    changed.session.review_revision = 1;
    changed.session.archived_at = Some("2026-10-04T00:00:00.000Z".into());
    fixture.state.replace(changed.clone(), 0).await.unwrap();
    let mut subscription = fixture.state.subscribe().await.unwrap();

    let stale = fixture.state.update_draft(changed.clone(), 0).await;
    let archived = fixture.state.update_draft(changed.clone(), 1).await;
    let backwards = fixture.state.replace(common::record(0), 1).await;

    assert!(matches!(
        stale,
        Err(StateError::Session(
            SessionError::StaleReviewRevision { .. }
        ))
    ));
    assert!(matches!(
        archived,
        Err(StateError::Session(SessionError::ReviewArchived { .. }))
    ));
    assert!(matches!(
        backwards,
        Err(StateError::Session(
            SessionError::RevisionWentBackwards { .. }
        ))
    ));
    assert_eq!(fixture.store.load_all().unwrap(), vec![changed]);
    assert!(matches!(
        subscription.events.try_recv(),
        Err(TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn snapshots_and_subscriptions_have_no_gap_when_racing_with_a_mutation() {
    let fixture = Fixture::new();
    fixture.state.add(common::record(0)).await.unwrap();

    for revision in 1..=20 {
        let mut changed = common::record(0);
        changed.session.review_revision = revision;
        let (subscription, mutation) = tokio::join!(
            fixture.state.subscribe(),
            fixture.state.replace(changed.clone(), revision - 1),
        );
        mutation.unwrap();
        let mut subscription = subscription.unwrap();
        let DaemonEvent::Snapshot(snapshot) = subscription.snapshot.event else {
            panic!("subscription must begin with a snapshot");
        };

        if subscription.snapshot.sequence == revision {
            assert_eq!(snapshot.sessions[0].review_revision, revision - 1);
            let event = subscription.events.recv().await.unwrap();
            assert_eq!(event.sequence, revision + 1);
            assert_eq!(
                event.event,
                DaemonEvent::SessionUpdated(Box::new(changed.session))
            );
        } else {
            assert_eq!(subscription.snapshot.sequence, revision + 1);
            assert_eq!(snapshot.sessions[0], changed.session);
            assert!(matches!(
                subscription.events.try_recv(),
                Err(TryRecvError::Empty)
            ));
        }
    }
}

#[tokio::test]
async fn every_subscriber_observes_one_order_and_snapshots_do_not_advance_it() {
    let fixture = Fixture::new();
    let mut first = fixture.state.subscribe().await.unwrap();
    let mut second = fixture.state.subscribe().await.unwrap();

    assert_eq!(first.snapshot.sequence, 0);
    assert_eq!(second.snapshot.sequence, 0);

    fixture.state.add(common::record(1)).await.unwrap();
    fixture.state.add(common::record(0)).await.unwrap();
    let mut updated = report();
    updated.status = DaemonStatus::Degraded;
    fixture
        .state
        .update_preflight(updated.clone())
        .await
        .unwrap();

    for sequence in 1..=3 {
        let left = first.events.recv().await.unwrap();
        let right = second.events.recv().await.unwrap();

        assert_eq!(left.sequence, sequence);
        assert_eq!(left, right);
    }

    let subscription = fixture.state.subscribe().await.unwrap();
    let DaemonEvent::Snapshot(snapshot) = subscription.snapshot.event else {
        panic!()
    };

    assert_eq!(subscription.snapshot.sequence, 3);
    assert_eq!(snapshot.preflight, updated);
    assert_eq!(snapshot.sessions[0].id, "claude-review");
    assert_eq!(snapshot.sessions[1].id, "draft-review");
}

#[tokio::test]
async fn disconnecting_all_subscribers_does_not_remove_state_or_stop_mutations() {
    let fixture = Fixture::new();
    let subscription = fixture.state.subscribe().await.unwrap();
    drop(subscription);

    fixture.state.add(common::record(0)).await.unwrap();
    fixture.state.add(common::record(1)).await.unwrap();

    let reconnect = fixture.state.subscribe().await.unwrap();
    let DaemonEvent::Snapshot(snapshot) = reconnect.snapshot.event else {
        panic!()
    };

    assert_eq!(reconnect.snapshot.sequence, 2);
    assert_eq!(snapshot.sessions.len(), 2);
    assert_eq!(fixture.store.load_all().unwrap().len(), 2);
}

#[tokio::test]
async fn lag_is_detected_without_blocking_the_owner_and_reconnect_gets_current_state() {
    let fixture = Fixture::new();
    let mut subscription = fixture.state.subscribe().await.unwrap();

    for _ in 0..129 {
        fixture.state.update_preflight(report()).await.unwrap();
    }

    assert!(matches!(
        subscription.events.try_recv(),
        Err(TryRecvError::Lagged(1))
    ));
    let reconnect = fixture.state.subscribe().await.unwrap();

    assert_eq!(reconnect.snapshot.sequence, 129);
    assert_eq!(fixture.state.preflight().await.unwrap(), report());
}

#[tokio::test]
async fn restored_chat_is_readable_without_writing_until_an_explicit_checkpoint() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    store.save(&common::record(2)).unwrap();
    let path = store.path_for("codex-review").unwrap();
    let original = fs::read(&path).unwrap();
    let service = SessionService::open(store.clone()).unwrap();
    let state = DaemonState::start(service, report()).unwrap();
    let view = state.session("codex-review").await.unwrap().unwrap();
    let recovered = view.chat.unwrap();

    assert_eq!(recovered.status, ChatStatus::Failed);
    assert_eq!(recovered.revision, 10);
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(state.subscribe().await.unwrap().snapshot.sequence, 0);

    state.flush().await.unwrap();
    let restarted = SessionService::open(store).unwrap();

    assert_eq!(
        restarted.registry().chat("codex-review").unwrap().snapshot,
        recovered
    );
}

#[tokio::test]
async fn dropping_all_owner_handles_closes_the_event_channel() {
    let fixture = Fixture::new();
    let mut subscription = fixture.state.subscribe().await.unwrap();
    drop(fixture.state);

    let result = timeout(TEST_TIMEOUT, subscription.events.recv())
        .await
        .unwrap();

    assert!(matches!(
        result,
        Err(tokio::sync::broadcast::error::RecvError::Closed)
    ));
}
