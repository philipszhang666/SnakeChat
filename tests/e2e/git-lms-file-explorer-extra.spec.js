const { test, expect } = require('@playwright/test');
const {
  gotoApp
} = require('./helpers');

async function openSettingsSection(page, section) {
  await page.locator('button[data-action="openSettings"]').first().click();
  await expect(page.locator('#settingsPage')).toHaveClass(/show/);
  await page.locator(`.settings-nav-item[data-settings-section="${section}"]`).click();
  await expect(page.locator('#settingsPageContent .settings-docked-panel')).toBeVisible();
}

async function gitCalls(backend, subcommand) {
  return backend.backendCalls.filter(call => call.action === 'git' && call.body.subcommand === subcommand);
}

async function expectGitCall(backend, subcommand, predicate = () => true) {
  await expect.poll(async () => (await gitCalls(backend, subcommand)).some(predicate)).toBe(true);
}

async function acceptGitDanger(page) {
  const modal = page.locator('.git-danger-mask').last();
  await expect(modal).toBeVisible();
  await modal.locator('.git-danger-input').fill('我确定');
  await expect(modal.locator('[data-act="ok"]')).toBeEnabled();
  await modal.locator('[data-act="ok"]').click();
  await expect(modal).toBeHidden();
}

async function openGitBranchMenu(page) {
  const trigger = page
    .locator('[data-action="_toggleBranchMenu"]')
    .filter({ has: page.locator('#gitBranchInlineBadge') });
  await trigger.click();
  const menu = page.locator('#gitBranchMenu');
  await expect(menu).not.toHaveAttribute('hidden', '');
  const triggerBox = await trigger.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(Math.abs((menuBox.x + menuBox.width) - (triggerBox.x + triggerBox.width))).toBeLessThan(36);
  expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y - 4);
}

async function openLmsPanel(page) {
  await page.locator('[data-action="openLmsPanel"]').click();
  await expect(page.locator('#lmsPanel')).toHaveClass(/show/);
}

async function openExplorer(page) {
  await page.locator('#sidebarExplorerBtn').click();
  await expect(page.locator('#sidebarExplorerPanel')).not.toHaveAttribute('hidden', '');
  await expect(page.locator('#fileExplorerList')).toContainText('sample.txt');
}

async function openFileFromExplorer(page, name) {
  await page.locator('#fileExplorerList .file-explorer-item').filter({ hasText: name }).click();
}

async function openFileContextMenu(page, name) {
  const nameLocator = page
    .locator('#fileExplorerList .file-explorer-item')
    .filter({ hasText: name })
    .locator('.file-explorer-name');
  await nameLocator.evaluate(el => {
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 4,
      clientY: rect.top + rect.height / 2
    }));
  });
  await expect(page.locator('#fileExplorerContextMenu')).not.toHaveAttribute('hidden', '');
}

async function openBlankExplorerContextMenu(page) {
  await page.locator('#fileExplorerList').evaluate(el => {
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 180
    }));
  });
  await expect(page.locator('#fileExplorerContextMenu')).not.toHaveAttribute('hidden', '');
}

async function clickContextMenuAction(page, action) {
  await page.locator(`#fileExplorerContextMenu [data-action="${action}"]:visible`).click();
}

function graphicalExplorerItem(page, name) {
  return page.locator('#fileExplorerGraphList .file-explorer-item').filter({ hasText: name });
}

async function openGraphicalFileContextMenu(page, name) {
  const nameLocator = graphicalExplorerItem(page, name).locator('.file-explorer-name');
  await nameLocator.evaluate(el => {
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 4,
      clientY: rect.top + rect.height / 2
    }));
  });
  await expect(page.locator('#fileExplorerContextMenu')).not.toHaveAttribute('hidden', '');
}

async function openBlankGraphicalContextMenu(page) {
  await page.locator('#fileExplorerGraphList').evaluate(el => {
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 420,
      clientY: 260
    }));
  });
  await expect(page.locator('#fileExplorerContextMenu')).not.toHaveAttribute('hidden', '');
}

async function clickBlankGraphicalExplorerSpace(page) {
  await page.locator('#fileExplorerGraphList').evaluate(el => {
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: rect.right - 8,
      clientY: rect.bottom - 8
    }));
  });
}

