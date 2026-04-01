import { getSettings, saveSettings, getActivityHistory, clearActivityHistory, setOnboardingComplete, getPendingConfirm } from '../shared/storage.js';
import { DEBUG, DEFAULT_ENABLED_SITES, STORAGE_KEYS } from '../shared/constants.js';
import { syncAlarmFromSettings } from '../shared/alarms.js';
import { mountRunFrequencyFieldset, getSelectedRunFrequency } from '../shared/run-frequency-fieldset.js';
import { PROVIDER_LIST } from '../providers/registry.js';
import { openPendingDeletionModal } from '../shared/pending-deletion-modal.js';

const AUTOSAVE_DEBOUNCE_MS = 450;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

let suppressAutosave = false;
let autosaveDebounceTimer = null;
let saveInFlight = false;
let saveAgainAfter = false;

async function onViewApprovePendingClick() {
  const pend = await getPendingConfirm();
  if (!pend?.count) return;
  if (pend.snoozedUntil && Date.now() < pend.snoozedUntil) return;
  openPendingDeletionModal(pend, {
    onError: (msg) => setStatus(msg, 'error'),
    afterSnooze: async () => {
      await refreshPendingAndConfirm();
      setStatus('Snoozed for 1 day', 'success');
    },
    afterConfirmSuccess: async (result) => {
      setStatus(`Deleted ${result?.deleted ?? 0} chat(s)`, 'success');
      await loadHistory();
      await refreshPendingAndConfirm();
    }
  });
}

async function loadSettings() {
  suppressAutosave = true;
  try {
    const settings = await getSettings();
    document.getElementById('daysThreshold').value = settings.daysThreshold;
    mountRunFrequencyFieldset(document.getElementById('runFrequencyMount'), {
      inputName: 'runFrequency',
      selectedValue: settings.runFrequency,
      fieldsetClass: 'space-y-2 border-0 p-0 m-0',
      labelExtraClass: 'bg-slate-50/50'
    });
    document.getElementById('promptConfirm').checked = !settings.autoConfirm;
    document.getElementById('ignoreStarred').checked = settings.ignoreStarred !== false;
    document.getElementById('recordActivity').checked = settings.recordActivity !== false;
    document.getElementById('showDeletedCountAfterRun').checked = settings.showDeletedCountAfterRun !== false;
    const enabled = { ...DEFAULT_ENABLED_SITES, ...settings.enabledSites };
    const activeProviders = PROVIDER_LIST.filter((p) => p.disabled !== true);
    const listEl = document.getElementById('sitesList');
    listEl.innerHTML = PROVIDER_LIST.map((p) => {
      const isDisabled = p.disabled === true;
      const checked = !isDisabled && enabled[p.id] !== false;
      const badge = p.badge ? `<span class="ml-auto px-2 py-0.5 text-xs font-medium rounded-full bg-slate-200 dark:bg-slate-600 text-slate-500 dark:text-slate-400">${escapeHtml(p.badge)}</span>` : '';
      return `
    <div class="flex items-center gap-3 ${isDisabled ? 'opacity-60' : ''}">
      <input type="checkbox" id="site-${p.id}" data-site="${p.id}"
        class="w-4 h-4 rounded border-slate-300 dark:border-slate-500 text-teal-500 focus:ring-teal-500 disabled:cursor-not-allowed"
        ${checked ? 'checked' : ''} ${isDisabled ? 'disabled' : ''}>
      <label for="site-${p.id}" class="flex-1 text-sm text-slate-700 dark:text-slate-300 ${isDisabled ? 'cursor-not-allowed' : ''}">${escapeHtml(p.displayName)} (${escapeHtml(p.domain)})</label>
      ${badge}
    </div>
  `;
    }).join('');
    const sitesSection = document.getElementById('sitesSection');
    if (sitesSection) sitesSection.classList.toggle('hidden', activeProviders.length <= 1);
  } finally {
    suppressAutosave = false;
  }
}

