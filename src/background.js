import { getSettings, addActivityEntry, setLastRun, setPendingConfirm, clearPendingConfirm } from './shared/storage.js';
import {
  DEBUG,
  RUN_FREQUENCIES,
  CHAT_PAGE_LIMIT,
  PAGINATION_DELAY_MS,
  DELETE_BATCH_SIZE,
  DELETE_BATCH_DELAY_MS,
  MAX_RETRIES,
  RATE_LIMIT_BACKOFF_MS,
  ALARM_NAME,
  ONBOARDING_PAGE,
  STORAGE_KEYS
} from './shared/constants.js';
import { syncAlarmFromSettings } from './shared/alarms.js';
import { claudeProvider, parseChatsResponse, getChatsWithRawDates } from './providers/claude.js';
import { resolveRunDaysThreshold, deletionCutoffMs } from './shared/run-threshold.js';

const CLAUDE_URL = 'https://claude.ai';

function setBadge(count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count > 99 ? '99+' : count) });
    chrome.action.setBadgeBackgroundColor({ color: '#0d9488' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

/** Badge hidden while user has snoozed the pending-deletion prompt. */
function badgeCountForPending(p) {
  if (!p?.count) return 0;
  if (p.snoozedUntil && Date.now() < p.snoozedUntil) return 0;
  return p.count;
}

function notifyPending(count) {
  chrome.notifications.create('autodelete-pending', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Auto-Delete',
    message: `${count} chat(s) ready to delete. Click the extension to review and confirm.`
  });
}

function log(...args) {
  if (DEBUG) console.log('[AutoDelete]', ...args);
}

async function fetchInPageContext(tabId, url, options) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (u, opts) => {
      const res = await fetch(u, {
        ...opts,
        credentials: 'include'
      });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, ok: res.ok, body };
    },
    args: [url, options || {}]
  });
  if (results[0]?.result) return results[0].result;
  log('fetch failed', { url, error: results[0]?.error });
  throw new Error('Failed to execute fetch');
}

async function fetchWithRetry(tabId, url, options) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetchInPageContext(tabId, url, options);
      log(url.replace(/\/api\/organizations\/[^/]+/, '/api/organizations/:orgId'), res.status);
      if (res.status === 429) {
        const delay = RATE_LIMIT_BACKOFF_MS[Math.min(attempt, RATE_LIMIT_BACKOFF_MS.length - 1)];
        log('rate limited, retrying in', delay, 'ms');
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (!res.ok) {
        const bodyStr = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        log('API error', res.status, url, bodyStr?.slice(0, 200));
      }
      return res;
    } catch (e) {
      lastError = e;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS[attempt]));
      }
    }
  }
  throw lastError;
}

async function getOrgIds(tabId) {
  const buildFetchOptions = claudeProvider.buildFetchOptions;
  const { url, options } = buildFetchOptions.getOrganizations();
  const res = await fetchWithRetry(tabId, url, options);
  if (!res.ok) {
    const bodyStr = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '');
    log('getOrgIds failed', res.status, bodyStr?.slice(0, 200));
    if (res.status === 401) throw new Error('Please log in to Claude');
    throw new Error(`Organizations API error: ${res.status} — ${bodyStr?.slice(0, 100) || ''}`);
  }
  const data = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
  const orgs = data.organization ?? data.organizations ?? data;
  const list = Array.isArray(orgs) ? orgs : (orgs ? [orgs] : Array.isArray(data) ? data : []);
  const ids = list.map((o) => o?.uuid ?? o?.id).filter(Boolean);
  if (ids.length === 0) throw new Error('No organizations found. Ensure you are logged in.');
  return ids;
}

async function getOrgIdWithChatAccess(tabId, fetchOptsBuilder) {
  const orgIds = await getOrgIds(tabId);
  const { [STORAGE_KEYS.CACHED_ORG_ID]: cached } = await chrome.storage.local.get(STORAGE_KEYS.CACHED_ORG_ID);
  const ordered = cached && orgIds.includes(cached)
    ? [cached, ...orgIds.filter((id) => id !== cached)]
    : orgIds;
  for (const orgId of ordered) {
    const { url, options } = fetchOptsBuilder.getChats(orgId, 0);
    const res = await fetchWithRetry(tabId, url, options);
    if (res.ok) {
      await chrome.storage.local.set({ [STORAGE_KEYS.CACHED_ORG_ID]: orgId });
      log('Using org', orgId);
      return orgId;
    }
    if (orgId === cached) {
      await chrome.storage.local.remove(STORAGE_KEYS.CACHED_ORG_ID);
    }
    log('Org', orgId, 'returned', res.status, '- trying next');
  }
  throw new Error('No organization with chat access. Try switching org in Claude.ai and run again.');
}

