# ============================================================
# server/remote.py - 远程 Agent 自动部署与 SSH 隧道
# ============================================================
# 使用系统 ssh/scp：
#   1) 打包最小后端 local_terminal_server.py + requirements.txt + server/
#   2) scp 上传到 ~/.snake-agent/current
#   3) 远程 nohup 启动 Agent，仅监听 127.0.0.1
#   4) 本地 ssh -N -L 建立隧道
# ============================================================

import os
import hashlib
import shlex
import shutil
import socket
import subprocess
import tarfile
import tempfile
import textwrap
import threading
import time
import json
import urllib.parse
import urllib.request
from pathlib import Path

from . import config

_REMOTE_STATE = {
    'connected': False,
    'ssh_command': '',
    'remote_workspace': '',
    'remote_agent_port': 8765,
    'local_port': 0,
    'server_url': '',
    'tunnel_pid': None,
    'started_at': '',
    'last_error': '',
    'tunnel_process': None,
    'heartbeat_thread': None,
    'heartbeat_stop': None,
    'heartbeat_timeout': 300,
    'reverse_git_proxy_enabled': False,
    'reverse_git_proxy_url': '',
    'reverse_git_proxy_port': 0,
    'local_git_proxy_url': '',
}
_REMOTE_CONNECTIONS = {}
_REMOTE_LOCK = threading.RLock()
_LOCAL_PORT_RESERVATIONS = set()


def _remote_state_defaults():
    return {
        'connected': False,
        'ssh_command': '',
        'remote_workspace': '',
        'remote_agent_port': 8765,
        'local_port': 0,
        'server_url': '',
        'tunnel_pid': None,
        'started_at': '',
        'last_error': '',
        'tunnel_process': None,
        'heartbeat_thread': None,
        'heartbeat_stop': None,
        'heartbeat_timeout': 300,
        'reverse_git_proxy_enabled': False,
        'reverse_git_proxy_url': '',
        'reverse_git_proxy_port': 0,
        'local_git_proxy_url': '',
        'connection_id': '',
    }


def _remote_connection_key(ssh_command, remote_workspace='', remote_agent_port=0):
    raw = '\0'.join([
        str(ssh_command or '').strip(),
        str(remote_workspace or '').strip(),
        str(int(remote_agent_port or 0)),
    ])
    return hashlib.sha256(raw.encode('utf-8', errors='replace')).hexdigest()[:16]


def _refresh_remote_state(state):
    if not state:
        return False
    proc = state.get('tunnel_process')
    connected = bool(proc and proc.poll() is None and state.get('server_url'))
    state['connected'] = connected
    if not connected and state.get('local_port'):
        _release_local_port_reservation(state.get('local_port'))
    return connected


def _public_remote_state(state):
    state = state or _remote_state_defaults()
    _refresh_remote_state(state)
    hidden = {'tunnel_process', 'heartbeat_thread', 'heartbeat_stop'}
    return {k: v for k, v in state.items() if k not in hidden}


def _remember_remote_connection(state):
    if not state:
        return state
    key = state.get('connection_id') or _remote_connection_key(
        state.get('ssh_command'),
        state.get('remote_workspace'),
        state.get('remote_agent_port'),
    )
    state['connection_id'] = key
    with _REMOTE_LOCK:
        _REMOTE_CONNECTIONS[key] = state
        _REMOTE_STATE.clear()
        _REMOTE_STATE.update(state)
    return state


def _remote_connection_matches(state, body):
    if not state:
        return False
    target_server_url = (body.get('server_url') or '').strip()
    target_ssh_command = (body.get('ssh_command') or '').strip()
    target_remote_workspace = (body.get('remote_workspace') or '').strip()
    try:
        target_local_port = int(body.get('local_port') or 0)
    except Exception:
        target_local_port = 0
    try:
        target_remote_port = int(body.get('remote_agent_port') or 0)
    except Exception:
        target_remote_port = 0
    target_connection_id = (body.get('connection_id') or '').strip()
    if target_connection_id:
        return target_connection_id == (state.get('connection_id') or '')
    if target_server_url:
        return target_server_url == (state.get('server_url') or '')
    if target_ssh_command and target_ssh_command != (state.get('ssh_command') or ''):
        return False
    if target_remote_workspace and target_remote_workspace != (state.get('remote_workspace') or ''):
        return False
    if target_local_port and target_local_port != int(state.get('local_port') or 0):
        return False
    if target_remote_port and target_remote_port != int(state.get('remote_agent_port') or 0):
        return False
    return True


def _find_remote_connection(body):
    with _REMOTE_LOCK:
        candidates = list(_REMOTE_CONNECTIONS.values())
    for state in candidates:
        if _remote_connection_matches(state, body):
            return state
    if _remote_connection_matches(_REMOTE_STATE, body):
        return _REMOTE_STATE
    return None


def _remote_connections_public():
    with _REMOTE_LOCK:
        return [_public_remote_state(state) for state in _REMOTE_CONNECTIONS.values()]


def _first_connected_remote_state():
    with _REMOTE_LOCK:
        states = list(_REMOTE_CONNECTIONS.values())
    for state in states:
        if _refresh_remote_state(state):
            return state
    return None


def _now_stamp():
    return time.strftime('%Y-%m-%d %H:%M:%S')


def _project_root():
    return Path(__file__).resolve().parent.parent


