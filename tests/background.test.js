import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStore } from './helpers/chrome-mock.js';

let messageHandler;
let alarmHandler;
let installedHandler;
let startupHandler;
let storageChangedHandler;

beforeEach(async () => {
  messageHandler = null;
  alarmHandler = null;
  installedHandler = null;
  startupHandler = null;
  storageChangedHandler = null;

  chrome.runtime.onMessage.addListener.mockImplementation((fn) => { messageHandler = fn; });
  chrome.alarms.onAlarm.addListener.mockImplementation((fn) => { alarmHandler = fn; });
  chrome.runtime.onInstalled.addListener.mockImplementation((fn) => { installedHandler = fn; });
  chrome.runtime.onStartup.addListener.mockImplementation((fn) => { startupHandler = fn; });
  chrome.storage.onChanged.addListener.mockImplementation((fn) => { storageChangedHandler = fn; });
  chrome.action.onClicked.addListener.mockImplementation(() => {});

  vi.resetModules();
  await import('../src/background.js');
});

describe('background service worker', () => {
  it('registers message listener', () => {
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled();
    expect(messageHandler).toBeTypeOf('function');
  });

  it('registers alarm listener', () => {
    expect(chrome.alarms.onAlarm.addListener).toHaveBeenCalled();
    expect(alarmHandler).toBeTypeOf('function');
  });

  it('registers onInstalled listener', () => {
    expect(chrome.runtime.onInstalled.addListener).toHaveBeenCalled();
    expect(installedHandler).toBeTypeOf('function');
  });

  it('registers onStartup listener', () => {
    expect(chrome.runtime.onStartup.addListener).toHaveBeenCalled();
    expect(startupHandler).toBeTypeOf('function');
  });

  it('registers storage change listener', () => {
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalled();
    expect(storageChangedHandler).toBeTypeOf('function');
  });

  it('syncs alarm from settings on load', () => {
    expect(chrome.alarms.clear).toHaveBeenCalled();
  });
});

describe('message handler - OPEN_OPTIONS', () => {
  it('opens options page', async () => {
    const sendResponse = vi.fn();
    messageHandler({ type: 'OPEN_OPTIONS' }, {}, sendResponse);
    await vi.waitFor(() => expect(chrome.runtime.openOptionsPage).toHaveBeenCalled());
  });

  it('stores pending hash and opens options when hash is provided', async () => {
    messageHandler({ type: 'OPEN_OPTIONS', hash: 'activity-history' }, {}, vi.fn());
    await vi.waitFor(() => expect(chrome.storage.local.set).toHaveBeenCalled());
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ options_pending_hash: 'activity-history' })
    );
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
  });
});

describe('message handler - RUN_NOW', () => {
  it('returns error when no Claude tab is open', async () => {
    chrome.tabs.query.mockResolvedValue([]);
    const sendResponse = vi.fn();
    const result = messageHandler({ type: 'RUN_NOW', options: {} }, {}, sendResponse);
    expect(result).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    const response = sendResponse.mock.calls[0][0];
    expect(response.error).toMatch(/No Claude tab/i);
  });
});

describe('message handler - TEST_ALARM', () => {
  it('returns error when no Claude tab open', async () => {
    chrome.tabs.query.mockResolvedValue([]);
    const sendResponse = vi.fn();
    const result = messageHandler({ type: 'TEST_ALARM' }, {}, sendResponse);
    expect(result).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    const response = sendResponse.mock.calls[0][0];
    expect(response.error).toBeDefined();
  });
});

describe('message handler - CONFIRM_DELETE', () => {
  it('returns error when execution fails', async () => {
    chrome.tabs.get.mockResolvedValue({ id: 999, url: 'https://claude.ai/chat' });
    chrome.scripting.executeScript.mockResolvedValue([{
      result: { status: 401, ok: false, body: 'Unauthorized' }
    }]);
    const sendResponse = vi.fn();
    const result = messageHandler(
      { type: 'CONFIRM_DELETE', tabId: 999, chatIds: ['c1'] },
      {},
      sendResponse
    );
    expect(result).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });
    const response = sendResponse.mock.calls[0][0];
    expect(response.error).toBeDefined();
  });

  it('uses another Claude tab when stored tab id is stale', async () => {
    const sendResponse = vi.fn();
    chrome.tabs.get.mockRejectedValue(new Error('No tab with id: 614124583'));
    chrome.tabs.query.mockResolvedValue([{ id: 42, url: 'https://claude.ai/new' }]);
    chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: { organization: [{ uuid: 'org-1' }] } } }])
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: [] } }])
      .mockResolvedValue([{ result: { status: 200, ok: true, body: { deleted: ['c1'] } } }]);
    const result = messageHandler(
      { type: 'CONFIRM_DELETE', tabId: 614124583, chatIds: ['c1'] },
      {},
      sendResponse
    );
    expect(result).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });
    expect(chrome.scripting.executeScript).toHaveBeenCalled();
    const firstTarget = chrome.scripting.executeScript.mock.calls[0][0].target;
    expect(firstTarget.tabId).toBe(42);
    const response = sendResponse.mock.calls[0][0];
    expect(response.deleted).toBe(1);
    expect(response.error).toBeUndefined();
  });
});

