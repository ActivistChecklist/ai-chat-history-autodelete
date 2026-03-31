# AI Chat History Auto-Delete (AI CHAD)

Privacy-focused Chrome extension that auto-deletes AI chat history older than your specified threshold.

Created by the team at [Activist Checklist](https://activistchecklist.org/).

## Project website (GitHub Pages)

- **Site:** [activistchecklist.github.io/ai-chat-history-autodelete](https://activistchecklist.github.io/ai-chat-history-autodelete/)
- **Privacy policy (use this URL in the Chrome Web Store):** [activistchecklist.github.io/ai-chat-history-autodelete/privacy.html](https://activistchecklist.github.io/ai-chat-history-autodelete/privacy.html)

## Install Chrome Extension

- **Marketing / privacy pages:** [Project site](https://activistchecklist.github.io/ai-chat-history-autodelete/) (after Pages is enabled).
- **From source:** Clone this repo, then follow [Build & packaging](#build--packaging) and load `dist/` via `chrome://extensions` → **Load unpacked**, or install from the zip under `release/`.
- **Chrome Web Store:** Add the listing link on the project site and here once the extension is published ([Developer Dashboard](https://chrome.google.com/webstore/devconsole)).

## Features

- **Auto-delete**: Set an age threshold (default 30 days) — chats older than that can be auto-deleted
- **Scheduled runs**: Daily (recommended), weekly, monthly, or manual only — **manual** is the default until you finish setup or change settings
- **Manual run**: Run manually at any point
- **Activity history**: Records the number of chats deleted each time the script ran in the last 30 days (doesn't record chat name or ID, just the total number deleted)

## Usage

1. **Click the extension icon** — Opens [claude.ai](https://claude.ai) (or focuses an existing tab) and shows a top bar on the page when there's progress, a recent deletion, or chats pending confirmation. The bar is dismissable.
2. **Claude in a tab**: Keep [claude.ai](https://claude.ai) open and signed in when a check runs—the extension uses that tab's session. It does **not** open Claude automatically during scheduled runs.
3. **Run**: Use **Run now** in Settings (or the top bar when there's pending) or wait for scheduled runs

### Notice: You must open claude.ai

The extension needs a **claude.ai** tab open to run. Nothing happens while no claude.ai tab is open. When you open claude.ai, the **next** scheduled check (or **Run now** from Settings) removes **all** conversations **older than your age threshold**—including chats that aged past that cutoff while no claude.ai tab was open.

## Security — What we don't store

No data ever leaves your computer. We don't record anything about the deleted chats except the total number deleted each time the extension runs.

We do NOT store:

- **Deleted chat IDs** — Never stored. Used only in memory during the API call to delete, then discarded.
- **Deleted chat names/titles** — Never stored. The activity log records only how many chats were deleted.
- **No external transmission** — All storage is local (`chrome.storage.local`). Nothing is sent to us or any third party.

**Privacy policy:** [PRIVACY.md](PRIVACY.md) (source) · [Hosted copy for listings](https://activistchecklist.github.io/ai-chat-history-autodelete/privacy.html) (after GitHub Pages is enabled)

## Build & packaging

Chrome extensions don’t compile to a single binary: you ship the **same files the browser loads** (manifest, JS modules, HTML, CSS, icons), usually as a **zip** for the Web Store or **unpacked folder** for local testing.

This repo uses an **allowlist-only** pack step so `dist/` and release zips never pick up tests, `discovery/`, source Tailwind input, env files, or other dev-only artifacts.

```bash
yarn install
yarn build
```

- Runs **Tailwind** (`build:css`) so `src/styles/auto-delete.css` is minified, then copies only listed runtime files into **`dist/`**.
- Writes **`release/ai-chat-history-autodelete-<version>.zip`** (version from `manifest.json`). Upload that zip to the Chrome Web Store, or in `chrome://extensions` choose **Load unpacked** and select the **`dist`** folder.

Options:

- `yarn build -- --no-zip` — populate `dist/` only.
- `yarn build -- --skip-css` — skip Tailwind if you already ran `yarn build:css`.

When you add a new imported module or static asset, add its path to **`ALLOWLISTED_FILES`** in `scripts/build-extension.mjs` or the build will fail on purpose (so nothing is shipped by accident).

Optional: Mozilla’s **`web-ext lint`** can cross-check manifest and common issues (`npx web-ext lint --source-dir=dist`); this project does not depend on it.

## Architecture

- **Background**: Orchestrates flow, uses `chrome.scripting.executeScript` with `world: "MAIN"` to run fetch in page context (inherits your session)
- **Provider interface**: Generic `loadChatsPage` / `deleteChats` so other chat providers can be added behind the same shape
- **Storage**: `chrome.storage.local` for settings and activity history

## Permissions

| Permission / access | Why |
|---------------------|-----|
| `storage` | Save settings (threshold, schedule) and local activity counts on your device only. |
| `alarms` | Run scheduled deletion checks. |
| `tabs` | Find or focus claude.ai so work runs in your signed-in session. |
| `scripting` | Run logic in the page context on claude.ai as designed. |
| `notifications` | Optional browser notifications when chats are pending confirmation or need attention. |
| `https://claude.ai/*` | Only this origin—list/delete conversations per your settings. No other domains, no analytics. |
