const { test, expect } = require('@playwright/test');
const {
  gotoApp
} = require('./helpers');

const STORE_KEY = 'aichat_data_v6';
const REMOTE_KEY = 'snake_remote_connection_v1';

function remoteBackend({ serverUrl, sshCommand, workspace, localPort = 18765, remoteAgentPort = 8765 }) {
  const connectionId = [
    'mock',
    sshCommand.replace(/[^A-Za-z0-9_.@-]+/g, '_'),
    workspace.replace(/[^A-Za-z0-9_.@-]+/g, '_'),
    remoteAgentPort
  ].join('-');
  return {
    type: 'remote',
    serverUrl,
    sshCommand,
    remoteWorkspace: workspace,
    remoteAgentPort,
    localPort,
    connectionId,
    updatedAt: Date.now()
  };
}

test.describe('remote workspace restoration', () => {
  test('does not auto reconnect remote config when the current restored chat is local', async ({ page }) => {
    await page.addInitScript(({ storeKey, remoteKey }) => {
      localStorage.setItem(storeKey, JSON.stringify({
        chats: [{
          id: 'local-chat',
          title: 'Local chat',
          messages: [],
          workspace: 'C:\\local-project',
          cwd: 'C:\\local-project'
        }],
        currentId: 'local-chat',
        savedAt: Date.now()
      }));
      localStorage.setItem(remoteKey, JSON.stringify({
        sshCommand: 'ssh stale-remote@example.test',
        remoteWorkspace: '/srv/stale',
        remoteAgentPort: 8765,
        localPort: 18765,
        encryptedPassword: '',
        autoReconnect: true,
        lastServerUrl: 'http://127.0.0.1:18765',
        lastConnectedAt: Date.now()
      }));
    }, { storeKey: STORE_KEY, remoteKey: REMOTE_KEY });

    const { backend, clientErrors } = await gotoApp(page);

    await expect.poll(() => page.evaluate(() => window.AgentApp.require('state').currentChat().backend.type)).toBe('local');
    await expect.poll(() => page.evaluate(() => window.AgentApp.require('terminal').TERMINAL_CONFIG.serverUrl)).toBe('http://localhost:8765');
    await expect(page.locator('#workspacePath')).toContainText('C:\\local-project');
    await page.waitForTimeout(300);
    expect(backend.backendCalls.filter(call => call.action === 'remote_connect')).toHaveLength(0);

    clientErrors.expectNoErrors();
  });

  test('switches remote chats by connection identity and persists each chat workspace as the profile default', async ({ page }) => {
    const { backend, clientErrors } = await gotoApp(page);
    const sshA = 'ssh e2e-a@example.test';
    const sshB = 'ssh e2e-b@example.test';
    backend.remoteConnections = [
      {
        connected: true,
        ssh_command: sshA,
        remote_workspace: '/srv/a',
        remote_agent_port: 8765,
        local_port: 18765,
        server_url: 'http://127.0.0.1:18765'
      },
      {
        connected: true,
        ssh_command: sshA,
        remote_workspace: '/srv/a2',
        remote_agent_port: 8765,
        local_port: 18765,
        server_url: 'http://127.0.0.1:18765'
      },
      {
        connected: true,
        ssh_command: sshB,
        remote_workspace: '/srv/b',
        remote_agent_port: 8765,
        local_port: 18766,
        server_url: 'http://127.0.0.1:18766'
      }
    ];

    const chats = [
      {
        id: 'remote-a',
        title: 'Remote A',
        messages: [],
        workspace: '/srv/a',
        cwd: '/srv/a',
        backend: remoteBackend({ serverUrl: 'http://127.0.0.1:18765', sshCommand: sshA, workspace: '/srv/a', localPort: 18765 })
      },
      {
        id: 'remote-a2',
        title: 'Remote A2',
        messages: [],
        workspace: '/srv/a2',
        cwd: '/srv/a2',
        backend: remoteBackend({ serverUrl: 'http://127.0.0.1:18765', sshCommand: sshA, workspace: '/srv/a2', localPort: 18765 })
      },
      {
        id: 'remote-b',
        title: 'Remote B',
        messages: [],
        workspace: '/srv/b',
        cwd: '/srv/b',
        backend: remoteBackend({ serverUrl: 'http://127.0.0.1:18766', sshCommand: sshB, workspace: '/srv/b', localPort: 18766 })
      }
    ];

    await page.evaluate(({ chats, remoteKey, sshA, sshB }) => {
      const stateModule = window.AgentApp.require('state');
      const terminalConfig = window.AgentApp.require('terminal').TERMINAL_CONFIG;
      stateModule.state.chats = chats;
      stateModule.state.currentId = 'remote-a';
      terminalConfig.serverUrl = 'http://127.0.0.1:18765';
      terminalConfig.workspace = '/srv/a';
      terminalConfig.cwd = '/srv/a';
      window.storage.set(remoteKey, JSON.stringify({
        sshCommand: sshA,
        remoteWorkspace: '/srv/a',
        remoteAgentPort: 8765,
        localPort: 18765,
        encryptedPassword: '',
        autoReconnect: true,
        lastServerUrl: 'http://127.0.0.1:18765',
        profiles: {
          [sshA]: {
            sshCommand: sshA,
            remoteWorkspace: '/srv/a',
            remoteAgentPort: 8765,
            localPort: 18765,
            autoReconnect: true,
            lastServerUrl: 'http://127.0.0.1:18765'
          },
          [sshB]: {
            sshCommand: sshB,
            remoteWorkspace: '/srv/b',
            remoteAgentPort: 8765,
            localPort: 18766,
            autoReconnect: true,
            lastServerUrl: 'http://127.0.0.1:18766'
          }
        }
      }));
      stateModule.saveData();
    }, { chats, remoteKey: REMOTE_KEY, sshA, sshB });

    await page.evaluate(() => window.AgentApp.require('chat').restoreWorkspaceForCurrentChat());
    await expect(page.locator('#workspacePath')).toHaveText('/srv/a');

    await page.evaluate(() => window.AgentApp.require('chat').switchChat('remote-a2'));
    await expect(page.locator('#workspacePath')).toHaveText('/srv/a2');
    await expect.poll(() => page.evaluate(() => {
      const cfg = JSON.parse(window.storage.get('snake_remote_connection_v1'));
      return cfg.profiles['ssh e2e-a@example.test'].remoteWorkspace;
    })).toBe('/srv/a2');
    expect(backend.backendCalls.filter(call =>
      call.action === 'remote_connect' && call.body.remote_workspace === '/srv/a2'
    ).length).toBeLessThanOrEqual(1);

    await page.evaluate(() => window.AgentApp.require('chat').switchChat('remote-b'));
    await expect.poll(() => page.evaluate(() => window.AgentApp.require('terminal').TERMINAL_CONFIG.serverUrl)).toBe('http://127.0.0.1:18766');
    await expect(page.locator('#workspacePath')).toHaveText('/srv/b');
    expect(backend.backendCalls.filter(call =>
      call.action === 'remote_connect' && call.body.remote_workspace === '/srv/b'
    ).length).toBeLessThanOrEqual(1);

    await page.evaluate(() => window.AgentApp.require('chat').switchChat('remote-a'));
    await expect.poll(() => page.evaluate(() => window.AgentApp.require('terminal').TERMINAL_CONFIG.serverUrl)).toBe('http://127.0.0.1:18765');
    await expect(page.locator('#workspacePath')).toHaveText('/srv/a');
    await expect.poll(() => page.evaluate(() => {
      const cfg = JSON.parse(window.storage.get('snake_remote_connection_v1'));
      return cfg.profiles['ssh e2e-a@example.test'].remoteWorkspace;
    })).toBe('/srv/a');
    expect(backend.backendCalls.filter(call =>
      call.action === 'remote_connect' && call.body.remote_workspace === '/srv/a'
    ).length).toBeLessThanOrEqual(1);

    await page.locator('[data-action="openRemoteConnection"]').click();
    await expect(page.locator('#remoteConnectionModal')).toHaveClass(/show/);
    const sshAWorkspaces = await page.locator('#remoteConnectionsList .remote-connection-item').filter({ hasText: sshA }).locator('.remote-connection-workspace').allTextContents();
    expect(sshAWorkspaces).toContain('/srv/a');
    const sshBWorkspaces = await page.locator('#remoteConnectionsList .remote-connection-item').filter({ hasText: sshB }).locator('.remote-connection-workspace').allTextContents();
    expect(sshBWorkspaces).toContain('/srv/b');

    clientErrors.expectNoErrors();
  });

  test('refreshes an open file explorer after a remote connection completes', async ({ page }) => {
    const { backend, clientErrors } = await gotoApp(page, {
      delayForBackend(action, body, state) {
        if (action === 'list_dir' && !state.delayedFirstListDir) {
          state.delayedFirstListDir = true;
          return 1200;
        }
        return 0;
      }
    });

    await page.locator('#sidebarExplorerBtn').click();
    await expect(page.locator('#sidebarExplorerPanel')).not.toHaveAttribute('hidden', '');

    await page.locator('[data-action="openRemoteConnection"]').click();
    await expect(page.locator('#remoteConnectionModal')).toHaveClass(/show/);
    await page.fill('#remoteSshCommand', 'ssh explorer@example.test');
    await page.fill('#remoteWorkspace', '/srv/connected');
    await page.fill('#remoteLocalPort', '18765');
    await page.locator('[data-action="connectRemoteAgent"]').click();

    await expect.poll(() => page.evaluate(() => window.AgentApp.require('terminal').TERMINAL_CONFIG.serverUrl)).toBe('http://127.0.0.1:18765');
    await expect(page.locator('#fileExplorerList')).toContainText('connected.txt');
    const listDirServers = backend.backendCalls
      .filter(call => call.action === 'list_dir')
      .map(call => call.serverUrl);
    expect(listDirServers).toContain('http://127.0.0.1:18765');

    clientErrors.expectNoErrors();
  });
});
