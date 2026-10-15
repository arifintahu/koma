//! Versioned, read-only ledger lane. Stdout contains frames only; EOF ends the worker.
use super::{queries::*, *};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub version: u32,
    pub request_id: u64,
    pub scope: String,
    pub session_uuid: String,
    pub range: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Response {
    pub version: u32,
    pub request_id: u64,
    pub scope: String,
    pub session_uuid: String,
    pub range: String,
    pub collected_at: i64,
    pub window_start: i64,
    pub window_end: i64,
    pub utc_offset: i64,
    pub data: Option<UsageData>,
    pub error: Option<String>,
    pub missing: bool,
}

fn collect(
    path: &Path,
    request: &Request,
    now: i64,
    tz: i64,
) -> anyhow::Result<(UsageData, i64, i64)> {
    anyhow::ensure!(request.version == 1, "Unsupported usage reader protocol");
    anyhow::ensure!(
        matches!(request.scope.as_str(), "session" | "global"),
        "Invalid usage scope"
    );
    let since = match request.range.as_str() {
        "today" => (now + tz).div_euclid(86400) * 86400 - tz,
        "week" => now - 7 * 86400,
        "year" => now - 365 * 86400,
        _ => anyhow::bail!("Invalid usage range"),
    };
    if request.scope == "session" {
        uuid::Uuid::parse_str(&request.session_uuid)?;
    }
    let mut conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_millis(200))?;
    let tx = conn.transaction()?;
    let session = (request.scope == "session").then_some(request.session_uuid.as_str());
    let since = if session.is_some() { 0 } else { since };
    let totals = range_totals_scoped_on(&tx, since, session, now)?;
    let models = top_models_in_range_scoped_on(&tx, since, -1, session, now)?;
    let roles = role_split_scoped_on(&tx, since, session, now)?;
    let bucket = if session.is_some() || request.range == "today" {
        BucketSize::Hour
    } else {
        BucketSize::Day
    };
    let buckets = spend_buckets_scoped_on(&tx, since, bucket, 0, tz, session, now)?;
    let start = if session.is_some() {
        buckets.first().map_or(now, |b| b.bucket_epoch)
    } else {
        since
    };
    let end = if session.is_none() && request.range == "today" {
        since + 86400
    } else {
        now + 1
    };
    let data = if session.is_some() {
        UsageData {
            session_calls: totals.calls,
            totals,
            session_models: models,
            session_hourly: buckets,
            ..Default::default()
        }
    } else {
        UsageData {
            totals,
            top_models: models,
            role_split: roles,
            heatmap_buckets: buckets,
            ..Default::default()
        }
    };
    tx.commit()?;
    Ok((data, start, end))
}

