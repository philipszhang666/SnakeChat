// 显卡监控（远程服务器 GPU）E2E：顶栏「监控」按钮 + 弹窗实时数据
const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers');

const SEP = '@@@GPU_MON@@@';
const mark = name => SEP + name + SEP;

const SAMPLE_STDOUT = [
  '0, GPU-aaaa, NVIDIA GeForce RTX 4090, 30, 46, P2, 137.5, 350.0, 858, 24576, 32',
  '1, GPU-bbbb, NVIDIA GeForce RTX 4090, MAX, 72, P2, 284.1, 350.0, 5013, 24576, 88',
  mark('NVITOP'),
  'NVITOP 1.6.1',
  mark('APPS'),
  'GPU-aaaa, 3532839, /home/zhzhang/anaconda3/bin/python3 train.py --config a.yaml, 852',
  'GPU-bbbb, 3535274, python main.py, 4488',
  mark('HOST'),
  ' 20:57:18 up 12 days,  3:04,  2 users,  load average: 9.35, 9.41, 9.87',
  '              total        used        free      shared  buff/cache   available',
  'Mem:          64246       12345        1234         100       52000       51000',
  'Swap:          2047           0        2047'
].join('\n');

const RAW_STDOUT = '\u001b[1mNVITOP 1.6.1\u001b[0m  Driver Version: 535.171.04\n│ 0  30%  46C  P2  137W/350W │';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
  'Content-Type': 'application/json'
};

// 把当前对话伪装成「已连接的远程对话」，并拦截远程后端的 execute 请求
async function fakeRemoteChat(page) {
  await page.route('http://127.0.0.1:18765/**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS_HEADERS });
    }
    let body = {};
    try { body = JSON.parse(request.postData() || '{}'); } catch (e) { body = {}; }
    const isRaw = /--once/.test(String(body.command || ''));
    return route.fulfill({
      status: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ok: true,
        stdout: isRaw ? RAW_STDOUT : SAMPLE_STDOUT,
        stderr: '',
        returncode: 0
      })
    });
  });

  const ready = await page.evaluate(() => {
    const stateModule = window.AgentApp.require('state');
    const st = stateModule.state || {};
    if ((!st.chats || !st.chats.length) && typeof window.newChat === 'function') window.newChat();
    const chat = stateModule.currentChat() || (st.chats && st.chats[0]);
    if (!chat) return false;
    chat.backend = {
      type: 'remote',
      serverUrl: 'http://127.0.0.1:18765',
      sshCommand: 'ssh zhzhang@inspiring',
      remoteWorkspace: '~/',
      remoteAgentPort: 8765,
      connectionId: 'cid-1'
    };
    TERMINAL_CONFIG.serverUrl = 'http://127.0.0.1:18765';
    return typeof window.openGpuMonitor === 'function';
  });
  expect(ready).toBe(true);
}

test.describe('gpu monitor panel', () => {
  test('remote chat opens the monitor and renders nvitop dashboard plus raw terminal', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);
    await fakeRemoteChat(page);

    // 参照物：先量一下「目录」弹窗的实际尺寸（监控弹窗要和它一样大）
    await page.locator('#topbarGraphicalExplorerBtn').click();
    await expect(page.locator('#fileExplorerGraphModal')).toHaveClass(/show/);
    const dirBox = await page.locator('#fileExplorerGraphModal .modal.file-explorer-graph-modal').boundingBox();
    await page.evaluate(() => { if (window.closeGraphicalFileExplorer) window.closeGraphicalFileExplorer(); });
    await expect(page.locator('#fileExplorerGraphModal')).not.toHaveClass(/show/);

    await page.locator('#gpuMonitorBtn').click();
    await expect(page.locator('#gpuMonitorModal')).toHaveClass(/show/);

    const body = page.locator('#gpuMonitorBody');
    await expect(body).toContainText('GPU 0', { timeout: 10000 });
    await expect(body).toContainText('RTX 4090');
    await expect(body).toContainText('5013 MiB');
    await expect(body).toContainText('train.py');
    await expect(page.locator('#gpuMonitorStatus')).toHaveText('实时监控中');
    await expect(page.locator('#gpuMonitorUpdated')).toContainText('NVITOP 1.6.1');

    // 刷新间隔下拉（被 select 皮肤接管）：宽度和选项文本都必须完整（曾经被裁成 "1."）
    const intervalTrigger = page.locator('#gpuMonitorModal .settings-select-trigger');
    await expect(intervalTrigger).toBeVisible();
    await intervalTrigger.click();
    await expect(page.locator('#gpuMonitorModal .settings-select-menu')).toBeVisible();
    expect(await page.locator('#gpuMonitorModal .settings-select-option-text').allTextContents())
      .toEqual(['1 秒', '2 秒', '3 秒', '5 秒', '10 秒']);
    const menuBox = await page.locator('#gpuMonitorModal .settings-select-menu').boundingBox();
    const panelBox = await page.locator('#gpuMonitorModal .gpu-monitor-modal').boundingBox();
    expect(menuBox.width).toBeGreaterThan(80);
    expect(menuBox.width).toBeLessThan(280);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
    await intervalTrigger.click();

    // 弹窗尺寸必须和「目录」弹窗一致（宽 + 高）
    expect(Math.abs(panelBox.width - dirBox.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(panelBox.height - dirBox.height)).toBeLessThanOrEqual(2);

    // nvitop 原始终端视图（ANSI 颜色转 HTML）
    await page.locator('[data-gpu-view="raw"]').click();
    await expect(page.locator('.gpu-mon-terminal')).toContainText('Driver Version: 535.171.04', { timeout: 10000 });

    await page.locator('[data-action="closeGpuMonitor"]').click();
    await expect(page.locator('#gpuMonitorModal')).not.toHaveClass(/show/);

    clientErrors.expectNoErrors();
  });

  test('local chat only shows a reminder instead of opening the monitor', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);

    await page.locator('#gpuMonitorBtn').click();
    await expect(page.locator('#gpuMonitorModal')).not.toHaveClass(/show/);
    await expect(page.locator('#toast')).toContainText('远程连接');

    clientErrors.expectNoErrors();
  });

  test('polling refreshes values in place instead of rebuilding the panel', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);
    await fakeRemoteChat(page);

    await page.locator('#gpuMonitorBtn').click();
    await expect(page.locator('#gpuMonitorBody')).toContainText('GPU 0', { timeout: 10000 });
    // 下拉框被项目的 select 皮肤接管（原生 select 隐藏），直接派发 change 事件切到 1 秒
    await page.evaluate(() => {
      const el = document.getElementById('gpuMonitorInterval');
      el.value = '1000';
      el.dispatchEvent(new Event('change'));
    });

    // 给卡片节点打标记：若刷新时整块重建，标记会丢失
    await page.evaluate(() => {
      document.querySelector('.gpu-mon-card').dataset.e2eMark = 'kept';
    });
    const firstUpdated = await page.locator('#gpuMonitorUpdated').textContent();

    await page.waitForTimeout(1600);

    const kept = await page.evaluate(() => {
      const card = document.querySelector('.gpu-mon-card');
      return card ? (card.dataset.e2eMark || '') : '';
    });
    expect(kept).toBe('kept');
    await expect(page.locator('#gpuMonitorBody')).toContainText('GPU 0');
    expect(await page.locator('#gpuMonitorUpdated').textContent()).not.toBe(firstUpdated);

    await page.locator('[data-action="closeGpuMonitor"]').click();
    await expect(page.locator('#gpuMonitorModal')).not.toHaveClass(/show/);

    clientErrors.expectNoErrors();
  });
});