async function loadChats(tabId, orgId, fetchOptsBuilder, opts = {}) {
  const { maxEligible, cutoff, ignoreStarred } = opts;
  const limit = CHAT_PAGE_LIMIT;
  const allChats = [];
  let offset = 0;
  let continuePaging = true;
  while (continuePaging) {
    const { url, options } = fetchOptsBuilder.getChats(orgId, offset, limit);
    const res = await fetchWithRetry(tabId, url, options);
    if (!res.ok) {
      const bodyStr = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '');
      const hint = bodyStr?.slice(0, 150) || '';
      throw new Error(`Failed to load chats: ${res.status} ${hint ? `(${hint})` : ''} — ${url}`);
    }
    const parsed = parseChatsResponse(res.body, limit);
    allChats.push(...parsed.chats);
    if (maxEligible != null && cutoff != null) {
      const eligible = allChats.filter((c) => {
        if (c.createdAt <= 0 || c.createdAt >= cutoff) return false;
        if (ignoreStarred && c.starred) return false;
        return true;
      });
      if (eligible.length >= maxEligible) return allChats;
    }
    if (parsed.hasMore) {
      offset += limit;
      await new Promise((r) => setTimeout(r, PAGINATION_DELAY_MS));
    } else {
      continuePaging = false;
    }
  }
  return allChats;
}

async function loadChatsForDebug() {
  const tabId = await ensureClaudeTab();
  const fetchOptsBuilder = claudeProvider.buildFetchOptions;
  const orgId = await getOrgIdWithChatAccess(tabId, fetchOptsBuilder);
  const limit = CHAT_PAGE_LIMIT;
  const allChats = [];
  const debugLog = [];
  let offset = 0;
  let pageNum = 0;
  let continuePaging = true;
  while (continuePaging) {
    pageNum++;
    const { url, options } = fetchOptsBuilder.getChats(orgId, offset, limit);
    const res = await fetchWithRetry(tabId, url, options);
    if (!res.ok) throw new Error(`Failed to load chats: ${res.status}`);
    const { chats, hasMore, nextCursor } = getChatsWithRawDates(res.body, limit);
    let body = res.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = body?.slice(0, 200); }
    }
    const isArray = Array.isArray(body);
    const topKeys = !isArray && body && typeof body === 'object' ? Object.keys(body) : null;
    debugLog.push({
      page: pageNum,
      url,
      offset,
      requestedLimit: limit,
      responseLength: chats.length,
      hasMore,
      nextCursor: nextCursor || null,
      responseIsArray: isArray,
      responseTopLevelKeys: topKeys
    });
    allChats.push(...chats);
    if (hasMore && chats.length >= 50) {
      offset += limit;
      await new Promise((r) => setTimeout(r, PAGINATION_DELAY_MS));
    } else {
      continuePaging = false;
    }
  }
  return { chats: allChats, debugLog };
}

async function deleteChats(tabId, orgId, ids, fetchOptsBuilder) {
  const total = ids.length;
  let deleted = 0;
  await chrome.storage.local.set({
    [STORAGE_KEYS.DELETION_PROGRESS]: { current: 0, total, deleted: 0 }
  });
  for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
    const batch = ids.slice(i, i + DELETE_BATCH_SIZE);
    try {
      const { url, options } = fetchOptsBuilder.deleteChats(orgId, batch);
      const res = await fetchWithRetry(tabId, url, options);
      if (res.ok && res.body?.deleted) {
        deleted += res.body.deleted.length;
      }
    } catch {
      // Skip failed batch
    }
    const processed = Math.min(i + DELETE_BATCH_SIZE, ids.length);
    await chrome.storage.local.set({
      [STORAGE_KEYS.DELETION_PROGRESS]: { current: processed, total, deleted }
    });
    if (i + DELETE_BATCH_SIZE < ids.length) {
      await new Promise((r) => setTimeout(r, DELETE_BATCH_DELAY_MS));
    }
  }
  await chrome.storage.local.remove(STORAGE_KEYS.DELETION_PROGRESS);
  return deleted;
}

