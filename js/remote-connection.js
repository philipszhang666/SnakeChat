// ============ 远程连接：SSH 隧道 + 远程 Agent 后端 ============
const REMOTE_CONNECTION_KEY = 'snake_remote_connection_v1';
const RemoteConnectionUiService = window.AgentApp.require('uiService');
const REMOTE_CONTROLLER = {
  serverUrl: (typeof TERMINAL_CONFIG !== 'undefined' && TERMINAL_CONFIG.serverUrl) ? TERMINAL_CONFIG.serverUrl : 'http://localhost:8765'
};
const REMOTE_DIR_PICKER = {
  currentPath: '~',
  parentPath: '~'
};
const REMOTE_HEARTBEAT_DEFAULT_SECONDS = 300;
let remoteAutoReconnectAttempted = false;
let REMOTE_CONNECTIONS_CACHE = [];
let REMOTE_SELECTED_CONNECTION = null;

function remoteDefaultConfig() {
  return {
    sshCommand: 'ssh user@example.com',
    remoteWorkspace: '~/',
    remoteAgentPort: 8765,
    localPort: 18765,
    heartbeatTimeout: REMOTE_HEARTBEAT_DEFAULT_SECONDS,
    installDeps: true,
    encryptedPassword: '',
    autoReconnect: false,
    lastConnectedAt: 0,
    lastServerUrl: '',
    connectionId: '',
    remoteGitProxyUrl: '',
    profiles: {}
  };
}

function remoteProfileKey(sshCommand) {
  return String(sshCommand || '').replace(/\s+/g, ' ').trim();
}

function normalizeRemoteProfiles(profiles) {
  const out = {};
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return out;
  Object.keys(profiles).forEach(key => {
    const profile = profiles[key];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return;
    const sshCommand = remoteProfileKey(profile.sshCommand || key);
    if (!sshCommand) return;
    out[sshCommand] = {
      sshCommand,
      remoteWorkspace: profile.remoteWorkspace || '~/',
      remoteAgentPort: parseInt(profile.remoteAgentPort, 10) || 8765,
      localPort: parseInt(profile.localPort, 10) || 18765,
      heartbeatTimeout: Math.max(120, parseInt(profile.heartbeatTimeout, 10) || REMOTE_HEARTBEAT_DEFAULT_SECONDS),
      installDeps: profile.installDeps !== false,
      encryptedPassword: profile.encryptedPassword || '',
      autoReconnect: !!profile.autoReconnect,
      lastConnectedAt: Number(profile.lastConnectedAt) || 0,
      lastServerUrl: profile.lastServerUrl || '',
      connectionId: profile.connectionId || profile.connection_id || '',
      remoteGitProxyUrl: profile.remoteGitProxyUrl || profile.reverse_git_proxy_url || '',
      updatedAt: Number(profile.updatedAt) || Number(profile.lastConnectedAt) || 0
    };
  });
  return out;
}

function normalizeRemoteConnectionConfig(raw = {}) {
  const rawConfig = raw || {};
  const cfg = { ...remoteDefaultConfig(), ...rawConfig };
  cfg.profiles = normalizeRemoteProfiles(cfg.profiles);
  const sshCommand = remoteProfileKey(cfg.sshCommand);
  const hasSavedSshCommand = Object.prototype.hasOwnProperty.call(rawConfig, 'sshCommand') && !!remoteProfileKey(rawConfig.sshCommand);
  if (sshCommand && (hasSavedSshCommand || !!cfg.profiles[sshCommand])) {
    cfg.sshCommand = sshCommand;
    cfg.profiles[sshCommand] = {
      ...(cfg.profiles[sshCommand] || {}),
      sshCommand,
      remoteWorkspace: cfg.remoteWorkspace || (cfg.profiles[sshCommand] && cfg.profiles[sshCommand].remoteWorkspace) || '~/',
      remoteAgentPort: parseInt(cfg.remoteAgentPort, 10) || 8765,
      localPort: parseInt(cfg.localPort, 10) || 18765,
      heartbeatTimeout: Math.max(120, parseInt(cfg.heartbeatTimeout, 10) || REMOTE_HEARTBEAT_DEFAULT_SECONDS),
      installDeps: cfg.installDeps !== false,
      encryptedPassword: cfg.encryptedPassword || (cfg.profiles[sshCommand] && cfg.profiles[sshCommand].encryptedPassword) || '',
      autoReconnect: !!cfg.autoReconnect,
      lastConnectedAt: Number(cfg.lastConnectedAt) || 0,
      lastServerUrl: cfg.lastServerUrl || '',
      connectionId: cfg.connectionId || cfg.connection_id || '',
      remoteGitProxyUrl: cfg.remoteGitProxyUrl || cfg.reverse_git_proxy_url || '',
      updatedAt: Date.now()
    };
  }
  return cfg;
}

function remoteProfileForCommand(cfg, sshCommand) {
  const key = remoteProfileKey(sshCommand);
  if (!key || !cfg || !cfg.profiles) return null;
  return cfg.profiles[key] || null;
}

function upsertRemoteProfile(cfg, sshCommand, patch = {}) {
  const key = remoteProfileKey(sshCommand || (cfg && cfg.sshCommand));
  if (!key || !cfg) return cfg;
  const profiles = { ...(cfg.profiles || {}) };
  profiles[key] = {
    ...(profiles[key] || {}),
    sshCommand: key,
    ...patch,
    updatedAt: Date.now()
  };
  cfg.profiles = profiles;
  return cfg;
}

