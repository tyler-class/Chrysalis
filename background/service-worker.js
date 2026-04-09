/**
 * Background service worker — Chrysalis: syncs Monarch → ProjectionLab.
 * Tries HTTP API first (key-only auth; request visible in extension's Network tab).
 * Falls back to in-page API if HTTP is not available.
 */

// Supported ProjectionLab origins. Order matters: ea.* is preferred (EA gets
// preferential treatment when both origins accept the same key). Setup probes
// and HTTP-fallback both honor this order.
const PL_ORIGINS = [
  'https://ea.projectionlab.com',
  'https://app.projectionlab.com',
];
const MONARCH_ORIGIN = 'https://app.monarch.com';
function buildPLUpdateHttpUrl(origin) {
  return origin + '/api/plugin/updateAccount';
}
function plOriginForUrl(url) {
  return PL_ORIGINS.find((o) => typeof url === 'string' && url.startsWith(o)) || null;
}
const AUTO_SYNC_ALARM = 'chrysalis-auto-sync';

/**
 * Data for updateAccount(accountId, data, options). PL does Object.assign(account, data).
 * Minimal payload: only the value field, no balanceType/amountType.
 * - Debt: amount as absolute value
 * - Asset (incl. asset-with-loan types): balance or assessedValue+balance
 * - Savings, investment, etc.: balance only
 */
function buildPayload(plType, plNativeType, balance) {
  const num = Number(balance);
  const type = (plType || 'asset').toLowerCase();
  if (type === 'debt') {
    return { amount: Math.abs(num) };
  }
  if (type === 'asset') {
    return { balance: Math.abs(num) };
  }
  return { balance: num };
}

const PL_ASSET_WITH_LOAN_TYPES = new Set([
  'land',
  'car',
  'vehicle',
  'auto',
  'real-estate',
  'building',
  'motorcycle',
  'boat',
  'jewelry',
  'precious-metals',
  'furniture',
  'instrument',
  'machinery',
  'other',
]);
function isAssetWithLoanMapping(mapping) {
  const t = (mapping.plNativeType || '').toLowerCase().replace(/_/g, '-');
  for (const key of PL_ASSET_WITH_LOAN_TYPES) { if (t === key || t.indexOf(key) !== -1) return true; }
  return false;
}

function buildPayloadAssetWithLoan(update) {
  const payload = {};
  if (update.hasValue) {
    const v = Math.abs(Number(update.valueSum) || 0);
    payload.amount = v;
  }
  if (update.hasLoan) payload.balance = Math.abs(Number(update.loanSum) || 0);
  return payload;
}

async function findPLTab() {
  const tabs = await chrome.tabs.query({ url: PL_ORIGINS.map((o) => o + '/*') });
  if (!tabs.length) return null;
  const originIndex = (url) => {
    const idx = PL_ORIGINS.findIndex((o) => typeof url === 'string' && url.startsWith(o));
    return idx === -1 ? PL_ORIGINS.length : idx;
  };
  const prefer = (t) => t.url && !t.url.includes('/docs') && !t.url.includes('/settings');
  // Primary sort: PL_ORIGINS order (ea.* before app.*). Secondary: most recently accessed.
  const sorted = [...tabs].sort((a, b) => {
    const ai = originIndex(a.url);
    const bi = originIndex(b.url);
    if (ai !== bi) return ai - bi;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });
  const main = sorted.find(prefer) || sorted[0];
  if (!main) return null;
  const origin = plOriginForUrl(main.url) || PL_ORIGINS[0];
  return { tab: main, origin };
}

