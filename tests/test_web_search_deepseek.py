"""DeepSeek 官方搜索 API 接入测试（server/web.py handle_web_search）。

覆盖：
1. 没有 search_api_key 时完全不请求 DeepSeek，行为与改造前一致
2. 有 Key 时 auto 模式优先走 deepseek，返回 billed / engine_label / 扩展字段
3. DeepSeek 失败（402/429/5xx）时自动回退到免费引擎，并暴露 fallback_errors
4. 显式 engine='deepseek' 失败时不做回退，直接报错
5. 未知引擎的报错文案包含 deepseek
"""

import unittest
from unittest import mock

from server.web import WebMixin


BING_HTML = '''
<html><body><ol>
<li class="b_algo">
  <h2><a href="https://fallback.example.com/page">Fallback Title</a></h2>
  <p class="b_lineclamp2">fallback snippet</p>
</li>
</ol></body></html>
'''

DEEPSEEK_PAYLOAD = {
    'results': [
        {
            'rerank_score': 2.4,
            'title': 'DeepSeek V4 模型发布',
            'url': 'https://example.com/deepseek-v4',
            'snippet': 'DeepSeek V4 已上线，支持工具调用与长上下文。',
            'summary': 'DeepSeek 发布了 V4 模型。此次发布改进了工具调用与长上下文能力。',
            'content': 'DeepSeek V4 现已正式上线……',
            'site_name': 'Example News',
            'site_icon': 'https://example.com/favicon.ico',
            'date': '2026-06-01T00:00:00+00:00',
            'authority': 3,
        }
    ]
}


class FakeResponse:
    def __init__(self):
        self.status = None
        self.payload = None

    def json(self, code, payload):
        self.status = code
        self.payload = payload


class SearchHandler(WebMixin):
    def __init__(self):
        self.response = FakeResponse()

    def search(self, body):
        self.handle_web_search(body)
        return self.response.payload


def _mock_post(status=200, payload=None, text=''):
    resp = mock.Mock()
    resp.status_code = status
    resp.text = text
    resp.json.return_value = payload if payload is not None else {}
    return resp


def _mock_get(html=BING_HTML):
    resp = mock.Mock()
    resp.status_code = 200
    resp.text = html
    return resp


class WebSearchDeepSeekTests(unittest.TestCase):
    def test_no_api_key_never_calls_deepseek(self):
        handler = SearchHandler()
        with mock.patch('requests.post') as post, \
                mock.patch('requests.get', return_value=_mock_get()):
            payload = handler.search({'query': 'test', 'region': 'cn'})

        post.assert_not_called()
        self.assertTrue(payload['ok'])
        self.assertEqual('bing-cn', payload['engine'])
        self.assertFalse(payload['billed'])
        self.assertEqual('Bing 国内', payload['engine_label'])
        self.assertEqual('', payload['price_hint'])
        self.assertNotIn('fallback_errors', payload)

    def test_deepseek_success_marks_billed_and_keeps_extra_fields(self):
        handler = SearchHandler()
        with mock.patch('requests.post', return_value=_mock_post(200, DEEPSEEK_PAYLOAD)) as post:
            payload = handler.search({
                'query': 'DeepSeek V4 模型 发布',
                'max_results': 5,
                'need_content': True,
                'search_api_key': 'sk-test-key',
            })

        self.assertTrue(payload['ok'])
        self.assertEqual('deepseek', payload['engine'])
        self.assertEqual('DeepSeek 官方搜索 API', payload['engine_label'])
        self.assertTrue(payload['billed'])
        self.assertIn('¥', payload['price_hint'])
        self.assertEqual(1, payload['count'])

        # 请求体与鉴权头
        args, kwargs = post.call_args
        self.assertEqual('https://api.deepseek.com/v1/tools/search', args[0])
        self.assertEqual('Bearer sk-test-key', kwargs['headers']['Authorization'])
        self.assertEqual('DeepSeek V4 模型 发布', kwargs['json']['query'])
        self.assertEqual(5, kwargs['json']['count'])
        self.assertTrue(kwargs['json']['need_content'])

        # _dedupe 必须保住 DeepSeek 的扩展字段
        first = payload['results'][0]
        self.assertEqual('DeepSeek V4 模型发布', first['title'])
        self.assertIn('summary', first)
        self.assertEqual(3, first['authority'])
        self.assertEqual(2.4, first['rerank_score'])
        self.assertEqual('2026-06-01T00:00:00+00:00', first['date'])
        self.assertEqual('Example News', first['site_name'])
        self.assertNotIn('fallback_errors', payload)

    def test_deepseek_failure_falls_back_to_free_engine(self):
        handler = SearchHandler()
        with mock.patch('requests.post', return_value=_mock_post(402, {}, 'Insufficient Balance')), \
                mock.patch('requests.get', return_value=_mock_get()):
            payload = handler.search({
                'query': 'test',
                'region': 'cn',
                'search_api_key': 'sk-test-key',
            })

        self.assertTrue(payload['ok'])
        self.assertEqual('bing-cn', payload['engine'])
        self.assertFalse(payload['billed'])
        self.assertIn('fallback_errors', payload)
        self.assertTrue(any('deepseek' in err for err in payload['fallback_errors']))

    def test_explicit_deepseek_engine_does_not_fall_back(self):
        handler = SearchHandler()
        with mock.patch('requests.post', return_value=_mock_post(401, {}, 'invalid api key')), \
                mock.patch('requests.get', return_value=_mock_get()) as get:
            payload = handler.search({
                'query': 'test',
                'engine': 'deepseek',
                'search_api_key': 'bad-key',
            })

        get.assert_not_called()
        self.assertFalse(payload['ok'])
        self.assertIn('deepseek', payload['error'])
        self.assertIn('401', payload['error'])

    def test_unknown_engine_error_lists_deepseek(self):
        handler = SearchHandler()
        payload = handler.search({'query': 'test', 'engine': 'nope'})
        self.assertFalse(payload['ok'])
        self.assertIn('deepseek', payload['error'])

    def test_base_url_with_v1_suffix_is_normalized(self):
        handler = SearchHandler()
        with mock.patch('requests.post', return_value=_mock_post(200, DEEPSEEK_PAYLOAD)) as post:
            handler.search({
                'query': 'test',
                'search_api_key': 'sk-test-key',
                'search_base_url': 'https://relay.example.com/v1',
            })

        args, _ = post.call_args
        self.assertEqual('https://relay.example.com/v1/tools/search', args[0])


if __name__ == '__main__':
    unittest.main()
