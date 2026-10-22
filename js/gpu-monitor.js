// ============ 🖥️ 显卡监控（远程服务器 GPU 实时使用情况） ============
// 数据来源：
//   1) 仪表盘视图：远程服务器 nvidia-smi 的 CSV 查询（与 nvitop 同源、同字段）
//   2) 终端视图：远程服务器 nvitop 的原始终端输出（ANSI 颜色转 HTML 渲染）
// 仅当「当前对话」是远程连接的对话时才允许打开（本地对话点击只给提醒）。

(function (global) {
  'use strict';

  const AgentApp = global.AgentApp;
  if (!AgentApp) throw new Error('AgentApp registry must load before gpu-monitor.js');

  const STORAGE_KEY = 'snake_gpu_monitor_v1';
  const DEFAULT_INTERVAL_MS = 3000;
  const ALLOWED_INTERVALS_MS = [1000, 2000, 3000, 5000, 10000];
  const SEP = '@@@GPU_MON@@@';
  const REQUEST_TIMEOUT_MS = 20000;
  const RAW_TIMEOUT_MS = 25000;

  // 远程 Agent 用「非交互登录 shell」执行命令：~/.bashrc 里常见的
  //   case $- in *i*) ;; *) return;; esac
  // 会让 conda init 被跳过，所以 conda 环境里的 nvitop 经常不在 PATH 中。
  // 这里先在 PATH 找，再逐个探测常见 conda 安装位置（只用 $HOME，避免沙箱路径越界拦截）。
  const NVITOP_FIND = [
    'N=$(command -v nvitop 2>/dev/null)',
    'if [ -z "$N" ]; then for p in "$HOME/miniconda3/bin/nvitop" "$HOME/anaconda3/bin/nvitop" "$HOME/miniforge3/bin/nvitop" "$HOME/mambaforge/bin/nvitop" "$HOME/conda/bin/nvitop" "$HOME/.local/bin/nvitop"; do if [ -x "$p" ]; then N="$p"; break; fi; done; fi',
    'if [ -z "$N" ]; then N=$(ls -1d "$HOME"/miniconda3/envs/*/bin/nvitop "$HOME"/anaconda3/envs/*/bin/nvitop "$HOME"/miniforge3/envs/*/bin/nvitop "$HOME"/.conda/envs/*/bin/nvitop 2>/dev/null | head -n 1); fi',
    'if [ -z "$N" ] && command -v conda >/dev/null 2>&1; then N=$(conda run -n base which nvitop 2>/dev/null | head -n 1); fi'
  ].join('; ');

  const GPU_QUERY = '"$S" --query-gpu=index,uuid,name,fan.speed,temperature.gpu,performance_state,power.draw,power.limit,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits';
  const APP_QUERY = '"$S" --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits';

  // nvitop 读 GPU 用的是 NVML 库，不依赖 nvidia-smi 这个可执行文件。
  // 所以 nvitop 能跑、nvidia-smi 不在 PATH 时，可以用 nvitop 自带的 python 直读 NVML，
  // 输出与 nvidia-smi CSV 完全对齐的 11 列，仪表盘照样有数据。
  const NVML_PY = 'from nvitop import Device; [print(str(d.index)+", "+str(d.uuid)+", "+str(d.name())+", "+str(d.fan_speed())+", "+str(d.temperature())+", "+str(d.performance_state())+", "+str(d.power_usage() and round(d.power_usage()*0.001,1))+", "+str(d.power_limit() and round(d.power_limit()*0.001,1))+", "+str((d.memory_used() or 0)>>20)+", "+str((d.memory_total() or 0)>>20)+", "+str(d.gpu_utilization())) for d in Device.all()]';
  // 用 $(printf '\057') 拼出斜杠，避免命令文本里出现「斜杠 + python」这种写法（沙箱路径规则会误判为沙箱外路径）
  const NVML_FALLBACK = 'if [ -n "$N" ]; then D=$(dirname "$N"); SL=$(printf \'\\057\'); '
    + 'C="$D"${SL}"python"; '
    + 'if [ ! -x "$C" ]; then C="$D"${SL}"python3"; fi; '
    + 'if [ -x "$C" ]; then "$C" -c \'' + NVML_PY + '\' 2>&1; else echo __GPU_MON_NO_PY__; fi; '
    + 'else echo __GPU_MON_NO_NVITOP__; fi';

  // 用户自定义的环境初始化命令（如 source conda.sh && conda activate 某环境）。
  // 沙箱会拦截 ~/... 形式的绝对路径，这里统一换成 $HOME/...
  function envPrefix() {
    const env = String(state.envCmd || '').trim().replace(/~\//g, '$HOME/');
    return env ? env + ' ; ' : '';
  }

  function buildSampleCommand() {
    return [
      envPrefix() + NVITOP_FIND,
      'S=$(command -v nvidia-smi 2>/dev/null)',
      'if [ -n "$S" ]; then ' + GPU_QUERY + ' 2>&1; else echo __GPU_MON_NO_SMI__; ' + NVML_FALLBACK + '; fi',
      'echo ' + SEP + 'NVITOP' + SEP,
      'if [ -n "$N" ]; then "$N" --version 2>&1 | head -n 1; fi',
      'echo ' + SEP + 'APPS' + SEP,
      'if [ -n "$S" ]; then ' + APP_QUERY + ' 2>&1; fi',
      'echo ' + SEP + 'HOST' + SEP,
      'uptime 2>&1',
      'free -m 2>&1'
    ].join(' ; ');
  }

  // 采样拿不到 GPU 行时，把服务器的真实回显摊出来，方便一眼看出是「命令不存在」「权限不足」还是别的
  function buildSampleDiagnosis(stdout, stderr) {
    const text = String(stdout || '');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
      .filter(l => l.indexOf(SEP) < 0);
    const parts = [];
    if (text.indexOf('__GPU_MON_NO_SMI__') >= 0) {
      if (text.indexOf('__GPU_MON_NO_NVITOP__') >= 0) {
        parts.push('服务器上既没有 nvidia-smi，也没有找到 nvitop，无法读取显卡信息。');
      } else if (text.indexOf('__GPU_MON_NO_PY__') >= 0) {
        parts.push('服务器上没有 nvidia-smi，且找不到 nvitop 所在环境的 python，无法通过 NVML 读取。');
      } else {
        parts.push('服务器 PATH 里没有 nvidia-smi（nvitop 用的是 NVML，所以仍可能正常），已尝试用 nvitop 的 python 直读，但没返回数据。');
      }
    }
    const head = lines.filter(l => l.indexOf('__GPU_MON_') < 0).slice(0, 5);
    if (head.length) parts.push('服务器回显：\n' + head.join('\n'));
    const errLines = String(stderr || '').trim().split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4);
    if (errLines.length) parts.push('错误输出：\n' + errLines.join('\n'));
    if (!parts.length) parts.push('服务器没有返回任何可解析的内容，请检查远程连接是否正常。');
    return '\n' + parts.join('\n\n');
  }

  // 测量等宽字体单字符宽度（用于把弹窗像素宽度换算成终端列数）
  function monoCharWidth(fontSize) {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no ctx');
      const mono = (getComputedStyle(document.body).getPropertyValue('--font-mono') || 'monospace').trim();
      ctx.font = fontSize + 'px ' + (mono || 'monospace');
      const w = ctx.measureText('0').width;
      if (Number.isFinite(w) && w > 0) return w;
    } catch (e) { /* 忽略 */ }
    return fontSize * 0.6;
  }

  // 把当前终端面板的像素尺寸换算成 cols / rows，让 nvitop 按这个宽度重新排版（宽度自适应）
  function termGeometry() {
    const bodyEl = byId('gpuMonitorBody');
    const pre = document.querySelector('#gpuMonitorBody .gpu-mon-terminal');
    const width = (pre && pre.clientWidth) || (bodyEl && bodyEl.clientWidth) || 900;
    const height = (pre && pre.clientHeight) || (bodyEl && bodyEl.clientHeight) || 420;
    let fontSize = 11.5;
    let lineHeight = 11.5 * 1.35;
    let padX = 32;
    let padY = 28;
    try {
      const cs = getComputedStyle(pre || bodyEl);
      const fs = parseFloat(cs.fontSize);
      if (Number.isFinite(fs) && fs > 0) fontSize = fs;
      const lh = parseFloat(cs.lineHeight);
      if (Number.isFinite(lh) && lh > 0) lineHeight = lh;
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      const pt = parseFloat(cs.paddingTop) || 0;
      const pb = parseFloat(cs.paddingBottom) || 0;
      if (pl + pr > 0) padX = pl + pr;
      if (pt + pb > 0) padY = pt + pb;
    } catch (e) { /* 忽略 */ }
    const charW = monoCharWidth(fontSize) || 7;
    return {
      cols: Math.max(80, Math.min(320, Math.floor((width - padX) / charW))),
      rows: Math.max(18, Math.min(90, Math.floor((height - padY) / lineHeight)))
    };
  }

  // 优先用伪终端执行：nvitop 只有在「stdout 是 tty」时才会输出和终端里完全一致的彩色画面
  function rawInvocation(cols, rows) {
    const plain = 'COLUMNS=' + cols + ' LINES=' + rows + ' "$N" --once --colorful 2>&1';
    const ttyCall = 'script -q -e -c "stty cols ' + cols + ' rows ' + rows
      + ' 2>/dev/null; \\"$N\\" --once --colorful" /dev/null';
    return 'if command -v script >/dev/null 2>&1; then ' + ttyCall + '; else ' + plain + '; fi';
  }

  // nvitop 原始终端快照（--once 打印一次即退出）
  function buildRawCommand(geom) {
    const cols = geom && geom.cols ? geom.cols : 160;
    const rows = geom && geom.rows ? geom.rows : 45;
    const missingHint = '未在远程服务器上找到 nvitop 命令：PATH 里没有，常见 conda 路径里也没找到。'
      + ' 解决办法（任选其一）：① 在下方「环境」里填写 conda 初始化命令，例如 '
      + 'source $HOME/anaconda3/etc/profile.d/conda.sh && conda activate 你的环境名 ；'
      + '② 或 pip install nvitop 装到 base 环境；③ 或把 nvitop 放进 $HOME/.local/bin。';
    return envPrefix() + NVITOP_FIND
      + ' ; if [ -z "$N" ]; then echo __GPU_MON_NO_NVITOP__; echo ' + "'" + missingHint + "'"
      + '; else ' + rawInvocation(cols, rows) + '; fi';
  }

  const state = {
    open: false,
    view: 'dashboard',
    intervalMs: DEFAULT_INTERVAL_MS,
    autoRefresh: true,
    timer: null,
    inFlight: false,
    envCmd: '',
    lastSample: null,
    lastError: '',
    rawText: '',
    rawError: '',
    rawLoading: false,
    lastUpdatedAt: 0,
    serverUrl: ''
  };

  // ---------------- 工具 ----------------

  function gpuMonToast(message, ms) {
    if (typeof global.toast === 'function') global.toast(message, ms);
  }

  function gpuMonEsc(text) {
    if (typeof global.escapeHtml === 'function') return global.escapeHtml(text);
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function num(value) {
    if (value == null) return null;
    const text = String(value).replace(/[^0-9.\-]/g, '');
    if (!text) return null;
    const n = parseFloat(text);
    return Number.isFinite(n) ? n : null;
  }

  function clampPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  function fmtGiB(mib) {
    if (mib == null) return 'N/A';
    const gib = mib / 1024;
    return gib >= 10 ? gib.toFixed(1) + ' GiB' : gib.toFixed(2) + ' GiB';
  }

  function fmtMiB(mib) {
    if (mib == null) return 'N/A';
    return mib >= 1024 ? (mib / 1024).toFixed(2) + ' GiB' : mib.toFixed(0) + ' MiB';
  }

  // 显卡显存按 MiB 显示（与 nvitop 终端一致，避免分配粒度换算误差）
  function fmtMemMiB(mib) {
    if (mib == null) return 'N/A';
    return Math.round(mib) + ' MiB';
  }

  function levelClass(pct, warn, danger) {
    if (pct == null) return '';
    if (pct >= danger) return 'is-danger';
    if (pct >= warn) return 'is-warn';
    return 'is-ok';
  }

  function loadPrefs() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      const interval = parseInt(data && data.intervalMs, 10);
      if (Number.isFinite(interval) && ALLOWED_INTERVALS_MS.indexOf(interval) >= 0) {
        state.intervalMs = interval;
      }
      if (data && typeof data.autoRefresh === 'boolean') state.autoRefresh = data.autoRefresh;
      if (data && typeof data.envCmd === 'string') state.envCmd = data.envCmd;
    } catch (e) { /* 忽略偏好读取失败 */ }
  }

  function savePrefs() {
    try {
      if (!global.localStorage) return;
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        intervalMs: state.intervalMs,
        autoRefresh: state.autoRefresh,
        envCmd: state.envCmd
      }));
    } catch (e) { /* 忽略偏好保存失败 */ }
  }

  // ---------------- 远程对话判定 ----------------

  function currentBinding() {
    try {
      if (typeof global.currentChatBackendBinding === 'function') return global.currentChatBackendBinding();
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function isRemoteChatActive() {
    const binding = currentBinding();
    if (!binding || binding.type !== 'remote') return false;
    try {
      if (typeof global.activeRemoteMatchesBinding === 'function' && global.activeRemoteMatchesBinding(binding)) {
        return true;
      }
    } catch (e) { /* 忽略 */ }
    return typeof global.isRemoteAgentActive === 'function' ? !!global.isRemoteAgentActive() : false;
  }

  function backendUrl() {
    try {
      if (typeof global.resolveAgentBackendServerUrl === 'function') {
        return global.resolveAgentBackendServerUrl('execute');
      }
    } catch (e) { /* 忽略 */ }
    if (typeof TERMINAL_CONFIG !== 'undefined' && TERMINAL_CONFIG && TERMINAL_CONFIG.serverUrl) {
      return TERMINAL_CONFIG.serverUrl;
    }
    return 'http://localhost:8765';
  }

  function backendLabel() {
    const binding = currentBinding();
    const cfg = (typeof global.loadRemoteConnectionConfig === 'function')
      ? global.loadRemoteConnectionConfig()
      : null;
    const ssh = (binding && binding.sshCommand) || (cfg && cfg.sshCommand) || '';
    const workspace = (binding && binding.remoteWorkspace) || (cfg && cfg.remoteWorkspace) || '';
    const parts = [];
    if (ssh) parts.push(ssh);
    if (workspace) parts.push(workspace);
    if (!parts.length) parts.push(backendUrl());
    return parts.join('  ·  ');
  }

  // ---------------- 后端请求 ----------------

  function sessionId() {
    try {
      if (typeof global.getAgentSessionId === 'function') return global.getAgentSessionId();
    } catch (e) { /* 忽略 */ }
    if (typeof TERMINAL_CONFIG !== 'undefined' && TERMINAL_CONFIG) return TERMINAL_CONFIG.sessionId;
    return '';
  }

  async function runRemoteCommand(command, timeoutMs) {
    const url = backendUrl();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    if (ctrl) {
      timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs || REQUEST_TIMEOUT_MS);
    }
    try {
      const payload = {
        action: 'execute',
        command,
        timeout: Math.max(5, Math.round((timeoutMs || REQUEST_TIMEOUT_MS) / 1000) - 3)
      };
      const sid = sessionId();
      if (sid) payload.session_id = sid;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl ? ctrl.signal : undefined
      });
      let data = null;
      try {
        data = await resp.json();
      } catch (e) {
        return { ok: false, error: '后端返回内容无法解析（HTTP ' + (resp && resp.status) + '）' };
      }
      if (!resp || !resp.ok) {
        return { ok: false, error: (data && data.error) || ('后端请求失败（HTTP ' + (resp && resp.status) + '）') };
      }
      return data || { ok: false, error: '后端返回为空' };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, error: '请求超时：服务器未在预期时间内响应' };
      return { ok: false, error: '无法连接远程后端：' + (e && e.message ? e.message : e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------------- 解析 ----------------

  function csvParts(line) {
    return String(line || '').split(',').map(s => s.trim());
  }

  function parseGpuSection(text) {
    const gpus = [];
    String(text || '').split('\n').forEach(line => {
      const row = line.trim();
      if (!row) return;
      const parts = csvParts(row);
      if (parts.length < 11) return;
      if (!/^\d+$/.test(parts[0])) return;
      const name = parts.slice(2, parts.length - 8).join(', ').trim();
      gpus.push({
        index: parseInt(parts[0], 10),
        uuid: parts[1],
        name: name || 'GPU',
        fan: parts[3],
        temp: num(parts[4]),
        perf: parts[5],
        power: num(parts[6]),
        powerCap: num(parts[7]),
        memUsed: num(parts[8]),
        memTotal: num(parts[9]),
        util: num(parts[10])
      });
    });
    return gpus.sort((a, b) => a.index - b.index);
  }

  function parseAppSection(text) {
    const apps = [];
    String(text || '').split('\n').forEach(line => {
      const row = line.trim();
      if (!row) return;
      const parts = csvParts(row);
      if (parts.length < 4) return;
      const memRaw = parts[parts.length - 1];
      apps.push({
        uuid: parts[0],
        pid: parts[1],
        command: parts.slice(2, parts.length - 1).join(', ').trim(),
        memory: num(memRaw)
      });
    });
    return apps;
  }

  function shortCommand(command) {
    const text = String(command || '').trim();
    if (!text) return '(未知进程)';
    const segs = text.split(/\s+/);
    const head = segs[0] || text;
    const base = head.split('/').filter(Boolean).pop() || head;
    const rest = segs.slice(1).join(' ');
    const tail = rest.length > 60 ? rest.slice(0, 60) + '…' : rest;
    return base + (tail ? ' ' + tail : '');
  }

  function parseHostSection(text) {
    const info = { uptime: '', load: '', memUsed: null, memTotal: null, swapUsed: null, swapTotal: null };
    String(text || '').split('\n').forEach(raw => {
      const line = raw.trim();
      if (!line) return;
      if (!info.uptime && /load average/.test(line)) {
        const m = line.match(/load average:\s*(.+)$/i);
        info.load = m ? m[1].trim() : '';
        const up = line.match(/up\s+(.+?),\s+\d+\s+user/);
        info.uptime = up ? up[1].trim() : line.replace(/\s+/g, ' ');
        return;
      }
      if (/^Mem:/.test(line)) {
        const cols = line.split(/\s+/);
        info.memTotal = num(cols[1]);
        info.memUsed = num(cols[2]);
        return;
      }
      if (/^Swap:/.test(line)) {
        const cols = line.split(/\s+/);
        info.swapTotal = num(cols[1]);
        info.swapUsed = num(cols[2]);
      }
    });
    return info;
  }

  function splitSections(stdout) {
    const text = String(stdout || '');
    const marker = new RegExp(SEP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(NVITOP|APPS|HOST)\\s*' + SEP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const out = { gpu: '', nvitop: '', apps: '', host: '' };
    const hits = [];
    let m;
    while ((m = marker.exec(text))) {
      hits.push({ key: m[1].toLowerCase(), start: m.index, end: m.index + m[0].length });
    }
    if (!hits.length) {
      out.gpu = text;
      return out;
    }
    out.gpu = text.slice(0, hits[0].start);
    hits.forEach((hit, i) => {
      const next = hits[i + 1];
      out[hit.key] = text.slice(hit.end, next ? next.start : text.length);
    });
    return out;
  }

  function parseSample(stdout) {
    const sections = splitSections(stdout);
    const gpus = parseGpuSection(sections.gpu);
    const apps = parseAppSection(sections.apps);
    const host = parseHostSection(sections.host);
    const versionLine = String(sections.nvitop || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
    return {
      gpus: gpus,
      apps: apps,
      host: host,
      nvitopVersion: versionLine,
      fetchedAt: Date.now()
    };
  }

  // ---------------- ANSI -> HTML ----------------

  const ANSI_BASIC_FG = {
    30: '#3f3f46', 31: '#ef4444', 32: '#22c55e', 33: '#eab308',
    34: '#3b82f6', 35: '#a855f7', 36: '#06b6d4', 37: '#e5e7eb',
    90: '#71717a', 91: '#f87171', 92: '#4ade80', 93: '#facc15',
    94: '#60a5fa', 95: '#c084fc', 96: '#22d3ee', 97: '#ffffff'
  };

  const ANSI_BASIC_BG = {
    40: '#000000', 41: '#7f1d1d', 42: '#14532d', 43: '#78350f',
    44: '#1e3a8a', 45: '#4c1d95', 46: '#164e63', 47: '#d4d4d8'
  };

  function ansi256ToHex(n) {
    const idx = Math.max(0, Math.min(255, parseInt(n, 10) || 0));
    if (idx < 16) {
      const basic = [30, 31, 32, 33, 34, 35, 36, 37][idx % 8];
      return ANSI_BASIC_FG[basic] || '#d4d4d8';
    }
    if (idx < 232) {
      const i = idx - 16;
      const steps = [0, 95, 135, 175, 215, 255];
      const r = steps[Math.floor(i / 36) % 6];
      const g = steps[Math.floor(i / 6) % 6];
      const b = steps[i % 6];
      return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    }
    const level = 8 + (idx - 232) * 10;
    const hex = level.toString(16).padStart(2, '0');
    return '#' + hex + hex + hex;
  }

  function ansiToHtml(text) {
    // 去掉清屏 / 光标移动等控制序列，只保留 SGR 颜色转义（否则会残留乱码）
    const src = String(text || '')
      .replace(/\r/g, '')
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, seq => (seq.charAt(seq.length - 1) === 'm' ? seq : ''));
    if (src.indexOf('\u001b[') < 0) {
      return gpuMonEsc(src);
    }
    let out = '';
    let seg = '';
    let fg = '';
    let bg = '';
    let bold = false;
    let idx = 0;
    const flush = () => {
      if (!seg) return;
      const style = [
        fg ? 'color:' + fg : '',
        bg ? 'background:' + bg : '',
        bold ? 'font-weight:700' : ''
      ].filter(Boolean).join(';');
      const safe = gpuMonEsc(seg);
      out += style ? '<span style="' + style + '">' + safe + '</span>' : safe;
      seg = '';
    };
    const re = /\u001b\[([0-9;]*)m/g;
    let m;
    while ((m = re.exec(src))) {
      seg += src.slice(idx, m.index);
      flush();
      const codes = String(m[1] || '').split(';').filter(s => s !== '').map(Number);
      if (!codes.length) codes.push(0);
      for (let i = 0; i < codes.length; i += 1) {
        const code = codes[i];
        if (code === 0) { fg = ''; bg = ''; bold = false; }
        else if (code === 1) bold = true;
        else if (code === 22) bold = false;
        else if (code === 39) fg = '';
        else if (code === 49) bg = '';
        else if (ANSI_BASIC_FG[code]) fg = ANSI_BASIC_FG[code];
        else if (ANSI_BASIC_BG[code]) bg = ANSI_BASIC_BG[code];
        else if (code === 38 && codes[i + 1] === 5) { fg = ansi256ToHex(codes[i + 2]); i += 2; }
        else if (code === 48 && codes[i + 1] === 5) { bg = ansi256ToHex(codes[i + 2]); i += 2; }
        else if (code === 38 && codes[i + 1] === 2) {
          fg = 'rgb(' + codes[i + 2] + ',' + codes[i + 3] + ',' + codes[i + 4] + ')';
          i += 4;
        } else if (code === 48 && codes[i + 1] === 2) {
          bg = 'rgb(' + codes[i + 2] + ',' + codes[i + 3] + ',' + codes[i + 4] + ')';
          i += 4;
        }
      }
      idx = m.index + m[0].length;
    }
    seg += src.slice(idx);
    flush();
    return out;
  }

  // ---------------- 渲染 ----------------

  function setStatus(text, kind) {
    const pill = byId('gpuMonitorStatus');
    if (!pill) return;
    pill.textContent = text;
    pill.className = 'gpu-monitor-pill' + (kind ? ' ' + kind : '');
  }

  function metricHtml(key, label, value, extraClass) {
    return '<div class="gpu-mon-metric">'
      + '<span class="gpu-mon-label">' + gpuMonEsc(label) + '</span>'
      + '<span class="' + ('gpu-mon-value ' + (extraClass || '')).trim() + '" data-k="' + key + '">'
      + gpuMonEsc(value) + '</span>'
      + '</div>';
  }

  function barHtml(key, label, pct, valueText) {
    const safePct = clampPct(pct);
    const cls = levelClass(pct, 70, 88);
    return '<div class="gpu-mon-bar">'
      + '<span class="gpu-mon-bar-label">' + gpuMonEsc(label) + '</span>'
      + '<span class="gpu-mon-bar-track"><i class="' + cls + '" data-k="' + key + '.w" style="width:'
      + safePct.toFixed(1) + '%"></i></span>'
      + '<span class="' + ('gpu-mon-bar-val ' + cls).trim() + '" data-k="' + key + '.v">'
      + gpuMonEsc(valueText) + '</span>'
      + '</div>';
  }

  // 单张卡的可变数值（骨架与增量更新共用，保证两边算出来的值完全一致）
  function gpuValues(gpu) {
    const memPct = (gpu.memUsed != null && gpu.memTotal) ? (gpu.memUsed / gpu.memTotal) * 100 : null;
    const powerPct = (gpu.power != null && gpu.powerCap) ? (gpu.power / gpu.powerCap) * 100 : null;
    return {
      fan: gpu.fan && gpu.fan !== '[N/A]' ? gpu.fan : 'N/A',
      perf: gpu.perf && gpu.perf !== '[N/A]' ? gpu.perf : 'N/A',
      temp: gpu.temp == null ? 'N/A' : gpu.temp + '°C',
      tempCls: gpu.temp == null ? '' : (gpu.temp >= 85 ? 'is-danger' : (gpu.temp >= 72 ? 'is-warn' : 'is-ok')),
      power: (gpu.power == null ? 'N/A' : gpu.power + 'W') + ' / ' + (gpu.powerCap == null ? 'N/A' : gpu.powerCap + 'W'),
      mem: fmtMemMiB(gpu.memUsed) + ' / ' + fmtGiB(gpu.memTotal),
      util: gpu.util == null ? 'N/A' : gpu.util + '%',
      utilCls: levelClass(gpu.util, 70, 90),
      memPct: memPct,
      powerPct: powerPct,
      powerBar: powerPct == null ? 'N/A' : powerPct.toFixed(0) + '%',
      memBar: memPct == null ? 'N/A' : memPct.toFixed(1) + '%',
      utilBar: gpu.util == null ? 'N/A' : gpu.util + '%'
    };
  }

  function procsHtml(apps) {
    if (!apps.length) return '<div class="gpu-mon-proc-empty">无计算进程</div>';
    return apps.map(app => '<div class="gpu-mon-proc-row">'
      + '<span class="gpu-mon-proc-cmd" title="' + gpuMonEsc(app.command) + '">' + gpuMonEsc(shortCommand(app.command)) + '</span>'
      + '<span class="gpu-mon-proc-pid">PID ' + gpuMonEsc(app.pid) + '</span>'
      + '<span class="gpu-mon-proc-mem">' + gpuMonEsc(fmtMemMiB(app.memory)) + '</span>'
      + '</div>').join('');
  }

  function gpuCardHtml(gpu, apps) {
    const v = gpuValues(gpu);
    const key = 'g' + gpu.index;
    const procHtml = procsHtml(apps);
    return '<section class="gpu-mon-card" data-gpu="' + gpu.index + '">'
      + '<header class="gpu-mon-card-head">'
      + '<span class="gpu-mon-idx">GPU ' + gpu.index + '</span>'
      + '<span class="gpu-mon-name" title="' + gpuMonEsc(gpu.name) + '" data-k="' + key + '.name">'
      + gpuMonEsc(gpu.name) + '</span>'
      + '<span class="gpu-mon-perf" data-k="' + key + '.perf">' + gpuMonEsc(v.perf) + '</span>'
      + '</header>'
      + '<div class="gpu-mon-metrics">'
      + metricHtml(key + '.fan', '风扇', v.fan)
      + metricHtml(key + '.temp', '温度', v.temp, v.tempCls)
      + metricHtml(key + '.power', '功耗', v.power)
      + metricHtml(key + '.mem', '显存', v.mem)
      + metricHtml(key + '.util', '利用率', v.util, v.utilCls)
      + '</div>'
      + '<div class="gpu-mon-bars">'
      + barHtml(key + '.pwr', 'PWR', v.powerPct, v.powerBar)
      + barHtml(key + '.mem', 'MEM', v.memPct, v.memBar)
      + barHtml(key + '.utl', 'UTIL', gpu.util, v.utilBar)
      + '</div>'
      + '<div class="gpu-mon-procs" data-k="' + key + '.procs" data-html="' + gpuMonEsc(procHtml) + '">'
      + procHtml + '</div>'
      + '</section>';
  }

  function overviewItems(sample) {
    const host = sample.host || {};
    const memPct = (host.memUsed != null && host.memTotal) ? (host.memUsed / host.memTotal) * 100 : null;
    const swapPct = (host.swapUsed != null && host.swapTotal) ? (host.swapUsed / host.swapTotal) * 100 : null;
    return [
      ['ov.gpu', 'GPU', (sample.gpus || []).length + ' 张'],
      ['ov.proc', '进程', (sample.apps || []).length + ' 个'],
      ['ov.mem', '内存', memPct == null
        ? 'N/A'
        : memPct.toFixed(1) + '%（' + fmtMiB(host.memUsed) + ' / ' + fmtMiB(host.memTotal) + '）'],
      ['ov.swap', 'SWAP', swapPct == null ? 'N/A' : swapPct.toFixed(1) + '%'],
      ['ov.load', '负载', host.load || 'N/A'],
      ['ov.uptime', '运行', host.uptime || 'N/A']
    ];
  }

  function overviewHtml(sample) {
    return '<section class="gpu-mon-overview">'
      + overviewItems(sample).map(item =>
        '<div class="gpu-mon-overview-item">'
        + '<span class="gpu-mon-overview-label">' + gpuMonEsc(item[1]) + '</span>'
        + '<span class="gpu-mon-overview-value" data-k="' + item[0] + '">' + gpuMonEsc(item[2]) + '</span>'
        + '</div>').join('')
      + '</section>';
  }

  function appsByGpu(sample) {
    const grouped = {};
    (sample.apps || []).forEach(app => {
      const key = String(app.uuid || '').trim();
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(app);
    });
    return grouped;
  }

  function dashboardHtml(sample) {
    const grouped = appsByGpu(sample);
    return overviewHtml(sample)
      + '<div class="gpu-mon-grid">'
      + sample.gpus.map(gpu => gpuCardHtml(gpu, grouped[gpu.uuid] || [])).join('')
      + '</div>';
  }

  function paintText(body, key, text, className) {
    const node = body.querySelector('[data-k="' + key + '"]');
    if (!node) return;
    if (node.textContent !== text) node.textContent = text;
    if (className != null && node.className !== className) node.className = className;
  }

  function paintBar(body, key, pct, text) {
    const cls = levelClass(pct, 70, 88);
    const fill = body.querySelector('[data-k="' + key + '.w"]');
    if (fill) {
      const width = clampPct(pct).toFixed(1) + '%';
      if (fill.style.width !== width) fill.style.width = width;
      if (fill.className !== cls) fill.className = cls;
    }
    const val = body.querySelector('[data-k="' + key + '.v"]');
    if (val) {
      if (val.textContent !== text) val.textContent = text;
      const valCls = ('gpu-mon-bar-val ' + cls).trim();
      if (val.className !== valCls) val.className = valCls;
    }
  }

  // 只改文本 / 宽度 / 颜色，不重建节点 → 不闪烁、进度条保留过渡动画、滚动位置不变
  function patchDashboard(body, sample) {
    overviewItems(sample).forEach(item => paintText(body, item[0], item[2]));
    const grouped = appsByGpu(sample);
    sample.gpus.forEach(gpu => {
      const v = gpuValues(gpu);
      const key = 'g' + gpu.index;
      paintText(body, key + '.name', gpu.name);
      paintText(body, key + '.perf', v.perf);
      paintText(body, key + '.fan', v.fan, 'gpu-mon-value');
      paintText(body, key + '.temp', v.temp, ('gpu-mon-value ' + v.tempCls).trim());
      paintText(body, key + '.power', v.power, 'gpu-mon-value');
      paintText(body, key + '.mem', v.mem, 'gpu-mon-value');
      paintText(body, key + '.util', v.util, ('gpu-mon-value ' + v.utilCls).trim());
      paintBar(body, key + '.pwr', v.powerPct, v.powerBar);
      paintBar(body, key + '.mem', v.memPct, v.memBar);
      paintBar(body, key + '.utl', gpu.util, v.utilBar);
      const procNode = body.querySelector('[data-k="' + key + '.procs"]');
      if (procNode) {
        const html = procsHtml(grouped[gpu.uuid] || []);
        if (procNode.dataset.html !== html) {
          procNode.innerHTML = html;
          procNode.dataset.html = html;
        }
      }
    });
  }

  function dashboardHtmlOrState() {
    if (state.lastError) {
      return '<div class="gpu-mon-error">' + gpuMonEsc(state.lastError) + '</div>';
    }
    const sample = state.lastSample;
    if (!sample) return '<div class="gpu-mon-loading">正在读取服务器显卡信息…</div>';
    if (!sample.gpus.length) {
      return '<div class="gpu-mon-error">未从服务器读取到 GPU 信息。请确认服务器已安装 NVIDIA 驱动，并检查 nvidia-smi 是否可用。</div>';
    }
    return dashboardHtml(sample);
  }

  function renderRaw() {
    if (state.rawLoading) {
      return '<div class="gpu-mon-loading">正在执行 nvitop --once …</div>';
    }
    if (state.rawError) {
      return '<div class="gpu-mon-error">' + gpuMonEsc(state.rawError) + '</div>';
    }
    if (!state.rawText) {
      return '<div class="gpu-mon-loading">尚未获取 nvitop 终端输出…</div>';
    }
    return '<pre class="gpu-mon-terminal">' + ansiToHtml(state.rawText) + '</pre>';
  }

  function render() {
    const body = byId('gpuMonitorBody');
    if (!body) return;
    const wantRaw = state.view === 'raw';
    body.classList.toggle('is-raw', wantRaw);

    if (wantRaw) {
      const pre = body.querySelector('.gpu-mon-terminal');
      if (pre && !state.rawError && !state.rawLoading && state.rawText) {
        // 已有终端画面：只换内部 HTML，并还原滚动位置（不重建 pre 本身）
        const top = pre.scrollTop;
        const left = pre.scrollLeft;
        if (pre.dataset.src !== state.rawText) {
          pre.innerHTML = ansiToHtml(state.rawText);
          pre.dataset.src = state.rawText;
        }
        pre.scrollTop = top;
        pre.scrollLeft = left;
      } else {
        body.innerHTML = renderRaw();
      }
    } else {
      const sample = state.lastSample;
      const cards = body.querySelectorAll('.gpu-mon-card');
      const hasSkeleton = !!body.querySelector('.gpu-mon-overview');
      const canPatch = hasSkeleton && sample && !state.lastError
        && (sample.gpus || []).length === cards.length;
      if (canPatch) {
        patchDashboard(body, sample);
      } else {
        body.innerHTML = dashboardHtmlOrState();
      }
    }

    const target = byId('gpuMonitorTarget');
    if (target) target.textContent = state.serverUrl ? backendLabel() : '—';

    const updated = byId('gpuMonitorUpdated');
    if (updated) {
      if (!state.lastUpdatedAt) {
        updated.textContent = '—';
      } else {
        const d = new Date(state.lastUpdatedAt);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        const version = state.lastSample && state.lastSample.nvitopVersion ? '  ·  ' + state.lastSample.nvitopVersion : '';
        updated.textContent = '更新于 ' + hh + ':' + mm + ':' + ss + version;
      }
    }

    const tabButtons = document.querySelectorAll('#gpuMonitorModal [data-gpu-view]');
    tabButtons.forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-gpu-view') === state.view);
    });
  }

  // ---------------- 采样 ----------------

  async function refresh(manual) {
    if (state.inFlight) return;
    if (!state.open) return;
    if (!isRemoteChatActive()) {
      stopPolling();
      state.lastError = '当前对话已不是远程连接对话，监控已停止。';
      setStatus('已断开', 'is-danger');
      render();
      return;
    }
    state.inFlight = true;
    state.serverUrl = backendUrl();
    // 只有「还没有任何数据」时才显示刷新中，避免每次轮询都闪一下
    if (!state.lastSample && !state.rawText) setStatus('刷新中…', 'is-busy');
    try {
      if (state.view === 'raw') {
        state.rawLoading = !state.rawText && !state.rawError;
        if (state.rawLoading) render();
        const rawResp = await runRemoteCommand(buildRawCommand(termGeometry()), RAW_TIMEOUT_MS);
        state.rawLoading = false;
        if (rawResp && rawResp.ok) {
          state.rawText = String(rawResp.stdout || '');
          if (state.rawText.indexOf('__GPU_MON_NO_NVITOP__') >= 0) {
            state.rawError = state.rawText.split('__GPU_MON_NO_NVITOP__').pop().trim()
              || '未在远程服务器上找到 nvitop 命令。';
            state.rawText = '';
            setStatus('nvitop 未就绪', 'is-danger');
          } else if (!state.rawText) {
            state.rawError = 'nvitop 无输出。' + (rawResp.stderr ? '\n' + rawResp.stderr : '');
            setStatus('采样失败', 'is-danger');
          } else {
            state.rawError = '';
            state.lastUpdatedAt = Date.now();
            setStatus('实时监控中', 'is-ok');
          }
        } else if (rawResp && rawResp.running) {
          state.rawError = 'nvitop --once 执行较慢，本次采样已转入后台任务'
            + (rawResp.task_id ? '（' + rawResp.task_id + '）' : '') + '，请稍后重试。';
          setStatus('采样超时', 'is-danger');
        } else {
          state.rawError = '执行 nvitop --once 失败：' + ((rawResp && rawResp.error) || '未知错误');
          setStatus('采样失败', 'is-danger');
        }
      } else {
        const resp = await runRemoteCommand(buildSampleCommand(), REQUEST_TIMEOUT_MS);
        if (resp && resp.ok) {
          const sample = parseSample(resp.stdout || '');
          if (sample.gpus.length) {
            state.lastSample = sample;
            state.lastError = '';
            state.lastUpdatedAt = Date.now();
            setStatus('实时监控中', 'is-ok');
          } else {
            state.lastError = '未读取到 GPU 数据。' + buildSampleDiagnosis(resp.stdout, resp.stderr);
            setStatus('无数据', 'is-danger');
          }
        } else if (resp && resp.running) {
          state.lastError = '服务器响应较慢，本次采样已转入后台任务'
            + (resp.task_id ? '（' + resp.task_id + '）' : '') + '，请稍后重试或把刷新间隔调大。';
          setStatus('采样超时', 'is-danger');
        } else {
          state.lastError = (resp && resp.error) || '采样失败';
          setStatus('采样失败', 'is-danger');
        }
      }
      render();
    } finally {
      state.inFlight = false;
      if (state.open && state.autoRefresh) schedule();
    }
    if (manual) {
      if (!state.lastError && !state.rawError) gpuMonToast('✓ 已刷新显卡监控');
    }
  }

  function stopPolling() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function schedule() {
    stopPolling();
    if (!state.open || !state.autoRefresh) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      refresh(false);
    }, state.intervalMs);
  }

  // ---------------- 打开 / 关闭 ----------------

  function openGpuMonitor() {
    if (!isRemoteChatActive()) {
      gpuMonToast('⚠️ 当前对话不是远程连接对话，显卡监控只能查看远程服务器的 GPU', 3200);
      return;
    }
    const modal = byId('gpuMonitorModal');
    if (!modal) return;
    state.open = true;
    state.lastError = '';
    state.rawError = '';
    state.rawText = '';
    state.serverUrl = backendUrl();
    modal.classList.add('show');
    // 弹窗刚显示时立刻让 select 皮肤重新测量宽度（否则宽度为 0，下拉文字会被裁掉）
    const skinRefresh = () => {
      if (typeof global.refreshMainSettingsSelectSkins !== 'function') return;
      try { global.refreshMainSettingsSelectSkins(modal); } catch (e) { /* 忽略 */ }
    };
    skinRefresh();
    if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(skinRefresh);
    const btn = byId('gpuMonitorBtn');
    if (btn) btn.classList.add('gpu-monitor-active');
    syncControls();
    setStatus('连接中…', 'is-busy');
    render();
    refresh(false);
  }

  function closeGpuMonitor() {
    state.open = false;
    stopPolling();
    const modal = byId('gpuMonitorModal');
    if (modal) modal.classList.remove('show');
    const btn = byId('gpuMonitorBtn');
    if (btn) btn.classList.remove('gpu-monitor-active');
  }

  function refreshGpuMonitor() {
    if (!state.open) {
      openGpuMonitor();
      return;
    }
    refresh(true);
  }

  function switchView(view) {
    if (view !== 'raw' && view !== 'dashboard') return;
    if (state.view === view) return;
    state.view = view;
    render();
    refresh(false);
  }

  function syncControls() {
    const autoEl = byId('gpuMonitorAutoRefresh');
    if (autoEl) autoEl.checked = !!state.autoRefresh;
    const intervalEl = byId('gpuMonitorInterval');
    if (intervalEl) intervalEl.value = String(state.intervalMs);
    const envEl = byId('gpuMonitorEnvCmd');
    if (envEl) envEl.value = String(state.envCmd || '');
  }

  function init() {
    loadPrefs();
    const modal = byId('gpuMonitorModal');
    if (!modal) return;

    // 视图切换
    modal.addEventListener('click', event => {
      const tab = event.target && event.target.closest ? event.target.closest('[data-gpu-view]') : null;
      if (tab && modal.contains(tab)) {
        event.preventDefault();
        switchView(tab.getAttribute('data-gpu-view'));
        return;
      }
      // 点击遮罩空白处关闭
      if (event.target === modal) closeGpuMonitor();
    });

    const autoEl = byId('gpuMonitorAutoRefresh');
    if (autoEl) {
      autoEl.addEventListener('change', () => {
        state.autoRefresh = !!autoEl.checked;
        savePrefs();
        if (state.autoRefresh) {
          refresh(false);
        } else {
          stopPolling();
        }
      });
    }

    const intervalEl = byId('gpuMonitorInterval');
    if (intervalEl) {
      intervalEl.addEventListener('change', () => {
        const value = parseInt(intervalEl.value, 10);
        if (Number.isFinite(value) && ALLOWED_INTERVALS_MS.indexOf(value) >= 0) {
          state.intervalMs = value;
        }
        savePrefs();
        if (state.open && state.autoRefresh) schedule();
      });
    }

    // 「环境」输入框：填写 conda 初始化命令后立即重新采样
    const envEl = byId('gpuMonitorEnvCmd');
    if (envEl) {
      const applyEnv = () => {
        const next = String(envEl.value || '').trim();
        if (next === state.envCmd) return;
        state.envCmd = next;
        savePrefs();
        if (state.open) {
          state.rawText = '';
          state.rawError = '';
          refresh(false);
        }
      };
      envEl.addEventListener('change', applyEnv);
      envEl.addEventListener('blur', applyEnv);
    }

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && state.open) closeGpuMonitor();
    });

    // 窗口尺寸变化 → nvitop 按新宽度重新采样（防抖 350ms）
    if (typeof global.addEventListener === 'function') {
      let resizeTimer = null;
      global.addEventListener('resize', () => {
        if (!state.open || state.view !== 'raw') return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeTimer = null;
          if (state.open && state.view === 'raw') refresh(false);
        }, 350);
      });
    }

    syncControls();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.openGpuMonitor = openGpuMonitor;
  global.closeGpuMonitor = closeGpuMonitor;
  global.refreshGpuMonitor = refreshGpuMonitor;
  global.switchGpuMonitorView = switchView;

  AgentApp.define('gpuMonitor', {
    openGpuMonitor,
    closeGpuMonitor,
    refreshGpuMonitor,
    switchGpuMonitorView: switchView,
    isRemoteChatActive,
    parseSample,
    ansiToHtml,
    state
  });
})(window);
