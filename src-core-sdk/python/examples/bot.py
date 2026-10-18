"""Intentional real inference. KOMA_EXECUTABLE overrides the installed binary."""
import asyncio
import os
import sys
from koma_sdk import Client, Disposition, OutputAppendEvent, StateEvent

async def main():
    async with Client(os.environ.get('KOMA_EXECUTABLE', 'koma')) as client:
        print(await client.probe())
        async with await client.create(os.path.abspath(sys.argv[1])) as session:
            print('Save session ID:', session.session_id)
            async def observe():
                async for event in session.events():
                    if isinstance(event, OutputAppendEvent):
                        print(event.text, end='', flush=True)
                    elif isinstance(event, StateEvent):
                        print('\n[state]', event.state.turn)
            observer = asyncio.create_task(observe())
            try:
                result = await session.submit('Briefly explain this repository; do not edit files.')
                if result.disposition is Disposition.STARTED:
                    print(await session.wait_turn(result.turn_id, timeout=120))
            finally:
                observer.cancel()
                await asyncio.gather(observer, return_exceptions=True)

asyncio.run(main())
