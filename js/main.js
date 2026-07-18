// ============ 初始化入口 ============

const MainStateModule = window.AgentApp.require('state');
const MainUiService = window.AgentApp.require('uiService');
const mainStateRef = MainStateModule.state;
const mainLoadDataFromState = MainStateModule.loadData;
const mainSaveDataFromState = MainStateModule.saveData;

function mainState() {
  return mainStateRef;
}

function mainLoadData() {
  return mainLoadDataFromState();
}

function mainSaveData() {
  return mainSaveDataFromState();
}

async function init() {
  // 0. 先把 IndexedDB 灌入内存缓存（含 localStorage 旧数据自动迁移）
  //    后续 storage.get/set 都是同步访问内存，但必须等这次异步加载完成。
  if (typeof idbInit === 'function') {
    try { await idbInit(); }
    catch (e) { console.error('[init] idbInit 失败，将继续使用 localStorage 兜底', e); }
  }

  // 0.1 trace.js 在模块加载时已经 loadTraces() 过一次（当时 IDB 可能还没就绪），
  //     这里 IDB 就绪后再 load 一次，确保拿到 IndexedDB 里的真实数据。
  if (typeof loadTraces === 'function') {
    try { loadTraces(); } catch (e) {}
  }

  // 0.2 terminal.js 在模块加载时已经读过 token/perms（同样在 IDB 就绪前），
  //     这里 IDB 就绪后强制刷新一次。
  if (typeof TERMINAL_CONFIG !== 'undefined' && typeof storage !== 'undefined') {
    try {
      const permsRaw = storage.get('aichat_terminal_perms_v1');
      if (permsRaw) {
        try { TERMINAL_CONFIG.permanentAllow = JSON.parse(permsRaw) || {}; } catch (e) {}
      }
      const fullAccessRaw = storage.get('aichat_terminal_full_access_v1');
      if (fullAccessRaw !== null && fullAccessRaw !== undefined) {
        try {
          if (typeof loadFullAccessMode === 'function') {
            TERMINAL_CONFIG.fullAccess = loadFullAccessMode();
          } else {
            const parsed = JSON.parse(fullAccessRaw);
            TERMINAL_CONFIG.fullAccess = parsed === true || !!(parsed && parsed.enabled);
          }
        } catch (e) {
          TERMINAL_CONFIG.fullAccess = fullAccessRaw === true || fullAccessRaw === 'true' || fullAccessRaw === '1';
        }
      }
    } catch (e) {}
  }

  // 1. 加载本地数据
  mainLoadData();
  const rehydratedCompression = (typeof rehydrateCompressionMarkersForAllChats === 'function')
    ? rehydrateCompressionMarkersForAllChats()
    : false;
  const recoveredTimers = (typeof recoverInterruptedMsgTimers === 'function') ? recoverInterruptedMsgTimers() : false;
  const recoveredConcurrent = (typeof recoverInterruptedConcurrentRequests === 'function') ? recoverInterruptedConcurrentRequests() : false;
  const recoveredDebates = (typeof recoverInterruptedDebates === 'function') ? recoverInterruptedDebates() : false;
  if (typeof registerMsgTimerExitRecovery === 'function') registerMsgTimerExitRecovery();
  if (rehydratedCompression || recoveredTimers || recoveredConcurrent || recoveredDebates) mainSaveData();
  if (typeof loadTaskQueue === 'function') {
    loadTaskQueue();
  }
  if (typeof loadGoals === 'function') {
    loadGoals();
  }
  
  // 2. 应用主题
  applyTheme();
  
  // 3. 刷新模型下拉框
  refreshModelSelect();
  
  // 4. 渲染聊天列表和消息
  MainUiService.renderChatList();
  MainUiService.renderMessages();
  if (typeof initDialogManager === 'function') initDialogManager();
  
  // 5. 恢复各按钮的激活状态
  const appState = mainState();
  if (appState.settings.useTools) {
    const btn = document.getElementById('toolsBtn');
    if (btn) btn.classList.add('tool-active');
  }
  if (appState.settings.useReflection) {
    const btn = document.getElementById('reflectBtn');
    if (btn) btn.classList.add('reflect-active');
  }
  if (appState.settings.usePlan) {
    const btn = document.getElementById('planBtn');
    if (btn) btn.classList.add('plan-active');
  }
  if (appState.settings.useOutline) {
    const btn = document.getElementById('outlineBtn');
    if (btn) btn.classList.add('outline-active');
  }
  if (appState.settings.usePpt) {
    const btn = document.getElementById('pptModeBtn');
    if (btn) btn.classList.add('ppt-active');
    if (typeof syncPptToolsWithMode === 'function') syncPptToolsWithMode(true, { render: false });
  }
  if (typeof updatePrivacyGuardButton === 'function') updatePrivacyGuardButton();
  if (typeof initScheduledSend === 'function') initScheduledSend();
  if (typeof initRemoteControl === 'function') {
    try { initRemoteControl(); } catch (e) { console.warn('[remote-control] init failed:', e); }
  }

  // 6. 更新底部状态信息
  MainUiService.updateSendBtn();
  
  // 7. 更新顶部 URL/沙箱预览
  updateTopUrlPreview();
  
  // 7.5 启动时检测沙箱目录，并每 30s 心跳一次。
  if (typeof refreshWorkspaceInfo === 'function') {
    if (typeof restoreWorkspaceForCurrentChat === 'function' && mainState().currentId) {
      const workspaceRestore = restoreWorkspaceForCurrentChat({ resetFileExplorer: true });
      if (workspaceRestore && typeof workspaceRestore.then === 'function' && typeof initRemoteConnection === 'function') {
        workspaceRestore.catch(e => console.warn('[workspace] initial restore failed:', e)).then(() => {
          try {
            const remoteInit = initRemoteConnection();
            if (remoteInit && typeof remoteInit.catch === 'function') {
              remoteInit.catch(e => console.warn('[remote] init failed:', e));
            }
          } catch (e) {
            console.warn('[remote] init failed:', e);
          }
        });
      }
    } else {
      refreshWorkspaceInfo();
      if (typeof initRemoteConnection === 'function') {
        try {
          const remoteInit = initRemoteConnection();
          if (remoteInit && typeof remoteInit.catch === 'function') {
            remoteInit.catch(e => console.warn('[remote] init failed:', e));
          }
        } catch (e) {
          console.warn('[remote] init failed:', e);
        }
      }
    }
    setInterval(refreshWorkspaceInfo, 30000);
  }

  // 7.6 恢复 Token / 请求速度统计栏收起状态。
  if (typeof initStatsBarToggle === 'function') initStatsBarToggle();
  
  // 7.5.1 本地代理自检：双击 HTML 打开（file://）时，浏览器对 https 跨域几乎必死。
  //       启动时主动测一下：① 本地服务在不在；② 有没有 token；③ 代理开关有没有开。
  //       三样齐全才能保证 fetch 不会被 CORS 卡死；缺一项就直接提示用户补全。
  (async function autoSetupLocalProxy() {
    try {
      const tc = (typeof TERMINAL_CONFIG !== 'undefined') ? TERMINAL_CONFIG : null;
      if (!tc || !tc.serverUrl) return;
      // ① 本地服务在不在
      let serverAlive = false;
      try {
        const r = await fetch(tc.serverUrl + '/workspace', { method: 'GET' });
        serverAlive = r.ok;
      } catch (e) { serverAlive = false; }
      if (!serverAlive) {
        console.warn('[self-check] Local service is not running; LLM CORS fallback will be unavailable.');
        MainUiService.toast('本地服务未启动，遇到 CORS 时无法绕过\n请运行 python local_terminal_server.py', 5000);
        return;
      }
      // ② 代理开关默认开启（state.js 里默认就是 true，但用户可能手动关过，所以不强改）
      if (mainState().settings.useLocalProxy) {
        console.log('[self-check] Local proxy is ready');
      } else if (!mainState().settings.useLocalProxy) {
        console.log('[self-check] Local proxy is disabled in settings');
      } else if (!tc.token) {
        console.warn('[self-check] Local proxy is enabled but token is missing');
      }
    } catch (e) {
      console.warn('[自检] 异常:', e);
    }
  })();
  
  // 7.6 消息计时器心跳：每 250ms 刷新一次进行中消息的等待/耗时显示。
  // 只改 timer 节点的 textContent，不重渲染整条消息，避免卡顿。
  if (typeof tickMsgTimers === 'function') {
    setInterval(tickMsgTimers, 250);
  }
  
  // 8. 更新 Token 显示
  if (typeof updateTokenDisplay === 'function') updateTokenDisplay();

  // 8.4 项目指令：默认读取已存在的 AGENTS.md，并作为人工维护规则注入。
  if (typeof initProjectInstructions === 'function') {
    setTimeout(() => initProjectInstructions(false), 500);
  }

  // 8.5 项目记忆：只有显式开启后才检测/读取/生成。
  if (typeof initProjectMemory === 'function') {
    setTimeout(() => initProjectMemory(false), 800);
  }
  
  // 9. 初始化请求频率管理
  if (typeof loadRateLimiter === 'function') {
    loadRateLimiter();
    updateRateDisplay();
  }
  
  // 10. 输入框自适应高度
  const input = document.getElementById('input');
  if (input) {
    if (typeof initPromptAutocomplete === 'function') initPromptAutocomplete(input);
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 100) + 'px';
      MainUiService.updateSendBtn();
      clearTimeout(window._tokenUpdateTimer);
      window._tokenUpdateTimer = setTimeout(() => {
        if (typeof updateTokenDisplay === 'function') updateTokenDisplay();
      }, 300);
    });
    input.addEventListener('keydown', e => {
      if (typeof handlePromptHistoryKeydown === 'function' && handlePromptHistoryKeydown(e)) return;
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    });
  }
  
  // 11. 监听导入文本框变化
  const importTa = document.getElementById('importText');
  if (importTa) importTa.addEventListener('input', parseAndPreviewImport);
  
  // 12. ESC 键关闭模态框
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      // 顺序：先关最上层（图片预览、终端确认）→ 普通模态 → LMS 抽屉。
      const modals = [
        'imgPreview', 'termConfirmMask',
        'goalModal', 'goalSettingsModal',
        'toolEditModal', 'dialogManagerModal', 'backupModal', 'projectInstructionsModal', 'projectMemoryModal', 'mcpSkillModal', 'toolsModal', 'reflectionModal',
        'planModal', 'outlineModal', 'privacyModal', 'taskQueueModal', 'concurrentRequestsModal', 'settingsModal', 'jsonEditorModal',
        'rateSettingsModal', 'tokenDetailModal', 'permissionsModal',
        'lmsCookieModal', 'lmsModal'
      ];
      for (const id of modals) {
        const el = document.getElementById(id);
        if (el && el.classList.contains('show')) {
          el.classList.remove('show');
          return;
        }
      }
      // 上面没关掉任何模态，再尝试关闭 LMS 抽屉。
      const lmsPanel = document.getElementById('lmsPanel');
      if (lmsPanel && lmsPanel.classList.contains('show')) {
        lmsPanel.classList.remove('show');
      }
    }
  });
  
  // 13. 移动端“更多”菜单切换
  document.addEventListener('click', e => {
    const wrap = document.querySelector('.more-menu-wrap');
    if (!wrap) return;
    if (e.target.closest('.more-btn')) {
      wrap.classList.toggle('open');
    } else if (!e.target.closest('.more-menu')) {
      wrap.classList.remove('open');
    }
  });
  
  // 14. 拖拽和粘贴支持
  setupDrag();
  setupPaste();
  
  // 15. 安装 Trace 钩子（fetch + executeTool 自动插桩）
  if (typeof installTraceHooks === 'function') {
    installTraceHooks();
    if (typeof renderTracePanel === 'function') renderTracePanel();
  }
  
  console.log('[init] AI Chat started');
  console.log('[init] tools loaded:', mainState().tools.length);
  console.log('[init] chats:', mainState().chats.length);
}

