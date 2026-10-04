use legible_daemon::sessions::PersistedSessionRecord;

pub fn record(index: usize) -> PersistedSessionRecord {
    let records: Vec<PersistedSessionRecord> =
        serde_json::from_str(include_str!("../fixtures/session-records.json")).unwrap();
    records.into_iter().nth(index).unwrap()
}
