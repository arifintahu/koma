import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_terminal', Path(__file__).with_name('prepare-terminal.py'))
payload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(payload)


class PayloadValidation(unittest.TestCase):
    def test_missing_stale_wrong_target_and_corrupt(self):
        original = payload.ROOT
        try:
            with tempfile.TemporaryDirectory() as temporary:
                payload.ROOT = Path(temporary)
                target = payload.host_target()
                with self.assertRaises(FileNotFoundError):
                    payload.check(target)
                (payload.ROOT / 'scripts').mkdir()
                (payload.ROOT / 'scripts/prepare-terminal.py').write_text('fixture')
                term = payload.ROOT / 'src-term'
                term.mkdir()
                for name in ['package.json', 'bun.lock', 'tsconfig.json']:
                    (term / name).write_text('{}')
                dest = payload.ROOT / 'target/terminal' / target
                dest.mkdir(parents=True)
                (dest / 'payload.zip').write_bytes(b'archive')
                manifest = dict(target=target, inputs=payload.inputs(), bun_version=payload.VERSION,
                                archive_sha256=payload.digest(dest / 'payload.zip'))
                def save():
                    (dest / 'manifest.json').write_text(json.dumps(manifest))
                save()
                payload.check(target)
                manifest['target'] = 'wrong-target'
                save()
                with self.assertRaisesRegex(ValueError, 'wrong target'):
                    payload.check(target)
                manifest['target'] = target
                save()
                (term / 'bun.lock').write_text('changed')
                with self.assertRaisesRegex(ValueError, 'stale'):
                    payload.check(target)
                manifest['inputs'] = payload.inputs()
                save()
                (dest / 'payload.zip').write_bytes(b'corrupt')
                with self.assertRaisesRegex(ValueError, 'corrupt'):
                    payload.check(target)
        finally:
            payload.ROOT = original

    def test_five_distinct_pinned_archives(self):
        self.assertEqual(len(payload.TARGETS), 5)
        for os_name, arch, asset, checksum in payload.TARGETS.values():
            self.assertIn(os_name, ['linux', 'darwin', 'win32'])
            self.assertIn(arch, ['x64', 'arm64'])
            self.assertEqual(len(checksum), 64)
            int(checksum, 16)
