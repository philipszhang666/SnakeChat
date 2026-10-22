/*
 * hover 卡顿诊断脚本
 * 用法：打开 index.html → F12 → Console → 把本文件全文粘贴进去回车。
 * 观测 6 秒，输出：
 *   1) 页面规模（对话数 / 消息节点数 / 全 DOM 节点数）
 *   2) 6 秒内的掉帧情况（帧间隔 > 50ms 的次数与最长帧）
 *   3) longtask（>50ms 的 JS 任务）数量、总时长、来源脚本
 *   4) 关键函数的调用次数与耗时（renderChatList / tickMsgTimers / pollFileExplorerChanges ...）
 *   5) 强制重排成本（DOM 越大越慢）
 * 这期间请照常把鼠标在侧栏对话和资源管理器文件上来回移动几次。
 */
(async function hoverLagDiag() {
  const log = (...a) => console.log('%c[diag]', 'color:#4f46e5;font-weight:600', ...a);

  // ---------- 1. 规模 ----------
  const scale = {
    侧栏对话项: document.querySelectorAll('#chatList .chat-item, #chatList [data-chat-id]').length,
    消息区节点: document.querySelectorAll('#messages *').length,
    文件项: document.querySelectorAll('#fileExplorerList .file-explorer-item, #fileExplorerGraphList .file-explorer-item').length,
    全文档节点: document.getElementsByTagName('*').length,
    DOM深度: (() => { let d = 0, n = document.body; while (n && n.children && n.children[0]) { d++; n = n.children[0]; } return d; })()
  };
  console.table(scale);

  // ---------- 2. longtask ----------
  const longTasks = [];
  let obs = null;
  try {
    obs = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        const a = (e.attribution && e.attribution[0]) || {};
        longTasks.push({ dur: Math.round(e.duration), src: (a.containerSrc || a.containerName || a.name || '') + (a.containerType ? ` (${a.containerType})` : '') });
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch (e) { log('longtask 观测不可用（老浏览器？）'); }

  // ---------- 3. 关键函数计时 ----------
  const patched = [];
  function wrap(name) {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    const rec = { fn: name, 调用次数: 0, 总耗时ms: 0, 最长ms: 0 };
    window[name] = function (...args) {
      const t0 = performance.now();
      try { return orig.apply(this, args); }
      finally {
        const d = performance.now() - t0;
        rec.调用次数++; rec.总耗时ms += d; if (d > rec.最长ms) rec.最长ms = d;
      }
    };
    patched.push({ rec, restore: () => { window[name] = orig; } });
  }
  ['renderChatList', 'renderMessages', 'renderFileExplorer', 'loadFileExplorer',
    'tickMsgTimers', 'pollFileExplorerChanges', 'updateTokenDisplay', 'sidebarChats',
    'processScheduledTasks', 'processScheduledGoals', 'groupToolFlows'].forEach(wrap);

  // ---------- 4. 帧间隔 ----------
  const gaps = [];
  let last = performance.now(), running = true;
  const raf = t => { gaps.push(t - last); last = t; if (running) requestAnimationFrame(raf); };
  requestAnimationFrame(raf);

  log('开始观测 6 秒，请现在把鼠标在侧栏对话 / 资源管理器文件上来回移动……');
  const start = performance.now();
  await new Promise(r => setTimeout(r, 6000));
  running = false;
  if (obs) obs.disconnect();
  patched.forEach(p => p.restore());
  const total = performance.now() - start;

  // ---------- 5. 报告 ----------
  const g = gaps.slice(2).map(x => Math.round(x));
  const avg = g.length ? g.reduce((a, b) => a + b, 0) / g.length : 0;
  const bad = g.filter(x => x > 50);
  log(`帧数 ${g.length} | 平均帧间隔 ${avg.toFixed(1)}ms | 掉帧(>50ms) ${bad.length} 次 | 最长帧 ${Math.max(0, ...g)}ms`);
  if (bad.length) log('掉帧明细(ms):', bad.slice(0, 25).join(', '));

  const ltTotal = longTasks.reduce((a, b) => a + b.dur, 0);
  log(`longtask ${longTasks.length} 个，累计 ${ltTotal}ms（约占 ${(ltTotal / total * 100).toFixed(1)}%）`);
  longTasks.sort((a, b) => b.dur - a.dur).slice(0, 8).forEach(t => log(`  ${t.dur}ms ← ${t.src || '未知来源'}`));

  const rows = patched.map(p => p.rec)
    .map(r => ({ 函数: r.fn, 调用次数: r.调用次数, 总耗时ms: Math.round(r.总耗时ms * 10) / 10, 单次最长ms: Math.round(r.最长ms * 10) / 10 }))
    .filter(r => r.调用次数 > 0)
    .sort((a, b) => b.总耗时ms - a.总耗时ms);
  if (rows.length) console.table(rows);
  else log('6 秒内上述函数均未被调用（说明卡顿不来自它们）');

  // 强制重排成本
  const ls = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    document.body.style.paddingTop = (i % 2 ? '0px' : '0.01px');
    void document.body.offsetHeight;
    ls.push(performance.now() - t0);
  }
  const layoutAvg = ls.reduce((a, b) => a + b, 0) / ls.length;
  log(`强制重排一次平均 ${layoutAvg.toFixed(2)}ms（>8ms 说明 DOM 规模已经开始拖累布局）`);

  // ---------- 6. 结论 ----------
  const busy = ltTotal / total * 100;
  let verdict;
  if (busy > 20 || bad.length > 20 || layoutAvg > 8) {
    verdict = '👉 倾向【代码/页面规模问题】：主线程有大量长任务或布局过重。看上面 longtask 来源与函数表定位。';
  } else if (avg > 25) {
    verdict = '👉 倾向【渲染/GPU 问题】：JS 不忙但帧率上不去，可能是显卡加速关闭、缩放比、DevTools 开着或系统级重绘。';
  } else {
    verdict = '👉 倾向【环境问题】：JS 与帧率都正常，卡顿更可能来自浏览器/系统（请关掉 DevTools 的 Console 日志、检查缩放、杀毒实时扫描、机械硬盘）。';
  }
  log('%c' + verdict, 'color:#10b981;font-weight:700');
  log('提示：把上面所有输出截图发我，我可以直接定位到具体函数。');
})();
