import { STORAGE_KEYS } from './constants.js';

export const PENDING_MODAL_OVERLAY_ID = 'aichad-pending-chats-modal';
export const CLAUDE_CHAT_BASE = 'https://claude.ai/chat';

const SNOOZE_MS = 24 * 60 * 60 * 1000;

export function escapeHtmlForPendingModal(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatLastEditedLabel(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
}

export function buildChatRows(pend) {
  const ids = pend.chatIds || [];
  const byId = new Map(
    (pend.chats || []).map((c) => [
      c.id,
      { name: c.name, lastEditAt: c.lastEditAt ?? null }
    ])
  );
  return ids.map((id) => {
    const row = byId.get(id);
    const name = row?.name ?? id;
    const lastEditAt = row?.lastEditAt ?? null;
    const lastEdited = formatLastEditedLabel(lastEditAt);
    return { id, name, lastEdited };
  });
}

export function closePendingDeletionModal(doc = document) {
  doc.getElementById(PENDING_MODAL_OVERLAY_ID)?.remove();
}

export async function applySnoozeToPending(storageKey = STORAGE_KEYS.PENDING_CONFIRM) {
  const r = await chrome.storage.local.get(storageKey);
  const pendingConfirm = r[storageKey];
  if (!pendingConfirm) return false;
  await chrome.storage.local.set({
    [storageKey]: {
      ...pendingConfirm,
      snoozedUntil: Date.now() + SNOOZE_MS
    }
  });
  return true;
}

/**
 * Deletion approval modal (shared by Claude top bar and extension options).
 * Uses classes from top-bar.css (.aichad-modal-overlay, .aichad-modal--chats, …).
 *
 * @param {object} pend - pending_confirm snapshot
 * @param {object} [opts]
 * @param {Document} [opts.document]
 * @param {() => void} [opts.onModalCleanup] - after overlay removed (Escape, overlay click, close)
 * @param {() => Promise<void>|void} [opts.afterSnooze]
 * @param {(result: { deleted?: number }) => Promise<void>|void} [opts.afterConfirmSuccess]
 * @param {(msg: string) => void} [opts.onError] - defaults to alert()
 */
export function openPendingDeletionModal(pend, opts = {}) {
  const doc = opts.document ?? document;
  const afterSnooze = opts.afterSnooze;
  const afterConfirmSuccess = opts.afterConfirmSuccess;
  const onError = opts.onError ?? ((msg) => { alert(msg); });
  const onModalCleanup = opts.onModalCleanup;

  const escapeHtml = escapeHtmlForPendingModal;
  closePendingDeletionModal(doc);

  const rows = buildChatRows(pend);
  const listHtml = rows.length
    ? rows.map((r) => `
        <li class="aichad-modal__chat-item">
          <a href="${CLAUDE_CHAT_BASE}/${encodeURIComponent(r.id)}" target="_blank" rel="noopener noreferrer" class="aichad-modal__chat-link">${escapeHtml(r.name)}</a>
          ${r.lastEdited ? `<span class="aichad-modal__chat-meta">Last edited ${escapeHtml(r.lastEdited)}</span>` : ''}
        </li>`).join('')
    : `<li class="aichad-modal__chat-item aichad-modal__chat-item--empty">No chat links available.</li>`;

  const overlay = doc.createElement('div');
  overlay.id = PENDING_MODAL_OVERLAY_ID;
  overlay.className = 'aichad-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'aichad-pending-chats-modal-title');
  overlay.innerHTML = `
      <div class="aichad-modal aichad-modal--chats">
        <h2 id="aichad-pending-chats-modal-title" class="aichad-modal__title">Chats ready to delete</h2>
        <p class="aichad-modal__body">${escapeHtml(String(pend.count ?? 0))} chat${(pend.count ?? 0) === 1 ? '' : 's'} will be permanently removed.</p>
        <ul class="aichad-modal__chat-list">${listHtml}</ul>
        <div class="aichad-modal__actions aichad-modal__actions--stack">
          <button type="button" class="aichad-modal__btn aichad-modal__btn--danger" data-aichad-confirm-delete>Confirm deletion</button>
          <button type="button" class="aichad-modal__btn aichad-modal__btn--outline" data-aichad-snooze>Snooze for 1 day</button>
          <button type="button" class="aichad-modal__btn aichad-modal__btn--outline" data-aichad-close>Close</button>
        </div>
      </div>`;
  doc.body.appendChild(overlay);

  const detachKey = () => {
    doc.removeEventListener('keydown', onKey);
  };

  function onKey(e) {
    if (e.key === 'Escape') {
      detachKey();
      closePendingDeletionModal(doc);
      onModalCleanup?.();
    }
  }
  doc.addEventListener('keydown', onKey);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      detachKey();
      closePendingDeletionModal(doc);
      onModalCleanup?.();
    }
  });

  overlay.querySelector('[data-aichad-close]').addEventListener('click', () => {
    detachKey();
    closePendingDeletionModal(doc);
    onModalCleanup?.();
  });

  overlay.querySelector('[data-aichad-snooze]').addEventListener('click', async () => {
    detachKey();
    const ok = await applySnoozeToPending();
    closePendingDeletionModal(doc);
    onModalCleanup?.();
    if (ok && afterSnooze) await afterSnooze();
  });

  overlay.querySelector('[data-aichad-confirm-delete]').addEventListener('click', () => {
    detachKey();
    const btn = overlay.querySelector('[data-aichad-confirm-delete]');
    if (btn) btn.disabled = true;
    chrome.storage.local.get(STORAGE_KEYS.PENDING_CONFIRM).then(({ [STORAGE_KEYS.PENDING_CONFIRM]: p }) => {
      if (!p?.chatIds?.length) {
        if (btn) btn.disabled = false;
        onError('No pending chats to delete.');
        return;
      }
      closePendingDeletionModal(doc);
      onModalCleanup?.();
      chrome.runtime.sendMessage(
        { type: 'CONFIRM_DELETE', tabId: p.tabId, chatIds: p.chatIds },
        async (res) => {
          if (chrome.runtime.lastError) {
            onError(chrome.runtime.lastError.message);
            return;
          }
          if (res?.error) {
            onError(res.error);
            return;
          }
          if (afterConfirmSuccess) await afterConfirmSuccess(res ?? {});
        }
      );
    });
  });
}
