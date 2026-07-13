// ============ Sidebar File Explorer ============

const FileExplorerUiService = window.AgentApp.require('uiService');

function fileExplorerToast(message, ms) {
  FileExplorerUiService.toast(message, ms);
}

const FILE_EXPLORER_STATE = {
  visible: false,
  graphicalVisible: false,
  path: '.',
  loading: false,
  autoRefreshTimer: null,
  autoRefreshInFlight: false,
  autoRefreshSignature: '',
  autoRefreshPath: '.',
  uploading: false,
  clipboard: null,
  selectedItems: new Map(),
  dragItems: [],
  dragTargetPath: '',
  graphicalViewMode: 'large',
  graphicalSortField: 'name',
  graphicalSortDirection: 'asc',
  entries: [],
  editorPath: '',
  editorOriginal: '',
  editorMarkdownPreview: false,
  editorCodePreview: false,
  editorLoading: false,
  editorPythonMode: false,
  editorCodeMirror: null,
  inlineCodeMirror: null,
  editorFontSize: 13,
  editorFoldedLines: new Set(),
  editorBracketMatch: null,
  pdfPath: '',
  pdfObjectUrl: '',
  imagePath: '',
  imageObjectUrl: '',
  mediaPath: '',
  mediaObjectUrl: '',
  contextPath: '',
  contextType: '',
  mediaKind: '',
  contextScope: '',
  absolutePath: '',
  workspaceRoot: '',
  graphSearchQuery: '',
  graphSearchBasePath: '.',
  graphSearchResults: [],
  graphSearchLoading: false,
  graphSearchError: '',
  graphSearchTruncated: false,
  graphSearchTimer: null,
  graphSearchRequestId: 0,
  graphForwardStack: [],
  localDriveEntries: [],
  localDriveLoading: false,
  localDriveLoaded: false,
  localDrivePromise: null,
  inlineFilePath: '',
  inlineFileKind: '',
  inlineFileSide: 'right',
  inlineChatWidth: 50
};

const INLINE_FILE_MIN_WINDOW_WIDTH = 1100;
const INLINE_FILE_MIN_MAIN_WIDTH = 920;
const INLINE_FILE_MIN_CHAT_WIDTH = 460;
const INLINE_FILE_MIN_FILE_WIDTH = 360;
const GRAPHICAL_FILE_EXPLORER_RECENT_LIMIT = 10;
const FILE_EXPLORER_THIS_PC_PATH = '__agent_this_pc__';
const FILE_EXPLORER_THIS_PC_LABEL = '此电脑';
const FILE_EXPLORER_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const FILE_EXPLORER_QUICK_ACCESS_LEGACY_KEY = 'aichat_file_explorer_quick_access_v1';
const FILE_EXPLORER_QUICK_ACCESS_KEY_PREFIX = 'aichat_file_explorer_quick_access_v2';
const FILE_EXPLORER_QUICK_ACCESS_MAX = 10;
const FILE_EXPLORER_QUICK_ACCESS_LABEL_MAX = 40;
const FILE_EXPLORER_GRAPH_VIEW_STORAGE_KEY = 'aichat_file_explorer_graph_view_v1';
const FILE_EXPLORER_GRAPH_VIEW_MODES = [
  { id: 'xlarge', label: '超大图标' },
  { id: 'large', label: '大图标' },
  { id: 'medium', label: '中图标' },
  { id: 'small', label: '小图标' },
  { id: 'list', label: '列表' },
  { id: 'details', label: '详细信息' }
];
const FILE_EXPLORER_GRAPH_VIEW_MODE_IDS = new Set(FILE_EXPLORER_GRAPH_VIEW_MODES.map(mode => mode.id));
const FILE_EXPLORER_GRAPH_SORT_STORAGE_KEY = 'aichat_file_explorer_graph_sort_v1';
const FILE_EXPLORER_GRAPH_SORT_FIELDS = [
  { id: 'name', label: '名称' },
  { id: 'modified', label: '修改时间' },
  { id: 'type', label: '类型' }
];
const FILE_EXPLORER_GRAPH_SORT_DIRECTIONS = [
  { id: 'asc', label: '递增' },
  { id: 'desc', label: '递减' }
];
const FILE_EXPLORER_GRAPH_SORT_FIELD_IDS = new Set(FILE_EXPLORER_GRAPH_SORT_FIELDS.map(item => item.id));
const FILE_EXPLORER_GRAPH_SORT_DIRECTION_IDS = new Set(FILE_EXPLORER_GRAPH_SORT_DIRECTIONS.map(item => item.id));
const FILE_EXPLORER_EDITOR_FONT_SIZE_KEY = 'aichat_file_editor_font_size_v1';
const FILE_EXPLORER_EDITOR_FONT_SIZE_DEFAULT = 13;
const FILE_EXPLORER_EDITOR_FONT_SIZE_MIN = 10;
const FILE_EXPLORER_EDITOR_FONT_SIZE_MAX = 24;

function fileExplorerBackendContext(options = {}) {
  return {
    ...(options && typeof options === 'object' ? options : {}),
    allowFullAccess: true
  };
}

function fileExplorerStorageGet(key) {
  try {
    if (typeof storage !== 'undefined' && storage && typeof storage.get === 'function') return storage.get(key);
  } catch (_) {}
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function fileExplorerStorageSet(key, value) {
  try {
    if (typeof storage !== 'undefined' && storage && typeof storage.set === 'function') {
      storage.set(key, value);
      return;
    }
  } catch (_) {}
  try { localStorage.setItem(key, value); } catch (_) {}
}

function clampFileExplorerEditorFontSize(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return FILE_EXPLORER_EDITOR_FONT_SIZE_DEFAULT;
  return Math.max(FILE_EXPLORER_EDITOR_FONT_SIZE_MIN, Math.min(FILE_EXPLORER_EDITOR_FONT_SIZE_MAX, Math.round(num)));
}

function fileExplorerEditorLineHeight(fontSize = FILE_EXPLORER_STATE.editorFontSize) {
  return Math.round(clampFileExplorerEditorFontSize(fontSize) * 1.6 * 10) / 10;
}

function loadFileExplorerEditorFontSize() {
  const stored = fileExplorerStorageGet(FILE_EXPLORER_EDITOR_FONT_SIZE_KEY);
  return clampFileExplorerEditorFontSize(stored || FILE_EXPLORER_EDITOR_FONT_SIZE_DEFAULT);
}

function applyFileExplorerEditorFontSize() {
  const fontSize = clampFileExplorerEditorFontSize(FILE_EXPLORER_STATE.editorFontSize);
  const lineHeight = fileExplorerEditorLineHeight(fontSize);
  [fileEditorCodeShell(), inlineFileCodeShell()].forEach(shell => {
    if (!shell) return;
    shell.style.setProperty('--editor-font-size', `${fontSize}px`);
    shell.style.setProperty('--editor-line-height', `${lineHeight}px`);
    if (shell.classList.contains('python-editor')) {
      shell.style.setProperty('--editor-gutter-width', `${Math.round(fontSize * 4.2)}px`);
    } else {
      shell.style.removeProperty('--editor-gutter-width');
    }
  });
  if (FILE_EXPLORER_STATE.editorPythonMode) {
    renderPythonEditor();
    syncPythonEditorScroll();
  }
  refreshFileEditorCodeMirror();
  refreshInlineCodeMirror();
}

function setFileExplorerEditorFontSize(value, options = {}) {
  const next = clampFileExplorerEditorFontSize(value);
  FILE_EXPLORER_STATE.editorFontSize = next;
  if (options.persist !== false) fileExplorerStorageSet(FILE_EXPLORER_EDITOR_FONT_SIZE_KEY, String(next));
  applyFileExplorerEditorFontSize();
  return next;
}

function handleFileExplorerEditorWheelZoom(event) {
  if (!event || !event.ctrlKey || event.deltaY === 0) return;
  event.preventDefault();
  event.stopPropagation();
  const direction = event.deltaY < 0 ? 1 : -1;
  setFileExplorerEditorFontSize(FILE_EXPLORER_STATE.editorFontSize + direction);
}

function bindFileExplorerEditorWheelZoom(shell) {
  if (!shell || shell.dataset.editorWheelZoomBound === '1') return;
  shell.dataset.editorWheelZoomBound = '1';
  shell.addEventListener('wheel', handleFileExplorerEditorWheelZoom, { passive: false });
  shell.title = shell.title || '按住 Ctrl 并滚动鼠标滚轮可调整编辑器字号';
  applyFileExplorerEditorFontSize();
}

function normalizeGraphicalFileExplorerViewMode(mode) {
  const normalized = String(mode || '').trim();
  return FILE_EXPLORER_GRAPH_VIEW_MODE_IDS.has(normalized) ? normalized : 'large';
}

function graphicalFileExplorerViewMode() {
  FILE_EXPLORER_STATE.graphicalViewMode = normalizeGraphicalFileExplorerViewMode(FILE_EXPLORER_STATE.graphicalViewMode);
  return FILE_EXPLORER_STATE.graphicalViewMode;
}

function graphicalFileExplorerViewModeInfo(mode = FILE_EXPLORER_STATE.graphicalViewMode) {
  const normalized = normalizeGraphicalFileExplorerViewMode(mode);
  return FILE_EXPLORER_GRAPH_VIEW_MODES.find(item => item.id === normalized) || FILE_EXPLORER_GRAPH_VIEW_MODES[1];
}

function loadGraphicalFileExplorerViewMode() {
  FILE_EXPLORER_STATE.graphicalViewMode = normalizeGraphicalFileExplorerViewMode(
    fileExplorerStorageGet(FILE_EXPLORER_GRAPH_VIEW_STORAGE_KEY) || FILE_EXPLORER_STATE.graphicalViewMode
  );
  return FILE_EXPLORER_STATE.graphicalViewMode;
}

function setGraphicalFileExplorerViewMode(mode) {
  const next = normalizeGraphicalFileExplorerViewMode(mode);
  FILE_EXPLORER_STATE.graphicalViewMode = next;
  fileExplorerStorageSet(FILE_EXPLORER_GRAPH_VIEW_STORAGE_KEY, next);
  renderGraphicalFileExplorer();
}

function normalizeGraphicalFileExplorerSortField(field) {
  const normalized = String(field || '').trim();
  return FILE_EXPLORER_GRAPH_SORT_FIELD_IDS.has(normalized) ? normalized : 'name';
}

function normalizeGraphicalFileExplorerSortDirection(direction) {
  const normalized = String(direction || '').trim();
  return FILE_EXPLORER_GRAPH_SORT_DIRECTION_IDS.has(normalized) ? normalized : 'asc';
}

function graphicalFileExplorerSortField() {
  FILE_EXPLORER_STATE.graphicalSortField = normalizeGraphicalFileExplorerSortField(FILE_EXPLORER_STATE.graphicalSortField);
  return FILE_EXPLORER_STATE.graphicalSortField;
}

function graphicalFileExplorerSortDirection() {
  FILE_EXPLORER_STATE.graphicalSortDirection = normalizeGraphicalFileExplorerSortDirection(FILE_EXPLORER_STATE.graphicalSortDirection);
  return FILE_EXPLORER_STATE.graphicalSortDirection;
}

function graphicalFileExplorerSortFieldInfo(field = FILE_EXPLORER_STATE.graphicalSortField) {
  const normalized = normalizeGraphicalFileExplorerSortField(field);
  return FILE_EXPLORER_GRAPH_SORT_FIELDS.find(item => item.id === normalized) || FILE_EXPLORER_GRAPH_SORT_FIELDS[0];
}

function graphicalFileExplorerSortDirectionInfo(direction = FILE_EXPLORER_STATE.graphicalSortDirection) {
  const normalized = normalizeGraphicalFileExplorerSortDirection(direction);
  return FILE_EXPLORER_GRAPH_SORT_DIRECTIONS.find(item => item.id === normalized) || FILE_EXPLORER_GRAPH_SORT_DIRECTIONS[0];
}

function loadGraphicalFileExplorerSort() {
  try {
    const parsed = JSON.parse(fileExplorerStorageGet(FILE_EXPLORER_GRAPH_SORT_STORAGE_KEY) || '{}');
    FILE_EXPLORER_STATE.graphicalSortField = normalizeGraphicalFileExplorerSortField(parsed.field);
    FILE_EXPLORER_STATE.graphicalSortDirection = normalizeGraphicalFileExplorerSortDirection(parsed.direction);
  } catch (_) {
    FILE_EXPLORER_STATE.graphicalSortField = 'name';
    FILE_EXPLORER_STATE.graphicalSortDirection = 'asc';
  }
  return {
    field: FILE_EXPLORER_STATE.graphicalSortField,
    direction: FILE_EXPLORER_STATE.graphicalSortDirection
  };
}

function setGraphicalFileExplorerSort(field = FILE_EXPLORER_STATE.graphicalSortField, direction = FILE_EXPLORER_STATE.graphicalSortDirection) {
  const nextField = normalizeGraphicalFileExplorerSortField(field);
  const nextDirection = normalizeGraphicalFileExplorerSortDirection(direction);
  FILE_EXPLORER_STATE.graphicalSortField = nextField;
  FILE_EXPLORER_STATE.graphicalSortDirection = nextDirection;
  fileExplorerStorageSet(FILE_EXPLORER_GRAPH_SORT_STORAGE_KEY, JSON.stringify({
    field: nextField,
    direction: nextDirection
  }));
  renderGraphicalFileExplorer();
}

const FILE_EXPLORER_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'php',
  'rb', 'swift', 'kt', 'kts', 'sql', 'sh', 'bash', 'zsh', 'ps1',
  'bat', 'cmd', 'tex', 'gitignore', 'dockerfile', 'env', 'log', 'csv',
  'tsv', 'properties'
]);

function normalizeExplorerPath(path) {
  let p = String(path || '.').replace(/\\/g, '/').trim();
  if (!p) return '.';
  if (p === '/') return '/';
  if (/^[A-Za-z]:\/?$/.test(p)) return `${p.charAt(0).toUpperCase()}:/`;
  if (/^\/\/[^/]+\/[^/]+/.test(p)) return p.replace(/\/+$/g, '');
  if (isAbsoluteExplorerPath(p)) return p.replace(/\/+$/g, '') || '/';
  p = p.replace(/^\/+/, '').replace(/\/+$/g, '');
  return p || '.';
}

function fileExplorerComparablePath(path) {
  return String(path || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
}

function isWindowsAbsoluteExplorerPath(path) {
  const raw = String(path || '').trim();
  return /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\]+\\[^\\]+/.test(raw) || /^\/\/[^/]+\/[^/]+/.test(raw);
}

function isPosixAbsoluteExplorerPath(path) {
  const raw = String(path || '').trim();
  return raw.startsWith('/') && !raw.startsWith('//');
}

function isAbsoluteExplorerPath(path) {
  return isWindowsAbsoluteExplorerPath(path) || isPosixAbsoluteExplorerPath(path);
}

function isFileExplorerThisPcPath(path) {
  return String(path || '').trim() === FILE_EXPLORER_THIS_PC_PATH;
}

function canUseFileExplorerThisPcRoot() {
  return !isFileExplorerRemoteMode() && (
    fileExplorerClientLooksWindows()
    || isWindowsAbsoluteExplorerPath(fileExplorerWorkspaceRoot())
    || isWindowsAbsoluteExplorerPath(FILE_EXPLORER_STATE.absolutePath)
  );
}

function fileExplorerRelativeToWorkspace(path) {
  const root = fileExplorerComparablePath(fileExplorerWorkspaceRoot());
  const target = fileExplorerComparablePath(path);
  if (!root || !target || !isAbsoluteExplorerPath(target)) return '';
  const caseInsensitive = isWindowsAbsoluteExplorerPath(root) || isWindowsAbsoluteExplorerPath(target);
  const cmpRoot = caseInsensitive ? root.toLowerCase() : root;
  const cmpTarget = caseInsensitive ? target.toLowerCase() : target;
  if (cmpTarget === cmpRoot) return '.';
  if (cmpTarget.startsWith(`${cmpRoot}/`)) return target.slice(root.length + 1) || '.';
  return '';
}

function resolveFileExplorerOpenPath(path) {
  const raw = String(path || '').trim();
  if (!raw) return { ok: false, error: '路径为空' };

  const relative = fileExplorerRelativeToWorkspace(raw);
  if (relative) return { ok: true, path: normalizeExplorerPath(relative) };

  const workspaceRoot = fileExplorerWorkspaceRoot();
  if (isFileExplorerRemoteMode() && isWindowsAbsoluteExplorerPath(raw) && !isWindowsAbsoluteExplorerPath(workspaceRoot)) {
    return {
      ok: false,
      error: `当前连接的是远程工作区，不能打开本机 Windows 路径：${raw}`
    };
  }

  return { ok: true, path: normalizeExplorerPath(raw) };
}

function isBareFileExplorerFileReference(path) {
  const raw = String(path || '').trim();
  if (!raw || raw.includes('/') || raw.includes('\\')) return false;
  if (isAbsoluteExplorerPath(raw) || raw.includes('..')) return false;
  return /^[\w@.+\-\u4e00-\u9fa5 ]+\.[A-Za-z0-9]{1,12}$/.test(raw);
}

async function resolveBareFileExplorerFileReference(path) {
  const name = String(path || '').trim();
  if (!isBareFileExplorerFileReference(name)) return { ok: true, path: name };
  if (typeof callAgentBackend !== 'function') return { ok: false, error: 'File explorer backend is not loaded' };
  const r = await callAgentBackend(
    'find_file',
    { path: '.', name, max_results: 20 },
    undefined,
    undefined,
    fileExplorerBackendContext()
  );
  if (typeof r === 'string') return { ok: false, error: r };
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || `Unable to find file: ${name}` };
  const matches = Array.isArray(r.matches) ? r.matches : [];
  if (matches.length === 1 && matches[0] && matches[0].path) {
    return { ok: true, path: normalizeExplorerPath(matches[0].path) };
  }
  if (!matches.length) {
    return { ok: false, error: `File not found: ${name}` };
  }
  const shown = matches.slice(0, 5).map(m => m && m.path ? m.path : '').filter(Boolean).join('\n');
  const more = r.truncated || matches.length > 5 ? '\n...' : '';
  return {
    ok: false,
    error: `Multiple files named ${name}; use a more specific relative path:\n${shown}${more}`
  };
}

function joinExplorerPath(base, name) {
  const root = normalizeExplorerPath(base);
  const cleanName = String(name || '').replace(/[\\/]+/g, '/').replace(/^\/+/, '').replace(/\/+$/g, '');
  if (!cleanName) return root;
  if (root === '/') return `/${cleanName}`;
  if (/^[A-Za-z]:\/?$/.test(root)) return `${root.replace(/\/?$/, '/')}${cleanName}`;
  return root === '.' ? cleanName : `${root}/${cleanName}`;
}

function parentExplorerPath(path) {
  const p = normalizeExplorerPath(path);
  if (p === '.') return '.';
  if (p === '/') return '/';
  if (/^[A-Za-z]:\/?$/.test(p)) return `${p.charAt(0).toUpperCase()}:/`;
  if (/^[A-Za-z]:\//.test(p)) {
    const drive = p.slice(0, 3);
    const rest = p.slice(3).split('/').filter(Boolean);
    if (!rest.length) return drive;
    rest.pop();
    return rest.length ? `${drive}${rest.join('/')}` : drive;
  }
  if (p.startsWith('/')) {
    const parts = p.slice(1).split('/').filter(Boolean);
    if (!parts.length) return '/';
    parts.pop();
    return parts.length ? `/${parts.join('/')}` : '/';
  }
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? parts.join('/') : '.';
}

function currentFileExplorerParentPath() {
  const current = normalizeExplorerPath(FILE_EXPLORER_STATE.path);
  if (isFileExplorerThisPcPath(current)) return current;
  if (canUseFileExplorerThisPcRoot() && /^[A-Za-z]:\/?$/.test(current)) return FILE_EXPLORER_THIS_PC_PATH;
  if (current === '.') {
    const absolute = trimFileExplorerAbsolutePath(FILE_EXPLORER_STATE.absolutePath || fileExplorerWorkspaceRoot());
    if (absolute) {
      const normalizedAbsolute = normalizeExplorerPath(absolute);
      const parent = parentExplorerPath(normalizedAbsolute);
      if (parent && parent !== normalizedAbsolute) return parent;
    }
  }
  return parentExplorerPath(current);
}

