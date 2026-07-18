const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers');

async function seedSearchChats(page) {
  await page.evaluate(() => {
    const stateModule = window.AgentApp.require('state');
    const chatModule = window.AgentApp.require('chat');
    stateModule.state.temporaryChat = null;
    stateModule.state.chats = [
      {
        id: 'search-alpha',
        title: 'Alpha Notes',
        createdAt: Date.now() - 2000,
        messages: [
          { role: 'user', content: 'current chat has shared-needle and alpha-only-token' },
          { role: 'assistant', content: 'assistant response for alpha workspace' }
        ]
      },
      {
        id: 'search-beta',
        title: 'Beta Notes',
        createdAt: Date.now() - 1000,
        messages: [
          { role: 'user', content: 'other chat has shared-needle and beta-only-token' },
          {
            role: 'assistant',
            content: 'tool call visible text',
            tool_calls: [
              {
                type: 'function',
                function: { name: 'search_tool', arguments: '{"query":"tool-needle"}' }
              }
            ],
            attachments: [{ name: 'attachment-needle.md', text: 'attachment text' }]
          }
        ]
      },
      {
        id: 'search-hidden',
        title: 'Hidden Notes',
        createdAt: Date.now() - 500,
        _hiddenFromUI: true,
        messages: [
          { role: 'user', content: 'hidden-dialog-token should still be searchable' }
        ]
      }
    ];
    stateModule.state.currentId = 'search-alpha';
    stateModule.saveData();
    chatModule.renderChatList();
    chatModule.renderMessages();
  });
}

