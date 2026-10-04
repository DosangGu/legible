mod common;

use legible_daemon::sessions::{ChatRecoveryError, PersistedChatRequest, recover_chat};
use legible_protocol::{ChatEntry, ChatStatus, NoticeLevel, ToolStatus};

use common::record;

const RESTORED_AT: &str = "2026-10-03T01:00:00.000Z";

#[test]
fn leaves_settled_transcripts_and_usage_unchanged_for_both_backends() {
    for index in [1, 2] {
        let mut chat = record(index).chat.unwrap();
        chat.active = None;
        chat.snapshot.status = ChatStatus::Idle;
        chat.snapshot.current_turn_id = None;
        chat.snapshot.current_item_id = None;
        chat.snapshot.retry_item_id = match &chat.retry {
            Some(PersistedChatRequest::Message { item_id, .. }) => item_id.clone(),
            _ => None,
        };
        let recovered = recover_chat(chat.clone(), RESTORED_AT, || {
            panic!("settled chat needs no id")
        })
        .unwrap();
        assert_eq!(recovered, chat);
    }
}

#[test]
fn interrupted_messages_replace_old_retry_requests_and_preserve_item_routing() {
    let original = record(2).chat.unwrap();
    let recovered =
        recover_chat(original.clone(), RESTORED_AT, || "recovery-notice".into()).unwrap();
    assert_eq!(recovered.snapshot.status, ChatStatus::Failed);
    assert_eq!(recovered.snapshot.revision, original.snapshot.revision + 1);
    assert_eq!(recovered.active, None);
    assert_eq!(recovered.retry, original.active);
    assert_eq!(recovered.snapshot.retry_item_id.as_deref(), Some("codex-1"));
    assert_eq!(recovered.snapshot.current_turn_id, None);
    assert_eq!(recovered.snapshot.current_item_id, None);
    assert_eq!(
        &recovered.snapshot.entries[..original.snapshot.entries.len()],
        &original.snapshot.entries
    );
    let ChatEntry::Notice(notice) = recovered.snapshot.entries.last().unwrap() else {
        panic!("missing recovery notice")
    };
    assert_eq!(notice.base.id, "recovery-notice");
    assert_eq!(notice.base.turn_id, "turn-2");
    assert_eq!(notice.base.item_id.as_deref(), Some("codex-1"));
    assert_eq!(notice.base.created_at, RESTORED_AT);
    assert_eq!(notice.level, NoticeLevel::Error);
    assert!(notice.retryable);
}

#[test]
fn interrupted_reviews_have_a_retry_without_an_item_and_get_a_turn_id_if_missing() {
    let mut chat = record(1).chat.unwrap();
    chat.active = Some(PersistedChatRequest::Review);
    chat.snapshot.status = ChatStatus::Starting;
    let mut ids = ["notice-id", "recovered-turn"].into_iter();
    let recovered = recover_chat(chat, RESTORED_AT, || ids.next().unwrap().into()).unwrap();
    assert_eq!(recovered.retry, Some(PersistedChatRequest::Review));
    assert_eq!(recovered.snapshot.retry_item_id, None);
    let ChatEntry::Notice(notice) = recovered.snapshot.entries.last().unwrap() else {
        panic!("missing recovery notice")
    };
    assert_eq!(notice.base.turn_id, "recovered-turn");
    assert_eq!(notice.base.item_id, None);
    assert!(notice.retryable);
}

#[test]
fn busy_snapshots_without_a_request_fail_without_advertising_a_retry() {
    for status in [
        ChatStatus::Starting,
        ChatStatus::Running,
        ChatStatus::Interrupting,
    ] {
        let mut chat = record(2).chat.unwrap();
        chat.active = None;
        chat.retry = None;
        chat.snapshot.status = status;
        let recovered = recover_chat(chat, RESTORED_AT, || "notice-id".into()).unwrap();
        assert_eq!(recovered.snapshot.status, ChatStatus::Failed);
        assert_eq!(recovered.snapshot.revision, 10);
        assert_eq!(recovered.retry, None);
        assert_eq!(recovered.snapshot.retry_item_id, None);
        let ChatEntry::Notice(notice) = recovered.snapshot.entries.last().unwrap() else {
            panic!("missing recovery notice")
        };
        assert!(!notice.retryable);
        assert!(notice.message.contains("Start a new turn"));
    }
}