// 启动应用
window.AgentApp.define('main', {
  mainState,
  mainLoadData,
  mainSaveData,
  init
});

init();

// ============ 🛠 浏览器控制台调试工具 ============
// 用法：在浏览器 F12 控制台输入 debugLLM()，即可查看完整链路状态。
window.debugLLM = async function() {
  const log = (...a) => console.log('%c[debugLLM]', 'color:#0a7', ...a);
  const err = (...a) => console.log('%c[debugLLM]', 'color:#c33', ...a);
  console.log('[debugLLM] LLM chain self-check');
  
  // 1. 当前页面环境
  log('1. page origin:', location.origin, location.protocol === 'file:' ? '(file://)' : '');
  
  // 2. 设置
  const s = mainState().settings;
  log('2. baseUrl:', s.baseUrl);
  log('   apiPath:', s.apiPath);
  log('   model  :', s.currentModel);
  log('   stream :', s.stream);
  log('   useLocalProxy:', s.useLocalProxy ? 'enabled' : 'disabled');
  log('   apiKey :', s.apiKey ? s.apiKey.slice(0, 8) + '...' + s.apiKey.slice(-4) : 'missing');
  
  // 3. 本地服务
  const tc = (typeof TERMINAL_CONFIG !== 'undefined') ? TERMINAL_CONFIG : null;
  if (!tc) { err('TERMINAL_CONFIG is not defined'); return; }
  log('3. local service URL:', tc.serverUrl);
  log('   local service config: ready');
  try {
    const r = await fetch(tc.serverUrl + '/workspace');
    if (r.ok) {
      const j = await r.json();
      log('   service status: online, workspace=' + j.workspace);
    } else {
      err('   service status: HTTP ' + r.status);
    }
  } catch (e) {
    err('   service status: unreachable. Run python local_terminal_server.py');
    err('   error:', e.message);
    return;
  }
  
  // 5. 走代理实际发送一条测试请求
  log('5. sending test request through local proxy');
  const url = buildFullUrl(s.baseUrl, s.apiPath);
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.apiKey };
  const body = { model: s.currentModel, messages: [{ role: 'user', content: 'reply OK' }], max_tokens: 10, stream: false };
  try {
    const r = await fetch(tc.serverUrl + '/llm-proxy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Target-Url': url,
        'X-Target-Headers': JSON.stringify(headers)
      },
      body: JSON.stringify(body)
    });
    const txt = await r.text();
    log('   HTTP:', r.status);
    log('   response:', txt.slice(0, 300));
    if (r.ok) {
      log('chain ok. If the frontend still fails, refresh the browser cache.');
    } else {
      err('proxy returned non-200');
    }
  } catch (e) {
    err('proxy request failed:', e.message);
  }
  console.log('[debugLLM] done');
};
console.log('%c💡 调试提示：遇到问题时在控制台输入 debugLLM() 即可自检', 'color:#888');