function trimFileExplorerAbsolutePath(path) {
  const raw = String(path || '').trim();
  if (!raw) return '';
  const trimmed = raw.replace(/[\\/]+$/g, '');
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`;
  if (!trimmed && /^[\\/]+$/.test(raw)) return raw.charAt(0);
  return trimmed || raw;
}

function fileExplorerPathSeparator(path) {
  return String(path || '').includes('\\') ? '\\' : '/';
}

function joinFileExplorerAbsolutePath(basePath, relativePath) {
  const base = trimFileExplorerAbsolutePath(basePath);
  const relative = normalizeExplorerPath(relativePath);
  if (!base || relative === '.') return base;
  const sep = fileExplorerPathSeparator(base);
  const prefix = /[\\/]$/.test(base) ? base : `${base}${sep}`;
  return prefix + relative.split('/').filter(Boolean).join(sep);
}

function fileExplorerWorkspaceRoot() {
  if (typeof TERMINAL_CONFIG !== 'undefined' && TERMINAL_CONFIG.workspace) {
    return trimFileExplorerAbsolutePath(TERMINAL_CONFIG.workspace);
  }
  if (FILE_EXPLORER_STATE.workspaceRoot) {
    return trimFileExplorerAbsolutePath(FILE_EXPLORER_STATE.workspaceRoot);
  }
  return '';
}

function noteFileExplorerAbsolutePath(absolutePath, relativePath = FILE_EXPLORER_STATE.path) {
  const absolute = trimFileExplorerAbsolutePath(absolutePath);
  if (!absolute) return;
  FILE_EXPLORER_STATE.absolutePath = absolute;
  if (normalizeExplorerPath(relativePath) === '.') {
    FILE_EXPLORER_STATE.workspaceRoot = absolute;
  }
}

function fileExplorerPathRelativeToCurrent(path) {
  const normalizedPath = normalizeExplorerPath(path);
  const currentPath = normalizeExplorerPath(FILE_EXPLORER_STATE.path);
  if (normalizedPath === currentPath) return '.';
  if (currentPath === '.') return normalizedPath;
  if (normalizedPath.startsWith(`${currentPath}/`)) {
    return normalizedPath.slice(currentPath.length + 1);
  }
  return '';
}

function fileExplorerAbsolutePathFor(path) {
  const normalizedPath = normalizeExplorerPath(path);
  if (isFileExplorerThisPcPath(normalizedPath)) return '';
  if (isAbsoluteExplorerPath(normalizedPath)) return trimFileExplorerAbsolutePath(normalizedPath);
  const currentAbsolute = trimFileExplorerAbsolutePath(FILE_EXPLORER_STATE.absolutePath);
  const currentRelative = fileExplorerPathRelativeToCurrent(normalizedPath);
  if (currentAbsolute && currentRelative) {
    return joinFileExplorerAbsolutePath(currentAbsolute, currentRelative);
  }
  return joinFileExplorerAbsolutePath(fileExplorerWorkspaceRoot(), normalizedPath);
}

function fileExplorerQuickAccessKey(path) {
  const normalized = normalizeExplorerPath(path);
  return isWindowsAbsoluteExplorerPath(normalized) ? normalized.toLowerCase() : normalized;
}

function fileExplorerNormalizeBackendUrl(url) {
  return String(url || '').trim().replace(/\/+$/g, '').toLowerCase();
}

function fileExplorerNormalizeSshCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

function fileExplorerRemoteConnectionConfigSnapshot() {
  try {
    if (typeof loadRemoteConnectionConfig === 'function') {
      const cfg = loadRemoteConnectionConfig();
      return cfg && typeof cfg === 'object' ? cfg : {};
    }
  } catch (_) {}
  return {};
}

function fileExplorerQuickAccessScope() {
  const controllerUrl = typeof REMOTE_CONTROLLER !== 'undefined' && REMOTE_CONTROLLER && REMOTE_CONTROLLER.serverUrl
    ? REMOTE_CONTROLLER.serverUrl
    : ((typeof TERMINAL_CONFIG !== 'undefined' && TERMINAL_CONFIG.serverUrl) || 'http://localhost:8765');
  if (!isFileExplorerRemoteMode()) return `local|${fileExplorerNormalizeBackendUrl(controllerUrl)}`;

  const cfg = fileExplorerRemoteConnectionConfigSnapshot();
  const sshCommand = fileExplorerNormalizeSshCommand(cfg.sshCommand || cfg.ssh_command || '');
  const remoteAgentPort = String(cfg.remoteAgentPort || cfg.remote_agent_port || '').trim();
  const fallbackUrl = fileExplorerNormalizeBackendUrl((typeof TERMINAL_CONFIG !== 'undefined' && TERMINAL_CONFIG.serverUrl) || '');
  if (sshCommand) return `remote|ssh:${sshCommand}|agent:${remoteAgentPort || 'default'}`;
  return `remote|url:${fallbackUrl || 'unknown'}`;
}

function fileExplorerQuickAccessStorageKey() {
  return `${FILE_EXPLORER_QUICK_ACCESS_KEY_PREFIX}:${encodeURIComponent(fileExplorerQuickAccessScope())}`;
}

function fileExplorerClientLooksWindows() {
  try {
    const platform = (navigator && navigator.userAgentData && navigator.userAgentData.platform)
      || (navigator && navigator.platform)
      || '';
    return /win/i.test(String(platform));
  } catch (_) {
    return false;
  }
}

function fileExplorerQuickAccessPathMatchesBackend(path) {
  const normalized = normalizeExplorerPath(path);
  if (!normalized || normalized === '.' || !isAbsoluteExplorerPath(normalized)) return false;
  let workspaceRoot = normalizeExplorerPath(fileExplorerWorkspaceRoot());
  if ((!workspaceRoot || !isAbsoluteExplorerPath(workspaceRoot)) && isFileExplorerRemoteMode()) {
    const cfg = fileExplorerRemoteConnectionConfigSnapshot();
    workspaceRoot = normalizeExplorerPath(cfg.remoteWorkspace || cfg.workspace || '');
  }
  if (!workspaceRoot || !isAbsoluteExplorerPath(workspaceRoot)) {
    if (!isFileExplorerRemoteMode() && fileExplorerClientLooksWindows()) return isWindowsAbsoluteExplorerPath(normalized);
    return true;
  }
  if (isWindowsAbsoluteExplorerPath(workspaceRoot)) return isWindowsAbsoluteExplorerPath(normalized);
  if (isPosixAbsoluteExplorerPath(workspaceRoot)) return isPosixAbsoluteExplorerPath(normalized);
  return true;
}

function normalizeFileExplorerQuickAccessRows(rows) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(rows) ? rows : []) {
    const path = normalizeExplorerPath(item && typeof item === 'object' ? item.path : item);
    if (!fileExplorerQuickAccessPathMatchesBackend(path)) continue;
    const key = fileExplorerQuickAccessKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = item && typeof item === 'object' ? String(item.label || '').trim() : '';
    out.push(label ? { path, label } : { path });
    if (out.length >= FILE_EXPLORER_QUICK_ACCESS_MAX) break;
  }
  return out;
}

function readFileExplorerQuickAccessRows(key) {
  try {
    const raw = fileExplorerStorageGet(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return {
      found: raw !== null && raw !== undefined,
      rows: Array.isArray(parsed) ? parsed : []
    };
  } catch (_) {
    return { found: true, rows: [] };
  }
}

function loadFileExplorerQuickAccess() {
  const key = fileExplorerQuickAccessStorageKey();
  const scoped = readFileExplorerQuickAccessRows(key);
  if (scoped.found) return normalizeFileExplorerQuickAccessRows(scoped.rows);

  if (!isFileExplorerRemoteMode()) {
    const legacy = normalizeFileExplorerQuickAccessRows(readFileExplorerQuickAccessRows(FILE_EXPLORER_QUICK_ACCESS_LEGACY_KEY).rows);
    if (legacy.length) saveFileExplorerQuickAccess(legacy);
    return legacy;
  }

  return [];
}

function saveFileExplorerQuickAccess(rows) {
  fileExplorerStorageSet(
    fileExplorerQuickAccessStorageKey(),
    JSON.stringify(normalizeFileExplorerQuickAccessRows(rows))
  );
}

function shortenFileExplorerQuickAccessPath(path) {
  const text = String(path || '');
  if (fileExplorerQuickAccessLabelWidth(text) <= FILE_EXPLORER_QUICK_ACCESS_LABEL_MAX) return text;
  return `...${fileExplorerQuickAccessTailByWidth(text, FILE_EXPLORER_QUICK_ACCESS_LABEL_MAX - 3)}`;
}

function fileExplorerQuickAccessLabelWidth(text) {
  let width = 0;
  for (const char of String(text || '')) width += fileExplorerQuickAccessCharWidth(char);
  return width;
}

function fileExplorerQuickAccessTailByWidth(text, maxWidth) {
  const chars = Array.from(String(text || ''));
  let width = 0;
  let tail = '';
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const char = chars[i];
    const charWidth = fileExplorerQuickAccessCharWidth(char);
    if (width + charWidth > maxWidth) break;
    tail = `${char}${tail}`;
    width += charWidth;
  }
  return tail;
}

function fileExplorerQuickAccessCharWidth(char) {
  return (char.codePointAt(0) || 0) > 0xff ? 2 : 1;
}

function currentFileExplorerAbsoluteDir() {
  return normalizeExplorerPath(fileExplorerAbsolutePathFor(FILE_EXPLORER_STATE.path) || FILE_EXPLORER_STATE.path);
}

function currentFileExplorerQuickAccessIndex(rows = loadFileExplorerQuickAccess()) {
  const key = fileExplorerQuickAccessKey(currentFileExplorerAbsoluteDir());
  return rows.findIndex(item => fileExplorerQuickAccessKey(item.path) === key);
}

function currentFileExplorerIsSandboxRoot() {
  if (normalizeExplorerPath(FILE_EXPLORER_STATE.path) === '.') return true;
  const root = fileExplorerWorkspaceRoot();
  return !!root && fileExplorerQuickAccessKey(currentFileExplorerAbsoluteDir()) === fileExplorerQuickAccessKey(root);
}

function fileExplorerQuickAccessDisplayLabel(item) {
  const label = item && typeof item === 'object' ? String(item.label || '').trim() : '';
  if (label) return label;
  const path = normalizeExplorerPath(item && typeof item === 'object' ? item.path : item);
  return fileExplorerBasename(path) || shortenFileExplorerQuickAccessPath(path);
}

function normalizeFileExplorerLocalDriveEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const normalizedPath = normalizeExplorerPath(source.path || source.name || entry);
  if (!/^[A-Za-z]:\/?$/.test(normalizedPath)) return null;
  const name = `${normalizedPath.charAt(0).toUpperCase()}:`;
  return {
    ...source,
    name,
    path: normalizedPath,
    type: 'dir',
    drive: true,
    meta: source.meta || '本地磁盘'
  };
}

function sortedFileExplorerLocalDrives(entries = FILE_EXPLORER_STATE.localDriveEntries) {
  const seen = new Set();
  const drives = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const drive = normalizeFileExplorerLocalDriveEntry(entry);
    if (!drive) continue;
    const key = fileExplorerQuickAccessKey(drive.path);
    if (seen.has(key)) continue;
    seen.add(key);
    drives.push(drive);
  }
  return drives.sort((a, b) => String(a.name || a.path).localeCompare(String(b.name || b.path), 'en', {
    numeric: true,
    sensitivity: 'base'
  }));
}

function syncFileExplorerLocalDrives(entries) {
  const drives = sortedFileExplorerLocalDrives(entries);
  FILE_EXPLORER_STATE.localDriveEntries = drives;
  FILE_EXPLORER_STATE.localDriveLoaded = true;
  return drives;
}

async function ensureFileExplorerLocalDrives(options = {}) {
  if (!canUseFileExplorerThisPcRoot()) {
    FILE_EXPLORER_STATE.localDriveEntries = [];
    FILE_EXPLORER_STATE.localDriveLoaded = false;
    FILE_EXPLORER_STATE.localDriveLoading = false;
    FILE_EXPLORER_STATE.localDrivePromise = null;
    return [];
  }
  if (FILE_EXPLORER_STATE.localDriveLoaded && options.force !== true) {
    return FILE_EXPLORER_STATE.localDriveEntries;
  }
  if (FILE_EXPLORER_STATE.localDrivePromise) return FILE_EXPLORER_STATE.localDrivePromise;
  FILE_EXPLORER_STATE.localDriveLoading = true;
  FILE_EXPLORER_STATE.localDrivePromise = (async () => {
    try {
      if (typeof callAgentBackend !== 'function') throw new Error('本地工具接口未加载');
      const r = await callAgentBackend('list_drives', {}, undefined, undefined, fileExplorerBackendContext());
      if (typeof r === 'string') throw new Error(r);
      if (!r || !r.ok) throw new Error((r && r.error) || '读取本机磁盘失败');
      const drives = syncFileExplorerLocalDrives(Array.isArray(r.entries) ? r.entries : []);
      renderGraphicalFileExplorerQuickAccess();
      updateGraphicalFileExplorerToolbar();
      return drives;
    } catch (_) {
      return FILE_EXPLORER_STATE.localDriveEntries;
    } finally {
      FILE_EXPLORER_STATE.localDriveLoading = false;
      FILE_EXPLORER_STATE.localDrivePromise = null;
    }
  })();
  return FILE_EXPLORER_STATE.localDrivePromise;
}

function removeCurrentFolderFromQuickAccess() {
  const rows = loadFileExplorerQuickAccess();
  const index = currentFileExplorerQuickAccessIndex(rows);
  if (index < 0) {
    fileExplorerToast('当前目录不在快速访问中');
    return;
  }
  const removed = rows[index].path;
  rows.splice(index, 1);
  saveFileExplorerQuickAccess(rows);
  renderFileExplorer();
  fileExplorerToast(`已移出快速访问：${shortenFileExplorerQuickAccessPath(removed)}`);
}

function quickAccessIndexForPath(path, rows = loadFileExplorerQuickAccess()) {
  const key = fileExplorerQuickAccessKey(path);
  return rows.findIndex(item => fileExplorerQuickAccessKey(item.path) === key);
}

function renameFileExplorerQuickAccessPath(path = FILE_EXPLORER_STATE.contextPath) {
  const rows = loadFileExplorerQuickAccess();
  const index = quickAccessIndexForPath(path, rows);
  if (index < 0) {
    fileExplorerToast('快速访问条目不存在');
    return;
  }
  const currentLabel = fileExplorerQuickAccessDisplayLabel(rows[index]);
  const nextLabel = prompt('输入快速访问名称', currentLabel);
  if (nextLabel === null) return;
  const label = String(nextLabel || '').trim();
  if (!label) {
    fileExplorerToast('名称不能为空');
    return;
  }
  rows[index] = { ...rows[index], label };
  saveFileExplorerQuickAccess(rows);
  renderFileExplorer();
  fileExplorerToast(`已重命名快速访问：${label}`);
}

function removeFileExplorerQuickAccessPath(path = FILE_EXPLORER_STATE.contextPath) {
  const rows = loadFileExplorerQuickAccess();
  const index = quickAccessIndexForPath(path, rows);
  if (index < 0) {
    fileExplorerToast('快速访问条目不存在');
    return;
  }
  const [removed] = rows.splice(index, 1);
  saveFileExplorerQuickAccess(rows);
  renderFileExplorer();
  fileExplorerToast(`已删除快速访问：${fileExplorerQuickAccessDisplayLabel(removed)}`);
}

function isFileExplorerRemoteMode() {
  return typeof isRemoteAgentActive === 'function' && isRemoteAgentActive();
}

function requireFileExplorerRemoteAction() {
  if (isFileExplorerRemoteMode()) return true;
  fileExplorerToast('远程连接时可用');
  return false;
}

function isFileExplorerRemoteOnlyAction(action) {
  return action === 'download' || action === 'upload-files' || action === 'upload-folder';
}

function setFileExplorerPathDisplay(path) {
  const pathEl = document.getElementById('fileExplorerPath');
  if (!pathEl) return;
  const normalized = normalizeExplorerPath(path);
  const label = isFileExplorerThisPcPath(normalized) ? FILE_EXPLORER_THIS_PC_LABEL : normalized;
  pathEl.textContent = label;
  pathEl.title = label;
  pathEl.setAttribute('aria-label', label);
}

function fileExplorerIcon(entry) {
  if (entry && entry.drive) return '💽';
  if (entry && entry.meta === '本地磁盘') return '💽';
  if (!entry || entry.type === 'dir') return '📁';
  const name = String(entry.name || '').toLowerCase();
  if (/\.(html?|css|js|ts|tsx|jsx|py|json|md|txt|bat|cmd|sh|yml|yaml)$/.test(name)) return '📄';
  if (/\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|avif)$/.test(name)) return '🖼️';
  if (/\.pdf$/.test(name)) return '📕';
  if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/.test(name)) return '🎵';
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(name)) return '🎬';
  return '📄';
}

function fileExplorerExtension(path) {
  const name = String(path || '').split('/').pop().toLowerCase();
  if (!name) return '';
  if (name === 'dockerfile' || name === 'makefile' || name === 'license') return name;
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1) : '';
}

function isFileExplorerTextFile(path) {
  return FILE_EXPLORER_TEXT_EXTENSIONS.has(fileExplorerExtension(path));
}

function isFileExplorerMarkdownFile(path) {
  return /^(md|markdown)$/i.test(fileExplorerExtension(path));
}

function isFileExplorerPythonFile(path) {
  return /^py$/i.test(fileExplorerExtension(path));
}

function isFileExplorerTexFile(path) {
  return /^tex$/i.test(fileExplorerExtension(path));
}

function isFileExplorerPdfFile(path) {
  return fileExplorerExtension(path) === 'pdf';
}

function isFileExplorerImageFile(path) {
  return /^(png|jpe?g|gif|webp|svg|bmp|ico|tiff?|avif)$/i.test(fileExplorerExtension(path));
}

function isFileExplorerAudioFile(path) {
  return /^(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(fileExplorerExtension(path));
}

function isFileExplorerVideoFile(path) {
  return /^(mp4|webm|mov|m4v|ogv)$/i.test(fileExplorerExtension(path));
}

function isFileExplorerMediaFile(path) {
  return isFileExplorerAudioFile(path) || isFileExplorerVideoFile(path);
}

async function fileExplorerPreviewUrl(path) {
  if (typeof TERMINAL_CONFIG === 'undefined') throw new Error('本地服务配置未加载');
  const base = (TERMINAL_CONFIG.serverUrl || 'http://localhost:8765').replace(/\/+$/, '');
  return `${base}/preview-file?path=${encodeURIComponent(normalizeExplorerPath(path))}&allow_full_access=1`;
}

function setFileEditorStatus(message, kind = '') {
  const el = document.getElementById('fileEditorStatus');
  if (!el) return;
  el.textContent = message || '';
  el.className = kind ? `file-editor-status ${kind}` : 'file-editor-status';
}

function fileEditorTextarea() {
  return document.getElementById('fileEditorContent');
}

function fileEditorCodeShell() {
  return document.getElementById('fileEditorCodeShell');
}

function fileEditorCodeGutter() {
  return document.getElementById('fileEditorCodeGutter');
}

function fileEditorCodeHighlight() {
  return document.querySelector('#fileEditorCodeHighlight code');
}

function hasFileEditorCodeMirror() {
  return typeof window !== 'undefined' && typeof window.CodeMirror === 'function';
}

function defineFileExplorerSimpleMode(name, options = {}) {
  if (!hasFileEditorCodeMirror()) return false;
  const CodeMirror = window.CodeMirror;
  if (CodeMirror.modes && CodeMirror.modes[name]) return true;
  const keywords = new Set(options.keywords || []);
  const atoms = new Set(options.atoms || ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
  const builtin = new Set(options.builtin || []);
  const lineComment = Object.prototype.hasOwnProperty.call(options, 'lineComment') ? options.lineComment : '//';
  const blockCommentStart = Object.prototype.hasOwnProperty.call(options, 'blockCommentStart') ? options.blockCommentStart : '/*';
  const blockCommentEnd = Object.prototype.hasOwnProperty.call(options, 'blockCommentEnd') ? options.blockCommentEnd : '*/';
  const numberPattern = options.numberPattern || /^(?:0x[\da-f]+|0b[01]+|\d+(?:\.\d+)?(?:e[+\-]?\d+)?)/i;
  const variablePattern = options.variablePattern || /^[A-Za-z_$][\w$-]*/;

  CodeMirror.defineMode(name, function() {
    return {
      startState() {
        return { inBlockComment: false };
      },
      token(stream, state) {
        if (state.inBlockComment) {
          if (stream.skipTo(blockCommentEnd)) {
            stream.match(blockCommentEnd);
            state.inBlockComment = false;
          } else {
            stream.skipToEnd();
          }
          return 'comment';
        }
        if (stream.eatSpace()) return null;
        if (lineComment && stream.match(lineComment)) {
          stream.skipToEnd();
          return 'comment';
        }
        if (blockCommentStart && stream.match(blockCommentStart)) {
          state.inBlockComment = true;
          return 'comment';
        }
        if (stream.match(/"(?:[^"\\]|\\.)*"?|`(?:[^`\\]|\\.)*`?|'(?:[^'\\]|\\.)*'?/)) return 'string';
        if (stream.match(numberPattern)) return 'number';
        if (stream.match(/[{}\[\]();,.]/)) return 'bracket';
        if (stream.match(/[+\-*\/%=&|!<>?:~^]+/)) return 'operator';
        const word = stream.match(variablePattern);
        if (word) {
          const value = word[0];
          if (keywords.has(value)) return 'keyword';
          if (atoms.has(value)) return 'atom';
          if (builtin.has(value)) return 'builtin';
          return 'variable';
        }
        stream.next();
        return null;
      },
      lineComment
    };
  });
  return true;
}

