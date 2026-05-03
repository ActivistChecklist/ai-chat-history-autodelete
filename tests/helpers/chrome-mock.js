import { vi, beforeEach } from 'vitest';

const store = {};

function makeStorageArea() {
  return {
    get: vi.fn(async (keys) => {
      if (typeof keys === 'string') {
        return { [keys]: store[keys] ?? undefined };
      }
      if (Array.isArray(keys)) {
        const result = {};
        keys.forEach((k) => { result[k] = store[k] ?? undefined; });
        return result;
      }
      return { ...store };
    }),
    set: vi.fn(async (items) => {
      Object.assign(store, items);
    }),
    remove: vi.fn(async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((k) => delete store[k]);
    }),
    clear: vi.fn(async () => {
      Object.keys(store).forEach((k) => delete store[k]);
    })
  };
}

const storageArea = makeStorageArea();

globalThis.chrome = {
  storage: {
    local: storageArea,
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },
  alarms: {
    create: vi.fn(),
    clear: vi.fn(),
    onAlarm: { addListener: vi.fn() }
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
    onClicked: { addListener: vi.fn() }
  },
  runtime: {
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    getURL: vi.fn((path) => `chrome-extension://test-id/${path}`),
    getManifest: vi.fn(() => ({ name: 'AI Chat History Auto-Delete', version: '1.0.0' })),
    openOptionsPage: vi.fn()
  },
  tabs: {
    query: vi.fn(async () => []),
    get: vi.fn(async (tabId) => {
      throw new Error(`No tab with id: ${tabId}`);
    }),
    create: vi.fn(async (opts) => ({ id: 1, ...opts })),
    update: vi.fn(async () => ({})),
    sendMessage: vi.fn(async () => ({}))
  },
  scripting: {
    executeScript: vi.fn(async () => [{ result: { status: 200, ok: true, body: {} } }]),
    insertCSS: vi.fn(async () => {})
  },
  notifications: {
    create: vi.fn()
  }
};

export function getStore() {
  return store;
}

export function clearStore() {
  Object.keys(store).forEach((k) => delete store[k]);
}

beforeEach(() => {
  clearStore();
  vi.clearAllMocks();
});
