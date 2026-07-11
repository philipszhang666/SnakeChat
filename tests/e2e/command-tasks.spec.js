const { test, expect } = require('@playwright/test');
const {
  configureMockProvider,
  gotoApp,
  sendMessage,
  waitForAssistantReply
} = require('./helpers');

test.describe('command task tool workflow', () => {
  test('keeps short commands out of task list and exposes timed-out background tasks', async ({ page }) => {
    const { backend, clientErrors } = await gotoApp(page, { commandTaskScenario: true });
    await configureMockProvider(page);

    await page.evaluate(() => {
      window.AgentApp.require('terminal').setFullAccessMode(true);
    });
    await expect.poll(() => page.evaluate(() => state.tools.some(tool => tool.name === 'execute_action'))).toBe(true);
    await expect.poll(() => page.evaluate(() => state.tools.some(tool => tool.name === 'command_task_list'))).toBe(true);
    await expect.poll(() => page.evaluate(() => state.tools.some(tool => tool.name === 'command_task_output'))).toBe(true);

    await page.locator('#toolsBtn').click();
    await expect.poll(() => page.evaluate(() => state.settings.useTools)).toBe(true);

    await sendMessage(page, 'run command task e2e workflow');
    await waitForAssistantReply(
      page,
      'Command task final: short command was not listed, timed-out task was listed and queried.',
      30_000
    );

    const relevantCalls = backend.backendCalls.filter(call => [
      'execute',
      'command_task_list',
      'command_task_output'
    ].includes(call.action));

    expect(relevantCalls.map(call => call.action)).toEqual([
      'execute',
      'command_task_list',
      'execute',
      'command_task_list',
      'command_task_output'
    ]);

    expect(relevantCalls[0].body).toMatchObject({
      command: 'echo short-e2e',
      cwd: 'C:\\e2e-workspace',
      timeout: 5,
      timeout_max: 300,
      max_runtime: 3600
    });
    expect(backend.commandTaskListSnapshots[0].tasks).toEqual([]);

    expect(relevantCalls[2].body.command).toContain('long-e2e-done');
    expect(relevantCalls[2].body).toMatchObject({
      cwd: 'C:\\e2e-workspace',
      timeout: 1,
      timeout_max: 300,
      max_runtime: 3600
    });

    expect(backend.commandTaskListSnapshots[1].tasks.map(task => task.task_id)).toEqual(['cmd_e2e_visible_long']);
    expect(relevantCalls[4].body).toMatchObject({
      task_id: 'cmd_e2e_visible_long',
      wait: 0,
      wait_max: 300
    });
    expect(backend.commandTasks.cmd_e2e_visible_long).toMatchObject({
      status: 'completed',
      running: false,
      returncode: 0
    });

    const sessionIds = relevantCalls.map(call => call.body.session_id).filter(Boolean);
    expect(new Set(sessionIds).size).toBe(1);
    clientErrors.expectNoErrors();
  });
});