def _iter_deployment_files():
    root = _project_root()
    files = [
        root / 'local_terminal_server.py',
        root / 'requirements.txt',
    ]
    server_dir = root / 'server'
    if server_dir.is_dir():
        files.extend(sorted(server_dir.rglob('*')))
    for p in files:
        if not p.is_file():
            continue
        rel = p.relative_to(root)
        parts = set(rel.parts)
        if '__pycache__' in parts or p.suffix in ('.pyc', '.pyo'):
            continue
        yield rel.as_posix(), p


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def _deployment_manifest():
    files = []
    fingerprint_source = []
    for rel, path in _iter_deployment_files():
        size = path.stat().st_size
        digest = _sha256_file(path)
        files.append({'path': rel, 'size': size, 'sha256': digest})
        fingerprint_source.append(f'{rel}\0{size}\0{digest}')
    fingerprint_source.sort()
    fingerprint = hashlib.sha256('\n'.join(fingerprint_source).encode('utf-8')).hexdigest()
    return {
        'schema': 1,
        'name': 'snake-agent-backend',
        'fingerprint': fingerprint,
        'files': files,
    }


def _split_cmd(command):
    command = (command or '').strip()
    if not command:
        raise ValueError('SSH 命令不能为空，例如：ssh user@example.com')
    parts = shlex.split(command, posix=(os.name != 'nt'))
    if not parts or Path(parts[0]).name.lower() not in ('ssh', 'ssh.exe'):
        raise ValueError('SSH 命令必须以 ssh 开头，例如：ssh -p 22 user@example.com')
    if len(parts) < 2:
        raise ValueError('SSH 命令缺少远程主机，例如：ssh user@example.com')
    return parts


def _scp_parts_from_ssh(parts):
    """把常见 ssh 参数转换成 scp 参数。约定远程目标在最后一个参数。"""
    target = parts[-1]
    opts = list(parts[1:-1])
    out = ['scp']
    i = 0
    while i < len(opts):
        p = opts[i]
        if p == '-p':
            out.append('-P')
            if i + 1 < len(opts):
                out.append(opts[i + 1]); i += 2; continue
        out.append(p)
        i += 1
    return out, target


def _remote_q(s):
    return shlex.quote(str(s or ''))


def _remote_login_shell_command(script):
    inner = textwrap.dedent(str(script or '')).strip()
    return textwrap.dedent(f'''
        snake_shell="${{SHELL:-}}"
        if command -v getent >/dev/null 2>&1; then
            snake_user="$(id -un 2>/dev/null || printf %s "${{USER:-}}")"
            snake_passwd_shell="$(getent passwd "$snake_user" 2>/dev/null | awk -F: '{{print $7}}' | tail -n 1)"
            if [ -n "$snake_passwd_shell" ]; then snake_shell="$snake_passwd_shell"; fi
        fi
        if [ -z "$snake_shell" ] || [ ! -x "$snake_shell" ]; then snake_shell="/bin/sh"; fi
        SNAKE_AGENT_LOGIN_SHELL="$snake_shell" exec "$snake_shell" -lc {_remote_q(inner)}
    ''').strip()


def _remote_python_bin_script():
    return textwrap.dedent('''
        PY_BIN="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
        if [ -z "$PY_BIN" ]; then
            echo "python3/python not found after loading login shell environment. PATH=$PATH" >&2
            exit 127
        fi
    ''').strip()


def _local_port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(('127.0.0.1', int(port)))
            return True
        except OSError:
            return False


def _pick_local_port(preferred=18765):
    p = int(preferred or 18765)
    with _REMOTE_LOCK:
        for port in range(p, p + 100):
            if port in _LOCAL_PORT_RESERVATIONS:
                continue
            if _local_port_free(port):
                _LOCAL_PORT_RESERVATIONS.add(port)
                return port
    raise RuntimeError('没有可用的本地隧道端口')


def _release_local_port_reservation(port):
    try:
        p = int(port or 0)
    except Exception:
        return
    if not p:
        return
    with _REMOTE_LOCK:
        _LOCAL_PORT_RESERVATIONS.discard(p)


def _normalize_reverse_git_proxy(raw):
    cfg = raw if isinstance(raw, dict) else None
    if not cfg or not cfg.get('enabled'):
        return None, ''
    raw_url = str(cfg.get('url') or '').strip()
    if not raw_url:
        return None, 'Git proxy is enabled, but proxy URL is empty'

    parsed = urllib.parse.urlparse(raw_url)
    scheme = (parsed.scheme or '').lower()
    host = (parsed.hostname or '').lower()
    try:
        port = parsed.port
    except ValueError:
        return None, 'Git proxy port must be an integer from 1 to 65535'

    if scheme not in {'http', 'https', 'socks5', 'socks5h'}:
        return None, 'Git proxy only supports http / https / socks5 / socks5h'
    if host not in {'127.0.0.1', 'localhost'}:
        return None, 'Git proxy must be a local address: 127.0.0.1 or localhost'
    if not isinstance(port, int) or port < 1 or port > 65535:
        return None, 'Git proxy port must be an integer from 1 to 65535'
    if parsed.username or parsed.password:
        return None, 'Git proxy URL must not include username or password'
    if parsed.path not in ('', '/'):
        return None, 'Git proxy URL must not include a path'

    if scheme == 'https':
        scheme = 'http'
    elif scheme == 'socks5':
        scheme = 'socks5h'
    return {
        'scheme': scheme,
        'local_port': port,
        'local_url': f'{scheme}://127.0.0.1:{port}',
    }, ''


