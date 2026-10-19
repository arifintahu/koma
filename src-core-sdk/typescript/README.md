# JavaScript / TypeScript SDK (Node.js 22+)

Install/configure an SDK-capable Koma binary separately: [shared guide](../README.md).
One ESM package provides JavaScript and TypeScript declarations. No runtime dependencies, native addons, installation hooks or engine downloads. The npm name is not a claim of registry publication.

Consumers install a supplied tarball:

```sh
npm install /path/to/koma-sdk-0.1.0.tgz
koma sdk --help
node examples/bot.mjs /absolute/workspace
```

```js
import { Client } from '@koma/sdk';
const client = new Client({ executable: '/absolute/path/to/koma' });
try {
  console.log(await client.probe());
  const session = await client.create({ cwd: '/absolute/workspace' });
  console.log(session.sessionId); // save for explicit resume
  const result = await session.submit({ text: 'Explain this repository' });
  if (result.disposition === 'started') {
    console.log(await session.waitTurn(result.turn_id, { timeoutMs: 120_000 }));
    console.log((await session.getState()).messages);
  }
} finally { await client.close(); }
```

`client.configure({providers, models})` fills an empty Koma before `create`. `session.configure(...)` swaps providers or roles while the session is running; the next `submit` uses them. A new provider needs `api_key`. Omitting it on a later call keeps the stored key. The reply contains names and uuids, never the key.

`executable` defaults to `koma` on PATH. `create` defaults to `{plan:'forbid',approval:'reject'}`; reject denies approval-requiring gates, not every tool, and is not a sandbox.
`resume({session_id})` preserves policy/cwd. Explicit policy changes honor daemon idle guards. External tool approvals require `external_approvals:true`; normally supply policy `{plan:'forbid',approval:'default'}` too.
Get `pending_approval.call_id` from `getState()` and call `approve(callId, true/false)`; plan/mission gates are visible but unsupported.

`submit({text,attachments})`, `enqueue(...)`, `interrupt(turnId)` and `interruptAndSubmit(turnId,input)` preserve typed daemon dispositions.
Enqueue admits to a five-entry FIFO/coalescing queue; it creates no reserved future turn ID. Replacement retains `interrupted_turn_id` on partial failure.
Attachments are `{kind:'image_file',path:'/absolute/chart.png'}` or `{kind:'pasted_text',text:'context',name:'label'}`. Paths are on the daemon host, not uploads. See the shared guide for limits.

`for await (const event of session.events())` allows one consumer. Handle full `state` replacements, `output_append` suffixes and informational `turn` observations; revisions/UTF-8 offsets prevent duplicate appends. Offset/revision mismatch causes state readback. A sequence gap triggers state readback; nonmonotonic sequences close the adapter. Event overflow clears buffered events, pauses buffering, and raises `SdkError` with code `event_overflow` through event consumption. Pending requests, polling waits, and control methods remain usable, including polling-only `submit` / `waitTurn` calls on long streams.

After catching `event_overflow`, start a new `session.events()` iterator. It enables buffering, reads authoritative state, and yields a state event with `resynced: true` before later output. Queued observations superseded by that state are ignored. Overflow during recovery raises `event_overflow` again. Polling waits do not consume an active iterator's events. Malformed frames and transport failures still close the connection. Events can precede method responses.
Bounded buffers: 256 events / 64 MiB, 64 pending requests, 64 MiB outbound buffering, 64 KiB stderr tail, 40 MiB frames. Keep consuming events during long-running work.

Requests accept `{signal,timeoutMs}`. Cancelling a local await does not interrupt a turn. A dispatched mutation with a lost reply throws `DeliveryUnknownError` containing available `requestId`, `sessionId`, `turnId`; no automatic retries. Resume/read state before deciding what to do.
`waitTurn` reports final observation, not goal success; a newer hidden turn raises `TurnReplacedError`, timeout raises an observation/timeout error. `finished` only means execution ended normally.
`detach`, `close` and stopping event iteration never stop/delete the daemon session. Use explicit targeted interruption when intended.

## Maintainers

```sh
npm ci
npm test
npm pack --pack-destination /tmp
# Install that tarball in a clean project, then test the public import.
```

`npm run build` emits ESM JS and `.d.ts` into `dist`. Build before packing; intentionally no install/prepare hooks. Tests use the shared fake adapter, with `PYTHON` override if needed. Real examples intentionally submit provider-backed inference. Windows/Linux runtime verification is separate from source portability.