function collectSettingsFromForm() {
  const sitesSection = document.getElementById('sitesSection');
  const enabledSites = {};
  if (sitesSection && !sitesSection.classList.contains('hidden')) {
    document.querySelectorAll('#sitesList input[data-site]').forEach((cb) => {
      enabledSites[cb.dataset.site] = cb.checked;
    });
  } else {
    const activeProviders = PROVIDER_LIST.filter((p) => p.disabled !== true);
    activeProviders.forEach((p) => { enabledSites[p.id] = true; });
  }
  return {
    daysThreshold: parseInt(document.getElementById('daysThreshold').value, 10) || 30,
    runFrequency: getSelectedRunFrequency('runFrequency'),
    autoConfirm: !document.getElementById('promptConfirm').checked,
    ignoreStarred: document.getElementById('ignoreStarred').checked,
    recordActivity: document.getElementById('recordActivity').checked,
    showDeletedCountAfterRun: document.getElementById('showDeletedCountAfterRun').checked,
    enabledSites
  };
}

async function persistSettings(settings) {
  await saveSettings(settings);
  syncAlarmFromSettings(settings);
  if (!settings.recordActivity) {
    await clearActivityHistory();
  }
  await loadHistory();
  await setOnboardingComplete(true);
}

function updateAutosaveUi(state) {
  const msg = document.getElementById('autosaveMessage');
  const icon = document.getElementById('autosaveIcon');
  const btn = document.getElementById('saveNow');
  if (!msg || !icon || !btn) return;
  icon.classList.add('hidden');
  const base = 'text-sm leading-snug ';
  if (state === 'pending') {
    msg.className = base + 'text-amber-800 dark:text-amber-200 font-medium';
    msg.textContent = 'Unsaved changes…';
    btn.disabled = false;
  } else if (state === 'saving') {
    msg.className = base + 'text-slate-600 dark:text-slate-400';
    msg.textContent = 'Saving…';
    btn.disabled = true;
  } else if (state === 'saved') {
    msg.className = base + 'text-emerald-700 dark:text-emerald-300';
    icon.classList.remove('hidden');
    const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    msg.textContent = `All changes saved · ${t}`;
    btn.disabled = false;
  } else if (state === 'error') {
    msg.className = base + 'text-rose-700 dark:text-rose-300 font-medium';
    msg.textContent = 'Couldn\'t save. Check your connection or click Save now.';
    btn.disabled = false;
  } else {
    msg.className = base + 'text-slate-600 dark:text-slate-300';
    msg.textContent = 'Changes save automatically.';
    btn.disabled = false;
  }
}

function scheduleAutosave() {
  if (suppressAutosave) return;
  updateAutosaveUi('pending');
  if (autosaveDebounceTimer != null) clearTimeout(autosaveDebounceTimer);
  autosaveDebounceTimer = setTimeout(() => {
    autosaveDebounceTimer = null;
    void performPersist();
  }, AUTOSAVE_DEBOUNCE_MS);
}

async function performPersist() {
  if (saveInFlight) {
    saveAgainAfter = true;
    return;
  }
  saveInFlight = true;
  updateAutosaveUi('saving');
  setStatus('');
  try {
    await persistSettings(collectSettingsFromForm());
    updateAutosaveUi('saved');
  } catch {
    updateAutosaveUi('error');
    setStatus('Failed to save', 'error');
  } finally {
    saveInFlight = false;
    if (saveAgainAfter) {
      saveAgainAfter = false;
      void performPersist();
    }
  }
}

function saveNow() {
  if (autosaveDebounceTimer != null) {
    clearTimeout(autosaveDebounceTimer);
    autosaveDebounceTimer = null;
  }
  void performPersist();
}

function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'text-sm ' + (type === 'error' ? 'text-rose-600 dark:text-rose-400' : type === 'success' ? 'text-emerald-600 dark:text-emerald-400' : type === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-600 dark:text-slate-400');
  if (msg) setTimeout(() => { el.textContent = ''; }, 5000);
}

