const { test, expect } = require('@playwright/test');
const {
  configureMockProvider,
  gotoApp,
  waitForGenerating
} = require('./helpers');

async function openGoalPanel(page) {
  await page.locator('#goalBtn').click();
  await expect(page.locator('#goalModal')).toHaveClass(/show/);
}

async function createGoalFromPanel(page, objective) {
  await page.fill('#goalObjectiveInput', objective);
  await page.fill('#goalMaxTurnsInput', '3');
  await page.locator('[data-action="createGoalFromUi"]').click();
}

function datetimeLocalFromNow(ms) {
  const d = new Date(Date.now() + ms);
  const pad = value => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function waitForGoalStatus(page, objective, status) {
  await expect.poll(() => page.evaluate(({ objective, status }) => {
    const goals = window.AgentApp.require('goalCore').listGoals();
    const goal = goals.find(item => item && item.objective === objective);
    return goal ? goal.status : '';
  }, { objective, status }), { timeout: 20_000 }).toBe(status);
}

async function ensureCurrentChat(page) {
  const currentId = await page.evaluate(() => window.AgentApp.require('state').state.currentId);
  if (currentId) return currentId;
  await page.locator('[data-action="newChat"]').first().click();
  await expect.poll(() => page.evaluate(() => window.AgentApp.require('state').state.currentId)).toBeTruthy();
  return page.evaluate(() => window.AgentApp.require('state').state.currentId);
}

async function goalSnapshot(page) {
  return page.evaluate(() => {
    const state = window.AgentApp.require('state').state;
    const chat = window.AgentApp.require('state').currentChat();
    const goals = window.AgentApp.require('goalCore').listGoals();
    return {
      currentId: state.currentId,
      chatCount: (state.chats || []).length,
      chatGoalIds: chat && Array.isArray(chat.goalIds) ? [...chat.goalIds] : [],
      goals: goals.map(goal => ({
        id: goal.id,
        objective: goal.objective,
        status: goal.status,
        lastError: goal.lastError || '',
        chatId: goal.chatId,
        turnCount: goal.turnCount
      })),
      messages: chat && Array.isArray(chat.messages)
        ? chat.messages.map(msg => ({
            role: msg.role,
            content: msg.content || '',
            goalId: msg.goalId || '',
            goalFinal: !!msg._goalFinal,
            goalGuidance: !!msg._goalGuidance
          }))
        : []
    };
  });
}

function validCompressionSummary(title) {
  return [
    '## 当前任务',
    title,
    '',
    '## 用户目标和约束',
    'Keep goal-mode compression visible and cache-friendly.',
    '',
    '## 已完成事项',
    'Older goal chat history was summarized before the next goal request.',
    '',
    '## 关键决策和事实',
    'Goal mode should use the same visible compressed context as normal chat.',
    '',
    '## 已查看或修改的文件',
    '无',
    '',
    '## 工具/命令结果',
    '无',
    '',
    '## 计划/大纲状态',
    '无',
    '',
    '## 测试和验证状态',
    'Playwright verified goal-mode visible compression.',
    '',
    '## 未完成事项',
    'Continue the goal after compression.',
    '',
    '## 风险/阻塞',
    '无',
    '',
    '## 下一步建议',
    'Run the goal request with the compressed summary.',
    '',
    '## 可丢弃上下文',
    'The raw legacy context messages can be discarded.'
  ].join('\n');
}

test.describe('goal mode workflows', () => {
  test('runs multiple goals in the current chat without creating goal-only conversations', async ({ page }) => {
    const { backend, clientErrors } = await gotoApp(page, { goalScenario: true });
    await configureMockProvider(page);
    await ensureCurrentChat(page);

    const before = await goalSnapshot(page);
    expect(before.currentId).toBeTruthy();

    await openGoalPanel(page);
    await createGoalFromPanel(page, 'E2E first reusable goal');
    await waitForGoalStatus(page, 'E2E first reusable goal', 'complete');

    const afterFirst = await goalSnapshot(page);
    expect(afterFirst.currentId).toBe(before.currentId);
    expect(afterFirst.chatCount).toBe(before.chatCount);
    expect(afterFirst.goals.find(goal => goal.objective === 'E2E first reusable goal').chatId).toBe(before.currentId);
    expect(afterFirst.goals.find(goal => goal.objective === 'E2E first reusable goal').lastError).toBe('');
    expect(afterFirst.chatGoalIds).toContain(afterFirst.goals.find(goal => goal.objective === 'E2E first reusable goal').id);
    expect(afterFirst.messages.some(msg => msg.role === 'assistant' && String(msg.content).includes('Goal complete: E2E first reusable goal'))).toBe(true);
    expect(afterFirst.messages.filter(msg => msg.goalFinal).length).toBe(1);

    await createGoalFromPanel(page, 'E2E second reusable goal');
    await waitForGoalStatus(page, 'E2E second reusable goal', 'complete');

    const afterSecond = await goalSnapshot(page);
    expect(afterSecond.currentId).toBe(before.currentId);
    expect(afterSecond.chatCount).toBe(before.chatCount);
    expect(afterSecond.goals.filter(goal => goal.chatId === before.currentId)).toHaveLength(2);
    expect(afterSecond.goals.find(goal => goal.objective === 'E2E second reusable goal').lastError).toBe('');
    expect(afterSecond.chatGoalIds).toEqual(expect.arrayContaining(afterSecond.goals.map(goal => goal.id)));
    expect(afterSecond.messages.filter(msg => msg.goalFinal)).toHaveLength(2);
    expect(JSON.stringify(afterSecond)).not.toContain('"goal_"');
    expect(backend.llmCalls.length).toBeGreaterThanOrEqual(4);

    clientErrors.expectNoErrors();
  });

  test('auto compression in goal mode is visible and feeds the compressed context to the goal request', async ({ page }) => {
    const { backend, clientErrors } = await gotoApp(page, { goalScenario: true });
    await configureMockProvider(page);
    await ensureCurrentChat(page);

    await page.evaluate(summary => {
      const apiCore = window.AgentApp.require('apiCore');
      window.__e2eOriginalGoalCompressionCallOnce = apiCore.callOnceWithRole;
      window.__e2eGoalCompressionCalls = 0;
      apiCore.callOnceWithRole = async () => {
        window.__e2eGoalCompressionCalls += 1;
        return summary;
      };

      window.saveContextLimitRules([{ key: 'e2e-goal-compress-model', limit: 8000 }]);
      const appState = window.AgentApp.require('state').state;
      appState.settings.currentModel = 'e2e-goal-compress-model';
      appState.settings.compressAutoEnabled = true;
      appState.settings.compressAutoThreshold = 50;
      appState.settings.compressKeepLast = 2;
      appState.settings.maxTokens = 0;
      appState.settings.systemPrompt = '';

      const chat = window.AgentApp.require('state').currentChat();
      chat.messages = Array.from({ length: 8 }, (_, idx) => ({
        role: idx % 2 === 0 ? 'user' : 'assistant',
        content: `legacy-context-message-${idx} ` + 'x'.repeat(3000)
      }));
      window.renderMessages();
    }, validCompressionSummary('E2E goal visible compression summary.'));

    await openGoalPanel(page);
    await createGoalFromPanel(page, 'E2E compressed goal context');
    await waitForGoalStatus(page, 'E2E compressed goal context', 'complete');

    await expect.poll(() => page.evaluate(() => window.__e2eGoalCompressionCalls)).toBe(1);
    await expect(page.locator('.compression-summary-card')).not.toHaveAttribute('open', '');
    await expect(page.locator('.compression-summary-card')).toContainText('E2E goal visible compression summary');

    const requestBodies = backend.llmCalls.map(call => JSON.stringify(call.body));
    expect(requestBodies.some(text => text.includes('E2E goal visible compression summary'))).toBe(true);
    expect(requestBodies.some(text => text.includes('legacy-context-message-0'))).toBe(false);

    await page.evaluate(() => {
      const apiCore = window.AgentApp.require('apiCore');
      if (window.__e2eOriginalGoalCompressionCallOnce) {
        apiCore.callOnceWithRole = window.__e2eOriginalGoalCompressionCallOnce;
        delete window.__e2eOriginalGoalCompressionCallOnce;
      }
      delete window.__e2eGoalCompressionCalls;
    });
    clientErrors.expectNoErrors();
  });

  test('elapsed time freezes while a goal is paused', async ({ page }) => {
    const objective = 'E2E paused elapsed goal';
    const { clientErrors } = await gotoApp(page, {
      goalScenario: true,
      delayForLlm() {
        return 1500;
      }
    });
    await configureMockProvider(page);
    await ensureCurrentChat(page);

    await openGoalPanel(page);
    await page.fill('#goalObjectiveInput', objective);
    await page.fill('#goalMaxTurnsInput', '3');
    await page.locator('[data-action="createGoalFromUi"]').click();
    await expect.poll(() => page.evaluate(objective => {
      const goal = window.AgentApp.require('goalCore').listGoals().find(item => item.objective === objective);
      return goal ? goal.status : '';
    }, objective)).toBe('active');

    await page.locator('[data-handler="pauseGoalById"]').first().click();
    await expect.poll(() => page.evaluate(objective => {
      const core = window.AgentApp.require('goalCore');
      const goal = core.listGoals().find(item => item.objective === objective);
      return goal ? goal.status : '';
    }, objective)).toBe('paused');

    const elapsedAtPause = await page.evaluate(objective => {
      const core = window.AgentApp.require('goalCore');
      const goal = core.listGoals().find(item => item.objective === objective);
      return core.goalElapsedMs(goal);
    }, objective);
    await expect.poll(() => page.evaluate(objective => {
      const core = window.AgentApp.require('goalCore');
      const goal = core.listGoals().find(item => item.objective === objective);
      return goal ? Number(goal.runningSince || 0) : -1;
    }, objective)).toBe(0);
    await page.waitForTimeout(1200);
    const elapsedLater = await page.evaluate(objective => {
      const core = window.AgentApp.require('goalCore');
      const goal = core.listGoals().find(item => item.objective === objective);
      return core.goalElapsedMs(goal);
    }, objective);

    expect(elapsedLater).toBe(elapsedAtPause);
    clientErrors.expectNoErrors();
  });

  test('protocol ordering warnings do not pause an otherwise useful goal turn', async ({ page }) => {
    const objective = 'E2E protocol warning remains active';
    const { backend, clientErrors } = await gotoApp(page, {
      goalScenario: true,
      goalScenarioFirstNonGoalTool: true,
      goalScenarioKeepActive: true
    });
    await configureMockProvider(page);
    await ensureCurrentChat(page);
    await page.evaluate(() => {
      const appState = window.AgentApp.require('state').state;
      const config = window.AgentApp.require('config');
      const listNotes = (config.BUILTIN_TOOLS || []).find(tool => tool && tool.name === 'list_notes');
      if (listNotes && !appState.tools.some(tool => tool && tool.name === 'list_notes')) {
        appState.tools.push(JSON.parse(JSON.stringify(listNotes)));
      }
    });

    await openGoalPanel(page);
    await page.fill('#goalObjectiveInput', objective);
    await page.fill('#goalMaxTurnsInput', '1');
    await page.locator('[data-action="createGoalFromUi"]').click();

    await expect.poll(() => page.evaluate(objective => {
      const goal = window.AgentApp.require('goalCore').listGoals().find(item => item.objective === objective);
      return !!(goal && goal.events && goal.events.some(event => event.type === 'protocol_warning'));
    }, objective), { timeout: 20_000 }).toBe(true);

    const goal = await page.evaluate(objective => {
      const item = window.AgentApp.require('goalCore').listGoals().find(goal => goal.objective === objective);
      return {
        status: item && item.status,
        lastError: item && item.lastError,
        turnCount: item && item.turnCount,
        events: item && Array.isArray(item.events) ? item.events.map(event => event.type) : []
      };
    }, objective);

    expect(goal.status).toBe('active');
    expect(goal.turnCount).toBe(1);
    expect(goal.events).toContain('protocol_warning');
    expect(goal.events).not.toContain('protocol_pause');
    expect(goal.lastError || '').not.toContain('Goal protocol violation');
    expect(backend.llmCalls.length).toBeGreaterThanOrEqual(4);
    await expect(page.locator('#sendBtn')).not.toHaveClass(/stop/);
    clientErrors.expectNoErrors();
  });

  test('marks a goal blocked only after the repeated blocker threshold is reached', async ({ page }) => {
    const objective = 'E2E repeated blocker goal';
    const { clientErrors } = await gotoApp(page, {
      goalScenario: true,
      goalScenarioBlocked: true
    });
    await configureMockProvider(page);
    await ensureCurrentChat(page);

    await openGoalPanel(page);
    await page.fill('#goalObjectiveInput', objective);
    await page.fill('#goalMaxTurnsInput', '4');
    await page.locator('[data-action="createGoalFromUi"]').click();

    await waitForGoalStatus(page, objective, 'blocked');
    const goal = await page.evaluate(objective => {
      const item = window.AgentApp.require('goalCore').listGoals().find(goal => goal.objective === objective);
      const events = item && Array.isArray(item.events) ? item.events : [];
      return {
        status: item && item.status,
        lastError: item && item.lastError,
        turnCount: item && item.turnCount,
        auditCounts: events.filter(event => event.type === 'blocked_audit').map(event => event.count),
        eventTypes: events.map(event => event.type)
      };
    }, objective);

    expect(goal.status).toBe('blocked');
    expect(goal.lastError).toBe('E2E blocker requires user input');
    expect(goal.turnCount).toBe(3);
    expect(goal.auditCounts).toEqual([1, 2, 3]);
    expect(goal.eventTypes).toContain('blocked');
    expect(goal.eventTypes).not.toContain('error');
    clientErrors.expectNoErrors();
  });

  test('creates a scheduled goal and only runs it after the selected time arrives', async ({ page }) => {
    const { backend, clientErrors } = await gotoApp(page, { goalScenario: true });
    await configureMockProvider(page);
    await ensureCurrentChat(page);

    await page.locator('#scheduleBtn').click();
    await expect(page.locator('#schedulePicker')).not.toHaveAttribute('hidden', '');
    await page.fill('#scheduleTimeInput', datetimeLocalFromNow(60_000));

    await openGoalPanel(page);
    await createGoalFromPanel(page, 'E2E scheduled goal');
    await expect(page.locator('#schedulePicker')).toHaveAttribute('hidden', '');

    await expect.poll(() => page.evaluate(() => {
      const goal = window.AgentApp.require('goalCore').listGoals().find(item => item.objective === 'E2E scheduled goal');
      return goal ? { status: goal.status, scheduledStatus: goal.scheduled && goal.scheduled.status } : null;
    })).toEqual({ status: 'paused', scheduledStatus: 'waiting' });
    expect(backend.llmCalls).toHaveLength(0);

    await page.evaluate(() => {
      const core = window.AgentApp.require('goalCore');
      const goal = core.listGoals().find(item => item.objective === 'E2E scheduled goal');
      if (!goal || !goal.scheduled) throw new Error('Scheduled goal was not created');
      goal.scheduled.runAt = Date.now() - 1;
      core.saveGoals();
      core.processScheduledGoals();
    });

    await waitForGoalStatus(page, 'E2E scheduled goal', 'complete');
    expect(backend.llmCalls.length).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#messagesInner')).toContainText('Goal complete: E2E scheduled goal');

    clientErrors.expectNoErrors();
  });

  test('accepts normal mid-run guidance while a goal is running and continues in the same chat', async ({ page }) => {
    const { backend, clientErrors } = await gotoApp(page, {
      goalScenario: true,
      delayForLlm(body, callNumber) {
        return callNumber === 1 ? 1200 : 20;
      }
    });
    await configureMockProvider(page);
    await ensureCurrentChat(page);

    const before = await goalSnapshot(page);
    await openGoalPanel(page);
    await createGoalFromPanel(page, 'E2E guided goal');
    await page.locator('#goalModal [data-action="closeGoalPanel"]').click();
    await expect(page.locator('#goalModal')).not.toHaveClass(/show/);
    await waitForGenerating(page);

    await page.fill('#input', 'E2E midrun guidance: use the revised approach');
    await page.locator('#sendBtn').click();

    await waitForGoalStatus(page, 'E2E guided goal', 'complete');
    await expect(page.locator('#messagesInner')).toContainText('E2E midrun guidance: use the revised approach');

    const after = await goalSnapshot(page);
    expect(after.currentId).toBe(before.currentId);
    expect(after.chatCount).toBe(before.chatCount);
    expect(after.messages.some(msg => msg.goalGuidance && String(msg.content).includes('revised approach'))).toBe(true);
    expect(after.messages.filter(msg => msg.goalFinal)).toHaveLength(1);
    expect(backend.llmCalls.some(call => JSON.stringify(call.body).includes('用户中途引导'))).toBe(true);
    expect(backend.llmCalls.some(call => JSON.stringify(call.body).includes('E2E midrun guidance: use the revised approach'))).toBe(true);

    clientErrors.expectNoErrors();
  });
});