async function beginGraphicalExplorerDrag(page, sourceName, targetName) {
  await page.evaluate(({ sourceName, targetName }) => {
    const itemByName = name => Array.from(document.querySelectorAll('#fileExplorerGraphList .file-explorer-item'))
      .find(item => item.querySelector('.file-explorer-name')?.textContent.trim() === name);
    const source = itemByName(sourceName);
    const target = itemByName(targetName);
    if (!source || !target) throw new Error(`Missing drag item ${sourceName} -> ${targetName}`);
    const dataTransfer = new DataTransfer();
    window.__e2eFileExplorerDragData = dataTransfer;
    source.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      dataTransfer
    }));
    target.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      dataTransfer
    }));
    target.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer
    }));
  }, { sourceName, targetName });
}

async function finishGraphicalExplorerDrag(page, sourceName, targetName) {
  await page.evaluate(({ sourceName, targetName }) => {
    const itemByName = name => Array.from(document.querySelectorAll('#fileExplorerGraphList .file-explorer-item'))
      .find(item => item.querySelector('.file-explorer-name')?.textContent.trim() === name);
    const source = itemByName(sourceName);
    const target = itemByName(targetName);
    const dataTransfer = window.__e2eFileExplorerDragData || new DataTransfer();
    if (!source || !target) throw new Error(`Missing drop item ${sourceName} -> ${targetName}`);
    target.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer
    }));
    source.dispatchEvent(new DragEvent('dragend', {
      bubbles: true,
      cancelable: true,
      dataTransfer
    }));
    delete window.__e2eFileExplorerDragData;
  }, { sourceName, targetName });
}

async function graphicalExplorerTopRowCount(page) {
  return page.locator('#fileExplorerGraphList .file-explorer-item').evaluateAll(items => {
    const boxes = items
      .map(item => item.getBoundingClientRect())
      .filter(rect => rect.width > 0 && rect.height > 0);
    if (!boxes.length) return 0;
    const top = Math.min(...boxes.map(rect => rect.top));
    return boxes.filter(rect => Math.abs(rect.top - top) < 2).length;
  });
}

function expectGraphicalCardRatio(box) {
  expect(Math.abs((box.width / box.height) - (16 / 9))).toBeLessThan(0.04);
}

async function expectElementCanScroll(locator) {
  await expect(locator).toBeVisible();
  const metrics = await locator.evaluate(el => {
    el.scrollTop = 0;
    el.scrollTop = el.scrollHeight;
    const style = getComputedStyle(el);
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      overflowY: style.overflowY
    };
  });
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 1);
  expect(metrics.scrollTop).toBeGreaterThan(0);
  expect(['auto', 'scroll']).toContain(metrics.overflowY);
}

async function installBrowserStubs(page) {
  await page.addInitScript(() => {
    window.__e2eClipboard = '';
    window.__openedUrls = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => {
          window.__e2eClipboard = String(text);
        }
      }
    });
    window.open = url => {
      window.__openedUrls.push(String(url));
      return null;
    };
  });
}

