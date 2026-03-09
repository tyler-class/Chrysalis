# Chrysalis

A Chrome extension (Manifest V3) that syncs your **Monarch Money** account balances to **ProjectionLab** with one click. You stay on `app.monarch.com`, click the extension icon, click **Sync**. Done.

## Why this instead of a Node.js script?

- **No local scripts to run** — everything runs in the browser where you’re already logged into Monarch.
- **Uses your existing session** — the extension reads Monarch’s auth token from the page’s localStorage and calls Monarch’s API from the same origin, so you don’t manage tokens or env vars for Monarch.
- **One-click sync** — no opening a terminal or running a command; sync from the popup in a couple of seconds.
- **Many-to-one mapping** — multiple Monarch accounts can map to a single ProjectionLab account; balances are summed before updating PL.

---

## Installation (from source)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select this folder (the one containing `manifest.json`).

The extension will appear in your toolbar. Pin it if you like.

---

## One-time setup

1. **Click the extension icon** → **setup ↗** (or right‑click the icon → Options).  
   This opens the setup page in a new tab.

2. **Step 1 — ProjectionLab API key**  
   - In ProjectionLab: **Account Settings → Plugins → Enable Plugins**.  
   - Copy your plugin API key and paste it into the setup page.  
   - Click **Save Key**.

3. **Step 2 — Load accounts**  
   - Open a tab to [Monarch Money](https://app.monarch.com) and log in.  
   - In the setup page, click **Load Accounts from Monarch**.  
   - The extension will load Monarch accounts from that tab and ProjectionLab accounts (opening a PL tab in the background if needed).  
   - Wait until you see “Loaded N Monarch accounts and M ProjectionLab accounts.”

4. **Step 3 — Map accounts**  
   - For each ProjectionLab account you want to update, choose one or more Monarch accounts.  
   - Multiple Monarch accounts map to one PL account; their balances are summed.  
   - Click **Save Mappings**.

---

## Using the extension (each sync)

1. Open [Monarch Money](https://app.monarch.com) and make sure you’re logged in.
2. Click the **Chrysalis** extension icon.
3. If the status shows **on Monarch**, click **↑ Sync to ProjectionLab**.
4. Wait for the result list (per-account success/failure and balances).

If you’re not on a Monarch tab, the Sync button is disabled and the popup will tell you to open `app.monarch.com` first.

---

## Permissions

| Permission       | Why it’s used |
|------------------|----------------|
| `storage`        | Store API key and account mappings in `chrome.storage.sync`; store last sync time/results in `chrome.storage.local`. |
| `activeTab`      | Know which tab is active when you open the popup (to check if you’re on Monarch). |
| `scripting`      | In setup: inject a script into the ProjectionLab tab to call `window.projectionlabPluginAPI.exportData()` and get PL account list. |
| `tabs`           | Find or create a Monarch/ProjectionLab tab; send messages to the content script on the Monarch tab. |
| Host: `app.monarch.com` | Content script runs there to read token and run GraphQL. |
| Host: `api.monarch.com` | GraphQL requests for accounts/balances (from the page context via content script). |
| Host: `app.projectionlab.com` | In setup: inject script for `exportData({ key })`. On Sync: inject script in a PL tab to call `updateAccount(id, { balance }, { key })`. |

---

## Architecture and breakage points

- **Monarch**  
  The extension uses Monarch’s **unofficial** GraphQL API at `https://api.monarch.com/graphql`, with the auth token read from the Monarch page’s localStorage (e.g. keys like `mm/auth/token` or any JWT-shaped value).  
  If Monarch changes their token key, auth flow, or GraphQL schema, sync will break.  
  **File to edit:** `content-scripts/monarch.js` (token keys, GraphQL query, and response handling).

- **ProjectionLab**  
  Sync requires an open tab to **app.projectionlab.com** (plan or dashboard). The extension injects a script and calls `updateAccount(accountId, data, { key: apiKey })` with a **per-type data property**: savings/investment/asset use `balance`, debt (loans, credit cards) use `currentBalance`.  
  Setup uses `exportData({ key: key })` in an open PL tab to get account IDs and names.  
  **Inspecting the export schema (for Insomnia or debugging):**  
  `exportData` is **not** an HTTP API — it runs only inside the browser as `window.projectionlabPluginAPI.exportData({ key: 'api-key' })`. You cannot call it from Insomnia. To see the structure (property names for each account type):  
  - **In Setup:** click **Copy export schema** (Step 2). It runs `exportData` in a PL tab and shows the first account of each type (savings, investment, assets, debts) and their keys, then copies to clipboard.  
  - **In the browser:** open [app.projectionlab.com](https://app.projectionlab.com), F12 → Console, run:  
    `const d = await window.projectionlabPluginAPI.exportData({ key: 'YOUR_KEY' }); console.log(JSON.stringify(d.today, null, 2));`  
  The extension uses **simple mode**: it always sends `{ balance: value }` for every account (same as [georgeck/projectionlab-monarchmoney-import](https://github.com/georgeck/projectionlab-monarchmoney-import) and ProjectionLab’s plugin docs).  
  **Testing from Insomnia:** `POST https://app.projectionlab.com/api/plugin/updateAccount` with body `{ "accountId": "<id>", "key": "<api-key>", "balance": <number> }`.

- **Storage**  
  API key and mappings live in `chrome.storage.sync`; last sync time and results in `chrome.storage.local`.  
  If you change the data model, consider migration in the same files that read storage (popup, setup, background).

---

## Contributing

- Open issues for bugs or API/schema changes.
- Pull requests welcome: keep the stack vanilla JS, no React/bundler, and follow the existing structure (content script for Monarch, background for sync and PL API, popup/setup for UI).

---

## Disclaimer

This extension is **unofficial** and not affiliated with Monarch Money or ProjectionLab. It relies on undocumented or semi-documented APIs and localStorage behavior that may change. Use at your own risk.

---

## Regenerating icons

Extension icons (16×16, 48×48, 128×128) are generated from `icons/logo-small.jpg`. To regenerate them (macOS; uses `sips`):

```bash
node scripts/generate-icons.js
```

This writes `icons/icon16.png`, `icons/icon48.png`, and `icons/icon128.png`.