async function remoteCryptoKey() {
  const raw = `${location.origin || 'file://snake'}::snake-remote-connection`;
  const bytes = new TextEncoder().encode(raw.padEnd(32, '#').slice(0, 32));
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function remoteEncryptPassword(password) {
  if (!password) return '';
  if (!window.crypto || !crypto.subtle) return btoa(unescape(encodeURIComponent(password)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await remoteCryptoKey();
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(password));
  const all = new Uint8Array(iv.length + enc.byteLength);
  all.set(iv, 0);
  all.set(new Uint8Array(enc), iv.length);
  return 'aesgcm:' + btoa(String.fromCharCode(...all));
}

async function remoteDecryptPassword(cipher) {
  if (!cipher) return '';
  try {
    if (!cipher.startsWith('aesgcm:')) return decodeURIComponent(escape(atob(cipher)));
    const bin = atob(cipher.slice(7));
    const all = Uint8Array.from(bin, c => c.charCodeAt(0));
    const iv = all.slice(0, 12);
    const data = all.slice(12);
    const key = await remoteCryptoKey();
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(dec);
  } catch (e) {
    console.warn('[remote] 密码解密失败:', e);
    return '';
  }
}

function loadRemoteConnectionConfig() {
  try {
    const raw = storage.get(REMOTE_CONNECTION_KEY);
    return normalizeRemoteConnectionConfig(raw ? JSON.parse(raw) : {});
  } catch (e) {
    return remoteDefaultConfig();
  }
}

function saveRemoteConnectionConfig(cfg) {
  storage.set(REMOTE_CONNECTION_KEY, JSON.stringify(normalizeRemoteConnectionConfig(cfg || {})));
}

function updateRemoteConnectionConfig(patch = {}) {
  const cfg = loadRemoteConnectionConfig();
  const next = { ...cfg, ...(patch || {}) };
  saveRemoteConnectionConfig(next);
  return next;
}

function isRemoteAgentActive() {
  return !!(
    typeof TERMINAL_CONFIG !== 'undefined' &&
    TERMINAL_CONFIG.serverUrl &&
    REMOTE_CONTROLLER.serverUrl &&
    TERMINAL_CONFIG.serverUrl !== REMOTE_CONTROLLER.serverUrl
  );
}

function localBackendServerUrl() {
  return (REMOTE_CONTROLLER && REMOTE_CONTROLLER.serverUrl) || 'http://localhost:8765';
}

function captureCurrentBackendBinding() {
  if (isRemoteAgentActive()) {
    const cfg = loadRemoteConnectionConfig();
    const activeServerUrl = (typeof TERMINAL_CONFIG !== 'undefined' && TERMINAL_CONFIG.serverUrl) || '';
    const activeConnection = (REMOTE_CONNECTIONS_CACHE || [])
      .map(normalizeRemoteConnectionInfo)
      .find(c => c.connected && c.serverUrl && c.serverUrl === activeServerUrl);
    const activeSshCommand = activeConnection && activeConnection.sshCommand ? activeConnection.sshCommand : cfg.sshCommand;
    const profile = remoteProfileForCommand(cfg, activeSshCommand) || {};
    const activeWorkspace = (activeConnection && activeConnection.remoteWorkspace) || profile.remoteWorkspace || cfg.remoteWorkspace || '~/';
    return {
      type: 'remote',
      serverUrl: TERMINAL_CONFIG.serverUrl || '',
      remoteGitProxyUrl: (activeConnection && activeConnection.remoteGitProxyUrl) || TERMINAL_CONFIG.remoteGitProxyUrl || '',
      sshCommand: activeSshCommand || profile.sshCommand || '',
      remoteWorkspace: activeWorkspace,
      remoteAgentPort: parseInt((activeConnection && activeConnection.remoteAgentPort) || cfg.remoteAgentPort || profile.remoteAgentPort, 10) || 8765,
      localPort: parseInt((activeConnection && activeConnection.localPort) || cfg.localPort || profile.localPort, 10) || 18765,
      heartbeatTimeout: Math.max(120, parseInt(cfg.heartbeatTimeout || profile.heartbeatTimeout, 10) || REMOTE_HEARTBEAT_DEFAULT_SECONDS),
      installDeps: cfg.installDeps !== false,
      encryptedPassword: cfg.encryptedPassword || profile.encryptedPassword || '',
      connectionId: (activeConnection && activeConnection.connectionId) || cfg.connectionId || profile.connectionId || '',
      updatedAt: Date.now()
    };
  }
  return {
    type: 'local',
    serverUrl: localBackendServerUrl(),
    updatedAt: Date.now()
  };
}

function normalizeBackendBinding(binding = {}) {
  const raw = binding && typeof binding === 'object' ? binding : {};
  const type = raw.type === 'remote' ? 'remote' : 'local';
  if (type === 'local') {
    return {
      type: 'local',
      serverUrl: raw.serverUrl || localBackendServerUrl(),
      updatedAt: raw.updatedAt || Date.now()
    };
  }
  return {
    type: 'remote',
    serverUrl: raw.serverUrl || '',
    remoteGitProxyUrl: raw.remoteGitProxyUrl || raw.reverse_git_proxy_url || '',
    sshCommand: remoteProfileKey(raw.sshCommand || ''),
    remoteWorkspace: raw.remoteWorkspace || raw.workspace || '~/',
    remoteAgentPort: parseInt(raw.remoteAgentPort, 10) || 8765,
    localPort: parseInt(raw.localPort, 10) || 18765,
    heartbeatTimeout: Math.max(120, parseInt(raw.heartbeatTimeout, 10) || REMOTE_HEARTBEAT_DEFAULT_SECONDS),
    installDeps: raw.installDeps !== false,
    encryptedPassword: raw.encryptedPassword || '',
    connectionId: raw.connectionId || raw.connection_id || '',
    updatedAt: raw.updatedAt || Date.now()
  };
}

function normalizeRemoteConnectionInfo(info = {}) {
  const raw = info && typeof info === 'object' ? info : {};
  return {
    type: 'remote',
    connected: !!raw.connected,
    serverUrl: raw.serverUrl || raw.server_url || '',
    remoteGitProxyUrl: raw.remoteGitProxyUrl || raw.reverse_git_proxy_url || '',
    sshCommand: remoteProfileKey(raw.sshCommand || raw.ssh_command || ''),
    remoteWorkspace: raw.remoteWorkspace || raw.remote_workspace || '~/',
    remoteAgentPort: parseInt(raw.remoteAgentPort || raw.remote_agent_port, 10) || 8765,
    localPort: parseInt(raw.localPort || raw.local_port, 10) || 0,
    heartbeatTimeout: Math.max(120, parseInt(raw.heartbeatTimeout || raw.heartbeat_timeout, 10) || REMOTE_HEARTBEAT_DEFAULT_SECONDS),
    tunnelPid: raw.tunnelPid || raw.tunnel_pid || null,
    startedAt: raw.startedAt || raw.started_at || '',
    lastError: raw.lastError || raw.last_error || '',
    connectionId: raw.connectionId || raw.connection_id || ''
  };
}

function remoteConnectionIdentityKey(connection) {
  const c = normalizeRemoteConnectionInfo(connection);
  if (c.sshCommand) return `${c.sshCommand}\0${c.remoteAgentPort || 8765}`;
  return c.connectionId || c.serverUrl || '';
}

function dedupeRemoteConnections(connections = []) {
  const byKey = new Map();
  const activeServerUrl = String((typeof TERMINAL_CONFIG !== 'undefined' && TERMINAL_CONFIG.serverUrl) || '');
  (Array.isArray(connections) ? connections : []).map(normalizeRemoteConnectionInfo).forEach(connection => {
    const key = remoteConnectionIdentityKey(connection);
    if (!key) return;
    const current = byKey.get(key);
    if (
      !current
      || (connection.connected && !current.connected)
      || (activeServerUrl && connection.serverUrl === activeServerUrl)
    ) {
      byKey.set(key, connection);
    }
  });
  return Array.from(byKey.values());
}

function remoteStatusPayloadConnections(payload = {}) {
  const list = Array.isArray(payload && payload.connections) ? payload.connections : [];
  REMOTE_CONNECTIONS_CACHE = dedupeRemoteConnections(list);
  return REMOTE_CONNECTIONS_CACHE;
}

function remoteConnectionMatchesBinding(connection, binding) {
  const c = normalizeRemoteConnectionInfo(connection);
  const b = normalizeBackendBinding(binding);
  if (b.type !== 'remote') return false;
  if (b.serverUrl && c.serverUrl && b.serverUrl === c.serverUrl) return true;
  if (b.connectionId && c.connectionId && b.connectionId === c.connectionId) return true;
  if (!b.sshCommand || !c.sshCommand || remoteProfileKey(b.sshCommand) !== remoteProfileKey(c.sshCommand)) return false;
  if (b.remoteAgentPort && c.remoteAgentPort && parseInt(b.remoteAgentPort, 10) !== parseInt(c.remoteAgentPort, 10)) return false;
  return true;
}

function findRemoteConnectionForBinding(binding, connections = REMOTE_CONNECTIONS_CACHE) {
  const list = Array.isArray(connections) ? connections : [];
  return list.map(normalizeRemoteConnectionInfo).find(c => c.connected && remoteConnectionMatchesBinding(c, binding)) || null;
}

function remoteProfileMatchesConnection(profile, connection) {
  if (!profile || !connection || !profile.sshCommand || !connection.sshCommand) return false;
  if (remoteProfileKey(profile.sshCommand) !== remoteProfileKey(connection.sshCommand)) return false;
  const profilePort = parseInt(profile.remoteAgentPort, 10) || 0;
  const connectionPort = parseInt(connection.remoteAgentPort, 10) || 0;
  return !profilePort || !connectionPort || profilePort === connectionPort;
}

function remoteDisplayWorkspaceForConnection(connection, cfg = loadRemoteConnectionConfig()) {
  const c = normalizeRemoteConnectionInfo(connection);
  const profile = remoteProfileForCommand(cfg, c.sshCommand);
  if (remoteProfileMatchesConnection(profile, c) && profile.remoteWorkspace) return profile.remoteWorkspace;
  return c.remoteWorkspace || '~';
}

function remoteDisconnectPayloadForBinding(binding, extra = {}) {
  const b = normalizeBackendBinding(binding);
  return {
    server_url: b.serverUrl || '',
    ssh_command: b.sshCommand || '',
    remote_workspace: b.remoteWorkspace || '',
    local_port: b.localPort || 0,
    remote_agent_port: b.remoteAgentPort || 0,
    connection_id: b.connectionId || '',
    ...extra
  };
}

function rememberConnectedRemoteFromResult(result = {}, source = {}) {
  const r = result || {};
  const src = source || {};
  const serverUrl = r.server_url || r.serverUrl || src.serverUrl || src.lastServerUrl || '';
  const localPort = parseInt(r.local_port || r.localPort || src.localPort, 10) || 18765;
  const remoteAgentPort = parseInt(r.remote_agent_port || r.remoteAgentPort || src.remoteAgentPort, 10) || 8765;
  const remoteWorkspace = src.remoteWorkspace || r.remote_workspace || r.remoteWorkspace || '~/';
  const connectionId = r.connection_id || r.connectionId || src.connectionId || '';
  const remoteGitProxyUrl = r.reverse_git_proxy_url || r.remoteGitProxyUrl || src.remoteGitProxyUrl || '';
  const cfg = loadRemoteConnectionConfig();
  const sshCommand = remoteProfileKey(src.sshCommand || cfg.sshCommand || '');
  const next = {
    ...cfg,
    sshCommand,
    remoteWorkspace,
    remoteAgentPort,
    localPort,
    heartbeatTimeout: Math.max(120, parseInt(r.heartbeat_timeout || src.heartbeatTimeout || cfg.heartbeatTimeout, 10) || REMOTE_HEARTBEAT_DEFAULT_SECONDS),
    installDeps: src.installDeps !== false,
    encryptedPassword: src.encryptedPassword || cfg.encryptedPassword || '',
    autoReconnect: true,
    lastConnectedAt: Date.now(),
    lastServerUrl: serverUrl,
    connectionId,
    remoteGitProxyUrl
  };
  upsertRemoteProfile(next, sshCommand, {
    remoteWorkspace,
    remoteAgentPort,
    localPort,
    heartbeatTimeout: next.heartbeatTimeout,
    installDeps: next.installDeps,
    encryptedPassword: next.encryptedPassword,
    autoReconnect: true,
    lastConnectedAt: next.lastConnectedAt,
    lastServerUrl: serverUrl,
    connectionId,
    remoteGitProxyUrl
  });
  saveRemoteConnectionConfig(next);
  return next;
}

function renderRemoteConnectionsList(connections = REMOTE_CONNECTIONS_CACHE) {
  const el = document.getElementById('remoteConnectionsList');
  if (!el) return;
  const list = (Array.isArray(connections) ? connections : []).map(normalizeRemoteConnectionInfo);
  const cfg = loadRemoteConnectionConfig();
  if (!list.length) {
    el.innerHTML = '<div class="remote-connections-empty">暂无远程连接</div>';
    return;
  }
  el.innerHTML = list.map(c => {
    const state = c.connected ? 'online' : 'offline';
    const statusText = c.connected ? '在线' : '离线';
    const endpoint = c.serverUrl || (c.localPort ? `http://127.0.0.1:${c.localPort}` : '');
    const meta = [
      endpoint,
      c.tunnelPid ? `PID ${c.tunnelPid}` : '',
      c.startedAt || ''
    ].filter(Boolean).join(' · ');
    const workspace = remoteDisplayWorkspaceForConnection(c, cfg);
    return `
      <button class="remote-connection-item ${state}" type="button" data-connection-id="${remoteEscapeHtml(c.connectionId)}" data-server-url="${remoteEscapeHtml(c.serverUrl)}">
        <span class="remote-connection-item-head">
          <span class="remote-connection-dot"></span>
          <span class="remote-connection-command">${remoteEscapeHtml(c.sshCommand || '(unknown ssh)')}</span>
          <span class="remote-connection-state">${statusText}</span>
        </span>
        <span class="remote-connection-workspace">${remoteEscapeHtml(workspace)}</span>
        <span class="remote-connection-meta">${remoteEscapeHtml(meta || '未分配本地端口')}</span>
        ${c.lastError ? `<span class="remote-connection-error">${remoteEscapeHtml(c.lastError)}</span>` : ''}
      </button>
    `;
  }).join('');
  el.querySelectorAll('.remote-connection-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const target = list.find(c => (
        (btn.dataset.connectionId && c.connectionId === btn.dataset.connectionId)
        || (btn.dataset.serverUrl && c.serverUrl === btn.dataset.serverUrl)
      ));
      if (!target) return;
      REMOTE_SELECTED_CONNECTION = target;
      const cfg = loadRemoteConnectionConfig();
      const profile = remoteProfileForCommand(cfg, target.sshCommand) || {};
      const workspace = remoteProfileMatchesConnection(profile, target)
        ? (profile.remoteWorkspace || target.remoteWorkspace)
        : target.remoteWorkspace;
      const password = await remoteDecryptPassword(profile.encryptedPassword || cfg.encryptedPassword || '');
      applyRemoteConfigToForm({
        ...cfg,
        ...profile,
        sshCommand: target.sshCommand,
        remoteWorkspace: workspace,
        remoteAgentPort: target.remoteAgentPort,
        localPort: target.localPort || profile.localPort || cfg.localPort,
        connectionId: target.connectionId,
        lastServerUrl: target.serverUrl,
        remoteGitProxyUrl: target.remoteGitProxyUrl
      }, password);
      setRemoteStatus(`已选择远程连接：${target.serverUrl || target.sshCommand}`, target.connected ? 'ok' : '');
    });
  });
}

