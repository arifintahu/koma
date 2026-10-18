"""Stdlib subprocess smoke tests; optional JSON Schema fixture validation."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

HERE = Path(__file__).resolve().parent

class Conformance(unittest.TestCase):
    def run_peer(self, scenario, requests):
        result = subprocess.run([sys.executable, str(HERE / 'fake_adapter.py'),
            '--scenario', scenario], input=''.join(json.dumps(r)+'\n' for r in requests),
            text=True, capture_output=True, timeout=5)
        return result, [json.loads(line) for line in result.stdout.splitlines()]

    def test_partial(self):
        _, frames = self.run_peer('partial', [
            dict(id='1', method='create', params=dict(cwd='/tmp')),
            dict(id='2', method='submit', params=dict(text='hello')),
            dict(id='3', method='interrupt_and_submit', params=dict(turn_id='turn-1',text='replace')),
            dict(id='4', method='detach', params={})])
        self.assertEqual(frames[0]['type'], 'hello')
        reply = next(f for f in frames if f.get('id') == '3')['result']
        self.assertEqual(reply['disposition'], 'rejected')
        self.assertEqual(reply['interrupted_turn_id'], 'turn-1')
        self.assertEqual(frames[-1]['result'], dict(detached=True))

    def test_reordered(self):
        _, frames = self.run_peer('out_of_order', [
            dict(id='1', method='create', params=dict(cwd='/tmp')),
            dict(id='2', method='state', params={})])
        self.assertEqual([f['id'] for f in frames[1:]], ['2','1'])

    def test_unknown(self):
        _, frames = self.run_peer('unknown', [
            dict(id='1', method='create', params=dict(cwd='/tmp')),
            dict(id='2', method='submit', params=dict(text='hello'))])
        self.assertEqual(frames[-1]['error']['delivery'], 'unknown')

    def test_fixtures(self):
        protocol = HERE.parent / 'protocol'
        schema = json.loads((protocol / 'schema.json').read_text())
        for path in (protocol / 'fixtures').glob('*.jsonl'):
            for line in path.read_text().splitlines():
                frame = json.loads(line)
                self.assertIsInstance(frame, dict)
                try:
                    import jsonschema
                except ImportError:
                    continue
                jsonschema.Draft202012Validator(schema).validate(frame)

if __name__ == '__main__':
    unittest.main()