test.describe('extra Git, LMS, and file explorer E2E coverage without real services', () => {
  test('Git branch menu, commit-and-push, recovery, config clearing, and credential help use mocked Git', async ({ page }) => {
    const { backend, clientErrors } = await gotoApp(page);

    await openSettingsSection(page, 'git');
    await expect(page.locator('#gitBody')).toContainText('js/pricing.js');

    await openGitBranchMenu(page);
    await page.locator('#gitBranchMenu [data-action="_doBranchCreate"]').click();
    await expectGitCall(backend, 'branch_create', call => call.body.name === 'e2e-value');

    await openGitBranchMenu(page);
    await page.locator('#gitBranchMenu [data-action="_doBranchRename"]').click();
    await expectGitCall(backend, 'branch_rename', call => call.body.new === 'e2e-value');

    await openGitBranchMenu(page);
    await page.locator('#gitBranchMenu .git-branch-item[data-name="feature/e2e"]').click();
    await acceptGitDanger(page);
    await expectGitCall(backend, 'branch_switch', call => call.body.name === 'feature/e2e');

    await page.fill('#gitCommitMsg', 'E2E commit and push');
    await page.locator('[data-action="_onCommitAndPush"]').click();
    await expectGitCall(backend, 'commit', call => call.body.message === 'E2E commit and push');
    await expectGitCall(backend, 'push');

    await page.locator('[data-action="_showGitConfigInline"]').first().click();
    await expect(page.locator('#cfgUserName')).toBeVisible();
    await page.locator('#gitConfigInline [data-action="_clearGitConfig"]').click();
    await expectGitCall(backend, 'config_set', call => call.body.key === 'user.name' && call.body.value === '');
    await expectGitCall(backend, 'config_set', call => call.body.key === 'user.email' && call.body.value === '');

    await page.locator('[data-action="_undoLastReset"]').click();
    await acceptGitDanger(page);
    await expectGitCall(backend, 'reset_orig_head');

    await page.locator('#gitBody [data-action="_openRemotePanel"]').first().click();
    await expect(page.locator('#gitRemotePanel')).toHaveClass(/show/);
    await page.locator('[data-action="_showCredHelp"]').click();
    await expect(page.locator('.git-help-box')).toContainText('GitHub');
    await page.locator('.git-help-box [data-action="removeClosest"]').click();
    await expect(page.locator('.git-help-box')).toHaveCount(0);

    clientErrors.expectNoErrors();
  });

  test('Git init wizard initializes an empty mocked workspace', async ({ page }) => {
    const { backend, clientErrors } = await gotoApp(page, { gitInRepo: false });

    await openSettingsSection(page, 'git');
    await expect(page.locator('#gitBody')).toContainText('初始化');
    await page.fill('#initUserName', 'Init E2E User');
    await page.fill('#initUserEmail', 'init-e2e@example.test');
    await page.locator('[data-action="_doInit"]').click();
    await expectGitCall(backend, 'init', call =>
      call.body.userName === 'Init E2E User' &&
      call.body.userEmail === 'init-e2e@example.test'
    );

    clientErrors.expectNoErrors();
  });

  test('LMS login dialog covers saved credentials, MFA, explicit refreshes, attendance paging, and cookie clearing', async ({ page }) => {
    const { backend, clientErrors } = await gotoApp(page, {
      lmsHasSavedCredential: true,
      lmsLoginRequiresMfa: true
    });

    await openLmsPanel(page);
    await page.locator('#lmsStatusBar [data-handler="lmsPanelOpenCookieEditor"][data-value="login"]').first().click();
    await expect(page.locator('#lmsCookieModal')).toHaveClass(/show/);
    await expect(page.locator('#lmsSavedCredentialBox')).toContainText('e2e-student');
    await page.locator('[data-action="lmsPanelClearSavedCredential"]').click();
    await expect.poll(() => backend.lmsServiceCalls.some(call =>
      call.path === '/lms-login' && call.body.action === 'clear_credentials'
    )).toBe(true);

    await page.fill('#lmsLoginUsername', 'e2e-student');
    await page.fill('#lmsLoginPassword', 'fake-password');
    await page.locator('#lmsLoginRemember').check();
    await page.locator('[data-action="lmsPanelLoginWithPassword"]').click();
    await expect(page.locator('#lmsLoginMfaBox')).toBeVisible();
    await page.locator('[data-action="lmsPanelSendMfaCode"]').click();
    await page.fill('#lmsLoginMfaCode', '123456');
    await page.locator('[data-action="lmsPanelVerifyMfaCode"]').click();
    await expect(page.locator('#lmsCookieModal')).not.toHaveClass(/show/);

    await page.locator('#lmsPanelBody [data-handler="lmsPanelSetPage"][data-value="lms"]').click();
    await expect(page.locator('#lmsPanelBody')).toContainText('E2E Homework');
    await page.locator('#lmsTab_todos').click();
    await page.locator('#lmsPanelBody [data-action="lmsPanelFetchTodos"]').click();
    await expect(page.locator('#lmsPanelBody')).toContainText('E2E Homework');
    await page.locator('#lmsTab_courses').click();
    await page.locator('#lmsPanelBody [data-action="lmsPanelFetchCourses"]').click();
    await expect(page.locator('#lmsPanelBody')).toContainText('Software Engineering');

    await page.locator('#lmsPanelBody [data-handler="lmsPanelSetPage"][data-value="home"]').click();
    await page.locator('#lmsPanelBody [data-handler="lmsPanelSetPage"][data-value="attendance"]').click();
    await page.locator('[data-action="lmsPanelFetchAttendance"]').click();
    await expect(page.locator('#lmsPanelBody')).toContainText('flow-1');
    await page.locator('[data-action="lmsPanelAttendanceNextPage"]').click();
    await expect(page.locator('#lmsPanelBody')).toContainText('flow-2');
    await page.locator('[data-action="lmsPanelAttendancePrevPage"]').click();
    await expect(page.locator('#lmsPanelBody')).toContainText('flow-1');

    await page.locator('#lmsStatusBar [data-handler="lmsPanelOpenCookieEditor"][data-value="cookie"]').first().click();
    await expect(page.locator('#lmsCookieModal')).toHaveClass(/show/);
    await page.locator('[data-action="lmsPanelClearCookie"]').click();
    await expect(page.locator('#lmsCookieModal')).not.toHaveClass(/show/);

    expect(backend.lmsServiceCalls.map(call => call.body.action)).toEqual(expect.arrayContaining([
      'credential_status',
      'clear_credentials',
      'start',
      'send_mfa',
      'verify_mfa'
    ]));
    clientErrors.expectNoErrors();
  });

  test('file explorer context menus, editor controls, inline panel, clipboard, and workspace navigation use mocked backend', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installBrowserStubs(page);
    const { backend, clientErrors } = await gotoApp(page, {
      dialogResponses: ['e2e-created.txt', 'reload-confirm', 'e2e-folder']
    });

    await openExplorer(page);
    await openBlankExplorerContextMenu(page);
    await clickContextMenuAction(page, 'new-file');
    await expect(page.locator('#fileEditorModal')).toHaveClass(/show/);
    await expect(page.locator('#fileEditorPath')).toContainText('e2e-created.txt');
    await expect.poll(() => backend.backendCalls.some(call =>
      call.action === 'create_file' && call.body.path === 'e2e-created.txt'
    )).toBe(true);

    await page.fill('#fileEditorContent', 'clipboard from file editor');
    await page.locator('[data-action="copyFileEditorContent"]').click();
    await expect.poll(() => page.evaluate(() => window.__e2eClipboard)).toBe('clipboard from file editor');
    await page.fill('#fileEditorContent', 'changed before reload');
    await page.locator('[data-action="reloadFileEditor"]').click();
    await expect(page.locator('#fileEditorContent')).toHaveValue(/Sample file content/);
    await page.locator('[data-action="openCurrentFileInMainPanel"][data-kind="text"]').click();
    await expect(page.locator('#fileEditorModal')).not.toHaveClass(/show/);
    await expect(page.locator('#inlineFilePanel')).not.toHaveAttribute('hidden', '');
    await page.locator('[data-action="copyInlineFileContent"]').click();
    await expect.poll(() => page.evaluate(() => window.__e2eClipboard)).toContain('Sample file content');
    await page.locator('[data-action="closeInlineFilePanel"]').click();

    await openBlankExplorerContextMenu(page);
    await clickContextMenuAction(page, 'new-folder');
    await expect.poll(() => backend.backendCalls.some(call =>
      call.action === 'create_dir' && call.body.path === 'e2e-folder'
    )).toBe(true);

    await openFileContextMenu(page, 'sample.txt');
    await clickContextMenuAction(page, 'copy-path');
    await expect.poll(() => page.evaluate(() => window.__e2eClipboard)).toBe('sample.txt');

    await openFileFromExplorer(page, 'sample.md');
    await expect(page.locator('#fileEditorModal')).toHaveClass(/show/);
    await page.locator('[data-action="toggleFileEditorMarkdownPreview"]').click();
    await expect(page.locator('#fileEditorMarkdownPreview')).toBeVisible();
    await page.locator('[data-action="closeFileEditor"]').first().click();

    await openFileFromExplorer(page, 'sample.py');
    await expect(page.locator('#fileEditorModal')).toHaveClass(/show/);
    await page.locator('[data-action="toggleFileEditorCodePreview"]').click();
    await expect(page.locator('#fileEditorMarkdownPreview')).toBeVisible();
    await page.locator('[data-action="closeFileEditor"]').first().click();

    await openFileFromExplorer(page, 'src');
    await expect(page.locator('#fileExplorerPath')).toHaveText('src');
    await page.locator('[data-action="fileExplorerGoUp"]').click();
    await expect(page.locator('#fileExplorerPath')).toHaveText('.');
    const listCallsBeforeRefresh = backend.backendCalls.filter(call => call.action === 'list_dir').length;
    await page.locator('[data-action="refreshFileExplorer"]').click();
    await expect.poll(() => backend.backendCalls.filter(call => call.action === 'list_dir').length).toBeGreaterThan(listCallsBeforeRefresh);

    clientErrors.expectNoErrors();
  });

  test('file explorer supports ctrl multi-select batch copy, cut, and delete', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installBrowserStubs(page);
    const { backend, clientErrors } = await gotoApp(page);

    const item = name => page.locator('#fileExplorerList .file-explorer-item').filter({ hasText: name });
    const expectBackendPaths = async (action, paths, targetDir) => {
      await expect.poll(() => {
        const matched = backend.backendCalls.filter(call =>
          call.action === action
          && paths.includes(call.body.path)
          && (targetDir === undefined || call.body.target_dir === targetDir)
        );
        return new Set(matched.map(call => call.body.path)).size;
      }).toBe(paths.length);
    };

    await openExplorer(page);
    await item('sample.txt').click({ modifiers: ['Control'] });
    await item('sample.md').click({ modifiers: ['Control'] });
    await expect(item('sample.txt')).toHaveClass(/is-selected/);
    await expect(item('sample.md')).toHaveClass(/is-selected/);
    await expect(page.locator('#fileEditorModal')).not.toHaveClass(/show/);

    await openFileContextMenu(page, 'sample.txt');
    await clickContextMenuAction(page, 'copy-item');
    await openBlankExplorerContextMenu(page);
    await clickContextMenuAction(page, 'paste');
    await expectBackendPaths('copy_file', ['sample.txt', 'sample.md'], '.');

    await item('sample.txt').click({ modifiers: ['Control'] });
    await item('sample.md').click({ modifiers: ['Control'] });
    await item('sample.py').click({ modifiers: ['Control'] });
    await item('sample.tex').click({ modifiers: ['Control'] });
    await expect(item('sample.py')).toHaveClass(/is-selected/);
    await expect(item('sample.tex')).toHaveClass(/is-selected/);
    await openFileContextMenu(page, 'sample.py');
    await clickContextMenuAction(page, 'cut-item');
    await openFileContextMenu(page, 'src');
    await clickContextMenuAction(page, 'paste');
    await expectBackendPaths('move_file', ['sample.py', 'sample.tex'], 'src');

    await item('sample.pdf').click({ modifiers: ['Control'] });
    await item('sample.png').click({ modifiers: ['Control'] });
    await expect(item('sample.pdf')).toHaveClass(/is-selected/);
    await expect(item('sample.png')).toHaveClass(/is-selected/);
    await openFileContextMenu(page, 'sample.pdf');
    await clickContextMenuAction(page, 'delete');
    await expectBackendPaths('delete_file', ['sample.pdf', 'sample.png']);

    clientErrors.expectNoErrors();
  });

  test('file explorer graphical window opens from the blank context menu and reuses existing actions', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installBrowserStubs(page);
    const { backend, clientErrors } = await gotoApp(page);
    await page.evaluate(() => localStorage.removeItem('aichat_file_explorer_graph_view_v1'));

    await openExplorer(page);
    await openBlankExplorerContextMenu(page);
    await expect(page.locator('#fileExplorerContextMenu [data-action="open-graphical"]:visible')).toHaveText('图形化界面');
    await clickContextMenuAction(page, 'open-graphical');

    await expect(page.locator('#fileExplorerGraphModal')).toHaveClass(/show/);
    const modalBox = await page.locator('#fileExplorerGraphModal .file-explorer-graph-modal').boundingBox();
    const titleBox = await page.locator('#fileExplorerGraphTitle').boundingBox();
    expect(modalBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(Math.abs((modalBox.width / modalBox.height) - (16 / 9))).toBeLessThan(0.05);
    expect(titleBox.y - modalBox.y).toBeGreaterThanOrEqual(14);
    await expect(page.locator('#fileExplorerGraphAddress')).toContainText('e2e-workspace');
    expect(await page.locator('#fileExplorerGraphAddress [data-graph-address-path]').count()).toBeGreaterThan(1);
    await expect(page.locator('#fileExplorerGraphAddress [data-graph-address-path="."]')).toContainText('e2e-workspace');
    await expect(page.locator('#fileExplorerGraphQuickAccessList')).toContainText(/沙箱目录|当前目录/);
    await expect(page.locator('#fileExplorerGraphList')).toContainText('sample.txt');
    await expect(graphicalExplorerItem(page, 'sample.txt')).toBeVisible();
    const graphItemBox = await graphicalExplorerItem(page, 'sample.txt').boundingBox();
    const graphIconBox = await graphicalExplorerItem(page, 'sample.txt').locator('.file-explorer-icon').boundingBox();
    expect(graphItemBox).not.toBeNull();
    expect(graphIconBox).not.toBeNull();
    expectGraphicalCardRatio(graphItemBox);
    expect(graphIconBox.width / graphItemBox.width).toBeGreaterThan(0.7);
    const largeTopRowCount = await graphicalExplorerTopRowCount(page);
    expect(largeTopRowCount).toBeGreaterThanOrEqual(4);

    await page.locator('#fileExplorerGraphViewTrigger').click();
    await expect(page.locator('#fileExplorerGraphViewMenu')).toBeVisible();
    await expect(page.locator('#fileExplorerGraphViewTrigger')).not.toContainText('☰');
    await expect(page.locator('#fileExplorerGraphViewMenu .file-explorer-graph-view-option-icon')).toHaveCount(0);
    await expect(page.locator('#fileExplorerGraphViewMenu [data-graph-view-mode="large"]')).toHaveClass(/is-active/);

    await page.locator('#fileExplorerGraphViewMenu [data-graph-view-mode="small"]').click();
    await expect(page.locator('#fileExplorerGraphList')).toHaveClass(/is-small/);
    await expect(page.locator('#fileExplorerGraphViewLabel')).toHaveText('小图标');
    const smallItemBox = await graphicalExplorerItem(page, 'sample.txt').boundingBox();
    expect(smallItemBox).not.toBeNull();
    expectGraphicalCardRatio(smallItemBox);
    expect(smallItemBox.width).toBeLessThan(graphItemBox.width);
    expect(await graphicalExplorerTopRowCount(page)).toBeGreaterThan(largeTopRowCount);

    await page.locator('#fileExplorerGraphViewTrigger').click();
    await page.locator('#fileExplorerGraphViewMenu [data-graph-view-mode="list"]').click();
    await expect(page.locator('#fileExplorerGraphList')).toHaveClass(/is-list/);
    await expect(page.locator('#fileExplorerGraphViewLabel')).toHaveText('列表');
    const listItemBox = await graphicalExplorerItem(page, 'sample.txt').boundingBox();
    const listIconBox = await graphicalExplorerItem(page, 'sample.txt').locator('.file-explorer-icon').boundingBox();
    expect(listItemBox).not.toBeNull();
    expect(listIconBox).not.toBeNull();
    await expect(graphicalExplorerItem(page, 'sample.txt')).toHaveCSS('flex-shrink', '0');
    expect(listItemBox.height).toBeGreaterThanOrEqual(37);
    expect(listItemBox.height).toBeLessThanOrEqual(39);
    expect(listIconBox.width).toBeGreaterThanOrEqual(23);
    expect(listIconBox.width).toBeLessThanOrEqual(25);
    expect(listItemBox.width / listItemBox.height).toBeGreaterThan(5);

    await page.locator('#fileExplorerGraphViewTrigger').click();
    await page.locator('#fileExplorerGraphViewMenu [data-graph-view-mode="details"]').click();
    await expect(page.locator('#fileExplorerGraphList')).toHaveClass(/is-details/);
    const detailsItemBox = await graphicalExplorerItem(page, 'sample.txt').boundingBox();
    expect(detailsItemBox).not.toBeNull();
    await expect(graphicalExplorerItem(page, 'sample.txt')).toHaveCSS('flex-shrink', '0');
    expect(detailsItemBox.height).toBeGreaterThanOrEqual(37);
    expect(detailsItemBox.height).toBeLessThanOrEqual(39);

    await page.locator('#fileExplorerGraphViewTrigger').click();
    await page.locator('#fileExplorerGraphViewMenu [data-graph-view-mode="xlarge"]').click();
    await expect(page.locator('#fileExplorerGraphList')).toHaveClass(/is-xlarge/);
    await expect(page.locator('#fileExplorerGraphViewLabel')).toHaveText('超大图标');
    const xlargeItemBox = await graphicalExplorerItem(page, 'sample.txt').boundingBox();
    const xlargeIconBox = await graphicalExplorerItem(page, 'sample.txt').locator('.file-explorer-icon').boundingBox();
    expect(xlargeItemBox).not.toBeNull();
    expect(xlargeIconBox).not.toBeNull();
    expectGraphicalCardRatio(xlargeItemBox);
    expect(xlargeItemBox.width).toBeGreaterThan(graphItemBox.width);
    expect(await graphicalExplorerTopRowCount(page)).toBeLessThan(largeTopRowCount);
    expect(xlargeIconBox.width / xlargeItemBox.width).toBeGreaterThan(0.7);

    await beginGraphicalExplorerDrag(page, 'sample.txt', 'src');
    await expect(graphicalExplorerItem(page, 'src')).toHaveClass(/is-drop-target/);
    await finishGraphicalExplorerDrag(page, 'sample.txt', 'src');
    await expect.poll(() => backend.backendCalls.some(call =>
      call.action === 'move_file' && call.body.path === 'sample.txt' && call.body.target_dir === 'src'
    )).toBe(true);
    await expect(graphicalExplorerItem(page, 'src')).not.toHaveClass(/is-drop-target/);

    await openGraphicalFileContextMenu(page, 'sample.txt');
    await clickContextMenuAction(page, 'copy-path');
    await expect.poll(() => page.evaluate(() => window.__e2eClipboard)).toBe('sample.txt');

    await graphicalExplorerItem(page, 'sample.txt').click();
    await expect(page.locator('#fileEditorModal')).toHaveClass(/show/);
    const modalLayers = await page.evaluate(() => ({
      graph: Number(getComputedStyle(document.getElementById('fileExplorerGraphModal')).zIndex),
      editor: Number(getComputedStyle(document.getElementById('fileEditorModal')).zIndex)
    }));
    expect(modalLayers.editor).toBeGreaterThan(modalLayers.graph);
    await page.locator('[data-action="closeFileEditor"]').first().click();
    await expect(page.locator('#fileEditorModal')).not.toHaveClass(/show/);

    await graphicalExplorerItem(page, 'sample.md').click({ modifiers: ['Control'] });
    await expect(graphicalExplorerItem(page, 'sample.md')).toHaveClass(/is-selected/);
    await clickBlankGraphicalExplorerSpace(page);
    await expect(graphicalExplorerItem(page, 'sample.md')).not.toHaveClass(/is-selected/);
    await graphicalExplorerItem(page, 'sample.md').click({ modifiers: ['Control'] });
    await expect(graphicalExplorerItem(page, 'sample.md')).toHaveClass(/is-selected/);
    await page.locator('#fileExplorerGraphModal [data-graph-command="copy"]').click();
    await page.locator('#fileExplorerGraphModal [data-graph-command="paste"]').click();
    await expect.poll(() => backend.backendCalls.some(call =>
      call.action === 'copy_file' && call.body.path === 'sample.md' && call.body.target_dir === '.'
    )).toBe(true);

    await graphicalExplorerItem(page, 'src').click();
    await expect(page.locator('#fileExplorerPath')).toHaveText('src');
    await expect(page.locator('#fileExplorerGraphAddress [data-graph-address-path="src"]')).toHaveText('src');
    await page.locator('#fileExplorerGraphAddress [data-graph-address-path="."]').filter({ hasText: 'e2e-workspace' }).click();
    await expect(page.locator('#fileExplorerPath')).toHaveText('.');
    await graphicalExplorerItem(page, 'src').click();
    await expect(page.locator('#fileExplorerPath')).toHaveText('src');
    await page.locator('#fileExplorerGraphUpBtn').click();
    await expect(page.locator('#fileExplorerPath')).toHaveText('.');

    await openBlankGraphicalContextMenu(page);
    await expect(page.locator('#fileExplorerContextMenu [data-action="open-graphical"]:visible')).toHaveText('图形化界面');
    await page.locator('[data-file-explorer-graph-close]').click();
    await expect(page.locator('#fileExplorerGraphModal')).not.toHaveClass(/show/);

    clientErrors.expectNoErrors();
  });

  test('inline markdown and Python preview panes scroll in the main panel', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 760 });
    const { clientErrors } = await gotoApp(page);
    await page.waitForFunction(() => typeof window.openTextInMainPanel === 'function');

    const markdown = Array.from({ length: 120 }, (_, i) =>
      `## Section ${i + 1}\n\nParagraph ${i + 1} from the inline markdown scroll regression fixture.`
    ).join('\n\n');
    await page.evaluate(async content => {
      await window.openTextInMainPanel('sample.md', content, content.length);
    }, markdown);
    await expect(page.locator('#inlineFilePanel')).not.toHaveAttribute('hidden', '');
    await page.locator('#inlineMarkdownToggle').click();
    await expectElementCanScroll(page.locator('#inlineFileBody .inline-markdown-preview'));
    await page.locator('[data-action="closeInlineFilePanel"]').click();

    const python = Array.from({ length: 140 }, (_, i) =>
      `def function_${i + 1}():\n    value = ${i + 1}\n    return "line " + str(value)`
    ).join('\n\n');
    await page.evaluate(async content => {
      await window.openTextInMainPanel('sample.py', content, content.length);
    }, python);
    await expect(page.locator('#inlineFilePanel')).not.toHaveAttribute('hidden', '');
    await page.locator('#inlinePythonToggle').click();
    await expectElementCanScroll(page.locator('#inlineFileBody .inline-code-preview'));
    await page.locator('[data-action="closeInlineFilePanel"]').click();

    clientErrors.expectNoErrors();
  });

  test('file explorer previews PDF, image, media, inline PDF new-tab, and TeX compilation via mocked backend', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installBrowserStubs(page);
    const { backend, clientErrors } = await gotoApp(page);

    await openExplorer(page);
    await openFileFromExplorer(page, 'sample.pdf');
    await expect(page.locator('#pdfViewerModal')).toHaveClass(/show/);
    await page.locator('[data-action="openPdfViewerInNewTab"]').click();
    await expect.poll(() => page.evaluate(() => window.__openedUrls.length)).toBe(1);
    await page.locator('[data-action="openCurrentFileInMainPanel"][data-kind="pdf"]').click();
    await expect(page.locator('#inlineFilePanel')).not.toHaveAttribute('hidden', '');
    await page.locator('[data-action="openInlineFileInNewTab"]').click();
    await expect.poll(() => page.evaluate(() => window.__openedUrls.length)).toBe(2);
    await page.locator('[data-action="closeInlineFilePanel"]').click();

    await openFileFromExplorer(page, 'sample.png');
    await expect(page.locator('#imageViewerModal')).toHaveClass(/show/);
    await page.locator('[data-action="openImageViewerInNewTab"]').click();
    await expect.poll(() => page.evaluate(() => window.__openedUrls.length)).toBe(3);
    await page.locator('#imageViewerModal [data-action="closeImageViewer"]').last().click();

    await openFileFromExplorer(page, 'sample.mp3');
    await expect(page.locator('#mediaViewerModal')).toHaveClass(/show/);
    await page.locator('[data-action="openMediaViewerInNewTab"]').click();
    await expect.poll(() => page.evaluate(() => window.__openedUrls.length)).toBe(4);
    await page.locator('#mediaViewerModal [data-action="closeMediaViewer"]').last().click();

    await openFileContextMenu(page, 'sample.tex');
    await clickContextMenuAction(page, 'compile-tex');
    await expect.poll(() => backend.backendCalls.some(call =>
      call.action === 'compile_tex' && call.body.path === 'sample.tex'
    )).toBe(true);
    await expect(page.locator('#pdfViewerModal')).toHaveClass(/show/);

    clientErrors.expectNoErrors();
  });
});
