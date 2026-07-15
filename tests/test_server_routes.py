import base64
import json
import shutil
import subprocess
import sys
import tarfile
import time
import unittest
from pathlib import Path
from unittest import mock

from server.command_tasks import COMMAND_TASKS, coerce_command_task_runtime
from server.exec import (
    ExecMixin,
    _apply_git_proxy_env,
    _command_invokes_git,
    _coerce_execute_timeout,
    _coerce_execute_timeout_max,
    _coerce_task_wait,
    _coerce_task_wait_max,
    _git_proxy_bat_lines,
    _normalize_local_git_proxy_url,
    _remote_terminal_ssh_args,
    _windows_remote_terminal_commands,
)
from server.handler import Handler
from server.remote import (
    _deployment_manifest,
    _make_bundle,
    _remote_deployment_matches,
    _remote_login_shell_command,
    _remote_python_bin_script,
)
from server.routes import (
    ACTION_ROUTE_BY_NAME,
    ACTION_ROUTES,
    GET_EXACT_ROUTES,
    GET_PREFIX_ROUTES,
    POST_PREFIX_ROUTES,
)
from server.web import WebMixin


ROOT = Path(__file__).resolve().parents[1]


class ServerRouteTests(unittest.TestCase):
    def test_all_route_handlers_exist(self):
        routes = (
            list(GET_EXACT_ROUTES)
            + list(GET_PREFIX_ROUTES)
            + list(POST_PREFIX_ROUTES)
            + list(ACTION_ROUTES)
        )
        missing = [route.handler for route in routes if not hasattr(Handler, route.handler)]
        self.assertEqual([], missing)

    def test_action_names_are_unique(self):
        actions = [route.action for route in ACTION_ROUTES]
        duplicates = sorted({action for action in actions if actions.count(action) > 1})
        self.assertEqual([], duplicates)

    def test_action_index_matches_declared_routes(self):
        indexed_actions = set(ACTION_ROUTE_BY_NAME)
        declared_actions = {route.action for route in ACTION_ROUTES}
        self.assertEqual(declared_actions, indexed_actions)

    def test_command_task_routes_are_registered(self):
        self.assertEqual('handle_command_task_output', ACTION_ROUTE_BY_NAME['command_task_output'].handler)
        self.assertEqual('handle_command_task_list', ACTION_ROUTE_BY_NAME['command_task_list'].handler)
        self.assertEqual('handle_command_task_cancel', ACTION_ROUTE_BY_NAME['command_task_cancel'].handler)


class CommandTaskTests(unittest.TestCase):
    def test_runtime_is_clamped(self):
        self.assertEqual(3600, coerce_command_task_runtime(None))
        self.assertEqual(1, coerce_command_task_runtime(-1))
        self.assertEqual(24 * 60 * 60, coerce_command_task_runtime(999999))

    def test_background_task_captures_output(self):
        command = subprocess.list2cmdline([sys.executable, '-c', 'print("task-ok")'])
        started = COMMAND_TASKS.start(command=command, cwd=str(ROOT), max_runtime=10)

        self.assertTrue(started['task_id'].startswith('cmd_'))
        deadline = time.time() + 5
        finished = COMMAND_TASKS.get(started['task_id'], wait=1)
        while finished and finished['status'] == 'running' and time.time() < deadline:
            finished = COMMAND_TASKS.get(started['task_id'], wait=0.2)

        self.assertEqual('completed', finished['status'])
        self.assertEqual(0, finished['returncode'])
        self.assertIn(b'task-ok', finished['stdout_raw'])

    def test_foreground_timeout_returns_running_task(self):
        command = subprocess.list2cmdline([
            sys.executable,
            '-c',
            'import time; print("started", flush=True); time.sleep(2); print("done")',
        ])
        mixin = ExecMixin()
        result = mixin._run_command_until_foreground_timeout(
            command,
            str(ROOT),
            timeout=0.2,
            body={'max_runtime': 10},
        )
        try:
            self.assertTrue(result['ok'])
            self.assertTrue(result['background_task'])
            self.assertTrue(result['running'])
            self.assertTrue(result['task_id'].startswith('cmd_'))
            self.assertIsNone(result['returncode'])
        finally:
            COMMAND_TASKS.cancel(result.get('task_id'))

    def test_short_foreground_task_is_discarded_after_response(self):
        command = subprocess.list2cmdline([
            sys.executable,
            '-c',
            'print("short-task-reclaimed")',
        ])
        mixin = ExecMixin()

        result = mixin._run_command_until_foreground_timeout(
            command,
            str(ROOT),
            timeout=5,
            body={'max_runtime': 10},
        )

        self.assertTrue(result['ok'])
        self.assertNotIn('task_id', result)
        self.assertFalse(any(
            task['command'] == command
            for task in COMMAND_TASKS.list(visible_only=False)
        ))

    def test_background_tasks_are_filtered_by_owner_session(self):
        command = subprocess.list2cmdline([sys.executable, '-c', 'print("owned-task")'])
        started = COMMAND_TASKS.start(
            command=command,
            cwd=str(ROOT),
            max_runtime=10,
            owner_session_id='session-a',
        )
        task_id = started['task_id']

        self.assertIsNotNone(COMMAND_TASKS.get(task_id, owner_session_id='session-a'))
        self.assertIsNone(COMMAND_TASKS.get(task_id, owner_session_id='session-b'))
        self.assertFalse(any(task['task_id'] == task_id for task in COMMAND_TASKS.list(owner_session_id='session-a')))

        COMMAND_TASKS.mark_visible(task_id, owner_session_id='session-a')

        self.assertTrue(any(task['task_id'] == task_id for task in COMMAND_TASKS.list(owner_session_id='session-a')))
        self.assertFalse(any(task['task_id'] == task_id for task in COMMAND_TASKS.list(owner_session_id='session-b')))