describe('message handler - DEBUG_CHAT_DATES', () => {
  it('handles debug chat dates request', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 1 }]);
    chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: [{ uuid: 'org-1' }] } }])
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: [] } }])
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: [] } }]);
    const sendResponse = vi.fn();
    const result = messageHandler({ type: 'DEBUG_CHAT_DATES' }, {}, sendResponse);
    expect(result).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });
    const response = sendResponse.mock.calls[0][0];
    expect(response).toHaveProperty('chats');
    expect(response).toHaveProperty('debugLog');
  });
});

describe('message handler - INTEGRATION_TEST', () => {
  it('dry run returns oldest chat without deleting', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 1 }]);
    const chats = [
      { uuid: 'c1', name: 'Newer', updated_at: '2025-06-01T00:00:00Z' },
      { uuid: 'c2', name: 'Oldest', updated_at: '2025-01-01T00:00:00Z' }
    ];
    chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: [{ uuid: 'org-1' }] } }])
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: chats } }])
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: chats } }]);
    const sendResponse = vi.fn();
    messageHandler({ type: 'INTEGRATION_TEST', dryRun: true }, {}, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });
    const response = sendResponse.mock.calls[0][0];
    expect(response.dryRun).toBe(true);
    expect(response.chat.id).toBe('c2');
    expect(response.chat.name).toBe('Oldest');
  });

  it('returns error when no chats found', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 1 }]);
    chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: [{ uuid: 'org-1' }] } }])
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: [] } }])
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: [] } }]);
    const sendResponse = vi.fn();
    messageHandler({ type: 'INTEGRATION_TEST', dryRun: true }, {}, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });
    const response = sendResponse.mock.calls[0][0];
    expect(response.error).toMatch(/No chats found/i);
  });

  it('auto-opens a Claude tab when none exists', async () => {
    chrome.tabs.query.mockResolvedValue([]);
    chrome.tabs.create.mockResolvedValue({ id: 42 });
    chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: [{ uuid: 'org-1' }] } }])
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: [] } }])
      .mockResolvedValueOnce([{ result: { status: 200, ok: true, body: [] } }]);
    const sendResponse = vi.fn();
    messageHandler({ type: 'INTEGRATION_TEST', dryRun: true }, {}, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 10000 });
    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://claude.ai' })
    );
    const response = sendResponse.mock.calls[0][0];
    expect(response.error).toMatch(/No chats found/i);
  });
});

describe('onInstalled', () => {
  it('opens onboarding page on install', async () => {
    await installedHandler({ reason: 'install' });
    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ active: true })
    );
  });

  it('marks onboarding complete on update if settings exist', async () => {
    getStore().settings = { daysThreshold: 14 };
    await installedHandler({ reason: 'update' });
    expect(getStore().onboarding_complete).toBe(true);
  });

  it('syncs alarm on install/update', async () => {
    chrome.alarms.clear.mockClear();
    await installedHandler({ reason: 'install' });
    expect(chrome.alarms.clear).toHaveBeenCalled();
  });
});

describe('onStartup', () => {
  it('sets badge from pending confirm count', async () => {
    getStore().pending_confirm = { count: 3 };
    await startupHandler();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '3' });
  });

  it('clears badge when no pending', async () => {
    await startupHandler();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('clears badge when pending is snoozed', async () => {
    getStore().pending_confirm = { count: 3, snoozedUntil: Date.now() + 86400000 };
    await startupHandler();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });
});

describe('storage change listener', () => {
  it('updates badge when pending_confirm changes', () => {
    storageChangedHandler(
      { pending_confirm: { newValue: { count: 5 } } },
      'local'
    );
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '5' });
  });

  it('clears badge when pending_confirm is snoozed', () => {
    storageChangedHandler(
      { pending_confirm: { newValue: { count: 5, snoozedUntil: Date.now() + 86400000 } } },
      'local'
    );
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('clears badge when pending_confirm is removed', () => {
    storageChangedHandler(
      { pending_confirm: { newValue: null } },
      'local'
    );
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('ignores changes from other areas', () => {
    chrome.action.setBadgeText.mockClear();
    storageChangedHandler({ pending_confirm: { newValue: { count: 5 } } }, 'sync');
    expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
  });
});

describe('alarm handler', () => {
  it('ignores alarms with wrong name', async () => {
    chrome.tabs.query.mockClear();
    await alarmHandler({ name: 'some-other-alarm' });
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  it('skips when frequency is manual', async () => {
    getStore().settings = { runFrequency: 'manual' };
    chrome.tabs.query.mockClear();
    await alarmHandler({ name: 'auto-delete-check' });
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  it('skips when claude is disabled', async () => {
    getStore().settings = { runFrequency: 'daily', enabledSites: { claude: false } };
    chrome.tabs.query.mockClear();
    await alarmHandler({ name: 'auto-delete-check' });
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  it('skips when last run is too recent', async () => {
    getStore().settings = { runFrequency: 'daily' };
    getStore().last_run = { timestamp: Date.now(), deleted: 0 };
    chrome.tabs.query.mockClear();
    await alarmHandler({ name: 'auto-delete-check' });
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  it('skips when pending deletion is snoozed', async () => {
    getStore().settings = { runFrequency: 'daily' };
    getStore().last_run = { timestamp: 0, deleted: 0 };
    getStore().pending_confirm = {
      count: 2,
      snoozedUntil: Date.now() + 86400000,
      timestamp: Date.now()
    };
    chrome.tabs.query.mockClear();
    await alarmHandler({ name: 'auto-delete-check' });
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });
});