def _make_bundle(manifest=None):
    root = _project_root()
    tmp_dir = Path(tempfile.mkdtemp(prefix='snake_remote_bundle_'))
    bundle = tmp_dir / 'snake-agent-backend.tar.gz'
    manifest = manifest or _deployment_manifest()
    manifest_path = tmp_dir / '.snake-agent-deploy-manifest.json'
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')),
        encoding='utf-8',
    )
    with tarfile.open(bundle, 'w:gz') as tar:
        for rel, p in _iter_deployment_files():
            tar.add(p, arcname=rel)
        tar.add(manifest_path, arcname='.snake-agent-deploy-manifest.json')
    return str(bundle), str(tmp_dir)


def _write_askpass(password):
    if not password:
        return None
    d = Path(tempfile.mkdtemp(prefix='snake_askpass_'))
    script = d / ('askpass.bat' if os.name == 'nt' else 'askpass.sh')
    if os.name == 'nt':
        script.write_text('@echo off\r\necho %SNAKE_REMOTE_PASSWORD%\r\n', encoding='utf-8')
    else:
        script.write_text('#!/bin/sh\nprintf "%s\\n" "$SNAKE_REMOTE_PASSWORD"\n', encoding='utf-8')
        script.chmod(0o700)
    return str(script)


def _run(cmd, password='', timeout=120, input_text=None):
    env = os.environ.copy()
    askpass = _write_askpass(password)
    if askpass:
        env['SNAKE_REMOTE_PASSWORD'] = password
        env['SSH_ASKPASS'] = askpass
        env['SSH_ASKPASS_REQUIRE'] = 'prefer'
        env.setdefault('DISPLAY', 'snake-agent:0')
    print(f"🔧 [remote] run: {shlex.join(cmd)}", flush=True)
    try:
        p = subprocess.run(
            cmd,
            input=input_text,
            text=True,
            encoding='utf-8',
            errors='replace',
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            env=env,
            stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
            shell=False,
        )
        out = (p.stdout or '') + (('\n' + p.stderr) if p.stderr else '')
        if p.returncode != 0:
            print(f"❌ [remote] command failed exit={p.returncode}: {out[-2000:]}", flush=True)
            raise RuntimeError(f'命令失败（exit {p.returncode}）：{shlex.join(cmd)}\n{out[-4000:]}')
        if out.strip():
            print(f"✅ [remote] output: {out.strip()[-2000:]}", flush=True)
        return out
    finally:
        if askpass:
            try:
                shutil.rmtree(str(Path(askpass).parent), ignore_errors=True)
            except Exception:
                pass


def _start_tunnel(ssh_parts, local_port, remote_port, password='', reverse_forwards=None):
    cmd = list(ssh_parts[:-1]) + [
        '-N',
        '-o', 'ExitOnForwardFailure=yes',
        '-L', f'127.0.0.1:{int(local_port)}:127.0.0.1:{int(remote_port)}',
    ]
    for item in reverse_forwards or []:
        remote_bind_port = int(item['remote_port'])
        local_target_port = int(item['local_port'])
        cmd.extend(['-R', f'127.0.0.1:{remote_bind_port}:127.0.0.1:{local_target_port}'])
    cmd.append(ssh_parts[-1])
    env = os.environ.copy()
    askpass = _write_askpass(password)
    if askpass:
        env['SNAKE_REMOTE_PASSWORD'] = password
        env['SSH_ASKPASS'] = askpass
        env['SSH_ASKPASS_REQUIRE'] = 'prefer'
        env.setdefault('DISPLAY', 'snake-agent:0')
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, env=env)
    time.sleep(1.2)
    if p.poll() is not None:
        raise RuntimeError('SSH 隧道启动失败，请检查 SSH 命令、密码/密钥和端口占用')
    return p


def _stop_heartbeat(state=None):
    target = state or _REMOTE_STATE
    ev = target.get('heartbeat_stop')
    if ev:
        try:
            ev.set()
        except Exception:
            pass
    target['heartbeat_thread'] = None
    target['heartbeat_stop'] = None


def _start_heartbeat(server_url, interval=15, state=None):
    target = state or _REMOTE_STATE
    _stop_heartbeat(target)
    stop_event = threading.Event()

    def _loop():
        url = server_url.rstrip('/') + '/remote-heartbeat'
        while not stop_event.is_set():
            try:
                with urllib.request.urlopen(url, timeout=5) as resp:
                    resp.read(200)
            except Exception as e:
                target['last_error'] = f'远程心跳失败: {e}'
            stop_event.wait(interval)

    t = threading.Thread(target=_loop, name='remote-agent-heartbeat', daemon=True)
    t.start()
    target['heartbeat_thread'] = t
    target['heartbeat_stop'] = stop_event
    return t


def _wait_for_remote_agent(server_url, timeout=30):
    url = server_url.rstrip('/') + '/remote-heartbeat'
    deadline = time.time() + max(1, int(timeout or 30))
    last_error = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as resp:
                resp.read(200)
                if 200 <= getattr(resp, 'status', 200) < 300:
                    return
        except Exception as e:
            last_error = e
        time.sleep(1)
    detail = f'最后错误：{last_error}' if last_error else '无响应'
    raise RuntimeError(
        '远程 Agent 未在超时时间内响应心跳；'
        '请检查远程日志 ~/.snake-agent/logs/remote-agent.log。' + detail
    )


