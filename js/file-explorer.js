// ============ Sidebar File Explorer ============

const FileExplorerUiService = window.AgentApp.require('uiService');

function fileExplorerToast(message, ms) {
  FileExplorerUiService.toast(message, ms);
}

const FILE_EXPLORER_STATE = {
  visible: false,
  path: '.',
  loading: false,
  autoRefreshTimer: null,
  autoRefreshInFlight: false,
  autoRefreshSignature: '',
  autoRefreshPath: '.',
  uploading: false,
  clipboard: null,
  entries: [],
  editorPath: '',
  editorOriginal: '',
  editorMarkdownPreview: false,
  editorCodePreview: false,
  editorLoading: false,
  editorPythonMode: false,
  editorCodeMirror: null,
  inlineCodeMirror: null,
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
  inlineFilePath: '',
  inlineFileKind: '',
  inlineFileSide: 'right',
  inlineChatWidth: 50
};

const INLINE_FILE_MIN_WINDOW_WIDTH = 1100;
const INLINE_FILE_MIN_MAIN_WIDTH = 920;
const INLINE_FILE_MIN_CHAT_WIDTH = 460;
const INLINE_FILE_MIN_FILE_WIDTH = 360;
const FILE_EXPLORER_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const FILE_EXPLORER_QUICK_ACCESS_LEGACY_KEY = 'aichat_file_explorer_quick_access_v1';
const FILE_EXPLORER_QUICK_ACCESS_KEY_PREFIX = 'aichat_file_explorer_quick_access_v2';
const FILE_EXPLORER_QUICK_ACCESS_MAX = 10;
const FILE_EXPLORER_QUICK_ACCESS_LABEL_MAX = 40;

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
    out.push({ path });
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
  fileExplorerToast(`已移出快速访问：${shortenFileExplorerQuickAccessPath(removed)}`);
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
  pathEl.textContent = normalized;
  pathEl.title = normalized;
  pathEl.setAttribute('aria-label', normalized);
}

function fileExplorerIcon(entry) {
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

function fileExplorerSort(entries) {
  return (entries || []).slice().sort((a, b) => {
    const ad = a.type === 'dir' ? 0 : 1;
    const bd = b.type === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  });
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
    return `
      <button class="file-explorer-quick-access-item" type="button" data-action="open-quick-access" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">
        <span class="file-explorer-quick-access-path">${escapeHtml(shortenFileExplorerQuickAccessPath(path))}</span>
      </button>
    `;
  }).join('');
}

