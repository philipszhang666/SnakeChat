import os
import subprocess
import threading
import time
import uuid


DEFAULT_MAX_RUNTIME = 60 * 60
MAX_RUNTIME_LIMIT = 24 * 60 * 60
DEFAULT_OUTPUT_LIMIT = 512 * 1024
COMPLETED_TTL = 60 * 60


def coerce_command_task_runtime(value, default=DEFAULT_MAX_RUNTIME):
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        seconds = default
    return max(1, min(seconds, MAX_RUNTIME_LIMIT))


def _windows_creationflags():
    if os.name != 'nt':
        return 0
    return getattr(subprocess, 'CREATE_NO_WINDOW', 0)


class CommandTask:
    def __init__(
        self,
        *,
        command,
        cwd,
        env=None,
        shell=True,
        shell_kwargs=None,
        max_runtime=DEFAULT_MAX_RUNTIME,
        output_limit=DEFAULT_OUTPUT_LIMIT,
        workspace='',
        kind='execute',
        owner_session_id='',
        visible_to_ai=False,
    ):
        self.id = 'cmd_' + uuid.uuid4().hex[:12]
        self.command = command
        self.cwd = cwd
        self.workspace = workspace
        self.kind = kind
        self.owner_session_id = str(owner_session_id or '')
        self.visible_to_ai = bool(visible_to_ai)
        self.max_runtime = coerce_command_task_runtime(max_runtime)
        self.output_limit = max(4096, int(output_limit or DEFAULT_OUTPUT_LIMIT))
        self.started_at = time.time()
        self.ended_at = None
        self.last_access = self.started_at
        self.returncode = None
        self.status = 'running'
        self.error = ''
        self.stdout = bytearray()
        self.stderr = bytearray()
        self.stdout_total = 0
        self.stderr_total = 0
        self.stdout_truncated = False
        self.stderr_truncated = False
        self._lock = threading.RLock()
        self._changed = threading.Condition(self._lock)
        self._proc = subprocess.Popen(
            command,
            shell=shell,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=_windows_creationflags(),
            **(shell_kwargs or {}),
        )
        self.pid = self._proc.pid
        self._start_threads()

    def _start_threads(self):
        self._reader_threads = [
            threading.Thread(
                target=self._read_pipe,
                args=(self._proc.stdout, 'stdout'),
                name=f'command-task-stdout-{self.id}',
                daemon=True,
            ),
            threading.Thread(
                target=self._read_pipe,
                args=(self._proc.stderr, 'stderr'),
                name=f'command-task-stderr-{self.id}',
                daemon=True,
            ),
        ]
        for thread in self._reader_threads:
            thread.start()
        threading.Thread(
            target=self._watch,
            name=f'command-task-watch-{self.id}',
            daemon=True,
        ).start()

    def _append_output(self, stream_name, chunk):
        if not chunk:
            return
        with self._changed:
            buf = self.stdout if stream_name == 'stdout' else self.stderr
            if stream_name == 'stdout':
                self.stdout_total += len(chunk)
            else:
                self.stderr_total += len(chunk)
            buf.extend(chunk)
            if len(buf) > self.output_limit:
                del buf[:len(buf) - self.output_limit]
                if stream_name == 'stdout':
                    self.stdout_truncated = True
                else:
                    self.stderr_truncated = True
            self._changed.notify_all()

    def _read_pipe(self, pipe, stream_name):
        try:
            while True:
                chunk = pipe.read(4096)
                if not chunk:
                    break
                self._append_output(stream_name, chunk)
        except Exception as exc:
            self._mark_error(f'{stream_name} read failed: {exc}')
        finally:
            try:
                pipe.close()
            except Exception:
                pass

    def _watch(self):
        timed_out = False
        while True:
            rc = self._proc.poll()
            if rc is not None:
                break
            if time.time() - self.started_at > self.max_runtime:
                timed_out = True
                self._terminate_process()
                try:
                    rc = self._proc.wait(timeout=5)
                except Exception:
                    rc = self._proc.poll()
                break
            time.sleep(0.2)

        if rc is None:
            try:
                rc = self._proc.wait(timeout=1)
            except Exception:
                rc = self._proc.poll()

        for thread in getattr(self, '_reader_threads', []):
            try:
                thread.join(timeout=1)
            except Exception:
                pass

        with self._changed:
            self.returncode = rc
            self.ended_at = time.time()
            if self.status == 'cancelled':
                pass
            elif timed_out:
                self.status = 'timed_out'
                self.error = f'Command exceeded max_runtime ({self.max_runtime}s)'
            else:
                self.status = 'completed'
            self._changed.notify_all()

    def _mark_error(self, message):
        with self._changed:
            if not self.error:
                self.error = message
            self._changed.notify_all()

    def _terminate_process(self):
        try:
            self._proc.terminate()
        except Exception:
            return
        try:
            self._proc.wait(timeout=3)
        except Exception:
            try:
                self._proc.kill()
            except Exception:
                pass

    def cancel(self):
        with self._changed:
            if self.status != 'running':
                return False
            self.status = 'cancelled'
            self.error = 'Command task cancelled'
            self._changed.notify_all()
        self._terminate_process()
        return True

    def snapshot(self, wait=0, wait_for_completion=False):
        wait = max(0.0, min(float(wait or 0), float(MAX_RUNTIME_LIMIT)))
        with self._changed:
            self.last_access = time.time()
            if wait and self.status == 'running':
                if wait_for_completion:
                    deadline = time.time() + wait
                    while self.status == 'running':
                        remaining = deadline - time.time()
                        if remaining <= 0:
                            break
                        self._changed.wait(timeout=remaining)
                else:
                    self._changed.wait(timeout=wait)
            return {
                'task_id': self.id,
                'kind': self.kind,
                'command': self.command,
                'cwd': self.cwd,
                'workspace': self.workspace,
                'pid': self.pid,
                'owner_session_id': self.owner_session_id,
                'visible_to_ai': self.visible_to_ai,
                'status': self.status,
                'running': self.status == 'running',
                'returncode': self.returncode,
                'error': self.error,
                'started_at': self.started_at,
                'ended_at': self.ended_at,
                'max_runtime': self.max_runtime,
                'stdout_raw': bytes(self.stdout),
                'stderr_raw': bytes(self.stderr),
                'stdout_size': self.stdout_total,
                'stderr_size': self.stderr_total,
                'stdout_truncated': self.stdout_truncated,
                'stderr_truncated': self.stderr_truncated,
            }


