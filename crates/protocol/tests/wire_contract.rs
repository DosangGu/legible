use std::any::type_name;

use legible_protocol::*;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/fixtures/wire.json"
    ))
    .expect("shared wire fixtures must be valid JSON")
}

fn assert_round_trips<T: DeserializeOwned + Serialize>(values: &Value) {
    for (index, expected) in values
        .as_array()
        .expect("fixture group is an array")
        .iter()
        .enumerate()
    {
        let decoded: T = serde_json::from_value(expected.clone())
            .unwrap_or_else(|error| panic!("{} fixture {index}: {error}", type_name::<T>()));
        assert_eq!(
            serde_json::to_value(decoded).expect("wire model must serialize"),
            *expected,
            "{} fixture {index} changed the JSON contract",
            type_name::<T>(),
        );
    }
}

#[test]
fn preserves_current_http_payloads_without_adding_or_dropping_fields() {
    let fixture = fixtures();
    assert_round_trips::<Repo>(&fixture["repos"]);
    assert_round_trips::<RepositoryDetails>(&fixture["repositoryDetails"]);
    assert_round_trips::<DaemonHealth>(&fixture["health"]);
    assert_round_trips::<PreflightReport>(&fixture["preflight"]);
    assert_round_trips::<ReviewSession>(&fixture["sessions"]);
    assert_round_trips::<ReviewSubmission>(&fixture["submissions"]);
    assert_round_trips::<ReviewUpdate>(&fixture["reviewUpdates"]);
    assert_round_trips::<DiffDocument>(&fixture["diffs"]);
    assert_round_trips::<ReviewFileContent>(&fixture["reviewFiles"]);
    assert_round_trips::<DirectoryListing>(&fixture["directories"]);
    assert_round_trips::<CodeSearchResult>(&fixture["searches"]);
    assert_round_trips::<ApiError>(&fixture["errors"]);
    assert_round_trips::<ChatSnapshot>(&fixture["chats"]);
    assert_round_trips::<ReviewFocusRequest>(&fixture["focusRequests"]);
    assert_round_trips::<CreateSessionRequest>(&fixture["createSessionRequests"]);
    assert_round_trips::<CreateSessionResponse>(&fixture["createSessionResponses"]);
    assert_round_trips::<RefreshReviewResponse>(&fixture["refreshResponses"]);
    assert_round_trips::<PullRequestSummary>(&fixture["pullRequests"]);
    assert_round_trips::<PullRequestPage>(&fixture["pullRequestPages"]);
    assert_round_trips::<CreateDraftCommentRequest>(&fixture["createCommentRequests"]);
    assert_round_trips::<UpdateDraftCommentRequest>(&fixture["updateCommentRequests"]);
    assert_round_trips::<SubmitReviewRequest>(&fixture["submitRequests"]);
    assert_round_trips::<ChatCommandAccepted>(&fixture["chatCommands"]);
}

#[test]
fn preserves_every_daemon_and_chat_event_discriminator_in_the_flat_envelope() {
    assert_round_trips::<DaemonEventEnvelope>(&fixtures()["events"]);
}

#[test]
fn preserves_entry_kind_when_serializing_individual_chat_entry_types() {
    let fixture = fixtures();
    let entries = &fixture["chats"][6]["entries"];
    assert_round_trips::<ChatMessageEntry>(&json!([entries[0], entries[1]]));
    assert_round_trips::<ChatToolEntry>(&json!([entries[2], entries[3], entries[4]]));
    assert_round_trips::<ChatNoticeEntry>(&json!([entries[5], entries[6]]));
    assert!(serde_json::from_value::<ChatMessageEntry>(entries[2].clone()).is_err());
}

#[test]
fn retains_null_sides_and_real_diff_line_numbers() {
    let diff: DiffDocument = serde_json::from_value(fixtures()["diffs"][0].clone()).unwrap();
    let lines = &diff.files[3].hunks[0].lines;
    assert_eq!(
        (lines[0].left_line, lines[0].right_line),
        (Some(4), Some(4))
    );
    assert_eq!((lines[1].left_line, lines[1].right_line), (Some(5), None));
    assert_eq!((lines[2].left_line, lines[2].right_line), (None, Some(5)));
    assert!(lines[2].no_newline_at_end);
    assert_eq!(
        serde_json::to_value(&lines[1]).unwrap()["rightLine"],
        Value::Null
    );
}

