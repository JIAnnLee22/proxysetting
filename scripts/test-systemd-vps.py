#!/usr/bin/env python3
"""Opt-in root/systemd test on an explicitly authorized host. Never changes firewall
or existing proxies. Requires staged bin/{xray,proxysetting-agent}, packaging/units,
and install.sh under --stage. Creates new ephemeral units, refuses name conflicts,
cleans them in finally. Mock HTTPS control is loopback-only, NOT Cloudflare acceptance.
"""
import argparse
from datetime import datetime, timezone, timedelta
import http.server
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import uuid

AGENT = 'proxysetting-agent.service'
XRAY = 'proxysetting-xray.service'


def command(args, check=True, env=None):
    return subprocess.run(args, text=True, capture_output=True, check=check, env=env)


def active(unit):
    return command(['systemctl', 'is-active', '--quiet', unit], check=False).returncode == 0


def prop(unit, name):
    return command(['systemctl', 'show', unit, '--property='+name, '--value']).stdout.strip()


def wait(predicate, seconds, label):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if predicate():
            return
        time.sleep(0.25)
    raise RuntimeError('timeout: '+label)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--stage', required=True)
    args.add_argument('--address', required=True)
    opts = args.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    stage = Path(opts.stage).resolve()
    for unit in (AGENT, XRAY):
        if prop(unit, 'LoadState') != 'not-found' or Path('/etc/systemd/system', unit).exists():
            raise RuntimeError('existing unit; refusing to touch '+unit)
    if Path('/opt/proxysetting').exists():
        raise RuntimeError('existing production root; choose disposable host')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 10085))
    original_443 = command(['ss', '-H', '-ltnp', 'sport = :443']).stdout
    original_firewall = command(['ufw', 'status'], check=False).stdout if shutil.which('ufw') else None
    root = Path(tempfile.mkdtemp(prefix='proxysetting-verification-', dir='/opt'))
    root.chmod(0o700)
    installed = []
    controller = None
    try:
        release = root/'releases'/'v0.1.0'
        shutil.copytree(stage/'bin', release/'bin')
        (root/'current').symlink_to(release)
        (root/'config').mkdir(mode=0o700)
        (root/'state').mkdir(mode=0o700)
        cert, key = root/'config'/'test-ca.crt', root/'config'/'test-ca.key'
        command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                 '-keyout', str(key), '-out', str(cert), '-subj', '/CN=proxysetting-test',
                 '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'])
        cert.chmod(0o600); key.chmod(0o600)
        token = secrets.token_urlsafe(32)
        credential = secrets.token_urlsafe(32)
        identity, vps = str(uuid.uuid4()), str(uuid.uuid4())
        port = free_port()
        month = datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m')
        desired = {'schema': 1, 'vpsId': vps, 'revision': 1, 'port': port,
                   'serverName': 'www.microsoft.com', 'upgrade': None,
                   'users': [{'id': identity, 'email': identity+'@proxysetting',
                              'uuid': str(uuid.uuid4()), 'quotaBytes': 1073741824}],
                   'usage': {'month': month, 'users': [{'id': identity, 'uplink': 1073741825,
                                                       'downlink': 0, 'disabled': True}]}}
        control_state = {'enrolled': False, 'offline': False, 'snapshots': 0}

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def send(self, code, value):
                b = json.dumps(value).encode()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                if control_state['offline']:
                    self.send(503, {'error': 'test outage'})
                elif self.headers.get('Authorization') != 'Bearer '+credential:
                    self.send(401, {})
                else:
                    self.send(200, desired)

            def do_POST(self):
                n = int(self.headers.get('Content-Length', '0'))
                if n > 65536:
                    self.send(413, {}); return
                b = json.loads(self.rfile.read(n))
                if self.path == '/api/agent/register':
                    if b.get('token') != token or control_state['enrolled']:
                        self.send(401, {}); return
                    if b.get('address') != opts.address or b.get('port') != port:
                        self.send(409, {}); return
                    if 'privateKey' in b:
                        self.send(400, {}); return
                    control_state['enrolled'] = True
                    self.send(200, {'vpsId': vps, 'credential': credential, 'config': desired})
                elif control_state['offline']:
                    self.send(503, {})
                elif self.headers.get('Authorization') != 'Bearer '+credential:
                    self.send(401, {})
                else:
                    control_state['snapshots'] += 1
                    self.send(200, {'accepted': True})

        controller = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.minimum_version = ssl.TLSVersion.TLSv1_3
        tls.load_cert_chain(str(cert), str(key))
        controller.socket = tls.wrap_socket(controller.socket, server_side=True)
        threading.Thread(target=controller.serve_forever, daemon=True).start()
        url = 'https://127.0.0.1:'+str(controller.server_port)
        env = dict(os.environ, SSL_CERT_FILE=str(cert), PROXYSETTING_ENROLL_TOKEN=token)
        # Existing 443 proxy must be refused by the agent's port check as well.
        if original_443:
            result = command([str(release/'bin'/'proxysetting-agent'), 'install', '--root', str(root/'port-guard'),
                              '--control-url', url, '--address', opts.address, '--port', '443',
                              '--server-name', desired['serverName']], check=False, env=env)
            assert result.returncode != 0 and 'listen port unavailable' in result.stderr
            assert not control_state['enrolled']
            print('PASS occupied 443 rejected without enrollment or interference', flush=True)
        command([str(release/'bin'/'proxysetting-agent'), 'install', '--root', str(root), '--control-url', url,
                 '--address', opts.address, '--port', str(port), '--server-name', desired['serverName']], env=env)
        assert control_state['enrolled']
        (root/'config'/'release.env').write_text('RELEASE_REPO=example/proxysetting\n')
        (root/'config'/'release.env').chmod(0o600)
        for unit in (AGENT, XRAY):
            rendered = (stage/'packaging'/unit).read_text().replace('@ROOT@', str(root))
            if unit == AGENT:
                # TEST ONLY CA for mock loopback HTTPS; never changes host trust store.
                rendered = rendered.replace('[Service]\n', '[Service]\nEnvironment=SSL_CERT_FILE='+str(cert)+'\n')
            path = Path('/etc/systemd/system', unit)
            if path.exists():
                raise RuntimeError('unit appeared during preparation')
            path.write_text(rendered); path.chmod(0o644); installed.append(path)
        command(['systemctl', 'daemon-reload'])
        def health():
            return active(AGENT) and active(XRAY) and command([str(release/'bin'/'proxysetting-agent'), 'check', '--root', str(root)], check=False).returncode == 0
        def disabled():
            state = json.loads((root/'state'/'usage.json').read_text())
            return state['users'][identity]['disabled'] and state['users'][identity]['uplink'] >= 1073741825
        command(['systemctl', 'start', AGENT])
        wait(health, 15, 'initial readiness')
        assert disabled()
        wait(lambda: control_state['snapshots'] > 0, 10, 'startup snapshot')
        print('PASS real TLS1.3 target, registration, notify READY and durable exhausted quota', flush=True)
        pid = prop(AGENT, 'MainPID')
        command(['systemctl', 'kill', '--kill-whom=main', '--signal=KILL', AGENT])
        wait(lambda: not active(XRAY), 4, 'Xray BindsTo agent crash')
        wait(lambda: health() and prop(AGENT, 'MainPID') != pid, 20, 'agent crash recovery')
        assert disabled()
        print('PASS agent SIGKILL stops Xray and restarts without reviving exhausted user', flush=True)
        old_xray = prop(XRAY, 'MainPID')
        command(['systemctl', 'kill', '--kill-whom=main', '--signal=KILL', XRAY])
        wait(lambda: health() and prop(XRAY, 'MainPID') != old_xray, 65, 'Xray crash detection/recovery')
        assert disabled()
        print('PASS unexpected Xray crash detected; coupled restart preserves disabled quota', flush=True)
        control_state['offline'] = True
        before = json.loads((root/'state'/'usage.json').read_text())['lastSample']
        time.sleep(65)  # includes a real 60-second config poll
        assert health() and disabled()
        assert json.loads((root/'state'/'usage.json').read_text())['lastSample'] != before
        print('PASS control outage keeps cached quotas and ongoing local sampling', flush=True)
        control_state['offline'] = False
        pid = prop(AGENT, 'MainPID')
        command(['systemctl', 'kill', '--kill-whom=main', '--signal=STOP', AGENT])
        wait(lambda: not active(XRAY), 55, 'watchdog must stop Xray for frozen collector')
        wait(lambda: health() and prop(AGENT, 'MainPID') != pid, 25, 'watchdog recovery')
        assert disabled()
        print('PASS frozen collector watchdog kills agent, stops Xray and recovers safely', flush=True)
        began = time.monotonic()
        command(['systemctl', 'stop', AGENT])
        assert not active(XRAY) and not active(AGENT) and time.monotonic()-began < 10
        state = json.loads((root/'state'/'usage.json').read_text())
        assert not state['ready'] and disabled()
        print('PASS graceful final sample and ordered stop (no systemd deadlock)', flush=True)
    finally:
        if installed:
            command(['systemctl', 'kill', '--kill-whom=main', '--signal=CONT', AGENT], check=False)
            command(['systemctl', 'stop', AGENT, XRAY], check=False)
            for path in installed:
                if path.exists() and str(root) in path.read_text():
                    path.unlink()
            command(['systemctl', 'daemon-reload'], check=False)
            command(['systemctl', 'reset-failed', AGENT, XRAY], check=False)
        if controller:
            controller.shutdown(); controller.server_close()
        shutil.rmtree(root)
        assert command(['ss', '-H', '-ltnp', 'sport = :443']).stdout == original_443, 'existing 443 service changed'
        if original_firewall is not None:
            assert command(['ufw', 'status'], check=False).stdout == original_firewall, 'firewall changed'
        print('CLEANUP verified: temporary units/files removed; original 443 service and firewall unchanged', flush=True)


if __name__ == '__main__':
    main()
