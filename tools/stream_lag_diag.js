/*
 * 流式回复期间卡顿诊断 v2
 * 用法：让 AI 开始长回复（最好带代码块）→ F12 → Console → 粘贴本文件全文 → 回车
 * 观测 15 秒。相比 v1 多了函数级插桩，能定位到具体是哪个环节吃掉了主线程。
 *
 * 注意：renderMarkdownStreaming / postRender 等存在嵌套调用，
 *       「累计耗时」会与其子函数重叠，看「单次最长」更准。
 */
(async function streamLagDiagV2() {
  const log = (...a) => console.log('%c[stream]', 'color:#10b981;font-weight:600', ...a);
  const inner = document.getElementById('messagesInner');
  if (!inner) { log('找不到 #messagesInner，请先打开一个对话'); return; }
  const now = () => (window.performance && performance.now ? performance.now() : Date.now());

  const contentLen = () => {
    const el = document.querySelector('#messagesInner .message:last-child .msg-content');
    return el ? (el.textContent || '').length : 0;
  };

  // ---------- longtask ----------
  const longTasks = [];
  let obs = null;
  try {
    obs = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        const a = (e.attribution && e.attribution[0]) || {};
        longTasks.push({ dur: Math.round(e.duration), src: a.containerSrc || a.containerName || '' });
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch (_) {}

  // ---------- 函数插桩 ----------
  const patched = [];
  const recs = new Map();
  function wrap(name) {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    const rec = { fn: name, calls: 0, total: 0, max: 0, maxLen: 0 };
    window[name] = function (...args) {
      const t0 = now();
      try { return orig.apply(this, args); }
      finally {
        const d = now() - t0;
        rec.calls++; rec.total += d;
        if (d > rec.max) { rec.max = d; rec.maxLen = contentLen(); }
      }
    };
    recs.set(name, rec);
    patched.push(() => { window[name] = orig; });
  }
  ['renderMarkdownStreaming', 'renderMarkdown', 'postRender', 'updateMsgContentNode',
    'scrollBottom', 'updateDialogTimeline', 'renderMessages', 'refreshMsgNode',
    'tickMsgTimers', 'updateTokenDisplay', 'groupToolFlows', 'updateLastMsg'
  ].forEach(wrap);

  // _flushLastMsg 单独处理：记录每一次的耗时 + 当时正文长度
  const flushOrig = window._flushLastMsg;
  const flushDetail = [];
  if (typeof flushOrig === 'function') {
    window._flushLastMsg = function (...args) {
      const t0 = now();
      const len = contentLen();
      try { return flushOrig.apply(this, args); }
      finally { flushDetail.push({ ms: now() - t0, len }); }
    };
    patched.push(() => { window._flushLastMsg = flushOrig; });
  }

  // ---------- 帧间隔 ----------
  const gaps = [];
  let last = now(), running = true;
  const raf = t => { gaps.push(t - last); last = t; if (running) requestAnimationFrame(raf); };
  requestAnimationFrame(raf);

  // ---------- 消息区 DOM 变更/秒 ----------
  const perSecond = [];
  let bucket = 0, secStart = now();
  const mo = new MutationObserver(recs2 => { bucket += recs2.length; });
  mo.observe(inner, { childList: true, subtree: true, characterData: true });

  log('开始观测 15 秒（请确保此刻 AI 正在输出）……');
  const start = now();
  const tick = setInterval(() => {
    const t = now();
    if (t - secStart >= 1000) {
      perSecond.push(Math.round(bucket * 1000 / (t - secStart)));
      bucket = 0; secStart = t;
    }
  }, 250);

  await new Promise(r => setTimeout(r, 15000));

  running = false;
  clearInterval(tick);
  mo.disconnect();
  if (obs) obs.disconnect();
  patched.forEach(fn => fn());
  const total = now() - start;

  // ---------- 报告 ----------
  const g = gaps.slice(2).map(x => Math.round(x));
  const bad = g.filter(x => x > 50);
  const avg = g.length ? g.reduce((a, b) => a + b, 0) / g.length : 0;
  log(`帧数 ${g.length} | 平均帧间隔 ${avg.toFixed(1)}ms | 掉帧(>50ms) ${bad.length} 次 | 最长帧 ${Math.max(0, ...g)}ms`);
  if (bad.length) log('掉帧明细(ms):', bad.slice(0, 25).join(', '));

  const ltTotal = longTasks.reduce((a, b) => a + b.dur, 0);
  log(`longtask ${longTasks.length} 个，累计 ${ltTotal}ms（占 ${(ltTotal / total * 100).toFixed(1)}%）`);
  longTasks.sort((a, b) => b.dur - a.dur).slice(0, 6).forEach(t => log(`  ${t.dur}ms ← ${t.src || '未知'}`));

  log('消息区 DOM 变更/秒:', perSecond.join(', ') || '(无变更)');
  log('  参考：60ms 节流生效时应 ≈ 16 次/秒；若 40+ 说明节流没生效');

  // 流式刷新明细
  if (flushDetail.length) {
    const sum = flushDetail.reduce((a, b) => a + b.ms, 0);
    const worst = [...flushDetail].sort((a, b) => b.ms - a.ms).slice(0, 6);
    log(`_flushLastMsg 调用 ${flushDetail.length} 次（≈${(flushDetail.length / (total / 1000)).toFixed(1)} 次/秒），累计 ${sum.toFixed(0)}ms，平均 ${(sum / flushDetail.length).toFixed(1)}ms`);
    log('  最慢 6 次（耗时ms → 当时正文字数）:');
    worst.forEach(w => log(`    ${w.ms.toFixed(1)}ms → ${w.len} 字`));
  } else {
    log('_flushLastMsg 0 次：观测期间没有在流式输出，请重跑一次');
  }

  const rows = Array.from(recs.values())
    .filter(r => r.calls > 0)
    .map(r => ({ 函数: r.fn, 调用次数: r.calls, 累计ms: Math.round(r.total), 单次最长ms: Math.round(r.max), 最长时字数: r.maxLen }))
    .sort((a, b) => b.单次最长ms - a.单次最长ms);
  if (rows.length) console.table(rows);

  // ---------- 结论 ----------
  const flushMs = flushDetail.reduce((a, b) => a + b.ms, 0);
  const flushMax = flushDetail.reduce((m, x) => Math.max(m, x.ms), 0);
  const lines = [];
  if (bad.length > 15 || ltTotal / total > 0.2) {
    if (flushMax > 120) lines.push(`单次 _flushLastMsg 峰值 ${flushMax.toFixed(0)}ms → 仍是"单次超长重渲染"，需要上增量渲染（只重建最后一段）`);
    else if (flushMs > 1500) lines.push('刷新次数偏多 → 节流没生效或 chunk 过密，检查 api-stream.js 的 STREAM_FLUSH_MIN_INTERVAL');
    else lines.push('长任务不在流式刷新路径上 → 看函数表里「单次最长」的非 flush 项（renderMessages / groupToolFlows / updateTokenDisplay）');
  } else {
    lines.push('流式期间已流畅，主线程没被打满 👍');
  }
  log('%c' + lines.join('；'), 'color:#4f46e5;font-weight:700');
})();
