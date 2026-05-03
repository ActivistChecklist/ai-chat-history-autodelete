/**
 * Loaded as a classic content script (no manifest "type": "module") so it works in
 * every Chromium build. ES module graph is loaded via dynamic import().
 */
if (window.__aichadTopBarLoaded) {
  window.__aichadTopBarRefresh?.();
} else {
  window.__aichadTopBarLoaded = true;
  window.__aichadTopBarRefresh = () => {};
  (async () => {
    const [
      {
        openPendingDeletionModal,
        closePendingDeletionModal,
        applySnoozeToPending
      },
      { insertBarAsFirstChildOfMainContent }
    ] = await Promise.all([
      import(chrome.runtime.getURL('src/shared/pending-deletion-modal.js')),
      import(chrome.runtime.getURL('src/shared/bar-insertion.js'))
    ]);

    (function () {
  'use strict';

  const STORAGE_KEYS = {
    SETTINGS: 'settings',
    DELETION_PROGRESS: 'deletion_progress',
    LAST_RUN: 'last_run',
    PENDING_CONFIRM: 'pending_confirm',
    TOP_BAR_DISMISSED_RUN: 'top_bar_dismissed_run',
    BAR_PINNED: 'aichad_bar_pinned'
  };

  const BAR_HEIGHT = 56;

  const SHOW_RECENT_MS = 5 * 60 * 1000;
  const SESSION_PENDING_BAR_DISMISS_KEY = 'aichad_pending_bar_dismissed';

  let wrapEl = null;
  let barEl = null;
  let reInjecting = false;
  let ensurePosTimer = null;

  function getMainContent() {
    return document.getElementById('main-content');
  }

  function getBarInsertionPoint() {
    const isChatPage = /^\/chat\//.test(window.location.pathname);
    if (isChatPage) {
      const header = document.querySelector('header[data-testid="page-header"]');
      if (header?.parentElement) {
        return { parent: header.parentElement, insertBefore: header };
      }
    }
    const main = getMainContent();
    if (main) return { parent: main, insertBefore: null };
    return null;
  }

  function isMainContentInsertion(pt) {
    return pt && !pt.insertBefore && pt.parent?.id === 'main-content';
  }

  function isBarInCorrectPosition() {
    if (!wrapEl?.parentElement) return false;
    const pt = getBarInsertionPoint();
    if (!pt) return true;
    if (pt.insertBefore) return wrapEl.nextElementSibling === pt.insertBefore;
    if (isMainContentInsertion(pt)) {
      return wrapEl.parentElement === pt.parent && wrapEl === pt.parent.firstElementChild;
    }
    return pt.parent.firstElementChild === wrapEl;
  }

  function ensureBarPosition() {
    if (!wrapEl) return;
    const pt = getBarInsertionPoint();
    if (!pt || isBarInCorrectPosition()) return;
    if (pt.insertBefore) {
      pt.parent.insertBefore(wrapEl, pt.insertBefore);
    } else if (isMainContentInsertion(pt) && pt.parent.firstElementChild !== wrapEl) {
      insertBarAsFirstChildOfMainContent(pt.parent, wrapEl);
    }
  }

  function openSettings() {
    try { chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }); } catch (_) {}
  }

  function openActivityHistory() {
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS', hash: 'activity-history' });
    } catch (_) {}
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  function getSessionPendingDismissed() {
    try {
      return sessionStorage.getItem(SESSION_PENDING_BAR_DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  }

  async function snoozePending() {
    const ok = await applySnoozeToPending();
    if (!ok) return;
    closePendingDeletionModal();
    if (barEl) barEl.classList.remove('aichad-top-bar--confirm');
    refreshState();
  }

  function openPendingChatsModal(pend) {
    openPendingDeletionModal(pend, {
      afterSnooze: async () => {
        if (barEl) barEl.classList.remove('aichad-top-bar--confirm');
        await refreshState();
      },
      afterConfirmSuccess: async () => {
        refreshState();
      },
      onError: (msg) => { alert(msg); }
    });
  }

  function dismissPendingBarSession() {
    try {
      sessionStorage.setItem(SESSION_PENDING_BAR_DISMISS_KEY, '1');
    } catch (_) {}
    if (barEl) barEl.classList.remove('aichad-top-bar--confirm');
    hideBar();
  }

  function wireTitleLink() {
    if (!barEl) return;
    const title = barEl.querySelector('.aichad-top-bar__title');
    if (title) {
      title.onclick = (e) => {
        e.preventDefault();
        openSettings();
      };
    }
  }

  /** Restore default brand row after pending-confirm layout (inline actions). */
  function resetBrandLayout() {
    if (!barEl) return;
    const brand = barEl.querySelector('.aichad-top-bar__brand');
    if (!brand) return;
    brand.classList.remove('aichad-top-bar__brand--pending');
    const BAR_TITLE = 'AI Chat History Auto-Delete';
    brand.innerHTML = `
      <a href="#" class="aichad-top-bar__title">${escapeHtml(BAR_TITLE)}</a>
      <span class="aichad-top-bar__sep">·</span>
      <span class="aichad-top-bar__text"></span>
    `;
    wireTitleLink();
  }

  function createBar() {
    if (barEl) return barEl;
    const pt = getBarInsertionPoint();
    if (!pt) return null;
    wrapEl = document.createElement('div');
    wrapEl.id = 'aichad-autodelete-top-bar-wrap';
    wrapEl.className = 'aichad-top-bar-wrap aichad-top-bar-wrap--hidden';
    wrapEl.style.height = '0';
    barEl = document.createElement('div');
    barEl.id = 'aichad-autodelete-top-bar';
    barEl.className = 'aichad-top-bar';
    barEl.setAttribute('aria-live', 'polite');
    const BAR_TITLE = 'AI Chat History Auto-Delete';
    barEl.innerHTML = `
      <div class="aichad-top-bar__content">
        <div class="aichad-top-bar__brand">
          <a href="#" class="aichad-top-bar__title">${escapeHtml(BAR_TITLE)}</a>
          <span class="aichad-top-bar__sep">·</span>
          <span class="aichad-top-bar__text"></span>
        </div>
        <div class="aichad-top-bar__progress-slot aichad-top-bar__progress-slot--empty"></div>
      </div>
      <div class="aichad-top-bar__actions">
        <button type="button" class="aichad-top-bar__btn aichad-top-bar__run-now">Run now</button>
        <button type="button" class="aichad-top-bar__btn aichad-top-bar__btn--outline aichad-top-bar__settings">Settings</button>
        <button type="button" class="aichad-top-bar__dismiss" aria-label="Dismiss">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    `;

    wireTitleLink();
    barEl.querySelector('.aichad-top-bar__settings').addEventListener('click', openSettings);
    barEl.querySelector('.aichad-top-bar__run-now').addEventListener('click', promptRunNowFromBar);

    barEl.querySelector('.aichad-top-bar__dismiss').addEventListener('click', () => {
      hideBar();
      try {
        chrome.storage.local.get(STORAGE_KEYS.LAST_RUN).then((result) => {
          try {
            const last = result[STORAGE_KEYS.LAST_RUN];
            if (last?.timestamp) {
              chrome.storage.local.set({ [STORAGE_KEYS.TOP_BAR_DISMISSED_RUN]: last.timestamp });
            }
          } catch (_) {}
        }).catch(() => {});
        chrome.storage.local.set({ [STORAGE_KEYS.BAR_PINNED]: false });
      } catch (_) {}
    });

    wrapEl.appendChild(barEl);
    if (pt.insertBefore) {
      pt.parent.insertBefore(wrapEl, pt.insertBefore);
    } else if (pt.parent?.id === 'main-content') {
      insertBarAsFirstChildOfMainContent(pt.parent, wrapEl);
    } else {
      pt.parent.prepend(wrapEl);
    }
    return barEl;
  }

  function updateFixedButtonOffsets() {
    const h = wrapEl && !wrapEl.classList.contains('aichad-top-bar-wrap--hidden')
      ? (barEl?.classList.contains('aichad-top-bar--progress') ? 72 : BAR_HEIGHT)
      : 0;
    requestAnimationFrame(() => {
      document.body.style.setProperty('--aichad-bar-offset', `${h}px`);
    });
  }

  function showBar() {
    ensureBarPosition();
    if (!createBar()) return;
    if (wrapEl) {
      wrapEl.classList.remove('aichad-top-bar-wrap--hidden');
      const h = barEl?.classList.contains('aichad-top-bar--progress') ? 72 : BAR_HEIGHT;
      wrapEl.style.height = `${h}px`;
      updateFixedButtonOffsets();
    }
  }

  function hideBar() {
    if (wrapEl) {
      wrapEl.classList.add('aichad-top-bar-wrap--hidden');
      wrapEl.style.height = '0';
    }
    updateFixedButtonOffsets();
  }

  function isBarWrapVisible() {
    return !!(wrapEl && !wrapEl.classList.contains('aichad-top-bar-wrap--hidden'));
  }

  /** Brief emphasis when user clicks the extension icon but the bar was already showing. */
  function pulseBarAttention() {
    if (!barEl || !isBarWrapVisible()) return;
    barEl.classList.remove('aichad-top-bar--attention-pulse');
    void barEl.offsetWidth;
    barEl.classList.add('aichad-top-bar--attention-pulse');
    barEl.addEventListener(
      'animationend',
      () => {
        barEl.classList.remove('aichad-top-bar--attention-pulse');
      },
      { once: true }
    );
  }

  function wireActivityHistoryLink() {
    if (!barEl) return;
    barEl.querySelectorAll('[data-aichad-open-activity]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        openActivityHistory();
      });
    });
  }

  function updateBarStatus(html) {
    const bar = createBar();
    if (!bar) return;
    const textEl = bar.querySelector('.aichad-top-bar__text');
    if (textEl) textEl.innerHTML = html;
    wireActivityHistoryLink();
    clearProgressSlot();
  }

  function clearProgressSlot() {
    if (!barEl) return;
    const slot = barEl.querySelector('.aichad-top-bar__progress-slot');
    if (slot) {
      slot.innerHTML = '';
      slot.classList.add('aichad-top-bar__progress-slot--empty');
    }
    barEl.classList.remove('aichad-top-bar--progress');
    barEl.classList.remove('aichad-top-bar--confirm');
    if (wrapEl && !wrapEl.classList.contains('aichad-top-bar-wrap--hidden')) {
      wrapEl.style.height = `${BAR_HEIGHT}px`;
      updateFixedButtonOffsets();
    }
  }

  function showProgress(current, total, deleted, roseProgress = false) {
    showBar();
    resetBrandLayout();
    const bar = createBar();
    if (!bar) return;
    if (roseProgress) bar.classList.add('aichad-top-bar--confirm');
    else bar.classList.remove('aichad-top-bar--confirm');
    bar.classList.add('aichad-top-bar--progress');
    const textEl = bar.querySelector('.aichad-top-bar__text');
    const slot = bar.querySelector('.aichad-top-bar__progress-slot');
    if (textEl) {
      textEl.innerHTML = `Deleting chats… ${deleted ?? current} / ${total} done`;
    }
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    if (slot) {
      slot.classList.remove('aichad-top-bar__progress-slot--empty');
      slot.innerHTML = `
        <div class="aichad-top-bar__progress-wrap">
          <div class="aichad-top-bar__progress-bar">
            <div class="aichad-top-bar__progress-fill" style="width: ${pct}%"></div>
          </div>
        </div>`;
    }
    if (wrapEl && !wrapEl.classList.contains('aichad-top-bar-wrap--hidden')) {
      wrapEl.style.height = '72px';
      updateFixedButtonOffsets();
    }
  }

  function formatLastRun(last) {
    if (!last?.timestamp) return 'Never run';
    const d = new Date(last.timestamp);
    const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const count = last.deleted ?? 0;
    if (count > 0) return `Last run ${date} ${time} — deleted ${count}`;
    return `Last run ${date} ${time} — nothing to delete`;
  }

  function buildLastRunWithLink(last) {
    const text = escapeHtml(formatLastRun(last));
    return `${text}<span class="aichad-top-bar__run-meta"> <a href="#" class="aichad-top-bar__subtle-link" data-aichad-open-activity>see previous runs →</a></span>`;
  }

  function showDefaultActions() {
    if (!barEl) return;
    const actions = barEl.querySelector('.aichad-top-bar__actions');
    actions.innerHTML = `
      <button type="button" class="aichad-top-bar__btn aichad-top-bar__run-now">Run now</button>
      <button type="button" class="aichad-top-bar__btn aichad-top-bar__btn--outline aichad-top-bar__settings">Settings</button>
      <button type="button" class="aichad-top-bar__dismiss" aria-label="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>`;
    actions.querySelector('.aichad-top-bar__run-now').addEventListener('click', promptRunNowFromBar);
    actions.querySelector('.aichad-top-bar__settings').addEventListener('click', openSettings);
    actions.querySelector('.aichad-top-bar__dismiss').addEventListener('click', () => {
      hideBar();
      try {
        chrome.storage.local.get(STORAGE_KEYS.LAST_RUN).then((result) => {
          try {
            const last = result[STORAGE_KEYS.LAST_RUN];
            if (last?.timestamp) {
              chrome.storage.local.set({ [STORAGE_KEYS.TOP_BAR_DISMISSED_RUN]: last.timestamp });
            }
          } catch (_) {}
        }).catch(() => {});
        chrome.storage.local.set({ [STORAGE_KEYS.BAR_PINNED]: false });
      } catch (_) {}
    });
  }

  function showRecentDelete(count, last) {
    showBar();
    resetBrandLayout();
    const info = last?.timestamp
      ? `Deleted ${count} chat${count === 1 ? '' : 's'} — ${new Date(last.timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
      : `Recently deleted ${count} chat${count === 1 ? '' : 's'}`;
    updateBarStatus(
      `${escapeHtml(info)}<span class="aichad-top-bar__run-meta"> <a href="#" class="aichad-top-bar__subtle-link" data-aichad-open-activity>see previous runs →</a></span>`
    );
    showDefaultActions();
  }

  function showPendingConfirm(pend) {
    const count = pend.count ?? 0;
    showBar();
    barEl.classList.add('aichad-top-bar--confirm');
    const BAR_TITLE = 'AI Chat History Auto-Delete';
    const brand = barEl.querySelector('.aichad-top-bar__brand');
    if (brand) {
      brand.classList.add('aichad-top-bar__brand--pending');
      brand.innerHTML = `
        <a href="#" class="aichad-top-bar__title">${escapeHtml(BAR_TITLE)}</a>
        <span class="aichad-top-bar__sep">·</span>
        <span class="aichad-top-bar__text">${escapeHtml(`${count} chat${count === 1 ? '' : 's'} ready to delete`)}</span>
        <span class="aichad-top-bar__pending-inline-actions" role="group" aria-label="Pending deletion actions">
          <button type="button" class="aichad-top-bar__btn aichad-top-bar__view-chats">View & approve</button>
          <button type="button" class="aichad-top-bar__btn aichad-top-bar__btn--outline aichad-top-bar__snooze-pending">Snooze for 1 day</button>
        </span>`;
      wireTitleLink();
      const viewBtn = brand.querySelector('.aichad-top-bar__view-chats');
      if (viewBtn) {
        viewBtn.addEventListener('click', () => {
          openPendingChatsModal(pend);
        });
      }
      brand.querySelector('.aichad-top-bar__snooze-pending').addEventListener('click', () => {
        snoozePending();
      });
    } else {
      updateBarStatus(escapeHtml(`${count} chat${count === 1 ? '' : 's'} ready to delete`));
    }
    clearProgressSlot();
    const actions = barEl.querySelector('.aichad-top-bar__actions');
    actions.innerHTML = `
      <button type="button" class="aichad-top-bar__dismiss aichad-top-bar__dismiss--pending" aria-label="Hide until next navigation">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>`;
    actions.querySelector('.aichad-top-bar__dismiss--pending').addEventListener('click', () => {
      dismissPendingBarSession();
    });
  }

  function showIdle(last) {
    showBar();
    resetBrandLayout();
    updateBarStatus(buildLastRunWithLink(last));
    showDefaultActions();
  }

  function closeRunNowModal() {
    const el = document.getElementById('aichad-run-now-modal');
    if (el) el.remove();
  }

  function promptRunNowFromBar() {
    chrome.storage.local.get(STORAGE_KEYS.SETTINGS, (r) => {
      const settings = r[STORAGE_KEYS.SETTINGS] || {};
      const days = settings.daysThreshold || 30;
      const ignoreStarred = settings.ignoreStarred !== false;
      closeRunNowModal();
      const overlay = document.createElement('div');
      overlay.id = 'aichad-run-now-modal';
      overlay.className = 'aichad-modal-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'aichad-run-now-modal-title');
      overlay.innerHTML = `
        <div class="aichad-modal">
          <h2 id="aichad-run-now-modal-title" class="aichad-modal__title">Run cleanup now?</h2>
          <p class="aichad-modal__body">
            Chats older than the age you set below will be considered for deletion for <strong>this run only</strong>.
            Your saved settings stay the same.
            ${ignoreStarred ? ' Starred chats are skipped.' : ''}
          </p>
          <div class="aichad-modal__field">
            <label for="aichad-run-now-days" class="aichad-modal__label">Delete chats older than (days)</label>
            <input type="number" id="aichad-run-now-days" class="aichad-modal__input" min="1" max="365" value="${days}" inputmode="numeric" />
          </div>
          <p class="aichad-modal__hint">Defaults to your saved threshold (${days} day${days === 1 ? '' : 's'}); change it for this run only.</p>
          <div class="aichad-modal__actions">
            <button type="button" class="aichad-modal__btn aichad-modal__btn--outline" data-aichad-cancel>Cancel</button>
            <button type="button" class="aichad-modal__btn aichad-modal__btn--primary" data-aichad-confirm>Run now</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const onKey = (e) => {
        if (e.key === 'Escape') {
          closeRunNowModal();
          document.removeEventListener('keydown', onKey);
        }
      };
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeRunNowModal();
      });
      overlay.querySelector('[data-aichad-cancel]').addEventListener('click', () => {
        closeRunNowModal();
        document.removeEventListener('keydown', onKey);
      });
      overlay.querySelector('[data-aichad-confirm]').addEventListener('click', () => {
        const input = document.getElementById('aichad-run-now-days');
        const raw = parseInt(input?.value, 10);
        let daysOverride = Number.isFinite(raw) ? raw : days;
        daysOverride = Math.min(365, Math.max(1, daysOverride));
        closeRunNowModal();
        document.removeEventListener('keydown', onKey);
        executeRunNowFromBar(daysOverride);
      });
    });
  }

  function executeRunNowFromBar(daysOverride) {
    if (!barEl) return;
    const runBtn = barEl.querySelector('.aichad-top-bar__run-now');
    if (runBtn) runBtn.disabled = true;
    resetBrandLayout();
    updateBarStatus(escapeHtml('Scanning for old chats…'));
    const opts = { useSavedSettings: true };
    if (daysOverride != null && Number.isFinite(daysOverride)) {
      opts.daysOverride = daysOverride;
    }
    chrome.runtime.sendMessage({ type: 'RUN_NOW', options: opts }, (result) => {
      if (runBtn) runBtn.disabled = false;
      if (chrome.runtime.lastError) {
        resetBrandLayout();
        updateBarStatus(`<span class="aichad-top-bar__text--error">${escapeHtml(chrome.runtime.lastError.message)}</span>`);
        showDefaultActions();
        return;
      }
      if (result?.error) {
        resetBrandLayout();
        updateBarStatus(`<span class="aichad-top-bar__text--error">${escapeHtml(result.error)}</span>`);
        showDefaultActions();
        return;
      }
      if (result?.requiresConfirm) {
        const pendingPayload = {
          count: result.count,
          chatIds: result.chatIds || [],
          chats: result.chats || [],
          tabId: result.tabId,
          timestamp: Date.now()
        };
        chrome.storage.local.set({
          [STORAGE_KEYS.PENDING_CONFIRM]: pendingPayload
        }, () => {
          showPendingConfirm(pendingPayload);
        });
        return;
      }
      resetBrandLayout();
      updateBarStatus(escapeHtml('No chats to delete'));
      showDefaultActions();
      setTimeout(() => refreshState(), 3000);
    });
  }

  async function refreshState(forceShow = false) {
    const [progress, lastRun, pending, dismissed, pinned, settingsWrap] = await Promise.all([
      chrome.storage.local.get(STORAGE_KEYS.DELETION_PROGRESS),
      chrome.storage.local.get(STORAGE_KEYS.LAST_RUN),
      chrome.storage.local.get(STORAGE_KEYS.PENDING_CONFIRM),
      chrome.storage.local.get(STORAGE_KEYS.TOP_BAR_DISMISSED_RUN),
      chrome.storage.local.get(STORAGE_KEYS.BAR_PINNED),
      chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
    ]);

    const prog = progress[STORAGE_KEYS.DELETION_PROGRESS];
    const last = lastRun[STORAGE_KEYS.LAST_RUN];
    const pend = pending[STORAGE_KEYS.PENDING_CONFIRM];
    const dismissedTs = dismissed[STORAGE_KEYS.TOP_BAR_DISMISSED_RUN];
    const isPinned = pinned[STORAGE_KEYS.BAR_PINNED] === true;
    const settings = settingsWrap[STORAGE_KEYS.SETTINGS] || {};
    const showDeletedAfterRun = settings.showDeletedCountAfterRun !== false;

    if (barEl) barEl.classList.remove('aichad-top-bar--confirm');

    if (prog) {
      const roseProgress = !!(pend?.count && pend?.chatIds?.length);
      showProgress(prog.current, prog.total, prog.deleted, roseProgress);
      return;
    }

    if (pend?.count) {
      if (pend.snoozedUntil && Date.now() < pend.snoozedUntil) {
        if (forceShow || isPinned) showIdle(last);
        else hideBar();
        return;
      }
      if (!forceShow && getSessionPendingDismissed()) {
        if (isPinned) showIdle(last);
        else hideBar();
        return;
      }
      showPendingConfirm(pend);
      return;
    }

    if (
      showDeletedAfterRun &&
      last?.deleted > 0 &&
      last.timestamp
    ) {
      const age = Date.now() - last.timestamp;
      if (age < SHOW_RECENT_MS && dismissedTs !== last.timestamp) {
        showRecentDelete(last.deleted, last);
        return;
      }
    }

    if (forceShow || isPinned) {
      if (forceShow) chrome.storage.local.set({ [STORAGE_KEYS.BAR_PINNED]: true });
      showIdle(last);
    } else {
      hideBar();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.BAR_PINNED]) {
      refreshState();
    }
    if (changes[STORAGE_KEYS.DELETION_PROGRESS]) {
      const prog = changes[STORAGE_KEYS.DELETION_PROGRESS].newValue;
      if (prog) {
        void chrome.storage.local.get(STORAGE_KEYS.PENDING_CONFIRM).then((r) => {
          const p = r[STORAGE_KEYS.PENDING_CONFIRM];
          const roseProgress = !!(p?.count && p?.chatIds?.length);
          showProgress(prog.current, prog.total, prog.deleted, roseProgress);
        });
      } else {
        refreshState();
      }
    }
    if (changes[STORAGE_KEYS.LAST_RUN]) {
      const last = changes[STORAGE_KEYS.LAST_RUN].newValue;
      if (last?.deleted > 0) {
        refreshState();
      } else {
        refreshState();
      }
    }
    if (changes[STORAGE_KEYS.PENDING_CONFIRM]) {
      refreshState();
    }
    if (changes[STORAGE_KEYS.SETTINGS]) {
      refreshState();
    }
  });

  const TOOLBAR_REFRESH_ATTEMPTS = 150;
  const TOOLBAR_REFRESH_DELAY_MS = 200;
  let toolbarRefreshGen = 0;

  /**
   * Toolbar icon: DOM may not have #main-content / header yet when the first
   * REFRESH_STATE arrives — createBar() would no-op. Retry until the bar is visible
   * or we time out (keeps in sync with background sendMessage polling).
   */
  async function refreshStateAfterToolbarClick(wasVisible) {
    const gen = ++toolbarRefreshGen;
    for (let i = 0; i < TOOLBAR_REFRESH_ATTEMPTS && gen === toolbarRefreshGen; i++) {
      await refreshState(true);
      if (isBarWrapVisible()) {
        if (wasVisible && gen === toolbarRefreshGen) {
          pulseBarAttention();
        }
        return;
      }
      await new Promise((r) => setTimeout(r, TOOLBAR_REFRESH_DELAY_MS));
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SHOW_RECENT_DELETE') {
      chrome.storage.local.get(STORAGE_KEYS.SETTINGS, (r) => {
        const s = r[STORAGE_KEYS.SETTINGS] || {};
        if (s.showDeletedCountAfterRun !== false) {
          showRecentDelete(msg.count ?? 0);
        }
      });
    }
    if (msg.type === 'REFRESH_STATE') {
      const wasVisible = isBarWrapVisible();
      void refreshStateAfterToolbarClick(wasVisible);
    }
  });

  function observeBarRemoval() {
    const observer = new MutationObserver(() => {
      if (reInjecting || !wrapEl) return;
      if (!document.body.contains(wrapEl)) {
        reInjecting = true;
        wrapEl = null;
        barEl = null;
        if (getBarInsertionPoint()) {
          createBar();
          refreshState(true);
        }
        reInjecting = false;
      } else {
        clearTimeout(ensurePosTimer);
        ensurePosTimer = setTimeout(ensureBarPosition, 150);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function injectSidebarButton() {
    if (document.getElementById('aichad-sidebar-btn')) return;
    const codeLink = document.querySelector('a[href="/code"][data-dd-action-name="sidebar-nav-item"]');
    const nav = codeLink?.closest('.flex.flex-col')
      || document.querySelector('[data-dd-action-name="sidebar-nav-item"]')?.closest('.flex.flex-col');
    if (!nav) {
      setTimeout(injectSidebarButton, 800);
      return;
    }
    const codeItem = codeLink?.closest('.relative.group') ?? codeLink?.parentElement;
    const wrapper = document.createElement('div');
    wrapper.className = 'relative group';
    wrapper.setAttribute('data-state', 'closed');
    const btn = document.createElement('button');
    btn.id = 'aichad-sidebar-btn';
    btn.type = 'button';
    btn.className = [
      'inline-flex items-center justify-center relative isolate shrink-0',
      'can-focus select-none disabled:pointer-events-none disabled:opacity-50',
      'disabled:shadow-none disabled:drop-shadow-none border-transparent',
      'transition font-base duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)]',
      'h-8 rounded-md px-3 min-w-[4rem] whitespace-nowrap !text-xs w-full !min-w-0',
      'group py-1.5 rounded-lg px-4 !duration-75 overflow-hidden',
      'active:bg-bg-300 active:scale-[1.0] _fill_56vq7_9 _ghost_56vq7_96'
    ].join(' ');
    btn.setAttribute('aria-label', 'Auto-Delete');
    btn.innerHTML = `
      <div class="-translate-x-2 w-full flex flex-row items-center justify-start gap-3">
        <div class="flex items-center justify-center text-text-100">
          <div class="group" style="width: 16px; height: 16px; display: flex; align-items: center; justify-content: center;">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex-shrink: 0;">
              <path d="M10 2C5.58 2 2 5.58 2 10s3.58 8 8 8 8-3.58 8-8-3.58-8-8-8zm0 1c3.87 0 7 3.13 7 7s-3.13 7-7 7-7-3.13-7-7 3.13-7 7-7z"/>
              <path d="M10 4.5a.5.5 0 0 1 .5.5v4.793l2.854 2.853a.5.5 0 0 1-.708.708l-3-3A.5.5 0 0 1 9.5 10V5a.5.5 0 0 1 .5-.5z"/>
            </svg>
          </div>
        </div>
        <span class="truncate text-sm whitespace-nowrap flex-1">
          <div class="opacity-100 transition-opacity ease-out duration-150"><span>Auto-Delete</span></div>
        </span>
      </div>`;
    btn.addEventListener('click', () => {
      try {
        chrome.storage.local.get(STORAGE_KEYS.BAR_PINNED).then((r) => {
          try {
            const next = !(r[STORAGE_KEYS.BAR_PINNED] === true);
            chrome.storage.local.set({ [STORAGE_KEYS.BAR_PINNED]: next });
          } catch (_) {}
        }).catch(() => {});
      } catch (_) {}
    });
    wrapper.appendChild(btn);
    if (codeItem?.nextSibling) {
      nav.insertBefore(wrapper, codeItem.nextSibling);
    } else if (codeItem) {
      codeItem.after(wrapper);
    } else {
      nav.appendChild(wrapper);
    }
  }

  function isDevMode() {
    try { return !chrome.runtime.getManifest().update_url; }
    catch { return false; }
  }

  function checkIntegrationTestParam() {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('_autodelete_test');
    if (!mode) return;
    if (!isDevMode()) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('_autodelete_test');
    history.replaceState(null, '', url.toString());

    const dryRun = mode !== 'delete';
    showBar();
    resetBrandLayout();
    updateBarStatus(escapeHtml(`Integration test: ${dryRun ? 'finding oldest chat…' : 'finding & deleting oldest chat…'}`));

    chrome.runtime.sendMessage({ type: 'INTEGRATION_TEST', dryRun }, (result) => {
      if (chrome.runtime.lastError) {
        resetBrandLayout();
        updateBarStatus(`<span class="aichad-top-bar__text--error">${escapeHtml(chrome.runtime.lastError.message)}</span>`);
        return;
      }
      if (result?.error) {
        resetBrandLayout();
        updateBarStatus(`<span class="aichad-top-bar__text--error">${escapeHtml(result.error)}</span>`);
        return;
      }
      const name = result.chat?.name || '(unnamed)';
      const date = result.chat?.createdAt ? new Date(result.chat.createdAt).toLocaleString() : '—';
      resetBrandLayout();
      if (dryRun) {
        updateBarStatus(`<span class="aichad-top-bar__text--ok">✓ Dry run OK — oldest: "${escapeHtml(name)}" (${escapeHtml(date)})</span>`);
      } else {
        updateBarStatus(`<span class="aichad-top-bar__text--ok">✓ Deleted "${escapeHtml(name)}" (${escapeHtml(date)})</span>`);
      }
    });
  }

  function init() {
    if (!document.body) {
      setTimeout(init, 50);
      return;
    }
    if (!getBarInsertionPoint()) {
      setTimeout(init, 100);
      return;
    }
    if (!createBar()) {
      setTimeout(init, 100);
      return;
    }
    refreshState();
    observeBarRemoval();
    setTimeout(injectSidebarButton, 800);
    window.addEventListener('beforeunload', () => {
      try {
        sessionStorage.removeItem(SESSION_PENDING_BAR_DISMISS_KEY);
      } catch (_) {}
    });
    window.addEventListener('popstate', () => {
      try {
        sessionStorage.removeItem(SESSION_PENDING_BAR_DISMISS_KEY);
      } catch (_) {}
      ensureBarPosition();
      refreshState();
    });
    checkIntegrationTestParam();
  }

  init();

  window.__aichadTopBarRefresh = () => refreshState(true);
    })();
  })();
}
