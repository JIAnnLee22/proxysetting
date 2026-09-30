#!/usr/bin/env python3
"""No root, network, or host systemd required: only mock commands touch a private fixture.
Production paths are rewritten ONLY in a temporary test copy (no runtime test bypass).
Run: python3 scripts/test-install.py
"""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import zipfile

PROJECT = Path(__file__).resolve().parent.parent
AGENT = 'proxysetting-agent.service'
XRAY = 'proxysetting-xray.service'
TOKEN = 'SECRET-enrollment-token-do-not-log'
MOCK = r'''#!/usr/bin/env python3
import hashlib, json, os, pathlib, shutil, subprocess, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
base = pathlib.Path(os.environ['MOCK_BASE'])
root = base / 'root'
log = base / 'events'
with log.open('a') as out: out.write(name + ' ' + ' '.join(args) + '\n')
def env(key, default=''): return os.environ.get(key, default)
def fail(): sys.exit(1)
if name == 'id': print(env('MOCK_UID', '0'))
elif name == 'uname': print(env('MOCK_ARCH', 'x86_64'))
elif name == 'stat':
    if args[:2] == ['-c', '%u']: print('0')
    else: os.execv(env('REAL_STAT'), [env('REAL_STAT')] + args)
elif name == 'ss':
    if env('MOCK_BUSY_PORT') and args[-1] == 'sport = :' + env('MOCK_BUSY_PORT'): print('LISTEN 0 128 0.0.0.0:' + env('MOCK_BUSY_PORT'))
elif name == 'sha256sum':
    path = pathlib.Path(args[-1])
    if path.name == 'xray.zip' and not env('MOCK_BAD_XRAY'):
        digest = ('4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c'
                  if env('MOCK_ARCH') in ['aarch64', 'arm64'] else
                  '23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae')
        print(digest + '  ' + str(path))
    else: os.execv(env('REAL_SHA'), [env('REAL_SHA')] + args)
elif name == 'curl':
    dest = pathlib.Path(args[args.index('--output') + 1]); url = args[-1]
    if env('MOCK_DOWNLOAD_FAIL') and env('MOCK_DOWNLOAD_FAIL') in url: fail()
    if '/XTLS/Xray-core/releases/download/v26.3.27/' in url:
        if not url.endswith(('Xray-linux-64.zip', 'Xray-linux-arm64-v8a.zip')): fail()
        src = base / 'assets' / 'xray.zip'
    else:
        if not url.startswith('https://github.com/owner/repo/releases/download/'): fail()
        version, asset = url.split('/download/', 1)[1].split('/', 1)
        src = base / 'assets' / version / asset
    if not src.is_file(): fail()
    shutil.copyfile(src, dest)
elif name == 'systemctl':
    statefile = base / 'systemd.json'
    state = json.loads(statefile.read_text()) if statefile.exists() else {'active': [], 'enabled': []}
    units = [a for a in args if a.endswith('.service')]
    command = args[0]
    if command == 'show':
        prop = next((a.split('=', 1)[1] for a in args if a.startswith('--property=')), '')
        if prop == 'Version': print('252')
        elif prop == 'LoadState':
            print('loaded' if env('MOCK_FOREIGN') or (base / 'system' / units[0]).exists() else 'not-found')
        elif prop == 'FragmentPath':
            print('/usr/lib/systemd/system/' + units[0] if env('MOCK_FOREIGN') else str(base / 'system' / units[0]))
        elif prop == 'DropInPaths': print(env('MOCK_DROPINS'))
        else: fail()
    elif command == 'is-active':
        sys.exit(0 if all(u in state['active'] for u in units) else 3)
    elif command == 'start':
        version = (root / 'current').resolve().name
        if env('MOCK_START_FAIL') == version: fail()
        # Model notify readiness and dependencies, not real PID1 behavior.
        state['active'] = ['proxysetting-xray.service', 'proxysetting-agent.service']
    elif command == 'stop':
        marker = base / 'stop-failed'
        if env('MOCK_STOP_FAIL') and not marker.exists(): marker.touch(); fail()
        if 'proxysetting-agent.service' in units and 'proxysetting-agent.service' in state['active']:
            assert 'proxysetting-xray.service' in state['active'], 'final sample lost API'
            with log.open('a') as out: out.write('final-sample-api-alive\n')
            usage = root / 'state' / 'usage.json'
            old = json.loads(usage.read_text())
            old['sequence'] += 1
            usage.write_text(json.dumps(old)); usage.chmod(0o600)
            state['active'] = []  # BindsTo stops Xray after final sample.
        else: state['active'] = [u for u in state['active'] if u not in units]
    elif command == 'kill': state['active'] = [u for u in state['active'] if u not in units]
    elif command == 'enable': state['enabled'] = units
    elif command == 'disable': state['enabled'] = []
    elif command in ['reset-failed', 'daemon-reload']: pass
    else: fail()
    if 'proxysetting-xray.service' in state['active']:
        assert 'proxysetting-agent.service' in state['active'], 'unmetered Xray'
    statefile.write_text(json.dumps(state))
else: fail()
'''
FAKE_AGENT = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
version = '__VERSION__'
if args == ['--version']:
    print(os.environ.get('MOCK_AGENT_VERSION', version)); sys.exit(0)
