// Intentional real inference; install the package tarball before running.
import { Client } from '@koma/sdk';
import { resolve } from 'node:path';
const client = new Client({ executable: process.env.KOMA_EXECUTABLE ?? 'koma' });
try {
  console.log(await client.probe());
  const session = await client.create({ cwd: resolve(process.argv[2]) });
  console.log('Save session ID:', session.sessionId);
  const controller = new AbortController();
  const observation = (async () => {
    try {
      for await (const event of session.events({ signal: controller.signal })) {
        if (event.event === 'output_append') process.stdout.write(event.text);
        else if (event.event === 'state') console.log('[state]', event.state.turn);
      }
    } catch (e) { if (!controller.signal.aborted) throw e; }
  })();
  try {
    const result = await session.submit({ text: 'Briefly explain this repository; do not edit files.' });
    if (result.disposition === 'started') console.log(await session.waitTurn(result.turn_id, { timeoutMs: 120_000 }));
  } finally { controller.abort(); await observation; }
} finally { await client.close(); }
