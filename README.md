# Chrysalis

**Sync Monarch Money balances to ProjectionLab.**

Chrysalis is a Chrome extension that pulls your live account balances from Monarch Money and pushes them into ProjectionLab with one click. No scripts, no terminal, no copy-pasting numbers by hand.

---

## Why Chrysalis exists

ProjectionLab is a powerful financial planning tool, but it only knows what you tell it. Monarch Money knows exactly what your accounts are worth right now. Chrysalis connects the two — your plan stays grounded in your actual balances without any manual data entry.

The existing workaround requires running a Node.js script from the terminal, manually editing a JSON config file, and pasting generated code into your browser console every time you want to update. It also broke in early 2025 when Monarch added email verification to their login flow. Chrysalis replaces all of that with a button.

---

## Requirements

- Google Chrome (or any Chromium-based browser)
- A [Monarch Money](https://monarchmoney.com) account
- A [ProjectionLab](https://projectionlab.com) account with Plugins enabled
- Your accounts must already exist in ProjectionLab before syncing — Chrysalis updates balances, it does not create accounts

---

## Installation

Chrysalis is not yet on the Chrome Web Store. Install it directly from the source:

1. Download or clone this repository and unzip it somewhere on your machine
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** using the toggle in the top-right corner
4. Click **Load unpacked**
5. Select the folder you unzipped

The Chrysalis icon will appear in your Chrome toolbar. Pin it for easy access.

---

## Setup

Setup takes about two minutes and only needs to be done once.

Click the Chrysalis icon and then click **setup ↗** in the top-right corner of the popup to open the setup page.

### Step 1 — Add your ProjectionLab API key

Chrysalis uses ProjectionLab's official Plugin API to update your account balances. You need to enable this and generate a key:

1. Log into [ProjectionLab](https://app.projectionlab.com)
2. Go to **Account Settings** (top-right menu) → **Plugins**
3. Toggle **Enable Plugins** on
4. Copy the value shown in the **Plugin API Key** field

Paste it into the API key field in Chrysalis and click **Save Key**.

### Step 2 — Load your accounts

Before you can map anything, Chrysalis needs to fetch your account lists from both services.

1. Make sure you're logged into Monarch Money — have `app.monarchmoney.com` open in a tab
2. Click **Load Accounts from Monarch**

Chrysalis will fetch your Monarch accounts from the open tab, then briefly open ProjectionLab in the background to retrieve your account list from there as well. Both lists will populate automatically.

> **Note:** If you see an error loading ProjectionLab accounts, make sure Plugins are enabled (Step 1) and that you're logged into ProjectionLab.

### Step 3 — Map your accounts

This is where you tell Chrysalis which Monarch account corresponds to which ProjectionLab account.

Each row represents one **ProjectionLab account** (the destination). On the left side, you select one or more **Monarch accounts** to map to it.

**One-to-one mapping** (most common): select one Monarch account on the left, one ProjectionLab account on the right.

**Many-to-one mapping**: if you have multiple Monarch accounts that should roll up into a single ProjectionLab account — for example, two checking accounts that map to one "cash" entry — select all of them on the left. Chrysalis will sum their balances before syncing.

To add a mapping:
1. Use the **+ add Monarch account** dropdown to select a Monarch account — it will appear as a chip
2. Add more Monarch accounts to the same row if needed
3. Select the corresponding ProjectionLab account on the right
4. Click **+ add PL account mapping** to add another row for a different PL account
5. Click **Save Mappings** when done

You do not need to map every account — only the ones you want Chrysalis to manage.

### Sync

Once setup is complete, syncing is a one-step process:

1. Navigate to `app.monarchmoney.com` in Chrome (and make sure you're logged in)
2. Click the Chrysalis icon in your toolbar
3. Click **↑ Sync to ProjectionLab**

The sync button is only active when you're on the Monarch site. This is intentional — Chrysalis reads your session directly from the Monarch page, so the page needs to be open.

---

## How it works

### Authentication

Chrysalis does not store your Monarch username or password. Instead, it reads the session token that Monarch's web app stores in the browser's `localStorage` after you log in normally. This is the same token your browser is already using to show you your accounts — Chrysalis just borrows it.

This approach is more secure than storing credentials, and it sidesteps the authentication issues that broke earlier scripted approaches when Monarch added email verification requirements to their login flow.

### Fetching balances

Once it has the session token, Chrysalis makes a GraphQL request directly to Monarch's API — the same endpoint the Monarch web app uses — and retrieves the current balance for each of your mapped accounts.

### Updating ProjectionLab

Chrysalis calls ProjectionLab's official Plugin API for each mapped account, sending the current balance. If you have multiple Monarch accounts mapped to one ProjectionLab account, Chrysalis sums the balances first, then makes a single API call with the total.

### What stays on your machine

Everything. Your API key is stored in Chrome's extension storage. Your account mappings are stored there too, and sync across your Chrome profiles if you're signed into Chrome. No data is sent to any server other than Monarch and ProjectionLab's own APIs.

---

## Other features

### Sync results

After each sync, the popup shows a per-account breakdown:

- ✓ Each successfully updated account, with the balance that was written and the Monarch source(s) it came from
- ✗ Any accounts that failed, with the specific error
- ⚠ A warning if some (but not all) source accounts in a many-to-one mapping couldn't be found — Chrysalis will still sync using the accounts it could find

The result list stays visible until you run the next sync, so you can close and reopen the popup without losing the last run's details.

### Sync history

The **Advanced** section of the setup page shows a log of recent syncs with timestamps and outcomes. Useful for confirming a sync ran correctly or diagnosing a pattern of failures.

### Partial sync behavior

If one of your mapped accounts is deleted or hidden in Monarch after you set up a mapping, Chrysalis will:
- Skip that account with an error rather than writing a wrong balance
- Still sync all other accounts that resolved correctly
- Report partial success so you know something needs attention

---

## Troubleshooting

**"No Monarch session token found"**  
Make sure you're logged into Monarch Money in the current tab. Try refreshing the Monarch page and syncing again.

**"ProjectionLab plugin API not found"**  
Plugins are not enabled in your ProjectionLab account. Go to Account Settings → Plugins and toggle them on.

**"Could not reach Monarch page"**  
The content script couldn't connect to the Monarch tab. Refresh the Monarch page and try again. If this persists, try disabling and re-enabling the extension.

**Account not found in Monarch**  
The account was likely hidden or deleted in Monarch after you set up the mapping. Go to setup, reload your accounts, and update the mapping.

**Balances look wrong after sync**  
Check the sync result detail in the popup — if a many-to-one mapping is partially resolving (some source accounts missing), the balance shown will be lower than expected. Update your mappings to reflect your current Monarch accounts.

---

## Known limitations

- Chrysalis requires the Monarch tab to be open when syncing. This is a trade-off for not needing to store your credentials.
- ProjectionLab accounts must already exist — Chrysalis cannot create new accounts, only update balances on existing ones.
- This uses Monarch's internal GraphQL API, which is unofficial and unversioned. It could change without notice. See [Contributing](#contributing) for how to report or fix breakage.

---

## Contributing

Contributions are welcome, especially fixes when Monarch or ProjectionLab change their APIs.

**When Monarch breaks auth or account fetching**, the relevant file is `content-scripts/monarch.js`. The most common failure mode is the session token moving to a different `localStorage` key — the token scanning logic is at the top of that file.

**When ProjectionLab's Plugin API changes**, the relevant call is in `background/service-worker.js`.

When filing an issue, please include:
- What error you saw (exact text)
- Whether the Monarch web app itself was working normally at the time
- Your Chrome version

---

## Disclaimer

Chrysalis is an independent project and is not affiliated with, endorsed by, or supported by Monarch Money or ProjectionLab. It uses unofficial APIs that may change at any time. Use it at your own risk, and always keep a backup of your ProjectionLab data (Account Settings → Export Data) before syncing.

---

## License

MIT