function registerFileExplorerCommonCodeMirrorModes() {
  if (!hasFileEditorCodeMirror()) return false;
  defineFileExplorerSimpleMode('file-explorer-javascript', {
    keywords: ['as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'interface', 'type', 'enum', 'implements', 'namespace', 'private', 'protected', 'public', 'readonly'],
    builtin: ['Array', 'Boolean', 'Date', 'Error', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'RegExp', 'Set', 'String', 'Symbol', 'console', 'document', 'window']
  });
  defineFileExplorerSimpleMode('file-explorer-clike', {
    keywords: ['alignas', 'alignof', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class', 'const', 'constexpr', 'continue', 'default', 'delete', 'do', 'double', 'else', 'enum', 'extern', 'false', 'final', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'namespace', 'new', 'noexcept', 'nullptr', 'operator', 'private', 'protected', 'public', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'while', 'include', 'define', 'ifdef', 'ifndef', 'endif', 'pragma'],
    atoms: ['true', 'false', 'NULL', 'nullptr']
  });
  defineFileExplorerSimpleMode('file-explorer-css', {
    keywords: ['align-items', 'animation', 'background', 'border', 'box-shadow', 'color', 'display', 'flex', 'font', 'gap', 'grid', 'height', 'justify-content', 'margin', 'padding', 'position', 'transform', 'transition', 'width', 'z-index'],
    atoms: ['auto', 'block', 'bold', 'center', 'flex', 'grid', 'hidden', 'inline', 'none', 'relative', 'absolute', 'fixed', 'solid', 'transparent'],
    lineComment: '',
    variablePattern: /^-?[_a-zA-Z][\w-]*/
  });
  defineFileExplorerSimpleMode('file-explorer-shell', {
    keywords: ['case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'then', 'until', 'while', 'echo', 'exit', 'export', 'local', 'read', 'set'],
    atoms: ['true', 'false'],
    lineComment: '#',
    blockCommentStart: '',
    blockCommentEnd: ''
  });
  defineFileExplorerSimpleMode('file-explorer-sql', {
    keywords: ['ADD', 'ALTER', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CREATE', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'FROM', 'GROUP', 'HAVING', 'IN', 'INSERT', 'INTO', 'JOIN', 'LEFT', 'LIKE', 'LIMIT', 'NOT', 'NULL', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'RIGHT', 'SELECT', 'SET', 'TABLE', 'UPDATE', 'VALUES', 'WHERE'],
    atoms: ['NULL', 'TRUE', 'FALSE'],
    lineComment: '--'
  });
  return true;
}

function registerFileExplorerConfigCodeMirrorMode() {
  if (!hasFileEditorCodeMirror()) return false;
  const CodeMirror = window.CodeMirror;
  if (CodeMirror.modes && CodeMirror.modes['file-explorer-config']) return true;
  CodeMirror.defineMode('file-explorer-config', function() {
    return {
      token(stream) {
        if (stream.eatSpace()) return null;
        if (stream.match(/<!--/)) {
          if (!stream.skipTo('-->')) stream.skipToEnd();
          else stream.match('-->');
          return 'comment';
        }
        if (stream.match(/[#;].*$/)) return 'comment';
        if (stream.match(/"(?:[^"\\]|\\.)*"?|`(?:[^`\\]|\\.)*`?|'(?:[^'\\]|\\.)*'?/)) return 'string';
        if (stream.match(/<\/?[A-Za-z][\w:-]*/)) return 'tag';
        if (stream.match(/[{}\[\]<>]/)) return 'bracket';
        if (stream.match(/[-+]?\d+(?:\.\d+)?/)) return 'number';
        if (stream.match(/\b(?:true|false|null|yes|no|on|off)\b/i)) return 'atom';
        if (stream.match(/[A-Za-z_][\w.-]*(?=\s*[:=])/)) return 'property';
        if (stream.match(/[=:,]/)) return 'operator';
        stream.next();
        return null;
      }
    };
  });
  return true;
}

function registerFileExplorerTexCodeMirrorMode() {
  if (!hasFileEditorCodeMirror()) return false;
  const CodeMirror = window.CodeMirror;
  if (CodeMirror.modes && CodeMirror.modes.stex) return true;
  CodeMirror.defineMode('stex', function() {
    return {
      startState() {
        return { inMath: false };
      },
      token(stream, state) {
        if (stream.eatSpace()) return null;
        if (stream.match('%')) {
          stream.skipToEnd();
          return 'comment';
        }
        if (stream.match(/\\(?:begin|end)(?=\s*\{)/)) return 'keyword';
        if (stream.match(/\\[a-zA-Z@]+\*?|\\./)) return 'tag';
        if (stream.match(/\$\$?|\\\(|\\\)|\\\[|\\\]/)) {
          state.inMath = !state.inMath;
          return 'operator';
        }
        if (stream.match(/[{}\[\](),;]/)) return 'bracket';
        if (stream.match(/#[0-9]+/)) return 'atom';
        if (state.inMath && stream.match(/[=+\-*\/^_<>'|:]+/)) return 'operator';
        if (state.inMath && stream.match(/\d+(?:\.\d+)?/)) return 'number';
        stream.next();
        return state.inMath ? 'variable-2' : null;
      },
      lineComment: '%'
    };
  });
  CodeMirror.defineMIME && CodeMirror.defineMIME('text/x-stex', 'stex');
  return true;
}

function fileExplorerCodeMirrorMode(path) {
  const ext = fileExplorerExtension(path);
  if (isFileExplorerPythonFile(path)) return 'python';
  if (isFileExplorerTexFile(path) && registerFileExplorerTexCodeMirrorMode()) return 'stex';
  if (/^(json|jsonl|yaml|yml|toml|ini|cfg|conf|properties|xml|svg|html|htm)$/i.test(ext)) {
    return registerFileExplorerConfigCodeMirrorMode() ? 'file-explorer-config' : null;
  }
  if (!registerFileExplorerCommonCodeMirrorModes()) return null;
  if (/^(js|mjs|cjs|jsx|ts|tsx)$/i.test(ext)) return 'file-explorer-javascript';
  if (/^(c|h|cpp|cc|cxx|hpp|hh|hxx|java|cs|go|rs|kt|kts|swift|php)$/i.test(ext)) return 'file-explorer-clike';
  if (/^(css|scss|sass|less)$/i.test(ext)) return 'file-explorer-css';
  if (/^(sh|bash|zsh|ps1|bat|cmd)$/i.test(ext)) return 'file-explorer-shell';
  if (/^sql$/i.test(ext)) return 'file-explorer-sql';
  return null;
}

function fileEditorCurrentValue() {
  const cm = FILE_EXPLORER_STATE.editorCodeMirror;
  if (cm) return cm.getValue();
  const textarea = fileEditorTextarea();
  return textarea ? textarea.value : '';
}

function syncFileEditorTextareaFromCodeMirror() {
  const cm = FILE_EXPLORER_STATE.editorCodeMirror;
  const textarea = fileEditorTextarea();
  if (cm && textarea) textarea.value = cm.getValue();
}

function refreshFileEditorCodeMirror() {
  const cm = FILE_EXPLORER_STATE.editorCodeMirror;
  if (!cm) return false;
  syncFileEditorTextareaFromCodeMirror();
  setTimeout(() => cm.refresh(), 0);
  return true;
}

function ensureFileEditorCodeMirror(path = FILE_EXPLORER_STATE.editorPath) {
  if (!hasFileEditorCodeMirror()) return null;
  const textarea = fileEditorTextarea();
  const shell = fileEditorCodeShell();
  if (!textarea || !shell) return null;
  const mode = fileExplorerCodeMirrorMode(path);
  const isPython = isFileExplorerPythonFile(path);
  if (FILE_EXPLORER_STATE.editorCodeMirror) {
    FILE_EXPLORER_STATE.editorCodeMirror.setOption('mode', mode);
    bindFileExplorerEditorWheelZoom(FILE_EXPLORER_STATE.editorCodeMirror.getWrapperElement && FILE_EXPLORER_STATE.editorCodeMirror.getWrapperElement());
    applyFileExplorerEditorFontSize();
    return FILE_EXPLORER_STATE.editorCodeMirror;
  }
  const cm = window.CodeMirror.fromTextArea(textarea, {
    mode,
    theme: 'material-darker',
    lineNumbers: true,
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    lineWrapping: false,
    autoCloseBrackets: !!mode,
    foldGutter: isPython,
    gutters: isPython ? ['CodeMirror-foldgutter', 'CodeMirror-linenumbers'] : ['CodeMirror-linenumbers'],
    foldOptions: isPython ? {
      rangeFinder: window.CodeMirror.fold && window.CodeMirror.fold.indent
    } : undefined,
    extraKeys: isPython ? {
      Tab(editor) {
        if (editor.somethingSelected()) editor.indentSelection('add');
        else editor.replaceSelection('    ', 'end');
      },
      'Ctrl-Q'(editor) { editor.foldCode(editor.getCursor()); }
    } : undefined
  });
  cm.on('change', () => {
    syncFileEditorTextareaFromCodeMirror();
    if (FILE_EXPLORER_STATE.editorMarkdownPreview) updateFileEditorMarkdownPreview();
    if (FILE_EXPLORER_STATE.editorCodePreview) updateFileEditorCodePreview();
  });
  FILE_EXPLORER_STATE.editorCodeMirror = cm;
  shell.classList.add('cm-active');
  bindFileExplorerEditorWheelZoom(cm.getWrapperElement && cm.getWrapperElement());
  applyFileExplorerEditorFontSize();
  return cm;
}

function destroyFileEditorCodeMirror() {
  const cm = FILE_EXPLORER_STATE.editorCodeMirror;
  if (!cm) return;
  syncFileEditorTextareaFromCodeMirror();
  cm.toTextArea();
  FILE_EXPLORER_STATE.editorCodeMirror = null;
  const shell = fileEditorCodeShell();
  if (shell) shell.classList.remove('cm-active');
}

function currentEditorLineIndex(textarea) {
  return String(textarea.value || '').slice(0, textarea.selectionStart || 0).split('\n').length - 1;
}

function editorLineStartOffsets(text) {
  const source = String(text || '');
  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function editorLineAtOffset(offsets, offset) {
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= offset && (mid === offsets.length - 1 || offsets[mid + 1] > offset)) return mid;
    if (offsets[mid] > offset) high = mid - 1;
    else low = mid + 1;
  }
  return 0;
}

function findPythonFoldRanges(lines) {
  const ranges = new Map();
  const indentOf = line => {
    const m = String(line || '').match(/^[ \t]*/);
    return m ? m[0].replace(/\t/g, '    ').length : 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !/:\s*(?:#.*)?$/.test(line)) continue;
    const baseIndent = indentOf(line);
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const t = (lines[j] || '').trim();
      if (!t) { end = j; continue; }
      const ind = indentOf(lines[j]);
      if (ind <= baseIndent) break;
      end = j;
    }
    if (end > i) ranges.set(i, end);
  }
  return ranges;
}

function foldedLineSetFromRanges(ranges) {
  const hidden = new Set();
  FILE_EXPLORER_STATE.editorFoldedLines.forEach(start => {
    const end = ranges.get(start);
    if (!Number.isInteger(end)) return;
    for (let i = start + 1; i <= end; i++) hidden.add(i);
  });
  return hidden;
}

function findBracketMatch(source, caret) {
  const pairs = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  const closes = new Set([')', ']', '}']);
  let pos = -1;
  if (caret > 0 && pairs[source[caret - 1]]) pos = caret - 1;
  else if (pairs[source[caret]]) pos = caret;
  if (pos < 0) return null;
  const ch = source[pos];
  const target = pairs[ch];
  const forward = opens.has(ch);
  let depth = 0;
  if (forward) {
    for (let i = pos; i < source.length; i++) {
      if (source[i] === ch) depth++;
      else if (source[i] === target) {
        depth--;
        if (depth === 0) return { a: pos, b: i };
      }
    }
  } else if (closes.has(ch)) {
    for (let i = pos; i >= 0; i--) {
      if (source[i] === ch) depth++;
      else if (source[i] === target) {
        depth--;
        if (depth === 0) return { a: i, b: pos };
      }
    }
  }
  return null;
}

function highlightPythonLineWithBrackets(line, absoluteStart, match) {
  const source = String(line || '');
  const marked = new Set();
  if (match) {
    if (match.a >= absoluteStart && match.a < absoluteStart + source.length) marked.add(match.a - absoluteStart);
    if (match.b >= absoluteStart && match.b < absoluteStart + source.length) marked.add(match.b - absoluteStart);
  }
  let html = highlightPythonCode(source);
  if (!marked.size) return html || ' ';
  let out = '';
  let plainIndex = 0;
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const c = html[i];
    if (c === '<') inTag = true;
    if (!inTag && marked.has(plainIndex)) out += '<span class="code-bracket-match">';
    out += c;
    if (c === '>') { inTag = false; continue; }
    if (!inTag) {
      if (marked.has(plainIndex)) out += '</span>';
      plainIndex++;
    }
  }
  return out || ' ';
}

function renderPythonEditor() {
  const textarea = fileEditorTextarea();
  const gutter = fileEditorCodeGutter();
  const highlight = fileEditorCodeHighlight();
  if (!textarea || !gutter || !highlight || !FILE_EXPLORER_STATE.editorPythonMode) return;
  const value = textarea.value || '';
  const lines = value.split('\n');
  const offsets = editorLineStartOffsets(value);
  const currentLine = currentEditorLineIndex(textarea);
  const foldRanges = findPythonFoldRanges(lines);
  const hiddenLines = foldedLineSetFromRanges(foldRanges);
  FILE_EXPLORER_STATE.editorBracketMatch = findBracketMatch(value, textarea.selectionStart || 0);
  gutter.innerHTML = lines.map((_, i) => {
    if (hiddenLines.has(i)) return '';
    const folded = FILE_EXPLORER_STATE.editorFoldedLines.has(i) && foldRanges.has(i);
    const fold = foldRanges.has(i) ? `<span class="code-fold-toggle" data-line="${i}" title="${folded ? '展开代码' : '折叠代码'}">${folded ? '›' : '⌄'}</span>` : '<span class="code-fold-toggle"></span>';
    return `<div class="code-gutter-line${i === currentLine ? ' current' : ''}">${fold}${i + 1}</div>`;
  }).join('');
  highlight.innerHTML = lines.map((line, i) => {
    if (hiddenLines.has(i)) return '';
    const cls = ['code-line'];
    if (i === currentLine) cls.push('current-line');
    const match = FILE_EXPLORER_STATE.editorBracketMatch;
    if (match && (editorLineAtOffset(offsets, match.a) === i || editorLineAtOffset(offsets, match.b) === i)) cls.push('bracket-line');
    const code = highlightPythonLineWithBrackets(line, offsets[i] || 0, match);
    const folded = FILE_EXPLORER_STATE.editorFoldedLines.has(i) && foldRanges.has(i);
    return `<span class="${cls.join(' ')}">${code}${folded ? ' <span class="code-fold-placeholder">⋯</span>' : ''}</span>`;
  }).join('') || '<span class="code-line"> </span>';
}

function syncPythonEditorScroll() {
  const textarea = fileEditorTextarea();
  const gutter = fileEditorCodeGutter();
  const pre = document.getElementById('fileEditorCodeHighlight');
  if (!textarea) return;
  if (gutter) gutter.style.transform = `translateY(${-textarea.scrollTop}px)`;
  if (pre) {
    pre.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
  }
}

function setPythonEditorMode(enabled) {
  const shell = fileEditorCodeShell();
  FILE_EXPLORER_STATE.editorPythonMode = !!enabled;
  if (shell) shell.classList.toggle('python-editor', !!enabled);
  if (enabled && hasFileEditorCodeMirror()) {
    const cm = ensureFileEditorCodeMirror(FILE_EXPLORER_STATE.editorPath);
    if (cm) {
      cm.setOption('readOnly', !!(fileEditorTextarea() && fileEditorTextarea().disabled));
      refreshFileEditorCodeMirror();
      cm.focus();
      return;
    }
  }
  if (!enabled) destroyFileEditorCodeMirror();
  if (enabled) {
    renderPythonEditor();
    syncPythonEditorScroll();
  }
}

function setFileEditorSyntaxMode(path) {
  const normalizedPath = normalizeExplorerPath(path || FILE_EXPLORER_STATE.editorPath);
  if (isFileExplorerPythonFile(normalizedPath)) {
    setPythonEditorMode(true);
    return;
  }
  setPythonEditorMode(false);
  const mode = fileExplorerCodeMirrorMode(normalizedPath);
  if (!mode || !hasFileEditorCodeMirror()) return;
  const cm = ensureFileEditorCodeMirror(normalizedPath);
  if (!cm) return;
  cm.setOption('mode', mode);
  cm.setOption('readOnly', !!(fileEditorTextarea() && fileEditorTextarea().disabled));
  refreshFileEditorCodeMirror();
}

function replaceEditorSelection(textarea, text, selectStart = null, selectEnd = null) {
  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  const nextStart = selectStart === null ? start + text.length : start + selectStart;
  const nextEnd = selectEnd === null ? nextStart : start + selectEnd;
  textarea.setSelectionRange(nextStart, nextEnd);
  renderPythonEditor();
}

function handlePythonEditorKeydown(event) {
  const textarea = event.currentTarget;
  if (!FILE_EXPLORER_STATE.editorPythonMode || !isFileExplorerPythonFile(FILE_EXPLORER_STATE.editorPath)) return;
  if (event.key === 'Tab') {
    event.preventDefault();
    replaceEditorSelection(textarea, '    ');
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const value = textarea.value || '';
    const before = value.slice(0, textarea.selectionStart || 0);
    const line = before.slice(before.lastIndexOf('\n') + 1);
    const indent = (line.match(/^[ \t]*/) || [''])[0];
    const extra = /:\s*(?:#.*)?$/.test(line) ? '    ' : '';
    replaceEditorSelection(textarea, `\n${indent}${extra}`);
    return;
  }
  const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
  if (pairs[event.key] && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    replaceEditorSelection(textarea, event.key + pairs[event.key], 1, 1);
  }
}

function bindPythonFileEditor() {
  const textarea = fileEditorTextarea();
  const gutter = fileEditorCodeGutter();
  bindFileExplorerEditorWheelZoom(fileEditorCodeShell());
  if (textarea && textarea.dataset.pythonEditorBound !== '1') {
    textarea.dataset.pythonEditorBound = '1';
    textarea.addEventListener('input', () => {
      if (FILE_EXPLORER_STATE.editorPythonMode) renderPythonEditor();
    });
    textarea.addEventListener('scroll', () => {
      if (FILE_EXPLORER_STATE.editorPythonMode) syncPythonEditorScroll();
    });
    textarea.addEventListener('keydown', handlePythonEditorKeydown);
    textarea.addEventListener('keyup', () => {
      if (FILE_EXPLORER_STATE.editorPythonMode) renderPythonEditor();
    });
    textarea.addEventListener('click', () => {
      if (FILE_EXPLORER_STATE.editorPythonMode) renderPythonEditor();
    });
    textarea.addEventListener('select', () => {
      if (FILE_EXPLORER_STATE.editorPythonMode) renderPythonEditor();
    });
  }
  if (gutter && gutter.dataset.pythonEditorBound !== '1') {
    gutter.dataset.pythonEditorBound = '1';
    gutter.addEventListener('click', event => {
      const toggle = event.target.closest('.code-fold-toggle[data-line]');
      if (!toggle) return;
      event.preventDefault();
      const line = Number(toggle.dataset.line);
      if (FILE_EXPLORER_STATE.editorFoldedLines.has(line)) FILE_EXPLORER_STATE.editorFoldedLines.delete(line);
      else FILE_EXPLORER_STATE.editorFoldedLines.add(line);
      renderPythonEditor();
      syncPythonEditorScroll();
    });
  }
}

function fileExplorerCompareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

function fileExplorerEntryModifiedValue(entry) {
  const raw = entry && (entry.mtime ?? entry.modified ?? entry.modified_at ?? entry.updated_at ?? 0);
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(raw || ''));
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

function fileExplorerEntryTypeValue(entry) {
  if (!entry || entry.type === 'dir') return '';
  return (fileExplorerExtension(entry.name || entry.path || '') || entry.type || 'file').toLowerCase();
}

function fileExplorerCompareEntriesByField(a, b, field) {
  if (field === 'modified') {
    const diff = fileExplorerEntryModifiedValue(a) - fileExplorerEntryModifiedValue(b);
    return diff < 0 ? -1 : (diff > 0 ? 1 : 0);
  }
  if (field === 'type') {
    const typeCompare = fileExplorerCompareText(fileExplorerEntryTypeValue(a), fileExplorerEntryTypeValue(b));
    if (typeCompare) return typeCompare;
  }
  return fileExplorerCompareText(a && a.name, b && b.name);
}

function fileExplorerSort(entries, options = {}) {
  const field = normalizeGraphicalFileExplorerSortField(options.field || 'name');
  const direction = normalizeGraphicalFileExplorerSortDirection(options.direction || 'asc');
  const directionMultiplier = direction === 'desc' ? -1 : 1;
  return (entries || []).slice().sort((a, b) => {
    const ad = a.type === 'dir' ? 0 : 1;
    const bd = b.type === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    const primary = fileExplorerCompareEntriesByField(a, b, field);
    if (primary) return primary * directionMultiplier;
    return fileExplorerCompareText(a && a.name, b && b.name);
  });
}

function graphicalFileExplorerSortEntries(entries) {
  return fileExplorerSort(entries, {
    field: graphicalFileExplorerSortField(),
    direction: graphicalFileExplorerSortDirection()
  });
}

function graphicalFileExplorerSearchActive() {
  return !!String(FILE_EXPLORER_STATE.graphSearchQuery || '').trim();
}

function fileExplorerSearchParentLabel(path) {
  const parent = parentExplorerPath(path);
  if (!parent || parent === path) return '.';
  const base = normalizeExplorerPath(FILE_EXPLORER_STATE.graphSearchBasePath || FILE_EXPLORER_STATE.path || '.');
  if (parent === base) return '.';
  if (base !== '.' && parent.startsWith(`${base}/`)) return parent.slice(base.length + 1) || '.';
  return parent;
}

function normalizeGraphicalFileExplorerSearchMatch(match) {
  if (!match || typeof match !== 'object') return null;
  const path = normalizeExplorerPath(match.path || '');
  if (!path) return null;
  const name = match.name || fileExplorerBasename(path) || path;
  const type = match.type === 'dir' ? 'dir' : 'file';
  return {
    ...match,
    path,
    name,
    type,
    searchMeta: type === 'dir' ? fileExplorerSearchParentLabel(path) : fileExplorerSearchParentLabel(path)
  };
}

function clearGraphicalFileExplorerSearch(options = {}) {
  if (FILE_EXPLORER_STATE.graphSearchTimer) {
    clearTimeout(FILE_EXPLORER_STATE.graphSearchTimer);
    FILE_EXPLORER_STATE.graphSearchTimer = null;
  }
  FILE_EXPLORER_STATE.graphSearchQuery = '';
  FILE_EXPLORER_STATE.graphSearchBasePath = normalizeExplorerPath(FILE_EXPLORER_STATE.path);
  FILE_EXPLORER_STATE.graphSearchResults = [];
  FILE_EXPLORER_STATE.graphSearchLoading = false;
  FILE_EXPLORER_STATE.graphSearchError = '';
  FILE_EXPLORER_STATE.graphSearchTruncated = false;
  FILE_EXPLORER_STATE.graphSearchRequestId += 1;
  clearFileExplorerSelection({ render: false });
  if (options.render !== false) renderGraphicalFileExplorer();
}

function graphicalFileExplorerSearchPlaceholder() {
  const address = fileExplorerGraphAddressText();
  const name = fileExplorerBasename(address) || address || '当前目录';
  return `在 ${name} 中搜索`;
}

function updateGraphicalFileExplorerSearchControls(modal = document.getElementById('fileExplorerGraphModal')) {
  if (!modal) return;
  const input = modal.querySelector('#fileExplorerGraphSearchInput');
  const clearBtn = modal.querySelector('#fileExplorerGraphSearchClear');
  if (input && document.activeElement !== input) input.value = FILE_EXPLORER_STATE.graphSearchQuery || '';
  if (input) input.placeholder = graphicalFileExplorerSearchPlaceholder();
  if (clearBtn) clearBtn.hidden = !graphicalFileExplorerSearchActive();
}

async function runGraphicalFileExplorerSearch(query = FILE_EXPLORER_STATE.graphSearchQuery) {
  const searchText = String(query || '').trim();
  if (!searchText) {
    clearGraphicalFileExplorerSearch();
    return;
  }
  if (FILE_EXPLORER_STATE.graphSearchTimer) {
    clearTimeout(FILE_EXPLORER_STATE.graphSearchTimer);
    FILE_EXPLORER_STATE.graphSearchTimer = null;
  }
  const requestId = FILE_EXPLORER_STATE.graphSearchRequestId + 1;
  const basePath = normalizeExplorerPath(FILE_EXPLORER_STATE.path);
  FILE_EXPLORER_STATE.graphSearchRequestId = requestId;
  FILE_EXPLORER_STATE.graphSearchQuery = searchText;
  FILE_EXPLORER_STATE.graphSearchBasePath = basePath;
  FILE_EXPLORER_STATE.graphSearchLoading = true;
  FILE_EXPLORER_STATE.graphSearchError = '';
  FILE_EXPLORER_STATE.graphSearchTruncated = false;
  FILE_EXPLORER_STATE.graphSearchResults = [];
  clearFileExplorerSelection({ render: false });
  renderGraphicalFileExplorer();
  try {
    if (typeof callAgentBackend !== 'function') throw new Error('本地工具接口未加载');
    const r = await callAgentBackend(
      'find_path',
      { path: basePath, query: searchText, max_results: 100, include_files: true, include_dirs: true },
      undefined,
      undefined,
      fileExplorerBackendContext()
    );
    if (requestId !== FILE_EXPLORER_STATE.graphSearchRequestId) return;
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '搜索失败');
    const matches = Array.isArray(r.matches) ? r.matches : [];
    FILE_EXPLORER_STATE.graphSearchResults = matches.map(normalizeGraphicalFileExplorerSearchMatch).filter(Boolean);
    FILE_EXPLORER_STATE.graphSearchTruncated = !!r.truncated;
  } catch (e) {
    if (requestId !== FILE_EXPLORER_STATE.graphSearchRequestId) return;
    FILE_EXPLORER_STATE.graphSearchError = e.message || String(e);
  } finally {
    if (requestId === FILE_EXPLORER_STATE.graphSearchRequestId) {
      FILE_EXPLORER_STATE.graphSearchLoading = false;
      renderGraphicalFileExplorer();
    }
  }
}

function scheduleGraphicalFileExplorerSearch(query) {
  FILE_EXPLORER_STATE.graphSearchQuery = String(query || '').trim();
  if (FILE_EXPLORER_STATE.graphSearchTimer) clearTimeout(FILE_EXPLORER_STATE.graphSearchTimer);
  if (!FILE_EXPLORER_STATE.graphSearchQuery) {
    clearGraphicalFileExplorerSearch();
    return;
  }
  FILE_EXPLORER_STATE.graphSearchLoading = true;
  FILE_EXPLORER_STATE.graphSearchError = '';
  FILE_EXPLORER_STATE.graphSearchResults = [];
  FILE_EXPLORER_STATE.graphSearchTruncated = false;
  clearFileExplorerSelection({ render: false });
  FILE_EXPLORER_STATE.graphSearchTimer = setTimeout(() => {
    FILE_EXPLORER_STATE.graphSearchTimer = null;
    runGraphicalFileExplorerSearch(FILE_EXPLORER_STATE.graphSearchQuery);
  }, 250);
  renderGraphicalFileExplorer();
}

function handleGraphicalFileExplorerSearchInput(event) {
  scheduleGraphicalFileExplorerSearch(event.target.value || '');
}

function handleGraphicalFileExplorerSearchKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.target.value = '';
    clearGraphicalFileExplorerSearch();
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    runGraphicalFileExplorerSearch(event.target.value || '');
  }
}

function fileExplorerEntriesSignature(entries) {
  return (Array.isArray(entries) ? entries : []).map(entry => [
    entry && entry.name ? String(entry.name) : '',
    entry && entry.type ? String(entry.type) : '',
    Number(entry && entry.size || 0),
    Number(entry && entry.mtime || 0)
  ].join('\u0001')).sort().join('\u0002');
}

function renderFileExplorerLoading() {
  const list = document.getElementById('fileExplorerList');
  if (list) {
    list.innerHTML = '<div class="file-explorer-empty">正在读取沙箱目录...</div>';
  }
  const graphList = document.getElementById('fileExplorerGraphList');
  if (graphList) {
    graphList.innerHTML = '<div class="file-explorer-empty">正在读取沙箱目录...</div>';
  }
  updateGraphicalFileExplorerToolbar();
}

function normalizeFileExplorerSelectionItem(item) {
  if (!item || typeof item !== 'object') return null;
  const path = normalizeExplorerPath(item.path);
  if (!path) return null;
  const type = item.type === 'dir' ? 'dir' : 'file';
  return {
    path,
    type,
    name: item.name || fileExplorerBasename(path) || path
  };
}

function selectedFileExplorerItems() {
  if (!FILE_EXPLORER_STATE.selectedItems || typeof FILE_EXPLORER_STATE.selectedItems.values !== 'function') {
    FILE_EXPLORER_STATE.selectedItems = new Map();
  }
  return Array.from(FILE_EXPLORER_STATE.selectedItems.values())
    .map(normalizeFileExplorerSelectionItem)
    .filter(Boolean);
}

function fileExplorerSelectionCount() {
  return selectedFileExplorerItems().length;
}

function isFileExplorerPathSelected(path) {
  if (!FILE_EXPLORER_STATE.selectedItems || typeof FILE_EXPLORER_STATE.selectedItems.has !== 'function') return false;
  return FILE_EXPLORER_STATE.selectedItems.has(normalizeExplorerPath(path));
}

function clearFileExplorerSelection(options = {}) {
  if (!FILE_EXPLORER_STATE.selectedItems || typeof FILE_EXPLORER_STATE.selectedItems.clear !== 'function') {
    FILE_EXPLORER_STATE.selectedItems = new Map();
  }
  if (!FILE_EXPLORER_STATE.selectedItems.size) return;
  FILE_EXPLORER_STATE.selectedItems.clear();
  if (options.render !== false) renderFileExplorer();
}

function toggleFileExplorerSelection(path, type) {
  const normalizedPath = normalizeExplorerPath(path);
  if (!normalizedPath) return;
  if (!FILE_EXPLORER_STATE.selectedItems || typeof FILE_EXPLORER_STATE.selectedItems.set !== 'function') {
    FILE_EXPLORER_STATE.selectedItems = new Map();
  }
  if (FILE_EXPLORER_STATE.selectedItems.has(normalizedPath)) {
    FILE_EXPLORER_STATE.selectedItems.delete(normalizedPath);
  } else {
    FILE_EXPLORER_STATE.selectedItems.set(normalizedPath, {
      path: normalizedPath,
      type: type === 'dir' ? 'dir' : 'file',
      name: fileExplorerBasename(normalizedPath) || normalizedPath
    });
  }
  renderFileExplorer();
}

function fileExplorerOperationItemsFor(path, type) {
  const normalizedPath = normalizeExplorerPath(path || FILE_EXPLORER_STATE.contextPath);
  const selected = selectedFileExplorerItems();
  if (normalizedPath && selected.length > 1 && selected.some(item => item.path === normalizedPath)) {
    return selected;
  }
  if (!normalizedPath) return [];
  return [normalizeFileExplorerSelectionItem({ path: normalizedPath, type })].filter(Boolean);
}

function fileExplorerDragItemsFromEvent(event) {
  const stateItems = Array.isArray(FILE_EXPLORER_STATE.dragItems) ? FILE_EXPLORER_STATE.dragItems : [];
  if (stateItems.length) return stateItems.map(normalizeFileExplorerSelectionItem).filter(Boolean);
  const raw = event && event.dataTransfer
    ? event.dataTransfer.getData('application/x-agent-file-explorer-items')
    : '';
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeFileExplorerSelectionItem).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function canDropFileExplorerItemsOnDirectory(items, targetDir) {
  const normalizedTargetDir = normalizeExplorerPath(targetDir);
  if (!normalizedTargetDir || !items.length) return false;
  return items.every(item => {
    const sourcePath = normalizeExplorerPath(item.path);
    return sourcePath
      && sourcePath !== normalizedTargetDir
      && !normalizedTargetDir.startsWith(sourcePath + '/')
      && normalizeExplorerPath(parentExplorerPath(sourcePath)) !== normalizedTargetDir;
  });
}

function fileExplorerDropTargetFromEvent(event) {
  const item = event && event.target && event.target.closest
    ? event.target.closest('.file-explorer-item.is-dir')
    : null;
  if (!item) return null;
  const list = event.currentTarget;
  if (list && !list.contains(item)) return null;
  return item;
}

function updateFileExplorerDragClasses() {
  const dragItems = fileExplorerDragItemsFromEvent(null);
  const draggingPaths = new Set(dragItems.map(item => normalizeExplorerPath(item.path)));
  const dropTargetPath = normalizeExplorerPath(FILE_EXPLORER_STATE.dragTargetPath);
  document.querySelectorAll('.file-explorer-item').forEach(item => {
    const path = normalizeExplorerPath(item.dataset.path || '');
    item.classList.toggle('is-dragging', !!path && draggingPaths.has(path));
    item.classList.toggle('is-drop-target', !!path && path === dropTargetPath);
  });
}

function setFileExplorerDragTarget(path) {
  const normalizedPath = normalizeExplorerPath(path);
  if (FILE_EXPLORER_STATE.dragTargetPath === normalizedPath) return;
  FILE_EXPLORER_STATE.dragTargetPath = normalizedPath;
  updateFileExplorerDragClasses();
}

function clearFileExplorerDragState() {
  FILE_EXPLORER_STATE.dragItems = [];
  FILE_EXPLORER_STATE.dragTargetPath = '';
  updateFileExplorerDragClasses();
}

function ensureFileExplorerContextMenu() {
  let menu = document.getElementById('fileExplorerContextMenu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'fileExplorerContextMenu';
  menu.className = 'file-explorer-context-menu';
  menu.hidden = true;
  menu.innerHTML = `
    <div data-menu-section="item">
      <button type="button" data-action="open">打开</button>
      <button type="button" data-action="compile-tex" data-tex-only="true" hidden>编译</button>
      <button type="button" data-action="copy-item">复制</button>
      <button type="button" data-action="cut-item">剪切</button>
      <button type="button" data-action="paste" data-paste-only="true" data-dir-only="true" hidden>粘贴到此文件夹</button>
      <button type="button" data-action="clear-clipboard" data-clipboard-only="true" hidden>取消复制/剪切</button>
      <button type="button" data-action="download" data-remote-only="true">下载</button>
      <button type="button" data-action="rename">重命名</button>
      <button type="button" data-action="copy-path">复制相对路径</button>
      <button type="button" data-action="copy-absolute-path">复制绝对路径</button>
      <button type="button" data-action="details">详情</button>
      <button type="button" data-action="delete">删除</button>
    </div>
    <div data-menu-section="blank">
      <button type="button" data-action="open-graphical">图形化界面</button>
      <button type="button" data-action="upload-files" data-remote-only="true">上传文件</button>
      <button type="button" data-action="upload-folder" data-remote-only="true">上传文件夹</button>
      <button type="button" data-action="paste" data-paste-only="true" hidden>粘贴</button>
      <button type="button" data-action="clear-clipboard" data-clipboard-only="true" hidden>取消复制/剪切</button>
      <button type="button" data-action="add-quick-access" data-add-quick-access-only>添加到快速访问</button>
      <button type="button" data-action="remove-quick-access" data-current-quick-access-only hidden>移出快速访问</button>
      <div class="file-explorer-menu-submenu" data-quick-access-wrapper hidden>
        <button class="file-explorer-submenu-trigger" type="button" aria-haspopup="true" tabindex="-1">
          <span>快速访问</span>
          <span class="file-explorer-submenu-arrow">›</span>
        </button>
        <div class="file-explorer-submenu-panel" data-quick-access-list></div>
      </div>
      <button type="button" data-action="return-sandbox-root">切回沙箱目录</button>
      <button type="button" data-action="new-file">新建文件</button>
      <button type="button" data-action="new-folder">新建文件夹</button>
      <button type="button" data-action="copy-path">复制相对路径</button>
      <button type="button" data-action="copy-absolute-path">复制绝对路径</button>
      <button type="button" data-action="details">详情</button>
      <button type="button" data-action="switch-workspace">切换工作区</button>
    </div>
    <div data-menu-section="quick-access">
      <button type="button" data-action="rename-quick-access">重命名</button>
      <button type="button" data-action="delete-quick-access">删除</button>
    </div>
  `;
  document.body.appendChild(menu);
  return menu;
}

function renderFileExplorerQuickAccessMenu(menu = ensureFileExplorerContextMenu()) {
  const wrapper = menu.querySelector('[data-quick-access-wrapper]');
  const list = menu.querySelector('[data-quick-access-list]');
  if (!wrapper || !list) return;
  const rows = loadFileExplorerQuickAccess();
  wrapper.hidden = rows.length === 0;
  list.innerHTML = rows.map(item => {
    const path = normalizeExplorerPath(item.path);
    const label = fileExplorerQuickAccessDisplayLabel(item);
    return `
      <button class="file-explorer-quick-access-item" type="button" data-action="open-quick-access" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">
        <span class="file-explorer-quick-access-path">${escapeHtml(label)}</span>
      </button>
    `;
  }).join('');
}

function addCurrentFolderToQuickAccess() {
  if (currentFileExplorerIsSandboxRoot()) {
    fileExplorerToast('沙箱目录已固定在快速访问');
    return;
  }
  const path = currentFileExplorerAbsoluteDir();
  if (!path || path === '.') {
    fileExplorerToast('无法获取当前目录绝对路径');
    return;
  }
  const rows = loadFileExplorerQuickAccess();
  const key = fileExplorerQuickAccessKey(path);
  const next = [{ path }, ...rows.filter(item => fileExplorerQuickAccessKey(item.path) !== key)]
    .slice(0, FILE_EXPLORER_QUICK_ACCESS_MAX);
  saveFileExplorerQuickAccess(next);
  renderFileExplorer();
  fileExplorerToast(`已添加到快速访问：${shortenFileExplorerQuickAccessPath(path)}`);
}

async function returnFileExplorerToSandboxRoot() {
  const ok = await loadFileExplorer('.');
  if (!ok) return;
  const root = fileExplorerWorkspaceRoot();
  fileExplorerToast(root ? `已切回沙箱目录：${shortenFileExplorerQuickAccessPath(root)}` : '已切回沙箱目录');
}

function hideFileExplorerContextMenu() {
  const menu = document.getElementById('fileExplorerContextMenu');
  if (menu) menu.hidden = true;
  FILE_EXPLORER_STATE.contextPath = '';
  FILE_EXPLORER_STATE.contextType = '';
  FILE_EXPLORER_STATE.contextScope = '';
}

function fileExplorerItemHtml(entry, options = {}) {
  const path = normalizeExplorerPath(entry.path || joinExplorerPath(FILE_EXPLORER_STATE.path, entry.name || ''));
  const name = entry.name || fileExplorerBasename(path) || '';
  const isDir = entry.type === 'dir';
  const selected = isFileExplorerPathSelected(path);
  const meta = entry.meta || entry.searchMeta || (isDir ? '文件夹' : formatSize(Number(entry.size || 0)));
  const viewClass = options.graphical ? ' file-explorer-graph-item' : '';
  return `
    <button class="file-explorer-item${viewClass} ${isDir ? 'is-dir' : 'is-file'} ${selected ? 'is-selected' : ''}" type="button" draggable="true" data-path="${escapeHtml(path)}" data-type="${escapeHtml(entry.type || '')}" aria-selected="${selected ? 'true' : 'false'}" title="${escapeHtml(path)}">
      <span class="file-explorer-icon">${fileExplorerIcon(entry)}</span>
      <span class="file-explorer-name">${escapeHtml(name)}</span>
      <span class="file-explorer-meta">${escapeHtml(meta)}</span>
    </button>
  `;
}

function renderFileExplorerListTarget(list, entries, options = {}) {
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = `<div class="file-explorer-empty">${escapeHtml(options.emptyMessage || '这个目录是空的。')}</div>`;
    return;
  }
  list.innerHTML = entries.map(entry => fileExplorerItemHtml(entry, options)).join('');
  updateFileExplorerDragClasses();
}

function fileExplorerGraphAddressText() {
  if (isFileExplorerThisPcPath(FILE_EXPLORER_STATE.path)) return FILE_EXPLORER_THIS_PC_LABEL;
  return fileExplorerAbsolutePathFor(FILE_EXPLORER_STATE.path) || normalizeExplorerPath(FILE_EXPLORER_STATE.path);
}

function fileExplorerAbsoluteAddressCrumbs(path) {
  const normalizedPath = normalizeExplorerPath(path);
  const crumbs = [];
  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    const drive = normalizedPath.slice(0, 3);
    crumbs.push({ label: drive.replace('/', ''), path: drive, title: drive });
    let acc = drive;
    normalizedPath.slice(3).split('/').filter(Boolean).forEach(part => {
      acc = joinExplorerPath(acc, part);
      crumbs.push({ label: part, path: acc, title: acc });
    });
  } else if (normalizedPath.startsWith('//')) {
    const parts = normalizedPath.split('/').filter(Boolean);
    if (parts.length >= 2) {
      let acc = `//${parts[0]}/${parts[1]}`;
      crumbs.push({ label: parts[1], path: acc, title: acc });
      parts.slice(2).forEach(part => {
        acc = joinExplorerPath(acc, part);
        crumbs.push({ label: part, path: acc, title: acc });
      });
    }
  } else if (normalizedPath.startsWith('/')) {
    let acc = '/';
    crumbs.push({ label: '/', path: '/', title: '/' });
    normalizedPath.slice(1).split('/').filter(Boolean).forEach(part => {
      acc = joinExplorerPath(acc, part);
      crumbs.push({ label: part, path: acc, title: acc });
    });
  } else {
    let acc = '.';
    crumbs.push({ label: '.', path: '.', title: '.' });
    normalizedPath.split('/').filter(Boolean).forEach(part => {
      acc = acc === '.' ? part : joinExplorerPath(acc, part);
      crumbs.push({ label: part, path: acc, title: acc });
    });
  }
  const current = normalizeExplorerPath(path);
  return crumbs.map((crumb, index) => ({
    ...crumb,
    current: normalizeExplorerPath(crumb.path) === current || index === crumbs.length - 1
  }));
}

function fileExplorerGraphAddressCrumbs() {
  if (isFileExplorerThisPcPath(FILE_EXPLORER_STATE.path)) {
    return [{
      label: FILE_EXPLORER_THIS_PC_LABEL,
      path: FILE_EXPLORER_THIS_PC_PATH,
      title: FILE_EXPLORER_THIS_PC_LABEL,
      current: true
    }];
  }
  return fileExplorerAbsoluteAddressCrumbs(fileExplorerGraphAddressText()).map(crumb => {
    const relativePath = fileExplorerRelativeToWorkspace(crumb.path);
    return {
      ...crumb,
      title: crumb.title || crumb.path,
      path: relativePath || crumb.path
    };
  });
}

function renderGraphicalFileExplorerAddress(pathEl) {
  if (!pathEl) return;
  const address = fileExplorerGraphAddressText();
  const crumbs = fileExplorerGraphAddressCrumbs();
  const parts = [];
  crumbs.forEach((crumb, index) => {
    if (index > 0) parts.push('<span class="file-explorer-graph-address-separator" aria-hidden="true">›</span>');
    parts.push(`
      <button class="file-explorer-graph-address-segment ${crumb.current ? 'is-current' : ''}" type="button" data-graph-address-path="${escapeHtml(crumb.path)}" title="${escapeHtml(crumb.title || crumb.path)}">
        ${escapeHtml(crumb.label || crumb.path)}
      </button>
    `);
    if (index === crumbs.length - 1) {
      parts.push('<span class="file-explorer-graph-address-tail" aria-hidden="true"></span>');
    }
  });
  pathEl.innerHTML = parts.join('');
  pathEl.title = address;
  pathEl.setAttribute('aria-label', `路径：${address}`);
  requestAnimationFrame(() => {
    pathEl.scrollLeft = pathEl.scrollWidth;
  });
}

function fileExplorerGraphToolbarSelection() {
  const selected = selectedFileExplorerItems();
  return {
    selected,
    first: selected[0] || null,
    count: selected.length
  };
}

function normalizeGraphicalFileExplorerRecentPath(path) {
  const raw = String(path || '').trim();
  return raw ? normalizeExplorerPath(raw) : '';
}

function graphicalFileExplorerRecentStack() {
  if (!Array.isArray(FILE_EXPLORER_STATE.graphForwardStack)) FILE_EXPLORER_STATE.graphForwardStack = [];
  const current = normalizeExplorerPath(FILE_EXPLORER_STATE.path);
  const seen = new Set();
  FILE_EXPLORER_STATE.graphForwardStack = FILE_EXPLORER_STATE.graphForwardStack
    .map(normalizeGraphicalFileExplorerRecentPath)
    .filter(path => path && path !== current)
    .filter(path => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    })
    .slice(0, GRAPHICAL_FILE_EXPLORER_RECENT_LIMIT);
  return FILE_EXPLORER_STATE.graphForwardStack;
}

function pushGraphicalFileExplorerRecentPath(path) {
  const normalized = normalizeGraphicalFileExplorerRecentPath(path);
  if (!normalized) return;
  const stack = graphicalFileExplorerRecentStack().filter(item => item !== normalized);
  FILE_EXPLORER_STATE.graphForwardStack = [normalized, ...stack].slice(0, GRAPHICAL_FILE_EXPLORER_RECENT_LIMIT);
}

function graphicalFileExplorerRecentTarget() {
  const stack = graphicalFileExplorerRecentStack();
  return stack[0] || '';
}

function popGraphicalFileExplorerRecentTarget() {
  const stack = graphicalFileExplorerRecentStack();
  return stack.shift() || '';
}

function graphicalFileExplorerViewMenuHtml() {
  const activeMode = graphicalFileExplorerViewMode();
  return FILE_EXPLORER_GRAPH_VIEW_MODES.map(mode => {
    const active = mode.id === activeMode;
    return `
      <button class="file-explorer-graph-view-option ${active ? 'is-active' : ''}" type="button" role="menuitemradio" aria-checked="${active ? 'true' : 'false'}" data-graph-view-mode="${escapeHtml(mode.id)}">
        <span class="file-explorer-graph-view-option-check" data-graph-view-check>${active ? '•' : ''}</span>
        <span class="file-explorer-graph-view-option-label">${escapeHtml(mode.label)}</span>
      </button>
    `;
  }).join('');
}

function graphicalFileExplorerSortMenuHtml() {
  const activeField = graphicalFileExplorerSortField();
  const activeDirection = graphicalFileExplorerSortDirection();
  const fieldOptions = FILE_EXPLORER_GRAPH_SORT_FIELDS.map(field => {
    const active = field.id === activeField;
    return `
      <button class="file-explorer-graph-view-option ${active ? 'is-active' : ''}" type="button" role="menuitemradio" aria-checked="${active ? 'true' : 'false'}" data-graph-sort-field="${escapeHtml(field.id)}">
        <span class="file-explorer-graph-view-option-check" data-graph-sort-field-check>${active ? '•' : ''}</span>
        <span class="file-explorer-graph-view-option-label">${escapeHtml(field.label)}</span>
      </button>
    `;
  }).join('');
  const directionOptions = FILE_EXPLORER_GRAPH_SORT_DIRECTIONS.map(direction => {
    const active = direction.id === activeDirection;
    return `
      <button class="file-explorer-graph-view-option ${active ? 'is-active' : ''}" type="button" role="menuitemradio" aria-checked="${active ? 'true' : 'false'}" data-graph-sort-direction="${escapeHtml(direction.id)}">
        <span class="file-explorer-graph-view-option-check" data-graph-sort-direction-check>${active ? '•' : ''}</span>
        <span class="file-explorer-graph-view-option-label">${escapeHtml(direction.label)}</span>
      </button>
    `;
  }).join('');
  return `${fieldOptions}<div class="file-explorer-graph-view-divider" role="separator"></div>${directionOptions}`;
}

function hideGraphicalFileExplorerViewMenu() {
  const modal = document.getElementById('fileExplorerGraphModal');
  if (!modal) return;
  const trigger = modal.querySelector('#fileExplorerGraphViewTrigger');
  const menu = modal.querySelector('#fileExplorerGraphViewMenu');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (menu) menu.hidden = true;
}

function toggleGraphicalFileExplorerViewMenu() {
  const modal = document.getElementById('fileExplorerGraphModal');
  if (!modal) return;
  hideGraphicalFileExplorerSortMenu();
  const trigger = modal.querySelector('#fileExplorerGraphViewTrigger');
  const menu = modal.querySelector('#fileExplorerGraphViewMenu');
  if (!menu) return;
  const open = menu.hidden;
  menu.hidden = !open;
  if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function hideGraphicalFileExplorerSortMenu() {
  const modal = document.getElementById('fileExplorerGraphModal');
  if (!modal) return;
  const trigger = modal.querySelector('#fileExplorerGraphSortTrigger');
  const menu = modal.querySelector('#fileExplorerGraphSortMenu');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (menu) menu.hidden = true;
}

function toggleGraphicalFileExplorerSortMenu() {
  const modal = document.getElementById('fileExplorerGraphModal');
  if (!modal) return;
  hideGraphicalFileExplorerViewMenu();
  const trigger = modal.querySelector('#fileExplorerGraphSortTrigger');
  const menu = modal.querySelector('#fileExplorerGraphSortMenu');
  if (!menu) return;
  const open = menu.hidden;
  menu.hidden = !open;
  if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function updateGraphicalFileExplorerViewControls(modal = document.getElementById('fileExplorerGraphModal')) {
  if (!modal) return;
  const activeMode = graphicalFileExplorerViewMode();
  const activeInfo = graphicalFileExplorerViewModeInfo(activeMode);
  const label = modal.querySelector('#fileExplorerGraphViewLabel');
  if (label) label.textContent = activeInfo.label;
  modal.querySelectorAll('[data-graph-view-mode]').forEach(btn => {
    const active = btn.dataset.graphViewMode === activeMode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
    const check = btn.querySelector('[data-graph-view-check]');
    if (check) check.textContent = active ? '•' : '';
  });
}

function updateGraphicalFileExplorerSortControls(modal = document.getElementById('fileExplorerGraphModal')) {
  if (!modal) return;
  const activeField = graphicalFileExplorerSortField();
  const activeDirection = graphicalFileExplorerSortDirection();
  const fieldInfo = graphicalFileExplorerSortFieldInfo(activeField);
  const directionInfo = graphicalFileExplorerSortDirectionInfo(activeDirection);
  const label = modal.querySelector('#fileExplorerGraphSortLabel');
  if (label) label.textContent = `${fieldInfo.label} · ${directionInfo.label}`;
  modal.querySelectorAll('[data-graph-sort-field]').forEach(btn => {
    const active = btn.dataset.graphSortField === activeField;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
    const check = btn.querySelector('[data-graph-sort-field-check]');
    if (check) check.textContent = active ? '•' : '';
  });
  modal.querySelectorAll('[data-graph-sort-direction]').forEach(btn => {
    const active = btn.dataset.graphSortDirection === activeDirection;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
    const check = btn.querySelector('[data-graph-sort-direction-check]');
    if (check) check.textContent = active ? '•' : '';
  });
}

function renderGraphicalFileExplorerQuickAccess() {
  const list = document.getElementById('fileExplorerGraphQuickAccessList');
  if (!list) return;
  const rows = loadFileExplorerQuickAccess();
  const root = fileExplorerWorkspaceRoot();
  const driveItems = canUseFileExplorerThisPcRoot()
    ? sortedFileExplorerLocalDrives().map(drive => ({
      path: normalizeExplorerPath(drive.path),
      label: drive.name || normalizeExplorerPath(drive.path),
      title: normalizeExplorerPath(drive.path),
      driveItem: true
    }))
    : [];
  const items = [
    { path: '.', label: root ? '沙箱目录' : '当前目录', title: root || '.' },
    ...driveItems,
    ...rows.map(item => ({
      path: normalizeExplorerPath(item.path),
      label: fileExplorerQuickAccessDisplayLabel(item),
      title: normalizeExplorerPath(item.path),
      userItem: true
    }))
  ];
  list.innerHTML = items.map(item => {
    const active = fileExplorerQuickAccessKey(item.path) === fileExplorerQuickAccessKey(currentFileExplorerAbsoluteDir())
      || (item.path === '.' && normalizeExplorerPath(FILE_EXPLORER_STATE.path) === '.');
    return `
      <button class="file-explorer-graph-quick-item ${active ? 'is-active' : ''}" type="button" data-graph-path="${escapeHtml(item.path)}" ${item.userItem ? 'data-quick-access-user="true"' : ''} ${item.driveItem ? 'data-quick-access-drive="true"' : ''} title="${escapeHtml(item.title)}">
        <span class="file-explorer-graph-quick-icon">${item.path === '.' ? '⌂' : (item.driveItem ? '💽' : '★')}</span>
        <span>${escapeHtml(item.label)}</span>
      </button>
    `;
  }).join('');
}

function updateGraphicalFileExplorerToolbar() {
  const modal = document.getElementById('fileExplorerGraphModal');
  if (!modal) return;
  const parent = currentFileExplorerParentPath();
  const upBtn = modal.querySelector('#fileExplorerGraphUpBtn');
  if (upBtn) upBtn.disabled = parent === FILE_EXPLORER_STATE.path;
  const forwardBtn = modal.querySelector('#fileExplorerGraphForwardBtn');
  if (forwardBtn) {
    forwardBtn.disabled = !graphicalFileExplorerRecentTarget();
  }
  const pathEl = modal.querySelector('#fileExplorerGraphAddress');
  renderGraphicalFileExplorerAddress(pathEl);
  const status = modal.querySelector('#fileExplorerGraphStatus');
  if (status) {
    const searchActive = graphicalFileExplorerSearchActive();
    const count = searchActive
      ? (Array.isArray(FILE_EXPLORER_STATE.graphSearchResults) ? FILE_EXPLORER_STATE.graphSearchResults.length : 0)
      : (Array.isArray(FILE_EXPLORER_STATE.entries) ? FILE_EXPLORER_STATE.entries.length : 0);
    const selectedCount = fileExplorerSelectionCount();
    if (searchActive && FILE_EXPLORER_STATE.graphSearchLoading) {
      status.textContent = `正在搜索“${FILE_EXPLORER_STATE.graphSearchQuery}”...`;
    } else if (searchActive && FILE_EXPLORER_STATE.graphSearchError) {
      status.textContent = `搜索失败：${FILE_EXPLORER_STATE.graphSearchError}`;
    } else if (searchActive) {
      const suffix = FILE_EXPLORER_STATE.graphSearchTruncated ? '，结果已截断' : '';
      status.textContent = selectedCount ? `${count} 个搜索结果，已选择 ${selectedCount} 项${suffix}` : `${count} 个搜索结果${suffix}`;
    } else {
      status.textContent = selectedCount ? `${count} 个项目，已选择 ${selectedCount} 项` : `${count} 个项目`;
    }
  }
  const selection = fileExplorerGraphToolbarSelection();
  modal.querySelectorAll('[data-graph-needs-selection]').forEach(btn => {
    btn.disabled = !selection.count;
  });
  modal.querySelectorAll('[data-graph-needs-single-selection]').forEach(btn => {
    btn.disabled = selection.count !== 1;
  });
  modal.querySelectorAll('[data-graph-needs-clipboard]').forEach(btn => {
    btn.disabled = !FILE_EXPLORER_STATE.clipboard;
  });
  updateGraphicalFileExplorerViewControls(modal);
  updateGraphicalFileExplorerSortControls(modal);
  updateGraphicalFileExplorerSearchControls(modal);
}

function renderGraphicalFileExplorer(entries = graphicalFileExplorerSortEntries(FILE_EXPLORER_STATE.entries)) {
  const modal = document.getElementById('fileExplorerGraphModal');
  if (!modal) return;
  const list = modal.querySelector('#fileExplorerGraphList');
  const viewMode = graphicalFileExplorerViewMode();
  if (list) {
    list.className = `file-explorer-graph-list is-${viewMode}`;
    list.dataset.viewMode = viewMode;
    list.setAttribute('aria-label', `文件和文件夹，${graphicalFileExplorerViewModeInfo(viewMode).label}视图`);
  }
  if (graphicalFileExplorerSearchActive()) {
    if (FILE_EXPLORER_STATE.graphSearchLoading) {
      if (list) list.innerHTML = `<div class="file-explorer-empty">正在搜索“${escapeHtml(FILE_EXPLORER_STATE.graphSearchQuery)}”...</div>`;
    } else if (FILE_EXPLORER_STATE.graphSearchError) {
      if (list) list.innerHTML = `<div class="file-explorer-empty error">${escapeHtml(FILE_EXPLORER_STATE.graphSearchError)}</div>`;
    } else {
      renderFileExplorerListTarget(
        list,
        graphicalFileExplorerSortEntries(FILE_EXPLORER_STATE.graphSearchResults),
        { graphical: true, search: true, emptyMessage: `未找到“${FILE_EXPLORER_STATE.graphSearchQuery}”` }
      );
    }
  } else {
    renderFileExplorerListTarget(list, entries, { graphical: true });
  }
  renderGraphicalFileExplorerQuickAccess();
  updateGraphicalFileExplorerToolbar();
}

function renderFileExplorer() {
  const list = document.getElementById('fileExplorerList');
  const upBtn = document.getElementById('fileExplorerUpBtn');
  setFileExplorerPathDisplay(FILE_EXPLORER_STATE.path);
  if (upBtn) upBtn.disabled = currentFileExplorerParentPath() === FILE_EXPLORER_STATE.path;

  const entries = fileExplorerSort(FILE_EXPLORER_STATE.entries);
  renderFileExplorerListTarget(list, entries);
  renderGraphicalFileExplorer();
}

function ensureGraphicalFileExplorerModal() {
  let modal = document.getElementById('fileExplorerGraphModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'fileExplorerGraphModal';
  modal.className = 'modal-mask file-explorer-graph-mask';
  modal.innerHTML = `
    <div class="modal file-explorer-graph-modal" role="dialog" aria-modal="true" aria-labelledby="fileExplorerGraphTitle">
      <div class="file-explorer-graph-titlebar">
        <h2 id="fileExplorerGraphTitle">Snake资源管理器</h2>
        <button class="modal-close" type="button" data-file-explorer-graph-close aria-label="关闭">×</button>
      </div>
      <div class="file-explorer-graph-addressbar">
        <button id="fileExplorerGraphUpBtn" class="file-explorer-graph-nav" type="button" title="返回上一级" aria-label="返回上一级">←</button>
        <button id="fileExplorerGraphForwardBtn" class="file-explorer-graph-nav" type="button" title="返回刚刚的下一级目录" aria-label="返回刚刚的下一级目录">→</button>
        <button id="fileExplorerGraphRefreshBtn" class="file-explorer-graph-nav" type="button" title="刷新" aria-label="刷新">↻</button>
        <nav id="fileExplorerGraphAddress" class="file-explorer-graph-address" aria-label="路径" title="."></nav>
        <div class="file-explorer-graph-search" role="search">
          <input id="fileExplorerGraphSearchInput" type="search" autocomplete="off" spellcheck="false" aria-label="搜索文件或文件夹">
          <button id="fileExplorerGraphSearchClear" class="file-explorer-graph-search-clear" type="button" title="清空搜索" aria-label="清空搜索" hidden>×</button>
          <span class="file-explorer-graph-search-icon" aria-hidden="true">⌕</span>
        </div>
      </div>
      <div class="file-explorer-graph-commandbar" aria-label="文件操作">
        <button type="button" data-graph-command="new-file">新建文件</button>
        <button type="button" data-graph-command="new-folder">新建文件夹</button>
        <span class="file-explorer-graph-separator"></span>
        <div class="file-explorer-graph-view-wrap">
          <button id="fileExplorerGraphViewTrigger" class="file-explorer-graph-view-trigger" type="button" data-graph-view-trigger aria-haspopup="true" aria-expanded="false">
            <span id="fileExplorerGraphViewLabel">大图标</span>
            <span class="file-explorer-graph-view-caret" aria-hidden="true"></span>
          </button>
          <div id="fileExplorerGraphViewMenu" class="file-explorer-graph-view-menu" role="menu" hidden>
            ${graphicalFileExplorerViewMenuHtml()}
          </div>
        </div>
        <div class="file-explorer-graph-view-wrap file-explorer-graph-sort-wrap">
          <button id="fileExplorerGraphSortTrigger" class="file-explorer-graph-view-trigger file-explorer-graph-sort-trigger" type="button" data-graph-sort-trigger aria-haspopup="true" aria-expanded="false">
            <span id="fileExplorerGraphSortLabel">${escapeHtml(`${graphicalFileExplorerSortFieldInfo().label} · ${graphicalFileExplorerSortDirectionInfo().label}`)}</span>
            <span class="file-explorer-graph-view-caret" aria-hidden="true"></span>
          </button>
          <div id="fileExplorerGraphSortMenu" class="file-explorer-graph-view-menu file-explorer-graph-sort-menu" role="menu" hidden>
            ${graphicalFileExplorerSortMenuHtml()}
          </div>
        </div>
        <span class="file-explorer-graph-separator"></span>
        <button type="button" data-graph-command="copy" data-graph-needs-selection>复制</button>
        <button type="button" data-graph-command="cut" data-graph-needs-selection>剪切</button>
        <button type="button" data-graph-command="paste" data-graph-needs-clipboard>粘贴</button>
        <button type="button" data-graph-command="delete" data-graph-needs-selection>删除</button>
        <button type="button" data-graph-command="details" data-graph-needs-single-selection>详情</button>
      </div>
      <div class="file-explorer-graph-body">
        <aside class="file-explorer-graph-sidebar" aria-label="快速访问">
          <div class="file-explorer-graph-sidebar-title">快速访问</div>
          <div id="fileExplorerGraphQuickAccessList" class="file-explorer-graph-quick-list"></div>
        </aside>
        <main id="fileExplorerGraphList" class="file-explorer-graph-list" aria-label="文件和文件夹"></main>
      </div>
      <div id="fileExplorerGraphStatus" class="file-explorer-graph-status">0 个项目</div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener('click', event => {
    if (event.target === modal || event.target.closest('[data-file-explorer-graph-close]')) {
      closeGraphicalFileExplorer();
      return;
    }
    const addressSegment = event.target.closest('[data-graph-address-path]');
    if (addressSegment) {
      navigateGraphicalFileExplorer(addressSegment.dataset.graphAddressPath || '.');
      return;
    }
    const viewMode = event.target.closest('[data-graph-view-mode]');
    if (viewMode) {
      setGraphicalFileExplorerViewMode(viewMode.dataset.graphViewMode);
      hideGraphicalFileExplorerViewMenu();
      return;
    }
    const sortField = event.target.closest('[data-graph-sort-field]');
    if (sortField) {
      setGraphicalFileExplorerSort(sortField.dataset.graphSortField, FILE_EXPLORER_STATE.graphicalSortDirection);
      hideGraphicalFileExplorerSortMenu();
      return;
    }
    const sortDirection = event.target.closest('[data-graph-sort-direction]');
    if (sortDirection) {
      setGraphicalFileExplorerSort(FILE_EXPLORER_STATE.graphicalSortField, sortDirection.dataset.graphSortDirection);
      hideGraphicalFileExplorerSortMenu();
      return;
    }
    if (event.target.closest('[data-graph-view-trigger]')) {
      toggleGraphicalFileExplorerViewMenu();
      return;
    }
    if (event.target.closest('[data-graph-sort-trigger]')) {
      toggleGraphicalFileExplorerSortMenu();
      return;
    }
    if (!event.target.closest('#fileExplorerGraphViewMenu')) hideGraphicalFileExplorerViewMenu();
    if (!event.target.closest('#fileExplorerGraphSortMenu')) hideGraphicalFileExplorerSortMenu();
    const command = event.target.closest('[data-graph-command]');
    if (command && !command.disabled) handleGraphicalFileExplorerCommand(command.dataset.graphCommand);
  });

  const list = modal.querySelector('#fileExplorerGraphList');
  if (list) {
    list.addEventListener('click', handleFileExplorerClick);
    list.addEventListener('contextmenu', handleFileExplorerContextMenu);
    bindFileExplorerDragAndDrop(list);
  }
  const quickList = modal.querySelector('#fileExplorerGraphQuickAccessList');
  if (quickList) {
    quickList.addEventListener('click', event => {
      const btn = event.target.closest('[data-graph-path]');
      if (!btn) return;
      navigateGraphicalFileExplorer(btn.dataset.graphPath || '.');
    });
    quickList.addEventListener('contextmenu', event => {
      const btn = event.target.closest('[data-quick-access-user="true"]');
      if (!btn) return;
      showFileExplorerContextMenu(event, null, {
        scope: 'quick-access',
        path: btn.dataset.graphPath || '',
        type: 'dir'
      });
    });
  }
  const upBtn = modal.querySelector('#fileExplorerGraphUpBtn');
  if (upBtn) upBtn.addEventListener('click', graphicalFileExplorerGoParent);
  const forwardBtn = modal.querySelector('#fileExplorerGraphForwardBtn');
  if (forwardBtn) forwardBtn.addEventListener('click', graphicalFileExplorerGoForward);
  const refreshBtn = modal.querySelector('#fileExplorerGraphRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshFileExplorer);
  const searchInput = modal.querySelector('#fileExplorerGraphSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', handleGraphicalFileExplorerSearchInput);
    searchInput.addEventListener('keydown', handleGraphicalFileExplorerSearchKeydown);
  }
  const searchClear = modal.querySelector('#fileExplorerGraphSearchClear');
  if (searchClear) searchClear.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    clearGraphicalFileExplorerSearch();
    if (searchInput) searchInput.focus();
  });
  return modal;
}

function selectedGraphicalFileExplorerItemOrToast() {
  const selection = fileExplorerGraphToolbarSelection();
  if (!selection.first) {
    fileExplorerToast('请先选择文件或文件夹');
    return null;
  }
  return selection.first;
}

function handleGraphicalFileExplorerCommand(action) {
  const selected = selectedGraphicalFileExplorerItemOrToast;
  if (action === 'new-file') createFileExplorerFile(FILE_EXPLORER_STATE.path);
  else if (action === 'new-folder') createFileExplorerFolder(FILE_EXPLORER_STATE.path);
  else if (action === 'paste') pasteFileExplorerItem(FILE_EXPLORER_STATE.path);
  else if (action === 'copy') {
    const item = selected();
    if (item) copyFileExplorerItem(item.path, item.type);
  } else if (action === 'cut') {
    const item = selected();
    if (item) cutFileExplorerItem(item.path, item.type);
  } else if (action === 'delete') {
    const item = selected();
    if (item) deleteFileExplorerPath(item.path, item.type);
  } else if (action === 'details') {
    const selection = fileExplorerGraphToolbarSelection();
    if (selection.count !== 1) {
      fileExplorerToast('请选择一个项目查看详情');
      return;
    }
    showFileExplorerDetails(selection.first.path);
  }
  updateGraphicalFileExplorerToolbar();
}

async function openGraphicalFileExplorer(path = FILE_EXPLORER_STATE.contextPath || FILE_EXPLORER_STATE.path) {
  if (path && typeof path === 'object' && typeof path.preventDefault === 'function') {
    path = FILE_EXPLORER_STATE.contextPath || FILE_EXPLORER_STATE.path;
  }
  loadGraphicalFileExplorerViewMode();
  loadGraphicalFileExplorerSort();
  const modal = ensureGraphicalFileExplorerModal();
  const localDrivePromise = ensureFileExplorerLocalDrives();
  FILE_EXPLORER_STATE.graphicalVisible = true;
  FILE_EXPLORER_STATE.graphForwardStack = [];
  modal.classList.add('show');
  renderFileExplorer();
  startFileExplorerAutoRefresh();
  await loadFileExplorer(path || FILE_EXPLORER_STATE.path, { silent: !!FILE_EXPLORER_STATE.entries.length });
  await localDrivePromise;
}

function closeGraphicalFileExplorer() {
  const modal = document.getElementById('fileExplorerGraphModal');
  if (modal) modal.classList.remove('show');
  FILE_EXPLORER_STATE.graphicalVisible = false;
  FILE_EXPLORER_STATE.graphForwardStack = [];
  hideFileExplorerContextMenu();
  clearGraphicalFileExplorerSearch({ render: false });
  hideGraphicalFileExplorerSortMenu();
  scheduleInlineFileLayoutRefresh();
  if (!FILE_EXPLORER_STATE.visible) stopFileExplorerAutoRefresh();
}

async function loadFileExplorer(path = FILE_EXPLORER_STATE.path, options = {}) {
  if (FILE_EXPLORER_STATE.loading) return false;
  FILE_EXPLORER_STATE.loading = true;
  const nextPath = normalizeExplorerPath(path);
  const pathChanged = nextPath !== FILE_EXPLORER_STATE.path;
  FILE_EXPLORER_STATE.path = nextPath;
  if (pathChanged) clearFileExplorerSelection({ render: false });
  if (pathChanged && options.preserveSearch !== true) clearGraphicalFileExplorerSearch({ render: false });
  if (pathChanged && options.preserveGraphForward !== true) FILE_EXPLORER_STATE.graphForwardStack = [];
  if (!options.silent) renderFileExplorerLoading();
  setFileExplorerPathDisplay(FILE_EXPLORER_STATE.path);
  try {
    if (typeof callAgentBackend !== 'function') throw new Error('本地工具接口未加载');
    if (isFileExplorerThisPcPath(FILE_EXPLORER_STATE.path)) {
      const r = await callAgentBackend('list_drives', {}, undefined, undefined, fileExplorerBackendContext());
      if (typeof r === 'string') throw new Error(r);
      if (!r || !r.ok) throw new Error((r && r.error) || '读取本机磁盘失败');
      const entries = syncFileExplorerLocalDrives(Array.isArray(r.entries) ? r.entries : []);
      FILE_EXPLORER_STATE.absolutePath = '';
      FILE_EXPLORER_STATE.entries = entries;
      FILE_EXPLORER_STATE.autoRefreshSignature = fileExplorerEntriesSignature(FILE_EXPLORER_STATE.entries);
      FILE_EXPLORER_STATE.autoRefreshPath = FILE_EXPLORER_STATE.path;
      renderFileExplorer();
      return true;
    }
    const r = await callAgentBackend('list_dir', { path: FILE_EXPLORER_STATE.path }, undefined, undefined, fileExplorerBackendContext());
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '读取目录失败');
    noteFileExplorerAbsolutePath(r.path, FILE_EXPLORER_STATE.path);
    FILE_EXPLORER_STATE.entries = Array.isArray(r.entries) ? r.entries : [];
    FILE_EXPLORER_STATE.autoRefreshSignature = fileExplorerEntriesSignature(FILE_EXPLORER_STATE.entries);
    FILE_EXPLORER_STATE.autoRefreshPath = FILE_EXPLORER_STATE.path;
    renderFileExplorer();
    return true;
  } catch (e) {
    const list = document.getElementById('fileExplorerList');
    if (list) {
      list.innerHTML = `<div class="file-explorer-empty error">${escapeHtml(e.message || String(e))}</div>`;
    }
    const graphList = document.getElementById('fileExplorerGraphList');
    if (graphList) {
      graphList.innerHTML = `<div class="file-explorer-empty error">${escapeHtml(e.message || String(e))}</div>`;
    }
    updateGraphicalFileExplorerToolbar();
    return false;
  } finally {
    FILE_EXPLORER_STATE.loading = false;
  }
}

function startFileExplorerAutoRefresh() {
  stopFileExplorerAutoRefresh();
  FILE_EXPLORER_STATE.autoRefreshTimer = setInterval(pollFileExplorerChanges, 2500);
}

function stopFileExplorerAutoRefresh() {
  if (FILE_EXPLORER_STATE.autoRefreshTimer) {
    clearInterval(FILE_EXPLORER_STATE.autoRefreshTimer);
    FILE_EXPLORER_STATE.autoRefreshTimer = null;
  }
  FILE_EXPLORER_STATE.autoRefreshInFlight = false;
}

function isFileExplorerViewActive() {
  return !!(FILE_EXPLORER_STATE.visible || FILE_EXPLORER_STATE.graphicalVisible);
}

async function pollFileExplorerChanges() {
  if (!isFileExplorerViewActive() || FILE_EXPLORER_STATE.loading || FILE_EXPLORER_STATE.autoRefreshInFlight) return;
  FILE_EXPLORER_STATE.autoRefreshInFlight = true;
  const path = normalizeExplorerPath(FILE_EXPLORER_STATE.path);
  try {
    if (typeof callAgentBackend !== 'function') return;
    const r = isFileExplorerThisPcPath(path)
      ? await callAgentBackend('list_drives', {}, undefined, undefined, fileExplorerBackendContext())
      : await callAgentBackend('list_dir', { path }, undefined, undefined, fileExplorerBackendContext());
    if (typeof r === 'string' || !r || !r.ok) return;
    if (path !== normalizeExplorerPath(FILE_EXPLORER_STATE.path) || !isFileExplorerViewActive()) return;
    if (!isFileExplorerThisPcPath(path)) noteFileExplorerAbsolutePath(r.path, path);
    let entries = Array.isArray(r.entries) ? r.entries : [];
    if (isFileExplorerThisPcPath(path)) entries = syncFileExplorerLocalDrives(entries);
    const signature = fileExplorerEntriesSignature(entries);
    if (FILE_EXPLORER_STATE.autoRefreshPath !== path || FILE_EXPLORER_STATE.autoRefreshSignature !== signature) {
      FILE_EXPLORER_STATE.entries = entries;
      FILE_EXPLORER_STATE.autoRefreshPath = path;
      FILE_EXPLORER_STATE.autoRefreshSignature = signature;
      renderFileExplorer();
    }
  } catch (e) {
    // 自动刷新失败时保持当前列表，避免后台轮询打断用户操作。
  } finally {
    FILE_EXPLORER_STATE.autoRefreshInFlight = false;
  }
}

function setSidebarExplorerMode(visible) {
  FILE_EXPLORER_STATE.visible = !!visible;
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('sidebarExplorerBtn');
  const chatPanel = document.getElementById('sidebarChatPanel');
  const explorerPanel = document.getElementById('sidebarExplorerPanel');
  if (sidebar) sidebar.classList.toggle('explorer-open', FILE_EXPLORER_STATE.visible);
  if (btn) {
    btn.classList.toggle('active', FILE_EXPLORER_STATE.visible);
    btn.setAttribute('aria-pressed', FILE_EXPLORER_STATE.visible ? 'true' : 'false');
  }
  if (chatPanel) chatPanel.hidden = FILE_EXPLORER_STATE.visible;
  if (explorerPanel) explorerPanel.hidden = !FILE_EXPLORER_STATE.visible;
  if (FILE_EXPLORER_STATE.visible) {
    loadFileExplorer(FILE_EXPLORER_STATE.path);
    startFileExplorerAutoRefresh();
  } else {
    if (!FILE_EXPLORER_STATE.graphicalVisible) stopFileExplorerAutoRefresh();
  }
}

function toggleSidebarExplorer() {
  setSidebarExplorerMode(!FILE_EXPLORER_STATE.visible);
}

function refreshFileExplorer() {
  loadFileExplorer(FILE_EXPLORER_STATE.path, { silent: true });
}

function resetFileExplorerToRoot() {
  FILE_EXPLORER_STATE.path = '.';
  FILE_EXPLORER_STATE.entries = [];
  if (isFileExplorerViewActive()) loadFileExplorer('.');
  else renderFileExplorer();
}

function sanitizeUploadRelativePath(path, fallbackName = 'upload.bin') {
  const source = String(path || fallbackName || 'upload.bin').replace(/\\/g, '/');
  const parts = source
    .split('/')
    .map(part => part.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter(part => part && part !== '.' && part !== '..');
  if (parts.length) return parts.join('/');
  const fallback = String(fallbackName || 'upload.bin').replace(/[\\/]+/g, '').trim();
  return fallback || 'upload.bin';
}

function fileExplorerArrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer || 0);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function fileExplorerReadFileAsArrayBuffer(file) {
  if (file && typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => resolve(event && event.target ? event.target.result : new ArrayBuffer(0));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
  });
}

async function readUploadBlobAsBase64(blob) {
  return fileExplorerArrayBufferToBase64(await fileExplorerReadFileAsArrayBuffer(blob));
}

function createFileExplorerUploadId(file, targetFilePath) {
  const size = Number(file && file.size || 0);
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  const name = String(targetFilePath || (file && file.name) || 'upload')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .slice(-80);
  return `${stamp}-${random}-${size}-${name}`;
}

async function uploadExplorerFileInChunks(file, targetFilePath, progress = {}) {
  const size = Math.max(0, Number(file && file.size || 0));
  const chunkSize = Math.max(1, FILE_EXPLORER_UPLOAD_CHUNK_BYTES);
  const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
  const uploadId = createFileExplorerUploadId(file, targetFilePath);
  let checkpointId = '';
  let lastToastAt = 0;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const offset = size === 0 ? 0 : chunkIndex * chunkSize;
    const end = size === 0 ? 0 : Math.min(size, offset + chunkSize);
    const blob = size === 0 ? file.slice(0, 0) : file.slice(offset, end);
    const content = await readUploadBlobAsBase64(blob);
    const now = Date.now();
    if (now - lastToastAt > 1000 || chunkIndex === 0 || chunkIndex === totalChunks - 1) {
      const pct = size > 0 ? Math.min(100, Math.round((end / size) * 100)) : 100;
      fileExplorerToast(`正在上传 ${progress.itemIndex + 1 || 1}/${progress.itemCount || 1}: ${progress.displayName || file.name || targetFilePath} ${pct}%`);
      lastToastAt = now;
    }
    const r = await callAgentBackend(
      'file_upload_chunk',
      {
        path: targetFilePath,
        upload_id: uploadId,
        offset,
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
        total_size: size,
        done: chunkIndex === totalChunks - 1,
        content,
        encoding: 'base64',
        mime: file.type || 'application/octet-stream',
        checkpoint_id: checkpointId || undefined
      },
      undefined,
      undefined,
      fileExplorerBackendContext({ skipConfirm: true })
    );
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '上传失败');
    if (r.checkpoint_id) checkpointId = r.checkpoint_id;
  }
}

function fileExplorerItemsFromFileList(files) {
  return Array.from(files || []).filter(Boolean).map(file => ({
    file,
    relativePath: file.webkitRelativePath || file.name
  }));
}

async function uploadSelectedFilesToExplorer(files, targetPath = FILE_EXPLORER_STATE.path) {
  if (!requireFileExplorerRemoteAction()) return;
  const items = Array.isArray(files) ? files.filter(item => item && item.file) : fileExplorerItemsFromFileList(files);
  if (!items.length) {
    fileExplorerToast('没有可上传的文件');
    return;
  }
  if (FILE_EXPLORER_STATE.uploading) {
    fileExplorerToast('已有文件正在上传');
    return;
  }
  FILE_EXPLORER_STATE.uploading = true;
  const normalizedTarget = normalizeExplorerPath(targetPath || FILE_EXPLORER_STATE.path);
  let uploaded = 0;
  const failed = [];
  try {
    if (typeof callAgentBackend !== 'function') throw new Error('本地工具接口未加载');
    fileExplorerToast(`正在上传 ${items.length} 个文件到 ${normalizedTarget}`);
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const file = item.file;
      const relativePath = sanitizeUploadRelativePath(item.relativePath, file.name);
      const targetFilePath = joinExplorerPath(normalizedTarget, relativePath);
      try {
        await uploadExplorerFileInChunks(file, targetFilePath, {
          itemIndex: i,
          itemCount: items.length,
          displayName: relativePath
        });
        uploaded += 1;
      } catch (e) {
        failed.push({ path: targetFilePath, error: e.message || String(e) });
      }
    }
    if (failed.length) {
      console.warn('[file-explorer] upload failed:', failed);
      fileExplorerToast(`已上传 ${uploaded} 个，失败 ${failed.length} 个`);
    } else {
      fileExplorerToast(`已上传 ${uploaded} 个文件`);
    }
    if (FILE_EXPLORER_STATE.visible) await loadFileExplorer(FILE_EXPLORER_STATE.path, { silent: true });
  } catch (e) {
    fileExplorerToast(e.message || String(e));
  } finally {
    FILE_EXPLORER_STATE.uploading = false;
  }
}

function ensureFileExplorerUploadInput(kind) {
  const id = kind === 'folder' ? 'fileExplorerFolderUploadInput' : 'fileExplorerFileUploadInput';
  let input = document.getElementById(id);
  if (input) return input;
  input = document.createElement('input');
  input.id = id;
  input.type = 'file';
  input.hidden = true;
  input.multiple = true;
  if (kind === 'folder') {
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }
  document.body.appendChild(input);
  return input;
}

function openFileExplorerUploadPicker(kind = 'files', targetPath = FILE_EXPLORER_STATE.path) {
  if (!requireFileExplorerRemoteAction()) return;
  const normalizedKind = kind === 'folder' ? 'folder' : 'files';
  const input = ensureFileExplorerUploadInput(normalizedKind);
  input.onchange = event => handleFileExplorerUploadInputChange(event, normalizedKind, targetPath);
  input.value = '';
  input.click();
}

async function handleFileExplorerUploadInputChange(event, kind, targetPath) {
  const input = event && event.target;
  const files = input && input.files ? input.files : [];
  try {
    const items = fileExplorerItemsFromFileList(files);
    await uploadSelectedFilesToExplorer(items, targetPath);
  } finally {
    if (input) input.value = '';
  }
}

function setInlineFileStatus(message, kind = '') {
  const el = document.getElementById('inlineFileStatus');
  if (!el) return;
  el.textContent = message || '';
  el.className = kind ? `inline-file-status ${kind}` : 'inline-file-status';
}

function setInlineFileChrome(path, title) {
  const titleEl = document.getElementById('inlineFileTitle');
  const pathEl = document.getElementById('inlineFilePath');
  const name = fileExplorerBasename(path) || title || '文件内容';
  if (titleEl) titleEl.textContent = name;
  if (pathEl) pathEl.textContent = path || '-';
}

function clearInlineFileContent() {
  const body = document.getElementById('inlineFileBody');
  const footer = document.getElementById('inlineFileFooter');
  destroyInlineCodeMirror();
  if (body) {
    body.querySelectorAll('iframe').forEach(frame => frame.removeAttribute('src'));
    body.innerHTML = '';
  }
  if (footer) footer.innerHTML = '';
}

function inlineFileTextarea() {
  return document.getElementById('inlineFileTextContent');
}

function inlineFileCodeShell() {
  return document.getElementById('inlineFileCodeShell');
}

function inlineFileCurrentValue() {
  const cm = FILE_EXPLORER_STATE.inlineCodeMirror;
  if (cm) return cm.getValue();
  const textarea = inlineFileTextarea();
  return textarea ? textarea.value : '';
}

function syncInlineTextareaFromCodeMirror() {
  const cm = FILE_EXPLORER_STATE.inlineCodeMirror;
  const textarea = inlineFileTextarea();
  if (cm && textarea) textarea.value = cm.getValue();
}

function refreshInlineCodeMirror() {
  const cm = FILE_EXPLORER_STATE.inlineCodeMirror;
  if (!cm) return false;
  syncInlineTextareaFromCodeMirror();
  setTimeout(() => cm.refresh(), 0);
  return true;
}

function scheduleInlineFileLayoutRefresh() {
  const cm = FILE_EXPLORER_STATE.inlineCodeMirror;
  const panel = document.getElementById('inlineFilePanel');
  if (!cm || !panel || panel.hidden) return false;
  syncInlineTextareaFromCodeMirror();
  const refresh = () => {
    if (FILE_EXPLORER_STATE.inlineCodeMirror === cm && !panel.hidden) cm.refresh();
  };
  refresh();
  setTimeout(refresh, 0);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(refresh));
  }
  setTimeout(refresh, 160);
  setTimeout(refresh, 360);
  setTimeout(refresh, 700);
  return true;
}

function ensureInlineCodeMirror(path) {
  if (!hasFileEditorCodeMirror()) return null;
  const textarea = inlineFileTextarea();
  const shell = inlineFileCodeShell();
  if (!textarea || !shell) return null;
  if (FILE_EXPLORER_STATE.inlineCodeMirror) {
    bindFileExplorerEditorWheelZoom(FILE_EXPLORER_STATE.inlineCodeMirror.getWrapperElement && FILE_EXPLORER_STATE.inlineCodeMirror.getWrapperElement());
    applyFileExplorerEditorFontSize();
    return FILE_EXPLORER_STATE.inlineCodeMirror;
  }
  const targetPath = path || FILE_EXPLORER_STATE.inlineFilePath;
  const isPython = isFileExplorerPythonFile(targetPath);
  const mode = fileExplorerCodeMirrorMode(targetPath);
  const cm = window.CodeMirror.fromTextArea(textarea, {
    mode,
    theme: 'material-darker',
    lineNumbers: true,
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    lineWrapping: false,
    readOnly: !!textarea.disabled,
    autoCloseBrackets: !!mode,
    foldGutter: isPython,
    gutters: isPython ? ['CodeMirror-foldgutter', 'CodeMirror-linenumbers'] : ['CodeMirror-linenumbers'],
    foldOptions: isPython ? {
      rangeFinder: window.CodeMirror.fold && window.CodeMirror.fold.indent
    } : undefined,
    extraKeys: isPython ? {
      Tab(editor) {
        if (editor.somethingSelected()) editor.indentSelection('add');
        else editor.replaceSelection('    ', 'end');
      },
      'Ctrl-Q'(editor) { editor.foldCode(editor.getCursor()); }
    } : undefined
  });
  cm.on('change', () => {
    syncInlineTextareaFromCodeMirror();
    const preview = document.querySelector('#inlineFileBody .inline-markdown-preview, #inlineFileBody .inline-code-preview');
    if (preview && !preview.hidden && isFileExplorerMarkdownFile(FILE_EXPLORER_STATE.inlineFilePath)) renderMarkdownPreviewInto(preview, inlineFileCurrentValue());
    if (preview && !preview.hidden && isFileExplorerPythonFile(FILE_EXPLORER_STATE.inlineFilePath)) renderPythonPreviewInto(preview, inlineFileCurrentValue());
  });
  FILE_EXPLORER_STATE.inlineCodeMirror = cm;
  shell.classList.add('cm-active');
  bindFileExplorerEditorWheelZoom(cm.getWrapperElement && cm.getWrapperElement());
  applyFileExplorerEditorFontSize();
  scheduleInlineFileLayoutRefresh();
  return cm;
}

function destroyInlineCodeMirror() {
  const cm = FILE_EXPLORER_STATE.inlineCodeMirror;
  if (!cm) return;
  syncInlineTextareaFromCodeMirror();
  cm.toTextArea();
  FILE_EXPLORER_STATE.inlineCodeMirror = null;
  const shell = inlineFileCodeShell();
  if (shell) shell.classList.remove('cm-active');
}

function inlineFileCanStayOpen() {
  return inlineFileLayoutFits(Number(FILE_EXPLORER_STATE.inlineChatWidth || 50));
}

function inlineFileLayoutFits(chatPercent = 50) {
  const mainContent = document.getElementById('mainContent');
  const mainWidth = mainContent ? mainContent.getBoundingClientRect().width : window.innerWidth;
  const safeChatPercent = Math.min(75, Math.max(35, Number(chatPercent) || 50));
  const chatWidth = mainWidth * safeChatPercent / 100;
  const fileWidth = mainWidth - chatWidth;
  return window.innerWidth >= INLINE_FILE_MIN_WINDOW_WIDTH &&
    mainWidth >= INLINE_FILE_MIN_MAIN_WIDTH &&
    chatWidth >= INLINE_FILE_MIN_CHAT_WIDTH &&
    fileWidth >= INLINE_FILE_MIN_FILE_WIDTH;
}

function inlineFileOpenBlockedMessage() {
  return '窗口较窄，无法在主页面显示文件内容，请放大浏览器窗口后再试';
}

function enforceInlineFileResponsive() {
  const panel = document.getElementById('inlineFilePanel');
  if (!panel || panel.hidden) return;
  if (!inlineFileCanStayOpen()) {
    closeInlineFilePanel();
    fileExplorerToast('窗口较窄，已关闭文件内容列');
    return;
  }
  scheduleInlineFileLayoutRefresh();
}

function applyInlineFileLayout() {
  const mainContent = document.getElementById('mainContent');
  const toggle = document.getElementById('inlineFileSideToggle');
  if (!mainContent) return;
  const side = FILE_EXPLORER_STATE.inlineFileSide === 'left' ? 'left' : 'right';
  const width = Math.min(75, Math.max(35, Number(FILE_EXPLORER_STATE.inlineChatWidth || 50)));
  mainContent.classList.toggle('inline-file-left', side === 'left');
  mainContent.classList.toggle('inline-file-right', side !== 'left');
  mainContent.style.setProperty('--chat-column-width', `${width}%`);
  scheduleInlineFileLayoutRefresh();
  if (toggle) toggle.textContent = side === 'left' ? '右列' : '左列';
}

function toggleInlineFileSide() {
  FILE_EXPLORER_STATE.inlineFileSide = FILE_EXPLORER_STATE.inlineFileSide === 'left' ? 'right' : 'left';
  applyInlineFileLayout();
}

function setInlineChatWidth(percent) {
  FILE_EXPLORER_STATE.inlineChatWidth = Math.min(75, Math.max(35, Number(percent) || 50));
  applyInlineFileLayout();
}

function showInlineFilePanel(kind, path) {
  if (!inlineFileLayoutFits(FILE_EXPLORER_STATE.inlineChatWidth) && inlineFileLayoutFits(50)) {
    FILE_EXPLORER_STATE.inlineChatWidth = 50;
  }
  if (!inlineFileCanStayOpen()) {
    fileExplorerToast(inlineFileOpenBlockedMessage());
    return false;
  }
  const mainContent = document.getElementById('mainContent');
  const panel = document.getElementById('inlineFilePanel');
  if (!mainContent || !panel) return false;
  FILE_EXPLORER_STATE.inlineFileKind = kind || '';
  FILE_EXPLORER_STATE.inlineFilePath = normalizeExplorerPath(path);
  panel.hidden = false;
  mainContent.classList.add('has-inline-file');
  applyInlineFileLayout();
  setInlineFileChrome(FILE_EXPLORER_STATE.inlineFilePath, kind === 'pdf' ? 'PDF 阅读器' : '文本内容');
  return true;
}

function closeInlineFilePanel() {
  const mainContent = document.getElementById('mainContent');
  const panel = document.getElementById('inlineFilePanel');
  if (mainContent) {
    mainContent.classList.remove('has-inline-file', 'inline-file-left', 'inline-file-right', 'is-resizing');
    mainContent.style.removeProperty('--chat-column-width');
  }
  if (panel) panel.hidden = true;
  clearInlineFileContent();
  FILE_EXPLORER_STATE.inlineFilePath = '';
  FILE_EXPLORER_STATE.inlineFileKind = '';
}

function highlightPythonCode(code) {
  const source = String(code || '');
  const keywords = new Set([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
    'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
    'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
    'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
  ]);
  const builtins = new Set([
    'abs', 'all', 'any', 'bool', 'bytes', 'callable', 'chr', 'dict', 'dir',
    'enumerate', 'Exception', 'filter', 'float', 'format', 'frozenset', 'getattr',
    'hasattr', 'help', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter',
    'len', 'list', 'map', 'max', 'min', 'next', 'object', 'open', 'ord', 'print',
    'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice',
    'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip'
  ]);
  const tokenRe = /(#[^\n]*)|((?:[rRuUbBfF]{0,2})(?:'''[\s\S]*?'''|\"\"\"[\s\S]*?\"\"\"|'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"))|(@[A-Za-z_]\w*)|(\b(?:0[xX][0-9A-Fa-f_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?j?)\b)|(\b[A-Za-z_]\w*\b)/g;
  let out = '';
  let last = 0;
  const wrap = (cls, text) => `<span class="py-${cls}">${escapeHtml(text)}</span>`;
  source.replace(tokenRe, (match, comment, string, decorator, number, word, offset) => {
    out += escapeHtml(source.slice(last, offset));
    if (comment) out += wrap('comment', comment);
    else if (string) out += wrap('string', string);
    else if (decorator) out += wrap('decorator', decorator);
    else if (number) out += wrap('number', number);
    else if (keywords.has(word)) out += wrap('keyword', word);
    else if (builtins.has(word)) out += wrap('builtin', word);
    else out += escapeHtml(word);
    last = offset + match.length;
    return match;
  });
  out += escapeHtml(source.slice(last));
  return out;
}

function renderPythonPreviewInto(container, code) {
  if (!container) return;
  container.innerHTML = `<pre class="python-code-preview"><code>${highlightPythonCode(code)}</code></pre>`;
}

function renderMarkdownPreviewInto(container, markdown) {
  if (!container) return;
  if (typeof renderMarkdown === 'function') {
    container.innerHTML = renderMarkdown(String(markdown || ''));
    if (typeof postRender === 'function') postRender(container);
  } else {
    container.innerHTML = `<pre>${escapeHtml(String(markdown || ''))}</pre>`;
  }
}

function updateFileEditorMarkdownPreview() {
  const textarea = fileEditorTextarea();
  const preview = document.getElementById('fileEditorMarkdownPreview');
  if (!textarea || !preview) return;
  renderMarkdownPreviewInto(preview, fileEditorCurrentValue());
}

function setFileEditorMarkdownPreview(enabled) {
  const path = FILE_EXPLORER_STATE.editorPath;
  const isMarkdown = isFileExplorerMarkdownFile(path);
  const textarea = fileEditorTextarea();
  const shell = fileEditorCodeShell();
  const preview = document.getElementById('fileEditorMarkdownPreview');
  const toggle = document.getElementById('fileEditorMarkdownToggle');
  const saveBtn = document.getElementById('fileEditorSaveBtn');
  const nextEnabled = !!enabled && isMarkdown;
  FILE_EXPLORER_STATE.editorCodePreview = false;
  FILE_EXPLORER_STATE.editorMarkdownPreview = nextEnabled;
  setPythonEditorMode(isFileExplorerPythonFile(path) && !nextEnabled);
  if (textarea) textarea.hidden = false;
  if (shell) shell.hidden = nextEnabled;
  if (preview) {
    preview.classList.remove('file-editor-code-preview');
    preview.classList.add('markdown-preview', 'file-editor-markdown-preview', 'msg-content');
    preview.hidden = !nextEnabled;
    if (nextEnabled) updateFileEditorMarkdownPreview();
  }
  if (toggle) {
    toggle.hidden = !isMarkdown;
    toggle.textContent = nextEnabled ? '编辑源码' : 'Markdown 预览';
    toggle.classList.toggle('active', nextEnabled);
  }
  const codeToggle = document.getElementById('fileEditorCodeToggle');
  if (codeToggle) {
    codeToggle.hidden = !isFileExplorerPythonFile(path);
    codeToggle.textContent = 'Python 高亮预览';
    codeToggle.classList.remove('active');
  }
  if (saveBtn) saveBtn.hidden = nextEnabled;
  if (!nextEnabled && textarea && !textarea.disabled) textarea.focus();
}

function updateFileEditorCodePreview() {
  const textarea = fileEditorTextarea();
  const preview = document.getElementById('fileEditorMarkdownPreview');
  if (!textarea || !preview) return;
  renderPythonPreviewInto(preview, fileEditorCurrentValue());
}

function setFileEditorCodePreview(enabled) {
  const path = FILE_EXPLORER_STATE.editorPath;
  const isPython = isFileExplorerPythonFile(path);
  const textarea = fileEditorTextarea();
  const shell = fileEditorCodeShell();
  const preview = document.getElementById('fileEditorMarkdownPreview');
  const toggle = document.getElementById('fileEditorCodeToggle');
  const markdownToggle = document.getElementById('fileEditorMarkdownToggle');
  const saveBtn = document.getElementById('fileEditorSaveBtn');
  const nextEnabled = !!enabled && isPython;
  FILE_EXPLORER_STATE.editorMarkdownPreview = false;
  FILE_EXPLORER_STATE.editorCodePreview = nextEnabled;
  if (shell) shell.hidden = nextEnabled;
  if (preview) {
    preview.classList.remove('markdown-preview', 'file-editor-markdown-preview', 'msg-content');
    preview.classList.add('file-editor-code-preview');
    preview.hidden = !nextEnabled;
    if (nextEnabled) updateFileEditorCodePreview();
  }
  if (toggle) {
    toggle.hidden = !isPython;
    toggle.textContent = nextEnabled ? '编辑器' : 'Python 高亮预览';
    toggle.classList.toggle('active', nextEnabled);
  }
  if (markdownToggle) markdownToggle.hidden = !isFileExplorerMarkdownFile(path);
  if (saveBtn) saveBtn.hidden = nextEnabled;
  if (nextEnabled) syncFileEditorTextareaFromCodeMirror();
  if (textarea) textarea.hidden = false;
  setPythonEditorMode(isPython && !nextEnabled);
  if (!nextEnabled && textarea && !textarea.disabled) textarea.focus();
}

function toggleFileEditorMarkdownPreview() {
  setFileEditorMarkdownPreview(!FILE_EXPLORER_STATE.editorMarkdownPreview);
}

function toggleFileEditorCodePreview() {
  setFileEditorCodePreview(!FILE_EXPLORER_STATE.editorCodePreview);
}

async function openTextInMainPanel(path, initialContent = null, initialSize = null) {
  const normalizedPath = normalizeExplorerPath(path);
  if (!isFileExplorerTextFile(normalizedPath)) {
    fileExplorerToast('暂只支持文本类文件');
    return false;
  }
  if (!showInlineFilePanel('text', normalizedPath)) return false;
  const body = document.getElementById('inlineFileBody');
  const footer = document.getElementById('inlineFileFooter');
  if (!body || !footer) return false;
  clearInlineFileContent();
  const shell = document.createElement('div');
  const textarea = document.createElement('textarea');
  const preview = document.createElement('div');
  const isMarkdown = isFileExplorerMarkdownFile(normalizedPath);
  const isPython = isFileExplorerPythonFile(normalizedPath);
  shell.id = 'inlineFileCodeShell';
  shell.className = `file-editor-code-shell inline-file-code-shell${isPython ? ' python-editor' : ''}`;
  textarea.spellcheck = false;
  textarea.placeholder = '文件内容...';
  textarea.id = 'inlineFileTextContent';
  preview.className = 'markdown-preview inline-markdown-preview msg-content';
  preview.hidden = true;
  shell.appendChild(textarea);
  body.appendChild(shell);
  body.appendChild(preview);
  bindFileExplorerEditorWheelZoom(shell);
  footer.innerHTML = `
    <button class="btn" type="button" data-action="copyInlineFileContent">复制内容</button>
    ${isMarkdown ? '<button class="btn" type="button" id="inlineMarkdownToggle" data-action="toggleInlineMarkdownPreview">Markdown 预览</button>' : ''}
    ${isPython ? '<button class="btn" type="button" id="inlinePythonToggle" data-action="toggleInlinePythonPreview">Python 高亮预览</button>' : ''}
    <button class="btn btn-primary" type="button" data-action="saveInlineFilePanel">保存修改</button>
    <button class="btn" type="button" data-action="reloadInlineFilePanel">重新读取</button>
  `;
  const setContent = (content, disabled = false) => {
    const cm = FILE_EXPLORER_STATE.inlineCodeMirror;
    textarea.value = String(content || '');
    textarea.disabled = !!disabled;
    if (cm) {
      cm.setValue(textarea.value);
      cm.setOption('readOnly', !!disabled);
      scheduleInlineFileLayoutRefresh();
    }
    if (isMarkdown && FILE_EXPLORER_STATE.inlineFileKind === 'markdown') renderMarkdownPreviewInto(preview, inlineFileCurrentValue());
    if (isPython && FILE_EXPLORER_STATE.inlineFileKind === 'python') renderPythonPreviewInto(preview, inlineFileCurrentValue());
  };
  ensureInlineCodeMirror(normalizedPath);
  if (initialContent !== null && initialContent !== undefined) {
    setContent(initialContent, false);
    setInlineFileStatus(`${initialSize !== null && initialSize !== undefined ? formatSize(Number(initialSize || 0)) : `${textarea.value.length} 字符`} / 已显示`, 'ok');
    textarea.focus();
    return true;
  }
  textarea.disabled = true;
  setInlineFileStatus('正在读取...', 'loading');
  try {
    if (typeof callAgentBackend !== 'function') throw new Error('本地工具接口未加载');
    const r = await callAgentBackend('read_file', { path: normalizedPath }, undefined, undefined, fileExplorerBackendContext());
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '读取文件失败');
    setContent(r.content || '', false);
    setInlineFileStatus(`${formatSize(Number(r.size || 0))} / 已读取`, 'ok');
    textarea.focus();
    return true;
  } catch (e) {
    textarea.disabled = true;
    setInlineFileStatus(e.message || String(e), 'error');
  }
  return true;
}

function toggleInlineMarkdownPreview(force) {
  const path = FILE_EXPLORER_STATE.inlineFilePath;
  if (!isFileExplorerMarkdownFile(path)) return;
  const shell = inlineFileCodeShell();
  const preview = document.querySelector('#inlineFileBody .inline-markdown-preview');
  const toggle = document.getElementById('inlineMarkdownToggle');
  if (!shell || !preview) return;
  const showPreview = typeof force === 'boolean' ? force : preview.hidden;
  if (showPreview) renderMarkdownPreviewInto(preview, inlineFileCurrentValue());
  preview.hidden = !showPreview;
  shell.hidden = showPreview;
  FILE_EXPLORER_STATE.inlineFileKind = showPreview ? 'markdown' : 'text';
  if (toggle) {
    toggle.textContent = showPreview ? '查看源码' : 'Markdown 预览';
    toggle.classList.toggle('active', showPreview);
  }
  if (!showPreview && !refreshInlineCodeMirror()) inlineFileTextarea()?.focus();
}

function toggleInlinePythonPreview(force) {
  const path = FILE_EXPLORER_STATE.inlineFilePath;
  if (!isFileExplorerPythonFile(path)) return;
  const shell = inlineFileCodeShell();
  const preview = document.querySelector('#inlineFileBody .inline-markdown-preview, #inlineFileBody .inline-code-preview');
  const toggle = document.getElementById('inlinePythonToggle');
  if (!shell || !preview) return;
  const showPreview = typeof force === 'boolean' ? force : preview.hidden;
  if (showPreview) {
    preview.className = 'inline-code-preview';
    renderPythonPreviewInto(preview, inlineFileCurrentValue());
  }
  preview.hidden = !showPreview;
  shell.hidden = showPreview;
  FILE_EXPLORER_STATE.inlineFileKind = showPreview ? 'python' : 'text';
  if (toggle) {
    toggle.textContent = showPreview ? '编辑器' : 'Python 高亮预览';
    toggle.classList.toggle('active', showPreview);
  }
  if (!showPreview && !refreshInlineCodeMirror()) inlineFileTextarea()?.focus();
}

async function openPdfInMainPanel(path, existingUrl = '') {
  const normalizedPath = normalizeExplorerPath(path);
  if (!isFileExplorerPdfFile(normalizedPath)) {
    fileExplorerToast('仅支持 PDF 文件');
    return false;
  }
  if (!showInlineFilePanel('pdf', normalizedPath)) return false;
  const body = document.getElementById('inlineFileBody');
  const footer = document.getElementById('inlineFileFooter');
  if (!body || !footer) return false;
  clearInlineFileContent();
  const frame = document.createElement('iframe');
  frame.title = 'PDF 阅读器';
  body.appendChild(frame);
  footer.innerHTML = `
    <button class="btn" type="button" data-action="reloadInlineFilePanel">重新读取</button>
    <button class="btn" type="button" data-action="openInlineFileInNewTab">新标签打开</button>
  `;
  setInlineFileStatus('正在读取...', 'loading');
  try {
    const url = existingUrl || await fileExplorerPreviewUrl(normalizedPath);
    frame.src = url;
    setInlineFileStatus('直接预览 / 支持大文件', 'ok');
  } catch (e) {
    frame.removeAttribute('src');
    setInlineFileStatus(e.message || String(e), 'error');
  }
  return true;
}

async function openCurrentFileInMainPanel(kind) {
  if (kind === 'pdf') {
    const path = FILE_EXPLORER_STATE.pdfPath;
    const url = FILE_EXPLORER_STATE.pdfObjectUrl;
    if (!path) return;
    const opened = await openPdfInMainPanel(path, url);
    if (opened) closePdfViewer();
    return;
  }
  const path = FILE_EXPLORER_STATE.editorPath;
  const textarea = fileEditorTextarea();
  if (!path) return;
  const opened = await openTextInMainPanel(path, textarea ? fileEditorCurrentValue() : null);
  if (opened) closeFileEditor(true);
}

function copyInlineFileContent() {
  const value = inlineFileCurrentValue();
  if (value === null || value === undefined) return;
  navigator.clipboard.writeText(value).then(() => {
    fileExplorerToast('内容已复制');
  });
}

async function saveInlineFilePanel() {
  const path = FILE_EXPLORER_STATE.inlineFilePath;
  const textarea = inlineFileTextarea();
  if (!path || !textarea || !isFileExplorerTextFile(path)) return;
  if (textarea.disabled) {
    setInlineFileStatus('文件仍在读取或当前不可编辑', 'error');
    return;
  }
  syncInlineTextareaFromCodeMirror();
  const content = textarea.value;
  setInlineFileStatus('等待保存确认...', 'loading');
  const preview = content.slice(0, 500) + (content.length > 500 ? '\n...' : '');
  try {
    const r = await callAgentBackend(
      'write_file',
      { path, content },
      '保存主页面文件修改',
      `[保存文件] ${path}\n\n字符数：${content.length}\n\n${preview}`,
      fileExplorerBackendContext()
    );
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
    const previewEl = document.querySelector('#inlineFileBody .inline-markdown-preview, #inlineFileBody .inline-code-preview');
    if (previewEl && !previewEl.hidden && isFileExplorerMarkdownFile(path)) renderMarkdownPreviewInto(previewEl, content);
    if (previewEl && !previewEl.hidden && isFileExplorerPythonFile(path)) renderPythonPreviewInto(previewEl, content);
    setInlineFileStatus(`已保存 ${formatSize(Number(r.bytes_written || 0))}`, 'ok');
    fileExplorerToast('文件已保存');
    if (FILE_EXPLORER_STATE.visible) refreshFileExplorer();
  } catch (e) {
    setInlineFileStatus(e.message || String(e), 'error');
  }
}

async function reloadInlineFilePanel() {
  const path = FILE_EXPLORER_STATE.inlineFilePath;
  const kind = FILE_EXPLORER_STATE.inlineFileKind;
  if (!path) return;
  if (kind === 'pdf') await openPdfInMainPanel(path);
  else if (kind === 'text' || kind === 'markdown' || kind === 'python') await openTextInMainPanel(path);
}

function openInlineFileInNewTab() {
  const frame = document.querySelector('#inlineFileBody iframe');
  const src = frame ? frame.getAttribute('src') : '';
  if (src) window.open(src, '_blank', 'noopener');
}

function startInlineFileResize(event) {
  const mainContent = document.getElementById('mainContent');
  if (!mainContent || !mainContent.classList.contains('has-inline-file')) return;
  event.preventDefault();
  mainContent.classList.add('is-resizing');
  const onMove = e => {
    const rect = mainContent.getBoundingClientRect();
    if (!rect.width) return;
    const x = Math.min(rect.right, Math.max(rect.left, e.clientX));
    let chatPercent;
    if (FILE_EXPLORER_STATE.inlineFileSide === 'left') {
      const filePercent = ((x - rect.left) / rect.width) * 100;
      chatPercent = 100 - filePercent;
    } else {
      chatPercent = ((x - rect.left) / rect.width) * 100;
    }
    setInlineChatWidth(chatPercent);
  };
  const onUp = () => {
    mainContent.classList.remove('is-resizing');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function bindInlineFileResizer() {
  const resizer = document.getElementById('inlineFileResizer');
  if (!resizer || resizer.dataset.bound === '1') return;
  resizer.dataset.bound = '1';
  resizer.addEventListener('mousedown', startInlineFileResize);
}

function closeFileEditor(force = false) {
  const modal = document.getElementById('fileEditorModal');
  const textarea = fileEditorTextarea();
  syncFileEditorTextareaFromCodeMirror();
  if (!force && textarea && FILE_EXPLORER_STATE.editorPath && textarea.value !== FILE_EXPLORER_STATE.editorOriginal) {
    refreshFileEditorCodeMirror();
    if (!confirm('文件有未保存修改，确定关闭？')) return;
  }
  setPythonEditorMode(false);
  if (modal) modal.classList.remove('show');
  scheduleInlineFileLayoutRefresh();
}

async function openFileEditor(path) {
  const normalizedPath = normalizeExplorerPath(path);
  if (!isFileExplorerTextFile(normalizedPath)) {
    fileExplorerToast('暂只支持文本类文件');
    return;
  }
  const modal = document.getElementById('fileEditorModal');
  const pathEl = document.getElementById('fileEditorPath');
  const textarea = fileEditorTextarea();
  if (!modal || !textarea) return;
  FILE_EXPLORER_STATE.editorPath = normalizedPath;
  FILE_EXPLORER_STATE.editorOriginal = '';
  FILE_EXPLORER_STATE.editorFoldedLines = new Set();
  if (pathEl) pathEl.textContent = normalizedPath;
  textarea.value = '';
  textarea.disabled = true;
  textarea.hidden = false;
  setFileEditorMarkdownPreview(false);
  setFileEditorCodePreview(false);
  setFileEditorSyntaxMode(normalizedPath);
  modal.classList.add('show');
  setFileEditorStatus('正在读取...', 'loading');
  try {
    if (typeof callAgentBackend !== 'function') throw new Error('本地工具接口未加载');
    const r = await callAgentBackend('read_file', { path: normalizedPath }, undefined, undefined, fileExplorerBackendContext());
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '读取文件失败');
    textarea.value = r.content || '';
    textarea.disabled = false;
    if (FILE_EXPLORER_STATE.editorCodeMirror) {
      FILE_EXPLORER_STATE.editorCodeMirror.setValue(textarea.value);
    }
    FILE_EXPLORER_STATE.editorOriginal = textarea.value;
    setFileEditorMarkdownPreview(false);
    setFileEditorCodePreview(false);
    setFileEditorSyntaxMode(normalizedPath);
    if (FILE_EXPLORER_STATE.editorCodeMirror) {
      FILE_EXPLORER_STATE.editorCodeMirror.setOption('readOnly', false);
    }
    setFileEditorStatus(`${formatSize(Number(r.size || 0))} / 已读取`, 'ok');
    textarea.focus();
  } catch (e) {
    if (/文件过大/.test(e.message || String(e))) {
      try {
        const url = await fileExplorerPreviewUrl(normalizedPath);
        textarea.value = `文件较大，已改用浏览器只读预览：\n${url}\n\n如果没有自动打开，请复制上面的链接到浏览器。`;
        window.open(url, '_blank', 'noopener');
        setFileEditorStatus('文件较大 / 已打开只读预览', 'ok');
        return;
      } catch (_) {}
    }
    textarea.disabled = true;
    setFileEditorStatus(e.message || String(e), 'error');
  }
}

async function reloadFileEditor() {
  if (!FILE_EXPLORER_STATE.editorPath) return;
  const textarea = fileEditorTextarea();
  if (textarea && textarea.value !== FILE_EXPLORER_STATE.editorOriginal) {
    if (!confirm('重新读取会丢弃未保存修改，继续？')) return;
  }
  await openFileEditor(FILE_EXPLORER_STATE.editorPath);
}

async function saveFileEditor() {
  const path = FILE_EXPLORER_STATE.editorPath;
  const textarea = fileEditorTextarea();
  if (!path || !textarea) return;
  syncFileEditorTextareaFromCodeMirror();
  const content = textarea.value;
  setFileEditorStatus('等待保存确认...', 'loading');
  const preview = content.slice(0, 500) + (content.length > 500 ? '\n...' : '');
  try {
    const r = await callAgentBackend(
      'write_file',
      { path, content },
      '保存文本文件修改',
      `[保存文件] ${path}\n\n字符数：${content.length}\n\n${preview}`,
      fileExplorerBackendContext()
    );
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
    FILE_EXPLORER_STATE.editorOriginal = content;
    if (FILE_EXPLORER_STATE.editorMarkdownPreview) updateFileEditorMarkdownPreview();
    if (FILE_EXPLORER_STATE.editorCodePreview) updateFileEditorCodePreview();
    if (FILE_EXPLORER_STATE.editorPythonMode) refreshFileEditorCodeMirror() || renderPythonEditor();
    setFileEditorStatus(`已保存 ${formatSize(Number(r.bytes_written || 0))}`, 'ok');
    fileExplorerToast('文件已保存');
    if (FILE_EXPLORER_STATE.visible) refreshFileExplorer();
  } catch (e) {
    setFileEditorStatus(e.message || String(e), 'error');
  }
}

function handleFileExplorerSaveShortcut(event) {
  if (!event || !(event.ctrlKey || event.metaKey) || event.altKey || String(event.key || '').toLowerCase() !== 's') return;
  const target = event.target;
  const closest = target && typeof target.closest === 'function' ? selector => target.closest(selector) : () => null;
  const modal = document.getElementById('fileEditorModal');
  if (modal && modal.classList.contains('show') && closest('#fileEditorModal')) {
    event.preventDefault();
    event.stopPropagation();
    saveFileEditor();
    return;
  }
  const panel = document.getElementById('inlineFilePanel');
  if (panel && !panel.hidden && closest('#inlineFilePanel')) {
    event.preventDefault();
    event.stopPropagation();
    saveInlineFilePanel();
  }
}

function copyFileEditorContent() {
  syncFileEditorTextareaFromCodeMirror();
  const textarea = fileEditorTextarea();
  if (!textarea) return;
  navigator.clipboard.writeText(textarea.value).then(() => {
    fileExplorerToast('内容已复制');
  });
}

async function openFileWithSystemDefault(path) {
  const normalizedPath = normalizeExplorerPath(path);
  if (isFileExplorerRemoteMode()) {
    fileExplorerToast(`远程连接时不能用本机默认应用直接打开远程文件：${fileExplorerBasename(normalizedPath)}。请使用预览或下载。`, 5200);
    return;
  }
  try {
    if (typeof callAgentBackend !== 'function') throw new Error('本地工具接口未加载');
    const r = await callAgentBackend('open_file_default', { path: normalizedPath }, undefined, undefined, fileExplorerBackendContext());
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '系统默认应用打开失败');
    fileExplorerToast(`已使用系统默认应用打开：${fileExplorerBasename(normalizedPath)}`);
  } catch (e) {
    fileExplorerToast(`无法使用系统默认应用打开：${e.message || String(e)}`);
  }
}

async function openFileExplorerPath(path, type = '') {
  const resolved = resolveFileExplorerOpenPath(path);
  if (!resolved.ok) {
    fileExplorerToast(resolved.error || '无法打开路径', 5200);
    return;
  }
  let normalizedPath = resolved.path;
  if (!type && isBareFileExplorerFileReference(normalizedPath)) {
    const found = await resolveBareFileExplorerFileReference(normalizedPath);
    if (!found.ok) {
      fileExplorerToast(found.error || 'Unable to resolve file reference', 6500);
      return;
    }
    normalizedPath = found.path;
  }
  if (type === 'dir') {
    loadFileExplorer(normalizedPath);
    return;
  }
  if (isFileExplorerTextFile(normalizedPath)) openFileEditor(normalizedPath);
  else if (isFileExplorerPdfFile(normalizedPath)) openPdfViewer(normalizedPath);
  else if (isFileExplorerImageFile(normalizedPath)) openImageViewer(normalizedPath);
  else if (isFileExplorerMediaFile(normalizedPath)) openMediaViewer(normalizedPath);
  else openFileWithSystemDefault(normalizedPath);
}

function siblingExplorerPath(path, newName) {
  const parent = parentExplorerPath(path);
  const cleanName = String(newName || '').replace(/[\\/]+/g, '').trim();
  if (!cleanName) return '';
  return joinExplorerPath(parent, cleanName);
}

function fileExplorerBasename(path) {
  return String(path || '').split('/').filter(Boolean).pop() || '';
}

async function compileTexFile(path = FILE_EXPLORER_STATE.contextPath) {
  const normalizedPath = normalizeExplorerPath(path);
  if (!isFileExplorerTexFile(normalizedPath)) {
    fileExplorerToast('仅支持编译 .tex 文件');
    return;
  }
  try {
    fileExplorerToast('正在调用 xelatex 编译...');
    if (typeof callAgentBackend !== 'function') throw new Error('本地工具接口未加载');
    const r = await callAgentBackend('compile_tex', { path: normalizedPath }, undefined, undefined, fileExplorerBackendContext({ skipConfirm: true }));
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) {
      const installHint = r && r.install_hint ? `\n${r.install_hint}` : '';
      throw new Error(((r && r.error) || 'TeX 编译失败') + installHint);
    }
    const pdfPath = normalizeExplorerPath(r.pdf_path || normalizedPath.replace(/\.tex$/i, '.pdf'));
    fileExplorerToast('编译完成，正在打开 PDF...');
    if (FILE_EXPLORER_STATE.visible) refreshFileExplorer();
    await openPdfViewer(pdfPath);
  } catch (e) {
    const message = e.message || String(e);
    if (FileExplorerUiService.has('toast')) fileExplorerToast(message, 6000);
    else alert(message);
  }
}

function setPdfViewerStatus(message, kind = '') {
  const el = document.getElementById('pdfViewerStatus');
  if (!el) return;
  el.textContent = message || '';
  el.className = kind ? `file-editor-status ${kind}` : 'file-editor-status';
}

function clearPdfViewerObjectUrl() {
  if (FILE_EXPLORER_STATE.pdfObjectUrl) {
    URL.revokeObjectURL(FILE_EXPLORER_STATE.pdfObjectUrl);
    FILE_EXPLORER_STATE.pdfObjectUrl = '';
  }
}

function dataUrlToBlob(dataUrl) {
  const text = String(dataUrl || '');
  const match = text.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) throw new Error('PDF 数据格式无效');
  const mime = match[1] || 'application/pdf';
  const isBase64 = !!match[2];
  const raw = isBase64 ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function openPdfViewer(path) {
  const normalizedPath = normalizeExplorerPath(path);
  if (!isFileExplorerPdfFile(normalizedPath)) {
    fileExplorerToast('仅支持 PDF 文件');
    return;
  }
  const modal = document.getElementById('pdfViewerModal');
  const pathEl = document.getElementById('pdfViewerPath');
  const frame = document.getElementById('pdfViewerFrame');
  if (!modal || !frame) return;

  FILE_EXPLORER_STATE.pdfPath = normalizedPath;
  if (pathEl) pathEl.textContent = normalizedPath;
  frame.removeAttribute('src');
  clearPdfViewerObjectUrl();
  modal.classList.add('show');
  setPdfViewerStatus('正在读取...', 'loading');

  try {
    const url = await fileExplorerPreviewUrl(normalizedPath);
    FILE_EXPLORER_STATE.pdfObjectUrl = url;
    frame.src = url;
    setPdfViewerStatus('直接预览 / 支持大文件', 'ok');
  } catch (e) {
    frame.removeAttribute('src');
    clearPdfViewerObjectUrl();
    setPdfViewerStatus(e.message || String(e), 'error');
  }
}

function closePdfViewer() {
  const modal = document.getElementById('pdfViewerModal');
  const frame = document.getElementById('pdfViewerFrame');
  if (frame) frame.removeAttribute('src');
  clearPdfViewerObjectUrl();
  if (modal) modal.classList.remove('show');
}

async function reloadPdfViewer() {
  if (!FILE_EXPLORER_STATE.pdfPath) return;
  await openPdfViewer(FILE_EXPLORER_STATE.pdfPath);
}

function openPdfViewerInNewTab() {
  if (!FILE_EXPLORER_STATE.pdfObjectUrl) return;
  window.open(FILE_EXPLORER_STATE.pdfObjectUrl, '_blank', 'noopener');
}

function setImageViewerStatus(message, kind = '') {
  const el = document.getElementById('imageViewerStatus');
  if (!el) return;
  el.textContent = message || '';
  el.className = kind ? `file-editor-status ${kind}` : 'file-editor-status';
}

function clearImageViewerObjectUrl() {
  if (FILE_EXPLORER_STATE.imageObjectUrl) {
    URL.revokeObjectURL(FILE_EXPLORER_STATE.imageObjectUrl);
    FILE_EXPLORER_STATE.imageObjectUrl = '';
  }
}

async function openImageViewer(path) {
  const normalizedPath = normalizeExplorerPath(path);
  if (!isFileExplorerImageFile(normalizedPath)) {
    fileExplorerToast('仅支持图片文件');
    return;
  }
  const modal = document.getElementById('imageViewerModal');
  const pathEl = document.getElementById('imageViewerPath');
  const img = document.getElementById('imageViewerImg');
  if (!modal || !img) return;

  FILE_EXPLORER_STATE.imagePath = normalizedPath;
  if (pathEl) pathEl.textContent = normalizedPath;
  img.removeAttribute('src');
  clearImageViewerObjectUrl();
  modal.classList.add('show');
  setImageViewerStatus('正在读取...', 'loading');

  try {
    const src = await fileExplorerPreviewUrl(normalizedPath);
    FILE_EXPLORER_STATE.imageObjectUrl = src;

    img.onload = () => {
      const sizeText = `${img.naturalWidth || '?'}×${img.naturalHeight || '?'}`;
      setImageViewerStatus(`${sizeText} / 直接预览`, 'ok');
    };
    img.onerror = () => {
      setImageViewerStatus('浏览器无法预览该图片格式', 'error');
    };
    img.src = src;
  } catch (e) {
    img.removeAttribute('src');
    clearImageViewerObjectUrl();
    setImageViewerStatus(e.message || String(e), 'error');
  }
}

function closeImageViewer() {
  const modal = document.getElementById('imageViewerModal');
  const img = document.getElementById('imageViewerImg');
  if (img) img.removeAttribute('src');
  clearImageViewerObjectUrl();
  if (modal) modal.classList.remove('show');
}

async function reloadImageViewer() {
  if (!FILE_EXPLORER_STATE.imagePath) return;
  await openImageViewer(FILE_EXPLORER_STATE.imagePath);
}

function openImageViewerInNewTab() {
  if (!FILE_EXPLORER_STATE.imageObjectUrl) return;
  window.open(FILE_EXPLORER_STATE.imageObjectUrl, '_blank', 'noopener');
}

function setMediaViewerStatus(message, kind = '') {
  const el = document.getElementById('mediaViewerStatus');
  if (!el) return;
  el.textContent = message || '';
  el.className = kind ? `file-editor-status ${kind}` : 'file-editor-status';
}

function clearMediaViewerObjectUrl() {
  if (FILE_EXPLORER_STATE.mediaObjectUrl) {
    URL.revokeObjectURL(FILE_EXPLORER_STATE.mediaObjectUrl);
    FILE_EXPLORER_STATE.mediaObjectUrl = '';
  }
}

function resetMediaPlayers() {
  const audio = document.getElementById('audioViewerPlayer');
  const video = document.getElementById('videoViewerPlayer');
  [audio, video].forEach(player => {
    if (!player) return;
    try { player.pause(); } catch (_) {}
    player.removeAttribute('src');
    player.hidden = true;
    try { player.load(); } catch (_) {}
  });
}

function activeMediaPlayer(kind) {
  return document.getElementById(kind === 'video' ? 'videoViewerPlayer' : 'audioViewerPlayer');
}

async function openMediaViewer(path) {
  const normalizedPath = normalizeExplorerPath(path);
  const kind = isFileExplorerVideoFile(normalizedPath) ? 'video' : (isFileExplorerAudioFile(normalizedPath) ? 'audio' : '');
  if (!kind) {
    fileExplorerToast('仅支持音频/视频文件');
    return;
  }

  const modal = document.getElementById('mediaViewerModal');
  const title = document.getElementById('mediaViewerTitle');
  const pathEl = document.getElementById('mediaViewerPath');
  if (!modal) return;

  FILE_EXPLORER_STATE.mediaPath = normalizedPath;
  FILE_EXPLORER_STATE.mediaKind = kind;
  if (title) title.textContent = kind === 'video' ? '视频预览器' : '音频预览器';
  if (pathEl) pathEl.textContent = normalizedPath;
  resetMediaPlayers();
  clearMediaViewerObjectUrl();
  modal.classList.add('show');
  setMediaViewerStatus('正在读取...', 'loading');

  try {
    const src = await fileExplorerPreviewUrl(normalizedPath);
    FILE_EXPLORER_STATE.mediaObjectUrl = src;

    const player = activeMediaPlayer(kind);
    if (!player) return;
    player.hidden = false;
    player.onloadedmetadata = () => {
      const duration = Number.isFinite(player.duration) ? ` / ${formatMediaDuration(player.duration)}` : '';
      const resolution = kind === 'video' && player.videoWidth ? ` / ${player.videoWidth}×${player.videoHeight}` : '';
      setMediaViewerStatus(`直接预览${duration}${resolution} / 支持大文件`, 'ok');
    };
    player.onerror = () => setMediaViewerStatus('浏览器无法预览该媒体格式', 'error');
    player.src = src;
    player.load();
  } catch (e) {
    resetMediaPlayers();
    clearMediaViewerObjectUrl();
    setMediaViewerStatus(e.message || String(e), 'error');
  }
}

function formatMediaDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function closeMediaViewer() {
  const modal = document.getElementById('mediaViewerModal');
  resetMediaPlayers();
  clearMediaViewerObjectUrl();
  if (modal) modal.classList.remove('show');
}

async function reloadMediaViewer() {
  if (!FILE_EXPLORER_STATE.mediaPath) return;
  await openMediaViewer(FILE_EXPLORER_STATE.mediaPath);
}

function openMediaViewerInNewTab() {
  if (!FILE_EXPLORER_STATE.mediaObjectUrl) return;
  window.open(FILE_EXPLORER_STATE.mediaObjectUrl, '_blank', 'noopener');
}

function fileExplorerGoUp() {
  const parent = currentFileExplorerParentPath();
  if (parent !== FILE_EXPLORER_STATE.path) loadFileExplorer(parent);
}

async function graphicalFileExplorerGoParent() {
  const current = normalizeExplorerPath(FILE_EXPLORER_STATE.path);
  const parent = currentFileExplorerParentPath();
  if (parent === current) return;
  await navigateGraphicalFileExplorer(parent);
}

async function graphicalFileExplorerGoForward() {
  const target = popGraphicalFileExplorerRecentTarget();
  if (!target || target === normalizeExplorerPath(FILE_EXPLORER_STATE.path)) return;
  await loadFileExplorer(target, { preserveGraphForward: true });
}

async function navigateGraphicalFileExplorer(path, options = {}) {
  const target = normalizeGraphicalFileExplorerRecentPath(path);
  const current = normalizeExplorerPath(FILE_EXPLORER_STATE.path);
  if (!target || target === current) return false;
  pushGraphicalFileExplorerRecentPath(current);
  return loadFileExplorer(target, { ...(options || {}), preserveGraphForward: true });
}

function fileExplorerItemTextRight(item) {
  const name = item ? item.querySelector('.file-explorer-name') : null;
  if (!name) return 0;
  const nameRect = name.getBoundingClientRect();
  let textRight = nameRect.left;
  const range = document.createRange();
  try {
    range.selectNodeContents(name);
    const rects = Array.from(range.getClientRects());
    for (const rect of rects) textRight = Math.max(textRight, rect.right);
  } catch (_) {
    textRight = nameRect.right;
  } finally {
    try { range.detach(); } catch (_) {}
  }
  return Math.min(textRight, nameRect.right);
}

function isFileExplorerItemBlankEvent(event, item) {
  if (!event || !item) return false;
  const itemRect = item.getBoundingClientRect();
  if (event.clientX < itemRect.left || event.clientX > itemRect.right) return false;
  const meta = item.querySelector('.file-explorer-meta');
  if (meta && meta.contains(event.target)) return false;
  const metaRect = meta ? meta.getBoundingClientRect() : null;
  if (metaRect && event.clientX >= metaRect.left - 4 && event.clientX <= metaRect.right + 4) return false;
  const textRight = fileExplorerItemTextRight(item);
  return !!textRight && event.clientX > textRight + 18;
}

function fileExplorerItemFromPointerEvent(event) {
  const item = event.target.closest('.file-explorer-item');
  if (!item) return null;
  return isFileExplorerItemBlankEvent(event, item) ? null : item;
}

function fileExplorerItemButtonFromEvent(event) {
  return event && event.target ? event.target.closest('.file-explorer-item') : null;
}

function showFileExplorerContextMenu(event, item, options = {}) {
  event.preventDefault();
  const isItem = !!item;
  const scope = options.scope || (isItem ? 'item' : 'blank');
  const path = options.path || (isItem ? (item.dataset.path || '.') : FILE_EXPLORER_STATE.path);
  const type = options.type || (isItem ? (item.dataset.type || '') : 'dir');
  if (isItem && fileExplorerSelectionCount() && !isFileExplorerPathSelected(path)) {
    clearFileExplorerSelection({ render: false });
    renderFileExplorer();
  }
  FILE_EXPLORER_STATE.contextPath = path;
  FILE_EXPLORER_STATE.contextType = type;
  FILE_EXPLORER_STATE.contextScope = scope;

  const menu = ensureFileExplorerContextMenu();
  renderFileExplorerQuickAccessMenu(menu);
  menu.querySelectorAll('[data-menu-section]').forEach(section => {
    section.hidden = section.dataset.menuSection !== FILE_EXPLORER_STATE.contextScope;
  });
  menu.querySelectorAll('[data-tex-only]').forEach(btn => {
    btn.hidden = !(isItem && type !== 'dir' && isFileExplorerTexFile(path));
  });
  menu.querySelectorAll('[data-paste-only]').forEach(btn => {
    const needsDir = btn.dataset.dirOnly === 'true';
    btn.hidden = !FILE_EXPLORER_STATE.clipboard || (needsDir && type !== 'dir');
  });
  menu.querySelectorAll('[data-clipboard-only]').forEach(btn => {
    btn.hidden = !FILE_EXPLORER_STATE.clipboard;
  });
  menu.querySelectorAll('[data-remote-only]').forEach(btn => {
    btn.hidden = !isFileExplorerRemoteMode();
  });
  const currentInQuickAccess = FILE_EXPLORER_STATE.contextScope === 'blank'
    && currentFileExplorerQuickAccessIndex() >= 0;
  menu.querySelectorAll('[data-current-quick-access-only]').forEach(btn => {
    btn.hidden = !currentInQuickAccess;
  });
  menu.querySelectorAll('[data-add-quick-access-only]').forEach(btn => {
    btn.hidden = currentInQuickAccess || currentFileExplorerIsSandboxRoot();
  });
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const padding = 8;
  const hasQuickAccess = loadFileExplorerQuickAccess().length > 0 && FILE_EXPLORER_STATE.contextScope === 'blank';
  const submenuReserve = hasQuickAccess ? 330 : 0;
  const left = Math.min(event.clientX, window.innerWidth - rect.width - submenuReserve - padding);
  const top = Math.min(event.clientY, window.innerHeight - rect.height - padding);
  menu.style.left = `${Math.max(padding, left)}px`;
  menu.style.top = `${Math.max(padding, top)}px`;
}

function handleFileExplorerClick(event) {
  const item = fileExplorerItemButtonFromEvent(event);
  if (!item) {
    if (fileExplorerSelectionCount()) clearFileExplorerSelection();
    return;
  }
  const path = item.dataset.path || '.';
  const type = item.dataset.type || '';
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    toggleFileExplorerSelection(path, type);
    return;
  }
  clearFileExplorerSelection();
  if (type === 'dir' && item.closest('#fileExplorerGraphList')) {
    navigateGraphicalFileExplorer(path);
    return;
  }
  openFileExplorerPath(path, type);
}

function handleFileExplorerContextMenu(event) {
  const item = fileExplorerItemFromPointerEvent(event);
  const list = event.currentTarget;
  if (!item && list && !list.contains(event.target)) return;
  showFileExplorerContextMenu(event, item || null);
}

function handleFileExplorerItemDragStart(event) {
  const item = fileExplorerItemButtonFromEvent(event);
  if (!item || !event.dataTransfer) return;
  const path = item.dataset.path || '';
  const type = item.dataset.type || '';
  const items = fileExplorerOperationItemsFor(path, type);
  if (!items.length) return;
  FILE_EXPLORER_STATE.dragItems = items;
  FILE_EXPLORER_STATE.dragTargetPath = '';
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-agent-file-explorer-items', JSON.stringify(items));
  event.dataTransfer.setData('text/plain', items.map(dragItem => dragItem.path).join('\n'));
  updateFileExplorerDragClasses();
}

function handleFileExplorerItemDragOver(event) {
  const target = fileExplorerDropTargetFromEvent(event);
  const items = fileExplorerDragItemsFromEvent(event);
  const targetPath = target ? (target.dataset.path || '') : '';
  if (target && canDropFileExplorerItemsOnDirectory(items, targetPath)) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    setFileExplorerDragTarget(targetPath);
    return;
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
  setFileExplorerDragTarget('');
}

function handleFileExplorerItemDragLeave(event) {
  const target = fileExplorerDropTargetFromEvent(event);
  if (!target) return;
  const related = event.relatedTarget;
  if (related && target.contains(related)) return;
  if (normalizeExplorerPath(FILE_EXPLORER_STATE.dragTargetPath) === normalizeExplorerPath(target.dataset.path || '')) {
    setFileExplorerDragTarget('');
  }
}

async function handleFileExplorerItemDrop(event) {
  const target = fileExplorerDropTargetFromEvent(event);
  const items = fileExplorerDragItemsFromEvent(event);
  const targetPath = target ? (target.dataset.path || '') : '';
  if (!target || !canDropFileExplorerItemsOnDirectory(items, targetPath)) {
    clearFileExplorerDragState();
    return;
  }
  event.preventDefault();
  clearFileExplorerDragState();
  await moveFileExplorerItemsToDirectory(items, targetPath);
}

function bindFileExplorerDragAndDrop(list) {
  if (!list || list.dataset.fileExplorerDragBound === 'true') return;
  list.dataset.fileExplorerDragBound = 'true';
  list.addEventListener('dragstart', handleFileExplorerItemDragStart);
  list.addEventListener('dragenter', handleFileExplorerItemDragOver);
  list.addEventListener('dragover', handleFileExplorerItemDragOver);
  list.addEventListener('dragleave', handleFileExplorerItemDragLeave);
  list.addEventListener('drop', handleFileExplorerItemDrop);
  list.addEventListener('dragend', clearFileExplorerDragState);
}

function uniqueExplorerChildPath(basePath, name) {
  const normalizedBase = normalizeExplorerPath(basePath || FILE_EXPLORER_STATE.path);
  const cleanName = String(name || '').replace(/[\\/]+/g, '').trim();
  if (!cleanName) return '';
  return joinExplorerPath(normalizedBase, cleanName);
}

async function createFileExplorerFile(basePath = FILE_EXPLORER_STATE.contextPath) {
  const name = prompt('输入新文件名称', '新建文件.txt');
  if (name === null) return;
  const path = uniqueExplorerChildPath(basePath, name);
  if (!path) {
    fileExplorerToast('文件名不能为空，且不能包含路径分隔符');
    return;
  }
  try {
    const r = await callAgentBackend('create_file', { path, content: '' }, undefined, undefined, fileExplorerBackendContext({ skipConfirm: true }));
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '新建文件失败');
    fileExplorerToast('已新建文件');
    await loadFileExplorer(basePath || FILE_EXPLORER_STATE.path);
    openFileEditor(path);
  } catch (e) {
    fileExplorerToast(e.message || String(e));
  }
}

async function createFileExplorerFolder(basePath = FILE_EXPLORER_STATE.contextPath) {
  const name = prompt('输入新文件夹名称', '新建文件夹');
  if (name === null) return;
  const path = uniqueExplorerChildPath(basePath, name);
  if (!path) {
    fileExplorerToast('文件夹名不能为空，且不能包含路径分隔符');
    return;
  }
  try {
    const r = await callAgentBackend('create_dir', { path }, undefined, undefined, fileExplorerBackendContext({ skipConfirm: true }));
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '新建文件夹失败');
    fileExplorerToast('已新建文件夹');
    refreshFileExplorer();
  } catch (e) {
    fileExplorerToast(e.message || String(e));
  }
}

async function switchFileExplorerWorkspace(path = FILE_EXPLORER_STATE.contextPath) {
  const normalizedPath = normalizeExplorerPath(path || FILE_EXPLORER_STATE.path);
  try {
    const r = await callAgentBackend('set_workspace', { path: normalizedPath }, undefined, undefined, fileExplorerBackendContext({ skipConfirm: true }));
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '切换工作区失败');
    if (typeof noteRemoteWorkspaceChanged === 'function') noteRemoteWorkspaceChanged(r.workspace || r.cwd || normalizedPath);
    FILE_EXPLORER_STATE.path = '.';
    FILE_EXPLORER_STATE.entries = [];
    fileExplorerToast('已切换工作区');
    await loadFileExplorer('.');
  } catch (e) {
    fileExplorerToast(e.message || String(e));
  }
}

async function copyFileExplorerRelativePath(path = FILE_EXPLORER_STATE.contextPath) {
  const normalizedPath = normalizeExplorerPath(path);
  try {
    await navigator.clipboard.writeText(normalizedPath);
    fileExplorerToast('相对路径已复制');
  } catch (e) {
    fileExplorerToast('复制失败：' + (e.message || String(e)));
  }
}

async function copyFileExplorerPath(path = FILE_EXPLORER_STATE.contextPath) {
  return copyFileExplorerRelativePath(path);
}

async function copyFileExplorerAbsolutePath(path = FILE_EXPLORER_STATE.contextPath) {
  const absolutePath = fileExplorerAbsolutePathFor(path);
  if (!absolutePath) {
    fileExplorerToast('无法获取沙箱绝对路径');
    return;
  }
  try {
    await navigator.clipboard.writeText(absolutePath);
    fileExplorerToast('绝对路径已复制');
  } catch (e) {
    fileExplorerToast('复制失败：' + (e.message || String(e)));
  }
}

function closeFileExplorerDetails() {
  const modal = document.getElementById('fileExplorerDetailsModal');
  if (modal) modal.classList.remove('show');
}

function ensureFileExplorerDetailsModal() {
  let modal = document.getElementById('fileExplorerDetailsModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'fileExplorerDetailsModal';
  modal.className = 'modal-mask file-details-mask';
  modal.innerHTML = `
    <div class="modal file-details-modal">
      <h2>
        <span>详情</span>
        <button class="modal-close" type="button" data-file-details-close>×</button>
      </h2>
      <div id="fileExplorerDetailsContent" class="file-details-content">
        <div class="file-details-empty">正在读取详情...</div>
      </div>
      <div class="modal-footer file-details-footer">
        <button class="btn" type="button" data-file-details-close>关闭</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', event => {
    if (event.target === modal || event.target.closest('[data-file-details-close]')) {
      closeFileExplorerDetails();
    }
  });
  document.body.appendChild(modal);
  return modal;
}

function fileExplorerPlatformLabel(platform) {
  const value = String(platform || '').toLowerCase();
  if (value === 'windows') return 'Windows';
  if (value === 'linux') return 'Linux';
  if (value === 'darwin') return 'macOS';
  return value || '未知';
}

function fileExplorerKindLabel(kind, fallbackType = '') {
  const value = String(kind || fallbackType || '').toLowerCase();
  const labels = {
    dir: '文件夹',
    file: '文件',
    symlink: '符号链接',
    fifo: '命名管道',
    socket: 'Socket',
    char_device: '字符设备',
    block_device: '块设备',
    other: '其他'
  };
  return labels[value] || value || '未知';
}

function fileExplorerBooleanLabel(value) {
  return value ? '是' : '否';
}

function fileExplorerHasDetailValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function formatFileExplorerDetailBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(bytes) : size.toFixed(unit === 1 ? 1 : 2);
  return unit === 0 ? `${text} ${units[unit]}` : `${text} ${units[unit]} (${bytes} B)`;
}

function formatFileExplorerDetailTime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  try {
    return new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });
  } catch (_) {
    return '';
  }
}

function fileExplorerDetailAttrsText(attrs) {
  if (!attrs || typeof attrs !== 'object') return '';
  const flags = [];
  if (attrs.read_only) flags.push('只读');
  if (attrs.hidden) flags.push('隐藏');
  if (attrs.system) flags.push('系统');
  if (attrs.archive) flags.push('存档');
  if (attrs.temporary) flags.push('临时');
  if (attrs.compressed) flags.push('压缩');
  if (attrs.encrypted) flags.push('加密');
  return flags.length ? flags.join('、') : '普通';
}

function fileExplorerDetailRowsHtml(rows) {
  return rows
    .filter(row => row && fileExplorerHasDetailValue(row.value))
    .map(row => {
      const value = String(row.value);
      const valueHtml = row.code
        ? `<code title="${escapeHtml(value)}">${escapeHtml(value)}</code>`
        : escapeHtml(value);
      return `
        <div class="file-details-row">
          <div class="file-details-label">${escapeHtml(row.label)}</div>
          <div class="file-details-value">${valueHtml}</div>
        </div>
      `;
    })
    .join('');
}

function fileExplorerDetailSectionHtml(title, rows) {
  const body = fileExplorerDetailRowsHtml(rows);
  if (!body) return '';
  return `
    <section class="file-details-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="file-details-grid">${body}</div>
    </section>
  `;
}

function renderFileExplorerDetails(info) {
  const modal = ensureFileExplorerDetailsModal();
  const content = modal.querySelector('#fileExplorerDetailsContent');
  if (!content) return;
  const platform = String(info.platform || '').toLowerCase();
  const isWindows = platform === 'windows';
  const attrs = info.windows_attributes && typeof info.windows_attributes === 'object' ? info.windows_attributes : null;
  const name = info.name || fileExplorerBasename(info.path || FILE_EXPLORER_STATE.contextPath);
  const typeLabel = fileExplorerKindLabel(info.kind, info.type);
  const absolutePath = info.absolute_path || info.path || '';
  const realPath = info.real_path && info.real_path !== absolutePath ? info.real_path : '';
  const owner = info.user ? `${info.user} (${info.uid})` : info.uid;
  const group = info.group ? `${info.group} (${info.gid})` : info.gid;
  const platformSectionTitle = isWindows ? 'Windows 详情' : (platform === 'linux' ? 'Linux 详情' : `${fileExplorerPlatformLabel(platform)} 详情`);

  const commonRows = [
    { label: '名称', value: name },
    { label: '类型', value: typeLabel },
    { label: '平台', value: fileExplorerPlatformLabel(platform) },
    { label: '绝对路径', value: absolutePath, code: true },
    { label: '真实路径', value: realPath, code: true },
    { label: '所在目录', value: info.parent, code: true },
    { label: '扩展名', value: info.extension ? `.${info.extension}` : '' },
    { label: '大小', value: formatFileExplorerDetailBytes(info.size) },
    { label: '修改时间', value: formatFileExplorerDetailTime(info.modified) },
    { label: '访问时间', value: formatFileExplorerDetailTime(info.accessed) }
  ];

  const platformRows = isWindows ? [
    { label: '创建时间', value: formatFileExplorerDetailTime(info.created) },
    { label: '所在盘符', value: info.drive, code: true },
    { label: '文件属性', value: fileExplorerDetailAttrsText(attrs) },
    { label: '只读', value: fileExplorerBooleanLabel(attrs && fileExplorerHasDetailValue(attrs.read_only) ? attrs.read_only : !info.writable) },
    { label: '隐藏', value: attrs && fileExplorerHasDetailValue(attrs.hidden) ? fileExplorerBooleanLabel(attrs.hidden) : '' },
    { label: '系统', value: attrs && fileExplorerHasDetailValue(attrs.system) ? fileExplorerBooleanLabel(attrs.system) : '' },
    { label: '存档', value: attrs && fileExplorerHasDetailValue(attrs.archive) ? fileExplorerBooleanLabel(attrs.archive) : '' },
    { label: '可读', value: fileExplorerBooleanLabel(info.readable) },
    { label: '可写', value: fileExplorerBooleanLabel(info.writable) },
    { label: '可执行', value: fileExplorerBooleanLabel(info.executable) }
  ] : [
    { label: '权限', value: info.permissions },
    { label: '八进制权限', value: info.mode_octal },
    { label: '所有者', value: owner },
    { label: '用户组', value: group },
    { label: 'Inode', value: info.inode },
    { label: '设备号', value: info.device },
    { label: '硬链接数', value: info.hard_links },
    { label: '状态变更时间', value: formatFileExplorerDetailTime(info.changed) },
    { label: '符号链接目标', value: info.symlink_target, code: true },
    { label: '链接本身大小', value: info.is_symlink ? formatFileExplorerDetailBytes(info.link_size) : '' },
    { label: '可读', value: fileExplorerBooleanLabel(info.readable) },
    { label: '可写', value: fileExplorerBooleanLabel(info.writable) },
    { label: '可执行', value: fileExplorerBooleanLabel(info.executable) }
  ];

  content.innerHTML = `
    <div class="file-details-head">
      <div class="file-details-type">${escapeHtml(typeLabel)} · ${escapeHtml(fileExplorerPlatformLabel(platform))}</div>
      <div class="file-details-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      ${absolutePath ? `<code title="${escapeHtml(absolutePath)}">${escapeHtml(absolutePath)}</code>` : ''}
    </div>
    ${fileExplorerDetailSectionHtml('基础信息', commonRows)}
    ${fileExplorerDetailSectionHtml(platformSectionTitle, platformRows)}
  `;
}

async function showFileExplorerDetails(path = FILE_EXPLORER_STATE.contextPath) {
  const normalizedPath = normalizeExplorerPath(path || FILE_EXPLORER_STATE.path);
  const modal = ensureFileExplorerDetailsModal();
  const content = modal.querySelector('#fileExplorerDetailsContent');
  if (content) {
    content.innerHTML = `
      <div class="file-details-head">
        <div class="file-details-type">正在读取详情</div>
        <div class="file-details-name" title="${escapeHtml(normalizedPath)}">${escapeHtml(fileExplorerBasename(normalizedPath) || normalizedPath)}</div>
        <code title="${escapeHtml(normalizedPath)}">${escapeHtml(normalizedPath)}</code>
      </div>
      <div class="file-details-empty">正在读取文件系统信息...</div>
    `;
  }
  modal.classList.add('show');
  try {
    if (typeof callAgentBackend !== 'function') throw new Error('本地工具接口未加载');
    const r = await callAgentBackend('file_info', { path: normalizedPath }, undefined, undefined, fileExplorerBackendContext());
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '读取详情失败');
    renderFileExplorerDetails(r);
  } catch (e) {
    if (content) {
      content.innerHTML = `<div class="file-details-empty error">${escapeHtml(e.message || String(e))}</div>`;
    }
  }
}

function fileExplorerClipboardItems(clip = FILE_EXPLORER_STATE.clipboard) {
  if (!clip) return [];
  if (Array.isArray(clip.items)) {
    return clip.items.map(normalizeFileExplorerSelectionItem).filter(Boolean);
  }
  return [normalizeFileExplorerSelectionItem(clip)].filter(Boolean);
}

function setFileExplorerClipboardItems(items, mode = 'copy') {
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map(normalizeFileExplorerSelectionItem)
    .filter(Boolean);
  if (!normalizedItems.length) return false;
  const first = normalizedItems[0];
  FILE_EXPLORER_STATE.clipboard = {
    path: first.path,
    type: first.type,
    mode: mode === 'cut' ? 'cut' : 'copy',
    name: first.name,
    items: normalizedItems,
    copiedAt: Date.now()
  };
  updateGraphicalFileExplorerToolbar();
  return true;
}

function setFileExplorerClipboard(path, type, mode = 'copy') {
  return setFileExplorerClipboardItems([{ path, type }], mode);
}

function copyFileExplorerItem(path = FILE_EXPLORER_STATE.contextPath, type = FILE_EXPLORER_STATE.contextType) {
  const items = fileExplorerOperationItemsFor(path, type);
  if (!setFileExplorerClipboardItems(items, 'copy')) return;
  if (items.length > 1) {
    fileExplorerToast(`已复制 ${items.length} 项`);
    return;
  }
  fileExplorerToast(`已复制 ${FILE_EXPLORER_STATE.clipboard.name || FILE_EXPLORER_STATE.clipboard.path}`);
}

function cutFileExplorerItem(path = FILE_EXPLORER_STATE.contextPath, type = FILE_EXPLORER_STATE.contextType) {
  const items = fileExplorerOperationItemsFor(path, type);
  if (!setFileExplorerClipboardItems(items, 'cut')) return;
  if (items.length > 1) {
    fileExplorerToast(`已剪切 ${items.length} 项`);
    return;
  }
  fileExplorerToast(`已剪切 ${FILE_EXPLORER_STATE.clipboard.name || FILE_EXPLORER_STATE.clipboard.path}`);
}

function clearFileExplorerClipboard() {
  if (!FILE_EXPLORER_STATE.clipboard) return;
  FILE_EXPLORER_STATE.clipboard = null;
  updateGraphicalFileExplorerToolbar();
  fileExplorerToast('已取消复制/剪切');
}

function rebaseMovedExplorerPath(current, sourcePath, targetPath) {
  const currentPath = normalizeExplorerPath(current);
  const source = normalizeExplorerPath(sourcePath);
  const target = normalizeExplorerPath(targetPath);
  if (currentPath === source) return target;
  if (currentPath.startsWith(source + '/')) return target + currentPath.slice(source.length);
  return current;
}

function updateMovedExplorerReferences(sourcePath, targetPath) {
  FILE_EXPLORER_STATE.editorPath = rebaseMovedExplorerPath(FILE_EXPLORER_STATE.editorPath, sourcePath, targetPath);
  FILE_EXPLORER_STATE.pdfPath = rebaseMovedExplorerPath(FILE_EXPLORER_STATE.pdfPath, sourcePath, targetPath);
  FILE_EXPLORER_STATE.imagePath = rebaseMovedExplorerPath(FILE_EXPLORER_STATE.imagePath, sourcePath, targetPath);
  FILE_EXPLORER_STATE.mediaPath = rebaseMovedExplorerPath(FILE_EXPLORER_STATE.mediaPath, sourcePath, targetPath);
  FILE_EXPLORER_STATE.inlineFilePath = rebaseMovedExplorerPath(FILE_EXPLORER_STATE.inlineFilePath, sourcePath, targetPath);
}

async function moveFileExplorerItemsToDirectory(items, targetDir, options = {}) {
  const normalizedTargetDir = normalizeExplorerPath(targetDir || FILE_EXPLORER_STATE.path);
  const moveItems = (Array.isArray(items) ? items : [])
    .map(normalizeFileExplorerSelectionItem)
    .filter(Boolean)
    .filter(item => canDropFileExplorerItemsOnDirectory([item], normalizedTargetDir));
  if (!normalizedTargetDir || !moveItems.length) {
    if (options.toast !== false) fileExplorerToast(options.emptyMessage || '文件已在目标文件夹');
    return false;
  }
  try {
    if (typeof callAgentBackend !== 'function') throw new Error('本地工具接口未加载');
    let lastResult = null;
    for (const item of moveItems) {
      const r = await callAgentBackend(
        'move_file',
        { path: item.path, target_dir: normalizedTargetDir, dedupe: true },
        undefined,
        undefined,
        fileExplorerBackendContext({ skipConfirm: true })
      );
      if (typeof r === 'string') throw new Error(r);
      if (!r || !r.ok) throw new Error((r && r.error) || '移动失败');
      lastResult = r;
      updateMovedExplorerReferences(item.path, r.new_path || r.path || item.path);
    }
    clearFileExplorerSelection({ render: false });
    const lastItem = moveItems[moveItems.length - 1];
    const movedName = fileExplorerBasename((lastResult && (lastResult.new_path || lastResult.path)) || lastItem.name);
    fileExplorerToast(moveItems.length > 1
      ? `已移动 ${moveItems.length} 项`
      : `已移动 ${movedName || lastItem.name}`);
    await loadFileExplorer(FILE_EXPLORER_STATE.path, { silent: true });
    return true;
  } catch (e) {
    fileExplorerToast(e.message || String(e));
    return false;
  }
}

async function pasteFileExplorerItem(targetDir = FILE_EXPLORER_STATE.contextPath) {
  const clip = FILE_EXPLORER_STATE.clipboard;
  const items = fileExplorerClipboardItems(clip);
  if (!clip || !items.length) {
    fileExplorerToast('没有可粘贴的文件');
    return;
  }
  const normalizedTargetDir = normalizeExplorerPath(targetDir || FILE_EXPLORER_STATE.path);
  const isCut = clip.mode === 'cut';
  const pasteItems = isCut
    ? items.filter(item => normalizeExplorerPath(parentExplorerPath(item.path)) !== normalizedTargetDir)
    : items;
  if (isCut && !pasteItems.length) {
    FILE_EXPLORER_STATE.clipboard = null;
    fileExplorerToast('文件已在当前目录');
    return;
  }
  try {
    if (typeof callAgentBackend !== 'function') throw new Error('本地工具接口未加载');
    const action = isCut ? 'move_file' : 'copy_file';
    let lastResult = null;
    for (const item of pasteItems) {
      const r = await callAgentBackend(
        action,
        { path: item.path, target_dir: normalizedTargetDir, dedupe: true },
        undefined,
        undefined,
        fileExplorerBackendContext({ skipConfirm: true })
      );
      if (typeof r === 'string') throw new Error(r);
      if (!r || !r.ok) throw new Error((r && r.error) || '粘贴失败');
      lastResult = r;
      if (isCut) {
        updateMovedExplorerReferences(item.path, r.new_path || r.path || item.path);
      }
    }
    if (isCut) {
      FILE_EXPLORER_STATE.clipboard = null;
      clearFileExplorerSelection({ render: false });
    }
    const lastItem = pasteItems[pasteItems.length - 1] || items[0];
    const pastedName = fileExplorerBasename((lastResult && (lastResult.new_path || lastResult.path)) || lastItem.name);
    fileExplorerToast(pasteItems.length > 1
      ? (isCut ? `已移动 ${pasteItems.length} 项` : `已粘贴 ${pasteItems.length} 项`)
      : (isCut ? `已移动 ${pastedName || lastItem.name}` : `已粘贴 ${pastedName || lastItem.name}`));
    await loadFileExplorer(FILE_EXPLORER_STATE.path, { silent: true });
  } catch (e) {
    fileExplorerToast(e.message || String(e));
  }
}

function downloadFileExplorerPath(path = FILE_EXPLORER_STATE.contextPath, type = FILE_EXPLORER_STATE.contextType) {
  if (!requireFileExplorerRemoteAction()) return;
  const normalizedPath = normalizeExplorerPath(path);
  if (!normalizedPath) {
    fileExplorerToast('没有可下载的路径');
    return;
  }
  if (typeof TERMINAL_CONFIG === 'undefined') {
    fileExplorerToast('本地工具接口未加载');
    return;
  }
  const base = (TERMINAL_CONFIG.serverUrl || 'http://localhost:8765').replace(/\/+$/, '');
  const archive = type === 'dir' ? '&archive=zip' : '';
  const url = `${base}/preview-file?path=${encodeURIComponent(normalizedPath)}&download=1${archive}&allow_full_access=1`;
  const a = document.createElement('a');
  a.href = url;
  a.download = type === 'dir' ? `${fileExplorerBasename(normalizedPath) || 'folder'}.zip` : fileExplorerBasename(normalizedPath);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  fileExplorerToast(type === 'dir' ? '已开始打包下载文件夹' : '已开始下载');
}

async function renameFileExplorerPath(path = FILE_EXPLORER_STATE.contextPath) {
  const normalizedPath = normalizeExplorerPath(path);
  const currentName = fileExplorerBasename(normalizedPath);
  const nextName = prompt('输入新名称', currentName);
  if (nextName === null) return;
  const newPath = siblingExplorerPath(normalizedPath, nextName);
  if (!newPath) {
    fileExplorerToast('名称不能为空，且不能包含路径分隔符');
    return;
  }
  if (newPath === normalizedPath) return;
  try {
    const r = await callAgentBackend('rename_file', { path: normalizedPath, new_path: newPath }, undefined, undefined, fileExplorerBackendContext({ skipConfirm: true }));
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '重命名失败');
    if (FILE_EXPLORER_STATE.editorPath === normalizedPath) FILE_EXPLORER_STATE.editorPath = newPath;
    if (FILE_EXPLORER_STATE.pdfPath === normalizedPath) FILE_EXPLORER_STATE.pdfPath = newPath;
    if (FILE_EXPLORER_STATE.imagePath === normalizedPath) FILE_EXPLORER_STATE.imagePath = newPath;
    if (FILE_EXPLORER_STATE.mediaPath === normalizedPath) FILE_EXPLORER_STATE.mediaPath = newPath;
    fileExplorerToast('已重命名');
    refreshFileExplorer();
  } catch (e) {
    fileExplorerToast(e.message || String(e));
  }
}

function isExplorerPathInside(targetPath, basePath) {
  const target = normalizeExplorerPath(targetPath);
  const base = normalizeExplorerPath(basePath);
  return !!target && !!base && (target === base || target.startsWith(base + '/'));
}

function closeDeletedExplorerReferences(deletedPath) {
  if (isExplorerPathInside(FILE_EXPLORER_STATE.editorPath, deletedPath)) closeFileEditor(true);
  if (isExplorerPathInside(FILE_EXPLORER_STATE.pdfPath, deletedPath)) closePdfViewer();
  if (isExplorerPathInside(FILE_EXPLORER_STATE.imagePath, deletedPath)) closeImageViewer();
  if (isExplorerPathInside(FILE_EXPLORER_STATE.mediaPath, deletedPath)) closeMediaViewer();
  if (isExplorerPathInside(FILE_EXPLORER_STATE.inlineFilePath, deletedPath)) closeInlineFilePanel();
}

async function deleteFileExplorerPath(path = FILE_EXPLORER_STATE.contextPath, type = FILE_EXPLORER_STATE.contextType) {
  const items = fileExplorerOperationItemsFor(path, type);
  if (!items.length) return;
  try {
    for (const item of items) {
      const normalizedPath = normalizeExplorerPath(item.path);
      const r = await callAgentBackend('delete_file', { path: normalizedPath, recursive: true }, undefined, undefined, fileExplorerBackendContext({ skipConfirm: true }));
      if (typeof r === 'string') throw new Error(r);
      if (!r || !r.ok) throw new Error((r && r.error) || '删除失败');
      closeDeletedExplorerReferences(normalizedPath);
    }
    clearFileExplorerSelection({ render: false });
    fileExplorerToast(items.length > 1 ? `已删除 ${items.length} 项` : '已删除');
    refreshFileExplorer();
  } catch (e) {
    fileExplorerToast(e.message || String(e));
  }
}

function handleFileExplorerContextMenuAction(event) {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const path = FILE_EXPLORER_STATE.contextPath;
  const type = FILE_EXPLORER_STATE.contextType;
  const action = btn.dataset.action;
  hideFileExplorerContextMenu();
  if (action === 'add-quick-access') addCurrentFolderToQuickAccess();
  else if (action === 'open-graphical') openGraphicalFileExplorer(path || FILE_EXPLORER_STATE.path);
  else if (action === 'remove-quick-access') removeCurrentFolderFromQuickAccess();
  else if (action === 'rename-quick-access') renameFileExplorerQuickAccessPath(path);
  else if (action === 'delete-quick-access') removeFileExplorerQuickAccessPath(path);
  else if (action === 'open-quick-access') {
    const quickPath = btn.dataset.path || '';
    if (quickPath) loadFileExplorer(quickPath);
  } else if (action === 'return-sandbox-root') returnFileExplorerToSandboxRoot();
  else if (!path) return;
  else if (isFileExplorerRemoteOnlyAction(action) && !requireFileExplorerRemoteAction()) return;
  else if (action === 'open') openFileExplorerPath(path, type);
  else if (action === 'compile-tex') compileTexFile(path);
  else if (action === 'copy-item') copyFileExplorerItem(path, type);
  else if (action === 'cut-item') cutFileExplorerItem(path, type);
  else if (action === 'clear-clipboard') clearFileExplorerClipboard();
  else if (action === 'paste') pasteFileExplorerItem(path);
  else if (action === 'download') downloadFileExplorerPath(path, type);
  else if (action === 'upload-files') openFileExplorerUploadPicker('files', path);
  else if (action === 'upload-folder') openFileExplorerUploadPicker('folder', path);
  else if (action === 'rename') renameFileExplorerPath(path);
  else if (action === 'copy-path') copyFileExplorerRelativePath(path);
  else if (action === 'copy-absolute-path') copyFileExplorerAbsolutePath(path);
  else if (action === 'details') showFileExplorerDetails(path);
  else if (action === 'delete') deleteFileExplorerPath(path, type);
  else if (action === 'new-file') createFileExplorerFile(path);
  else if (action === 'new-folder') createFileExplorerFolder(path);
  else if (action === 'switch-workspace') switchFileExplorerWorkspace(path);
}

document.addEventListener('DOMContentLoaded', () => {
  setFileExplorerEditorFontSize(loadFileExplorerEditorFontSize(), { persist: false });
  bindPythonFileEditor();
  const list = document.getElementById('fileExplorerList');
  if (list) {
    list.addEventListener('click', handleFileExplorerClick);
    list.addEventListener('contextmenu', handleFileExplorerContextMenu);
    bindFileExplorerDragAndDrop(list);
  }
  const menu = ensureFileExplorerContextMenu();
  menu.addEventListener('click', handleFileExplorerContextMenuAction);
  document.addEventListener('click', event => {
    if (!event.target.closest('#fileExplorerContextMenu')) hideFileExplorerContextMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      hideFileExplorerContextMenu();
      closeFileExplorerDetails();
      closeGraphicalFileExplorer();
    }
  });
  document.addEventListener('keydown', handleFileExplorerSaveShortcut, true);
  window.addEventListener('resize', enforceInlineFileResponsive);
  bindInlineFileResizer();
  setSidebarExplorerMode(false);
});

window.toggleSidebarExplorer = toggleSidebarExplorer;
window.setSidebarExplorerMode = setSidebarExplorerMode;
window.refreshFileExplorer = refreshFileExplorer;
window.fileExplorerGoUp = fileExplorerGoUp;
window.resetFileExplorerToRoot = resetFileExplorerToRoot;
window.openGraphicalFileExplorer = openGraphicalFileExplorer;
window.closeGraphicalFileExplorer = closeGraphicalFileExplorer;
window.openFileEditor = openFileEditor;
window.closeFileEditor = closeFileEditor;
window.reloadFileEditor = reloadFileEditor;
window.saveFileEditor = saveFileEditor;
window.copyFileEditorContent = copyFileEditorContent;
window.openPdfViewer = openPdfViewer;
window.closePdfViewer = closePdfViewer;
window.reloadPdfViewer = reloadPdfViewer;
window.openPdfViewerInNewTab = openPdfViewerInNewTab;
window.openImageViewer = openImageViewer;
window.closeImageViewer = closeImageViewer;
window.reloadImageViewer = reloadImageViewer;
window.openImageViewerInNewTab = openImageViewerInNewTab;
window.openMediaViewer = openMediaViewer;
window.closeMediaViewer = closeMediaViewer;
window.reloadMediaViewer = reloadMediaViewer;
window.openMediaViewerInNewTab = openMediaViewerInNewTab;
window.copyFileExplorerPath = copyFileExplorerPath;
window.copyFileExplorerRelativePath = copyFileExplorerRelativePath;
window.copyFileExplorerAbsolutePath = copyFileExplorerAbsolutePath;
window.copyFileExplorerItem = copyFileExplorerItem;
window.cutFileExplorerItem = cutFileExplorerItem;
window.clearFileExplorerClipboard = clearFileExplorerClipboard;
window.clearFileExplorerSelection = clearFileExplorerSelection;
window.toggleFileExplorerSelection = toggleFileExplorerSelection;
window.selectedFileExplorerItems = selectedFileExplorerItems;
window.pasteFileExplorerItem = pasteFileExplorerItem;
window.downloadFileExplorerPath = downloadFileExplorerPath;
window.renameFileExplorerPath = renameFileExplorerPath;
window.deleteFileExplorerPath = deleteFileExplorerPath;
window.openFileExplorerPath = openFileExplorerPath;
window.isBareFileExplorerFileReference = isBareFileExplorerFileReference;
window.resolveBareFileExplorerFileReference = resolveBareFileExplorerFileReference;
window.createFileExplorerFile = createFileExplorerFile;
window.createFileExplorerFolder = createFileExplorerFolder;
window.switchFileExplorerWorkspace = switchFileExplorerWorkspace;
window.uploadSelectedFilesToExplorer = uploadSelectedFilesToExplorer;
window.openFileExplorerUploadPicker = openFileExplorerUploadPicker;
window.openCurrentFileInMainPanel = openCurrentFileInMainPanel;
window.openTextInMainPanel = openTextInMainPanel;
window.openPdfInMainPanel = openPdfInMainPanel;
window.closeInlineFilePanel = closeInlineFilePanel;
window.setFileEditorMarkdownPreview = setFileEditorMarkdownPreview;
window.setFileEditorCodePreview = setFileEditorCodePreview;
window.toggleFileEditorMarkdownPreview = toggleFileEditorMarkdownPreview;
window.toggleFileEditorCodePreview = toggleFileEditorCodePreview;
window.saveInlineFilePanel = saveInlineFilePanel;
window.reloadInlineFilePanel = reloadInlineFilePanel;
window.copyInlineFileContent = copyInlineFileContent;
window.openInlineFileInNewTab = openInlineFileInNewTab;
window.toggleInlineMarkdownPreview = toggleInlineMarkdownPreview;
window.toggleInlineFileSide = toggleInlineFileSide;

window.AgentApp.define('fileExplorer', {
  FILE_EXPLORER_STATE,
  normalizeExplorerPath,
  resolveFileExplorerOpenPath,
  isBareFileExplorerFileReference,
  resolveBareFileExplorerFileReference,
  joinExplorerPath,
  parentExplorerPath,
  renderFileExplorer,
  loadFileExplorer,
  refreshFileExplorer,
  resetFileExplorerToRoot,
  openGraphicalFileExplorer,
  closeGraphicalFileExplorer,
  toggleSidebarExplorer,
  setSidebarExplorerMode,
  openFileExplorerPath,
  openFileEditor,
  closeFileEditor,
  saveFileEditor,
  saveInlineFilePanel,
  openPdfViewer,
  openImageViewer,
  openMediaViewer,
  openCurrentFileInMainPanel,
  openTextInMainPanel,
  openPdfInMainPanel,
  closeInlineFilePanel,
  createFileExplorerFile,
  createFileExplorerFolder,
  copyFileExplorerPath,
  copyFileExplorerRelativePath,
  copyFileExplorerAbsolutePath,
  copyFileExplorerItem,
  cutFileExplorerItem,
  clearFileExplorerClipboard,
  clearFileExplorerSelection,
  toggleFileExplorerSelection,
  selectedFileExplorerItems,
  pasteFileExplorerItem,
  downloadFileExplorerPath,
  renameFileExplorerPath,
  deleteFileExplorerPath,
  switchFileExplorerWorkspace,
  uploadSelectedFilesToExplorer,
  openFileExplorerUploadPicker
});