root = pathlib.Path(args[args.index('--root') + 1])
with (pathlib.Path(os.environ['MOCK_BASE']) / 'events').open('a') as out:
    out.write('agent-' + args[0] + '-' + version + '\n')
if args[0] == 'install':
    assert '--repo' not in args and '--version' not in args and '--token' not in args
    assert os.environ.get('PROXYSETTING_ENROLL_TOKEN') == 'SECRET-enrollment-token-do-not-log'
    if os.environ.get('MOCK_ENROLL_FAIL'):
        print(os.environ['PROXYSETTING_ENROLL_TOKEN'], file=sys.stderr); sys.exit(1)
    for path, value in [(root/'config'/'agent.json', {'version': version}),
                        (root/'config'/'xray.json', {'inbounds': []}),
                        (root/'state'/'usage.json', {'sequence': 1})]:
        path.write_text(json.dumps(value)); path.chmod(0o600)
    if os.environ.get('MOCK_INSECURE_CONFIG'): (root/'config'/'agent.json').chmod(0o666)
elif args[0] == 'check':
    assert not os.environ.get('PROXYSETTING_ENROLL_TOKEN'), 'persistent enrollment token'
    if os.environ.get('MOCK_HEALTH_FAIL') == version or os.environ.get('MOCK_HEALTH_FAIL') == 'all': sys.exit(1)