async function loadHistory() {
  const raw = await getActivityHistory();
  const filtered = raw.filter((h) => h.deletedCount > 0);
  const tbody = document.getElementById('historyBody');
  const table = document.getElementById('historyTable');
  const noHistory = document.getElementById('noHistory');
  tbody.innerHTML = '';
  if (filtered.length === 0) {
    table.classList.add('hidden');
    noHistory.classList.remove('hidden');
    return;
  }
  table.classList.remove('hidden');
  noHistory.classList.add('hidden');
  filtered.forEach((entry) => {
    const d = new Date(entry.timestamp);
    const row = tbody.insertRow();
    row.className = 'hover:bg-slate-50 dark:hover:bg-slate-700/50 transition';
    const cells = [row.insertCell(0), row.insertCell(1), row.insertCell(2)];
    cells.forEach((c) => { c.className = 'px-6 py-3 text-sm text-slate-600 dark:text-slate-400'; });
    cells[0].textContent = d.toLocaleDateString();
    cells[1].textContent = d.toLocaleTimeString();
    cells[2].textContent = entry.deletedCount;
  });
}

function formatAutoDeleteIn(updatedAt, daysThreshold) {
  if (!updatedAt) return '—';
  const now = Date.now();
  const ts = new Date(updatedAt).getTime();
  const oneDay = 24 * 60 * 60 * 1000;
  const msUntilEligible = (ts + daysThreshold * oneDay) - now;
  if (msUntilEligible <= 0) return 'eligible now';
  const days = Math.floor(msUntilEligible / oneDay);
  const hours = Math.floor((msUntilEligible % oneDay) / (60 * 60 * 1000));
  if (days >= 30) return `in ${Math.floor(days / 30)} mo`;
  if (days >= 1) return hours > 0 ? `in ${days}d ${hours}h` : `in ${days} day${days === 1 ? '' : 's'}`;
  if (hours >= 1) return `in ${hours} hr`;
  const mins = Math.floor((msUntilEligible % (60 * 60 * 1000)) / 60000);
  return mins > 0 ? `in ${mins} min` : 'in < 1 min';
}

async function showDebugChatDates() {
  const btn = document.getElementById('debugChatDates');
  const output = document.getElementById('debugOutput');
  const tbody = document.getElementById('debugBody');
  const noChats = document.getElementById('debugNoChats');
  btn.disabled = true;
  btn.textContent = 'Loading...';
  output.classList.add('hidden');
  tbody.innerHTML = '';
  noChats.classList.add('hidden');
  setStatus('');
  try {
    const [result, settings] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'DEBUG_CHAT_DATES' }),
      getSettings()
    ]);
    if (result === undefined) {
      const msg = 'No response from background — try reloading the extension (chrome://extensions → refresh) and ensure a claude.ai tab is open.';
      setStatus(msg, 'error');
      noChats.textContent = msg;
      noChats.classList.remove('hidden');
      output.classList.remove('hidden');
      return;
    }
    if (result?.error) {
      setStatus(result.error, 'error');
      noChats.textContent = `Error: ${result.error} — Open claude.ai and ensure you're logged in.`;
      noChats.classList.remove('hidden');
      output.classList.remove('hidden');
      return;
    }
    const chats = result.chats ?? [];
    const debugLog = result.debugLog ?? [];
    const daysThreshold = settings.daysThreshold || 30;

    const debugLogEl = document.getElementById('debugLogPre');
    const debugDetailsEl = document.getElementById('debugLogDetails');
    if (debugLog.length > 0) {
      const summary = `Total: ${chats.length} chats from ${debugLog.length} page(s)\n\n`;
      const logText = summary + debugLog.map((d) => JSON.stringify(d, null, 2)).join('\n\n');
      debugLogEl.textContent = logText;
      debugDetailsEl.classList.remove('hidden');
      debugDetailsEl.open = true;
      console.log('[AutoDelete] Pagination debug:', debugLog);
    } else {
      debugDetailsEl.classList.add('hidden');
    }

    if (chats.length === 0) {
      noChats.classList.remove('hidden');
    } else {
      chats.forEach((c) => {
        const updated = c.updated_at ?? c.updatedAt ?? c.dateUsed;
        const row = tbody.insertRow();
        row.className = 'hover:bg-amber-50/50 dark:hover:bg-amber-900/30 transition';
        const cells = [row.insertCell(0), row.insertCell(1), row.insertCell(2)];
        cells.forEach((cell) => { cell.className = 'px-4 py-2 text-sm text-slate-600 dark:text-slate-400'; });
        const nameCell = cells[0];
        nameCell.textContent = c.name || '(unnamed)';
        if (c.starred) {
          const star = document.createElement('span');
          star.className = 'ml-1 text-amber-500';
          star.title = 'Starred';
          star.textContent = '★';
          nameCell.appendChild(star);
        }
        cells[1].textContent = updated ? new Date(updated).toLocaleDateString() : '—';
        const ignoreStarred = settings.ignoreStarred !== false;
        cells[2].textContent = (c.starred && ignoreStarred) ? '—' : formatAutoDeleteIn(updated, daysThreshold);
      });
    }
    output.classList.remove('hidden');
  } catch (err) {
    const msg = err?.message || String(err) || 'Failed';
    setStatus(msg, 'error');
    noChats.textContent = `Error: ${msg} — Open claude.ai and ensure you're logged in.`;
    noChats.classList.remove('hidden');
    output.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Show chat dates';
  }
}