#[test]
fn running_tools_fail_without_losing_partial_output_or_completed_tool_results() {
    let mut chat = record(1).chat.unwrap();
    let mut completed = chat.snapshot.entries[1].clone();
    let ChatEntry::Tool(tool) = &mut completed else {
        panic!("missing tool")
    };
    tool.base.id = "completed-tool".into();
    let ChatEntry::Tool(tool) = &mut chat.snapshot.entries[1] else {
        panic!("missing tool")
    };
    tool.status = ToolStatus::Running;
    tool.output = Some("partial result".into());
    let running = chat.snapshot.entries[1].clone();
    chat.snapshot.entries.push(running);
    let ChatEntry::Tool(tool) = &mut chat.snapshot.entries[2] else {
        panic!("missing tool")
    };
    tool.base.id = "second-tool".into();
    tool.output = None;
    chat.snapshot.entries.push(completed.clone());
    let recovered = recover_chat(chat, RESTORED_AT, || "notice-id".into()).unwrap();
    for index in [1, 2] {
        let ChatEntry::Tool(tool) = &recovered.snapshot.entries[index] else {
            panic!("missing tool")
        };
        assert_eq!(tool.status, ToolStatus::Failed);
        assert!(
            tool.output
                .as_ref()
                .unwrap()
                .contains("before this tool completed")
        );
    }
    let ChatEntry::Tool(tool) = &recovered.snapshot.entries[1] else {
        unreachable!()
    };
    assert!(
        tool.output
            .as_ref()
            .unwrap()
            .starts_with("partial result\n")
    );
    assert_eq!(recovered.snapshot.status, ChatStatus::Failed);
    assert_eq!(recovered.snapshot.entries[3], completed);
    assert_eq!(
        recovered.snapshot.last_usage,
        record(1).chat.unwrap().snapshot.last_usage
    );
}

#[test]
fn a_missing_active_request_does_not_advertise_an_older_retry_as_this_turn() {
    let mut chat = record(2).chat.unwrap();
    chat.active = None;
    let previous_retry = chat.retry.clone();
    let recovered = recover_chat(chat, RESTORED_AT, || "notice-id".into()).unwrap();
    assert_eq!(recovered.retry, previous_retry);
    assert_eq!(
        recovered.snapshot.retry_item_id.as_deref(),
        Some("claude-1")
    );
    let ChatEntry::Notice(notice) = recovered.snapshot.entries.last().unwrap() else {
        panic!("missing recovery notice")
    };
    assert_eq!(notice.base.item_id.as_deref(), Some("codex-1"));
    assert!(!notice.retryable);
    assert!(notice.message.contains("Start a new turn"));
}

#[test]
fn recovered_transcripts_do_not_accumulate_notices_on_a_second_recovery() {
    let first = recover_chat(record(2).chat.unwrap(), RESTORED_AT, || "notice-id".into()).unwrap();
    let second = recover_chat(first.clone(), RESTORED_AT, || {
        panic!("must not create a second notice")
    })
    .unwrap();
    assert_eq!(second, first);
}

#[test]
fn clears_stale_live_turn_and_retry_hints_with_one_revision_increment() {
    let mut chat = record(2).chat.unwrap();
    chat.active = None;
    chat.retry = Some(PersistedChatRequest::Review);
    chat.snapshot.status = ChatStatus::Failed;
    let entry_count = chat.snapshot.entries.len();
    let recovered = recover_chat(chat, RESTORED_AT, || panic!("hints need no notice")).unwrap();
    assert_eq!(recovered.snapshot.revision, 10);
    assert_eq!(recovered.snapshot.current_turn_id, None);
    assert_eq!(recovered.snapshot.current_item_id, None);
    assert_eq!(recovered.snapshot.retry_item_id, None);
    assert_eq!(recovered.snapshot.entries.len(), entry_count);
}

#[test]
fn refuses_to_wrap_or_lose_precision_in_chat_revisions() {
    for revision in [9_007_199_254_740_991, u64::MAX] {
        let mut chat = record(2).chat.unwrap();
        chat.snapshot.revision = revision;
        assert!(matches!(
            recover_chat(chat, RESTORED_AT, || "notice-id".into()),
            Err(ChatRecoveryError::RevisionExhausted { .. })
        ));
    }
    let mut settled = record(1).chat.unwrap();
    settled.snapshot.revision = u64::MAX;
    assert!(matches!(
        recover_chat(settled, RESTORED_AT, || panic!(
            "invalid revision needs no id"
        )),
        Err(ChatRecoveryError::RevisionExhausted { .. })
    ));
}

#[test]
fn rejects_invalid_recovery_context_and_duplicate_notice_ids() {
    assert_eq!(
        recover_chat(record(2).chat.unwrap(), "not a date", || "notice-id".into()).unwrap_err(),
        ChatRecoveryError::InvalidTimestamp
    );
    for id in ["", "user-2"] {
        assert_eq!(
            recover_chat(record(2).chat.unwrap(), RESTORED_AT, || id.into()).unwrap_err(),
            ChatRecoveryError::InvalidNoticeId
        );
    }
    let mut chat = record(2).chat.unwrap();
    chat.snapshot.current_turn_id = None;
    let mut ids = ["notice-id", ""].into_iter();
    assert_eq!(
        recover_chat(chat, RESTORED_AT, || ids.next().unwrap().into()).unwrap_err(),
        ChatRecoveryError::InvalidTurnId
    );
}
