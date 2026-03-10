# Privacy Policy

**Chrysalis — Monarch Money → ProjectionLab Sync**  
Last updated: March 2026

---

## Overview

Chrysalis is a Chrome extension that syncs your account balances from Monarch Money to ProjectionLab. This policy explains what data Chrysalis accesses, how it's used, and where it goes (spoiler: almost nowhere).

---

## What data Chrysalis accesses

**Monarch Money session token**  
When you are logged into Monarch Money in your browser, Chrysalis reads the session token that Monarch's web app stores in your browser's `localStorage`. This is the same token your browser already uses to authenticate you with Monarch. Chrysalis uses it to make a GraphQL request to Monarch's API to fetch your current account balances. Chrysalis does not store, transmit, or log this token beyond the immediate sync operation.

**Monarch account balances**  
Chrysalis retrieves the current balance for each of your Monarch accounts that you have mapped. These balances are used solely to update ProjectionLab and are not stored persistently. Sync history (timestamps, account names, and balance amounts) is stored locally in Chrome's extension storage for your own reference and is never transmitted to any external server other than ProjectionLab.

**ProjectionLab API key**  
Your ProjectionLab Plugin API key is stored in Chrome's extension storage (`chrome.storage`). It is used exclusively to authenticate update requests to ProjectionLab's Plugin API. It is never sent to any server other than `app.projectionlab.com`.

**Account mappings**  
Your configured mappings between Monarch and ProjectionLab accounts are stored in Chrome's extension storage. These sync across your Chrome profiles if you are signed into Chrome (this is standard Chrome sync behavior). They are not transmitted to any external server.

---

## What Chrysalis does NOT do

- Does not collect, store, or transmit your Monarch username or password
- Does not send any data to servers owned or operated by the Chrysalis developer
- Does not use your data for advertising, analytics, or any purpose other than performing the sync you initiate
- Does not share your data with any third parties
- Does not use your financial data to assess creditworthiness or for any purpose other than updating your ProjectionLab account balances

---

## Data flow summary

| Data | Where it comes from | Where it goes | Stored? |
|------|-------------------|--------------|---------|
| Session token | Monarch tab (`localStorage`) | Monarch API | No |
| Account balances | Monarch API | ProjectionLab API | Sync history only, locally |
| ProjectionLab API key | You (setup) | ProjectionLab API | Yes, in `chrome.storage` |
| Account mappings | You (setup) | Nowhere | Yes, in `chrome.storage` |

---

## Third-party services

Chrysalis communicates with two external services, both at your direction:

- **Monarch Money** (`api.monarchmoney.com`) — to fetch your account balances
- **ProjectionLab** (`app.projectionlab.com`) — to update your account balances via the official Plugin API

Use of these services is governed by their own privacy policies. Chrysalis is not affiliated with or endorsed by either service.

---

## Data retention

Sync history is stored locally in Chrome's extension storage indefinitely, unless you configure a TTL in the Advanced settings or manually delete it. You can clear all stored data at any time from the Advanced section of the setup page.

---

## Your rights

You can view, export, or delete all data Chrysalis stores at any time:
- **View/export mappings**: Advanced → Back up mappings (downloads as JSON)
- **Clear sync history**: Advanced → Clear cache
- **Delete everything**: Advanced → Reset Everything

---

## Limited Use

The use of information accessed by Chrysalis is limited to providing the sync functionality described in this policy. Chrysalis does not transfer, sell, or use your data for any purpose beyond the single stated purpose of syncing your Monarch Money balances to ProjectionLab.

The use of information received from any API will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

---

## Changes to this policy

If this policy changes materially, the "Last updated" date above will be updated. Continued use of the extension after any update constitutes acceptance of the revised policy.

---

## Contact

Chrysalis is an independent open-source project. For questions or concerns, open an issue at [github.com/tyler-class/Chrysalis](https://github.com/tyler-class/Chrysalis).