else: sys.exit(1)
'''
FAKE_XRAY = r'''#!/usr/bin/env python3
import os, pathlib, sys
assert sys.argv[1:3] == ['run', '-test']
with (pathlib.Path(os.environ['MOCK_BASE']) / 'events').open('a') as out: out.write('xray-test\n')
if os.environ.get('MOCK_XRAY_TEST_FAIL'): sys.exit(1)
'''


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='proxysetting-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'root'
        (self.base / 'system').mkdir()
        (self.base / 'run-systemd').mkdir()
        (self.base / 'os-release').write_text('ID=debian\n')
        (self.base / 'mocks').mkdir()
        (self.base / 'assets').mkdir()
        self.env = dict(os.environ)
        self.env.pop('PROXYSETTING_ENROLL_TOKEN', None)
        self.env.update(MOCK_BASE=str(self.base), REAL_SHA=shutil.which('sha256sum'),
                        REAL_STAT=shutil.which('stat'),
                        PATH=str(self.base / 'mocks') + os.pathsep + os.environ['PATH'])
        # System path substitution is test-only. Production installer has no override/backdoor.
        self.installer = self.base / 'install.sh'
        text = (PROJECT / 'scripts' / 'install.sh').read_text()
        for old, new in [('/etc/systemd/system', self.base / 'system'),
                         ('/run/systemd/system', self.base / 'run-systemd'),
                         ('/etc/os-release', self.base / 'os-release')]:
            text = text.replace(old, str(new))
        self.installer.write_text(text)
        self.installer.chmod(0o755)
        for command in ['id', 'uname', 'stat', 'ss', 'sha256sum', 'curl', 'systemctl']:
            path = self.base / 'mocks' / command
            path.write_text(MOCK)
            path.chmod(0o755)
        with zipfile.ZipFile(self.base / 'assets' / 'xray.zip', 'w') as archive:
            archive.writestr('xray', FAKE_XRAY)
        for version in ['v0.1.0', 'v0.2.0', 'v0.3.0']:
            self.release(version)

    def release(self, version):
        directory = self.base / 'assets' / version
        directory.mkdir()
        (directory / 'install.sh').write_bytes(self.installer.read_bytes())
        for arch in ['amd64', 'arm64']:
            name = f'proxysetting-agent-linux-{arch}.tar.gz'
            with tarfile.open(directory / name, 'w:gz') as archive:
                files = {'bin/proxysetting-agent': FAKE_AGENT.replace('__VERSION__', version).encode()}
                for unit in [AGENT, XRAY]:
                    files['packaging/' + unit] = (PROJECT / 'packaging' / unit).read_bytes()
                for filename, data in files.items():
                    member = tarfile.TarInfo(filename)
                    member.size = len(data)
                    member.mode = 0o755 if filename.startswith('bin/') else 0o644
                    archive.addfile(member, io.BytesIO(data))
        self.manifest(version)

    def manifest(self, version):
        directory = self.base / 'assets' / version
        lines = [hashlib.sha256((directory / name).read_bytes()).hexdigest() + '  ' + name
                 for name in ['install.sh', 'proxysetting-agent-linux-amd64.tar.gz', 'proxysetting-agent-linux-arm64.tar.gz']]
        (directory / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')

    def call(self, args=None, expected=0, **extra):
        if args is None:
            args = ['--control-url', 'https://control.example', '--address', '203.0.113.10',
                    '--port', '443', '--server-name', 'www.example.com',
                    '--version', 'v0.1.0', '--repo', 'owner/repo']
            extra = dict(PROXYSETTING_ENROLL_TOKEN=TOKEN, **extra)
        result = subprocess.run(['bash', str(self.installer), '--root', str(self.root)] + args,
                                env=dict(self.env, **extra), text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=20)
        self.assertNotIn(TOKEN, result.stdout, 'token leaked to console')
        if expected == 0:
            self.assertEqual(result.returncode, 0, result.stdout)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        statefile = self.base / 'systemd.json'
        if statefile.exists():
            active = json.loads(statefile.read_text())['active']
            self.assertFalse(XRAY in active and AGENT not in active, 'unmetered Xray')
        return result.stdout

    def events(self):
        return (self.base / 'events').read_text()

    def active(self):
        return json.loads((self.base / 'systemd.json').read_text())['active']

    def current(self):
        return (self.root / 'current').resolve().name

    def upgrade(self, expected=0, version='v0.2.0', **extra):
        return self.call(['--upgrade', '--version', version], expected=expected, **extra)

    def test_install_amd64(self):
        out = self.call()
        self.assertEqual(self.current(), 'v0.1.0')
        self.assertIn('Firewall rules were NOT changed', out)
        self.assertEqual((self.root / 'config' / 'release.env').read_text(),
                         'RELEASE_REPO=owner/repo\nXRAY_VERSION=v26.3.27\n')
        for path in ['config/agent.json', 'config/xray.json', 'state/usage.json', 'config/release.env']:
            self.assertEqual((self.root / path).stat().st_mode & 0o777, 0o600)
        self.assertIn(AGENT, self.active())
        self.assertIn('Xray-linux-64.zip', self.events())
        self.assertNotIn(' --token ', self.events())
        self.assertNotIn(TOKEN, self.events())

    def test_install_ubuntu_arm64(self):
        (self.base / 'os-release').write_text('ID="ubuntu"\n')
        self.call(MOCK_ARCH='aarch64')
        self.assertIn('Xray-linux-arm64-v8a.zip', self.events())

    def test_install_arch_amd64(self):
        (self.base / 'os-release').write_text('ID=arch\n')
        self.call()
        self.assertEqual(self.current(), 'v0.1.0')
        self.assertIn(AGENT, self.active())
        self.assertIn('Xray-linux-64.zip', self.events())

    def test_initial_fixed_newer_version(self):
        args = ['--control-url', 'https://control.example', '--address', '203.0.113.10',
                '--port', '443', '--server-name', 'www.example.com', '--version', 'v0.2.0', '--repo', 'owner/repo']
        self.call(args, PROXYSETTING_ENROLL_TOKEN=TOKEN)
        self.assertEqual(self.current(), 'v0.2.0')
        self.assertIn(AGENT, self.active())

    def test_binary_version_mismatch_refused(self):
        self.call(expected=1, MOCK_AGENT_VERSION='v9.9.9')
        self.assertNotIn('agent-install-', self.events())
        self.assertEqual(self.active(), [])
        self.assertFalse((self.root / 'current').exists())

    def test_unsupported_os_arch_nonroot_and_no_systemd(self):
        (self.base / 'os-release').write_text('ID=fedora\n')
        self.call(expected=1)
        (self.base / 'os-release').write_text('ID=debian\n')
        self.call(expected=1, MOCK_ARCH='riscv64')
        self.call(expected=1, MOCK_UID='1000')
        (self.base / 'run-systemd').rmdir()
        self.call(expected=1)
        self.assertNotIn('curl ', self.events())
        self.assertFalse(self.root.exists())

    def test_repeat_never_overwrites(self):
        self.call()
        before = (self.root / 'config' / 'agent.json').read_bytes()
        self.call(expected=1)
        self.assertEqual(before, (self.root / 'config' / 'agent.json').read_bytes())
        self.assertEqual(self.events().count('agent-install-'), 1)

    def test_nonempty_root_is_refused(self):
        self.root.mkdir()
        (self.root / 'important').write_text('preserve')
        self.call(expected=1)
        self.assertEqual((self.root / 'important').read_text(), 'preserve')
        self.assertNotIn('curl ', self.events())

    def test_symlink_root_and_dot_traversal_refused(self):
        other = self.base / 'other'; other.mkdir()
        self.root.symlink_to(other)
        self.call(expected=1)
        self.assertFalse(list(other.iterdir()))
        self.call(['--root', str(self.base / 'root' / '..' / 'escape')], expected=1)
        self.assertFalse((self.base / 'escape').exists())

    def test_port_conflicts(self):
        self.call(expected=1, MOCK_BUSY_PORT='443')
        self.call(expected=1, MOCK_BUSY_PORT='10085')
        args = ['--control-url', 'https://control.example', '--address', '203.0.113.10',
                '--port', '10085', '--server-name', 'www.example.com', '--version', 'v0.1.0', '--repo', 'owner/repo']
        self.call(args, expected=1, PROXYSETTING_ENROLL_TOKEN=TOKEN)
        self.assertNotIn('curl ', self.events())

    def test_bad_port_and_unpinned_version(self):
        args = ['--control-url', 'https://control.example', '--address', '203.0.113.10',
                '--port', '65536', '--server-name', 'www.example.com', '--version', 'v0.1.0', '--repo', 'owner/repo']
        self.call(args, expected=1, PROXYSETTING_ENROLL_TOKEN=TOKEN)
        args[args.index('65536')] = '443'
        args[args.index('v0.1.0')] = 'latest'
        self.call(args, expected=1, PROXYSETTING_ENROLL_TOKEN=TOKEN)
        self.assertFalse(self.root.exists())

    def test_foreign_unit_file_or_vendor_unit_refused(self):
        unit = self.base / 'system' / AGENT
        unit.write_text('# Managed by proxysetting;\n[Service]\nExecStart=/bin/false\n')
        self.call(expected=1)
        self.assertIn('ExecStart=/bin/false', unit.read_text())
        unit.unlink()
        self.call(expected=1, MOCK_FOREIGN='1')
        self.assertNotIn('curl ', self.events())

    def test_checksums_agent_installer_xray(self):
        agent = self.base / 'assets' / 'v0.1.0' / 'proxysetting-agent-linux-amd64.tar.gz'
        original = agent.read_bytes()
        agent.write_bytes(original + b'tampered')
        self.call(expected=1)
        self.assertNotIn('agent-install-', self.events())
        # Failure before staging creates only installer lock; use a fresh root for each attempt.
        shutil.rmtree(self.root)
        agent.write_bytes(original)
        script = self.base / 'assets' / 'v0.1.0' / 'install.sh'
        original = script.read_bytes(); script.write_bytes(original + b'bad')
        self.call(expected=1)
        shutil.rmtree(self.root)
        script.write_bytes(original)
        self.call(expected=1, MOCK_BAD_XRAY='1')
        self.assertNotIn('agent-install-', self.events())
        self.assertFalse((self.root / 'current').exists())

    def test_duplicate_checksum_refused(self):
        manifest = self.base / 'assets' / 'v0.1.0' / 'SHA256SUMS'
        text = manifest.read_text(); manifest.write_text(text + text)
        self.call(expected=1)
        self.assertNotIn('agent-install-', self.events())

    def test_malicious_archive_member_not_extracted(self):
        archive = self.base / 'assets' / 'v0.1.0' / 'proxysetting-agent-linux-amd64.tar.gz'
        with tarfile.open(archive, 'w:gz') as out:
            member = tarfile.TarInfo('../../escaped'); member.size = 5
            out.addfile(member, io.BytesIO(b'owned'))
        self.manifest('v0.1.0')
        self.call(expected=1)
        self.assertFalse((self.base / 'escaped').exists())
        self.assertNotIn('agent-install-', self.events())

    def test_failed_enrollment_and_reinstall_refused(self):
        self.call(expected=1, MOCK_ENROLL_FAIL='1')
        self.assertEqual(self.active(), [])
        self.assertFalse((self.root / 'current').exists())
        self.assertFalse((self.base / 'system' / AGENT).exists())
        self.call(expected=1)
        self.assertEqual(self.events().count('agent-install-'), 1)

    def test_invalid_xray_and_initial_readiness_fail_closed(self):
        self.call(expected=1, MOCK_XRAY_TEST_FAIL='1')
        self.assertEqual(self.active(), [])
        shutil.rmtree(self.root)
        self.call(expected=1, MOCK_HEALTH_FAIL='v0.1.0')
        self.assertEqual(self.active(), [])
        self.assertFalse((self.base / 'system' / AGENT).exists())

    def test_unsafe_agent_generated_file_refused(self):
        self.call(expected=1, MOCK_INSECURE_CONFIG='1')
        self.assertEqual(self.active(), [])

    def test_upgrade_and_manual_rollback_from_persisted_repo(self):
        self.call()
        self.upgrade()
        self.assertEqual(self.current(), 'v0.2.0')
        self.assertEqual((self.root / 'previous').resolve().name, 'v0.1.0')
        self.assertIn('final-sample-api-alive', self.events())
        events = self.events()
        self.assertLess(events.index('final-sample-api-alive'), events.index('/download/v0.2.0/SHA256SUMS'))
        self.assertEqual(events.count('agent-install-'), 1)
        self.call(['--rollback'])
        self.assertEqual(self.current(), 'v0.1.0')
        self.assertEqual((self.root / 'previous').resolve().name, 'v0.2.0')
        self.assertEqual(json.loads((self.root / 'state' / 'usage.json').read_text())['sequence'], 3)

    def test_upgrade_foreign_unit_dropin_and_repo_refused_without_stop(self):
        self.call()
        before = self.events()
        unit = self.base / 'system' / XRAY
        original = unit.read_text(); unit.write_text(original + '# custom foreign replacement\n')
        self.upgrade(expected=1)
        self.assertNotIn('systemctl stop', self.events()[len(before):])
        self.assertEqual(unit.read_text(), original + '# custom foreign replacement\n')
        unit.write_text(original)
        self.upgrade(expected=1, MOCK_DROPINS='/etc/foreign.conf')
        self.call(['--upgrade', '--version', 'v0.2.0', '--repo', 'evil/repo'], expected=1)
        self.assertNotIn('systemctl stop', self.events()[len(before):])
        self.assertEqual(self.current(), 'v0.1.0')

    def test_upgrade_failures_restore_and_keep_final_usage(self):
        self.call()
        before = (self.root / 'config' / 'agent.json').read_bytes()
        self.upgrade(expected=1, MOCK_DOWNLOAD_FAIL='/v0.2.0/')
        self.assertEqual(self.current(), 'v0.1.0')
        self.assertEqual(before, (self.root / 'config' / 'agent.json').read_bytes())
        self.assertEqual(json.loads((self.root / 'state' / 'usage.json').read_text())['sequence'], 2)
        self.assertIn(XRAY, self.active())
        self.upgrade(expected=1, MOCK_HEALTH_FAIL='v0.2.0')
        self.assertEqual(self.current(), 'v0.1.0')
        self.assertEqual(json.loads((self.root / 'state' / 'usage.json').read_text())['sequence'], 4)
        self.assertIn(XRAY, self.active())
        self.assertEqual(before, (self.root / 'config' / 'agent.json').read_bytes())

    def test_upgrade_xray_test_and_start_failure_restore(self):
        self.call()
        self.upgrade(expected=1, MOCK_XRAY_TEST_FAIL='1')
        self.assertEqual(self.current(), 'v0.1.0')
        self.assertIn(AGENT, self.active())
        shutil.rmtree(self.root / 'releases' / 'v0.2.0')
        self.upgrade(expected=1, MOCK_START_FAIL='v0.2.0')
        self.assertEqual(self.current(), 'v0.1.0')
        self.assertIn(AGENT, self.active())

    def test_stop_failure_restores_safely(self):
        self.call()
        self.upgrade(expected=1, MOCK_STOP_FAIL='1')
        self.assertEqual(self.current(), 'v0.1.0')
        self.assertIn(AGENT, self.active())

    def test_recovery_failure_stops_everything_and_retains_backup(self):
        self.call()
        out = self.upgrade(expected=1, MOCK_HEALTH_FAIL='all')
        self.assertEqual(self.active(), [])
        self.assertIn('Recovery failed', out)
        self.assertTrue(list(self.root.glob('.installer.*/backup/config/agent.json')))

    def test_missing_previous_and_same_version_refused(self):
        self.call()
        self.call(['--rollback'], expected=1)
        self.upgrade(expected=1, version='v0.1.0')
        self.assertNotIn('systemctl stop', self.events())

    def test_escaping_current_link_refused(self):
        self.call()
        (self.root / 'current').unlink()
        (self.root / 'current').symlink_to(self.base)
        self.upgrade(expected=1)
        self.assertNotIn('systemctl stop', self.events())

    def test_release_env_is_not_sourced(self):
        self.call()
        (self.root / 'config' / 'release.env').write_text('RELEASE_REPO=$(touch ' + str(self.base / 'executed') + ')\n')
        self.upgrade(expected=1)
        self.assertFalse((self.base / 'executed').exists())
        self.assertNotIn('systemctl stop', self.events())

    def test_cli_token_compatibility(self):
        args = ['--control-url', 'https://control.example', '--address', '203.0.113.10', '--port', '443',
                '--server-name', 'www.example.com', '--version', 'v0.1.0', '--repo', 'owner/repo', '--token', TOKEN]
        self.call(args)
        self.assertNotIn(TOKEN, self.events())

    def test_systemd_template_invariants(self):
        agent = (PROJECT / 'packaging' / AGENT).read_text()
        xray = (PROJECT / 'packaging' / XRAY).read_text()
        self.assertIn('Type=notify', agent)
        self.assertIn('WatchdogSec=45s', agent)
        self.assertIn('After=network-online.target proxysetting-xray.service', agent)
        self.assertIn('BindsTo=proxysetting-agent.service', xray)
        self.assertIn('Before=proxysetting-agent.service', xray)
        self.assertNotIn('After=proxysetting-agent.service', xray)
        self.assertNotIn('WantedBy=', xray)


if __name__ == '__main__':
    unittest.main(verbosity=2)
