"""Offline packaging checks. All tokens below are synthetic."""
import importlib.util
import io
from pathlib import Path
import tarfile
import unittest

spec = importlib.util.spec_from_file_location('cli', Path(__file__).parents[1] / 'tools/xtream_webos.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class PackagingTests(unittest.TestCase):
    def test_debian_container_and_per_device_launcher(self):
        raw = cli.launcher_package('a' * 64)
        self.assertEqual(raw[:8], b'!<arch>\n')
        offset, members = 8, {}
        while offset < len(raw):
            header = raw[offset:offset+60]
            self.assertEqual(header[58:], b'`\n')
            size = int(header[48:58])
            members[header[:16].decode().strip().rstrip('/')] = raw[offset+60:offset+60+size]
            offset += 60 + size + size % 2
        self.assertEqual(offset, len(raw))
        self.assertEqual(members['debian-binary'], b'2.0\n')
        with tarfile.open(fileobj=io.BytesIO(members['data.tar.gz'])) as tar:
            launcher = tar.extractfile('./usr/palm/applications/' + cli.APP_ID + '/index.html').read()
            self.assertIn(('token=' + 'a' * 64).encode(), launcher)
            self.assertIn(b'127.0.0.1:17651', launcher)
            self.assertEqual(len(tar.getmembers()), 4)

    def test_runtime_contains_no_generated_or_private_payload(self):
        with tarfile.open(fileobj=io.BytesIO(cli.runtime_tar())) as tar:
            names = tar.getnames()
            self.assertIn('prepare.js', names)
            self.assertIn('app/app.js', names)
            self.assertIn('hooks/55-disable-lg-channels', names)
            self.assertIn('hooks/40-native-xtream', names)
            self.assertIn('xtream-native-boot.service', names)
            self.assertIn('lib/boot-player.js', names)
            self.assertFalse(any('.private.' in n or n.startswith(('originals/', 'patches/', 'backups/')) for n in names))

    def test_token_and_host_validation(self):
        for token in ('', 'z' * 64, 'a' * 63, 'A' * 64):
            with self.assertRaises(ValueError):
                cli.launcher_package(token)
        for host in ('-oProxyCommand=bad', 'root@host', 'host; id', 'host\ncommand', ''):
            with self.assertRaises(ValueError):
                cli.TV(host)
        self.assertEqual(cli.TV('tv.local').ssh[-1], 'root@tv.local')

    def test_install_refuses_developer_mode_or_legacy_install(self):
        report = dict(compatible=True, webosService=True, startupHooks=True, feedExecutable=True,
                      developerModeInstalled=False, existingInstallation=False, qml='anchors-match',
                      tv=dict(modelName='OLED55G19LA', firmwareVersion='03.53.45', sdkVersion='6.5.3'))
        cli.validate_install(report, False)
        for field in ('developerModeInstalled', 'existingInstallation'):
            with self.assertRaises(RuntimeError):
                cli.validate_install(dict(report, **{field: True}), False)
        with self.assertRaises(RuntimeError):
            cli.validate_install(dict(report, tv={}), False)


if __name__ == '__main__':
    unittest.main()
