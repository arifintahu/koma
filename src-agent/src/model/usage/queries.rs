use super::ledger::{now_secs, open};
use super::types::{
    BucketSize, DailyCost, ModelCost, ModelCostRange, RangeTotals, RoleSplit, SpendBucket,
    WeeklyCost,
};

// ── Read queries (non-fatal, return empty/zero on any DB error) ──────────────

/// Cost per calendar day for the last `days` days (inclusive of today).
///
/// **Non-fatal**: returns an empty `Vec` on any DB error.
#[allow(dead_code)]
pub fn daily_costs(days: i64) -> Vec<DailyCost> {
    let Some(conn) = open() else {
        return Vec::new();
    };
    let cutoff = now_secs() - days * 86400;
    let mut stmt = match conn.prepare(
        "SELECT (ts - ts % 86400) AS day_epoch, COALESCE(SUM(cost), 0.0)
         FROM usage
         WHERE ts >= ?1
         GROUP BY day_epoch
         ORDER BY day_epoch ASC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map(rusqlite::params![cutoff], |r| {
        Ok(DailyCost {
            day_epoch: r.get(0)?,
            cost: r.get(1)?,
        })
    }) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    rows.flatten().collect()
}

/// Top models by total spend, limited to `limit` rows, ordered by cost desc.
///
/// **Non-fatal**: returns an empty `Vec` on any DB error.
#[allow(dead_code)]
pub fn top_models(limit: i64) -> Vec<ModelCost> {
    let Some(conn) = open() else {
        return Vec::new();
    };
    let mut stmt = match conn.prepare(
        "SELECT
            COALESCE(model_id, ''),
            COALESCE(SUM(cost), 0.0),
            COALESCE(SUM(tokens_in + tokens_out), 0),
            COUNT(*)
         FROM usage
         GROUP BY model_id
         ORDER BY SUM(cost) DESC
         LIMIT ?1",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map(rusqlite::params![limit], |r| {
        Ok(ModelCost {
            model_id: r.get(0)?,
            total_cost: r.get(1)?,
            total_tokens: r.get(2)?,
            call_count: r.get(3)?,
        })
    }) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    rows.flatten().collect()
}

