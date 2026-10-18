# Shared subprocess conformance peer

Run `python3 src-core-sdk/conformance/fake_adapter.py --scenario normal`.
Python 3.8+, standard library only; executable can also be launched directly.
This is a deterministic transport test peer, NOT a daemon emulator and NOT a
reference security validator. It trusts well-formed method parameters; production
adapters must implement the full validation and byte budgets in CONTRACT.md.

Scenarios (one per process):

| scenario | behavior / client assertion |
|---|---|
| normal | all methods; running turns stay running until targeted interrupt; events precede mutation replies |
| reject | turn mutations reject with invalid_input; no automatic retries |
| partial | replacement rejects after old turn was interrupted; preserve interrupted_turn_id |
| unknown | valid turn mutation returns unavailable/delivery unknown; do not retry |
| eof | exit 3 on submit/replacement without reply; report delivery unknown |
| malformed | malformed JSON after first request; fail all pending calls |
| wrong_id | extra unknown response before correct response; do not steal correlation |
| out_of_order | hold first response, respond to second then first; send two concurrent requests (including create+state) |
| event_flood | emit 300 state events before reply; bounded stalled event consumers must fail, not hang/unboundedly grow |
| flood_output | first submit overflows; restart reconciles output and subsequent turns emit valid appends |
| flood_finish | submit emits 300 events before its reply; next state read completes the turn; polling and restart recovery remain usable |
| approval | submit parks at tool approval gate; explicitly opted-in approval uses actual pending call ID |
| bad_version | hello protocol 2; client must refuse before requests |
| stderr | >64 KiB diagnostic stream; drain independently and retain bounded tail |

| output | emit full running state followed by a revisioned UTF-8 suffix append |
| hidden | explicit state hides old turn behind a newer running record |
| fragmented | write frames one byte at a time, including split multibyte UTF-8 |
| timeout | delay submit response by two seconds; client cancellation/timeout is local |
| missing_cap | omit detach from hello; compatibility probe must refuse |
| output_gap / bad_offset | force sequence or append-offset mismatch; clients replace state by readback |
| finish | complete the observed turn on the next state read; runnable-example smoke tests |
| bad_result | return an invalid typed mutation result; report delivery unknown, not success |

Tests impose their own finite timeout. The timeout scenario intentionally sleeps.
The out_of_order scenario deliberately holds every odd response until a second
request; do not sequentially await the first response. Detach always replies and
exits immediately. Events are full copies; seq is monotonic per process.

Representative `.jsonl` fixtures in ../protocol/fixtures contain only wire frames.
Request/response IDs tie methods to results; schema validation does not replace
cross-frame assertions. Run `python3 src-core-sdk/conformance/test_fake_adapter.py`
for stdlib smoke tests. If jsonschema is installed these also validate fixtures.
