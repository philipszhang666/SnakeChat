# ============================================================
# server/web.py - 网络搜索 & 网页抓取
# ============================================================
# 提供 WebMixin。包含：
#   handle_web_search - 多搜索源自动回退（DeepSeek 官方 API / Bing / Google / DuckDuckGo / 360 / 搜狗 / 百度）
#   handle_fetch_url  - 抓取并提取网页正文
#
# 依赖第三方库 requests（仅这里和 LMS 教务工具用到）
# ============================================================

import os
import re
from html import unescape
from urllib.parse import quote_plus, parse_qs, unquote, urlparse

# ============ 🔍 DeepSeek 官方搜索 API（可选引擎） ============
# 文档：https://api-docs.deepseek.com/zh-cn/guides/search
# 计费：每 1,000 次成功请求 5 元；无结果 / 失败 / 超时不计费；QPS 5
DEEPSEEK_SEARCH_DEFAULT_BASE = 'https://api.deepseek.com'
DEEPSEEK_SEARCH_PATH = '/v1/tools/search'
DEEPSEEK_SEARCH_PRICE_HINT = '约 ¥0.005 / 次'

# _dedupe() 需要原样保留的扩展字段（DeepSeek 搜索独有）
_EXTRA_RESULT_FIELDS = ('summary', 'content', 'date', 'authority',
                        'rerank_score', 'site_name', 'site_icon')