function activeRemoteMatchesBinding(binding) {
  const b = normalizeBackendBinding(binding);
  if (b.type !== 'remote' || !isRemoteAgentActive()) return false;
  const activeServerUrl = String((typeof TERMINAL_CONFIG !== 'undefined' && TERMINAL_CONFIG.serverUrl) || '');

  const activeConnection = (REMOTE_CONNECTIONS_CACHE || [])
    .map(normalizeRemoteConnectionInfo)
    .find(c => c.connected && c.serverUrl && String(c.serverUrl) === activeServerUrl);
  if (activeConnection) return remoteConnectionMatchesBinding(activeConnection, b);

  if (b.serverUrl && activeServerUrl === String(b.serverUrl)) return true;

  const cfg = loadRemoteConnectionConfig();
  const cfgServerUrl = String(cfg.lastServerUrl || '');
  if (!cfgServerUrl || cfgServerUrl !== activeServerUrl) return false;
  if (b.connectionId && cfg.connectionId && b.connectionId === cfg.connectionId) return true;
  return remoteProfileKey(cfg.sshCommand) === remoteProfileKey(b.sshCommand)
    && (parseInt(cfg.remoteAgentPort, 10) || 8765) === (parseInt(b.remoteAgentPort, 10) || 8765);
}

function currentChatBackendBinding() {
  try {
    const stateModule = window.AgentApp && window.AgentApp.require && window.AgentApp.require('state');
    const chat = stateModule && typeof stateModule.currentChat === 'function' ? stateModule.currentChat() : null;
    return chat && chat.backend && typeof chat.backend === 'object' ? chat.backend : null;
  } catch (_) {
    return null;
  }
}

function remoteBindingNeedsConnection(binding) {
  const b = normalizeBackendBinding(binding);
  return b.type === 'remote'
    && !activeRemoteMatchesBinding(b)
    && !findRemoteConnectionForBinding(b, REMOTE_CONNECTIONS_CACHE);
}

async function applyBackendBinding(binding, options = {}) {
  const b = normalizeBackendBinding(binding);
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('Remote backend binding request is stale');
  };
  if (b.type !== 'remote') {
    assertCurrent();
    if (typeof TERMINAL_CONFIG !== 'undefined') {
      TERMINAL_CONFIG.serverUrl = localBackendServerUrl();
      TERMINAL_CONFIG.remoteGitProxyUrl = '';
    }
    return { ok: true, type: 'local', serverUrl: localBackendServerUrl() };
  }

  assertCurrent();
  if (!b.sshCommand) {
    throw new Error('该对话缺少远程 SSH 命令，无法恢复远程连接');
  }

  const alreadyMatched = activeRemoteMatchesBinding(b);

  const cfg = {
    ...loadRemoteConnectionConfig(),
    sshCommand: b.sshCommand,
    remoteWorkspace: b.remoteWorkspace,
    remoteAgentPort: b.remoteAgentPort,
    localPort: b.localPort,
    heartbeatTimeout: b.heartbeatTimeout,
    installDeps: b.installDeps,
    encryptedPassword: b.encryptedPassword,
    connectionId: b.connectionId,
    autoReconnect: true,
    lastServerUrl: b.serverUrl || '',
    lastConnectedAt: Date.now()
  };
  upsertRemoteProfile(cfg, b.sshCommand, {
    remoteWorkspace: b.remoteWorkspace,
    remoteAgentPort: b.remoteAgentPort,
    localPort: b.localPort,
    heartbeatTimeout: b.heartbeatTimeout,
    installDeps: b.installDeps,
    encryptedPassword: b.encryptedPassword,
    autoReconnect: true,
    lastServerUrl: b.serverUrl || '',
    lastConnectedAt: cfg.lastConnectedAt,
    connectionId: b.connectionId,
    remoteGitProxyUrl: b.remoteGitProxyUrl || ''
  });
  saveRemoteConnectionConfig(cfg);

  const password = await remoteDecryptPassword(cfg.encryptedPassword || '');
  assertCurrent();
  applyRemoteConfigToForm(cfg, password);

  const cachedConnection = findRemoteConnectionForBinding(b, REMOTE_CONNECTIONS_CACHE);
  if (cachedConnection) {
    assertCurrent();
    TERMINAL_CONFIG.serverUrl = cachedConnection.serverUrl;
    TERMINAL_CONFIG.remoteGitProxyUrl = cachedConnection.remoteGitProxyUrl || '';
    rememberConnectedRemoteFromResult(cachedConnection, { ...cfg, ...b });
    return { ok: true, type: 'remote', reused: true, serverUrl: cachedConnection.serverUrl };
  }

  try {
    const status = await remoteBackend('remote_status', {
      ...remoteDisconnectPayloadForBinding(b),
      requestTimeoutMs: 15000
    });
    const connections = remoteStatusPayloadConnections(status);
    renderRemoteConnectionsList(connections);
    const statusConnection = findRemoteConnectionForBinding(b, connections) || (status.connected ? normalizeRemoteConnectionInfo(status) : null);
    if (statusConnection && statusConnection.connected && remoteConnectionMatchesBinding(statusConnection, b)) {
      assertCurrent();
      TERMINAL_CONFIG.serverUrl = statusConnection.serverUrl;
      TERMINAL_CONFIG.remoteGitProxyUrl = statusConnection.remoteGitProxyUrl || '';
      rememberConnectedRemoteFromResult(statusConnection, { ...cfg, ...b });
      return { ok: true, type: 'remote', reused: true, serverUrl: statusConnection.serverUrl };
    }
  } catch (e) {
    console.warn('[remote] status before backend binding failed:', e);
  }

  if (alreadyMatched || activeRemoteMatchesBinding(b)) {
    assertCurrent();
    if (b.remoteGitProxyUrl) TERMINAL_CONFIG.remoteGitProxyUrl = b.remoteGitProxyUrl;
    return { ok: true, type: 'remote', reused: true, serverUrl: TERMINAL_CONFIG.serverUrl };
  }

  if (options.toast !== false) {
    RemoteConnectionUiService.toast(options.toastMessage || '远程连接中，可能需要几十秒...');
  }
  const result = await connectRemoteAgent({
    autoReconnect: true,
    skipConfirm: true,
    silentSave: true,
    reuseExisting: true,
    throwOnError: true,
    suppressWorkspaceUi: !!options.suppressWorkspaceUi,
    suppressStatusUi: !!options.suppressStatusUi,
    isCurrent,
    binding: b
  });
  assertCurrent();
  return {
    ok: true,
    type: 'remote',
    reused: !!(result && result.reusedExisting),
    serverUrl: (result && result.serverUrl) || TERMINAL_CONFIG.serverUrl,
    localPort: result && result.localPort,
    remoteAgentPort: result && result.remoteAgentPort,
    connectionId: result && result.connectionId
  };
}

