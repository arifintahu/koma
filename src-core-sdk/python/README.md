# Python SDK (Python 3.11+)

Install and configure an SDK-capable Koma binary separately; see [installation and safety](../README.md).
These are local packages, not a claim of PyPI publication. No runtime dependencies or binary downloader.

```sh
python -m pip install /path/to/koma/src-core-sdk/python
koma sdk --help
python /path/to/koma/src-core-sdk/python/examples/bot.py /absolute/workspace
```

```python
import asyncio
from koma_sdk import Client, Disposition, DeliveryUnknown

async def main():
    async with Client(executable="/absolute/path/to/koma") as client:
        print(await client.probe())
        async with await client.create("/absolute/workspace") as session:
            print(session.session_id)  # save for explicit resume
            result = await session.submit("Explain this repository")
            if result.disposition is Disposition.STARTED:
                turn = await session.wait_turn(result.turn_id, timeout=120)
                print(turn.state, (await session.get_state()).messages)

asyncio.run(main())
```

`create` defaults to `Policy(plan=FORBID, approval=REJECT)`. Reject denies gates requiring approval, not every tool, and is not a sandbox.
`resume(id)` preserves cwd/policy; an explicit `policy=` requests an idle-guarded change.
External approvals require `external_approvals=True` and normally `Policy(approval=ApprovalPolicy.DEFAULT)`.
Use `state.pending_approval.call_id` with `session.approve(call_id, True/False)`; plan/mission gates remain unsupported and visible in `state.gate`.

`enqueue(text)` reports admission only (up to five queued inputs, FIFO with existing coalescing); it reserves no new turn.
`interrupt(turn_id)` and `interrupt_and_submit(turn_id, text)` are targeted. Replacement results preserve `interrupted_turn_id` even on partial failure.
Attachments are ordered `ImageFile('/absolute/chart.png')` or `PastedText('context', 'label')` objects passed as `attachments=[...]`.
Paths refer to the daemon host. See the shared guide for byte/count limits.

`async for event in session.events()` has one consumer. Handle `StateEvent` replacements, `OutputAppendEvent` proven UTF-8 suffixes, and `TurnEvent` observations.
Revisions and offsets are connection-local; full state replaces prior state. The iterator reconciles mismatches by state readback. Events can precede method results.
Buffers are bounded (256 events / 64 MiB, 64 pending requests, 64 KiB stderr tail, 40 MiB serialized frames). Overflow clears buffered events and pauses event buffering. Event consumption raises `EventOverflow`; pending requests, polling waits, and control methods remain usable. Polling-only `submit` / `wait_turn` usage is supported for long streams.
After catching `EventOverflow`, start a new `session.events()` iterator. It enables buffering, reads authoritative state, and yields `StateEvent(resynced=True)` before later output. Queued observations superseded by that state are ignored. Overflow during recovery raises `EventOverflow` again. Polling waits do not consume an active iterator's events. Malformed frames and transport failures still close the connection.

Mutation timeouts, cancellation after writing, malformed replies and disconnects raise `DeliveryUnknown`, containing available request/session/turn IDs. Never retry automatically: resume/read state first. Cancellation does not interrupt work.
`wait_turn` returns the observed final record, not proof of task success; hidden/newer turns or timeout raise `ObservationUnavailable`. `finished` only means normal execution ended.
Context exit, `close`, `detach` and EOF only close the adapter connection; they do not stop the daemon or running turn. Explicitly interrupt if that is intended.

## Maintainers

```sh
PYTHONPATH=src python -m unittest discover -s tests -v
python -m pip wheel --no-deps --wheel-dir /tmp/koma-wheels .
# Install the resulting wheel in a clean venv and import koma_sdk.
```

Build tooling is setuptools; wheel metadata includes `py.typed`. Tests use the shared fake adapter without providers. Provider-backed examples intentionally submit real inference. Windows/Linux source portability is not runtime verification.
