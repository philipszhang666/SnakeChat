import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from server import config
from server.files import FilesMixin


class CaptureResponse:
    def __init__(self):
        self.code = None
        self.data = None

    def json(self, code, data):
        self.code = code
        self.data = data


class FileFindHandler(FilesMixin):
    def __init__(self):
        self.response = CaptureResponse()
        self.request_context = SimpleNamespace(session_id='test-file-find')


class FileFindTests(unittest.TestCase):
    def _with_workspace(self, root):
        return mock.patch.multiple(
            config,
            WORKSPACE_ROOT=os.path.realpath(root),
            current_cwd=os.path.realpath(root),
        )

    def test_find_file_returns_relative_match(self):
        with tempfile.TemporaryDirectory() as root, self._with_workspace(root), mock.patch('builtins.print'):
            os.makedirs(os.path.join(root, 'src'))
            with open(os.path.join(root, 'src', 'main.py'), 'w', encoding='utf-8') as f:
                f.write('print("hi")')

            handler = FileFindHandler()
            handler.handle_find_file({'name': 'main.py'})

            self.assertEqual(200, handler.response.code)
            self.assertTrue(handler.response.data['ok'])
            self.assertEqual(['src/main.py'], [m['path'] for m in handler.response.data['matches']])

    def test_find_file_limits_ambiguous_matches(self):
        with tempfile.TemporaryDirectory() as root, self._with_workspace(root), mock.patch('builtins.print'):
            os.makedirs(os.path.join(root, 'a'))
            os.makedirs(os.path.join(root, 'b'))
            for folder in ('a', 'b'):
                with open(os.path.join(root, folder, 'main.py'), 'w', encoding='utf-8') as f:
                    f.write(folder)

            handler = FileFindHandler()
            handler.handle_find_file({'name': 'main.py', 'max_results': 1})

            self.assertEqual(200, handler.response.code)
            self.assertTrue(handler.response.data['ok'])
            self.assertEqual(1, len(handler.response.data['matches']))
            self.assertTrue(handler.response.data['truncated'])

    def test_find_file_rejects_paths(self):
        with tempfile.TemporaryDirectory() as root, self._with_workspace(root), mock.patch('builtins.print'):
            handler = FileFindHandler()
            handler.handle_find_file({'name': '../main.py'})

            self.assertEqual(200, handler.response.code)
            self.assertFalse(handler.response.data['ok'])


if __name__ == '__main__':
    unittest.main()
