# AI Chat History Auto-Delete (AI CHAD)

Chrome extension for **claude.ai**: **delete chats older than X days** (you choose X; 30 is the default). Runs in your browser only—nothing is sent to us.

Made by [Activist Checklist](https://activistchecklist.org/).

## Project website (GitHub Pages)

- **Site:** [activistchecklist.github.io/ai-chat-history-auto-delete](https://activistchecklist.github.io/ai-chat-history-auto-delete/)
- **Privacy policy (use this URL in the Chrome Web Store):** [activistchecklist.github.io/ai-chat-history-auto-delete/privacy.html](https://activistchecklist.github.io/ai-chat-history-auto-delete/privacy.html)

## Install Chrome Extension

- **Chrome Web Store:** (LINK HERE)
- **Marketing / privacy pages:** [Project site](https://activistchecklist.github.io/ai-chat-history-auto-delete/).
- **From source:** Clone this repo, then follow [Build & packaging](#build--packaging) and load `dist/` via `chrome://extensions` → **Load unpacked**, or install from the zip under `release/`.

## Features

- **Delete chats older than X days** — You set X (e.g. 30). The extension deletes conversations **older than that many days**. That is the whole point.
- **Run on a schedule or not** — Once a day, once a week, once a month, or **never automatically** until you click Run. Out of the box it stays **manual-only** until you finish setup or change it.
- **“Run now”** — Kick off a delete pass whenever you want from Settings (or from the bar on claude.ai when something needs you).
- **Bar on claude.ai** — When a run is happening, just finished, or chats are waiting for you to confirm, you get a small top bar on the page. Dismiss it when you’re done reading it.
- **No list of what got deleted** — You might see a number (e.g. how many were removed last time). It doesn’t save chat names or links.

## Usage

1. **Click the extension icon** — Opens [claude.ai](https://claude.ai) (or focuses a tab you already have). If something is running, just finished, or needs you to confirm deletes, a **thin bar** appears at the top of the page. Close it when you’re done reading.
2. **Keep claude.ai open when you want work to happen** — Signed in, normal browser tab. The extension uses **your** login. It does **not** open Claude for you when a scheduled time hits—you have to have the site open.
3. **Make it go** — Use **Run now** in Settings, or wait for your schedule, or use the bar when it says there’s pending stuff.

### You need claude.ai open in a tab

If no **claude.ai** tab is open, the extension does **nothing**—it can’t see your session. When you **do** have a tab open and a run happens (scheduled or **Run now**), it deletes **every chat that is older than X days** based on the number you set—including chats that “became” older than X while you didn’t have a tab open.

## Security — What we don't store

No data ever leaves your computer. We don't record anything about the deleted chats except the total number deleted each time the extension runs.

We do NOT store:

- **Deleted chat IDs** — Never stored. Used only in memory during the API call to delete, then discarded.
- **Deleted chat names/titles** — Never stored. The activity log records only how many chats were deleted.
- **No external transmission** — All storage is local (`chrome.storage.local`). Nothing is sent to us or any third party.

**Privacy policy:** [PRIVACY.md](PRIVACY.md) (source) · [Hosted copy for listings](https://activistchecklist.github.io/ai-chat-history-auto-delete/privacy.html) (after GitHub Pages is enabled)

## Build & packaging

Chrome extensions don’t compile to a single binary: you ship the **same files the browser loads** (manifest, JS modules, HTML, CSS, icons), usually as a **zip** for the Web Store or **unpacked folder** for local testing.

This repo uses an **allowlist-only** pack step so `dist/` and release zips never pick up tests, `discovery/`, source Tailwind input, env files, or other dev-only artifacts.

```bash
yarn install
yarn build
```

- Runs **Tailwind** (`build:css`) so `src/styles/auto-delete.css` is minified, then copies only listed runtime files into **`dist/`**.
- Writes **`release/ai-chat-history-auto-delete-<version>.zip`** (version from `manifest.json`). Upload that zip to the Chrome Web Store, or in `chrome://extensions` choose **Load unpacked** and select the **`dist`** folder.

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
| `storage` | Save your “older than X days” number, schedule, and local run counts on your device only. |
| `alarms` | Run scheduled deletion checks. |
| `tabs` | Find or focus claude.ai so work runs in your signed-in session. |
| `scripting` | Run logic in the page context on claude.ai as designed. |
| `notifications` | Optional browser notifications when chats are pending confirmation or need attention. |
| `https://claude.ai/*` | Only this origin—list/delete conversations per your settings. No other domains, no analytics. |
