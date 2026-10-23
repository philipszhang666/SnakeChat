import os
import tempfile
import unittest
import zipfile
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


class FileExtractHandler(FilesMixin):
    def __init__(self):
        self.response = CaptureResponse()
        self.request_context = SimpleNamespace(session_id='test-file-extract')


class FileExtractZipTests(unittest.TestCase):
    def _with_workspace(self, root):
        return mock.patch.multiple(
            config,
            WORKSPACE_ROOT=os.path.realpath(root),
            current_cwd=os.path.realpath(root),
        )

    def _make_zip(self, root, name, entries):
        path = os.path.join(root, name)
        with zipfile.ZipFile(path, 'w') as zf:
            for arcname, content in entries:
                zf.writestr(arcname, content)
        return path

    def test_extract_zip_to_same_name_folder(self):
        with tempfile.TemporaryDirectory() as root, self._with_workspace(root), mock.patch('builtins.print'):
            self._make_zip(root, 'demo.zip', [
                ('a.txt', 'hello'),
                ('sub/b.txt', 'world'),
                ('中文/名称.txt', '你好'),
                ('空目录/', ''),
            ])

            handler = FileExtractHandler()
            handler.handle_extract_zip({'path': 'demo.zip'})

            self.assertEqual(200, handler.response.code)
            self.assertTrue(handler.response.data['ok'])
            self.assertEqual(3, handler.response.data['entries'])
            dest = os.path.join(root, 'demo')
            self.assertEqual(os.path.realpath(dest), os.path.realpath(handler.response.data['dest_dir']))
            with open(os.path.join(dest, 'a.txt'), encoding='utf-8') as f:
                self.assertEqual('hello', f.read())
            with open(os.path.join(dest, 'sub', 'b.txt'), encoding='utf-8') as f:
                self.assertEqual('world', f.read())
            with open(os.path.join(dest, '中文', '名称.txt'), encoding='utf-8') as f:
                self.assertEqual('你好', f.read())
            self.assertTrue(os.path.isdir(os.path.join(dest, '空目录')))

    def test_extract_zip_twice_uses_deduped_folder(self):
        with tempfile.TemporaryDirectory() as root, self._with_workspace(root), mock.patch('builtins.print'):
            self._make_zip(root, 'demo.zip', [('a.txt', 'hello')])

            handler = FileExtractHandler()
            handler.handle_extract_zip({'path': 'demo.zip'})
            first = handler.response.data['dest_dir']
            handler.handle_extract_zip({'path': 'demo.zip'})
            second = handler.response.data['dest_dir']

            self.assertNotEqual(first, second)
            self.assertEqual('demo (2)', os.path.basename(os.path.realpath(second)))
            self.assertTrue(os.path.isfile(os.path.join(second, 'a.txt')))

    def test_extract_zip_rejects_non_zip_file(self):
        with tempfile.TemporaryDirectory() as root, self._with_workspace(root), mock.patch('builtins.print'):
            with open(os.path.join(root, 'note.txt'), 'w', encoding='utf-8') as f:
                f.write('plain')

            handler = FileExtractHandler()
            handler.handle_extract_zip({'path': 'note.txt'})

            self.assertFalse(handler.response.data['ok'])
            self.assertIn('zip', handler.response.data['error'])

    def test_extract_zip_rejects_missing_file(self):
        with tempfile.TemporaryDirectory() as root, self._with_workspace(root), mock.patch('builtins.print'):
            handler = FileExtractHandler()
            handler.handle_extract_zip({'path': 'missing.zip'})

            self.assertFalse(handler.response.data['ok'])

    def test_extract_zip_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as root, self._with_workspace(root), mock.patch('builtins.print'):
            self._make_zip(root, 'evil.zip', [('../evil.txt', 'bad')])

            handler = FileExtractHandler()
            handler.handle_extract_zip({'path': 'evil.zip'})

            self.assertFalse(handler.response.data['ok'])
            self.assertIn('非法路径', handler.response.data['error'])
            self.assertFalse(os.path.exists(os.path.join(os.path.dirname(os.path.realpath(root)), 'evil.txt')))

    def test_extract_zip_into_explicit_dest_dir(self):
        with tempfile.TemporaryDirectory() as root, self._with_workspace(root), mock.patch('builtins.print'):
            self._make_zip(root, 'demo.zip', [('deep/a.txt', 'hello')])
            os.makedirs(os.path.join(root, 'target'))

            handler = FileExtractHandler()
            handler.handle_extract_zip({'path': 'demo.zip', 'dest_dir': 'target'})

            self.assertTrue(handler.response.data['ok'])
            self.assertEqual('target', os.path.basename(os.path.realpath(handler.response.data['dest_dir'])))
            self.assertTrue(os.path.isfile(os.path.join(root, 'target', 'deep', 'a.txt')))


if __name__ == '__main__':
    unittest.main()