#[test]
fn requires_a_review_revision_without_inventing_lifecycle_fields() {
    let expected = fixtures()["sessions"][0].clone();
    let session: ReviewSession = serde_json::from_value(expected.clone()).unwrap();
    assert_eq!(session.review_revision, 0);
    assert_eq!(session.submission_history, None);
    assert_eq!(session.archived_at, None);
    assert_eq!(serde_json::to_value(session).unwrap(), expected);
    let mut missing_revision = expected;
    missing_revision
        .as_object_mut()
        .unwrap()
        .remove("reviewRevision");
    assert!(serde_json::from_value::<ReviewSession>(missing_revision).is_err());
}

fn assert_missing_nullable_is_rejected<T: DeserializeOwned>(source: &Value, fields: &[&str]) {
    for field in fields {
        let mut malformed = source.clone();
        malformed.as_object_mut().unwrap().remove(*field);
        assert!(
            serde_json::from_value::<T>(malformed).is_err(),
            "{} accepted missing required field {field}",
            type_name::<T>(),
        );
    }
}

#[test]
fn rejects_absent_nullable_fields_instead_of_treating_them_as_null() {
    let fixture = fixtures();
    assert_missing_nullable_is_rejected::<DiffLine>(
        &fixture["diffs"][0]["files"][3]["hunks"][0]["lines"][0],
        &["leftLine", "rightLine"],
    );
    assert_missing_nullable_is_rejected::<DiffFile>(
        &fixture["diffs"][0]["files"][0],
        &["oldPath", "newPath"],
    );
    assert_missing_nullable_is_rejected::<ReviewFileContent>(
        &fixture["reviewFiles"][0],
        &["content"],
    );
    assert_missing_nullable_is_rejected::<ReviewUpdate>(
        &fixture["reviewUpdates"][0],
        &["baseChanged"],
    );
}

#[test]
fn rejects_null_for_optional_fields_that_typescript_only_allows_to_be_absent() {
    let mut session = fixtures()["sessions"][0].clone();
    session["archivedAt"] = Value::Null;
    assert!(serde_json::from_value::<ReviewSession>(session).is_err());

    let mut request = fixtures()["submitRequests"][0].clone();
    request["body"] = Value::Null;
    assert!(serde_json::from_value::<SubmitReviewRequest>(request).is_err());

    let mut status = json!({ "type": "status", "status": "idle" });
    status["currentTurnId"] = Value::Null;
    assert!(serde_json::from_value::<ChatStreamEvent>(status).is_err());
}

#[test]
fn rejects_unknown_backends_while_retaining_free_form_model_and_effort() {
    let mut config = fixtures()["sessions"][1]["config"].clone();
    let decoded: ReviewConfig = serde_json::from_value(config.clone()).unwrap();
    assert_eq!(decoded.main.model.as_deref(), Some("future-model"));
    assert_eq!(decoded.main.effort.as_deref(), Some("future-effort"));
    config["main"]["backend"] = json!("unknown");
    assert!(serde_json::from_value::<ReviewConfig>(config).is_err());
}

#[test]
fn requires_receipt_fields_for_submitted_reviews() {
    let mut submission = fixtures()["submissions"][2].clone();
    submission.as_object_mut().unwrap().remove("githubReviewId");
    assert!(serde_json::from_value::<ReviewSubmission>(submission).is_err());
}

#[test]
fn rejects_pending_submissions_in_completed_review_history() {
    let fixture = fixtures();
    let mut session = fixture["sessions"][1].clone();
    session["submissionHistory"][0]["submission"] = fixture["submissions"][0].clone();
    assert!(serde_json::from_value::<ReviewSession>(session).is_err());
}

#[test]
fn rejects_running_status_in_a_tool_completion_event() {
    assert!(
        serde_json::from_value::<ChatStreamEvent>(json!({
            "type": "tool.completed", "entryId": "tool", "status": "running", "output": ""
        }))
        .is_err()
    );
}