def _read_remote_workspace_info(server_url, timeout=10):
    """Read /workspace through the local SSH tunnel so the controller can fail with details."""
    url = server_url.rstrip('/') + '/workspace'
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            raw = resp.read(65536).decode('utf-8', errors='replace')
            data = json.loads(raw or '{}')
            if not isinstance(data, dict):
                raise RuntimeError('workspace response is not a JSON object')
            return data
    except Exception as e:
        print(f"❌ [remote] read /workspace failed: {e}", flush=True)
        raise RuntimeError(f'无法读取远程工作区信息：{e}')


def _tail_remote_agent_log(ssh_parts, password='', lines=120):
    """Fetch the tail of the remote Agent log for diagnostics."""
    try:
        n = max(20, min(500, int(lines or 120)))
        cmd = f'test -f ~/.snake-agent/logs/remote-agent.log && tail -n {n} ~/.snake-agent/logs/remote-agent.log || true'
        return _run(ssh_parts + [cmd], password=password, timeout=20).strip()
    except Exception as e:
        return f'读取远程日志失败：{e}'


def _diagnose_remote_workspace(ssh_parts, remote_workspace, password=''):
    """Validate the workspace on the remote host and return human-readable diagnostics."""
    q = _remote_q(remote_workspace)
    cmd = _remote_login_shell_command(f'''
        set +e
        {_remote_python_bin_script()}
        "$PY_BIN" - {q} <<'PY'
import os, sys, json
p = os.path.expanduser(sys.argv[1])
rp = os.path.realpath(p)
info = {{
    'input': sys.argv[1],
    'expanded': p,
    'realpath': rp,
    'exists': os.path.exists(rp),
    'isdir': os.path.isdir(rp),
    'readable': os.access(rp, os.R_OK),
    'executable': os.access(rp, os.X_OK),
}}
print(json.dumps(info, ensure_ascii=False))
if not (info['exists'] and info['isdir'] and info['readable'] and info['executable']):
    sys.exit(2)
PY
    ''')
    return _run(ssh_parts + [cmd], password=password, timeout=30).strip()


def _remote_deployment_matches(ssh_parts, expected_fingerprint, password=''):
    q_expected = _remote_q(expected_fingerprint)
    cmd = _remote_login_shell_command(f'''
        set -e
        {_remote_python_bin_script()}
        "$PY_BIN" - {q_expected} <<'PY'
import json, os, sys

expected = sys.argv[1] if len(sys.argv) > 1 else ''
base = os.path.expanduser('~/.snake-agent/current')
manifest_path = os.path.join(base, '.snake-agent-deploy-manifest.json')
data = {{}}
error = ''
try:
    if os.path.isfile(manifest_path):
        with open(manifest_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
except Exception as e:
    error = str(e)

fingerprint = data.get('fingerprint') if isinstance(data, dict) else ''
main_ok = os.path.isfile(os.path.join(base, 'local_terminal_server.py'))
server_ok = os.path.isdir(os.path.join(base, 'server'))
ok = bool(expected and fingerprint == expected and main_ok and server_ok)
print(json.dumps({{
    'ok': ok,
    'fingerprint': fingerprint or '',
    'expected': expected,
    'manifest': manifest_path,
    'main_ok': main_ok,
    'server_ok': server_ok,
    'error': error,
}}, ensure_ascii=False))
PY
    ''')
    out = _run(ssh_parts + [cmd], password=password, timeout=30).strip()
    for line in reversed(out.splitlines()):
        line = line.strip()
        if line.startswith('{') and line.endswith('}'):
            try:
                return json.loads(line)
            except Exception:
                break
    return {
        'ok': False,
        'fingerprint': '',
        'expected': expected_fingerprint,
        'error': f'remote manifest check returned non-JSON output: {out[-1000:]}',
    }


def _pick_remote_port(ssh_parts, preferred_port, password='', span=100):
    """Pick an available port on the remote host by attempting to bind 127.0.0.1."""
    start = int(preferred_port or 8765)
    count = max(1, min(1000, int(span or 100)))
    cmd = _remote_login_shell_command(f'''
        set -e
        {_remote_python_bin_script()}
        "$PY_BIN" - <<'PY'
import socket, sys
start = {start}
count = {count}
for port in range(start, start + count):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(('127.0.0.1', port))
        print(port)
        sys.exit(0)
    except OSError:
        pass
    finally:
        s.close()
print('')
sys.exit(2)
PY
    ''')
    out = _run(ssh_parts + [cmd], password=password, timeout=30).strip()
    if not out:
        raise RuntimeError(f'远程没有可用端口：{start}-{start + count - 1}')
    return int(out.splitlines()[-1].strip())