async function refreshPendingAndConfirm() {
  const pending = await getPendingConfirm();
  const pendingSection = document.getElementById('pendingSection');
  const pendingCount = document.getElementById('pendingCount');
  const snoozed = pending?.snoozedUntil && Date.now() < pending.snoozedUntil;
  if (pending?.count && !snoozed) {
    pendingSection.classList.remove('hidden');
    pendingCount.textContent = pending.count;
  } else {
    pendingSection.classList.add('hidden');
  }
}

document.getElementById('saveNow').addEventListener('click', saveNow);
document.getElementById('viewApprovePending').addEventListener('click', onViewApprovePendingClick);

const settingsMain = document.querySelector('main');
function onSettingsUserEdit() {
  if (suppressAutosave) return;
  scheduleAutosave();
}
settingsMain?.addEventListener('input', onSettingsUserEdit);
settingsMain?.addEventListener('change', onSettingsUserEdit);

window.addEventListener('beforeunload', (e) => {
  if (autosaveDebounceTimer != null || saveInFlight) {
    e.preventDefault();
    e.returnValue = '';
  }
});
document.getElementById('clearActivity').addEventListener('click', async () => {
  await clearActivityHistory();
  await loadHistory();
  setStatus('Activity cleared', 'success');
});

async function runIntegrationTest(dryRun) {
  const dryRunBtn = document.getElementById('integrationDryRun');
  const runBtn = document.getElementById('integrationRun');
  const resultEl = document.getElementById('integrationResult');
  dryRunBtn.disabled = true;
  runBtn.disabled = true;
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = `<p class="text-slate-500">${dryRun ? 'Finding oldest chat...' : 'Finding and deleting oldest chat...'}</p>`;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'INTEGRATION_TEST', dryRun });
    if (result === undefined) {
      resultEl.innerHTML = '<p class="text-rose-600 dark:text-rose-400">No response — reload extension and ensure claude.ai is open.</p>';
      return;
    }
    if (result?.error) {
      resultEl.innerHTML = `<p class="text-rose-600 dark:text-rose-400">Error: ${escapeHtml(result.error)}</p>`;
      return;
    }
    const chat = result.chat;
    const date = chat?.createdAt ? new Date(chat.createdAt).toLocaleString() : '—';
    const name = chat?.name || '(unnamed)';
    if (dryRun) {
      resultEl.innerHTML = [
        '<p class="font-medium text-emerald-700 dark:text-emerald-300">Dry run complete — no chat deleted</p>',
        `<p><strong>Oldest chat:</strong> ${escapeHtml(name)}</p>`,
        `<p><strong>Last activity:</strong> ${escapeHtml(date)}</p>`,
        `<p class="text-xs text-slate-400">ID: ${escapeHtml(chat?.id ?? '—')}</p>`
      ].join('');
    } else {
      resultEl.innerHTML = [
        `<p class="font-medium text-emerald-700 dark:text-emerald-300">Deleted ${result.deleted ?? 0} chat(s)</p>`,
        `<p><strong>Chat:</strong> ${escapeHtml(name)}</p>`,
        `<p><strong>Last activity:</strong> ${escapeHtml(date)}</p>`,
        `<p class="text-xs text-slate-400">ID: ${escapeHtml(chat?.id ?? '—')}</p>`
      ].join('');
      await loadHistory();
    }
  } catch (err) {
    resultEl.innerHTML = `<p class="text-rose-600 dark:text-rose-400">${escapeHtml(err?.message || 'Failed')}</p>`;
  } finally {
    dryRunBtn.disabled = false;
    runBtn.disabled = false;
  }
}