class WebProxyTests(unittest.TestCase):
    def setUp(self):
        self.web = WebMixin()

    def test_local_proxy_urls_are_normalized_like_git_proxy(self):
        cases = {
            'http://localhost:7890': 'http://127.0.0.1:7890',
            'https://127.0.0.1:7890': 'http://127.0.0.1:7890',
            'socks5://localhost:7890': 'socks5h://127.0.0.1:7890',
            'socks5h://127.0.0.1:7890': 'socks5h://127.0.0.1:7890',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                normalized, error = self.web._normalize_local_web_proxy_url(raw)
                self.assertIsNone(error)
                self.assertEqual(expected, normalized)

    def test_non_local_proxy_urls_are_rejected(self):
        normalized, error = self.web._normalize_local_web_proxy_url('http://proxy.example.com:7890')

        self.assertEqual('', normalized)
        self.assertIn('local proxy', error)

    def test_proxy_flag_honors_explicit_false(self):
        proxies, proxy_url, error = self.web._web_proxy_config({
            'proxy_enabled': False,
            'use_proxy': True,
            'proxy_url': 'http://127.0.0.1:7890',
        })

        self.assertIsNone(error)
        self.assertIsNone(proxies)
        self.assertEqual('', proxy_url)

    def test_request_error_mentions_proxy_diagnostics(self):
        message = self.web._format_web_request_error(
            'google',
            ConnectionError('Connection refused'),
            'http://127.0.0.1:7890',
        )

        self.assertIn('google: ConnectionError', message)
        self.assertIn('proxy=http://127.0.0.1:7890', message)
        self.assertIn('local proxy is running', message)


class ExecGitProxyTests(unittest.TestCase):
    def test_local_git_proxy_urls_are_normalized(self):
        cases = {
            'http://localhost:7890': 'http://127.0.0.1:7890',
            'https://127.0.0.1:7890': 'http://127.0.0.1:7890',
            'socks5://localhost:7890': 'socks5h://127.0.0.1:7890',
            'socks5h://127.0.0.1:7890': 'socks5h://127.0.0.1:7890',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(expected, _normalize_local_git_proxy_url(raw))

    def test_non_local_git_proxy_urls_are_not_exported(self):
        self.assertEqual('', _normalize_local_git_proxy_url('http://proxy.example.com:7890'))
        self.assertEqual('', _normalize_local_git_proxy_url('http://127.0.0.1:70000'))

    def test_execute_proxy_env_only_targets_git_commands(self):
        self.assertTrue(_command_invokes_git('git fetch origin'))
        self.assertTrue(_command_invokes_git('npm test && git pull'))
        self.assertTrue(_command_invokes_git('cmd /c git fetch'))
        self.assertTrue(_command_invokes_git('powershell -Command "git fetch"'))
        self.assertFalse(_command_invokes_git('echo git'))
        self.assertFalse(_command_invokes_git('python script.py'))

        env = _apply_git_proxy_env({}, 'http://127.0.0.1:7890')
        for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
            self.assertEqual('http://127.0.0.1:7890', env[key])

    def test_new_window_bat_exports_git_proxy(self):
        lines = _git_proxy_bat_lines('socks5h://127.0.0.1:7890')

        self.assertIn('set "HTTP_PROXY=socks5h://127.0.0.1:7890"', lines)
        self.assertIn('set "all_proxy=socks5h://127.0.0.1:7890"', lines)

    def test_execute_reads_git_proxy_from_config(self):
        mixin = ExecMixin()
        completed = mock.Mock(returncode=0, stdout=b'socks5://localhost:7890\n')

        with mock.patch('server.exec.subprocess.run', return_value=completed) as run:
            proxy_url, proxy_error = mixin._git_proxy_url_for_execute('git fetch origin', str(ROOT))

        self.assertEqual('socks5h://127.0.0.1:7890', proxy_url)
        self.assertEqual('', proxy_error)
        run.assert_called_once()

    def test_execute_does_not_read_git_config_for_non_git_command(self):
        mixin = ExecMixin()

        with mock.patch('server.exec.subprocess.run') as run:
            proxy_url, proxy_error = mixin._git_proxy_url_for_execute('python script.py', str(ROOT))

        self.assertEqual('', proxy_url)
        self.assertEqual('', proxy_error)
        run.assert_not_called()

    def test_execute_timeout_is_clamped(self):
        self.assertEqual(60, _coerce_execute_timeout(None, default=60))
        self.assertEqual(1, _coerce_execute_timeout(-5, default=60))
        self.assertEqual(300, _coerce_execute_timeout(999, default=60))
        self.assertEqual(120, _coerce_execute_timeout('120', default=60))
        self.assertEqual(60, _coerce_execute_timeout('bad', default=60))

    def test_execute_timeout_max_is_configurable(self):
        self.assertEqual(300, _coerce_execute_timeout_max(None))
        self.assertEqual(1, _coerce_execute_timeout_max(-5))
        self.assertEqual(1200, _coerce_execute_timeout_max('1200'))
        self.assertEqual(86400, _coerce_execute_timeout_max(999999))
        self.assertEqual(1200, _coerce_execute_timeout(9999, default=60, maximum=_coerce_execute_timeout_max(1200)))

    def test_command_task_wait_max_is_configurable(self):
        self.assertEqual(300, _coerce_task_wait_max(None))
        self.assertEqual(0, _coerce_task_wait_max(-5))
        self.assertEqual(900, _coerce_task_wait_max('900'))
        self.assertEqual(3600, _coerce_task_wait_max(999999))
        self.assertEqual(900, _coerce_task_wait(9999, maximum=_coerce_task_wait_max(900)))

    def test_remote_login_shell_wrapper_uses_passwd_shell(self):
        command = _remote_login_shell_command('echo ok')

        self.assertIn('getent passwd "$snake_user"', command)
        self.assertIn('SNAKE_AGENT_LOGIN_SHELL="$snake_shell" exec "$snake_shell" -lc', command)
        self.assertIn("'echo ok'", command)

    def test_remote_python_probe_accepts_python_or_python3(self):
        script = _remote_python_bin_script()

        self.assertIn('command -v python3', script)
        self.assertIn('command -v python', script)
        self.assertIn('python3/python not found', script)

    def test_remote_bundle_contains_deployment_manifest(self):
        manifest = _deployment_manifest()
        bundle, tmp_dir = _make_bundle(manifest)
        try:
            with tarfile.open(bundle, 'r:gz') as tar:
                names = set(tar.getnames())
                self.assertIn('local_terminal_server.py', names)
                self.assertIn('requirements.txt', names)
                self.assertIn('server/remote.py', names)
                self.assertIn('.snake-agent-deploy-manifest.json', names)
                member = tar.extractfile('.snake-agent-deploy-manifest.json')
                packed_manifest = json.loads(member.read().decode('utf-8'))

            self.assertEqual(manifest['fingerprint'], packed_manifest['fingerprint'])
            self.assertTrue(manifest['fingerprint'])
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def test_remote_deployment_match_parses_last_json_line(self):
        with mock.patch('server.remote._run', return_value='login banner\n{"ok": true, "fingerprint": "abc"}\n'):
            result = _remote_deployment_matches(['ssh', 'host'], 'abc')

        self.assertTrue(result['ok'])
        self.assertEqual('abc', result['fingerprint'])

    def test_remote_terminal_builds_ssh_cd_command(self):
        args = _remote_terminal_ssh_args('ssh -p 2222 user@example.com', '~/project dir')

        self.assertEqual(['ssh', '-p', '2222', '-t', 'user@example.com'], args[:5])
        self.assertIn('cd "$HOME"/', args[-1])
        self.assertIn('project dir', args[-1])
        self.assertIn('getent passwd "$snake_user"', args[-1])
        self.assertIn('exec "$snake_shell" -l', args[-1])

    def test_remote_terminal_exports_git_proxy(self):
        args = _remote_terminal_ssh_args(
            'ssh user@example.com',
            '~/project',
            proxy_url='http://127.0.0.1:7890',
        )

        self.assertIn('export HTTP_PROXY=http://127.0.0.1:7890', args[-1])
        self.assertIn('https_proxy=http://127.0.0.1:7890', args[-1])
        self.assertIn('exec "$snake_shell" -l', args[-1])

    def test_windows_remote_terminal_wraps_ssh_in_encoded_powershell(self):
        ssh_args = _remote_terminal_ssh_args('ssh -p 2222 user@example.com', '~/project dir')
        commands = _windows_remote_terminal_commands('AI Remote Terminal', ssh_args)

        self.assertEqual(['wt.exe', 'new-tab', '--title', 'AI Remote Terminal', '--'], commands[0][:5])
        self.assertEqual(['wt.exe', '--'], commands[1][:2])
        self.assertEqual('powershell.exe', commands[0][5])
        self.assertEqual('powershell.exe', commands[1][2])
        self.assertEqual('powershell.exe', commands[2][0])
        self.assertNotIn('exec "$snake_shell" -l', commands[0])

        encoded = commands[0][-1]
        script = base64.b64decode(encoded).decode('utf-16le')
        self.assertIn("$psi.FileName = 'ssh'", script)
        self.assertIn("$psi.Arguments = '-p 2222 -t user@example.com", script)
        self.assertIn('exec \\"$snake_shell\\" -l', script)


if __name__ == '__main__':
    unittest.main()