async function ensureClaudeTab({ autoOpen = false } = {}) {
  const tabs = await chrome.tabs.query({ url: `${CLAUDE_URL}/*` });
  if (tabs.length > 0) return tabs[0].id;
  if (autoOpen) {
    const tab = await chrome.tabs.create({ url: CLAUDE_URL, active: false });
    await new Promise((r) => setTimeout(r, 4000));
    return tab.id;
  }
  throw new Error(
    'No Claude tab is open. Open claude.ai in a tab, sign in if asked, leave it open, then try again.'
  );
}

/**
 * The tab captured when the scan ran may be closed or navigated away before the user confirms.
 * MAIN-world fetch must run in a live claude.ai tab — resolve a current one, falling back from the hint.
 */
async function resolveClaudeTabForDeletion(preferredTabId) {
  if (preferredTabId != null) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      const u = tab?.url ?? '';
      if (u.startsWith(CLAUDE_URL)) return preferredTabId;
    } catch {
      // Tab closed or id invalid — fall through
    }
  }
  return ensureClaudeTab();
}

async function runDeletionFlow(settings, options = {}) {
  const daysThreshold = resolveRunDaysThreshold(settings, options);
  const cutoff = deletionCutoffMs(daysThreshold);

  const tabId = await ensureClaudeTab();
  const fetchOptsBuilder = claudeProvider.buildFetchOptions;

  const orgId = await getOrgIdWithChatAccess(tabId, fetchOptsBuilder);

  const ignoreStarred = settings.ignoreStarred !== false;
  const loadOpts = options.maxDelete != null
    ? { maxEligible: options.maxDelete, cutoff, ignoreStarred }
    : { ignoreStarred };
  const allChats = await loadChats(tabId, orgId, fetchOptsBuilder, loadOpts);
  let toDelete = allChats.filter((c) => {
    if (c.createdAt <= 0 || c.createdAt >= cutoff) return false;
    if (ignoreStarred && c.starred) return false;
    return true;
  });
  if (options.maxDelete != null) {
    toDelete = toDelete.slice(0, options.maxDelete);
  }

  return {
    count: toDelete.length,
    chatIds: toDelete.map((c) => c.id),
    chats: toDelete.map((c) => ({
      id: c.id,
      name: c.name,
      lastEditAt: typeof c.createdAt === 'number' && c.createdAt > 0 ? c.createdAt : null
    })),
    tabId
  };
}