async function setSearchObjects(page, selectedIds) {
  await page.locator('[data-chat-search-object]').evaluateAll((inputs, ids) => {
    inputs.forEach(input => {
      input.checked = ids.includes(input.dataset.chatSearchObject);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }, selectedIds);
}

test.describe('chat content search', () => {
  test('global search opens from the sidebar, finds another chat, and jumps to the message', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);
    await seedSearchChats(page);

    await page.locator('button[data-action="openSavedChatSearch"]').click();
    await expect(page.locator('#chatSearchMask')).toHaveClass(/show/);
    await expect(page.locator('[data-chat-search-scope="all"]')).toHaveClass(/active/);

    await page.fill('#chatSearchInput', 'beta-only-token');
    const results = page.locator('#chatSearchResults .chat-search-result');
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText('Beta Notes');

    await results.first().click();
    await expect(page.locator('#chatSearchMask')).not.toHaveClass(/show/);
    await expect.poll(() => page.evaluate(() => window.AgentApp.require('state').state.currentId)).toBe('search-beta');
    await expect(page.locator('#messagesInner .message.dialog-jump-highlight')).toContainText('beta-only-token');
    await expect(page.locator('#messagesInner .message.chat-search-active')).toHaveCount(0);
    clientErrors.expectNoErrors();
  });

  test('current chat search excludes other chats and keyboard shortcuts open the expected scope', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);
    await seedSearchChats(page);

    await page.keyboard.press('Control+F');
    await expect(page.locator('#chatSearchMask')).toHaveClass(/show/);
    await expect(page.locator('[data-chat-search-scope="current"]')).toHaveClass(/active/);
    await page.fill('#chatSearchInput', 'shared-needle');
    await expect(page.locator('#chatSearchResults .chat-search-result')).toHaveCount(1);
    await expect(page.locator('#chatSearchResults .chat-search-result').first()).toContainText('Alpha Notes');

    await page.locator('button[data-action="closeChatSearch"]').click();
    await expect(page.locator('#chatSearchMask')).not.toHaveClass(/show/);

    await page.keyboard.press('Control+Shift+F');
    await expect(page.locator('#chatSearchMask')).toHaveClass(/show/);
    await expect(page.locator('[data-chat-search-scope="all"]')).toHaveClass(/active/);
    await expect(page.locator('#chatSearchInput')).toHaveValue('shared-needle');
    await expect(page.locator('#chatSearchResults .chat-search-result')).toHaveCount(2);

    await page.fill('#chatSearchInput', 'tool-needle');
    await expect(page.locator('#chatSearchResults .chat-search-result')).toHaveCount(1);
    await expect(page.locator('#chatSearchResults .chat-search-result').first()).toContainText('Beta Notes');
    clientErrors.expectNoErrors();
  });

  test('search object filters support multi-select across titles and tool calls', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);
    await seedSearchChats(page);

    await page.locator('button[data-action="openSavedChatSearch"]').click();
    await page.fill('#chatSearchInput', 'Beta Notes');
    await expect(page.locator('#chatSearchResults .chat-search-result')).toHaveCount(1);
    await expect(page.locator('#chatSearchResults .chat-search-result').first()).toContainText('标题');

    await setSearchObjects(page, ['user', 'assistant']);
    await expect(page.locator('#chatSearchResults .chat-search-result')).toHaveCount(0);

    await setSearchObjects(page, ['title', 'tool_call']);
    await expect(page.locator('#chatSearchResults .chat-search-result')).toHaveCount(1);
    await page.fill('#chatSearchInput', 'tool-needle');
    await expect(page.locator('#chatSearchResults .chat-search-result')).toHaveCount(1);
    await expect(page.locator('#chatSearchResults .chat-search-result').first()).toContainText('工具调用');

    await setSearchObjects(page, []);
    await expect(page.locator('#chatSearchCount')).toContainText('未选择搜索对象');
    clientErrors.expectNoErrors();
  });

  test('global search includes hidden chats and can switch to them', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);
    await seedSearchChats(page);

    await page.locator('button[data-action="openSavedChatSearch"]').click();
    await page.fill('#chatSearchInput', 'hidden-dialog-token');
    const results = page.locator('#chatSearchResults .chat-search-result');
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText('Hidden Notes');

    await results.first().click();
    await expect.poll(() => page.evaluate(() => window.AgentApp.require('state').state.currentId)).toBe('search-hidden');
    await expect(page.locator('#messagesInner')).toContainText('hidden-dialog-token');
    clientErrors.expectNoErrors();
  });

  test('wildcards work by default and fuzzy matching is controlled by a toggle', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);
    await seedSearchChats(page);

    await page.locator('button[data-action="openSavedChatSearch"]').click();
    await page.fill('#chatSearchInput', 'beta-*-token');
    await expect(page.locator('#chatSearchResults .chat-search-result')).toHaveCount(1);
    await expect(page.locator('#chatSearchResults .chat-search-result').first()).toContainText('beta-only-token');

    await page.fill('#chatSearchInput', 'bttkn');
    await expect(page.locator('#chatSearchResults .chat-search-result')).toHaveCount(0);
    await page.locator('#chatSearchFuzzyToggle').check();
    await expect(page.locator('#chatSearchResults .chat-search-result')).toHaveCount(1);
    await expect(page.locator('#chatSearchResults .chat-search-result').first()).toContainText('beta-only-token');
    clientErrors.expectNoErrors();
  });

  test('exact word matching requires full words', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);
    await seedSearchChats(page);

    await page.keyboard.press('Control+F');
    await setSearchObjects(page, ['user']);
    await page.fill('#chatSearchInput', 'alp');
    await expect(page.locator('#chatSearchResults .chat-search-result')).toHaveCount(1);

    await page.locator('#chatSearchExactToggle').check();
    await expect(page.locator('#chatSearchResults .chat-search-result')).toHaveCount(0);

    await page.fill('#chatSearchInput', 'alpha');
    await expect(page.locator('#chatSearchResults .chat-search-result')).toHaveCount(1);
    await expect(page.locator('#chatSearchResults .chat-search-result').first()).toContainText('alpha-only-token');
    clientErrors.expectNoErrors();
  });

  test('search panel restores the last selected scope, objects, and matching toggles', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);
    await seedSearchChats(page);

    await page.locator('button[data-action="openSavedChatSearch"]').click();
    await page.locator('[data-chat-search-scope="current"]').click();
    await setSearchObjects(page, ['user']);
    await page.locator('#chatSearchExactToggle').check();
    await page.locator('#chatSearchFuzzyToggle').check();
    await page.locator('button[data-action="closeChatSearch"]').click();

    await page.locator('button[data-action="openSavedChatSearch"]').click();
    await expect(page.locator('[data-chat-search-scope="current"]')).toHaveClass(/active/);
    await expect(page.locator('#chatSearchExactToggle')).toBeChecked();
    await expect(page.locator('#chatSearchFuzzyToggle')).toBeChecked();
    await expect(page.locator('[data-chat-search-object="user"]')).toBeChecked();
    await expect(page.locator('[data-chat-search-object="assistant"]')).not.toBeChecked();
    await page.locator('button[data-action="closeChatSearch"]').click();

    await page.reload();
    await seedSearchChats(page);
    await page.locator('button[data-action="openSavedChatSearch"]').click();
    await expect(page.locator('[data-chat-search-scope="current"]')).toHaveClass(/active/);
    await expect(page.locator('#chatSearchExactToggle')).toBeChecked();
    await expect(page.locator('#chatSearchFuzzyToggle')).toBeChecked();
    await expect(page.locator('[data-chat-search-object="user"]')).toBeChecked();
    await expect(page.locator('[data-chat-search-object="assistant"]')).not.toBeChecked();
    clientErrors.expectNoErrors();
  });

  test('chat sidebar menu shows saved binding details for a conversation', async ({ page }) => {
    const { clientErrors } = await gotoApp(page);
    const assistantEndTime = new Date('2026-07-18T08:30:00Z').getTime();
    await page.evaluate(ts => {
      const stateModule = window.AgentApp.require('state');
      const chatModule = window.AgentApp.require('chat');
      stateModule.state.temporaryChat = null;
      stateModule.state.chats = [
        {
          id: 'details-current-local',
          title: 'Current Local Chat',
          createdAt: ts - 120000,
          workspace: 'C:\\e2e-workspace',
          cwd: 'C:\\e2e-workspace',
          backend: { type: 'local' },
          messages: [
            { role: 'user', content: 'current chat' }
          ]
        },
        {
          id: 'details-remote-chat',
          title: 'Remote Details Chat',
          createdAt: ts - 60000,
          workspace: '/srv/project-a',
          cwd: '/srv/project-a',
          workspaceUpdatedAt: ts - 30000,
          backend: {
            type: 'remote',
            sshCommand: 'ssh dev@example.test',
            remoteWorkspace: '/srv/project-a',
            remoteAgentPort: 8765,
            localPort: 18765,
            serverUrl: 'http://127.0.0.1:18765',
            remoteGitProxyUrl: 'http://127.0.0.1:18766',
            updatedAt: ts - 20000
          },
          messages: [
            { role: 'user', content: 'show details please', createdAt: ts - 50000 },
            { role: 'assistant', content: 'details answer', _startTime: ts - 45000, _endTime: ts },
            {
              role: 'tool',
              content: 'tool result',
              createdAt: ts - 10000,
              _hiddenFromUI: true
            }
          ]
        }
      ];
      stateModule.state.currentId = 'details-current-local';
      stateModule.saveData();
      chatModule.renderChatList();
      chatModule.renderMessages();
    }, assistantEndTime);

    const item = page.locator('#chatList .chat-item[data-chat-id="details-remote-chat"]');
    await item.hover();
    await item.locator('.chat-item-menu-btn').click();
    await item.locator('[data-chat-action="details"]').click();

    const details = page.locator('#chatDetailsMask');
    await expect(details).toHaveClass(/show/);
    await expect(details).toContainText('Remote Details Chat');
    await expect(details).toContainText('/srv/project-a');
    await expect(details).toContainText('ssh dev@example.test');
    await expect(details).toContainText('2026/7/18 16:30:00');
    await expect(details).toContainText('消息总数');
    await expect(details).toContainText('3');
    await expect(details).toContainText('可见消息');
    await expect(details).toContainText('2');

    await details.locator('[data-chat-details-close]').last().click();
    await expect(details).not.toHaveClass(/show/);
    clientErrors.expectNoErrors();
  });
});
