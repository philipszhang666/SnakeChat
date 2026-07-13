const { test, expect } = require('@playwright/test');
const {
  configureMockProvider,
  gotoApp,
  sendMessage,
  waitForAssistantReply,
  closeSettingsPageIfOpen
} = require('./helpers');

async function openSettingsSection(page, section) {
  const settingsPage = page.locator('#settingsPage');
  if (!(await settingsPage.evaluate(el => el.classList.contains('show')).catch(() => false))) {
    await page.locator('button[data-action="openSettings"]').first().click();
    await expect(settingsPage).toHaveClass(/show/);
  }
  await page.locator(`.settings-nav-item[data-settings-section="${section}"]`).click();
  await expect(page.locator('#settingsPageContent .settings-docked-panel')).toBeVisible();
}

async function setCheckbox(page, selector, checked) {
  await page.locator(selector).evaluate((el, value) => {
    el.checked = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, checked);
}

test.describe('extra settings prompts and safety controls without real services', () => {
  test('mode prompt presets and reset buttons update plan, outline, reflection, and PPT settings', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);
    await configureMockProvider(page);

    await expect(page.locator('#planBtn')).toHaveCount(0);
    await openSettingsSection(page, 'plan');
    await setCheckbox(page, '#plan_enabled', true);
    await page.locator('[data-action="savePlanSettings"]').click();
    await expect.poll(() => page.evaluate(() => window.AgentApp.require('state').state.settings.usePlan)).toBe(true);
    await page.locator('[data-action="toggleOutline"]').click();
    await expect(page.locator('#outlineBtn')).toHaveClass(/outline-active/);
    await expect.poll(() => page.evaluate(() => window.AgentApp.require('state').state.settings.usePlan)).toBe(false);

    await openSettingsSection(page, 'plan');
    await page.locator('[data-action="applyPlanPreset"][data-value="code"]').click();
    await expect(page.locator('#plan_plannerPrompt')).not.toHaveValue('');
    await page.fill('#plan_plannerPrompt', 'temporary e2e plan prompt');
    await page.locator('[data-action="resetPlanPrompts"]').click();
    await expect(page.locator('#plan_plannerPrompt')).not.toHaveValue('temporary e2e plan prompt');

    await openSettingsSection(page, 'outline');
    await page.fill('#outline_systemPrompt', 'temporary e2e outline prompt');
    await page.locator('[data-action="resetOutlinePrompt"]').click();
    await expect(page.locator('#outline_systemPrompt')).not.toHaveValue('temporary e2e outline prompt');
    await page.locator('details').filter({ has: page.locator('#outline_codeTaskPrompt') }).locator('summary').click();
    await page.fill('#outline_codeTaskPrompt', 'temporary e2e code task prompt');
    await page.locator('[data-action="resetAllOutlinePrompts"]').click();
    await expect(page.locator('#outline_codeTaskPrompt')).not.toHaveValue('temporary e2e code task prompt');

    await openSettingsSection(page, 'reflection');
    await page.locator('[data-action="applyPreset"][data-value="code"]').click();
    await expect(page.locator('#ref_studentPrompt')).not.toHaveValue('');
    await setCheckbox(page, '#ref_enabled', true);
    await page.locator('[data-action="saveReflectionSettings"]').click();
    await expect.poll(() => page.evaluate(() => !!state.settings.useReflection)).toBe(true);

    await openSettingsSection(page, 'ppt');
    await page.fill('#pptUnderstandPrompt', 'temporary e2e ppt prompt');
    await page.locator('[data-action="resetPptPromptsToDefault"]').click();
    await expect(page.locator('#pptUnderstandPrompt')).not.toHaveValue('temporary e2e ppt prompt');
    await setCheckbox(page, '#pptEnabled', true);
    await page.fill('#pptSlideCount', '6');
    await page.locator('[data-action="savePptSettings"]').click();
    await expect.poll(() => page.evaluate(() => ({
      usePpt: !!state.settings.usePpt,
      slideCount: state.settings.pptSlideCount
    }))).toEqual({ usePpt: true, slideCount: 6 });

    await closeSettingsPageIfOpen(page);
    clientErrors.expectNoErrors();
  });

  test('MCP/Skill settings, JSON tabs, pricing currency, and permission cleanup controls persist expected state', async ({ page }) => {
    const { clientErrors } = await gotoApp(page, { dialogResponses: ['initial-e2e-profile', 'renamed-e2e-profile'] });
    await configureMockProvider(page, { modelName: 'mock-model, mock-model-fast' });

    await openSettingsSection(page, 'main');
    await page.locator('[data-action="onSaveAsNewProfile"]').click();
    await expect(page.locator('[data-action="onRenameActiveProfile"]')).toBeEnabled();
    await page.locator('[data-action="onRenameActiveProfile"]').click();
    await expect(page.locator('#apiProfileTriggerText')).toContainText('renamed-e2e-profile');

    await openSettingsSection(page, 'mcpSkill');
    await page.fill('#mcpServerName', 'temporary-mcp');
    await page.fill('#mcpServerCommand', 'node');
    await page.fill('#mcpServerArgs', 'server.js');
    await page.locator('[data-action="clearMcpServerForm"]').click();
    await expect(page.locator('#mcpServerName')).toHaveValue('');
    await expect(page.locator('#mcpServerCommand')).toHaveValue('');

    await page.locator('[data-action="switchMcpSkillTab"][data-value="skills"]').click();
    await page.fill('#skillRootsText', 'skill\n.codex/skills');
    await setCheckbox(page, '#skillUseEnabled', false);
    await page.locator('[data-action="saveSkillRootsFromUi"]').click();
    await expect.poll(() => page.evaluate(() => {
      const cfg = ensureMcpSkillSettings();
      return { roots: cfg.skillRoots, useSkills: cfg.useSkills };
    })).toEqual({ roots: ['skill', '.codex/skills'], useSkills: false });

    await closeSettingsPageIfOpen(page);
    await sendMessage(page, 'json tab setup message');
    await waitForAssistantReply(page, 'Mock reply #1: json tab setup message');
    await openSettingsSection(page, 'jsonEditor');
    await page.locator('[data-action="switchJsonTab"][data-jsontab="headers"]').click();
    await expect(page.locator('#jsonTab-headers')).toBeVisible();
    await page.fill('#jsonHeaders', '{}');
    await page.locator('[data-action="setCodexUserAgentHeader"]').click();
    await expect(page.locator('#jsonHeaders')).toHaveValue(/codex-tui/);
    await page.locator('[data-action="switchJsonTab"][data-jsontab="history"]').click();
    await expect(page.locator('#jsonTab-history')).toBeVisible();

    await openSettingsSection(page, 'pricing');
    await page.locator('[data-action="addPricingRow"]').click();
    const pricingRow = page.locator('#pricingTableBody tr[data-idx]').last();
    await pricingRow.locator('.pricing-key').fill('currency-e2e-model');
    await pricingRow.locator('[data-action="setPricingCurrency"][data-value="CNY"]').click();
    await expect(pricingRow.locator('.pricing-currency')).toHaveValue('CNY');

    await openSettingsSection(page, 'permissions');
    await page.evaluate(() => {
      getTaskAllowForChat(state.currentId).execute = true;
      renderTaskPermissionsList();
    });
    await expect(page.locator('#taskPermissionsList [data-action="onClearTaskPerms"]')).toBeVisible();
    await page.locator('[data-action="onClearTaskPerms"]').click();
    await expect.poll(() => page.evaluate(() => Object.keys(getTaskAllowForChat(state.currentId)).length)).toBe(0);
    await page.locator('[data-action="onClearAllSecrets"]').click();
    await expect.poll(() => page.evaluate(() => state.settings.apiKey || '')).toBe('');

    await closeSettingsPageIfOpen(page);
    clientErrors.expectNoErrors();
  });

  test('LMS saved credential login and fetch-all controls run through the mocked LMS service', async ({ page }) => {
    const { backend, clientErrors } = await gotoApp(page, {
      lmsHasSavedCredential: true
    });

    await page.locator('[data-action="openLmsPanel"]').click();
    await expect(page.locator('#lmsPanel')).toHaveClass(/show/);
    await page.locator('#lmsStatusBar [data-handler="lmsPanelOpenCookieEditor"][data-value="login"]').first().click();
    await expect(page.locator('#lmsCookieModal')).toHaveClass(/show/);
    await expect(page.locator('#lmsSavedCredentialBox')).toContainText('e2e-student');
    await page.locator('[data-action="lmsPanelLoginWithSavedCredential"]').click();
    await expect(page.locator('#lmsCookieModal')).not.toHaveClass(/show/);
    await expect.poll(() => backend.lmsServiceCalls.some(call =>
      call.path === '/lms-login' && call.body.action === 'start_saved'
    )).toBe(true);

    await page.evaluate(() => {
      const lms = window.AgentApp.require('lmsPanel');
      lms.LMS_PANEL_STATE.cache = lms.lmsPanelEmptyCache();
      lms.LMS_PANEL_STATE.page = 'lms';
      lms.LMS_PANEL_STATE.tab = 'overview';
      lms.lmsPanelRender();
    });
    await page.locator('[data-action="lmsPanelFetchAll"]').click();
    await expect(page.locator('#lmsPanelBody')).toContainText('E2E Homework');
    await expect.poll(() => backend.lmsProxyCalls.length).toBeGreaterThan(0);

    await page.locator('#lmsStatusBar [data-handler="lmsPanelOpenCookieEditor"][data-value="cookie"]').first().click();
    await expect(page.locator('#lmsCookieModal')).toHaveClass(/show/);
    await page.locator('[data-action="lmsPanelCloseCookieEditor"]').first().click();
    await expect(page.locator('#lmsCookieModal')).not.toHaveClass(/show/);
    await page.locator('[data-action="closeLmsPanel"]').click();
    clientErrors.expectNoErrors();
  });

  test('manual context compression uses a structured mocked summary and keeps the composer usable', async ({ page }) => {
    const { backend, clientErrors } = await gotoApp(page);
    await configureMockProvider(page);

    for (const text of ['compress seed one', 'compress seed two', 'compress seed three']) {
      await sendMessage(page, text);
      await waitForAssistantReply(page, 'Mock reply');
    }
    expect(backend.llmCalls).toHaveLength(3);

    await page.locator('[data-action="manualCompress"]').click();
    await expect.poll(() => backend.llmCalls.length, { timeout: 15_000 }).toBeGreaterThan(3);
    await expect.poll(() => page.evaluate(() => currentChat().messages.some(m => !!m._isSummary)), { timeout: 15_000 }).toBe(true);
    await expect(page.locator('#sendBtn')).not.toHaveClass(/stop/);
    await sendMessage(page, 'after manual compression');
    await waitForAssistantReply(page, 'Mock reply');
    clientErrors.expectNoErrors();
  });

  test('auto compression honors the saved usage threshold setting', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);

    await openSettingsSection(page, 'main');
    await page.locator('#compressAutoThreshold').evaluate(el => {
      el.value = '90';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#settingsPageContent [data-action="saveAndClose"]').click();
    await expect.poll(() => page.evaluate(() => state.settings.compressAutoThreshold)).toBe(90);

    await page.evaluate(() => {
      const apiCore = window.AgentApp.require('apiCore');
      window.__e2eOriginalThresholdCallOnce = apiCore.callOnceWithRole;
      window.__e2eThresholdCompressionCalls = 0;
      apiCore.callOnceWithRole = async () => {
        window.__e2eThresholdCompressionCalls += 1;
        return [
          '## 当前任务',
          'E2E threshold summary.',
          '',
          '## 用户目标和约束',
          'Verify auto compression threshold settings without a live model.',
          '',
          '## 已完成事项',
          'Generated a mocked compression summary.',
          '',
          '## 关键决策和事实',
          'The threshold should be read from settings instead of falling back to 75.',
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
          'Playwright is exercising the auto compression threshold path.',
          '',
          '## 未完成事项',
          'Continue after compression.',
          '',
          '## 风险/阻塞',
          '无',
          '',
          '## 下一步建议',
          'Keep using the configured threshold.',
          '',
          '## 可丢弃上下文',
          'Earlier raw message wording can be discarded.'
        ].join('\n');
      };

      window.saveContextLimitRules([{ key: 'e2e-threshold-model', limit: 8000 }]);
      state.settings.currentModel = 'e2e-threshold-model';
      state.settings.compressAutoEnabled = true;
      state.settings.compressKeepLast = 2;
      state.settings.maxTokens = 0;
      state.settings.systemPrompt = '';
      window.AgentApp.require('chat').newChat();
      const chat = currentChat();
      const roles = ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant'];
      chat.messages = roles.map((role, idx) => ({
        role,
        content: `threshold message ${idx} ` + 'x'.repeat(3000)
      }));
      renderMessages();
    });

    const highThresholdResult = await page.evaluate(() => window.autoCompressCheck(currentChat()));
    expect(highThresholdResult).toBe(false);
    await expect.poll(() => page.evaluate(() => window.__e2eThresholdCompressionCalls)).toBe(0);

    const lowThresholdResult = await page.evaluate(async () => {
      state.settings.compressAutoThreshold = 50;
      return await window.autoCompressCheck(currentChat());
    });
    expect(lowThresholdResult).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__e2eThresholdCompressionCalls)).toBe(1);
    await expect.poll(() => page.evaluate(() => currentChat().messages.some(m => !!m._isSummary))).toBe(true);

    await page.evaluate(() => {
      const apiCore = window.AgentApp.require('apiCore');
      if (window.__e2eOriginalThresholdCallOnce) {
        apiCore.callOnceWithRole = window.__e2eOriginalThresholdCallOnce;
        delete window.__e2eOriginalThresholdCallOnce;
      }
      delete window.__e2eThresholdCompressionCalls;
    });
    clientErrors.expectNoErrors();
  });

  test('context compression keeps stable base summaries and merges bounded deltas', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);
    await page.evaluate(() => {
      const apiCore = window.AgentApp.require('apiCore');
      window.__e2eOriginalCompressionCallOnce = apiCore.callOnceWithRole;
      window.__e2eCompressionPrompts = [];
      apiCore.callOnceWithRole = async messages => {
        const prompt = String(messages && messages[0] && messages[0].content || '');
        window.__e2eCompressionPrompts.push(prompt);
        const isDelta = prompt.includes('本次要输出“近期增量摘要”');
        const kind = isDelta ? 'delta' : 'base';
        const seq = window.__e2eCompressionPrompts.length;
        return [
          '## 当前任务',
          `E2E ${kind} summary ${seq}.`,
          '',
          '## 用户目标和约束',
          'Verify two-layer compression summaries without a live model.',
          '',
          '## 已完成事项',
          `Generated ${kind} summary in mocked compression call ${seq}.`,
          '',
          '## 关键决策和事实',
          'Stable base summaries should be preserved while delta summaries are below the merge threshold.',
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
          'Playwright is exercising the compression state transitions.',
          '',
          '## 未完成事项',
          'Continue after compression.',
          '',
          '## 风险/阻塞',
          '无',
          '',
          '## 下一步建议',
          'Use the newest kept user message.',
          '',
          '## 可丢弃上下文',
          'Earlier raw message wording can be discarded.'
        ].join('\n');
      };

      window.AgentApp.require('chat').newChat();
      const chat = currentChat();
      state.settings.compressKeepLast = 2;
      state.settings.currentModel = 'mock-model';
      chat.messages = [
        { role: 'user', content: 'base old user one' },
        { role: 'assistant', content: 'base old assistant one' },
        { role: 'user', content: 'base old user two' },
        { role: 'assistant', content: 'base old assistant two' },
        { role: 'user', content: 'initial latest keep user' }
      ];

      window.__e2eRunCompression = async label => {
        const c = currentChat();
        if (label) {
          const last = c.messages[c.messages.length - 1];
          if (last && last.role === 'user') {
            c.messages.push({ role: 'assistant', content: `${label} answer to previous keep` });
          }
          c.messages.push({ role: 'user', content: `${label} compressible user detail` });
          c.messages.push({ role: 'assistant', content: `${label} compressible assistant detail` });
          c.messages.push({ role: 'user', content: `${label} latest keep user` });
        }
        renderMessages();
        return await window.compressChat(c, {
          reason: 'manual',
          retryMaxAttempts: 0
        });
      };
      renderMessages();
    });

    await expect.poll(() => page.evaluate(() => window.__e2eRunCompression(''))).toBe(true);
    const afterBase = await page.evaluate(() => {
      const summaries = currentChat().messages.filter(m => m && m._isSummary);
      return summaries.map(m => ({
        layer: m._summaryLayer,
        content: m.content,
        originalCount: m._originalCount
      }));
    });
    expect(afterBase).toHaveLength(1);
    expect(afterBase[0].layer).toBe('base');
    expect(afterBase[0].content).toContain('【稳定基础摘要】');
    expect(afterBase[0].content).not.toContain('由 AI');
    expect(afterBase[0].content).not.toContain('原 4 条消息');
    const firstBaseContent = afterBase[0].content;

    await expect.poll(() => page.evaluate(() => window.__e2eRunCompression('delta-one'))).toBe(true);
    const afterDelta = await page.evaluate(() => {
      const summaries = currentChat().messages.filter(m => m && m._isSummary);
      return {
        summaries: summaries.map(m => ({
          layer: m._summaryLayer,
          content: m.content,
          undoId: m._compressionUndoId
        })),
        prompts: window.__e2eCompressionPrompts.slice()
      };
    });
    expect(afterDelta.summaries.map(m => m.layer)).toEqual(['base', 'delta']);
    expect(afterDelta.summaries[0].content).toBe(firstBaseContent);
    expect(afterDelta.summaries[1].content).toContain('【近期增量摘要】');
    expect(afterDelta.prompts.at(-1)).toContain('【已有摘要，仅作去重和衔接参考，不要改写】');
    expect(afterDelta.prompts.at(-1)).toContain('本次要输出“近期增量摘要”');

    await page.locator('.msg-action').filter({ hasText: '撤销压缩' }).last().click();
    await expect.poll(() => page.evaluate(() =>
      currentChat().messages.filter(m => m && m._isSummary).map(m => m._summaryLayer)
    )).toEqual(['base']);
    const afterUndo = await page.evaluate(() => ({
      baseContent: currentChat().messages.find(m => m && m._isSummary)?.content || '',
      allText: currentChat().messages.map(m => m.content || '').join('\n')
    }));
    expect(afterUndo.baseContent).toBe(firstBaseContent);
    expect(afterUndo.allText).toContain('delta-one compressible user detail');

    for (const label of ['delta-two', 'delta-three', 'delta-four']) {
      await expect.poll(() => page.evaluate(value => window.__e2eRunCompression(value), label)).toBe(true);
    }
    const beforeMerge = await page.evaluate(() =>
      currentChat().messages.filter(m => m && m._isSummary).map(m => m._summaryLayer)
    );
    expect(beforeMerge).toEqual(['base', 'delta', 'delta', 'delta']);

    await expect.poll(() => page.evaluate(() => window.__e2eRunCompression('merge-after-three-deltas'))).toBe(true);
    const afterMerge = await page.evaluate(() => {
      const summaries = currentChat().messages.filter(m => m && m._isSummary);
      return {
        summaries: summaries.map(m => ({ layer: m._summaryLayer, content: m.content })),
        lastPrompt: window.__e2eCompressionPrompts.at(-1) || ''
      };
    });
    expect(afterMerge.summaries).toHaveLength(1);
    expect(afterMerge.summaries[0].layer).toBe('base');
    expect(afterMerge.summaries[0].content).toContain('【稳定基础摘要】');
    expect(afterMerge.lastPrompt).toContain('本次要输出“稳定基础摘要”');
    expect(afterMerge.lastPrompt).toContain('【已有摘要，仅作去重和衔接参考，不要改写】');

    await page.evaluate(() => {
      const apiCore = window.AgentApp.require('apiCore');
      if (window.__e2eOriginalCompressionCallOnce) {
        apiCore.callOnceWithRole = window.__e2eOriginalCompressionCallOnce;
        delete window.__e2eOriginalCompressionCallOnce;
      }
      delete window.__e2eCompressionPrompts;
      delete window.__e2eRunCompression;
    });
    clientErrors.expectNoErrors();
  });

  test('context compression auto-patches missing file paths and ignores escaped log fragments', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);
    await page.evaluate(() => {
      const apiCore = window.AgentApp.require('apiCore');
      window.__e2eOriginalCompressionCallOnce = apiCore.callOnceWithRole;
      apiCore.callOnceWithRole = async () => [
        '## 当前任务',
        '压缩一个包含文件引用和日志输出的对话。',
        '',
        '## 用户目标和约束',
        '保留后续任务需要的关键信息。',
        '',
        '## 已完成事项',
        '已读取并整理早期上下文。',
        '',
        '## 关键决策和事实',
        '需要继续当前任务。',
        '',
        '## 已查看或修改的文件',
        '无',
        '',
        '## 工具/命令结果',
        '日志中包含数据集处理输出。',
        '',
        '## 计划/大纲状态',
        '无',
        '',
        '## 测试和验证状态',
        '无',
        '',
        '## 未完成事项',
        '继续处理最新请求。',
        '',
        '## 风险/阻塞',
        '无',
        '',
        '## 下一步建议',
        '按最新用户问题继续。',
        '',
        '## 可丢弃上下文',
        '旧对话原文可丢弃。'
      ].join('\n');

      window.AgentApp.require('chat').newChat();
      const chat = currentChat();
      state.settings.compressKeepLast = 4;
      chat.messages = [
        {
          role: 'user',
          content: [
            '压缩时必须保留 student.txt / course.txt / sc.txt。',
            '日志：reviews_Beauty_5.json.gz False None\\nmeta_Beauty.js, False None\\n/media/inspur/disk1/zhzhang/conda_envs/llm4rec/bin/python data/process_beauty.py',
            '命令：chmod +x scripts/run_beauty_graph_random_811_gpu3.sh；bash -n scripts/run_beauty_graph_random_811_gpu3.sh；+x scripts/run_beauty_graph_random_811_gpu3.sh',
            '新增脚本 scripts/run_beauty_graph_random_811_gpu3.sh，正在运行 model/main.py',
            'remote command: ../../../conda_envs/nlgcl/bin/python main.py',
            'project entry: /media/inspur/disk1/zhzhang/NLGCL/main.py',
            'model/main.py|resume_beauty_tiger|run_beauty_paper|generate_code|rqvae/main.py',
            'diff --git a/media/inspur/disk1/zhzhang/TIGER-XiaoLongtaoo/data/process_beauty.py b/media/inspur/disk1/zhzhang/TIGER-XiaoLongtaoo/data/process_beauty.py',
            '/media/inspur/disk1/zhzhang/media/inspur/disk1/zhzhang/TIGER-XiaoLongtaoo/data/process_beauty.py'
          ].join('\n')
        },
        { role: 'assistant', content: '已记录这些文件和日志。' },
        { role: 'user', content: '补充上下文一。' },
        { role: 'assistant', content: '补充回答一。' },
        { role: 'user', content: '这是压缩后应该保留的最新请求。' },
        { role: 'assistant', content: '这是最新回答。' },
        { role: 'user', content: '继续。' }
      ];
      renderMessages();
    });

    const result = await page.evaluate(async () => {
      return await window.compressChat(currentChat(), {
        reason: 'manual',
        retryMaxAttempts: 0
      });
    });
    expect(result).toBe(true);

    const summary = await page.evaluate(() => {
      const msg = currentChat().messages.find(m => m && m._isSummary);
      return msg ? msg.content : '';
    });
    expect(summary).toContain('student.txt');
    expect(summary).toContain('course.txt');
    expect(summary).toContain('sc.txt');
    expect(summary).toContain('reviews_Beauty_5.json.gz');
    expect(summary).toContain('meta_Beauty.js');
    expect(summary).toContain('data/process_beauty.py');
    expect(summary).toContain('scripts/run_beauty_graph_random_811_gpu3.sh');
    expect(summary).toContain('model/main.py');
    expect(summary).toContain('rqvae/main.py');
    expect(summary).toContain('/media/inspur/disk1/zhzhang/NLGCL/main.py');
    expect(summary).toContain('/media/inspur/disk1/zhzhang/TIGER-XiaoLongtaoo/data/process_beauty.py');
    expect(summary).not.toContain('student.txt / course.txt / sc.txt');
    expect(summary).not.toContain('False None\\nmeta_Beauty.js');
    expect(summary).not.toContain('reviews_Beauty_5.json.gz False None');
    expect(summary).not.toContain('python data/process_beauty.py');
    expect(summary).not.toContain('../../../conda_envs/nlgcl/bin/python main.py');
    expect(summary).not.toContain('chmod +x scripts/run_beauty_graph_random_811_gpu3.sh');
    expect(summary).not.toContain('bash -n scripts/run_beauty_graph_random_811_gpu3.sh');
    expect(summary).not.toContain('+x scripts/run_beauty_graph_random_811_gpu3.sh');
    expect(summary).not.toContain('新增脚本 scripts/run_beauty_graph_random_811_gpu3.sh');
    expect(summary).not.toContain('正在运行 model/main.py');
    expect(summary).not.toContain('model/main.py|resume_beauty_tiger');
    expect(summary).not.toContain('a/media/inspur/disk1/zhzhang/TIGER-XiaoLongtaoo/data/process_beauty.py');
    expect(summary).not.toContain('b/media/inspur/disk1/zhzhang/TIGER-XiaoLongtaoo/data/process_beauty.py');
    expect(summary).not.toContain('/media/inspur/disk1/zhzhang/media/inspur/disk1/zhzhang/TIGER-XiaoLongtaoo/data/process_beauty.py');

    const renderedPaths = await page.evaluate(() => window.renderMarkdown([
      '/media/inspur/disk1/zhzhang/NLGCL/main.py',
      '../../../conda_envs/nlgcl/bin/python main.py',
      '- search_54.py'
    ].join('\n')));
    expect(renderedPaths).toContain('data-explorer-file="/media/inspur/disk1/zhzhang/NLGCL/main.py"');
    expect(renderedPaths).toContain('data-explorer-file="search_54.py"');
    expect(renderedPaths).not.toContain('data-explorer-file="- search_54.py"');
    expect(renderedPaths).not.toContain('>- search_54.py</a>');
    expect(renderedPaths).not.toContain('data-explorer-file="../../../conda_envs/nlgcl/bin/python main.py"');

    await page.evaluate(() => {
      const apiCore = window.AgentApp.require('apiCore');
      if (window.__e2eOriginalCompressionCallOnce) {
        apiCore.callOnceWithRole = window.__e2eOriginalCompressionCallOnce;
        delete window.__e2eOriginalCompressionCallOnce;
      }
    });
    clientErrors.expectNoErrors();
  });

  test('context compression times out and restores composer state when helper request hangs', async ({ page }) => {
    const { clientErrors } = await gotoApp(page, {
      delayForLlm(body) {
        return JSON.stringify(body).includes('上下文压缩') ? 1500 : 0;
      }
    });
    await configureMockProvider(page);

    for (const text of ['timeout seed one', 'timeout seed two', 'timeout seed three']) {
      await sendMessage(page, text);
      await waitForAssistantReply(page, 'Mock reply');
    }

    const result = await page.evaluate(async () => {
      const chat = currentChat();
      return await window.compressChat(chat, {
        reason: 'manual',
        touchGlobalGenerating: true,
        timeoutMs: 1000,
        retryMaxAttempts: 0
      });
    });
    expect(result).toBe(false);
    await expect(page.locator('#toast')).toContainText('压缩请求超时');
    const toastText = await page.locator('#toast').textContent();
    expect((toastText || '').length).toBeLessThanOrEqual(220);
    const toastBox = await page.locator('#toast').boundingBox();
    expect(toastBox.width).toBeLessThanOrEqual(720);
    expect(toastBox.height).toBeLessThanOrEqual(320);
    const toastRadius = await page.locator('#toast').evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius));
    expect(toastRadius).toBeLessThanOrEqual(20);
    await expect(page.locator('#sendBtn')).not.toHaveClass(/stop/);
    await expect.poll(() => page.evaluate(() =>
      currentChat().messages.some(m => m && m._isCompressing)
    )).toBe(false);
    await expect.poll(() => page.evaluate(() =>
      window.AgentApp.require('state').state.isGenerating
    )).toBe(false);

    clientErrors.expectNoErrors();
  });
});