async function executeDeletion(tabId, chatIds) {
  const resolvedTabId = await resolveClaudeTabForDeletion(tabId);
  const fetchOptsBuilder = claudeProvider.buildFetchOptions;
  const orgId = await getOrgIdWithChatAccess(resolvedTabId, fetchOptsBuilder);
  const deleted = await deleteChats(resolvedTabId, orgId, chatIds, fetchOptsBuilder);
  const settings = await getSettings();
  if (settings.recordActivity !== false) {
    await addActivityEntry(deleted);
  }
  await setLastRun({ deleted, timestamp: Date.now() });
  try {
    await chrome.tabs.sendMessage(resolvedTabId, { type: 'SHOW_RECENT_DELETE', count: deleted });
  } catch {
    // Content script may not be loaded
  }
  return deleted;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'RUN_NOW') {
    (async () => {
      try {
        const settings = await getSettings();
        const { count, chatIds, chats, tabId } = await runDeletionFlow(settings, msg.options || {});

        if (count === 0) {
          await clearPendingConfirm();
          await setLastRun({ deleted: 0, timestamp: Date.now() });
          return { deleted: 0 };
        }

        return { requiresConfirm: true, count, chatIds, chats, tabId };
      } catch (err) {
        log('RUN_NOW error', err);
        return { error: err.message };
      }
    })().then(sendResponse);
    return true;
  }

  if (msg.type === 'TEST_ALARM') {
    if (!DEBUG) {
      sendResponse({ error: 'Scheduled scan simulation is only available in development builds.' });
      return;
    }
    (async () => {
      try {
        const settings = await getSettings();
        const enabled = settings.enabledSites ?? { claude: true };
        if (!enabled.claude) return { error: 'Claude is disabled for automatic runs. Enable it in settings.' };
        const { count, chatIds, chats, tabId } = await runDeletionFlow(settings);
        if (count === 0) {
          await clearPendingConfirm();
          await setLastRun({ deleted: 0, timestamp: Date.now() });
          return { deleted: 0 };
        }
        if (settings.autoConfirm) {
          const deleted = await executeDeletion(tabId, chatIds);
          return { deleted };
        }
        await setPendingConfirm({
          count,
          chatIds,
          chats,
          tabId,
          timestamp: Date.now()
        });
        setBadge(count);
        notifyPending(count);
        return { pendingConfirm: count };
      } catch (err) {
        log('TEST_ALARM error', err);
        return { error: err.message };
      }
    })().then(sendResponse);
    return true;
  }

  if (msg.type === 'DEBUG_CHAT_DATES') {
    if (!DEBUG) return sendResponse({ error: 'DEBUG is disabled' });
    (async () => {
      try {
        const { chats, debugLog } = await loadChatsForDebug();
        return { chats, debugLog };
      } catch (err) {
        log('DEBUG_CHAT_DATES error', err);
        return { error: err.message };
      }
    })().then(sendResponse);
    return true;
  }

  if (msg.type === 'INTEGRATION_TEST') {
    if (!DEBUG || chrome.runtime.getManifest().update_url) {
      return sendResponse({ error: 'Integration tests are only available in dev mode' });
    }
    (async () => {
      try {
        const tabId = await ensureClaudeTab({ autoOpen: true });
        const fetchOptsBuilder = claudeProvider.buildFetchOptions;
        const orgId = await getOrgIdWithChatAccess(tabId, fetchOptsBuilder);
        const { url, options } = fetchOptsBuilder.getChats(orgId, 0, 100);
        const res = await fetchWithRetry(tabId, url, options);
        if (!res.ok) throw new Error(`Failed to load chats: ${res.status}`);
        const { chats } = parseChatsResponse(res.body, 100);
        if (chats.length === 0) return { error: 'No chats found to test with.' };
        const oldest = chats.reduce((a, b) =>
          (a.createdAt > 0 && (b.createdAt <= 0 || a.createdAt < b.createdAt)) ? a : b
        );
        if (!oldest?.id) return { error: 'Could not identify a chat to delete.' };
        if (msg.dryRun) {
          return { dryRun: true, chat: { id: oldest.id, name: oldest.name, createdAt: oldest.createdAt } };
        }
        const deleted = await deleteChats(tabId, orgId, [oldest.id], fetchOptsBuilder);
        const settings = await getSettings();
        if (settings.recordActivity !== false) {
          await addActivityEntry(deleted);
        }
        await setLastRun({ deleted, timestamp: Date.now() });
        try {
          await chrome.tabs.sendMessage(tabId, { type: 'SHOW_RECENT_DELETE', count: deleted });
        } catch {
          // Content script may not be loaded
        }
        return { deleted, chat: { id: oldest.id, name: oldest.name, createdAt: oldest.createdAt } };
      } catch (err) {
        log('INTEGRATION_TEST error', err);
        return { error: err.message };
      }
    })().then(sendResponse);
    return true;
  }

  if (msg.type === 'OPEN_OPTIONS') {
    (async () => {
      const raw = msg.hash != null ? String(msg.hash) : '';
      const hash = raw.replace(/^#/, '');
      if (hash) {
        await chrome.storage.local.set({ [STORAGE_KEYS.OPTIONS_PENDING_HASH]: hash });
      }
      chrome.runtime.openOptionsPage();
    })();
    return;
  }

  if (msg.type === 'CONFIRM_DELETE') {
    (async () => {
      try {
        const { tabId, chatIds } = msg;
        const deleted = await executeDeletion(tabId, chatIds);
        await clearPendingConfirm();
        setBadge(0);
        return { deleted };
      } catch (err) {
        log('CONFIRM_DELETE error', err);
        return { error: err.message };
      }
    })().then(sendResponse);
    return true;
  }
});

