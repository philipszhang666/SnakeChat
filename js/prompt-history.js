(function(global) {
  'use strict';

  const STORAGE_KEY = 'aichat_prompt_history_v1';
  const MAX_HISTORY = 50;
  const MAX_VISIBLE = 5;

  const state = {
    input: null,
    list: null,
    matches: [],
    activeIndex: -1,
    applying: false,
    initialized: false
  };

  function storageGet(key) {
    try {
      if (global.storage && typeof global.storage.get === 'function') return global.storage.get(key);
      if (global.localStorage) return global.localStorage.getItem(key);
    } catch (e) {}
    return null;
  }

  function storageSet(key, value) {
    try {
      if (global.storage && typeof global.storage.set === 'function') {
        global.storage.set(key, value);
        return;
      }
      if (global.localStorage) global.localStorage.setItem(key, value);
    } catch (e) {
      console.warn('[prompt-history] save failed:', e);
    }
  }

  function normalizeEntry(item) {
    if (typeof item === 'string') {
      const text = item.trim();
      return text ? { text, usedAt: 0 } : null;
    }
    if (!item || typeof item !== 'object') return null;
    const text = String(item.text || '').trim();
    if (!text) return null;
    return { text, usedAt: Number(item.usedAt) || 0 };
  }

  function readHistory() {
    const raw = storageGet(STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const seen = new Set();
      const result = [];
      for (const item of parsed) {
        const entry = normalizeEntry(item);
        if (!entry || seen.has(entry.text)) continue;
        seen.add(entry.text);
        result.push(entry);
        if (result.length >= MAX_HISTORY) break;
      }
      return result;
    } catch (e) {
      return [];
    }
  }

  function writeHistory(history) {
    const normalized = [];
    const seen = new Set();
    for (const item of history || []) {
      const entry = normalizeEntry(item);
      if (!entry || seen.has(entry.text)) continue;
      seen.add(entry.text);
      normalized.push(entry);
      if (normalized.length >= MAX_HISTORY) break;
    }
    storageSet(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function normForMatch(value) {
    return String(value || '').trim().toLocaleLowerCase();
  }

  function findMatches(queryValue) {
    const query = normForMatch(queryValue);
    if (!query) return [];

    const prefixMatches = [];
    const containsMatches = [];
    for (const entry of readHistory()) {
      const text = String(entry.text || '');
      const haystack = normForMatch(text);
      if (!haystack) continue;
      if (haystack.startsWith(query)) {
        prefixMatches.push({ ...entry, matchType: 'prefix' });
      } else if (haystack.includes(query)) {
        containsMatches.push({ ...entry, matchType: 'contains' });
      }
    }

    const selected = prefixMatches.slice(0, MAX_VISIBLE);
    if (selected.length < MAX_VISIBLE) {
      selected.push(...containsMatches.slice(0, MAX_VISIBLE - selected.length));
    }
    return selected;
  }

  function hidePromptSuggestions() {
    state.matches = [];
    state.activeIndex = -1;
    if (state.list) {
      state.list.hidden = true;
      state.list.innerHTML = '';
    }
    if (state.input) {
      state.input.removeAttribute('aria-activedescendant');
      state.input.setAttribute('aria-expanded', 'false');
    }
  }

  function renderMatches(matches) {
    if (!state.list || !state.input) return;
    state.list.innerHTML = '';
    state.matches = matches || [];
    state.activeIndex = -1;

    if (!state.matches.length) {
      hidePromptSuggestions();
      return;
    }

    state.matches.forEach((entry, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'prompt-suggestion';
      button.id = 'promptSuggestion_' + index;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', 'false');
      button.dataset.index = String(index);
      button.title = entry.text;

      const text = document.createElement('span');
      text.className = 'prompt-suggestion-text';
      text.textContent = entry.text;
      button.appendChild(text);

      button.addEventListener('mousedown', event => {
        event.preventDefault();
      });
      button.addEventListener('click', () => {
        applyPromptSuggestion(index);
      });

      state.list.appendChild(button);
    });

    state.list.hidden = false;
    state.input.setAttribute('aria-expanded', 'true');
    state.input.removeAttribute('aria-activedescendant');
  }

  function updatePromptHistorySuggestions(value) {
    if (!state.input || !state.list) return;
    renderMatches(findMatches(value == null ? state.input.value : value));
  }

  function setActiveIndex(index) {
    if (!state.list || !state.matches.length) return;
    const total = state.matches.length;
    state.activeIndex = ((index % total) + total) % total;
    const options = Array.from(state.list.querySelectorAll('.prompt-suggestion'));
    options.forEach((option, idx) => {
      const active = idx === state.activeIndex;
      option.classList.toggle('is-active', active);
      option.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active) {
        state.input.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function applyPromptSuggestion(index) {
    if (!state.input || !state.matches.length) return false;
    const targetIndex = Number.isInteger(index) && index >= 0 ? index : 0;
    const entry = state.matches[targetIndex];
    if (!entry) return false;

    state.applying = true;
    state.input.value = entry.text;
    state.input.focus();
    if (typeof state.input.setSelectionRange === 'function') {
      const pos = state.input.value.length;
      state.input.setSelectionRange(pos, pos);
    }
    state.input.dispatchEvent(new Event('input', { bubbles: true }));
    hidePromptSuggestions();
    return true;
  }

  function handlePromptHistoryKeydown(event) {
    if (!state.input || !state.list || state.list.hidden || event.isComposing) return false;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(state.activeIndex < 0 ? 0 : state.activeIndex + 1);
      return true;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(state.activeIndex < 0 ? state.matches.length - 1 : state.activeIndex - 1);
      return true;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      if (state.activeIndex < 0) return false;
      event.preventDefault();
      applyPromptSuggestion(state.activeIndex);
      return true;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      hidePromptSuggestions();
      return true;
    }

    return false;
  }

  function recordPromptHistory(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return readHistory();

    const now = Date.now();
    const next = [{ text, usedAt: now }, ...readHistory().filter(entry => entry.text !== text)];
    const written = writeHistory(next);
    if (state.input && document.activeElement === state.input) {
      updatePromptHistorySuggestions(state.input.value);
    }
    return written;
  }

  function initPromptAutocomplete(input) {
    if (!input || state.initialized) return;
    const list = document.getElementById('promptSuggestions');
    if (!list) return;

    state.input = input;
    state.list = list;
    state.initialized = true;

    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'promptSuggestions');
    input.setAttribute('aria-expanded', 'false');

    input.addEventListener('input', () => {
      if (state.applying) {
        state.applying = false;
        hidePromptSuggestions();
        return;
      }
      updatePromptHistorySuggestions(input.value);
    });
    input.addEventListener('focus', () => {
      updatePromptHistorySuggestions(input.value);
    });
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement !== input) hidePromptSuggestions();
      }, 120);
    });
    document.addEventListener('mousedown', event => {
      const inner = document.getElementById('inputInner');
      if (inner && inner.contains(event.target)) return;
      hidePromptSuggestions();
    });
  }

  const api = {
    initPromptAutocomplete,
    recordPromptHistory,
    updatePromptHistorySuggestions,
    hidePromptSuggestions,
    handlePromptHistoryKeydown,
    _readHistory: readHistory,
    _findMatches: findMatches
  };

  global.initPromptAutocomplete = initPromptAutocomplete;
  global.recordPromptHistory = recordPromptHistory;
  global.updatePromptHistorySuggestions = updatePromptHistorySuggestions;
  global.hidePromptSuggestions = hidePromptSuggestions;
  global.handlePromptHistoryKeydown = handlePromptHistoryKeydown;

  if (global.AgentApp && typeof global.AgentApp.define === 'function') {
    global.AgentApp.define('promptHistory', api);
  }
})(window);
