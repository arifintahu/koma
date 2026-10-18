// Compile in a consumer project with NodeNext module resolution. Real inference.
import { Client } from '@koma/sdk';
const client = new Client({ executable: process.env.KOMA_EXECUTABLE ?? 'koma' });
try {
  const session = await client.resume({ session_id: process.argv[2]! });
  const state = await session.getState();
  if (state.turn?.state === 'running') {
    console.log(await session.enqueue({ text: 'Keep the answer concise.' }));
    console.log(await session.interruptAndSubmit(state.turn.id, {
      text: 'Describe progress only.', attachments: [{ kind: 'pasted_text', text: 'Do not edit files.', name: 'constraints' }],
    }));
  } else console.log(await session.submit({ text: 'Describe progress only.' }));
  // Explicit external_approvals opt-in allows ordinary pending calls only:
  // await session.approve((await session.getState()).pending_approval!.call_id, false);
  // No plan/mission approval API is provided.
} finally { await client.close(); }