getSettings().then((s) => syncAlarmFromSettings(s));

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const url = chrome.runtime.getURL(ONBOARDING_PAGE);
    chrome.tabs.create({ url, active: true });
  }
  if (details.reason === 'update') {
    const { [STORAGE_KEYS.SETTINGS]: stored } = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    if (stored && typeof stored === 'object' && Object.keys(stored).length > 0) {
      await chrome.storage.local.set({ [STORAGE_KEYS.ONBOARDING_COMPLETE]: true });
    }
  }
  const settings = await getSettings();
  syncAlarmFromSettings(settings);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const settings = await getSettings();
  const freq = RUN_FREQUENCIES[settings.runFrequency];
  if (!freq?.minutes) return;
  const enabled = settings.enabledSites ?? { claude: true };
  if (!enabled.claude) return;
  const { last_run, pending_confirm } = await chrome.storage.local.get([STORAGE_KEYS.LAST_RUN, STORAGE_KEYS.PENDING_CONFIRM]);
  if (
    pending_confirm?.count &&
    pending_confirm?.snoozedUntil &&
    Date.now() < pending_confirm.snoozedUntil
  ) {
    return;
  }
  const last = Math.max(last_run?.timestamp ?? 0, pending_confirm?.timestamp ?? 0);
  if (Date.now() - last < freq.minutes * 60 * 1000) return;
  try {
        const { count, chatIds, chats, tabId } = await runDeletionFlow(settings);
        if (count === 0) {
          await clearPendingConfirm();
          await setLastRun({ deleted: 0, timestamp: Date.now() });
          return;
        }
        if (settings.autoConfirm) {
          const deleted = await executeDeletion(tabId, chatIds);
          log('Auto-delete completed:', deleted, 'chats');
        } else {
          await setPendingConfirm({
            count,
            chatIds,
            chats,
            tabId,
            timestamp: Date.now()
          });
          setBadge(count);
          notifyPending(count);
        }
  } catch (err) {
    log('Auto-delete failed:', err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const { pending_confirm } = await chrome.storage.local.get(STORAGE_KEYS.PENDING_CONFIRM);
  setBadge(badgeCountForPending(pending_confirm));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.PENDING_CONFIRM]) {
    const next = changes[STORAGE_KEYS.PENDING_CONFIRM]?.newValue;
    setBadge(badgeCountForPending(next));
  }
});

chrome.storage.local.get(STORAGE_KEYS.PENDING_CONFIRM).then(({ pending_confirm }) => {
  setBadge(badgeCountForPending(pending_confirm));
});

/**
 * Ask the Claude tab to show/pin the top bar.
 *
 * Strategy (avoids a rapid-fire retry loop that spams the console):
 *  1. Try once immediately — succeeds when the content script is already live.
 *  2. If that fails, wait for the tab's `status === 'complete'` event (covers hard
 *     refresh / in-flight navigation) then retry a handful of times with a short
 *     back-off to let the content script finish initialising.
 *  3. Time-box the whole thing so we never hang indefinitely.
 *
 * We do not use executeScript(top-bar.js) as a fallback: that file is an ES module
 * (import …) and programmatic file injection runs as a classic script, so it fails to parse.
 */
async function showTopBarOnClaudeTab(tabId) {
  if (tabId == null) return false;

  async function trySend() {
    log('sendMessage REFRESH_STATE to tab', tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'REFRESH_STATE' });
    log('sendMessage ok');
    return true;
  }

  // 1. Try immediately — works when the CS is already live.
  try {
    return await trySend();
  } catch {
    log('sendMessage: content script not ready, waiting for tab to finish loading');
  }

  // 2. Wait for the tab to reach status=complete (e.g. after hard refresh),
  //    then retry a few times with a short delay to let the CS initialise.
  const POST_LOAD_RETRIES = 5;
  const POST_LOAD_DELAY_MS = 400;
  const LOAD_WAIT_TIMEOUT_MS = 15000;

  return new Promise((resolve) => {
    const giveUp = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      log('showTopBarOnClaudeTab: timed out waiting for tab');
      resolve(false);
    }, LOAD_WAIT_TIMEOUT_MS);

    async function onUpdated(updatedId, info) {
      if (updatedId !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(giveUp);

      for (let i = 0; i < POST_LOAD_RETRIES; i++) {
        await new Promise((r) => setTimeout(r, POST_LOAD_DELAY_MS));
        try {
          resolve(await trySend());
          return;
        } catch (e) {
          log('sendMessage retry', i + 1, e?.message);
        }
      }
      log('showTopBarOnClaudeTab: content script did not respond after tab load');
      resolve(false);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: `${CLAUDE_URL}/*` });
  let tabId;
  if (tabs.length === 0) {
    const tab = await chrome.tabs.create({ url: CLAUDE_URL, active: true });
    tabId = tab.id;
  } else {
    tabId = tabs[0].id;
    await chrome.tabs.update(tabId, { active: true });
  }
  await showTopBarOnClaudeTab(tabId);
});