function addCurrentFolderToQuickAccess() {
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

function renderFileExplorer() {
  const list = document.getElementById('fileExplorerList');
  const upBtn = document.getElementById('fileExplorerUpBtn');
  setFileExplorerPathDisplay(FILE_EXPLORER_STATE.path);
  if (upBtn) upBtn.disabled = currentFileExplorerParentPath() === FILE_EXPLORER_STATE.path;
  if (!list) return;

  const entries = fileExplorerSort(FILE_EXPLORER_STATE.entries);
  if (!entries.length) {
    list.innerHTML = '<div class="file-explorer-empty">这个目录是空的。</div>';
    return;
  }

  list.innerHTML = entries.map(entry => {
    const name = entry.name || '';
    const isDir = entry.type === 'dir';
    const path = joinExplorerPath(FILE_EXPLORER_STATE.path, name);
    const meta = isDir ? '文件夹' : formatSize(Number(entry.size || 0));
    return `
      <button class="file-explorer-item ${isDir ? 'is-dir' : 'is-file'}" type="button" data-path="${escapeHtml(path)}" data-type="${escapeHtml(entry.type || '')}" title="${escapeHtml(path)}">
        <span class="file-explorer-icon">${fileExplorerIcon(entry)}</span>
        <span class="file-explorer-name">${escapeHtml(name)}</span>
        <span class="file-explorer-meta">${escapeHtml(meta)}</span>
      </button>
    `;
  }).join('');
}

async function loadFileExplorer(path = FILE_EXPLORER_STATE.path, options = {}) {
  if (FILE_EXPLORER_STATE.loading) return false;
  FILE_EXPLORER_STATE.loading = true;
  FILE_EXPLORER_STATE.path = normalizeExplorerPath(path);
  if (!options.silent) renderFileExplorerLoading();
  setFileExplorerPathDisplay(FILE_EXPLORER_STATE.path);
  try {
    if (typeof callAgentBackend !== 'function') throw new Error('本地工具接口未加载');
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

async function pollFileExplorerChanges() {
  if (!FILE_EXPLORER_STATE.visible || FILE_EXPLORER_STATE.loading || FILE_EXPLORER_STATE.autoRefreshInFlight) return;
  FILE_EXPLORER_STATE.autoRefreshInFlight = true;
  const path = normalizeExplorerPath(FILE_EXPLORER_STATE.path);
  try {
    if (typeof callAgentBackend !== 'function') return;
    const r = await callAgentBackend('list_dir', { path }, undefined, undefined, fileExplorerBackendContext());
    if (typeof r === 'string' || !r || !r.ok) return;
    if (path !== normalizeExplorerPath(FILE_EXPLORER_STATE.path) || !FILE_EXPLORER_STATE.visible) return;
    noteFileExplorerAbsolutePath(r.path, path);
    const entries = Array.isArray(r.entries) ? r.entries : [];
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
    stopFileExplorerAutoRefresh();
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
  if (FILE_EXPLORER_STATE.visible) loadFileExplorer('.');
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

function ensureInlineCodeMirror(path) {
  if (!hasFileEditorCodeMirror()) return null;
  const textarea = inlineFileTextarea();
  const shell = inlineFileCodeShell();
  if (!textarea || !shell) return null;
  if (FILE_EXPLORER_STATE.inlineCodeMirror) return FILE_EXPLORER_STATE.inlineCodeMirror;
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
  refreshInlineCodeMirror();
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
  }
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
  footer.innerHTML = `
    <button class="btn" type="button" data-action="copyInlineFileContent">复制内容</button>
    ${isMarkdown ? '<button class="btn" type="button" id="inlineMarkdownToggle" data-action="toggleInlineMarkdownPreview">Markdown 预览</button>' : ''}
    ${isPython ? '<button class="btn" type="button" id="inlinePythonToggle" data-action="toggleInlinePythonPreview">Python 高亮预览</button>' : ''}
    <button class="btn" type="button" data-action="reloadInlineFilePanel">重新读取</button>
  `;
  const setContent = (content, disabled = false) => {
    const cm = FILE_EXPLORER_STATE.inlineCodeMirror;
    textarea.value = String(content || '');
    textarea.disabled = !!disabled;
    if (cm) {
      cm.setValue(textarea.value);
      cm.setOption('readOnly', !!disabled);
      refreshInlineCodeMirror();
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

async function reloadInlineFilePanel() {
  const path = FILE_EXPLORER_STATE.inlineFilePath;
  const kind = FILE_EXPLORER_STATE.inlineFileKind;
  if (!path) return;
  if (kind === 'pdf') await openPdfInMainPanel(path);
  else if (kind === 'text' || kind === 'markdown') await openTextInMainPanel(path);
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

function showFileExplorerContextMenu(event, item) {
  event.preventDefault();
  const isItem = !!item;
  const path = isItem ? (item.dataset.path || '.') : FILE_EXPLORER_STATE.path;
  const type = isItem ? (item.dataset.type || '') : 'dir';
  FILE_EXPLORER_STATE.contextPath = path;
  FILE_EXPLORER_STATE.contextType = type;
  FILE_EXPLORER_STATE.contextScope = isItem ? 'item' : 'blank';

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
    btn.hidden = currentInQuickAccess;
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
  if (!item) return;
  const path = item.dataset.path || '.';
  const type = item.dataset.type || '';
  openFileExplorerPath(path, type);
}

function handleFileExplorerContextMenu(event) {
  const item = fileExplorerItemFromPointerEvent(event);
  const list = event.currentTarget;
  if (!item && list && !list.contains(event.target)) return;
  showFileExplorerContextMenu(event, item || null);
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

function setFileExplorerClipboard(path, type, mode = 'copy') {
  const normalizedPath = normalizeExplorerPath(path);
  if (!normalizedPath) return false;
  FILE_EXPLORER_STATE.clipboard = {
    path: normalizedPath,
    type: type === 'dir' ? 'dir' : 'file',
    mode: mode === 'cut' ? 'cut' : 'copy',
    name: fileExplorerBasename(normalizedPath),
    copiedAt: Date.now()
  };
  return true;
}

function copyFileExplorerItem(path = FILE_EXPLORER_STATE.contextPath, type = FILE_EXPLORER_STATE.contextType) {
  if (!setFileExplorerClipboard(path, type, 'copy')) return;
  fileExplorerToast(`已复制 ${FILE_EXPLORER_STATE.clipboard.name || FILE_EXPLORER_STATE.clipboard.path}`);
}

function cutFileExplorerItem(path = FILE_EXPLORER_STATE.contextPath, type = FILE_EXPLORER_STATE.contextType) {
  if (!setFileExplorerClipboard(path, type, 'cut')) return;
  fileExplorerToast(`已剪切 ${FILE_EXPLORER_STATE.clipboard.name || FILE_EXPLORER_STATE.clipboard.path}`);
}

function clearFileExplorerClipboard() {
  if (!FILE_EXPLORER_STATE.clipboard) return;
  FILE_EXPLORER_STATE.clipboard = null;
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

async function pasteFileExplorerItem(targetDir = FILE_EXPLORER_STATE.contextPath) {
  const clip = FILE_EXPLORER_STATE.clipboard;
  if (!clip || !clip.path) {
    fileExplorerToast('没有可粘贴的文件');
    return;
  }
  const normalizedTargetDir = normalizeExplorerPath(targetDir || FILE_EXPLORER_STATE.path);
  const isCut = clip.mode === 'cut';
  if (isCut && normalizeExplorerPath(parentExplorerPath(clip.path)) === normalizedTargetDir) {
    FILE_EXPLORER_STATE.clipboard = null;
    fileExplorerToast('文件已在当前目录');
    return;
  }
  try {
    if (typeof callAgentBackend !== 'function') throw new Error('本地工具接口未加载');
    const action = isCut ? 'move_file' : 'copy_file';
    const r = await callAgentBackend(
      action,
      { path: clip.path, target_dir: normalizedTargetDir, dedupe: true },
      undefined,
      undefined,
      fileExplorerBackendContext({ skipConfirm: true })
    );
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '粘贴失败');
    const pastedName = fileExplorerBasename(r.new_path || r.path || clip.name);
    if (isCut) {
      updateMovedExplorerReferences(clip.path, r.new_path || clip.path);
      FILE_EXPLORER_STATE.clipboard = null;
    }
    fileExplorerToast(isCut ? `已移动 ${pastedName || clip.name}` : `已粘贴 ${pastedName || clip.name}`);
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

async function deleteFileExplorerPath(path = FILE_EXPLORER_STATE.contextPath) {
  const normalizedPath = normalizeExplorerPath(path);
  try {
    const r = await callAgentBackend('delete_file', { path: normalizedPath, recursive: true }, undefined, undefined, fileExplorerBackendContext({ skipConfirm: true }));
    if (typeof r === 'string') throw new Error(r);
    if (!r || !r.ok) throw new Error((r && r.error) || '删除失败');
    if (FILE_EXPLORER_STATE.editorPath === normalizedPath) closeFileEditor(true);
    if (FILE_EXPLORER_STATE.pdfPath === normalizedPath) closePdfViewer();
    if (FILE_EXPLORER_STATE.imagePath === normalizedPath) closeImageViewer();
    if (FILE_EXPLORER_STATE.mediaPath === normalizedPath) closeMediaViewer();
    fileExplorerToast('已删除');
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
  else if (action === 'remove-quick-access') removeCurrentFolderFromQuickAccess();
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
  else if (action === 'delete') deleteFileExplorerPath(path);
  else if (action === 'new-file') createFileExplorerFile(path);
  else if (action === 'new-folder') createFileExplorerFolder(path);
  else if (action === 'switch-workspace') switchFileExplorerWorkspace(path);
}

document.addEventListener('DOMContentLoaded', () => {
  bindPythonFileEditor();
  const list = document.getElementById('fileExplorerList');
  if (list) {
    list.addEventListener('click', handleFileExplorerClick);
    list.addEventListener('contextmenu', handleFileExplorerContextMenu);
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
    }
  });
  window.addEventListener('resize', enforceInlineFileResponsive);
  bindInlineFileResizer();
  setSidebarExplorerMode(false);
});

window.toggleSidebarExplorer = toggleSidebarExplorer;
window.setSidebarExplorerMode = setSidebarExplorerMode;
window.refreshFileExplorer = refreshFileExplorer;
window.fileExplorerGoUp = fileExplorerGoUp;
window.resetFileExplorerToRoot = resetFileExplorerToRoot;
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
  toggleSidebarExplorer,
  setSidebarExplorerMode,
  openFileExplorerPath,
  openFileEditor,
  closeFileEditor,
  saveFileEditor,
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
  pasteFileExplorerItem,
  downloadFileExplorerPath,
  renameFileExplorerPath,
  deleteFileExplorerPath,
  switchFileExplorerWorkspace,
  uploadSelectedFilesToExplorer,
  openFileExplorerUploadPicker
});