async function devSimulateScheduledScan() {
  const btn = document.getElementById('devSimulateScheduledScan');
  const statusEl = document.getElementById('devSimulateScheduledScanStatus');
  if (!btn || !statusEl) return;
  btn.disabled = true;
  statusEl.classList.remove('hidden');
  statusEl.textContent = 'Running…';
  statusEl.className = 'text-xs text-orange-900 dark:text-orange-200';
  setStatus('');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'TEST_ALARM' });
    if (result === undefined) {
      statusEl.textContent = 'No response — reload the extension and try again.';
      statusEl.classList.add('text-orange-800', 'dark:text-orange-100');
      return;
    }
    if (result?.error) {
      statusEl.textContent = result.error;
      statusEl.classList.add('text-orange-950', 'dark:text-orange-50');
      return;
    }
    if (result?.pendingConfirm != null) {
      statusEl.textContent =
        `${result.pendingConfirm} chat(s) pending confirmation — check the badge, notification, or “View & approve” at the top of settings.`;
      await refreshPendingAndConfirm();
      return;
    }
    if (result?.deleted != null) {
      statusEl.textContent =
        result.deleted > 0
          ? `Auto-deleted ${result.deleted} chat(s) (confirm-before-delete is off).`
          : 'No chats matched your threshold.';
      await loadHistory();
      await refreshPendingAndConfirm();
      return;
    }
    statusEl.textContent = 'Done.';
  } catch (err) {
    statusEl.textContent = err?.message || 'Failed';
  } finally {
    btn.disabled = false;
  }
}

if (DEBUG) {
  document.getElementById('debugSection').classList.remove('hidden');
  document.getElementById('devSimulateScheduledScan').addEventListener('click', devSimulateScheduledScan);
  document.getElementById('debugChatDates').addEventListener('click', showDebugChatDates);
  document.getElementById('integrationDryRun').addEventListener('click', () => runIntegrationTest(true));
  document.getElementById('integrationRun').addEventListener('click', () => runIntegrationTest(false));
}

async function applyPendingOptionsHash() {
  const { [STORAGE_KEYS.OPTIONS_PENDING_HASH]: hash } = await chrome.storage.local.get(STORAGE_KEYS.OPTIONS_PENDING_HASH);
  if (!hash) return;
  await chrome.storage.local.remove(STORAGE_KEYS.OPTIONS_PENDING_HASH);
  const el = document.getElementById(String(hash));
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.PENDING_CONFIRM]) {
    refreshPendingAndConfirm();
  }
});

updateAutosaveUi('idle');
loadSettings();
loadHistory();
refreshPendingAndConfirm();
applyPendingOptionsHash();