function persistActiveRemoteConnection(info = {}) {
  const workspace = (info && (info.workspace || info.cwd || info.remoteWorkspace)) || '';
  const patch = {
    autoReconnect: true,
    lastConnectedAt: Date.now(),
    lastServerUrl: (typeof TERMINAL_CONFIG !== 'undefined' && TERMINAL_CONFIG.serverUrl) || ''
  };
  if (workspace) patch.remoteWorkspace = workspace;
  if (info.remoteAgentPort) patch.remoteAgentPort = parseInt(info.remoteAgentPort, 10) || undefined;
  if (info.localPort) patch.localPort = parseInt(info.localPort, 10) || undefined;
  if (info.connectionId) patch.connectionId = info.connectionId;
  if (info.serverUrl) patch.lastServerUrl = info.serverUrl;
  if (info.remoteGitProxyUrl) patch.remoteGitProxyUrl = info.remoteGitProxyUrl;
  const cfg = loadRemoteConnectionConfig();
  const next = { ...cfg, ...patch };
  upsertRemoteProfile(next, next.sshCommand, {
    remoteWorkspace: workspace || next.remoteWorkspace,
    remoteAgentPort: patch.remoteAgentPort || next.remoteAgentPort,
    localPort: patch.localPort || next.localPort,
    connectionId: patch.connectionId || next.connectionId || '',
    remoteGitProxyUrl: patch.remoteGitProxyUrl || next.remoteGitProxyUrl || '',
    autoReconnect: true,
    lastConnectedAt: patch.lastConnectedAt,
    lastServerUrl: patch.lastServerUrl
  });
  saveRemoteConnectionConfig(next);
  return next;
}

function clearRemoteAutoReconnectFlag(binding = null) {
  const cfg = loadRemoteConnectionConfig();
  const target = binding ? normalizeBackendBinding(binding) : null;
  if (!target || target.type !== 'remote') {
    return updateRemoteConnectionConfig({
      autoReconnect: false,
      lastServerUrl: '',
      lastConnectedAt: 0,
      connectionId: ''
    });
  }
  const next = { ...cfg };
  if (
    (target.connectionId && cfg.connectionId === target.connectionId)
    || (target.serverUrl && cfg.lastServerUrl === target.serverUrl)
    || (target.sshCommand && remoteProfileKey(cfg.sshCommand) === remoteProfileKey(target.sshCommand))
  ) {
    next.autoReconnect = false;
    next.lastServerUrl = '';
    next.lastConnectedAt = 0;
    next.connectionId = '';
  }
  const profile = remoteProfileForCommand(next, target.sshCommand);
  if (profile) {
    profile.autoReconnect = false;
    profile.lastServerUrl = '';
    profile.lastConnectedAt = 0;
    profile.connectionId = '';
    profile.updatedAt = Date.now();
  }
  saveRemoteConnectionConfig(next);
  return next;
}

function noteRemoteWorkspaceChanged(path, binding = null) {
  const workspace = String(path || '').trim();
  if (!workspace || !isRemoteAgentActive()) return;
  const b = binding ? normalizeBackendBinding(binding) : normalizeBackendBinding(currentChatBackendBinding() || {});
  const cfg = loadRemoteConnectionConfig();
  const activeServerUrl = (typeof TERMINAL_CONFIG !== 'undefined' && TERMINAL_CONFIG.serverUrl) || '';
  const activeConnection = (REMOTE_CONNECTIONS_CACHE || [])
    .map(normalizeRemoteConnectionInfo)
    .find(c => c.connected && c.serverUrl && c.serverUrl === activeServerUrl);
  if (b.type === 'remote' && activeServerUrl) {
    const bindingMatchesActive = (b.serverUrl && b.serverUrl === activeServerUrl)
      || (activeConnection && remoteConnectionMatchesBinding(activeConnection, b));
    if (!bindingMatchesActive) return;
  }
  const sshCommand = remoteProfileKey(
    (b.type === 'remote' && b.sshCommand)
    || (activeConnection && activeConnection.sshCommand)
    || cfg.sshCommand
  );
  if (!sshCommand) return;
  REMOTE_CONNECTIONS_CACHE = (REMOTE_CONNECTIONS_CACHE || []).map(connection => {
    const c = normalizeRemoteConnectionInfo(connection);
    const shouldUpdate = (activeConnection && remoteConnectionMatchesBinding(c, activeConnection))
      || (b.type === 'remote' && remoteConnectionMatchesBinding(c, b))
      || (c.serverUrl && c.serverUrl === activeServerUrl);
    return shouldUpdate ? { ...c, remoteWorkspace: workspace } : c;
  });
  const next = {
    ...cfg,
    sshCommand,
    remoteWorkspace: workspace,
    autoReconnect: true,
    lastConnectedAt: Date.now(),
    lastServerUrl: activeServerUrl,
    connectionId: (b.type === 'remote' && b.connectionId) || (activeConnection && activeConnection.connectionId) || cfg.connectionId || '',
    remoteAgentPort: (b.type === 'remote' && b.remoteAgentPort) || (activeConnection && activeConnection.remoteAgentPort) || cfg.remoteAgentPort,
    localPort: (b.type === 'remote' && b.localPort) || (activeConnection && activeConnection.localPort) || cfg.localPort
  };
  upsertRemoteProfile(next, sshCommand, {
    remoteWorkspace: workspace,
    remoteAgentPort: next.remoteAgentPort,
    localPort: next.localPort,
    autoReconnect: true,
    lastConnectedAt: next.lastConnectedAt,
    lastServerUrl: next.lastServerUrl,
    connectionId: next.connectionId,
    remoteGitProxyUrl: (b.type === 'remote' && b.remoteGitProxyUrl) || cfg.remoteGitProxyUrl || ''
  });
  saveRemoteConnectionConfig(next);
  renderRemoteConnectionsList(REMOTE_CONNECTIONS_CACHE);
}

function setRemoteStatus(message, kind = '') {
  const el = document.getElementById('remoteConnectionStatus');
  if (!el) return;
  el.textContent = message || '';
  el.className = kind ? `remote-connection-status ${kind}` : 'remote-connection-status';
}

function remoteEscapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function applyRemoteConfigToForm(cfg, password = '') {
  const config = { ...remoteDefaultConfig(), ...(cfg || {}) };
  document.getElementById('remoteSshCommand').value = config.sshCommand || '';
  document.getElementById('remotePassword').value = password || '';
  document.getElementById('remoteWorkspace').value = config.remoteWorkspace || '';
  document.getElementById('remoteAgentPort').value = config.remoteAgentPort || 8765;
  document.getElementById('remoteLocalPort').value = config.localPort || 18765;
  document.getElementById('remoteHeartbeatTimeout').value = Math.max(120, parseInt(config.heartbeatTimeout, 10) || REMOTE_HEARTBEAT_DEFAULT_SECONDS);
  document.getElementById('remoteInstallDeps').checked = config.installDeps !== false;
}

function remoteSortedProfiles(cfg = loadRemoteConnectionConfig()) {
  return Object.values((cfg && cfg.profiles) || {})
    .filter(profile => profile && profile.sshCommand)
    .sort((a, b) => (Number(b.updatedAt || b.lastConnectedAt) || 0) - (Number(a.updatedAt || a.lastConnectedAt) || 0));
}

function hideRemoteSshProfileMenu() {
  const menu = document.getElementById('remoteSshProfileMenu');
  const toggle = document.getElementById('remoteSshHistoryToggle');
  if (menu) menu.hidden = true;
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

function remoteSshProfileMatches(profile, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return String(profile.sshCommand || '').toLowerCase().includes(q)
    || String(profile.remoteWorkspace || '').toLowerCase().includes(q);
}

function renderRemoteSshProfilesDatalist(cfg = loadRemoteConnectionConfig(), options = {}) {
  const input = document.getElementById('remoteSshCommand');
  const menu = document.getElementById('remoteSshProfileMenu');
  const toggle = document.getElementById('remoteSshHistoryToggle');
  const oldList = document.getElementById('remoteSshCommandHistory');
  if (input) input.removeAttribute('list');
  if (oldList) oldList.remove();
  if (!menu || !input) return;

  const profiles = remoteSortedProfiles(cfg);
  const query = remoteProfileKey(input.value);
  const showAll = !!options.showAll;
  const shouldOpen = !!options.open;
  const visibleProfiles = showAll ? profiles : profiles.filter(profile => remoteSshProfileMatches(profile, query));
  if (!shouldOpen) {
    hideRemoteSshProfileMenu();
    return;
  }

  if (!profiles.length) {
    menu.innerHTML = '<div class="remote-ssh-profile-empty">暂无 SSH 历史记录</div>';
  } else if (!visibleProfiles.length) {
    menu.innerHTML = '<div class="remote-ssh-profile-empty">没有匹配的 SSH 历史记录</div>';
  } else {
    menu.innerHTML = visibleProfiles.map(profile => `
      <div class="remote-ssh-profile-row" data-command="${remoteEscapeHtml(profile.sshCommand)}">
        <button class="remote-ssh-profile-item" type="button" data-command="${remoteEscapeHtml(profile.sshCommand)}">
          <span class="remote-ssh-profile-command">${remoteEscapeHtml(profile.sshCommand)}</span>
          <span class="remote-ssh-profile-workspace">${remoteEscapeHtml(profile.remoteWorkspace || '~')}</span>
        </button>
        <button class="remote-ssh-profile-delete" type="button" data-command="${remoteEscapeHtml(profile.sshCommand)}" title="删除这条 SSH 历史记录" aria-label="删除这条 SSH 历史记录">×</button>
      </div>
    `).join('');
    menu.querySelectorAll('.remote-ssh-profile-item').forEach(btn => {
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => selectRemoteSshProfile(btn.dataset.command || ''));
    });
    menu.querySelectorAll('.remote-ssh-profile-delete').forEach(btn => {
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', e => {
        e.stopPropagation();
        deleteRemoteSshProfile(btn.dataset.command || '', { reopen: true, showAll });
      });
    });
  }
  menu.hidden = false;
  if (toggle) toggle.setAttribute('aria-expanded', 'true');
}

let remoteProfileApplyTimer = null;

async function applyRemoteProfileForCommand(sshCommand, options = {}) {
  const command = remoteProfileKey(sshCommand);
  if (!command) return false;
  const cfg = loadRemoteConnectionConfig();
  const profile = remoteProfileForCommand(cfg, command);
  if (!profile) return false;
  const password = await remoteDecryptPassword(profile.encryptedPassword || '');
  applyRemoteConfigToForm({ ...cfg, ...profile, sshCommand: command }, password);
  if (!options.silent) {
    setRemoteStatus(`已加载该 SSH 命令上次的远程工作区：${profile.remoteWorkspace || '~'}`, 'ok');
  }
  return true;
}

function deleteRemoteSshProfile(sshCommand, options = {}) {
  const command = remoteProfileKey(sshCommand);
  if (!command) return false;
  const cfg = loadRemoteConnectionConfig();
  if (!cfg.profiles || !cfg.profiles[command]) return false;
  const nextProfiles = { ...(cfg.profiles || {}) };
  delete nextProfiles[command];
  const patch = { profiles: nextProfiles };
  if (remoteProfileKey(cfg.sshCommand) === command) {
    patch.sshCommand = '';
    patch.autoReconnect = false;
    patch.lastServerUrl = '';
    patch.lastConnectedAt = 0;
    patch.connectionId = '';
  }
  const next = updateRemoteConnectionConfig(patch);
  renderRemoteSshProfilesDatalist(next, {
    open: options.reopen !== false,
    showAll: options.showAll !== false
  });
  setRemoteStatus(`已删除 SSH 历史记录：${command}`, 'ok');
  return true;
}

async function selectRemoteSshProfile(sshCommand) {
  const input = document.getElementById('remoteSshCommand');
  const command = remoteProfileKey(sshCommand);
  if (!command) return;
  if (input) input.value = command;
  clearTimeout(remoteProfileApplyTimer);
  hideRemoteSshProfileMenu();
  await applyRemoteProfileForCommand(command).catch(e => console.warn('[remote] apply selected profile failed:', e));
}

function bindRemoteProfileInputs() {
  const input = document.getElementById('remoteSshCommand');
  if (!input || input._remoteProfileBound) return;
  input._remoteProfileBound = true;
  const wrap = document.querySelector('.remote-ssh-command-wrap');
  const toggle = document.getElementById('remoteSshHistoryToggle');
  const schedule = () => {
    clearTimeout(remoteProfileApplyTimer);
    remoteProfileApplyTimer = setTimeout(() => {
      applyRemoteProfileForCommand(input.value, { silent: true }).catch(e => console.warn('[remote] apply profile failed:', e));
    }, 250);
  };
  input.addEventListener('input', () => {
    schedule();
    const query = remoteProfileKey(input.value);
    renderRemoteSshProfilesDatalist(loadRemoteConnectionConfig(), { open: !!query, showAll: false });
  });
  input.addEventListener('focus', () => {
    const query = remoteProfileKey(input.value);
    if (query) renderRemoteSshProfilesDatalist(loadRemoteConnectionConfig(), { open: true, showAll: false });
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideRemoteSshProfileMenu();
  });
  input.addEventListener('change', () => {
    clearTimeout(remoteProfileApplyTimer);
    hideRemoteSshProfileMenu();
    applyRemoteProfileForCommand(input.value).catch(e => console.warn('[remote] apply profile failed:', e));
  });
  if (toggle) {
    toggle.addEventListener('mousedown', e => e.preventDefault());
    toggle.addEventListener('click', () => {
      const menu = document.getElementById('remoteSshProfileMenu');
      if (menu && !menu.hidden && toggle.getAttribute('aria-expanded') === 'true') {
        hideRemoteSshProfileMenu();
        return;
      }
      renderRemoteSshProfilesDatalist(loadRemoteConnectionConfig(), { open: true, showAll: true });
    });
  }
  document.addEventListener('mousedown', e => {
    if (wrap && !wrap.contains(e.target)) hideRemoteSshProfileMenu();
  });
}

async function openRemoteConnection() {
  const modal = document.getElementById('remoteConnectionModal');
  if (!modal) return;
  const cfg = loadRemoteConnectionConfig();
  const password = await remoteDecryptPassword(cfg.encryptedPassword || '');
  applyRemoteConfigToForm(cfg, password);
  renderRemoteSshProfilesDatalist(cfg);
  renderRemoteConnectionsList(REMOTE_CONNECTIONS_CACHE);
  bindRemoteProfileInputs();
  setRemoteStatus('填写 SSH 命令后点击连接；远程工作区留空时默认使用远程用户主目录 ~。');
  modal.classList.add('show');
  checkRemoteStatus({ silent: true }).catch(e => console.warn('[remote] refresh status on open failed:', e));
}

function closeRemoteConnection() {
  const modal = document.getElementById('remoteConnectionModal');
  if (modal) modal.classList.remove('show');
}