/// Cost per 7-day window for the last `weeks` weeks, ordered ascending.
///
/// **Non-fatal**: returns an empty `Vec` on any DB error.
#[allow(dead_code)]
pub fn weekly_costs(weeks: i64) -> Vec<WeeklyCost> {
    let Some(conn) = open() else {
        return Vec::new();
    };
    let cutoff = now_secs() - weeks * 604800;
    let mut stmt = match conn.prepare(
        "SELECT (ts - ts % 604800) AS week_epoch, COALESCE(SUM(cost), 0.0)
         FROM usage
         WHERE ts >= ?1
         GROUP BY week_epoch
         ORDER BY week_epoch ASC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map(rusqlite::params![cutoff], |r| {
        Ok(WeeklyCost {
            week_epoch: r.get(0)?,
            cost: r.get(1)?,
        })
    }) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    rows.flatten().collect()
}

// ── New range-aware queries ──────────────────────────────────────────────────

/// Aggregated totals (cost, token breakdown, call count) for rows where
/// `ts >= since_ts`.  Used for the KPI strip.
///
/// **Non-fatal**: returns [`RangeTotals::default()`] (all zeroes) on any DB error.
#[allow(dead_code)]
pub fn range_totals(since_ts: i64) -> RangeTotals {
    range_totals_scoped(since_ts, None)
}

/// Same as [`range_totals`], additionally filtered to a single `session_uuid` when
/// `Some` — the GUI Usage panel's "session" scope toggle. `None` behaves identically
/// to [`range_totals`]. The uuid is always parameter-bound, never interpolated.
///
/// **Non-fatal**: returns [`RangeTotals::default()`] (all zeroes) on any DB error.
#[allow(dead_code)]
pub fn range_totals_scoped(since_ts: i64, session_uuid: Option<&str>) -> RangeTotals {
    let Some(conn) = open() else {
        return RangeTotals::default();
    };
    range_totals_scoped_on(&conn, since_ts, session_uuid, i64::MAX).unwrap_or_default()
}

/// Fallible read on the caller's connection/transaction. Never opens or migrates a ledger.
pub(super) fn range_totals_scoped_on(
    conn: &rusqlite::Connection,
    since_ts: i64,
    session_uuid: Option<&str>,
    until: i64,
) -> rusqlite::Result<RangeTotals> {
    let clause = " AND (?2 IS NULL OR session_uuid = ?2) AND ts <= ?3";
    let sql = format!(
        "SELECT
            COALESCE(SUM(cost), 0.0),
            COALESCE(SUM(tokens_in), 0),
            COALESCE(SUM(tokens_cached), 0),
            COALESCE(SUM(tokens_out), 0),
            COUNT(*)
         FROM usage
         WHERE ts >= ?1{clause}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mapper = |r: &rusqlite::Row| {
        Ok(RangeTotals {
            cost: r.get(0)?,
            tokens_in: r.get(1)?,
            tokens_cached: r.get(2)?,
            tokens_out: r.get(3)?,
            calls: r.get(4)?,
        })
    };
    stmt.query_row(rusqlite::params![since_ts, session_uuid, until], mapper)
}

/// Top models by spend within a time window (`ts >= since_ts`), with full
/// token breakdown.  Returns at most `limit` rows ordered by cost descending.
///
/// **Non-fatal**: returns an empty `Vec` on any DB error.
#[allow(dead_code)]
pub fn top_models_in_range(since_ts: i64, limit: i64) -> Vec<ModelCostRange> {
    top_models_in_range_scoped(since_ts, limit, None)
}

/// Same as [`top_models_in_range`], additionally filtered to a single
/// `session_uuid` when `Some` — the GUI Usage panel's "session" scope toggle.
/// `None` behaves identically to [`top_models_in_range`]. The uuid is always
/// parameter-bound, never interpolated.
///
/// **Non-fatal**: returns an empty `Vec` on any DB error.
#[allow(dead_code)]
pub fn top_models_in_range_scoped(
    since_ts: i64,
    limit: i64,
    session_uuid: Option<&str>,
) -> Vec<ModelCostRange> {
    let Some(conn) = open() else {
        return Vec::default();
    };
    top_models_in_range_scoped_on(&conn, since_ts, limit, session_uuid, i64::MAX)
        .unwrap_or_default()
}

/// Fallible read on the caller's connection/transaction. Never opens or migrates a ledger.
pub(super) fn top_models_in_range_scoped_on(
    conn: &rusqlite::Connection,
    since_ts: i64,
    limit: i64,
    session_uuid: Option<&str>,
    until: i64,
) -> rusqlite::Result<Vec<ModelCostRange>> {
    let clause = " AND (?3 IS NULL OR session_uuid = ?3) AND ts <= ?4";
    let sql = format!(
        "SELECT
            COALESCE(model_id, ''),
            COALESCE(SUM(cost), 0.0),
            COALESCE(SUM(tokens_in), 0),
            COALESCE(SUM(tokens_cached), 0),
            COALESCE(SUM(tokens_out), 0),
            COUNT(*)
         FROM usage
         WHERE ts >= ?1{clause}
         GROUP BY model_id
         ORDER BY SUM(cost) DESC
         LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mapper = |r: &rusqlite::Row| {
        Ok(ModelCostRange {
            model_id: r.get(0)?,
            total_cost: r.get(1)?,
            tokens_in: r.get(2)?,
            tokens_cached: r.get(3)?,
            tokens_out: r.get(4)?,
            call_count: r.get(5)?,
        })
    };
    let rows = stmt.query_map(
        rusqlite::params![since_ts, limit, session_uuid, until],
        mapper,
    );
    match rows {
        Ok(r) => r.collect(),
        Err(error) => Err(error),
    }
}

/// Split spend and call count between the `"main"` role and all `"sub:*"` roles
/// for rows where `ts >= since_ts`.
///
/// **Non-fatal**: returns [`RoleSplit::default()`] (all zeroes) on any DB error.
#[allow(dead_code)]
pub fn role_split(since_ts: i64) -> RoleSplit {
    role_split_scoped(since_ts, None)
}

/// Same as [`role_split`], additionally filtered to a single `session_uuid` when
/// `Some` — the GUI Analytics tab's "session" scope. `None` behaves identically
/// to [`role_split`]. The uuid is always parameter-bound, never interpolated.
///
/// **Non-fatal**: returns [`RoleSplit::default()`] (all zeroes) on any DB error.
#[allow(dead_code)]
pub fn role_split_scoped(since_ts: i64, session_uuid: Option<&str>) -> RoleSplit {
    let Some(conn) = open() else {
        return RoleSplit::default();
    };
    role_split_scoped_on(&conn, since_ts, session_uuid, i64::MAX).unwrap_or_default()
}

/// Fallible read on the caller's connection/transaction. Never opens or migrates a ledger.
pub(super) fn role_split_scoped_on(
    conn: &rusqlite::Connection,
    since_ts: i64,
    session_uuid: Option<&str>,
    until: i64,
) -> rusqlite::Result<RoleSplit> {
    let clause = " AND (?2 IS NULL OR session_uuid = ?2) AND ts <= ?3";
    let sql = format!(
        "SELECT
            COALESCE(SUM(CASE WHEN role = 'main' THEN cost ELSE 0 END), 0.0),
            COALESCE(SUM(CASE WHEN role = 'main' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN role LIKE 'sub:%' THEN cost ELSE 0 END), 0.0),
            COALESCE(SUM(CASE WHEN role LIKE 'sub:%' THEN 1 ELSE 0 END), 0)
         FROM usage
         WHERE ts >= ?1{clause}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mapper = |r: &rusqlite::Row| {
        Ok(RoleSplit {
            main_cost: r.get(0)?,
            main_calls: r.get(1)?,
            sub_cost: r.get(2)?,
            sub_calls: r.get(3)?,
        })
    };
    stmt.query_row(rusqlite::params![since_ts, session_uuid, until], mapper)
}

/// Time-bucketed spend and token totals for rows where `ts >= since_ts`,
/// grouped into `bucket`-sized windows.
///
/// Only buckets that have at least one row are returned; the caller fills gaps
/// with zeroes as needed.  `_n` is reserved for future limit hints.
///
/// **Non-fatal**: returns an empty `Vec` on any DB error.
#[allow(dead_code)]
pub fn spend_buckets(since_ts: i64, bucket: BucketSize, _n: usize, tz: i64) -> Vec<SpendBucket> {
    spend_buckets_scoped(since_ts, bucket, _n, tz, None)
}

/// Same as [`spend_buckets`], additionally filtered to a single `session_uuid`
/// when `Some` — the GUI Usage panel's "session" scope toggle. `None` behaves
/// identically to [`spend_buckets`]. The uuid is always parameter-bound, never
/// interpolated (only the static clause text + the bucket size, a fixed enum,
/// are spliced into the SQL).
///
/// **Non-fatal**: returns an empty `Vec` on any DB error.
#[allow(dead_code)]
pub fn spend_buckets_scoped(
    since_ts: i64,
    bucket: BucketSize,
    _n: usize,
    tz: i64,
    session_uuid: Option<&str>,
) -> Vec<SpendBucket> {
    let Some(conn) = open() else {
        return Vec::default();
    };
    spend_buckets_scoped_on(&conn, since_ts, bucket, _n, tz, session_uuid, i64::MAX)
        .unwrap_or_default()
}

/// Fallible read on the caller's connection/transaction. Never opens or migrates a ledger.
pub(super) fn spend_buckets_scoped_on(
    conn: &rusqlite::Connection,
    since_ts: i64,
    bucket: BucketSize,
    _n: usize,
    tz: i64,
    session_uuid: Option<&str>,
    until: i64,
) -> rusqlite::Result<Vec<SpendBucket>> {
    let secs = bucket.secs();
    // Bucket size is injected as a literal; SQLite does not accept arithmetic
    // expressions in GROUP BY via parameter substitution.
    let clause = " AND (?2 IS NULL OR session_uuid = ?2) AND ts <= ?3";
    let sql = format!(
        "SELECT
            ((ts + {tz}) - (ts + {tz}) % {secs} - {tz}) AS bucket_epoch,
            COALESCE(SUM(cost), 0.0),
            COALESCE(SUM(tokens_in + tokens_out), 0)
         FROM usage
         WHERE ts >= ?1{clause}
         GROUP BY bucket_epoch
         ORDER BY bucket_epoch ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mapper = |r: &rusqlite::Row| {
        Ok(SpendBucket {
            bucket_epoch: r.get(0)?,
            cost: r.get(1)?,
            tokens: r.get(2)?,
        })
    };
    let rows = stmt.query_map(rusqlite::params![since_ts, session_uuid, until], mapper);
    match rows {
        Ok(r) => r.collect(),
        Err(error) => Err(error),
    }
}

/// Per-model spend/token breakdown for a specific session UUID.
/// Used for View B (current-session models table).
///
/// **Non-fatal**: returns an empty `Vec` on any DB error.
#[allow(dead_code)]
pub fn session_models(session_uuid: &str) -> Vec<ModelCostRange> {
    let Some(conn) = open() else {
        return Vec::new();
    };
    let mut stmt = match conn.prepare(
        "SELECT
            COALESCE(model_id, ''),
            COALESCE(SUM(cost), 0.0),
            COALESCE(SUM(tokens_in), 0),
            COALESCE(SUM(tokens_cached), 0),
            COALESCE(SUM(tokens_out), 0),
            COUNT(*)
         FROM usage
         WHERE session_uuid = ?1
         GROUP BY model_id
         ORDER BY SUM(cost) DESC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map(rusqlite::params![session_uuid], |r| {
        Ok(ModelCostRange {
            model_id: r.get(0)?,
            total_cost: r.get(1)?,
            tokens_in: r.get(2)?,
            tokens_cached: r.get(3)?,
            tokens_out: r.get(4)?,
            call_count: r.get(5)?,
        })
    }) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    rows.flatten().collect()
}

/// Aggregated totals (cost, token breakdown, call count) for a single session.
/// Used for View B's KPI strip.
///
/// **Non-fatal**: returns [`RangeTotals::default()`] (all zeroes) on any DB error.
#[allow(dead_code)]
pub fn session_totals(session_uuid: &str) -> RangeTotals {
    let Some(conn) = open() else {
        return RangeTotals::default();
    };
    let mut stmt = match conn.prepare(
        "SELECT
            COALESCE(SUM(cost), 0.0),
            COALESCE(SUM(tokens_in), 0),
            COALESCE(SUM(tokens_cached), 0),
            COALESCE(SUM(tokens_out), 0),
            COUNT(*)
         FROM usage
         WHERE session_uuid = ?1",
    ) {
        Ok(s) => s,
        Err(_) => return RangeTotals::default(),
    };
    stmt.query_row(rusqlite::params![session_uuid], |r| {
        Ok(RangeTotals {
            cost: r.get(0)?,
            tokens_in: r.get(1)?,
            tokens_cached: r.get(2)?,
            tokens_out: r.get(3)?,
            calls: r.get(4)?,
        })
    })
    .unwrap_or_default()
}

/// Hourly spend/token buckets for a specific session UUID, ordered ascending.
/// Used for View B's hourly heatmap.
///
/// **Non-fatal**: returns an empty `Vec` on any DB error.
#[allow(dead_code)]
pub fn session_hourly(session_uuid: &str) -> Vec<SpendBucket> {
    let Some(conn) = open() else {
        return Vec::new();
    };
    let mut stmt = match conn.prepare(
        "SELECT
            (ts - ts % 3600) AS bucket_epoch,
            COALESCE(SUM(cost), 0.0),
            COALESCE(SUM(tokens_in + tokens_out), 0)
         FROM usage
         WHERE session_uuid = ?1
         GROUP BY bucket_epoch
         ORDER BY bucket_epoch ASC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map(rusqlite::params![session_uuid], |r| {
        Ok(SpendBucket {
            bucket_epoch: r.get(0)?,
            cost: r.get(1)?,
            tokens: r.get(2)?,
        })
    }) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    rows.flatten().collect()
}
