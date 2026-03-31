# GitHub Pages (project site)

This folder is the **static marketing site** and the **canonical privacy policy URL** for Chrome Web Store and other listings.

## Live URLs (after Pages is enabled)

With the default GitHub Pages setup for this repo:

- Site: `https://activistchecklist.github.io/ai-chat-history-autodelete/`
- Privacy policy: `https://activistchecklist.github.io/ai-chat-history-autodelete/privacy.html`

Use the privacy URL in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) under **Privacy practices**.

## Enable GitHub Pages

1. Repo **Settings** → **Pages**.
2. **Build and deployment** → **Source**: *Deploy from a branch*.
3. **Branch**: `main` (or your default), folder **`/docs`**, Save.

The site uses [Tailwind CSS](https://tailwindcss.com/) via the Play CDN in each HTML file (no separate build step for `docs/`).

## After publishing to the Chrome Web Store

In `index.html`, add a second primary button or replace the GitHub CTA with your listing URL, for example:

`https://chromewebstore.google.com/detail/<slug>/<extension-id>`

Keep `privacy.html` in sync with `PRIVACY.md` at the repo root when policy text changes.
