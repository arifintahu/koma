# Independent terminal Usage dashboard

OpenTUI `/usage` reads the host ledger through a persistent `koma remote-usage`
worker. This entry point runs before normal startup initialization. It opens only
`<resolved Koma data directory>/usage.sqlite`, using SQLite read-only flags and a
200 ms busy timeout. It never creates a schema or scans session files. Each
response uses one read transaction for totals, every model, roles, and buckets.
Legacy callers retain their nonfatal query APIs and existing accounting sums.

The stdin/stdout protocol uses the existing four-byte big-endian length framing.
Version 1 requests contain `request_id`, `scope`, `range`, and `session_uuid`.
Responses echo those fields and include `data`, `collected_at`, `window_start`,
`window_end`, `utc_offset`, `missing`, and `error`. Both cost and token values are
included. Missing files are distinct from unreadable, busy, or corrupt databases.
EOF terminates the worker. The terminal restarts failed workers on refresh.

Usage polls once per second while mounted. Requests coalesce behind one active
read, and selection generations reject superseded results. Request IDs remain
unique across terminal session changes. A successful result stays visible during
refresh and errors. Polling pauses on close; terminal teardown kills its worker.

`GetMenuCapabilities` advertises optional `usage_reader` support. A new terminal
sends `SetUsageReader { enabled: true }` only after support is advertised. That
client receives navigation and live session counters without daemon ledger reads,
including resyncs. Other clients retain complete legacy snapshots. Older peers
use snapshot data and show the reduced refresh capability.

Remote terminals use the authenticated `term-remote` helper's `Usage`, `UsageError`
and `Usage` result messages. A separate task owns a dedicated SSH child running
`remote-usage` on the remote host. Its framed I/O is independent of the daemon
bridge and discovery commands. There is no local-ledger fallback. Helper teardown
aborts that task and kills its SSH child. Credentials remain in helper pipes.

Today covers 24 host-local hourly buckets, with future periods marked. Week and
Year preserve rolling seven-day and 365-day cutoffs, including partial boundary
days. Session uses lifetime hourly buckets and folds adjacent hours only to fit,
retaining both sums and interval bounds. Dates use the reader's reported offset,
so client timezone differences do not move cells. The offset is the current host
offset, matching the existing ledger aggregation convention; this does not add a
historical timezone/DST database.

Year uses Sunday–Saturday rows, chronological week columns, five theme heat
colors, month labels, and a Less–More legend. Wide calendars use two columns per
cell; medium calendars use one. Narrow calendars follow selection horizontally
and show the visible week range. Arrows browse intervals (Left/Right move a week
in Year); Home/End choose the first/latest elapsed period. Clicks select periods.
The selected timestamp survives refresh, metric changes, and resizing. Page keys
and wheel scrolling affect the content area; header, summary, details and refresh
status stay protected. Narrow interval details use two rows so values fit.
Models have no top-eight limit, show all token columns and selected-metric shares,
and expose full Unicode names on selection. Role shares use all recorded cost as
the denominator, without claiming Main/Subagents exhaust all roles.

## Verification

Run from the repository root:

```sh
cargo build -p agent
cargo test -p agent model::usage::reader -- --test-threads=1
cargo test -p agent ipc::roundtrip_tests -- --test-threads=1
cargo test -p agent remote:: -- --test-threads=1
python3 src-term/scripts/verify-usage.py
python3 src-term/scripts/verify-remote.py
src-term/.tools/bun src-term/scripts/verify-usage-ui.tsx
src-term/.tools/bun test src-term/src
src-term/.tools/bun src-term/node_modules/typescript/bin/tsc --noEmit -p src-term
```

Reader tests cover missing/corrupt/schema-less/busy databases, unchanged ledger
bytes, complete models, role sums, transaction consistency during writes, rolling
boundaries, leap day, non-hour offsets, session lifetime, and invalid requests.
The local process harness verifies real framing, EOF, writes between reads,
per-client capability negotiation, old-client snapshots, range keys, and Esc.
The fake-SSH harness reads a remote fixture while a different local sentinel
ledger exists, tests missing-remote behavior, reader crash/restart and cleanup,
and verifies ordinary daemon input still works.

The live UI harness drives actual `SessionScreen` keys against an isolated daemon
and real reader, checks all four views/sizes, complete models, Esc/draft restoration,
and polling pause. Its loopback transport bypasses launcher discovery; remote
isolation is verified separately by the fake-SSH harness.

Terminal tests cover coalescing, stale rejection, crashes, preserved data on
errors, local selection, pointer controls, metric changes without reads, resize,
and scrolling through all models. Native captures cover all four views at
50×24, 80×18, 100×40 and 160×45. Forty additional captures inspect all five heat
colors and selection/summary colors across ten themes and four sizes. Review
`/tmp/koma-usage-frames.txt` and `/tmp/koma-usage-review.html`.

These checks use isolated fixtures and instrumented SSH, not a live remote host
or provider account. At implementation time the complete working-tree Bun suite
also has 25 failures outside Usage: a composer prompt expectation and settings
switch-alignment expectations. Focused Usage tests, TypeScript, and Rust checks
are separate from those existing UI changes.
