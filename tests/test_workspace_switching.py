import os
import tempfile
import unittest
from unittest import mock

from server import config


class WorkspaceSwitchingTests(unittest.TestCase):
    def test_session_workspace_relative_path_uses_request_cwd_not_process_cwd(self):
        previous_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as process_cwd, tempfile.TemporaryDirectory() as request_base, mock.patch.multiple(
            config,
            WORKSPACE_ROOT=os.path.realpath(process_cwd),
            current_cwd=os.path.realpath(process_cwd),
        ):
            os.makedirs(os.path.join(request_base, 'new-project'))
            os.chdir(process_cwd)
            workspace_token = config.bind_request_workspace(process_cwd)
            cwd_token = config.bind_request_cwd(request_base)
            try:
                resolved = config.set_session_workspace('chat-workspace', 'new-project')
            finally:
                config.reset_request_cwd(cwd_token)
                config.reset_request_workspace(workspace_token)
                config.SESSION_WORKSPACES.clear()
                config.SESSION_CWDS.clear()
                os.chdir(previous_cwd)

        self.assertEqual(
            os.path.realpath(os.path.join(request_base, 'new-project')),
            resolved
        )

    def test_session_workspace_relative_path_can_use_explicit_base(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as explicit_base, mock.patch.multiple(
            config,
            WORKSPACE_ROOT=os.path.realpath(root),
            current_cwd=os.path.realpath(root),
        ):
            os.makedirs(os.path.join(explicit_base, 'target'))
            try:
                resolved = config.set_session_workspace(
                    'chat-explicit-base',
                    'target',
                    base_dir=explicit_base
                )
            finally:
                config.SESSION_WORKSPACES.clear()
                config.SESSION_CWDS.clear()

        self.assertEqual(os.path.realpath(os.path.join(explicit_base, 'target')), resolved)


if __name__ == '__main__':
    unittest.main()