def _list_remote_dirs(ssh_parts, path='~', password='', show_hidden=False, limit=500):
    """List child directories on the remote host before the remote Agent is started."""
    q_path = _remote_q(path or '~')
    show_hidden_flag = '1' if show_hidden else '0'
    max_items = max(10, min(2000, int(limit or 500)))
    cmd = _remote_login_shell_command(f'''
        set -e
        {_remote_python_bin_script()}
        "$PY_BIN" - {q_path} {show_hidden_flag} {max_items} <<'PY'
import json, os, sys

raw = sys.argv[1] if len(sys.argv) > 1 else '~'
show_hidden = (sys.argv[2] if len(sys.argv) > 2 else '0') == '1'
limit = int(sys.argv[3] if len(sys.argv) > 3 else '500')

expanded = os.path.expanduser(raw or '~')
real = os.path.realpath(expanded)

def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))

if not os.path.exists(real):
    emit({{'ok': False, 'error': '目录不存在', 'input': raw, 'path': real}})
    sys.exit(0)
if not os.path.isdir(real):
    emit({{'ok': False, 'error': '不是目录', 'input': raw, 'path': real}})
    sys.exit(0)
if not os.access(real, os.R_OK | os.X_OK):
    emit({{'ok': False, 'error': '没有读取或进入该目录的权限', 'input': raw, 'path': real}})
    sys.exit(0)

entries = []
try:
    names = os.listdir(real)
except Exception as e:
    emit({{'ok': False, 'error': str(e), 'input': raw, 'path': real}})
    sys.exit(0)

for name in names:
    if not show_hidden and name.startswith('.'):
        continue
    p = os.path.join(real, name)
    try:
        is_dir = os.path.isdir(p)
    except Exception:
        continue
    if not is_dir:
        continue
    entries.append({{
        'name': name,
        'path': p,
        'readable': os.access(p, os.R_OK),
        'executable': os.access(p, os.X_OK),
    }})
entries.sort(key=lambda x: x['name'].lower())
emit({{'ok': True, 'input': raw, 'path': real, 'parent': os.path.dirname(real) or real, 'entries': entries[:limit], 'truncated': len(entries) > limit}})
PY
    ''')
    out = _run(ssh_parts + [cmd], password=password, timeout=45).strip()
    try:
        data = json.loads(out.splitlines()[-1] if out else '{}')
    except Exception as e:
        raise RuntimeError(f'远程目录列表返回非 JSON：{e}\n{out[-2000:]}')
    return data


