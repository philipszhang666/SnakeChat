(function(global) {
  'use strict';

  const AgentApp = global.AgentApp;
  if (!AgentApp) throw new Error('AgentApp registry must load before chat-search.js');

  const StateModule = AgentApp.require('state');
  const SEARCH_SCOPE_ALL = 'all';
  const SEARCH_SCOPE_CURRENT = 'current';
  const CHAT_SEARCH_PREFS_KEY = 'aichat_chat_search_prefs_v1';
  const MAX_RESULTS = 500;
  const MAX_MESSAGE_TEXT = 50000;
  const SEARCH_OBJECTS = [
    { id: 'title', label: '标题' },
    { id: 'user', label: '用户消息' },
    { id: 'assistant', label: 'AI回答' },
    { id: 'tool_call', label: '工具调用' },
    { id: 'tool_result', label: '工具结果' },
    { id: 'system', label: '系统消息' },
    { id: 'attachment', label: '附件' }
  ];
  const DEFAULT_SEARCH_OBJECTS = SEARCH_OBJECTS.map(item => item.id);

  const searchState = {
    scope: SEARCH_SCOPE_ALL,
    query: '',
    fuzzyEnabled: false,
    exactWordEnabled: false,
    selectedObjects: [...DEFAULT_SEARCH_OBJECTS],
    results: [],
    activeIndex: -1,
    limitReached: false,
    modal: null,
    lastFocused: null
  };

  function searchPrefsStore() {
    const asyncStore = global.storage && typeof global.storage.get === 'function' && typeof global.storage.set === 'function'
      ? global.storage
      : null;
    const syncStore = global.localStorage || null;
    if (!asyncStore && !syncStore) return null;
    return {
      get(key) {
        const asyncValue = asyncStore ? asyncStore.get(key) : null;
        if (asyncValue != null) return asyncValue;
        return syncStore ? syncStore.getItem(key) : null;
      },
      set(key, value) {
        if (asyncStore) asyncStore.set(key, value);
        if (syncStore) syncStore.setItem(key, value);
        if (asyncStore && typeof asyncStore.flush === 'function') {
          Promise.resolve(asyncStore.flush()).catch(e => {
            console.warn('[chat-search] failed to flush preferences:', e);
          });
        }
      }
    };
  }

  function sanitizeSelectedObjects(value) {
    const valid = new Set(SEARCH_OBJECTS.map(item => item.id));
    const input = Array.isArray(value) ? value : DEFAULT_SEARCH_OBJECTS;
    const selected = input.filter(id => valid.has(id));
    return Array.from(new Set(selected));
  }

  function loadChatSearchPrefs() {
    const store = searchPrefsStore();
    if (!store) return;
    try {
      const raw = store.get(CHAT_SEARCH_PREFS_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw);
      if (!prefs || typeof prefs !== 'object') return;
      searchState.scope = validScope(prefs.scope);
      searchState.fuzzyEnabled = !!prefs.fuzzyEnabled;
      searchState.exactWordEnabled = !!prefs.exactWordEnabled;
      searchState.selectedObjects = sanitizeSelectedObjects(prefs.selectedObjects);
    } catch (e) {
      console.warn('[chat-search] failed to load preferences:', e);
    }
  }

  function saveChatSearchPrefs() {
    const store = searchPrefsStore();
    if (!store) return;
    try {
      store.set(CHAT_SEARCH_PREFS_KEY, JSON.stringify({
        scope: validScope(searchState.scope),
        fuzzyEnabled: !!searchState.fuzzyEnabled,
        exactWordEnabled: !!searchState.exactWordEnabled,
        selectedObjects: sanitizeSelectedObjects(searchState.selectedObjects)
      }));
    } catch (e) {
      console.warn('[chat-search] failed to save preferences:', e);
    }
  }

  loadChatSearchPrefs();

  function appState() {
    return StateModule.state;
  }

  function currentChat() {
    return StateModule.currentChat();
  }

  function chatById(id) {
    return StateModule.chatById(id);
  }

  function validScope(scope) {
    return scope === SEARCH_SCOPE_CURRENT ? SEARCH_SCOPE_CURRENT : SEARCH_SCOPE_ALL;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function hasWildcard(query) {
    return /[*?]/.test(String(query || ''));
  }

  function wildcardRegExp(query) {
    const pattern = String(query || '')
      .split('')
      .map(ch => {
        if (ch === '*') return '.*';
        if (ch === '?') return '.';
        return escapeRegExp(ch);
      })
      .join('');
    try {
      return new RegExp(pattern, 'i');
    } catch (e) {
      return null;
    }
  }

  function normalize(value) {
    return String(value == null ? '' : value).toLocaleLowerCase();
  }

  function roleLabel(role) {
    if (role === 'user') return '用户';
    if (role === 'assistant') return '助手';
    if (role === 'system') return '系统';
    if (role === 'tool') return '工具';
    return role || '消息';
  }

  function objectLabel(objectId) {
    const item = SEARCH_OBJECTS.find(option => option.id === objectId);
    return item ? item.label : roleLabel(objectId);
  }

  function displayChatTitle(chat) {
    if (!chat) return '未知对话';
    if (typeof global._chatDisplayTitle === 'function') {
      try {
        const title = global._chatDisplayTitle(chat);
        if (title) return title;
      } catch (e) {}
    }
    return chat.title || (chat.temporary ? '临时会话' : '新对话');
  }

  function pushText(parts, value) {
    if (value == null) return;
    if (typeof value === 'string') {
      if (value) parts.push(value);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => pushText(parts, item));
      return;
    }
    if (typeof value !== 'object') return;

    if (typeof value.text === 'string') pushText(parts, value.text);
    if (typeof value.content === 'string' || Array.isArray(value.content)) pushText(parts, value.content);
    if (typeof value.name === 'string') pushText(parts, value.name);
    if (typeof value.path === 'string') pushText(parts, value.path);
    if (typeof value.url === 'string') pushText(parts, value.url);

    if (!value.text && !value.content && !value.name && !value.path && !value.url) {
      try {
        parts.push(JSON.stringify(value));
      } catch (e) {}
    }
  }

  function truncateSearchText(value) {
    const text = String(value || '');
    return text.length > MAX_MESSAGE_TEXT ? text.slice(0, MAX_MESSAGE_TEXT) : text;
  }

  function messageContentText(message) {
    const parts = [];
    if (!message) return '';
    pushText(parts, message.content);
    pushText(parts, message.name);
    return truncateSearchText(parts.filter(Boolean).join('\n'));
  }

  function toolCallSearchText(message) {
    const parts = [];
    if (!message) return '';
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach(call => {
        if (!call) return;
        pushText(parts, call.function && call.function.name);
        pushText(parts, call.function && call.function.arguments);
        pushText(parts, call.name);
        pushText(parts, call.arguments);
      });
    }
    return truncateSearchText(parts.filter(Boolean).join('\n'));
  }

  function attachmentSearchText(message) {
    const parts = [];
    if (!message) return '';
    if (Array.isArray(message.attachments)) {
      message.attachments.forEach(att => {
        pushText(parts, att && att.name);
        pushText(parts, att && att.path);
        pushText(parts, att && att.text);
      });
    }
    return truncateSearchText(parts.filter(Boolean).join('\n'));
  }

  function messageSearchText(message) {
    return truncateSearchText([
      messageContentText(message),
      toolCallSearchText(message),
      attachmentSearchText(message)
    ].filter(Boolean).join('\n'));
  }

  function selectedObjectSet() {
    return new Set(searchState.selectedObjects);
  }

  function hasSelectedSearchObject() {
    return searchState.selectedObjects.length > 0;
  }

  function fuzzyTextMatch(text, query) {
    const rawNeedle = String(query || '').replace(/\s+/g, '');
    if (!rawNeedle) return null;
    const haystack = normalize(text);
    const needle = normalize(rawNeedle);
    let pos = 0;
    let start = -1;
    let end = -1;
    for (const ch of needle) {
      const found = haystack.indexOf(ch, pos);
      if (found < 0) return null;
      if (start < 0) start = found;
      end = found + 1;
      pos = found + 1;
    }
    return start >= 0 ? { index: start, length: Math.max(1, end - start), mode: 'fuzzy' } : null;
  }

  function tokenizeWords(text) {
    const tokens = [];
    const source = String(text || '');
    const regex = /[A-Za-z0-9_]+|[\u3400-\u9FFF]+/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
      tokens.push({ text: match[0], index: match.index, length: match[0].length });
    }
    return tokens;
  }

  function queryWordTerms(query) {
    const raw = String(query || '').trim();
    if (!raw) return [];
    if (hasWildcard(raw)) return raw.split(/\s+/).filter(Boolean);
    const tokens = tokenizeWords(raw);
    return tokens.length ? tokens.map(token => token.text) : raw.split(/\s+/).filter(Boolean);
  }

  function exactWordTextMatch(text, query) {
    const tokens = tokenizeWords(text);
    const terms = queryWordTerms(query);
    if (!tokens.length || !terms.length) return null;

    let firstMatch = null;
    for (const term of terms) {
      const normalizedTerm = normalize(term);
      const termRegex = hasWildcard(term) ? wildcardRegExp(term) : null;
      const token = tokens.find(item => {
        if (termRegex) {
          const match = termRegex.exec(item.text);
          return !!(match && match.index === 0 && match[0].length === item.text.length);
        }
        return normalize(item.text) === normalizedTerm;
      });
      if (!token) return null;
      if (!firstMatch || token.index < firstMatch.index) firstMatch = token;
    }
    return firstMatch ? { index: firstMatch.index, length: firstMatch.length, mode: 'exact_word' } : null;
  }

  function findTextMatch(text, query) {
    const rawText = String(text || '');
    const rawQuery = String(query || '').trim();
    if (!rawText || !rawQuery) return null;

    if (searchState.exactWordEnabled) return exactWordTextMatch(rawText, rawQuery);

    if (hasWildcard(rawQuery)) {
      const regex = wildcardRegExp(rawQuery);
      const match = regex && regex.exec(rawText);
      if (!match) return null;
      return { index: match.index, length: Math.max(1, match[0].length), mode: 'wildcard' };
    }

    const index = normalize(rawText).indexOf(normalize(rawQuery));
    if (index >= 0) return { index, length: rawQuery.length, mode: 'exact' };

    return searchState.fuzzyEnabled ? fuzzyTextMatch(rawText, rawQuery) : null;
  }

  function textMatches(text, query) {
    return !!findTextMatch(text, query);
  }

  function pushResult(results, result) {
    results.push(result);
    return results.length >= MAX_RESULTS;
  }

  function searchableChats(scope) {
    const state = appState();
    if (scope === SEARCH_SCOPE_CURRENT) {
      const chat = currentChat();
      return chat ? [chat] : [];
    }

    const chats = [];
    if (state.temporaryChat) chats.push(state.temporaryChat);
    (state.chats || []).forEach(chat => {
      if (chat) chats.push(chat);
    });
    return chats;
  }

  function makeSnippet(text, query) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    const match = findTextMatch(raw, query);
    const hit = match ? match.index : -1;
    const start = hit > 72 ? hit - 72 : 0;
    const matchLength = match ? Math.max(1, match.length || String(query || '').length) : 0;
    const end = hit >= 0 ? Math.min(raw.length, hit + matchLength + 96) : Math.min(raw.length, 168);
    const body = raw.slice(start, end);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < raw.length ? '...' : '';
    if (!match) return escapeHtml(prefix + body + suffix);

    if (match.mode === 'wildcard') {
      const pattern = wildcardRegExp(query);
      if (pattern) {
        let last = 0;
        let html = '';
        body.replace(pattern, (matched, offset) => {
          html += escapeHtml(body.slice(last, offset));
          html += '<mark>' + escapeHtml(matched) + '</mark>';
          last = offset + matched.length;
          return matched;
        });
        html += escapeHtml(body.slice(last));
        return escapeHtml(prefix) + html + escapeHtml(suffix);
      }
    }

    if (match.mode === 'fuzzy' || match.mode === 'exact_word') {
      const localStart = Math.max(0, hit - start);
      const localEnd = Math.min(body.length, localStart + matchLength);
      return escapeHtml(prefix)
        + escapeHtml(body.slice(0, localStart))
        + '<mark>' + escapeHtml(body.slice(localStart, localEnd)) + '</mark>'
        + escapeHtml(body.slice(localEnd))
        + escapeHtml(suffix);
    }

    const pattern = new RegExp(escapeRegExp(query), 'ig');
    let last = 0;
    let html = '';
    body.replace(pattern, (matched, offset) => {
      html += escapeHtml(body.slice(last, offset));
      html += '<mark>' + escapeHtml(matched) + '</mark>';
      last = offset + matched.length;
      return matched;
    });
    html += escapeHtml(body.slice(last));
    return escapeHtml(prefix) + html + escapeHtml(suffix);
  }

  function buildResults(query, scope) {
    const results = [];
    const objects = selectedObjectSet();
    let limitReached = false;

    for (const chat of searchableChats(scope)) {
      const messages = Array.isArray(chat.messages) ? chat.messages : [];
      const title = displayChatTitle(chat);

      if (objects.has('title') && textMatches(title, query)) {
        limitReached = pushResult(results, {
          chatId: chat.id,
          chatTitle: title,
          msgIdx: null,
          object: 'title',
          snippet: makeSnippet(title, query)
        });
        if (limitReached) break;
      }

      for (let idx = 0; idx < messages.length; idx += 1) {
        const message = messages[idx];
        if (!message || message._hiddenFromUI) continue;

        const contentObject = message.role === 'user'
          ? 'user'
          : (message.role === 'assistant' ? 'assistant' : (message.role === 'system' ? 'system' : null));
        if (contentObject && objects.has(contentObject)) {
          const text = messageContentText(message);
          if (textMatches(text, query)) {
            limitReached = pushResult(results, {
              chatId: chat.id,
              chatTitle: title,
              msgIdx: idx,
              object: contentObject,
              role: message.role || 'message',
              snippet: makeSnippet(text, query)
            });
            if (limitReached) break;
          }
        }

        if (objects.has('tool_call')) {
          const text = toolCallSearchText(message);
          if (textMatches(text, query)) {
            limitReached = pushResult(results, {
              chatId: chat.id,
              chatTitle: title,
              msgIdx: idx,
              object: 'tool_call',
              role: message.role || 'message',
              snippet: makeSnippet(text, query)
            });
            if (limitReached) break;
          }
        }

        if (objects.has('tool_result') && message.role === 'tool') {
          const text = messageContentText(message);
          if (textMatches(text, query)) {
            limitReached = pushResult(results, {
              chatId: chat.id,
              chatTitle: title,
              msgIdx: idx,
              object: 'tool_result',
              role: message.role || 'tool',
              snippet: makeSnippet(text, query)
            });
            if (limitReached) break;
          }
        }

        if (objects.has('attachment')) {
          const text = attachmentSearchText(message);
          if (textMatches(text, query)) {
            limitReached = pushResult(results, {
              chatId: chat.id,
              chatTitle: title,
              msgIdx: idx,
              object: 'attachment',
              role: message.role || 'message',
              snippet: makeSnippet(text, query)
            });
            if (limitReached) break;
          }
        }
      }
      if (limitReached) break;
    }

    return { results, limitReached };
  }

  function ensureChatSearchModal() {
    if (searchState.modal && document.body.contains(searchState.modal)) return searchState.modal;

    const mask = document.createElement('div');
    mask.className = 'modal-mask chat-search-mask';
    mask.id = 'chatSearchMask';
    mask.innerHTML = `
      <div class="modal chat-search-modal" role="dialog" aria-modal="true" aria-labelledby="chatSearchTitle">
        <div class="chat-search-titlebar">
          <div>
            <h2 id="chatSearchTitle">搜索对话内容</h2>
            <p id="chatSearchScopeHint">在全部对话中搜索消息、工具调用和附件名</p>
          </div>
          <button class="modal-close" type="button" data-action="closeChatSearch" title="关闭" aria-label="关闭">×</button>
        </div>
        <div class="chat-search-toolbar">
          <label class="chat-search-input-wrap" for="chatSearchInput">
            <img src="icon/搜索_search.png" alt="">
            <input id="chatSearchInput" type="search" autocomplete="off" placeholder="输入关键词，支持 * 和 ?" aria-label="搜索关键词">
            <button class="chat-search-clear" id="chatSearchClearBtn" type="button" data-action="clearChatSearchInput" title="清空" aria-label="清空" hidden>×</button>
          </label>
          <div class="chat-search-scope" role="tablist" aria-label="搜索范围">
            <button type="button" data-chat-search-scope="all" role="tab">全部对话</button>
            <button type="button" data-chat-search-scope="current" role="tab">当前对话</button>
          </div>
          <label class="chat-search-exact-toggle" title="开启后查询词必须匹配完整单词，优先于模糊匹配">
            <input id="chatSearchExactToggle" type="checkbox">
            <span>精确</span>
          </label>
          <label class="chat-search-fuzzy-toggle" title="开启后允许关键词字符非连续匹配">
            <input id="chatSearchFuzzyToggle" type="checkbox">
            <span>模糊</span>
          </label>
        </div>
        <div class="chat-search-object-row" aria-label="搜索对象">
          <span>搜索对象</span>
          <div class="chat-search-object-options">
            ${SEARCH_OBJECTS.map(item => `
              <label class="chat-search-object-option">
                <input type="checkbox" data-chat-search-object="${escapeHtml(item.id)}" checked>
                <span>${escapeHtml(item.label)}</span>
              </label>
            `).join('')}
          </div>
        </div>
        <div class="chat-search-results" id="chatSearchResults" role="listbox" aria-label="搜索结果"></div>
        <div class="chat-search-footer">
          <span id="chatSearchCount">输入关键词开始搜索</span>
          <div class="chat-search-nav">
            <button type="button" data-action="chatSearchPrev" title="上一条" aria-label="上一条">↑</button>
            <button type="button" data-action="chatSearchNext" title="下一条" aria-label="下一条">↓</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(mask);
    searchState.modal = mask;

    const input = mask.querySelector('#chatSearchInput');
    const results = mask.querySelector('#chatSearchResults');

    input.addEventListener('input', () => {
      searchState.query = input.value.trim();
      runChatSearch();
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeChatSearch();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) chatSearchPrev(event);
        else chatSearchNext(event);
      }
    });

    mask.querySelectorAll('[data-chat-search-scope]').forEach(button => {
      button.addEventListener('click', () => setChatSearchScope(button.dataset.chatSearchScope));
    });

    const fuzzyToggle = mask.querySelector('#chatSearchFuzzyToggle');
    if (fuzzyToggle) {
      fuzzyToggle.addEventListener('change', () => {
        searchState.fuzzyEnabled = !!fuzzyToggle.checked;
        saveChatSearchPrefs();
        runChatSearch();
      });
    }
    const exactToggle = mask.querySelector('#chatSearchExactToggle');
    if (exactToggle) {
      exactToggle.addEventListener('change', () => {
        searchState.exactWordEnabled = !!exactToggle.checked;
        saveChatSearchPrefs();
        runChatSearch();
      });
    }

    mask.querySelectorAll('[data-chat-search-object]').forEach(input => {
      input.addEventListener('change', () => {
        const next = Array.from(mask.querySelectorAll('[data-chat-search-object]:checked'))
          .map(el => el.dataset.chatSearchObject)
          .filter(Boolean);
        searchState.selectedObjects = sanitizeSelectedObjects(next);
        saveChatSearchPrefs();
        runChatSearch();
      });
    });

    results.addEventListener('click', event => {
      const item = event.target && event.target.closest ? event.target.closest('.chat-search-result') : null;
      if (!item) return;
      const index = Number(item.dataset.index);
      if (Number.isFinite(index)) goToChatSearchResult(index, { close: true });
    });
    results.addEventListener('keydown', event => {
      const item = event.target && event.target.closest ? event.target.closest('.chat-search-result') : null;
      if (!item) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const index = Number(item.dataset.index);
      if (Number.isFinite(index)) goToChatSearchResult(index, { close: true });
    });

    mask.addEventListener('click', event => {
      if (event.target === mask) closeChatSearch();
    });

    return mask;
  }

  function updateScopeButtons() {
    const mask = ensureChatSearchModal();
    mask.querySelectorAll('[data-chat-search-scope]').forEach(button => {
      const active = button.dataset.chatSearchScope === searchState.scope;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    });
    const hint = mask.querySelector('#chatSearchScopeHint');
    if (hint) {
      hint.textContent = searchState.scope === SEARCH_SCOPE_CURRENT
        ? '只在当前对话中搜索消息、工具调用和附件名'
        : '在全部对话中搜索消息、工具调用和附件名';
    }
  }

  function syncSearchObjectInputs() {
    const mask = ensureChatSearchModal();
    const selected = selectedObjectSet();
    mask.querySelectorAll('[data-chat-search-object]').forEach(input => {
      input.checked = selected.has(input.dataset.chatSearchObject);
    });
  }

  function syncSearchModeInputs() {
    const mask = ensureChatSearchModal();
    const fuzzyToggle = mask.querySelector('#chatSearchFuzzyToggle');
    if (fuzzyToggle) fuzzyToggle.checked = !!searchState.fuzzyEnabled;
    const exactToggle = mask.querySelector('#chatSearchExactToggle');
    if (exactToggle) exactToggle.checked = !!searchState.exactWordEnabled;
  }

  function renderChatSearchResults() {
    const mask = ensureChatSearchModal();
    const list = mask.querySelector('#chatSearchResults');
    const count = mask.querySelector('#chatSearchCount');
    const clear = mask.querySelector('#chatSearchClearBtn');
    const navButtons = mask.querySelectorAll('.chat-search-nav button');

    if (clear) clear.hidden = !searchState.query;
    navButtons.forEach(button => { button.disabled = searchState.results.length === 0; });

    if (!searchState.query) {
      list.innerHTML = '<div class="chat-search-empty">输入关键词后开始搜索。</div>';
      if (count) count.textContent = '输入关键词开始搜索';
      return;
    }

    if (!hasSelectedSearchObject()) {
      list.innerHTML = '<div class="chat-search-empty">请选择至少一个搜索对象。</div>';
      if (count) count.textContent = '未选择搜索对象';
      return;
    }

    if (!searchState.results.length) {
      list.innerHTML = '<div class="chat-search-empty">没有找到匹配内容。</div>';
      if (count) count.textContent = '0 条结果';
      return;
    }

    list.innerHTML = searchState.results.map((result, index) => `
      <button class="chat-search-result ${index === searchState.activeIndex ? 'active' : ''}" type="button" data-index="${index}" role="option" aria-selected="${index === searchState.activeIndex ? 'true' : 'false'}">
        <span class="chat-search-result-head">
          <span class="chat-search-result-title">${escapeHtml(result.chatTitle)}</span>
          <span class="chat-search-result-meta">${escapeHtml(result.msgIdx == null ? objectLabel(result.object) : `${objectLabel(result.object)} · #${result.msgIdx + 1}`)}</span>
        </span>
        <span class="chat-search-result-snippet">${result.snippet}</span>
      </button>
    `).join('');

    if (count) {
      const activeText = searchState.activeIndex >= 0 ? `${searchState.activeIndex + 1} / ` : '';
      count.textContent = `${activeText}${searchState.results.length} 条结果${searchState.limitReached ? '，已显示前 500 条' : ''}`;
    }

    const active = list.querySelector('.chat-search-result.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function runChatSearch() {
    const query = searchState.query.trim();
    if (!query) {
      searchState.results = [];
      searchState.activeIndex = -1;
      searchState.limitReached = false;
      renderChatSearchResults();
      refreshChatSearchHighlights();
      return;
    }

    const built = buildResults(query, searchState.scope);
    searchState.results = built.results;
    searchState.limitReached = built.limitReached;
    searchState.activeIndex = built.results.length ? 0 : -1;
    renderChatSearchResults();
    refreshChatSearchHighlights();
  }

  function setChatSearchScope(scope) {
    searchState.scope = validScope(scope);
    saveChatSearchPrefs();
    updateScopeButtons();
    runChatSearch();
  }

  function openChatSearch(scope) {
    const mask = ensureChatSearchModal();
    searchState.lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (scope) {
      searchState.scope = validScope(scope);
      saveChatSearchPrefs();
    } else {
      searchState.scope = validScope(searchState.scope);
    }
    updateScopeButtons();
    syncSearchObjectInputs();
    syncSearchModeInputs();
    mask.classList.add('show');
    const input = mask.querySelector('#chatSearchInput');
    if (input) {
      input.value = searchState.query;
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    }
    runChatSearch();
  }

  function openGlobalChatSearch(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    openChatSearch(SEARCH_SCOPE_ALL);
  }

  function openCurrentChatSearch(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    openChatSearch(SEARCH_SCOPE_CURRENT);
  }

  function openSavedChatSearch(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    openChatSearch();
  }

  function closeChatSearch(options) {
    const keepHighlight = !!(options && options.keepHighlight === true);
    const mask = ensureChatSearchModal();
    mask.classList.remove('show');
    if (!keepHighlight) {
      searchState.activeIndex = -1;
      refreshChatSearchHighlights();
    }
    if (searchState.lastFocused && typeof searchState.lastFocused.focus === 'function') {
      try { searchState.lastFocused.focus(); } catch (e) {}
    }
  }

  function clearChatSearchInput(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const mask = ensureChatSearchModal();
    const input = mask.querySelector('#chatSearchInput');
    searchState.query = '';
    if (input) {
      input.value = '';
      input.focus();
    }
    runChatSearch();
  }

  function resultAt(index) {
    if (!searchState.results.length) return null;
    const normalizedIndex = ((index % searchState.results.length) + searchState.results.length) % searchState.results.length;
    return { index: normalizedIndex, result: searchState.results[normalizedIndex] };
  }

  function switchToResultChat(result) {
    const chat = currentChat();
    if (chat && chat.id === result.chatId) return;
    const chatModule = AgentApp.optional('chat');
    if (chatModule && typeof chatModule.switchChat === 'function') {
      chatModule.switchChat(result.chatId);
      return;
    }
    if (typeof global.switchChat === 'function') global.switchChat(result.chatId);
  }

  function focusResultMessage(result) {
    refreshChatSearchHighlights();
    requestAnimationFrame(() => {
      const node = document.querySelector(`#messagesInner .message[data-idx="${result.msgIdx}"]`);
      if (!node) return;
      const scroller = document.getElementById('messages');
      if (scroller) {
        const nodeRect = node.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const centeredTop = nodeRect.top - scrollerRect.top + scroller.scrollTop - Math.max(20, (scroller.clientHeight - node.offsetHeight) / 2);
        scroller.scrollTo({ top: Math.max(0, centeredTop), behavior: 'smooth' });
      } else {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      node.classList.add('dialog-jump-highlight');
      setTimeout(() => node.classList.remove('dialog-jump-highlight'), 1600);
    });
  }

  function goToChatSearchResult(index, options = {}) {
    const hit = resultAt(index);
    if (!hit) return false;

    searchState.activeIndex = hit.index;
    renderChatSearchResults();
    switchToResultChat(hit.result);
    requestAnimationFrame(() => focusResultMessage(hit.result));

    if (options.close) closeChatSearch();
    return true;
  }

  function chatSearchNext(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (!searchState.results.length) return false;
    const next = searchState.activeIndex < 0 ? 0 : searchState.activeIndex + 1;
    return goToChatSearchResult(next, { close: false });
  }

  function chatSearchPrev(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (!searchState.results.length) return false;
    const prev = searchState.activeIndex < 0 ? searchState.results.length - 1 : searchState.activeIndex - 1;
    return goToChatSearchResult(prev, { close: false });
  }

  function refreshChatSearchHighlights() {
    document.querySelectorAll('#messagesInner .message.chat-search-match, #messagesInner .message.chat-search-active')
      .forEach(node => {
        node.classList.remove('chat-search-match', 'chat-search-active');
      });
  }

  function shouldIgnoreShortcutTarget(target) {
    if (!target || !(target instanceof HTMLElement)) return false;
    if (target.closest('#chatSearchMask')) return false;
    if (target.closest('input, textarea, select, [contenteditable="true"], .CodeMirror')) return true;
    if (document.querySelector('.file-editor-mask.show, .pdf-viewer-mask.show, .image-viewer-mask.show, .media-viewer-mask.show')) return true;
    return false;
  }

  function handleShortcut(event) {
    if (!event || event.defaultPrevented) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (String(event.key || '').toLowerCase() !== 'f') return;
    if (shouldIgnoreShortcutTarget(event.target)) return;

    event.preventDefault();
    if (event.shiftKey) openGlobalChatSearch(event);
    else openCurrentChatSearch(event);
  }

  document.addEventListener('keydown', handleShortcut, true);

  global.openGlobalChatSearch = openGlobalChatSearch;
  global.openCurrentChatSearch = openCurrentChatSearch;
  global.openSavedChatSearch = openSavedChatSearch;
  global.openChatSearch = openChatSearch;
  global.closeChatSearch = closeChatSearch;
  global.clearChatSearchInput = clearChatSearchInput;
  global.chatSearchNext = chatSearchNext;
  global.chatSearchPrev = chatSearchPrev;
  global.refreshChatSearchHighlights = refreshChatSearchHighlights;

  AgentApp.define('chatSearch', {
    openGlobalChatSearch,
    openCurrentChatSearch,
    openSavedChatSearch,
    openChatSearch,
    closeChatSearch,
    clearChatSearchInput,
    chatSearchNext,
    chatSearchPrev,
    runChatSearch,
    refreshChatSearchHighlights,
    _savePrefs: saveChatSearchPrefs,
    _loadPrefs: loadChatSearchPrefs,
    _prefsKey: CHAT_SEARCH_PREFS_KEY,
    _state: searchState,
    _messageSearchText: messageSearchText,
    _buildResults: buildResults
  });
})(window);
