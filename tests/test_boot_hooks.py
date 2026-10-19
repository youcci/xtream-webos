"""Execute the actual boot hooks against temporary paths and a systemctl stub."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class BootHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='xtream-boot-hooks-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.runtime = self.base / 'runtime'
        self.units = self.base / 'units'
        self.bin = self.base / 'bin'
        self.runtime.mkdir()
        self.bin.mkdir()
        self.log = self.base / 'calls'
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'], BOOT_TEST_LOG=str(self.log))
        for path, source in [
            (self.bin / 'systemctl', '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BOOT_TEST_LOG"\nif [ "${BOOT_TEST_FAIL_UNIT:-0}" = 1 ] && [ "$1" = start ]; then exit 1; fi\nexit 0\n'),
            (self.runtime / 'control.sh', '#!/bin/sh\nprintf "legacy-start\\n" >> "$BOOT_TEST_LOG"\n')
        ]:
            path.write_text(source)
            path.chmod(0o700)
        (self.runtime / 'xtream-native-boot.service').write_text((ROOT / 'runtime/xtream-native-boot.service').read_text())

    def run_hook(self, name):
        source = (ROOT / 'runtime/hooks' / name).read_text().replace('/var/lib/xtream-native', str(self.runtime)).replace('/run/systemd/system', str(self.units))
        subprocess.run(['/bin/sh'], input=source, text=True, env=self.env, check=True, capture_output=True)

    def test_early_and_late_hooks_use_the_same_nonblocking_job(self):
        (self.runtime / 'enabled').touch()
        self.run_hook('40-native-xtream')
        self.run_hook('60-native-xtream')
        self.assertEqual(self.log.read_text().splitlines(), ['daemon-reload', 'start --no-block xtream-native-boot.service', 'start --no-block xtream-native-boot.service'])
        self.assertTrue((self.units / 'xtream-native-boot.service').is_file())

    def test_late_hook_preserves_legacy_fallback_without_early_unit(self):
        (self.runtime / 'enabled').touch()
        self.run_hook('60-native-xtream')
        self.assertEqual(self.log.read_text().splitlines(), ['legacy-start'])

    def test_disabled_hooks_do_not_create_or_start_units(self):
        self.run_hook('40-native-xtream')
        self.run_hook('60-native-xtream')
        self.assertFalse(self.log.exists())
        self.assertFalse(self.units.exists())

    def test_late_hook_falls_back_if_the_early_unit_cannot_be_queued(self):
        (self.runtime / 'enabled').touch()
        self.units.mkdir()
        (self.units / 'xtream-native-boot.service').touch()
        self.env['BOOT_TEST_FAIL_UNIT'] = '1'
        self.run_hook('60-native-xtream')
        self.assertEqual(self.log.read_text().splitlines(), ['start --no-block xtream-native-boot.service', 'legacy-start'])
