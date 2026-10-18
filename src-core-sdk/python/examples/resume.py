"""Resume/queue/replace example. Intentionally runs real inference."""
import asyncio
import os
import sys
from koma_sdk import Client, Disposition, PastedText

async def main():
    async with Client(os.environ.get('KOMA_EXECUTABLE', 'koma')) as client:
        async with await client.resume(sys.argv[1]) as session:
            state = await session.get_state()
            if state.turn and state.turn.state.value == 'running':
                print(await session.enqueue('Keep the answer concise.'))
                print(await session.interrupt_and_submit(state.turn.id, 'Describe current progress only.',
                    attachments=[PastedText('Do not change files.', 'constraints')]))
            else:
                print(await session.submit('Describe current progress only.'))
            # Opted-in sessions can answer ordinary tools with the actual pending call ID:
            # await session.approve((await session.get_state()).pending_approval.call_id, False)
            # Plan/mission gates intentionally have no approval API.

asyncio.run(main())
