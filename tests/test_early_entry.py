"""Exercise the real entry constructor with private paths and a fixture UID."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class EarlyEntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='xtream-entry-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.runtime = self.base / 'runtime'
        self.entry = self.runtime / 'early-entry'
        self.run = self.base / 'run'
        self.entry.mkdir(parents=True)
        self.run.mkdir()
        self.failsafe = self.base / 'failsafe'
        self.armed = self.entry / 'armed'
        self.claimed = self.entry / 'claimed'
        self.marker = self.entry / 'marker.log'
        self.enabled = self.runtime / 'enabled'
        self.enabled.touch()
        (self.base / 'uptime').write_text('16.0 0.0\n')
        source = (ROOT / 'experimental/early-entry/early-marker.c').read_text()
        source = source.replace('/var/lib/xtream-native', str(self.runtime)).replace('/run/xtream-native', str(self.run))
        source = source.replace('/var/luna/preferences/webosbrew_failsafe', str(self.failsafe)).replace('/proc/uptime', str(self.base / 'uptime'))
        source += '\nunsigned int fixture_uid(void){char *v=getenv("ENTRY_FIXTURE_UID");return v&&v[0]==\'0\'?0:501;}\n'
        # The production flags are Linux ABI constants; translate only this
        # syscall boundary when executing the constructor on a macOS host.
        source += '''
#undef open
#include <fcntl.h>
int fixture_open(const char *p,int flags,...){
    int native=flags&3;
    if(flags&64)native|=O_CREAT;
    if(flags&128)native|=O_EXCL;
    return open(p,native,0600);
}
'''
        target = self.base / 'entry.c'
        target.write_text(source)
        self.library = self.base / ('entry.dylib' if sys.platform == 'darwin' else 'entry.so')
        compiler = os.environ.get('CC') or shutil.which('clang') or shutil.which('cc')
        self.assertIsNotNone(compiler, 'A host C compiler is required for entry guard checks.')
        command = [compiler, '-dynamiclib'] if sys.platform == 'darwin' else [compiler, '-shared', '-fPIC']
        subprocess.run(command + ['-O2', '-fno-builtin', '-Dgetuid=fixture_uid', '-Dopen=fixture_open', str(target), '-o', str(self.library)], check=True, capture_output=True)

    def load(self, value='1', uid='0'):
        env = dict(os.environ, XTREAM_EARLY_ENTRY=value, ENTRY_FIXTURE_UID=uid)
        env.pop('XTREAM_EARLY_DISPATCH', None)  # Never execute dispatch on the host.
        subprocess.run([sys.executable, '-c', 'import ctypes,sys;ctypes.CDLL(sys.argv[1])', str(self.library)], env=env, check=True, capture_output=True)

    def test_a_lease_is_consumed_and_later_tts_restart_preserves_next_boot_lease(self):
        self.armed.touch()
        self.load()
        self.assertFalse(self.armed.exists())
        self.assertTrue(self.claimed.exists())
        self.assertIn('uid=0', self.marker.read_text())
        self.assertEqual(self.marker.stat().st_mode & 0o777, 0o600)
        before = self.marker.read_bytes()
        self.armed.touch()
        self.load()
        self.assertTrue(self.armed.exists())
        self.assertEqual(self.marker.read_bytes(), before)

    def test_wrong_flag_and_nonroot_do_not_consume_a_lease(self):
        self.armed.touch()
        for value, uid in [('', '0'), ('1x', '0'), ('1', '501')]:
            self.load(value, uid)
            self.assertTrue(self.armed.exists())
            self.assertFalse(self.marker.exists())

    def test_disabled_and_homebrew_failsafe_leave_the_lease_untouched(self):
        self.armed.touch()
        self.enabled.unlink()
        self.load()
        self.enabled.touch()
        self.failsafe.touch()
        self.load()
        self.assertTrue(self.armed.exists())
        self.assertFalse(self.marker.exists())

    def test_unarmed_load_does_not_dispatch_or_write_a_marker(self):
        self.load()
        self.assertFalse(self.marker.exists())
        self.assertFalse((self.entry / 'dispatch-result.log').exists())

    def run_disable(self, environment):
        env_file = self.base / 'tts.env'
        env_file.write_text(environment)
        (self.entry / 'auto-rearm').touch()
        self.armed.touch()
        library = self.entry / 'libxtream-early.so'
        library.write_bytes(b'synthetic-library')
        commands = self.base / 'bin'
        commands.mkdir()
        stub = commands / 'systemctl'
        stub.write_text('#!/bin/sh\nexit 0\n')
        stub.chmod(0o700)
        source = (ROOT / 'experimental/early-entry/disable.sh').read_text()
        source = source.replace('/var/lib/xtream-native', str(self.runtime)).replace('/run/xtream-native', str(self.run))
        source = source.replace('/var/systemd/system/env/tts.env', str(env_file))
        result = subprocess.run(['/bin/sh'], input=source, text=True, env=dict(os.environ, PATH=str(commands)+os.pathsep+os.environ['PATH']), capture_output=True)
        self.assertFalse(self.armed.exists())
        self.assertFalse((self.entry / 'auto-rearm').exists())
        self.assertTrue(library.exists())
        self.assertTrue(self.enabled.exists())
        return result, env_file

    def test_disable_removes_owned_environment_before_retaining_library_and_normal_startup(self):
        result, env_file = self.run_disable('LD_PRELOAD='+str(self.entry / 'libxtream-early.so')+'\nXTREAM_EARLY_ENTRY=1\nXTREAM_EARLY_DISPATCH=start\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(env_file.exists())

    def test_disable_preserves_an_environment_containing_other_configuration(self):
        original = 'UNRELATED=value\nLD_PRELOAD='+str(self.entry / 'libxtream-early.so')+'\n'
        result, env_file = self.run_disable(original)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(env_file.read_text(), original)


if __name__ == '__main__':
    unittest.main()