pub(crate) fn respond(request: Request) -> Response {
    let now = super::ledger::now_secs();
    let tz = local_utc_offset_secs();
    let mut response = Response {
        version: 1,
        request_id: request.request_id,
        scope: request.scope.clone(),
        session_uuid: request.session_uuid.clone(),
        range: request.range.clone(),
        collected_at: now,
        window_start: now,
        window_end: now,
        utc_offset: tz,
        data: None,
        error: None,
        missing: false,
    };
    let result = usage_db_path().ok_or_else(|| anyhow::anyhow!("Cannot resolve Koma data directory")).and_then(|path| {
        response.missing = matches!(std::fs::metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
        collect(&path, &request, now, tz)
    });
    match result {
        Ok((data, start, end)) => {
            response.data = Some(data);
            response.window_start = start;
            response.window_end = end;
        }
        Err(error) => {
            response.error = Some(if response.missing {
                "No usage ledger yet".into()
            } else {
                format!("Cannot read usage ledger: {error:#}")
            })
        }
    }
    response
}

pub(crate) fn run() -> anyhow::Result<()> {
    tokio::runtime::Runtime::new()?.block_on(async {
        use crate::ipc::frame::{read_frame_from, write_frame_to, FrameReader};
        use tokio::io::AsyncWriteExt;
        let mut input = tokio::io::BufReader::new(tokio::io::stdin());
        let mut output = tokio::io::stdout();
        let mut reader = FrameReader::new();
        loop {
            let bytes = match read_frame_from(&mut input, &mut reader).await {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(error.into()),
            };
            let request: Request = serde_json::from_slice(&bytes)?;
            let result = tokio::task::spawn_blocking(move || respond(request)).await?;
            write_frame_to(&mut output, &serde_json::to_vec(&result)?).await?;
            output.flush().await?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("koma-usage-{}.sqlite", uuid::Uuid::new_v4())))
        }
        fn writer(&self) -> Connection {
            let conn = Connection::open(&self.0).unwrap();
            super::super::ledger::ensure_schema(&conn).unwrap();
            conn
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    fn request(scope: &str, range: &str) -> Request {
        Request {
            version: 1,
            request_id: 7,
            scope: scope.into(),
            range: range.into(),
            session_uuid: "00000000-0000-0000-0000-000000000001".into(),
        }
    }
    fn insert(conn: &Connection, ts: i64, model: &str, role: &str) {
        conn.execute("INSERT INTO usage(ts,model_id,role,session_uuid,tokens_in,tokens_cached,tokens_out,cost) VALUES(?1,?2,?3,'00000000-0000-0000-0000-000000000001',10,4,2,0.5)", rusqlite::params![ts, model, role]).unwrap();
    }
    #[test]
    fn reader_never_creates_or_repairs_a_ledger() {
        let f = Fixture::new();
        assert!(collect(&f.0, &request("global", "today"), 100000, 0).is_err());
        assert!(!f.0.exists());
        std::fs::write(&f.0, b"broken sqlite").unwrap();
        assert!(collect(&f.0, &request("global", "today"), 100000, 0).is_err());
        assert_eq!(std::fs::read(&f.0).unwrap(), b"broken sqlite");
        let empty = Fixture::new();
        drop(Connection::open(&empty.0).unwrap());
        assert!(collect(&empty.0, &request("global", "today"), 100000, 0).is_err());
        let conn = Connection::open(&empty.0).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn all_models_and_roles_share_the_same_bounded_snapshot() {
        let f = Fixture::new();
        let conn = f.writer();
        for n in 0..24 {
            insert(
                &conn,
                100000,
                &format!("模型-{n}"),
                if n < 10 {
                    "main"
                } else if n < 20 {
                    "sub:worker"
                } else {
                    "planner"
                },
            );
        }
        insert(&conn, 100002, "future", "main");
        let before = std::fs::read(&f.0).unwrap();
        let (data, start, end) = collect(&f.0, &request("global", "today"), 100001, 20700).unwrap();
        assert_eq!(data.top_models.len(), 24);
        assert_eq!(data.totals.calls, 24);
        assert_eq!(data.totals.cost, 12.0);
        assert_eq!(data.role_split.main_calls, 10);
        assert_eq!(data.role_split.sub_calls, 10);
        assert_eq!(
            data.heatmap_buckets.iter().map(|b| b.tokens).sum::<i64>(),
            288
        );
        assert_eq!((start, end), (65700, 152100));
        assert_eq!(before, std::fs::read(&f.0).unwrap());
        let (session, start, _) =
            collect(&f.0, &request("session", "year"), 100001, 20700).unwrap();
        assert_eq!(session.session_models.len(), 24);
        assert_eq!(session.session_calls, 24);
        assert_eq!(start, 98100);
    }
    #[test]
    fn rolling_boundaries_and_lifetime_are_preserved() {
        let f = Fixture::new();
        let conn = f.writer();
        let now = 1709251200; // 2024-03-01 UTC, immediately after leap day
        insert(&conn, now - 7 * 86400 - 1, "old", "main");
        insert(&conn, now - 7 * 86400, "boundary", "main");
        insert(&conn, now - 1, "leap-day", "main");
        let (week, start, _) = collect(&f.0, &request("global", "week"), now, -12600).unwrap();
        assert_eq!(start, now - 7 * 86400);
        assert_eq!(week.totals.calls, 2);
        let (year, start, _) = collect(&f.0, &request("global", "year"), now, 0).unwrap();
        assert_eq!(start, now - 365 * 86400);
        assert_eq!(year.totals.calls, 3);
        let (session, _, _) = collect(&f.0, &request("session", "today"), now, 0).unwrap();
        assert_eq!(session.session_calls, 3);
    }
    #[test]
    fn concurrent_writes_do_not_mix_transactions_and_busy_is_an_error() {
        let f = Fixture::new();
        let writer = f.writer();
        writer.execute_batch("PRAGMA journal_mode=WAL").unwrap();
        insert(&writer, 100000, "before", "main");
        let mut reader =
            Connection::open_with_flags(&f.0, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let tx = reader.transaction().unwrap();
        assert_eq!(
            range_totals_scoped_on(&tx, 0, None, i64::MAX)
                .unwrap()
                .calls,
            1
        );
        insert(&writer, 100001, "after", "main");
        assert_eq!(
            top_models_in_range_scoped_on(&tx, 0, -1, None, i64::MAX)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            role_split_scoped_on(&tx, 0, None, i64::MAX)
                .unwrap()
                .main_calls,
            1
        );
        tx.commit().unwrap();
        assert_eq!(
            collect(&f.0, &request("global", "today"), 100002, 0)
                .unwrap()
                .0
                .totals
                .calls,
            2
        );
        drop(reader);
        writer
            .execute_batch("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE")
            .unwrap();
        assert!(collect(&f.0, &request("global", "today"), 100002, 0).is_err());
        writer.execute_batch("ROLLBACK").unwrap();
    }
    #[test]
    fn invalid_protocol_and_scope_are_rejected() {
        let f = Fixture::new();
        let _conn = f.writer();
        let mut req = request("session", "today");
        req.session_uuid = "wrong".into();
        assert!(collect(&f.0, &req, 1, 0).is_err());
        req = request("global", "today");
        req.version = 2;
        assert!(collect(&f.0, &req, 1, 0).is_err());
        assert!(collect(&f.0, &request("elsewhere", "today"), 1, 0).is_err());
    }
    #[test]
    fn optional_capability_and_new_request_roundtrip() {
        use crate::ipc::proto::{ClientRequest, DaemonEvent};
        let old: DaemonEvent =
            serde_json::from_str(r#"{"MenuCapabilities":{"version":1}}"#).unwrap();
        assert!(matches!(
            old,
            DaemonEvent::MenuCapabilities {
                version: 1,
                usage_reader: false
            }
        ));
        let control = ClientRequest::SetUsageReader { enabled: true };
        let bytes = serde_json::to_vec(&control).unwrap();
        assert_eq!(
            serde_json::from_slice::<ClientRequest>(&bytes).unwrap(),
            control
        );
        let request = request("global", "today");
        let bytes = serde_json::to_vec(&request).unwrap();
        assert_eq!(
            serde_json::from_slice::<Request>(&bytes)
                .unwrap()
                .request_id,
            7
        );
    }
}