class CommandTaskRegistry:
    def __init__(self):
        self._lock = threading.RLock()
        self._tasks = {}

    def start(self, **kwargs):
        self.cleanup()
        task = CommandTask(**kwargs)
        with self._lock:
            self._tasks[task.id] = task
        return task.snapshot(wait=0)

    def _session_can_access(self, task, owner_session_id):
        owner = str(owner_session_id or '')
        if not owner:
            return True
        task_owner = str(getattr(task, 'owner_session_id', '') or '')
        return not task_owner or task_owner == owner

    def get(self, task_id, wait=0, wait_for_completion=False, owner_session_id=''):
        self.cleanup()
        with self._lock:
            task = self._tasks.get(str(task_id or ''))
        if not task or not self._session_can_access(task, owner_session_id):
            return None
        return task.snapshot(wait=wait, wait_for_completion=wait_for_completion)

    def cancel(self, task_id, owner_session_id=''):
        with self._lock:
            task = self._tasks.get(str(task_id or ''))
        if not task or not self._session_can_access(task, owner_session_id):
            return None
        task.cancel()
        return task.snapshot(wait=0)

    def mark_visible(self, task_id, owner_session_id=''):
        with self._lock:
            task = self._tasks.get(str(task_id or ''))
        if not task or not self._session_can_access(task, owner_session_id):
            return None
        with task._changed:
            task.visible_to_ai = True
            task.last_access = time.time()
            task._changed.notify_all()
        return task.snapshot(wait=0)

    def discard_unexposed_if_finished(self, task_id, owner_session_id=''):
        task_id = str(task_id or '')
        with self._lock:
            task = self._tasks.get(task_id)
            if not task or not self._session_can_access(task, owner_session_id):
                return False
            with task._changed:
                if task.status == 'running' or task.visible_to_ai:
                    return False
                self._tasks.pop(task_id, None)
                return True

    def list(self, owner_session_id='', include_finished=True, limit=50, visible_only=True):
        self.cleanup()
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = 50
        limit = max(1, min(limit, 200))
        with self._lock:
            tasks = [
                task for task in self._tasks.values()
                if self._session_can_access(task, owner_session_id)
                and (not visible_only or getattr(task, 'visible_to_ai', False))
                and (include_finished or task.status == 'running')
            ]
        tasks.sort(key=lambda task: task.started_at, reverse=True)
        return [task.snapshot(wait=0) for task in tasks[:limit]]

    def cleanup(self):
        now = time.time()
        with self._lock:
            stale = [
                task_id for task_id, task in self._tasks.items()
                if task.status != 'running' and now - task.last_access > COMPLETED_TTL
            ]
            for task_id in stale:
                self._tasks.pop(task_id, None)


COMMAND_TASKS = CommandTaskRegistry()
