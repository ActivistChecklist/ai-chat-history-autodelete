# Claude API Discovery

**Load this as a separate extension** to capture Claude's real API calls.

## Steps

1. Open Brave/Chrome → `brave://extensions` → Developer mode → **Load unpacked**
2. Select the `discovery` folder (not the parent `ai-chat-history-auto-delete` folder)
3. Go to [claude.ai](https://claude.ai) and log in
4. Browse around:
   - Open the chat list / "Show all chats" / sidebar
   - Scroll down to trigger pagination (load more chats)
   - Delete at least one chat
5. Open DevTools (F12 or Cmd+Option+I) → **Console** tab
6. Run: `__claudeDiscoveryExportSummary()` (compact, ~few KB)
7. Copy the output and share it

**Use `__claudeDiscoveryExportSummary()`** — it outputs only unique endpoints with structure (keys, types, sample shapes), not full request/response bodies. The full `__claudeDiscoveryExport()` can be 1MB+ and is not needed for provider updates.