class RemoteMixin:
    def handle_remote_list_dirs(self, body):
        ssh_command = (body.get('ssh_command') or '').strip()
        password = body.get('password') or ''
        path = (body.get('path') or '~').strip() or '~'
        show_hidden = bool(body.get('show_hidden'))
        try:
            ssh_parts = _split_cmd(ssh_command)
            data = _list_remote_dirs(ssh_parts, path=path, password=password, show_hidden=show_hidden)
            self.response.json(200, data)
        except Exception as e:
            self.response.json(200, {'ok': False, 'error': str(e), 'path': path})

    def handle_remote_status(self, body):
        has_target = any(body.get(k) for k in (
            'server_url',
            'ssh_command',
            'remote_workspace',
            'local_port',
            'remote_agent_port',
            'connection_id',
        ))
        target = _find_remote_connection(body) if has_target else (_REMOTE_STATE if _REMOTE_STATE.get('server_url') else None)
        if target is None:
            target = _first_connected_remote_state()
        payload = _public_remote_state(target)
        payload['ok'] = True
        payload['connections'] = _remote_connections_public()
        self.response.json(200, payload)

    def handle_remote_disconnect(self, body):
        stop_remote = bool(body.get('stop_remote'))
        password = body.get('password') or ''
        target = _find_remote_connection(body) or (_REMOTE_STATE if _REMOTE_STATE.get('server_url') else None)
        if not target:
            return self.response.json(200, {
                'ok': True,
                'skipped': True,
                'reason': 'remote connection not found',
                'connections': _remote_connections_public(),
            })
        proc = target.get('tunnel_process')
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
        _stop_heartbeat(target)
        if stop_remote and target.get('ssh_command'):
            try:
                parts = _split_cmd(target['ssh_command'])
                remote_port = int(target.get('remote_agent_port') or 0)
                cmd = f'''
                pid_file="$HOME/.snake-agent/run/agent-{remote_port}.pid"
                if [ -f "$pid_file" ]; then
                    kill "$(cat "$pid_file")" 2>/dev/null || true
                    rm -f "$pid_file"
                fi
                if [ {remote_port} -gt 0 ]; then
                    if command -v fuser >/dev/null 2>&1; then
                        fuser -k {remote_port}/tcp >/dev/null 2>&1 || true
                    elif command -v lsof >/dev/null 2>&1; then
                        pids=$(lsof -ti tcp:{remote_port} 2>/dev/null || true)
                        if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi
                    fi
                fi
                '''
                _run(parts + [cmd], password=password, timeout=20)
            except Exception as e:
                target['last_error'] = str(e)
        target.update({
            'connected': False,
            'server_url': '',
            'tunnel_pid': None,
            'tunnel_process': None,
            'reverse_git_proxy_enabled': False,
            'reverse_git_proxy_url': '',
            'reverse_git_proxy_port': 0,
            'local_git_proxy_url': '',
        })
        _release_local_port_reservation(target.get('local_port'))
        with _REMOTE_LOCK:
            key = target.get('connection_id')
            if key and key in _REMOTE_CONNECTIONS:
                _REMOTE_CONNECTIONS.pop(key, None)
            replacement = None
            for state in _REMOTE_CONNECTIONS.values():
                if _refresh_remote_state(state):
                    replacement = state
                    break
            _REMOTE_STATE.clear()
            _REMOTE_STATE.update(replacement or _remote_state_defaults())
        self.response.json(200, {
            'ok': True,
            'message': 'remote tunnel disconnected',
            'connections': _remote_connections_public(),
        })

    def handle_remote_connect(self, body):
        ssh_command = (body.get('ssh_command') or '').strip()
        password = body.get('password') or ''
        remote_workspace = (body.get('remote_workspace') or '~/').strip()
        remote_port = int(body.get('remote_agent_port') or 8765)
        requested_local_port = int(body.get('local_port') or 18765)
        local_port = 0
        heartbeat_timeout = max(120, int(body.get('heartbeat_timeout') or 300))
        install_deps = body.get('install_deps', True) is not False
        reuse_existing = bool(body.get('reuse_existing'))
        fallback_on_reuse_failure = body.get('fallback_on_reuse_failure', True) is not False
        logs = []
        bundle = tmp_dir = ''
        try:
            ssh_parts = _split_cmd(ssh_command)
            scp_base, target = _scp_parts_from_ssh(ssh_parts)
            git_proxy_cfg, git_proxy_error = _normalize_reverse_git_proxy(body.get('git_proxy'))
            if git_proxy_error:
                raise RuntimeError(git_proxy_error)

            existing_state = None
            with _REMOTE_LOCK:
                for state in _REMOTE_CONNECTIONS.values():
                    if (
                        state.get('ssh_command') == ssh_command
                        and state.get('remote_workspace') == remote_workspace
                        and int(state.get('remote_agent_port') or 0) == int(remote_port or 0)
                        and _refresh_remote_state(state)
                    ):
                        existing_state = state
                        break
            if existing_state:
                _remember_remote_connection(existing_state)
                server_url = existing_state.get('server_url') or ''
                try:
                    workspace_info = _read_remote_workspace_info(server_url, timeout=6)
                except Exception as e:
                    workspace_info = {'ok': False, 'error': str(e)}
                logs.append('Reused active local SSH tunnel from connection pool.')
                return self.response.json(200, {
                    'ok': True,
                    'reused_existing': True,
                    'reused_pool': True,
                    'server_url': server_url,
                    'local_port': int(existing_state.get('local_port') or 0),
                    'remote_agent_port': int(existing_state.get('remote_agent_port') or 0),
                    'remote_workspace': existing_state.get('remote_workspace') or remote_workspace,
                    'tunnel_pid': existing_state.get('tunnel_pid'),
                    'heartbeat_timeout': existing_state.get('heartbeat_timeout') or heartbeat_timeout,
                    'reverse_git_proxy_enabled': bool(existing_state.get('reverse_git_proxy_url')),
                    'reverse_git_proxy_url': existing_state.get('reverse_git_proxy_url') or '',
                    'reverse_git_proxy_port': existing_state.get('reverse_git_proxy_port') or 0,
                    'local_git_proxy_url': existing_state.get('local_git_proxy_url') or '',
                    'connection_id': existing_state.get('connection_id') or '',
                    'workspace_info': workspace_info,
                    'connections': _remote_connections_public(),
                    'logs': logs,
                })

            local_port = _pick_local_port(requested_local_port)

            if reuse_existing:
                tunnel = None
                try:
                    logs.append('快速连接：尝试复用远程已运行的 Agent...')
                    reverse_forwards = []
                    reverse_git_proxy_url = ''
                    reverse_git_proxy_port = 0
                    local_git_proxy_url = ''
                    if git_proxy_cfg:
                        local_git_proxy_url = git_proxy_cfg['local_url']
                        reverse_git_proxy_port = _pick_remote_port(
                            ssh_parts,
                            git_proxy_cfg['local_port'],
                            password=password,
                            span=100,
                        )
                        reverse_git_proxy_url = f"{git_proxy_cfg['scheme']}://127.0.0.1:{reverse_git_proxy_port}"
                        reverse_forwards.append({
                            'remote_port': reverse_git_proxy_port,
                            'local_port': git_proxy_cfg['local_port'],
                        })
                        logs.append(
                            f'Git proxy reverse tunnel: remote {reverse_git_proxy_url} -> local {local_git_proxy_url}'
                        )

                    tunnel = _start_tunnel(
                        ssh_parts,
                        local_port,
                        remote_port,
                        password=password,
                        reverse_forwards=reverse_forwards,
                    )
                    server_url = f'http://127.0.0.1:{local_port}'
                    _wait_for_remote_agent(server_url, timeout=8)
                    workspace_info = _read_remote_workspace_info(server_url, timeout=6)
                    state = _remote_state_defaults()
                    state.update({
                        'connected': True,
                        'ssh_command': ssh_command,
                        'remote_workspace': remote_workspace,
                        'remote_agent_port': remote_port,
                        'local_port': local_port,
                        'server_url': server_url,
                        'heartbeat_timeout': heartbeat_timeout,
                        'tunnel_pid': tunnel.pid,
                        'tunnel_process': tunnel,
                        'reverse_git_proxy_enabled': bool(reverse_git_proxy_url),
                        'reverse_git_proxy_url': reverse_git_proxy_url,
                        'reverse_git_proxy_port': reverse_git_proxy_port,
                        'local_git_proxy_url': local_git_proxy_url,
                        'started_at': _now_stamp(),
                        'last_error': '',
                    })
                    _start_heartbeat(server_url, interval=max(5, min(20, heartbeat_timeout // 4 or 15)), state=state)
                    _remember_remote_connection(state)
                    logs.append('快速连接成功：已复用远程 Agent。')
                    return self.response.json(200, {
                        'ok': True,
                        'reused_existing': True,
                        'server_url': server_url,
                        'local_port': local_port,
                        'remote_agent_port': remote_port,
                        'remote_workspace': remote_workspace,
                        'tunnel_pid': tunnel.pid,
                        'heartbeat_timeout': heartbeat_timeout,
                        'reverse_git_proxy_enabled': bool(reverse_git_proxy_url),
                        'reverse_git_proxy_url': reverse_git_proxy_url,
                        'reverse_git_proxy_port': reverse_git_proxy_port,
                        'local_git_proxy_url': local_git_proxy_url,
                        'connection_id': state.get('connection_id'),
                        'workspace_info': workspace_info,
                        'connections': _remote_connections_public(),
                        'logs': logs,
                    })
                except Exception as e:
                    if tunnel:
                        try:
                            tunnel.terminate()
                        except Exception:
                            pass
                    logs.append(f'快速连接失败，{"降级完整启动流程" if fallback_on_reuse_failure else "不再重试"}：{e}')
                    if not fallback_on_reuse_failure:
                        _release_local_port_reservation(local_port)
                        return self.response.json(200, {'ok': False, 'error': str(e), 'reused_existing': False, 'logs': logs})

            deployment_manifest = _deployment_manifest()

            logs.append('检查远程工作区目录...')
            try:
                logs.append('远程工作区检查：' + _diagnose_remote_workspace(ssh_parts, remote_workspace, password=password))
                print(f"✅ [remote] workspace check ok: {remote_workspace}", flush=True)
            except Exception as e:
                raise RuntimeError(f'远程工作区不可用：{remote_workspace}\n{e}')

            original_remote_port = remote_port
            remote_port = _pick_remote_port(ssh_parts, remote_port, password=password, span=100)
            if remote_port != original_remote_port:
                logs.append(f'远程端口 {original_remote_port} 被占用或不可用，自动改用 {remote_port}')
                print(f'⚠️ [remote] remote port {original_remote_port} unavailable, use {remote_port}', flush=True)

            logs.append('2/5 创建远程目录...')
            _run(ssh_parts + ['mkdir -p ~/.snake-agent/current ~/.snake-agent/logs ~/.snake-agent/run'], password=password, timeout=60)

            logs.append('3/5 检查远程部署缓存...')
            remote_deploy = _remote_deployment_matches(
                ssh_parts,
                deployment_manifest.get('fingerprint') or '',
                password=password,
            )
            deployment_cache_hit = bool(remote_deploy.get('ok'))
            if deployment_cache_hit:
                logs.append(
                    '远程部署缓存命中：'
                    f"{str(remote_deploy.get('fingerprint') or '')[:12]}，跳过打包上传。"
                )
            else:
                logs.append(
                    '远程部署缓存未命中，开始打包上传。'
                    f" remote={str(remote_deploy.get('fingerprint') or '')[:12]}"
                    f" expected={str(deployment_manifest.get('fingerprint') or '')[:12]}"
                    f" error={remote_deploy.get('error') or ''}"
                )
                bundle, tmp_dir = _make_bundle(deployment_manifest)
                _run(scp_base + [bundle, f'{target}:~/.snake-agent/agent_bundle.tar.gz'], password=password, timeout=180)

            logs.append('4/5 启动远程 Agent...')
            install_cmd = '"$PY_BIN" -m pip install --user -r ~/.snake-agent/current/requirements.txt >/tmp/snake-agent-pip.log 2>&1 || true' if install_deps else 'true'
            deploy_cmd = 'true'
            if not deployment_cache_hit:
                deploy_cmd = f'''
                tar -xzf ~/.snake-agent/agent_bundle.tar.gz -C ~/.snake-agent/current
                {install_cmd}
                '''
            start_cmd = _remote_login_shell_command(f'''
                set -e
                {_remote_python_bin_script()}
                echo "login_shell=${{SNAKE_AGENT_LOGIN_SHELL:-${{SHELL:-unknown}}}}"
                echo "python=$PY_BIN"
                {deploy_cmd}
                # 先停掉旧 Agent。只 kill pidfile 可能不够：pidfile 可能丢失/过期，或旧进程不是当前 pid。
                pid_file="$HOME/.snake-agent/run/agent-{remote_port}.pid"
                if [ -f "$pid_file" ]; then
                    oldpid=$(cat "$pid_file" 2>/dev/null || true)
                    if [ -n "$oldpid" ]; then
                        kill "$oldpid" 2>/dev/null || true
                    fi
                    rm -f "$pid_file"
                fi

                # 再清理占用目标端口的进程，避免新 Agent 启动后报 Address already in use。
                # 远程 Agent 只监听 127.0.0.1:{remote_port}，这里等价于释放本次连接使用的 Agent 端口。
                if command -v fuser >/dev/null 2>&1; then
                    fuser -k {remote_port}/tcp >/dev/null 2>&1 || true
                elif command -v lsof >/dev/null 2>&1; then
                    pids=$(lsof -ti tcp:{remote_port} 2>/dev/null || true)
                    if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi
                fi
                sleep 0.8

                if command -v fuser >/dev/null 2>&1; then
                    if fuser {remote_port}/tcp >/dev/null 2>&1; then
                        fuser -k -9 {remote_port}/tcp >/dev/null 2>&1 || true
                        sleep 0.3
                    fi
                fi
                cd ~/.snake-agent/current
                SNAKE_AGENT_LOGIN_SHELL="${{SNAKE_AGENT_LOGIN_SHELL:-${{SHELL:-/bin/sh}}}}" nohup "$PY_BIN" local_terminal_server.py --workspace {_remote_q(remote_workspace)} --host 127.0.0.1 --port {remote_port} --remote-heartbeat-timeout {heartbeat_timeout} > ~/.snake-agent/logs/remote-agent.log 2>&1 &
                newpid=$!
                echo $newpid > "$pid_file"
                sleep 1.5
                if ! kill -0 "$newpid" 2>/dev/null; then
                    echo "远程 Agent 启动后立即退出，日志如下：" >&2
                    tail -n 120 ~/.snake-agent/logs/remote-agent.log >&2 || true
                    exit 1
                fi
                echo "$newpid"
            ''')
            remote_out = _run(ssh_parts + [start_cmd], password=password, timeout=180)
            logs.append(remote_out.strip()[-1000:])

            reverse_forwards = []
            reverse_git_proxy_url = ''
            reverse_git_proxy_port = 0
            local_git_proxy_url = ''
            if git_proxy_cfg:
                local_git_proxy_url = git_proxy_cfg['local_url']
                reverse_git_proxy_port = _pick_remote_port(
                    ssh_parts,
                    git_proxy_cfg['local_port'],
                    password=password,
                    span=100,
                )
                reverse_git_proxy_url = f"{git_proxy_cfg['scheme']}://127.0.0.1:{reverse_git_proxy_port}"
                reverse_forwards.append({
                    'remote_port': reverse_git_proxy_port,
                    'local_port': git_proxy_cfg['local_port'],
                })
                logs.append(
                    f'Git proxy reverse tunnel: remote {reverse_git_proxy_url} -> local {local_git_proxy_url}'
                )

            logs.append('5/5 建立本地 SSH 隧道...')
            tunnel = _start_tunnel(
                ssh_parts,
                local_port,
                remote_port,
                password=password,
                reverse_forwards=reverse_forwards,
            )
            server_url = f'http://127.0.0.1:{local_port}'
            try:
                _wait_for_remote_agent(server_url, timeout=30)
                logs.append('远程 Agent 已响应心跳。')
            except Exception:
                try:
                    tunnel.terminate()
                except Exception:
                    pass
                raise

            try:
                workspace_info = _read_remote_workspace_info(server_url, timeout=10)
                logs.append(f"远程工作区：{workspace_info.get('workspace') or workspace_info.get('cwd') or remote_workspace}")
                print(f"✅ [remote] /workspace: {workspace_info}", flush=True)
            except Exception as e:
                diag = ''
                try:
                    diag = _diagnose_remote_workspace(ssh_parts, remote_workspace, password=password)
                except Exception as de:
                    diag = f'远程工作区复查失败：{de}'
                log_tail = _tail_remote_agent_log(ssh_parts, password=password, lines=160)
                detail = f'{e}\n远程工作区诊断：{diag}\n远程日志尾部：\n{log_tail}'
                workspace_info = {'ok': False, 'error': detail}
                logs.append('读取远程工作区失败：' + detail[-3000:])
                print(f"❌ [remote] workspace detail: {detail[-4000:]}", flush=True)
            state = _remote_state_defaults()
            state.update({
                'connected': True,
                'ssh_command': ssh_command,
                'remote_workspace': remote_workspace,
                'remote_agent_port': remote_port,
                'local_port': local_port,
                'server_url': server_url,
                'heartbeat_timeout': heartbeat_timeout,
                'tunnel_pid': tunnel.pid,
                'tunnel_process': tunnel,
                'reverse_git_proxy_enabled': bool(reverse_git_proxy_url),
                'reverse_git_proxy_url': reverse_git_proxy_url,
                'reverse_git_proxy_port': reverse_git_proxy_port,
                'local_git_proxy_url': local_git_proxy_url,
                'started_at': _now_stamp(),
                'last_error': '',
            })
            _start_heartbeat(server_url, interval=max(5, min(20, heartbeat_timeout // 4 or 15)), state=state)
            _remember_remote_connection(state)
            self.response.json(200, {
                'ok': True,
                'server_url': server_url,
                'local_port': local_port,
                'remote_agent_port': remote_port,
                'remote_workspace': remote_workspace,
                'tunnel_pid': tunnel.pid,
                'heartbeat_timeout': heartbeat_timeout,
                'reverse_git_proxy_enabled': bool(reverse_git_proxy_url),
                'reverse_git_proxy_url': reverse_git_proxy_url,
                'reverse_git_proxy_port': reverse_git_proxy_port,
                'local_git_proxy_url': local_git_proxy_url,
                'connection_id': state.get('connection_id'),
                'workspace_info': workspace_info,
                'deployment_cache_hit': deployment_cache_hit,
                'connections': _remote_connections_public(),
                'logs': logs,
            })
        except Exception as e:
            _release_local_port_reservation(local_port)
            _REMOTE_STATE['last_error'] = str(e)
            self.response.json(200, {'ok': False, 'error': str(e), 'logs': logs})
        finally:
            if tmp_dir:
                shutil.rmtree(tmp_dir, ignore_errors=True)