class WebMixin:
    """Handler mixin：网络搜索 + 网页抓取"""

    # ============ Proxy helpers ============
    def _proxy_flag_enabled(self, value):
        if isinstance(value, bool):
            return value
        if value is None:
            return False
        if isinstance(value, (int, float)):
            return bool(value)
        return str(value).strip().lower() in ('1', 'true', 'yes', 'y', 'on')

    def _normalize_local_web_proxy_url(self, raw_url):
        raw = str(raw_url or '').strip()
        if not raw:
            return '', 'proxy_url is empty while proxy is enabled'

        m = re.match(r'^(https?|socks5h?)://(?:127\.0\.0\.1|localhost):(\d{1,5})/?$', raw, flags=re.I)
        if not m:
            return '', 'proxy_url must be a local proxy like http://127.0.0.1:7890 or socks5h://127.0.0.1:7890'

        scheme = m.group(1).lower()
        port = int(m.group(2))
        if port < 1 or port > 65535:
            return '', 'proxy port must be between 1 and 65535'
        if scheme == 'https':
            scheme = 'http'
        elif scheme == 'socks5':
            scheme = 'socks5h'
        return f'{scheme}://127.0.0.1:{port}', None

    def _web_proxy_config(self, body):
        body = body or {}
        enabled_value = body.get('proxy_enabled')
        if enabled_value is None:
            enabled_value = body.get('use_proxy')
        if not self._proxy_flag_enabled(enabled_value):
            return None, '', None

        proxy_url, error = self._normalize_local_web_proxy_url(body.get('proxy_url') or body.get('proxy'))
        if error:
            return None, '', error

        if proxy_url.startswith('socks5h://'):
            try:
                import socks  # noqa: F401
            except ImportError:
                return None, '', 'SOCKS proxy requires PySocks support. Run: pip install "requests[socks]" and restart the local service.'

        return {'http': proxy_url, 'https': proxy_url}, proxy_url, None

    def _format_web_request_error(self, engine, error, proxy_url=''):
        message = re.sub(r'\s+', ' ', str(error) or type(error).__name__).strip()
        if len(message) > 260:
            message = message[:257] + '...'
        text = f'{engine}: {type(error).__name__}: {message}'
        if proxy_url:
            text += f' (proxy={proxy_url})'
            lower = message.lower()
            if 'missing dependencies for socks support' in lower or 'socks' in lower:
                text += '; install requests[socks] and restart the local service'
            elif 'connection refused' in lower or 'actively refused' in lower or 'winerror 10061' in lower:
                text += '; confirm the local proxy is running and the port is correct'
            elif 'proxy' in lower:
                text += '; check the local proxy type and port'
        return text

    # 引擎名 → 前端展示用的中文名（让用户一眼看出本次用的是哪个引擎）
    _WEB_ENGINE_LABELS = {
        'deepseek':    'DeepSeek 官方搜索 API',
        'bing-cn':     'Bing 国内',
        'bing-global': 'Bing 国际',
        'bing':        'Bing',
        'google':      'Google',
        'duckduckgo':  'DuckDuckGo',
        'ddg':         'DuckDuckGo',
        'sogou':       '搜狗',
        '360':         '360 搜索',
        'so':          '360 搜索',
        'baidu':       '百度',
    }

    def _web_engine_label(self, name):
        """引擎名 → 中文展示名。"""
        return self._WEB_ENGINE_LABELS.get(str(name or '').strip().lower(), name or 'unknown')

    # ============ Web search ============
    def handle_web_search(self, body):
        """网页搜索，返回标题 + URL + 摘要列表。

        默认不需要任何 API Key（抓取公开搜索页）。若请求体带 search_api_key，
        则优先调用 DeepSeek 官方搜索 API：结构化结果，额外返回摘要 / 发布时间 /
        权威度 / 改写分数，按次计费（约 ¥0.005 / 次），失败自动回退到免费引擎。

        引擎按可用性排序（自动回退）：
          0. DeepSeek 官方 API        — 仅当提供 search_api_key 时启用，计费
          1. Bing 国内 (cn.bing.com)   — 默认主力
          2. Google (google.com)       — 全球内容更全，可能受网络环境影响
          3. DuckDuckGo HTML           — 轻量页面，适合兜底
          4. 搜狗 / 360 / 百度          — 国内结果补充
          5. Bing 国际 (www.bing.com)  — 海外内容兜底

        region:
          - 'cn' / 'cn-zh' / 'zh-cn' / 缺省 → 国内引擎优先
          - 'global' / 'us-en' / 'wt-wt' / 'en' → Bing 国际优先

        engine/source（可选）：
          - auto / all：按 region 自动回退
          - deepseek / google / duckduckgo / bing / bing-cn / bing-global / sogou / 360 / baidu：指定单个搜索源
            （显式指定 deepseek 时不做回退，失败直接报错，便于排查）

        proxy_enabled/proxy_url（可选）：
          - proxy_enabled=true 且 proxy_url 非空时，本次搜索请求走本地代理
          - proxy_url 示例：http://127.0.0.1:7890 / socks5://127.0.0.1:7890

        search_api_key / search_base_url / ori_question / need_content（可选）：
          - search_api_key：DeepSeek API Key；提供后 auto 模式把 deepseek 排第一位
          - search_base_url：默认 https://api.deepseek.com
          - ori_question：触发搜索的用户原始问题，帮助理解搜索意图
          - need_content：是否让 DeepSeek 一并返回网页正文（更耗 token）
        """
        query = (body.get('query') or '').strip()
        max_results = min(int(body.get('max_results', 8)), 20)
        region = (body.get('region') or 'cn').lower()
        preferred_engine = (body.get('engine') or body.get('source') or 'auto').strip().lower()
        # 🔍 DeepSeek 官方搜索（可选）：Key 由前端每次请求带上，后端不落盘
        search_api_key = (body.get('search_api_key') or '').strip()
        search_base_url = (body.get('search_base_url') or '').strip() or DEEPSEEK_SEARCH_DEFAULT_BASE
        ori_question = (body.get('ori_question') or '').strip()
        need_content = bool(body.get('need_content'))
        proxies, proxy_url, proxy_error = self._web_proxy_config(body)

        if not query:
            return self.response.json(200, {'ok': False, 'error': 'query 不能为空'})
        if proxy_error:
            return self.response.json(200, {'ok': False, 'error': proxy_error})

        proxy_hint = proxy_url if proxies else 'off'
        deepseek_hint = 'on' if search_api_key else 'off'
        print(f'🌐 [网络搜索] "{query}" (max={max_results}, region={region}, '
              f'engine={preferred_engine}, deepseek={deepseek_hint}, proxy={proxy_hint})')

        try:
            import requests
        except ImportError:
            return self.response.json(200, {'ok': False, 'error': '后端缺少 requests 模块，请运行：pip install requests'})

        UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
        BASE_HEADERS = {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            # ⭐ 不要写 br！requests 默认不支持 Brotli 解压，会拿到二进制乱码
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        }

        def _dedupe(items):
            seen = set()
            out = []
            for item in items or []:
                url = (item.get('url') or '').strip()
                title = (item.get('title') or '').strip()
                if not url or not title:
                    continue
                key = re.sub(r'#.*$', '', url).rstrip('/')
                if key in seen:
                    continue
                seen.add(key)
                entry = {
                    'title': title,
                    'url': url,
                    'snippet': (item.get('snippet') or '').strip()
                }
                # 保留 DeepSeek 搜索的扩展字段（摘要 / 正文 / 时间 / 权威度等）
                for extra_key in _EXTRA_RESULT_FIELDS:
                    extra_val = item.get(extra_key)
                    if extra_val not in (None, '', []):
                        entry[extra_key] = extra_val
                out.append(entry)
                if len(out) >= max_results:
                    break
            return out

        # 通用工具：去 HTML 标签 + HTML 实体解码 + 折叠空白
        def _clean(s):
            if not s:
                return ''
            s = re.sub(r'<[^>]+>', '', s)
            s = unescape(s)
            s = re.sub(r'\s+', ' ', s).strip()
            return s

        def _unwrap_search_url(raw_url):
            """解开 Google / DuckDuckGo 等搜索页的跳转 URL。"""
            if not raw_url:
                return ''
            raw_url = unescape(raw_url).strip()
            if raw_url.startswith('//'):
                raw_url = 'https:' + raw_url
            if raw_url.startswith('/url?') or raw_url.startswith('https://www.google.'):
                try:
                    qs = parse_qs(urlparse(raw_url).query)
                    if qs.get('q'):
                        return qs['q'][0]
                    if qs.get('url'):
                        return qs['url'][0]
                except Exception:
                    pass
            if 'duckduckgo.com/l/?' in raw_url:
                try:
                    qs = parse_qs(urlparse(raw_url).query)
                    if qs.get('uddg'):
                        return unquote(qs['uddg'][0])
                except Exception:
                    pass
            return raw_url

        # ===== Bing 国内 / 国际版 =====
        def search_bing(base_url, mkt='zh-CN'):
            url = f'{base_url}/search?q={quote_plus(query)}&mkt={mkt}&count={max_results}'
            resp = requests.get(url, headers=BASE_HEADERS, timeout=10, proxies=proxies)
            html = resp.text
            out = []
            for m in re.finditer(
                r'<li[^>]*\bclass="[^"]*b_algo[^"]*"[^>]*>(.*?)</li>',
                html, flags=re.S
            ):
                block = m.group(1)
                tm = re.search(r'<h2[^>]*>\s*<a[^>]*\shref="([^"]+)"[^>]*>(.*?)</a>',
                               block, flags=re.S)
                if not tm:
                    continue
                raw_url, raw_title = tm.group(1), tm.group(2)
                if not raw_url.startswith('http'):
                    continue
                sm = re.search(r'<p[^>]*\bclass="[^"]*b_lineclamp[^"]*"[^>]*>(.*?)</p>',
                               block, flags=re.S)
                if not sm:
                    sm = re.search(r'<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>.*?<p[^>]*>(.*?)</p>',
                                   block, flags=re.S)
                snippet = _clean(sm.group(1)) if sm else ''
                title = _clean(raw_title)
                if title:
                    out.append({'title': title, 'url': raw_url, 'snippet': snippet})
                if len(out) >= max_results:
                    break
            return out

        # ===== Google =====
        def search_google():
            # Google 裸抓取可能因地区、验证码或网络环境失败；失败时会自动回退到其它引擎。
            hl = 'en' if region in ('global', 'us-en', 'wt-wt', 'en') else 'zh-CN'
            url = f'https://www.google.com/search?q={quote_plus(query)}&num={max_results}&hl={quote_plus(hl)}&filter=0'
            headers = dict(BASE_HEADERS)
            headers['Accept-Language'] = 'en-US,en;q=0.9,zh-CN;q=0.8' if hl == 'en' else BASE_HEADERS['Accept-Language']
            resp = requests.get(url, headers=headers, timeout=10, proxies=proxies)
            html = resp.text
            out = []

            # 常见结构：<a href="/url?q=..."><h3>标题</h3></a>
            for tm in re.finditer(r'<a[^>]+href="([^"]+)"[^>]*>\s*(?:<br>\s*)?<h3[^>]*>(.*?)</h3>', html, flags=re.S | re.I):
                raw_url, raw_title = tm.group(1), tm.group(2)
                real_url = _unwrap_search_url(raw_url)
                if not real_url.startswith('http') or 'google.' in urlparse(real_url).netloc:
                    continue
                tail = html[tm.end():tm.end() + 2500]
                sm = re.search(r'<div[^>]*\bclass="[^"]*(?:VwiC3b|IsZvec|BNeawe)[^"]*"[^>]*>(.*?)</div>', tail, flags=re.S | re.I)
                title = _clean(raw_title)
                snippet = _clean(sm.group(1)) if sm else ''
                if title:
                    out.append({'title': title, 'url': real_url, 'snippet': snippet})
                if len(out) >= max_results:
                    break

            # 备用结构：移动/简化页常见 /url?q=... 后面跟文本块
            if not out:
                for tm in re.finditer(r'<a[^>]+href="(/url\?q=[^"]+)"[^>]*>(.*?)</a>', html, flags=re.S | re.I):
                    real_url = _unwrap_search_url(tm.group(1))
                    title = _clean(tm.group(2))
                    if not real_url.startswith('http') or not title or 'google.' in urlparse(real_url).netloc:
                        continue
                    out.append({'title': title, 'url': real_url, 'snippet': ''})
                    if len(out) >= max_results:
                        break
            return _dedupe(out)

        # ===== DuckDuckGo HTML =====
        def search_duckduckgo():
            url = f'https://html.duckduckgo.com/html/?q={quote_plus(query)}'
            headers = dict(BASE_HEADERS)
            headers['Referer'] = 'https://duckduckgo.com/'
            resp = requests.get(url, headers=headers, timeout=10, proxies=proxies)
            html = resp.text
            out = []
            for tm in re.finditer(r'<a[^>]*\bclass="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', html, flags=re.S | re.I):
                raw_url, raw_title = tm.group(1), tm.group(2)
                real_url = _unwrap_search_url(raw_url)
                tail = html[tm.end():tm.end() + 2000]
                sm = re.search(r'<a[^>]*\bclass="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>', tail, flags=re.S | re.I)
                if not sm:
                    sm = re.search(r'<div[^>]*\bclass="[^"]*result__snippet[^"]*"[^>]*>(.*?)</div>', tail, flags=re.S | re.I)
                title = _clean(raw_title)
                snippet = _clean(sm.group(1)) if sm else ''
                if title and real_url.startswith('http'):
                    out.append({'title': title, 'url': real_url, 'snippet': snippet})
                if len(out) >= max_results:
                    break
            return _dedupe(out)

        # ===== 搜狗 =====
        def search_sogou():
            url = f'https://www.sogou.com/web?query={quote_plus(query)}'
            resp = requests.get(url, headers=BASE_HEADERS, timeout=10, proxies=proxies)
            html = resp.text
            out = []
            for tm in re.finditer(
                r'<h3[^>]*\bclass="(?:pt|vr-title)"[^>]*>\s*(?:<!--[^>]*-->)?\s*<a[^>]*\sname="dttl"[^>]*\shref="([^"]+)"[^>]*>(.*?)</a>',
                html, flags=re.S
            ):
                raw_url, raw_title = tm.group(1), tm.group(2)
                if raw_url.startswith('/'):
                    raw_url = 'https://www.sogou.com' + raw_url
                elif not raw_url.startswith('http'):
                    continue
                tail = html[tm.end():tm.end() + 3500]
                sm = re.search(r'<div[^>]*\bclass="[^"]*\b(?:ft|fz-mid|space-txt|str_info|str-text-info)[^"]*"[^>]*>(.*?)</div>',
                               tail, flags=re.S)
                if not sm:
                    sm = re.search(r'<div[^>]*\bclass="text-layout"[^>]*>.*?<p[^>]*>(.*?)</p>',
                                   tail, flags=re.S)
                snippet = _clean(sm.group(1)) if sm else ''
                title = _clean(raw_title)
                if title:
                    out.append({'title': title, 'url': raw_url, 'snippet': snippet})
                if len(out) >= max_results:
                    break
            return out

        # ===== 360 =====
        def search_360():
            url = f'https://www.so.com/s?q={quote_plus(query)}'
            resp = requests.get(url, headers=BASE_HEADERS, timeout=10, proxies=proxies)
            html = resp.text
            out = []
            for tm in re.finditer(
                r'<h3[^>]*\bclass="[^"]*res-title[^"]*"[^>]*>\s*<a([^>]+)>(.*?)</a>',
                html, flags=re.S
            ):
                a_attrs, raw_title = tm.group(1), tm.group(2)
                mu = re.search(r'\bdata-mdurl="([^"]+)"', a_attrs)
                if mu:
                    real_url = mu.group(1)
                else:
                    hm = re.search(r'\shref="([^"]+)"', a_attrs)
                    if not hm:
                        continue
                    real_url = hm.group(1)
                if not real_url.startswith('http'):
                    continue
                tail = html[tm.end():tm.end() + 3000]
                sm = re.search(r'<p[^>]*\bclass="[^"]*res-desc[^"]*"[^>]*>(.*?)</p>',
                               tail, flags=re.S)
                if not sm:
                    sm = re.search(r'<div[^>]*\bclass="[^"]*res-rich-desc[^"]*"[^>]*>(.*?)</div>',
                                   tail, flags=re.S)
                if not sm:
                    sm = re.search(r'<p[^>]*\bclass="[^"]*res-comm-con[^"]*"[^>]*>(.*?)</p>',
                                   tail, flags=re.S)
                snippet = _clean(sm.group(1)) if sm else ''
                title = _clean(raw_title)
                if title:
                    out.append({'title': title, 'url': real_url, 'snippet': snippet})
                if len(out) >= max_results:
                    break
            return out

        # ===== 百度（必须先拿 Cookie）=====
        def search_baidu():
            sess = requests.Session()
            sess.headers.update(BASE_HEADERS)
            if proxies:
                sess.proxies.update(proxies)
            try:
                sess.get('https://www.baidu.com/', timeout=5)
            except Exception:
                pass
            url = f'https://www.baidu.com/s?wd={quote_plus(query)}&rn={max_results}'
            resp = sess.get(url, timeout=10, headers={'Referer': 'https://www.baidu.com/'})
            html = resp.text
            out = []
            for tm in re.finditer(
                r'<h3[^>]*\bclass="[^"]*\bt\b[^"]*"[^>]*>\s*<a[^>]*\shref="(https?://[^"]*baidu\.com/link\?[^"]+)"[^>]*>(.*?)</a>\s*</h3>',
                html, flags=re.S
            ):
                raw_url, raw_title = tm.group(1), tm.group(2)
                tail = html[tm.end():tm.end() + 4000]
                sm = re.search(r'<span[^>]*\bclass="[^"]*content-right[^"]*"[^>]*>(.*?)</span>',
                               tail, flags=re.S)
                if not sm:
                    sm = re.search(r'<div[^>]*\bclass="[^"]*c-abstract[^"]*"[^>]*>(.*?)</div>',
                                   tail, flags=re.S)
                if not sm:
                    sm = re.search(r'<span[^>]*\bdata-module="abstract"[^>]*>(.*?)</span>',
                                   tail, flags=re.S)
                snippet = _clean(sm.group(1)) if sm else ''
                title = _clean(raw_title)
                if title:
                    out.append({'title': title, 'url': raw_url, 'snippet': snippet})
                if len(out) >= max_results:
                    break
            return out

        # ===== DeepSeek 官方搜索 API（可选，计费） =====
        def search_deepseek():
            """POST /v1/tools/search，返回结构化结果（含摘要 / 时间 / 权威度）。"""
            if not search_api_key:
                raise RuntimeError('未配置 DeepSeek API Key')

            base = search_base_url.rstrip('/')
            if base.endswith('/v1'):
                base = base[:-3]
            url = base + DEEPSEEK_SEARCH_PATH
            api_payload = {
                'query': query,
                'count': max(1, min(max_results, 50)),
                'need_content': need_content,
            }
            if ori_question:
                api_payload['ori_question'] = ori_question

            resp = requests.post(
                url,
                headers={
                    'Authorization': f'Bearer {search_api_key}',
                    'Content-Type': 'application/json',
                },
                json=api_payload,
                timeout=20,
                proxies=proxies,
            )
            if resp.status_code != 200:
                # 400/401/402/403/429/5xx 统一抛错，交给回退链处理
                detail = re.sub(r'\s+', ' ', (resp.text or '')).strip()[:200]
                raise RuntimeError(f'HTTP {resp.status_code} {detail}'.strip())

            data = resp.json() or {}
            out = []
            for item in data.get('results') or []:
                if not isinstance(item, dict):
                    continue
                real_url = (item.get('url') or '').strip()
                title = (item.get('title') or '').strip()
                if not real_url or not title:
                    continue
                out.append({
                    'title': title,
                    'url': real_url,
                    'snippet': (item.get('snippet') or '').strip(),
                    'summary': (item.get('summary') or '').strip(),
                    'content': (item.get('content') or '').strip(),
                    'date': item.get('date'),
                    'authority': item.get('authority'),
                    'rerank_score': item.get('rerank_score'),
                    'site_name': item.get('site_name'),
                    'site_icon': item.get('site_icon'),
                })
            return out

        engine_map = {
            'deepseek':    search_deepseek,
            'bing-cn':     lambda: search_bing('https://cn.bing.com', 'zh-CN'),
            'bing-global': lambda: search_bing('https://www.bing.com', 'en-US'),
            'bing':        lambda: search_bing('https://www.bing.com', 'en-US' if region in ('global', 'us-en', 'wt-wt', 'en') else 'zh-CN'),
            'google':      search_google,
            'duckduckgo':  search_duckduckgo,
            'ddg':         search_duckduckgo,
            '360':         search_360,
            'so':          search_360,
            'sogou':       search_sogou,
            'baidu':       search_baidu,
        }

        # 提供了 DeepSeek Key 时，auto 模式把它排第一位（失败自动回退到免费引擎）
        deepseek_first = [('deepseek', search_deepseek)] if search_api_key else []

        # ===== 按 region / 指定 engine 决定回退顺序 =====
        if preferred_engine not in ('', 'auto', 'all'):
            fn = engine_map.get(preferred_engine)
            if not fn:
                return self.response.json(200, {
                    'ok': False,
                    'error': f'未知搜索源：{preferred_engine}。可选：auto, deepseek, google, duckduckgo, bing, bing-cn, bing-global, 360, sogou, baidu'
                })
            engines = [(preferred_engine, fn)]
        elif region in ('global', 'us-en', 'wt-wt', 'en'):
            engines = deepseek_first + [
                ('google',      search_google),
                ('duckduckgo',  search_duckduckgo),
                ('bing-global', lambda: search_bing('https://www.bing.com', 'en-US')),
                ('bing-cn',     lambda: search_bing('https://cn.bing.com',  'zh-CN')),
                ('sogou',       search_sogou),
                ('360',         search_360),
                ('baidu',       search_baidu),
            ]
        else:  # cn / 缺省
            engines = deepseek_first + [
                ('bing-cn',     lambda: search_bing('https://cn.bing.com',  'zh-CN')),
                ('sogou',       search_sogou),
                ('360',         search_360),
                ('baidu',       search_baidu),
                ('google',      search_google),
                ('duckduckgo',  search_duckduckgo),
                ('bing-global', lambda: search_bing('https://www.bing.com', 'en-US')),
            ]

        # ===== 逐个尝试 =====
        errors = []
        for name, fn in engines:
            try:
                results = _dedupe(fn())
                if results:
                    billed = (name == 'deepseek')
                    label = self._web_engine_label(name)
                    if billed:
                        print(f'✅ [网络搜索] {name} 命中 {len(results)} 条 '
                              f'💰 计费 1 次（{DEEPSEEK_SEARCH_PRICE_HINT}）')
                    else:
                        print(f'✅ [网络搜索] {name} 命中 {len(results)} 条（免费引擎）')
                    payload = {
                        'ok': True,
                        'query': query,
                        'engine': name,
                        'engine_label': label,
                        'billed': billed,
                        'price_hint': DEEPSEEK_SEARCH_PRICE_HINT if billed else '',
                        'count': len(results),
                        'results': results,
                    }
                    if errors:
                        # 前面失败的引擎（例如 DeepSeek 402/429），让用户知道已回退
                        payload['fallback_errors'] = errors
                    return self.response.json(200, payload)
                else:
                    errors.append(f'{name}: 0 条结果')
                    print(f'⚠️ [网络搜索] {name} 无结果')
            except Exception as e:
                errors.append(self._format_web_request_error(name, e, proxy_url if proxies else ''))
                print(f'⚠️ [网络搜索] {name} 失败: {e}')

        return self.response.json(200, {
            'ok': False,
            'error': f'所有搜索引擎都未返回结果。{" | ".join(errors)}'
        })

    # ============ 🌐 抓取网页正文 ============
    def handle_fetch_url(self, body):
        """抓取指定 URL 的文本/HTML，可选择提取正文（去除 script/style/导航）。"""
        url = (body.get('url') or '').strip()
        extract_text = body.get('extract_text', True)
        max_chars = min(int(body.get('max_chars', 8000)), 50000)

        if not url:
            return self.response.json(200, {'ok': False, 'error': 'url 不能为空'})
        if not (url.startswith('http://') or url.startswith('https://')):
            return self.response.json(200, {'ok': False, 'error': 'URL 必须以 http:// 或 https:// 开头'})

        proxies, proxy_url, proxy_error = self._web_proxy_config(body)
        if proxy_error:
            return self.response.json(200, {'ok': False, 'error': proxy_error})

        proxy_hint = proxy_url if proxies else 'off'
        print(f'🌐 [抓取] {url}  extract={extract_text}  proxy={proxy_hint}')

        try:
            import requests
        except ImportError:
            return self.response.json(200, {'ok': False, 'error': '后端缺少 requests 模块，请运行：pip install requests'})

        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                              '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            }
            resp = requests.get(url, headers=headers, timeout=15, allow_redirects=True, proxies=proxies)
            content_type = resp.headers.get('content-type', '')
            if not resp.encoding or resp.encoding.lower() == 'iso-8859-1':
                resp.encoding = resp.apparent_encoding or 'utf-8'
            raw = resp.text

            if not extract_text or 'text/html' not in content_type.lower():
                truncated = raw[:max_chars]
                self.response.json(200, {
                    'ok': True,
                    'url': resp.url,
                    'status': resp.status_code,
                    'content_type': content_type,
                    'length': len(raw),
                    'content': truncated,
                    'truncated': len(raw) > max_chars
                })
                return

            # —— 提取 HTML 正文 ——
            text = raw
            text = re.sub(r'<script\b[^>]*>.*?</script>', ' ', text, flags=re.S | re.I)
            text = re.sub(r'<style\b[^>]*>.*?</style>', ' ', text, flags=re.S | re.I)
            text = re.sub(r'<noscript\b[^>]*>.*?</noscript>', ' ', text, flags=re.S | re.I)
            title_m = re.search(r'<title[^>]*>(.*?)</title>', text, flags=re.S | re.I)
            title = unescape(re.sub(r'\s+', ' ', title_m.group(1)).strip()) if title_m else ''
            text = re.sub(r'</?(p|div|li|tr|h[1-6]|br|hr|article|section)[^>]*>', '\n', text, flags=re.I)
            text = re.sub(r'<[^>]+>', '', text)
            text = unescape(text)
            text = re.sub(r'[ \t\r\f\v]+', ' ', text)
            text = re.sub(r'\n\s*\n+', '\n\n', text).strip()

            truncated_text = text[:max_chars]
            self.response.json(200, {
                'ok': True,
                'url': resp.url,
                'status': resp.status_code,
                'title': title,
                'length': len(text),
                'content': truncated_text,
                'truncated': len(text) > max_chars
            })
        except Exception as e:
            self.response.json(200, {'ok': False, 'error': self._format_web_request_error('fetch_url', e, proxy_url if proxies else '')})