async function findMonarchTab() {
  const tabs = await chrome.tabs.query({ url: MONARCH_ORIGIN + '/*' });
  if (!tabs.length) return null;
  const sorted = [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return sorted[0] || null;
}

/**
 * Update one account via HTTP. Sends force: true so the server skips the "property must exist on account" check
 * (same as in-page options.force — allows assigning balance/balanceType or amount/amountType even if strict check would fail).
 */
async function updateViaHttp(apiKey, plId, data, origin) {
  // Coerce accountId to string — PL validates strictly, and EA can return
  // numeric IDs that got persisted into the mapping as numbers.
  const body = { accountId: String(plId), key: apiKey, force: true, ...data };
  const res = await fetch(buildPLUpdateHttpUrl(origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (typeof console !== 'undefined' && console.log) {
    console.log('[Chrysalis] HTTP', res.status, plId, body, text.slice(0, 200));
  }
  if (!res.ok) {
    return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 150)}` };
  }
  return { success: true };
}

/**
 * Run updateAccount in the page context. Each update has { plId, data } (data built by buildPayload).
 * Returns array of { plId, success, error }.
 */
async function runPLUpdatesInTab(plTabId, updatesWithPayload, apiKey) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: plTabId },
    world: 'MAIN',
    func: async (updatesJson, key) => {
      const updates = JSON.parse(updatesJson);
      const options = { key: key, force: true };
      const out = [];
      const debugInfo = { lastRun: Date.now(), updateCount: updates.length, logs: [] };
      try { window.__monarchPlSyncDebug = debugInfo; } catch (_) {}
      // Try multiple updateAccount call shapes to handle signature variation
      // between app.* (positional: updateAccount(id, data, options)) and ea.*
      // (which reports "Invalid accountId: must be a string" on positional calls,
      // suggesting a single-object shape). We try the known-good positional form
      // first, then two common object shapes, and return the first that succeeds.
      const updateFn = window.projectionlabPluginAPI && window.projectionlabPluginAPI.updateAccount;
      for (const u of updates) {
        try {
          if (typeof updateFn !== 'function') {
            out.push({ plId: u.plId, success: false, error: 'Plugin API or updateAccount not available' });
            continue;
          }
          const data = u.data || { balance: Number(u.balance) };
          // PL validates accountId strictly. EA returns numeric IDs for at
          // least some categories, so coerce defensively.
          const accountId = String(u.plId);
          debugInfo.logs.push({ plId: accountId, data, t: Date.now() });

          const callForms = [
            { name: 'positional', args: [accountId, data, options] },
            { name: 'object+options', args: [{ accountId: accountId, ...data }, options] },
            { name: 'single-object', args: [{ accountId: accountId, key: options.key, force: options.force, ...data }] },
          ];
          let returnValue;
          let usedForm = null;
          let lastErr = null;
          for (const form of callForms) {
            try {
              returnValue = await updateFn.apply(window.projectionlabPluginAPI, form.args);
              usedForm = form.name;
              lastErr = null;
              break;
            } catch (e) {
              lastErr = e;
            }
          }
          if (usedForm) {
            out.push({ plId: u.plId, success: true, debug: { callForm: usedForm, accountId, data, returnValue } });
          } else {
            // All call shapes failed. Include the updateAccount function source so we can
            // see the real signature and add a matching form on the next iteration.
            let fnSrc = '';
            try {
              fnSrc = typeof updateFn.toString === 'function' ? updateFn.toString().slice(0, 400) : '';
            } catch (_) {}
            const fnLen = typeof updateFn.length === 'number' ? updateFn.length : -1;
            const baseMsg = lastErr && lastErr.message ? lastErr.message : String(lastErr);
            out.push({
              plId: u.plId,
              success: false,
              error: `${baseMsg} | tried all call forms | updateFn.length=${fnLen} | updateFn.src=${fnSrc}`,
            });
          }
        } catch (e) {
          out.push({ plId: u.plId, success: false, error: e.message || String(e) });
        }
      }
      try {
        const toast = document.createElement('div');
        toast.id = 'monarch-pl-sync-toast';
        toast.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999999;background:#181c27;color:#34d58e;border:1px solid #34d58e;padding:12px 16px;border-radius:8px;font-family:system-ui,sans-serif;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
        toast.textContent = 'Chrysalis ran • ' + out.filter(function(r){ return r.success; }).length + '/' + updates.length + ' updated';
        document.body.appendChild(toast);
        setTimeout(function() { try { toast.remove(); } catch(_){} }, 5000);
      } catch (_) {}
      return out;
    },
    args: [JSON.stringify(updatesWithPayload), apiKey],
  });
  const payload = results && results[0] && results[0].result;
  return Array.isArray(payload) ? payload : [];
}

/**
 * Normalize accountMappings to new schema: array of { plId, plName, monarchAccounts: [{ id, name }] }.
 * Migrates old flat schema (monarchId, monarchName at top level) by grouping by plId.
 */
function normalizeMappings(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const hasNewSchema = raw.some(
    (m) =>
      Array.isArray(m.monarchAccounts) ||
      Array.isArray(m.monarchAccountsLoan)
  );
  if (hasNewSchema) {
    return raw.map((m) => ({
      plId: m.plId,
      plName: m.plName || m.plId,
      plType: m.plType || 'asset',
      plNativeType: m.plNativeType || '',
      monarchAccounts: Array.isArray(m.monarchAccounts)
        ? m.monarchAccounts.map((a) => ({ id: a.id, name: a.name || a.id }))
        : [],
      monarchAccountsLoan: Array.isArray(m.monarchAccountsLoan)
        ? m.monarchAccountsLoan.map((a) => ({ id: a.id, name: a.name || a.id }))
        : [],
    }));
  }
  const byPlId = new Map();
  for (const m of raw) {
    const plId = m.plId;
    if (!plId) continue;
    if (!byPlId.has(plId)) {
      byPlId.set(plId, { plId, plName: m.plName || plId, plType: m.plType || 'asset', plNativeType: m.plNativeType || '', monarchAccounts: [], monarchAccountsLoan: [] });
    }
    const entry = byPlId.get(plId);
    const mid = m.monarchId || m.monarchAccountId;
    const mname = m.monarchName || m.monarchAccountName || mid;
    if (mid && !entry.monarchAccounts.some((a) => a.id === mid)) {
      entry.monarchAccounts.push({ id: mid, name: mname });
    }
  }
  return Array.from(byPlId.values());
}

/**
 * Run full sync using the given Monarch tab ID (for fetching balances).
 * Returns { success, partialSuccess?, results?, error? }.
 */
async function runSyncWithTabId(tabId) {
  const sync = await chrome.storage.sync.get(['plApiKey', 'accountMappings']);
    const plApiKey = sync.plApiKey;
    const rawMappings = sync.accountMappings;
    const accountMappings = normalizeMappings(rawMappings || []);

    if (!plApiKey || !plApiKey.trim()) {
      return { success: false, error: 'ProjectionLab API key not configured' };
    }
    if (accountMappings.length === 0) {
      return { success: false, error: 'No account mappings configured' };
    }

    const allMonarchIds = [
      ...new Set(
        accountMappings.flatMap((m) => [
          ...(m.monarchAccounts || []).map((a) => a.id),
          ...(m.monarchAccountsLoan || []).map((a) => a.id),
        ])
      ),
    ];

    let balanceResponse;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/monarch.js'],
      });
      balanceResponse = await chrome.tabs.sendMessage(tabId, {
        type: 'FETCH_BALANCES',
        accountIds: allMonarchIds,
      });
    } catch (e) {
      return {
        success: false,
        error: 'Could not reach Monarch tab. Ensure app.monarch.com is open and refreshed.',
      };
    }

    if (!balanceResponse || !balanceResponse.success) {
      return {
        success: false,
        error: balanceResponse?.error || 'Failed to fetch Monarch balances',
      };
    }

    const balanceMap = {};
    for (const acc of balanceResponse.accounts || []) {
      const num = parseFloat(acc.balance);
      balanceMap[acc.id] = Number.isNaN(num) ? 0 : num;
    }

    const results = [];
    let partialSuccess = false;
    const updatesToRun = [];

    for (const mapping of accountMappings) {
      const isDual = isAssetWithLoanMapping(mapping);
      const monarchAccounts = mapping.monarchAccounts || [];
      const monarchAccountsLoan = mapping.monarchAccountsLoan || [];

      if (isDual) {
        let valueSum = 0;
        let loanSum = 0;
        const valueFound = [];
        const loanFound = [];
        const missing = [];
        for (const ma of monarchAccounts) {
          if (ma.id in balanceMap) {
            valueFound.push(ma);
            valueSum += balanceMap[ma.id];
          } else {
            missing.push((ma.name || ma.id) + ' (value)');
          }
        }
        for (const ma of monarchAccountsLoan) {
          if (ma.id in balanceMap) {
            loanFound.push(ma);
            loanSum += balanceMap[ma.id];
          } else {
            missing.push((ma.name || ma.id) + ' (loan)');
          }
        }
        if (valueFound.length === 0 && loanFound.length === 0) {
          results.push({
            plName: mapping.plName,
            plId: mapping.plId,
            plType: mapping.plType || 'asset',
            plNativeType: mapping.plNativeType || '',
            monarchAccounts: monarchAccounts.map((a) => a.name),
            aggregatedBalance: 0,
            isAggregated: false,
            success: false,
            error: missing.length ? `No Monarch accounts found: ${missing.join(', ')}` : 'No Monarch accounts mapped for this asset-with-loan row.',
          });
          continue;
        }
        let warning;
        if (missing.length > 0) {
          warning = `Some sources missing: ${missing.join(', ')}. Synced the rest.`;
          partialSuccess = true;
        }
        updatesToRun.push({
          plId: mapping.plId,
          isAssetWithLoan: true,
          valueSum,
          loanSum,
          hasValue: valueFound.length > 0,
          hasLoan: loanFound.length > 0,
        });
        results.push({
          plName: mapping.plName,
          plId: mapping.plId,
          plType: mapping.plType || 'asset',
          plNativeType: mapping.plNativeType || '',
          monarchAccounts: [...valueFound, ...loanFound].map((a) => a.name),
          aggregatedBalance: valueSum + loanSum,
          isAggregated: monarchAccounts.length + monarchAccountsLoan.length > 1,
          valueSum,
          loanSum,
          success: false,
          warning,
        });
        continue;
      }

      const found = [];
      const missing = [];
      let aggregatedBalance = 0;

      for (const ma of monarchAccounts) {
        if (ma.id in balanceMap) {
          found.push(ma);
          aggregatedBalance += balanceMap[ma.id];
        } else {
          missing.push(ma.name || ma.id);
        }
      }

      if (found.length === 0) {
        results.push({
          plName: mapping.plName,
          plId: mapping.plId,
          plType: mapping.plType || 'asset',
          plNativeType: mapping.plNativeType || '',
          monarchAccounts: monarchAccounts.map((a) => a.name),
          aggregatedBalance: 0,
          isAggregated: monarchAccounts.length > 1,
          success: false,
          error: `No Monarch accounts found: ${missing.join(', ')}`,
        });
        continue;
      }

      let warning;
      if (missing.length > 0) {
        warning = `Some sources missing: ${missing.join(', ')}. Synced the rest.`;
        partialSuccess = true;
      }

      const balance = Number(aggregatedBalance);
      const plType = (mapping.plType || 'asset').toLowerCase();
      const plNativeType = (mapping.plNativeType || '').toLowerCase();
      if (balance !== null && !Number.isNaN(balance)) {
        updatesToRun.push({ plId: mapping.plId, balance, plType, plNativeType });
      }
      results.push({
        plName: mapping.plName,
        plId: mapping.plId,
        plType: mapping.plType || 'asset',
        plNativeType: mapping.plNativeType || '',
        monarchAccounts: found.map((a) => a.name),
        aggregatedBalance,
        isAggregated: monarchAccounts.length > 1,
        success: false,
        warning,
      });
    }

    const updatesWithPayload = updatesToRun.map((u) => {
      if (u.isAssetWithLoan) {
        return {
          plId: u.plId,
          data: buildPayloadAssetWithLoan(u),
        };
      }
      return {
        plId: u.plId,
        balance: u.balance,
        data: buildPayload(u.plType, u.plNativeType, u.balance),
      };
    });

    let plResults = [];
    let lastSyncMethod = 'none';
    let plTabUrl = null;
    if (updatesToRun.length > 0) {
      const found = await findPLTab();
      if (found) {
        const { tab: plTab, origin } = found;
        lastSyncMethod = 'in-page (PL tab)';
        plTabUrl = plTab.url || null;
        plResults = await runPLUpdatesInTab(plTab.id, updatesWithPayload, plApiKey);
        // Persist the origin we just synced against so HTTP fallback on future runs
        // knows which instance to hit.
        try { await chrome.storage.local.set({ plOrigin: origin }); } catch (_) {}
      } else {
        // No PL tab open — fall back to HTTP. Prefer the cached origin (set by
        // a previous successful in-page sync or by setup's detectPLOrigin).
        // If no cache exists, default to app.* to match legacy behavior — this
        // protects existing app.* users whose extension has never written
        // plOrigin (e.g. right after upgrading from a pre-EA version).
        const { plOrigin: cachedOrigin } = await chrome.storage.local.get(['plOrigin']);
        const httpOrigin =
          cachedOrigin && PL_ORIGINS.includes(cachedOrigin)
            ? cachedOrigin
            : 'https://app.projectionlab.com';
        lastSyncMethod = `HTTP ${httpOrigin} (no PL tab; see extension service worker Network)`;
        for (const u of updatesWithPayload) {
          const hr = await updateViaHttp(plApiKey, u.plId, u.data, httpOrigin);
          plResults.push({ plId: u.plId, success: hr.success, error: hr.error });
        }
      }
    }
    const byPlId = new Map(plResults.map((r) => [r.plId, r]));
    const payloadByPlId = new Map(updatesWithPayload.map((u) => [u.plId, u.data]));

    // Tally which updateAccount call shapes succeeded this run so the service
    // worker console and the persisted sync history both make it visible.
    // This is how we'll learn which EA signature wins without the user having
    // to keep DevTools attached across a service-worker sleep.
    const callFormTally = {};
    for (const pr of plResults) {
      const form = pr && pr.debug && pr.debug.callForm;
      if (form) callFormTally[form] = (callFormTally[form] || 0) + 1;
    }
    try {
      console.log(
        '[Chrysalis] sync result:',
        plResults.filter((r) => r.success).length + '/' + plResults.length,
        'updated. Call forms used:',
        callFormTally,
        'Method:', lastSyncMethod
      );
    } catch (_) {}

    for (const r of results) {
      if (r.plId == null) continue;
      const pr = byPlId.get(r.plId);
      if (pr) {
        r.success = pr.success;
        if (!pr.success && pr.error) r.error = pr.error;
        if (pr.debug && pr.debug.callForm) r.callForm = pr.debug.callForm;
      }
    }

    const allSuccess = results.every((r) => r.success);
    const successCount = results.filter((r) => r.success).length;
    const total = results.length;
    const firstError = results.find((r) => r.error);
    const lastSyncDebug = {
      method: lastSyncMethod,
      plTabUrl: plTabUrl || undefined,
      callFormTally: Object.keys(callFormTally).length ? callFormTally : undefined,
      updates: results
        .filter((r) => r.plId != null)
        .map((r) => ({
          plName: r.plName,
          plId: r.plId,
          balance: r.aggregatedBalance,
          // Include accountId in the payload display so the debug column shows
          // the full set of fields being sent to updateAccount, not just data.
          payload: {
            accountId: String(r.plId),
            ...(payloadByPlId.get(r.plId) || buildPayload(r.plType, r.plNativeType, r.aggregatedBalance)),
          },
          callForm: r.callForm || undefined,
          success: r.success,
          error: r.error || null,
        })),
    };
    const now = Date.now();
    const { syncHistoryRetentionDays } = await chrome.storage.sync.get(['syncHistoryRetentionDays']).then((s) => s || {});
    const retentionMs =
      typeof syncHistoryRetentionDays === 'number' && syncHistoryRetentionDays >= 1
        ? syncHistoryRetentionDays * 24 * 60 * 60 * 1000
        : null;
    const { syncHistory: prevHistory = [] } = await chrome.storage.local.get(['syncHistory']);
    const appended = [...prevHistory, {
      time: now,
      successCount,
      total,
      error: allSuccess ? null : (firstError?.error || (successCount > 0 ? 'Partial failure' : 'Sync failed')),
      results: results.map((r) => ({
        plId: r.plId,
        plName: r.plName,
        success: r.success,
        error: r.error || null,
        aggregatedBalance: r.aggregatedBalance,
        monarchAccounts: r.monarchAccounts || [],
        isAggregated: r.isAggregated,
        warning: r.warning || null,
        valueSum: typeof r.valueSum === 'number' ? r.valueSum : null,
        loanSum: typeof r.loanSum === 'number' ? r.loanSum : null,
      })),
      debug: lastSyncDebug,
    }];
    const syncHistory =
      retentionMs != null ? appended.filter((e) => now - e.time <= retentionMs) : appended;
    await chrome.storage.local.set({
      lastSyncTime: now,
      lastSyncResults: results,
      lastSyncDebug,
      syncHistory,
    });

  return {
    success: allSuccess,
    partialSuccess: partialSuccess || (results.some((r) => r.success) && !allSuccess),
    results,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'RUN_SYNC') {
    return false;
  }
  const tabId = message.tabId;
  if (tabId == null) {
    sendResponse({ success: false, error: 'Missing tabId' });
    return true;
  }
  runSyncWithTabId(tabId)
    .then(sendResponse)
    .catch((err) => {
      console.error('[Chrysalis]', err.message || err);
      sendResponse({ success: false, error: err.message || String(err) });
    });
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTO_SYNC_ALARM) return;
  const monarchTab = await findMonarchTab();
  if (!monarchTab) return;
  try {
    await runSyncWithTabId(monarchTab.id);
  } catch (e) {
    console.error('[Chrysalis] auto-sync', e.message || e);
  }
  scheduleAutoSync(); // schedule next run
});

/**
 * Compute next run timestamp (ms) from now. Uses local time.
 * sync: { autoSyncFrequency, autoSyncDayOfWeek 0-6, autoSyncDayOfMonth 1-28, autoSyncTimeHour 0-23, autoSyncTimeMinute 0-59 }
 */
function getNextRunTs(now, sync) {
  const freq = sync.autoSyncFrequency || 'daily';
  const dayOfWeek = Math.max(0, Math.min(6, parseInt(sync.autoSyncDayOfWeek, 10) || 0));
  const dayOfMonth = Math.max(1, Math.min(28, parseInt(sync.autoSyncDayOfMonth, 10) || 1));
  const hour = Math.max(0, Math.min(23, parseInt(sync.autoSyncTimeHour, 10) || 9));
  const minute = Math.max(0, Math.min(59, parseInt(sync.autoSyncTimeMinute, 10) || 0));

  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);

  if (freq === 'daily') {
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  if (freq === 'weekly') {
    const currentDOW = next.getDay();
    let daysToAdd = dayOfWeek - currentDOW;
    if (daysToAdd < 0) daysToAdd += 7;
    if (daysToAdd === 0 && next.getTime() <= now.getTime()) daysToAdd = 7;
    next.setDate(next.getDate() + daysToAdd);
    return next.getTime();
  }

  if (freq === 'monthly') {
    next.setDate(Math.min(dayOfMonth, 28));
    if (next.getTime() <= now.getTime()) next.setMonth(next.getMonth() + 1);
    return next.getTime();
  }

  if (freq === 'quarterly') {
    const qMonths = [0, 3, 6, 9]; // Jan, Apr, Jul, Oct
    const yr = now.getFullYear();
    for (const m of qMonths) {
      const d = new Date(yr, m, Math.min(dayOfMonth, 28), hour, minute, 0, 0);
      if (d.getTime() > now.getTime()) return d.getTime();
    }
    return new Date(yr + 1, 0, Math.min(dayOfMonth, 28), hour, minute, 0, 0).getTime();
  }

  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function scheduleAutoSync() {
  chrome.storage.sync.get(
    [
      'autoSyncEnabled',
      'autoSyncFrequency',
      'autoSyncDayOfWeek',
      'autoSyncDayOfMonth',
      'autoSyncTimeHour',
      'autoSyncTimeMinute',
    ],
    (sync) => {
      chrome.alarms.clear(AUTO_SYNC_ALARM);
      if (!sync.autoSyncEnabled || !sync.autoSyncFrequency) return;
      const when = getNextRunTs(new Date(), sync);
      chrome.alarms.create(AUTO_SYNC_ALARM, { when });
    }
  );
}

chrome.runtime.onStartup.addListener(scheduleAutoSync);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  const keys = [
    'autoSyncEnabled',
    'autoSyncFrequency',
    'autoSyncDayOfWeek',
    'autoSyncDayOfMonth',
    'autoSyncTimeHour',
    'autoSyncTimeMinute',
  ];
  if (!keys.some((k) => changes[k])) return;
  scheduleAutoSync();
});

scheduleAutoSync();