function remoteFormValues() {
  return {
    sshCommand: document.getElementById('remoteSshCommand').value.trim(),
    password: document.getElementById('remotePassword').value,
    remoteWorkspace: document.getElementById('remoteWorkspace').value.trim() || '~/',
    remoteAgentPort: parseInt(document.getElementById('remoteAgentPort').value, 10) || 8765,
    localPort: parseInt(document.getElementById('remoteLocalPort').value, 10) || 18765,
    heartbeatTimeout: Math.max(120, parseInt(document.getElementById('remoteHeartbeatTimeout').value, 10) || REMOTE_HEARTBEAT_DEFAULT_SECONDS),
    installDeps: !!document.getElementById('remoteInstallDeps').checked
  };
}

async function saveRemoteConnectionFromUi(options = {}) {
  const v = remoteFormValues();
  const encryptedPassword = await remoteEncryptPassword(v.password || '');
  const existing = loadRemoteConnectionConfig();
  const next = {
    ...existing,
    sshCommand: v.sshCommand,
    remoteWorkspace: v.remoteWorkspace,
    remoteAgentPort: v.remoteAgentPort,
    localPort: v.localPort,
    heartbeatTimeout: v.heartbeatTimeout,
    installDeps: v.installDeps,
    encryptedPassword
  };
  upsertRemoteProfile(next, v.sshCommand, {
    remoteWorkspace: v.remoteWorkspace,
    remoteAgentPort: v.remoteAgentPort,
    localPort: v.localPort,
    heartbeatTimeout: v.heartbeatTimeout,
    installDeps: v.installDeps,
    encryptedPassword
  });
  saveRemoteConnectionConfig(next);
  renderRemoteSshProfilesDatalist(next);
  if (!options.silent) {
    setRemoteStatus('Remote connection config saved locally.', 'ok');
    RemoteConnectionUiService.toast('Remote connection config saved');
  }
}
async function remoteBackend(action, params = {}) {
  const requestTimeoutMs = Math.max(1000, parseInt(params.requestTimeoutMs, 10) || 75000);
  const payload = { ...params };
  delete payload.requestTimeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs);
  try {
    const resp = await fetch(REMOTE_CONTROLLER.serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload, session_id: TERMINAL_CONFIG.sessionId || 'remote-ui' }),
      signal: ctrl.signal
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`远程控制请求超时（${Math.round(requestTimeoutMs / 1000)}s）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function loadRemoteDir(path) {
  const v = remoteFormValues();
  if (!v.sshCommand) {
    setRemoteStatus('请先填写 SSH 命令，再浏览远程目录。', 'error');
    return;
  }
  const picker = document.getElementById('remoteDirPicker');
  const currentEl = document.getElementById('remoteDirCurrent');
  const listEl = document.getElementById('remoteDirList');
  if (picker) picker.classList.add('show');
  if (currentEl) currentEl.textContent = '正在读取：' + (path || '~');
  if (listEl) listEl.innerHTML = '<div class="remote-dir-empty">正在通过 SSH 读取远程目录...</div>';
  setRemoteStatus('正在读取远程目录：' + (path || '~'), 'loading');
  try {
    const r = await remoteBackend('remote_list_dirs', {
      ssh_command: v.sshCommand,
      password: v.password,
      path: path || '~',
      requestTimeoutMs: 60000
    });
    if (!r.ok) throw new Error(r.error || '远程目录读取失败');
    REMOTE_DIR_PICKER.currentPath = r.path || path || '~';
    REMOTE_DIR_PICKER.parentPath = r.parent || REMOTE_DIR_PICKER.currentPath;
    if (currentEl) {
      currentEl.textContent = REMOTE_DIR_PICKER.currentPath;
      currentEl.title = REMOTE_DIR_PICKER.currentPath;
    }
    renderRemoteDirList(r.entries || [], !!r.truncated);
    setRemoteStatus('已读取远程目录，点击文件夹进入，或选择当前目录作为工作区。', 'ok');
  } catch (e) {
    if (currentEl) currentEl.textContent = '读取失败：' + e.message;
    if (listEl) listEl.innerHTML = `<div class="remote-dir-empty">读取失败：${remoteEscapeHtml(e.message)}</div>`;
    setRemoteStatus('远程目录读取失败：' + e.message, 'error');
  }
}

function renderRemoteDirList(entries, truncated) {
  const listEl = document.getElementById('remoteDirList');
  if (!listEl) return;
  if (!entries.length) {
    listEl.innerHTML = '<div class="remote-dir-empty">当前目录下没有可显示的子目录</div>';
    return;
  }
  const rows = entries.map(item => {
    const path = item.path || item.name;
    const disabledHint = (!item.readable || !item.executable) ? '（权限可能不足）' : '';
    return `<button class="remote-dir-item" type="button" data-path="${remoteEscapeHtml(path)}" title="${remoteEscapeHtml(path)}">
      <span>📁</span><span>${remoteEscapeHtml(item.name)} ${remoteEscapeHtml(disabledHint)}</span>
    </button>`;
  });
  if (truncated) rows.push('<div class="remote-dir-empty">目录过多，仅显示前部分结果</div>');
  listEl.innerHTML = rows.join('');
  listEl.querySelectorAll('.remote-dir-item').forEach(btn => {
    btn.addEventListener('click', () => loadRemoteDir(btn.dataset.path));
  });
}

async function openRemoteDirPicker() {
  const input = document.getElementById('remoteWorkspace');
  const start = (input && input.value.trim()) || REMOTE_DIR_PICKER.currentPath || '~';
  await loadRemoteDir(start);
}

async function refreshRemoteDirPicker() {
  await loadRemoteDir(REMOTE_DIR_PICKER.currentPath || '~');
}

async function remoteDirGoHome() {
  await loadRemoteDir('~');
}

async function remoteDirGoParent() {
  await loadRemoteDir(REMOTE_DIR_PICKER.parentPath || '~');
}

async function selectRemoteDirCurrent() {
  const input = document.getElementById('remoteWorkspace');
  const selected = REMOTE_DIR_PICKER.currentPath || '~';
  if (input) input.value = selected;
  const picker = document.getElementById('remoteDirPicker');
  if (picker) picker.classList.remove('show');

  // 这里的“选择当前目录”默认只是写入远程连接表单，用于下一次连接。
  // 如果当前已经连上远程 Agent，则进一步调用远程 Agent 的 set_workspace，真正切换当前沙箱。
  if (typeof saveRemoteConnectionFromUi === 'function') {
    try { await saveRemoteConnectionFromUi(); } catch (e) { console.warn('[remote] save selected dir failed:', e); }
  }

  const remoteActive = !!(
    typeof TERMINAL_CONFIG !== 'undefined' &&
    TERMINAL_CONFIG.serverUrl &&
    REMOTE_CONTROLLER.serverUrl &&
    TERMINAL_CONFIG.serverUrl !== REMOTE_CONTROLLER.serverUrl
  );

  if (!remoteActive) {
    setRemoteStatus('已选择远程工作区：' + selected + '。点击“连接远程”后生效。', 'ok');
    return;
  }

  try {
    setRemoteStatus('正在切换远程沙箱目录：' + selected, 'loading');
    const r = await workspaceBackendAction('set_workspace', { path: selected });
    if (!r.ok) throw new Error(r.error || '切换远程沙箱目录失败');
    updateWorkspaceDisplay(r);
    refreshWorkspaceDependentContext();
    noteRemoteWorkspaceChanged(r.workspace || r.cwd || selected);
    if (typeof resetFileExplorerToRoot === 'function') resetFileExplorerToRoot();
    setRemoteStatus('远程沙箱目录已切换：' + (r.workspace || selected), 'ok');
    RemoteConnectionUiService.toast('✓ 远程沙箱目录已切换');
  } catch (e) {
    setRemoteStatus('远程目录已填入，但切换当前沙箱失败：' + e.message, 'error');
  }
}

async function connectRemoteAgent(options = {}) {
  const opts = (options && typeof options === 'object' && !('target' in options)) ? options : {};
  const autoReconnect = !!opts.autoReconnect;
  const skipConfirm = !!opts.skipConfirm || autoReconnect;
  const isCurrent = typeof opts.isCurrent === 'function' ? opts.isCurrent : () => true;
  const canUpdateStatusUi = () => isCurrent() && !opts.suppressStatusUi;
  const btn = document.getElementById('remoteConnectBtn');
  const oldServerUrl = TERMINAL_CONFIG.serverUrl;
  const oldRemoteGitProxyUrl = TERMINAL_CONFIG.remoteGitProxyUrl || '';
  const v = remoteFormValues();
  if (!v.sshCommand) return setRemoteStatus('请填写 SSH 命令，例如 ssh user@example.com', 'error');
  if (!skipConfirm && !confirm('将通过 SSH 上传并在远程服务器启动 Agent 后端，继续？')) return;
  if (btn && canUpdateStatusUi()) btn.disabled = true;
  if (canUpdateStatusUi()) {
  setRemoteStatus(autoReconnect ? '正在恢复上次远程连接...' : '正在保存配置...', 'loading');
  }
  if (!autoReconnect) {
    await saveRemoteConnectionFromUi({ silent: !!opts.silentSave });
  }
  try {
    if (canUpdateStatusUi()) {
    setRemoteStatus(autoReconnect ? '正在自动连接上次远程工作区，可能需要几十秒...' : '正在打包、上传、启动远程 Agent 并建立隧道，可能需要几十秒...', 'loading');
    }
    const r = await remoteBackend('remote_connect', {
      ssh_command: v.sshCommand,
      password: v.password,
      remote_workspace: v.remoteWorkspace,
      remote_agent_port: v.remoteAgentPort,
      local_port: v.localPort,
      heartbeat_timeout: v.heartbeatTimeout,
      install_deps: v.installDeps,
      reuse_existing: !!opts.reuseExisting || autoReconnect,
      fallback_on_reuse_failure: true,
      git_proxy: (typeof gitProxyConfigForBackend === 'function') ? gitProxyConfigForBackend() : undefined,
      requestTimeoutMs: 240000
    });
    if (!r.ok) throw new Error(r.error || '远程连接失败');
    const savedCfg = loadRemoteConnectionConfig();
    const resultSource = { ...savedCfg, ...v, ...(opts.binding || {}) };
    rememberConnectedRemoteFromResult(r, resultSource);
    remoteStatusPayloadConnections(r);
    renderRemoteConnectionsList(REMOTE_CONNECTIONS_CACHE);
    if (!isCurrent()) {
      return {
        ok: false,
        stale: true,
        serverUrl: r.server_url,
        localPort: r.local_port,
        remoteAgentPort: r.remote_agent_port,
        connectionId: r.connection_id || ''
      };
    }
    TERMINAL_CONFIG.remoteGitProxyUrl = r.reverse_git_proxy_url || '';
    TERMINAL_CONFIG.serverUrl = r.server_url;

    let workspaceInfo = r.workspace_info;
    if (!workspaceInfo) {
      workspaceInfo = await refreshWorkspaceInfo();
    }
    if (!isCurrent()) {
      return {
        ok: false,
        stale: true,
        serverUrl: r.server_url,
        localPort: r.local_port,
        remoteAgentPort: r.remote_agent_port,
        connectionId: r.connection_id || ''
      };
    }
    if (!workspaceInfo || workspaceInfo.ok === false) {
      const detail = (workspaceInfo && workspaceInfo.error)
        || r.workspace_error
        || (Array.isArray(r.logs) && r.logs.length ? r.logs.join('\n') : '')
        || '请检查远程工作区目录是否存在且有权限访问';
      console.error('[remote] workspace read failed', { response: r, workspaceInfo });
      throw new Error('远程 Agent 已启动，但无法读取远程工作区：' + detail);
    }
    const requestedWorkspace = String(v.remoteWorkspace || '').trim();
    const currentRemoteWorkspace = String((workspaceInfo && (workspaceInfo.workspace || workspaceInfo.cwd)) || '').trim();
    if (requestedWorkspace && currentRemoteWorkspace && currentRemoteWorkspace !== requestedWorkspace && typeof workspaceBackendAction === 'function') {
      const switchedWorkspace = await workspaceBackendAction('set_workspace', { path: requestedWorkspace });
      if (!switchedWorkspace || switchedWorkspace.ok === false) {
        throw new Error((switchedWorkspace && switchedWorkspace.error) || '切换远程沙箱目录失败');
      }
      workspaceInfo = switchedWorkspace;
    }
    if (!isCurrent()) {
      return {
        ok: false,
        stale: true,
        serverUrl: r.server_url,
        localPort: r.local_port,
        remoteAgentPort: r.remote_agent_port,
        connectionId: r.connection_id || ''
      };
    }
    if (!opts.suppressWorkspaceUi && canUpdateStatusUi() && typeof updateWorkspaceDisplay === 'function') {
      updateWorkspaceDisplay(workspaceInfo);
    }
    if (!isCurrent()) {
      return {
        ok: false,
        stale: true,
        serverUrl: r.server_url,
        localPort: r.local_port,
        remoteAgentPort: r.remote_agent_port,
        connectionId: r.connection_id || ''
      };
    }
    persistActiveRemoteConnection({
      workspace: workspaceInfo.workspace || workspaceInfo.cwd || v.remoteWorkspace,
      cwd: workspaceInfo.cwd,
      remoteWorkspace: v.remoteWorkspace,
      remoteAgentPort: r.remote_agent_port || v.remoteAgentPort,
      localPort: r.local_port || v.localPort,
      connectionId: r.connection_id || '',
      serverUrl: r.server_url || '',
      remoteGitProxyUrl: r.reverse_git_proxy_url || ''
    });
    if (!opts.suppressWorkspaceUi && canUpdateStatusUi() && typeof resetFileExplorerToRoot === 'function') resetFileExplorerToRoot();
    if (canUpdateStatusUi()) {
    setRemoteStatus(`已连接：${r.server_url} → ${workspaceInfo.workspace || v.remoteWorkspace}`, 'ok');
    RemoteConnectionUiService.toast('远程 Agent 已连接');
    }
    return {
      ok: true,
      serverUrl: r.server_url,
      localPort: r.local_port,
      remoteAgentPort: r.remote_agent_port,
      connectionId: r.connection_id || '',
      remoteGitProxyUrl: r.reverse_git_proxy_url || '',
      reusedExisting: !!r.reused_existing,
      workspace: workspaceInfo.workspace || workspaceInfo.cwd || v.remoteWorkspace,
      cwd: workspaceInfo.cwd
    };
  } catch (e) {
    const stillCurrent = isCurrent();
    if (stillCurrent) {
      TERMINAL_CONFIG.serverUrl = oldServerUrl;
      TERMINAL_CONFIG.remoteGitProxyUrl = oldRemoteGitProxyUrl;
    }
    console.error('[remote] connect failed:', e);
    if (canUpdateStatusUi()) {
    setRemoteStatus('连接失败：' + e.message, 'error');
    }
    if (opts.throwOnError) throw e;
    return { ok: false, stale: !stillCurrent, error: e.message || String(e) };
  } finally {
    if (btn && canUpdateStatusUi()) btn.disabled = false;
  }
}

function stopChatsUsingRemoteBinding(binding) {
  if (!binding || binding.type !== 'remote' || !window.AgentApp) return 0;
  let stopped = 0;
  try {
    const stateModule = window.AgentApp.require('state');
    const appState = stateModule && stateModule.state;
    const chats = [
      ...((appState && Array.isArray(appState.chats)) ? appState.chats : []),
      ...((appState && appState.temporaryChat) ? [appState.temporaryChat] : [])
    ];
    const seen = new Set();
    chats.forEach(chat => {
      if (!chat || !chat.id || seen.has(chat.id)) return;
      seen.add(chat.id);
      if (chat.backend && remoteConnectionMatchesBinding(binding, chat.backend)) {
        if (stateModule.requestStopChatTask(chat.id)) stopped += 1;
      }
    });
  } catch (e) {
    console.warn('[remote] stop related chats failed:', e);
  }
  return stopped;
}

async function disconnectRemoteAgent(options = {}) {
  const opts = (options && typeof options === 'object' && !('target' in options)) ? options : {};
  if (!opts.skipConfirm && !confirm('断开本地 SSH 隧道？如勾选停止远程 Agent，会尝试 kill 远程进程。')) return;
  const v = remoteFormValues();
  const stopRemoteEl = document.getElementById('remoteStopRemote');
  const stopRemote = Object.prototype.hasOwnProperty.call(opts, 'stopRemote')
    ? !!opts.stopRemote
    : !!(stopRemoteEl && stopRemoteEl.checked);
  try {
    if (!opts.silent) setRemoteStatus('正在断开...', 'loading');
    await remoteBackend('remote_disconnect', { password: v.password, stop_remote: stopRemote, requestTimeoutMs: 60000 });
  } catch (e) {
    console.warn('[remote] disconnect failed:', e);
  }
  clearRemoteAutoReconnectFlag();
  TERMINAL_CONFIG.serverUrl = REMOTE_CONTROLLER.serverUrl || 'http://localhost:8765';
  TERMINAL_CONFIG.remoteGitProxyUrl = '';
  if (opts.refreshWorkspace !== false) await refreshWorkspaceInfo();
  if (!opts.silent) setRemoteStatus(`已切回控制端 ${TERMINAL_CONFIG.serverUrl}`, 'ok');
}

disconnectRemoteAgent = async function(options = {}) {
  const opts = (options && typeof options === 'object' && !('target' in options)) ? options : {};
  if (
    opts.skipConfirm === true
    && opts.stopRemote === false
    && opts.silent === true
    && opts.refreshWorkspace === false
    && !opts.binding
    && !opts.serverUrl
    && !opts.connectionId
  ) {
    TERMINAL_CONFIG.serverUrl = REMOTE_CONTROLLER.serverUrl || 'http://localhost:8765';
    TERMINAL_CONFIG.remoteGitProxyUrl = '';
    return { ok: true, switchedLocalOnly: true };
  }
  if (!opts.skipConfirm && !confirm('断开选中的远程连接？')) return;
  const v = remoteFormValues();
  const cfg = loadRemoteConnectionConfig();
  const selected = REMOTE_SELECTED_CONNECTION && remoteConnectionMatchesBinding(REMOTE_SELECTED_CONNECTION, {
    type: 'remote',
    sshCommand: v.sshCommand || cfg.sshCommand,
    remoteWorkspace: v.remoteWorkspace || cfg.remoteWorkspace,
    remoteAgentPort: v.remoteAgentPort || cfg.remoteAgentPort,
    localPort: v.localPort || cfg.localPort
  }) ? REMOTE_SELECTED_CONNECTION : null;
  const targetBinding = normalizeBackendBinding(opts.binding || selected || {
    type: 'remote',
    serverUrl: opts.serverUrl || cfg.lastServerUrl || (isRemoteAgentActive() ? TERMINAL_CONFIG.serverUrl : ''),
    remoteGitProxyUrl: cfg.remoteGitProxyUrl || TERMINAL_CONFIG.remoteGitProxyUrl || '',
    sshCommand: v.sshCommand || cfg.sshCommand,
    remoteWorkspace: v.remoteWorkspace || cfg.remoteWorkspace,
    remoteAgentPort: v.remoteAgentPort || cfg.remoteAgentPort,
    localPort: v.localPort || cfg.localPort,
    heartbeatTimeout: v.heartbeatTimeout || cfg.heartbeatTimeout,
    installDeps: v.installDeps,
    encryptedPassword: cfg.encryptedPassword || '',
    connectionId: opts.connectionId || cfg.connectionId || ''
  });
  const stopRemoteEl = document.getElementById('remoteStopRemote');
  const stopRemote = Object.prototype.hasOwnProperty.call(opts, 'stopRemote')
    ? !!opts.stopRemote
    : !!(stopRemoteEl && stopRemoteEl.checked);
  try {
    if (!opts.silent) setRemoteStatus('正在断开选中的远程连接...', 'loading');
    const r = await remoteBackend('remote_disconnect', {
      ...remoteDisconnectPayloadForBinding(targetBinding),
      password: v.password,
      stop_remote: stopRemote,
      requestTimeoutMs: 60000
    });
    remoteStatusPayloadConnections(r);
    renderRemoteConnectionsList(REMOTE_CONNECTIONS_CACHE);
  } catch (e) {
    console.warn('[remote] disconnect failed:', e);
  }
  clearRemoteAutoReconnectFlag(targetBinding);
  const stopped = stopChatsUsingRemoteBinding(targetBinding);
  const targetIsCurrent = targetBinding.serverUrl && TERMINAL_CONFIG.serverUrl === targetBinding.serverUrl;
  if (targetIsCurrent) {
    TERMINAL_CONFIG.serverUrl = REMOTE_CONTROLLER.serverUrl || 'http://localhost:8765';
    TERMINAL_CONFIG.remoteGitProxyUrl = '';
    if (opts.refreshWorkspace !== false) await refreshWorkspaceInfo();
  }
  if (!opts.silent) {
    const suffix = stopped ? `，已停止 ${stopped} 个相关对话` : '';
    setRemoteStatus(targetIsCurrent ? `已切回控制端 ${TERMINAL_CONFIG.serverUrl}${suffix}` : `已断开选中的远程连接${suffix}`, 'ok');
  }
};

async function initRemoteConnection() {
  if (remoteAutoReconnectAttempted) return;
  remoteAutoReconnectAttempted = true;
  const currentBinding = currentChatBackendBinding();
  if (currentBinding && currentBinding.type) return;
  const cfg = loadRemoteConnectionConfig();
  if (!cfg.autoReconnect || !cfg.sshCommand || !cfg.remoteWorkspace) return;
  if (isRemoteAgentActive()) return;

  const password = await remoteDecryptPassword(cfg.encryptedPassword || '');
  applyRemoteConfigToForm(cfg, password);
  setRemoteStatus('正在恢复上次远程连接：' + cfg.remoteWorkspace, 'loading');
  await connectRemoteAgent({ autoReconnect: true, skipConfirm: true, silentSave: true });
}

async function checkRemoteStatus() {
  try {
    const r = await remoteBackend('remote_status', { requestTimeoutMs: 30000 });
    if (r.connected && r.reverse_git_proxy_url) {
      TERMINAL_CONFIG.remoteGitProxyUrl = r.reverse_git_proxy_url;
    } else if (!r.connected) {
      TERMINAL_CONFIG.remoteGitProxyUrl = '';
    }
    setRemoteStatus(
      r.connected ? `隧道在线：${r.server_url}，PID ${r.tunnel_pid}，心跳超时 ${r.heartbeat_timeout || REMOTE_HEARTBEAT_DEFAULT_SECONDS}s` : '当前没有活动远程隧道。', r.connected ? 'ok' : ''
    );
  } catch (e) {
    setRemoteStatus('状态检查失败：' + e.message, 'error');
  }
}

checkRemoteStatus = async function(options = {}) {
  try {
    const r = await remoteBackend('remote_status', { requestTimeoutMs: 30000 });
    const connections = remoteStatusPayloadConnections(r);
    renderRemoteConnectionsList(connections);
    const active = connections.find(c => c.connected && c.serverUrl === TERMINAL_CONFIG.serverUrl)
      || connections.find(c => c.connected)
      || (r.connected ? normalizeRemoteConnectionInfo(r) : null);
    if (active && active.connected && active.remoteGitProxyUrl && active.serverUrl === TERMINAL_CONFIG.serverUrl) {
      TERMINAL_CONFIG.remoteGitProxyUrl = active.remoteGitProxyUrl;
    } else if (!active || !active.connected) {
      TERMINAL_CONFIG.remoteGitProxyUrl = '';
    }
    if (!options.silent || active) {
      setRemoteStatus(
        active && active.connected
          ? `远程连接在线：${active.serverUrl}，PID ${active.tunnelPid || '-'}，共 ${connections.filter(c => c.connected).length} 个连接`
          : '当前没有活动远程连接。',
        active && active.connected ? 'ok' : ''
      );
    }
    return r;
  } catch (e) {
    setRemoteStatus('状态检查失败：' + e.message, 'error');
    throw e;
  }
};

window.openRemoteConnection = openRemoteConnection;
window.closeRemoteConnection = closeRemoteConnection;
window.saveRemoteConnectionFromUi = saveRemoteConnectionFromUi;
window.connectRemoteAgent = connectRemoteAgent;
window.disconnectRemoteAgent = disconnectRemoteAgent;
window.initRemoteConnection = initRemoteConnection;
window.noteRemoteWorkspaceChanged = noteRemoteWorkspaceChanged;
window.captureCurrentBackendBinding = captureCurrentBackendBinding;
window.applyBackendBinding = applyBackendBinding;
window.remoteBindingNeedsConnection = remoteBindingNeedsConnection;
window.checkRemoteStatus = checkRemoteStatus;
window.openRemoteDirPicker = openRemoteDirPicker;
window.refreshRemoteDirPicker = refreshRemoteDirPicker;
window.remoteDirGoHome = remoteDirGoHome;
window.remoteDirGoParent = remoteDirGoParent;
window.selectRemoteDirCurrent = selectRemoteDirCurrent;

window.AgentApp.define('remoteConnection', {
  openRemoteConnection,
  closeRemoteConnection,
  saveRemoteConnectionFromUi,
  connectRemoteAgent,
  disconnectRemoteAgent,
  initRemoteConnection,
  noteRemoteWorkspaceChanged,
  captureCurrentBackendBinding,
  applyBackendBinding,
  remoteBindingNeedsConnection,
  checkRemoteStatus,
  openRemoteDirPicker,
  refreshRemoteDirPicker,
  remoteDirGoHome,
  remoteDirGoParent,
  selectRemoteDirCurrent
});
