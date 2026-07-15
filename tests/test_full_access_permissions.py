import os
import tempfile
import unittest
from unittest import mock

from server import config
from server.sandbox import check_path_or_error, command_workspace_violation, is_inside_workspace


class FullAccessPermissionTests(unittest.TestCase):
    def _with_workspace(self, root):
        return mock.patch.multiple(
            config,
            WORKSPACE_ROOT=os.path.realpath(root),
            current_cwd=os.path.realpath(root),
        )

    def test_sandbox_blocks_outside_path_without_full_access(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside, self._with_workspace(root):
            outside_file = os.path.join(outside, 'note.txt')

            self.assertFalse(is_inside_workspace(outside_file))
            _, err = check_path_or_error(outside_file)

            self.assertIsNotNone(err)

    def test_full_access_request_allows_outside_path(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside, self._with_workspace(root):
            outside_file = os.path.join(outside, 'note.txt')
            token = config.bind_request_full_access(True)
            try:
                self.assertTrue(is_inside_workspace(outside_file))
                path, err = check_path_or_error(outside_file)
                self.assertEqual(os.path.realpath(outside_file), os.path.realpath(path))
                self.assertIsNone(err)
            finally:
                config.reset_request_full_access(token)

            self.assertFalse(is_inside_workspace(outside_file))

    def test_full_access_request_disables_shell_workspace_boundary_only(self):
        with tempfile.TemporaryDirectory() as root, self._with_workspace(root):
            violation, _ = command_workspace_violation('type C:\\outside\\secret.txt')
            self.assertTrue(violation)

            token = config.bind_request_full_access(True)
            try:
                violation, reason = command_workspace_violation('type C:\\outside\\secret.txt')
                self.assertFalse(violation)
                self.assertEqual('', reason)
            finally:
                config.reset_request_full_access(token)

    def test_request_workspace_is_bound_by_session(self):
        with tempfile.TemporaryDirectory() as root_a, tempfile.TemporaryDirectory() as root_b, self._with_workspace(root_a):
            try:
                config.set_session_workspace('chat-a', root_a)
                config.set_session_workspace('chat-b', root_b)
                token_ws = config.bind_request_workspace(config.get_session_workspace('chat-b'))
                token_cwd = config.bind_request_cwd(config.get_session_cwd('chat-b'))
                try:
                    file_a = os.path.join(root_a, 'a.txt')
                    file_b = os.path.join(root_b, 'b.txt')
                    self.assertEqual(os.path.realpath(root_b), config.get_current_workspace())
                    self.assertFalse(is_inside_workspace(file_a))
                    self.assertTrue(is_inside_workspace(file_b))
                    _, err = check_path_or_error(file_b)
                    self.assertIsNone(err)
                finally:
                    config.reset_request_cwd(token_cwd)
                    config.reset_request_workspace(token_ws)
            finally:
                config.SESSION_WORKSPACES.clear()
                config.SESSION_CWDS.clear()


if __name__ == '__main__':
    unittest.main()
