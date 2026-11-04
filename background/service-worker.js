/**
 * Background service worker — Chrysalis: syncs Monarch → ProjectionLab.
 * Balances are read through an open, signed-in Monarch tab and written through the plugin API
 * on an open, signed-in ProjectionLab tab. There is no background or scheduled sync.
 */

import '../shared/mapping-storage.js';
import '../shared/mapping-model.js';

const Model = globalThis.ChrysalisMappingModel;

// ProjectionLab origins. By default Chrysalis only uses the standard app.*
// instance. Early Access users opt in via the setup toggle
// (chrome.storage.sync.plUseEarlyAccess), which makes ea.* the preferred origin
// with app.* kept as a fallback. ALL_PL_ORIGINS is the full set, used only to
// recognize a PL URL regardless of the user's preference.
const APP_PL_ORIGIN = 'https://app.projectionlab.com';
const EA_PL_ORIGIN = 'https://ea.projectionlab.com';
const ALL_PL_ORIGINS = [EA_PL_ORIGIN, APP_PL_ORIGIN];
async function getPlOrigins() {
  const { plUseEarlyAccess } = await chrome.storage.sync.get(['plUseEarlyAccess']);
  return plUseEarlyAccess ? [EA_PL_ORIGIN, APP_PL_ORIGIN] : [APP_PL_ORIGIN];
}
const MONARCH_ORIGIN = 'https://app.monarch.com';
function plOriginForUrl(url) {
  return ALL_PL_ORIGINS.find((o) => typeof url === 'string' && url.startsWith(o)) || null;
}

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

const isAssetWithLoanMapping = Model.isAssetWithLoanMapping;

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
  const origins = await getPlOrigins();
  const tabs = await chrome.tabs.query({ url: origins.map((o) => o + '/*') });
  if (!tabs.length) return null;
  const originIndex = (url) => {
    const idx = origins.findIndex((o) => typeof url === 'string' && url.startsWith(o));
    return idx === -1 ? origins.length : idx;
  };
  const prefer = (t) => t.url && !t.url.includes('/docs') && !t.url.includes('/settings');
  // Primary sort: preferred-origin order (ea.* before app.* when Early Access is
  // enabled). Secondary: most recently accessed.
  const sorted = [...tabs].sort((a, b) => {
    const ai = originIndex(a.url);
    const bi = originIndex(b.url);
    if (ai !== bi) return ai - bi;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });
  const main = sorted.find(prefer) || sorted[0];
  if (!main) return null;
  const origin = plOriginForUrl(main.url) || origins[0];
  return { tab: main, origin };
}

async function findMonarchTab() {
  const tabs = await chrome.tabs.query({ url: MONARCH_ORIGIN + '/*' });
  if (!tabs.length) return null;
  const sorted = [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return sorted[0] || null;
}

/**
 * Which plugin API contract a ProjectionLab tab serves, checked fresh on every sync (never cached
 * or inferred from the hostname). V5 (`version: 2`) also returns a fresh getAccounts() list, which
 * decides each write's field and catches archived or deleted accounts before anything is written.
 * Resolves to { contract, accounts? } or { error }.
 */
async function connectPLTab(plTabId, apiKey) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: plTabId },
      world: 'MAIN',
      func: async (key) => {
        const api = window.projectionlabPluginAPI;
        if (!api) return { error: 'Plugin API not available' };
        const contract = api.version == null ? 1 : api.version;
        if (contract !== 2) return { contract };
        try {
          const list = await api.getAccounts({ key: key });
          return {
            contract,
            rawAccounts: (Array.isArray(list) ? list : []).map((a) => ({
              id: a.id, name: a.name, kind: a.kind, type: a.type, subtype: a.subtype, securedByAssetId: a.securedByAssetId,
            })),
          };
        } catch (e) {
          return { contract, error: e.message || String(e) };
        }
      },
      args: [apiKey],
    });
  } catch (e) {
    return { error: e.message || String(e) };
  }
  const payload = results && results[0] && results[0].result;
  if (!payload) return { error: 'Could not run script on the ProjectionLab tab' };
  if (payload.rawAccounts) {
    payload.accounts = payload.rawAccounts.map(Model.normalizeV5Account).filter(Boolean);
    delete payload.rawAccounts;
  }
  return payload;
}

/**
 * V5 writes: one updateAccountValues() call per planned write, with no retries and never through
 * the V4 path. Re-checks the contract first in case the tab reloaded onto a different version.
 * writes: [{ plId, values }] from Model.planV5Writes. Returns [{ plId, success, error? }].
 */
async function runPLV5WritesInTab(plTabId, writes, apiKey) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: plTabId },
    world: 'MAIN',
    func: async (writesJson, key) => {
      const writes = JSON.parse(writesJson);
      const api = window.projectionlabPluginAPI;
      if (!api || api.version !== 2 || typeof api.updateAccountValues !== 'function') {
        const error = 'ProjectionLab changed plugin API versions during the sync. Nothing was written. Sync again.';
        return writes.map((w) => ({ plId: w.plId, success: false, error }));
      }
      const out = [];
      for (const w of writes) {
        try {
          await api.updateAccountValues({ accountId: String(w.plId), values: w.values, key: key });
          out.push({ plId: w.plId, success: true });
        } catch (e) {
          out.push({ plId: w.plId, success: false, error: e.message || String(e) });
        }
      }
      try {
        const toast = document.createElement('div');
        toast.id = 'monarch-pl-sync-toast';
        toast.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999999;background:#181c27;color:#34d58e;border:1px solid #34d58e;padding:12px 16px;border-radius:8px;font-family:system-ui,sans-serif;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
        toast.textContent = 'Chrysalis ran • ' + out.filter(function (r) { return r.success; }).length + '/' + writes.length + ' updated';
        document.body.appendChild(toast);
        setTimeout(function () { try { toast.remove(); } catch (_) {} }, 5000);
      } catch (_) {}
      return out;
    },
    args: [JSON.stringify(writes), apiKey],
  });
  const payload = results && results[0] && results[0].result;
  return Array.isArray(payload) ? payload : writes.map((w) => ({ plId: w.plId, success: false, error: 'No result from the ProjectionLab tab' }));
}

/**
 * Run updateAccount in the page context (plugin API V4 only). Each update has { plId, data } (data built by buildPayload).
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

const USD_CENTS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** One Monarch source of a row, as stored in sync history. Amounts are in dollars. */
function describeSourceForHistory(src) {
  return {
    monarchId: src.sourceId,
    name: src.name,
    pct: src.isSplit ? src.pct : null,
    balance: typeof src.balance === 'number' ? src.balance : null,
    amount: typeof src.amountCents === 'number' ? src.amountCents / 100 : null,
    roundingCents: src.roundingCents || 0,
    status: src.status,
  };
}

function blockedSplitMessage(b) {
  if (b.reason === 'invalid') {
    return `${b.name} has a split share with no percentage, probably because an older version of Chrysalis re-saved your mappings. Re-enter its shares in Setup. Nothing was written to this account.`;
  }
  return `${b.name} is split ${Model.formatPct(b.totalPct)}. A Monarch account's shares can't total more than 100%. Fix the split in Setup. Nothing was written to this account.`;
}

/** Split settings as they were at sync time, so old runs stay explainable after edits. */
function buildSplitSnapshot(allocations, balanceMap, splitMeta) {
  const out = [];
  for (const entry of allocations.values()) {
    if (!entry.isSplit) continue;
    out.push({
      monarchId: entry.sourceId,
      name: entry.name,
      balance: entry.sourceId in balanceMap ? balanceMap[entry.sourceId] : null,
      totalPct: entry.total,
      state: Model.allocationState(entry),
      updatedAt: (splitMeta[entry.sourceId] && splitMeta[entry.sourceId].updatedAt) || null,
      shares: entry.legs
        .filter((l) => !l.dual)
        .map((l) => ({ plId: l.plId, plName: l.plName, pct: Model.shareOf(l.chip) })),
    });
  }
  return out.length ? out : null;
}

/**
 * Run full sync using the given Monarch tab ID (for fetching balances).
 * Returns { success, partialSuccess?, results?, error? }.
 */
/**
 * Before a sync: if the open ProjectionLab tab serves the newer account format, move two-lane
 * asset + loan rows to one account per row and save them, keeping the old rows as a backup and
 * leaving the same notice Setup shows. Returns null when there's nothing to move (no ProjectionLab
 * tab, older format, or no two-lane rows). Otherwise { mappings, summary, unmatched }, where
 * `unmatched` holds the new loan rows that still need a ProjectionLab account picked in Setup.
 */
async function migrateLoanRowsBeforeSync(accountMappings, splitMeta, plApiKey) {
  const found = await findPLTab();
  if (!found) return null;
  const conn = await connectPLTab(found.tab.id, plApiKey);
  if (conn.error || conn.contract !== Model.PL_CONTRACT_V5 || !conn.accounts) return null;
  const plan = Model.planV5LoanMigration(accountMappings, conn.accounts, splitMeta, {
    extensionVersion: chrome.runtime.getManifest().version,
  });
  if (!plan) return null;
  // Backup first, so the old rows can always be downloaded even if saving the new ones fails.
  await chrome.storage.local.set({ mappingsBackupBeforeLoanUpdate: { savedAt: Date.now(), backup: plan.backup } });
  await globalThis.ChrysalisMappingStorage.saveMappings(Model.serializeMappings(plan.mappings));
  await chrome.storage.local.set({
    // `source: 'sync'` tells an open Setup page to reload instead of keeping the old rows.
    loanUpdateNotice: { at: Date.now(), source: 'sync', ...plan.summary },
    // Setup lists ProjectionLab accounts from this cache; keep it in the same format as the rows.
    cachedPLAccounts: conn.accounts,
  });
  await chrome.storage.local.remove(['plAccountUpdateNeeded']);
  const before = new Set(accountMappings);
  const unmatched = new Set(plan.mappings.filter((m) => !before.has(m) && !m.plId));
  return { mappings: plan.mappings, summary: plan.summary, unmatched };
}

async function runSyncWithTabId(tabId) {
  let sync;
  let rawMappings;
  let splitMeta = {};
  try {
    [sync, rawMappings] = await Promise.all([
      chrome.storage.sync.get(['plApiKey']),
      globalThis.ChrysalisMappingStorage.loadMappings(),
    ]);
  } catch (e) {
    return {
      success: false,
      error: `Could not load account mappings: ${e.message || String(e)}`,
    };
  }
  try {
    splitMeta = await globalThis.ChrysalisMappingStorage.loadSplitMeta();
  } catch (e) {
    // Notes only feed the history snapshot; a failed read must not block the sync.
    console.warn('[Chrysalis] Could not load split notes:', e);
  }
    const plApiKey = sync.plApiKey;
    let accountMappings = Model.normalizeMappings(rawMappings || []);

    if (!plApiKey || !plApiKey.trim()) {
      return { success: false, error: 'ProjectionLab API key not configured' };
    }
    if (accountMappings.length === 0) {
      return { success: false, error: 'No account mappings configured' };
    }

    // ProjectionLab's newer account format keeps each loan as its own account. If two-lane
    // asset + loan rows are still saved, move them now (the same way Setup does) so this sync
    // writes loans to their own accounts instead of skipping them.
    let loanMigration = null;
    if (accountMappings.some((m) => isAssetWithLoanMapping(m))) {
      try {
        loanMigration = await migrateLoanRowsBeforeSync(accountMappings, splitMeta, plApiKey);
        if (loanMigration) accountMappings = loanMigration.mappings;
      } catch (e) {
        // Not fatal: the old rows still sync safely (asset value only) and the popup says why.
        console.warn('[Chrysalis] Could not move loans to their own rows before syncing:', e);
      }
    }

    // Nothing syncs while a split account's shares don't total 100% (this also covers
    // auto-sync, which never goes through the popup).
    const unbalanced = Model.unbalancedSplits(accountMappings);
    if (unbalanced.length) {
      return {
        success: false,
        blockedBySplits: true,
        error: `Sync is paused until every split account totals 100%: ${unbalanced.map(Model.describeUnbalancedSplit).join('; ')}. Fix the split in Setup → Map Accounts.`,
      };
    }

    // Split chips resolve to their underlying Monarch account id.
    const allMonarchIds = Model.allSourceIds(accountMappings);

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

    // Single-lane rows (including percentage splits) are planned by the shared model:
    // shares are allocated per Monarch account with cent-exact rounding.
    const { rows: plannedRows, allocations } = Model.planSync(accountMappings, balanceMap);
    const planByIndex = new Map(plannedRows.map((p) => [p.mappingIndex, p]));

    for (const [mappingIndex, mapping] of accountMappings.entries()) {
      // Rows without a ProjectionLab account are unfinished in Setup; skip them. A loan row that
      // was just moved but couldn't be matched to a ProjectionLab loan is reported instead.
      if (!mapping.plId) {
        if (loanMigration && loanMigration.unmatched.has(mapping)) {
          results.push({
            plName: mapping.title || 'Loan',
            plId: '',
            plType: 'debt',
            plNativeType: '',
            monarchAccounts: (mapping.monarchAccounts || []).map((a) => a.name),
            aggregatedBalance: 0,
            isAggregated: false,
            success: false,
            error: "This loan wasn't synced. Pick its ProjectionLab loan account in Setup → Map Accounts.",
          });
        }
        continue;
      }
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

      const plan = planByIndex.get(mappingIndex);
      const base = {
        plName: mapping.plName,
        plId: mapping.plId,
        plType: mapping.plType || 'asset',
        plNativeType: mapping.plNativeType || '',
        isAggregated: monarchAccounts.length > 1,
        sources: plan.sources.map(describeSourceForHistory),
      };
      const contributing = plan.sources.filter((src) => src.status === 'ok');

      if (plan.blocked.length > 0) {
        results.push({
          ...base,
          monarchAccounts: plan.sources.map((src) => src.label),
          aggregatedBalance: 0,
          success: false,
          error: plan.blocked.map(blockedSplitMessage).join(' '),
        });
        continue;
      }

      if (contributing.length === 0) {
        results.push({
          ...base,
          monarchAccounts: plan.sources.map((src) => src.label),
          aggregatedBalance: 0,
          success: false,
          error: plan.missing.length
            ? `No Monarch accounts found: ${plan.missing.join(', ')}`
            : 'Every share in this row is 0%, so nothing was written. Give it a share above 0% in Setup to sync it.',
        });
        continue;
      }

      const notes = [];
      if (plan.missing.length > 0) {
        notes.push(`Some sources missing: ${plan.missing.join(', ')}. Synced the rest.`);
        partialSuccess = true;
      }
      for (const name of plan.zero) notes.push(`${name} share is 0% and was skipped.`);
      for (const u of plan.under) {
        notes.push(`${u.name} is split ${Model.formatPct(u.totalPct)}. ${USD_CENTS.format(u.unallocatedCents / 100)} isn't synced to any account.`);
      }

      const balance = plan.amountCents / 100;
      const plType = (mapping.plType || 'asset').toLowerCase();
      const plNativeType = (mapping.plNativeType || '').toLowerCase();
      updatesToRun.push({ plId: mapping.plId, balance, plType, plNativeType });
      results.push({
        ...base,
        monarchAccounts: contributing.map((src) => src.label),
        aggregatedBalance: balance,
        success: false,
        warning: notes.length ? notes.join(' ') : undefined,
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
    let plContract = null;
    const v5ValuesByPlId = new Map(); // V5 writes, for the debug view
    let lastSyncMethod = 'none';
    let plTabUrl = null;
    if (updatesToRun.length > 0) {
      const found = await findPLTab();
      if (found) {
        const { tab: plTab, origin } = found;
        plTabUrl = plTab.url || null;
        const conn = await connectPLTab(plTab.id, plApiKey);
        plContract = conn.contract || null;
        lastSyncMethod = `in-page (PL tab${plContract ? `, plugin API v${plContract}` : ''})`;
        if (conn.error) {
          plResults = updatesWithPayload.map((u) => ({ plId: u.plId, success: false, error: conn.error }));
        } else if (conn.contract === Model.PL_CONTRACT_V4) {
          plResults = await runPLUpdatesInTab(plTab.id, updatesWithPayload, plApiKey);
        } else if (conn.contract === Model.PL_CONTRACT_V5) {
          // Two-lane asset + loan rows still exist: Setup moves them once it syncs ProjectionLab
          // accounts in the new format. Until then the popup shows a notice.
          if (updatesToRun.some((u) => u.isAssetWithLoan)) {
            try { await chrome.storage.local.set({ plAccountUpdateNeeded: true }); } catch (_) {}
          }
          const planned = Model.planV5Writes(updatesToRun, conn.accounts);
          const writes = planned.filter((p) => p.values);
          for (const p of writes) v5ValuesByPlId.set(p.plId, p.values);
          const written = writes.length ? await runPLV5WritesInTab(plTab.id, writes, plApiKey) : [];
          const writtenById = new Map(written.map((r) => [r.plId, r]));
          plResults = planned.map((p) => {
            const r = p.values ? (writtenById.get(p.plId) || { plId: p.plId, success: false, error: 'No result from the ProjectionLab tab' }) : { plId: p.plId, success: false, error: p.error };
            return p.warning ? { ...r, warning: p.warning } : r;
          });
        } else {
          const error = Model.unsupportedPlContractMessage(conn.contract);
          plResults = updatesWithPayload.map((u) => ({ plId: u.plId, success: false, error }));
        }
        // Remember the instance we just synced against; Setup's origin detection reuses it.
        try { await chrome.storage.local.set({ plOrigin: origin }); } catch (_) {}
      } else {
        // No ProjectionLab tab: nothing can be written. The popup only enables Sync Now once a
        // signed-in ProjectionLab tab is open, so this only happens if it closed mid-sync.
        lastSyncMethod = 'none (no ProjectionLab tab open)';
        const error = 'ProjectionLab isn\'t open. Open ProjectionLab in a tab, sign in, and sync again.';
        plResults = updatesWithPayload.map((u) => ({ plId: u.plId, success: false, error }));
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
        if (pr.warning) {
          r.warning = r.warning ? `${r.warning} ${pr.warning}` : pr.warning;
          partialSuccess = true;
        }
        if (pr.debug && pr.debug.callForm) r.callForm = pr.debug.callForm;
      }
    }

    const allSuccess = results.every((r) => r.success);
    const successCount = results.filter((r) => r.success).length;
    const total = results.length;
    const firstError = results.find((r) => r.error);
    const lastSyncDebug = {
      method: lastSyncMethod,
      plContract: plContract || undefined,
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
          payload: plContract === Model.PL_CONTRACT_V5
            ? { accountId: String(r.plId), values: v5ValuesByPlId.get(r.plId) || null } // updateAccountValues
            : {
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
        sources: Array.isArray(r.sources) ? r.sources : null,
      })),
      splits: buildSplitSnapshot(allocations, balanceMap, splitMeta),
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

// ---------- Sync readiness (the popup's two checks) ----------

// A signed-in Monarch result is reused briefly so the popup's polling doesn't query Monarch every
// few seconds.
const MONARCH_AUTH_CACHE_MS = 20000;
let monarchAuthCache = { tabId: null, at: 0 };

/** Monarch: a tab is open, and Monarch answers a signed-in request from it. */
async function checkMonarchReady() {
  const tab = await findMonarchTab();
  if (!tab) return { ok: false, reason: 'not_open' };
  if (/\/(login|signup|sign-in|signin)\b/i.test(tab.url || '')) return { ok: false, tabId: tab.id, reason: 'signed_out' };
  if (monarchAuthCache.tabId === tab.id && Date.now() - monarchAuthCache.at < MONARCH_AUTH_CACHE_MS) {
    return { ok: true, tabId: tab.id };
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-scripts/monarch.js'] });
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'CHECK_AUTH' });
    if (res && res.success) {
      monarchAuthCache = { tabId: tab.id, at: Date.now() };
      return { ok: true, tabId: tab.id };
    }
    return { ok: false, tabId: tab.id, reason: 'signed_out' };
  } catch (_) {
    // Still loading, or a page the extension can't run on yet.
    return { ok: false, tabId: tab.id, reason: 'loading' };
  }
}

/**
 * ProjectionLab: a tab is open on the instance the Early Access setting allows, the plugin API is
 * on the page (it only appears once signed in with Plugins enabled), and it accepts the saved key.
 */
async function checkPLReady() {
  const found = await findPLTab();
  if (!found) return { ok: false, reason: 'not_open' };
  const tabId = found.tab.id;
  const { plApiKey } = await chrome.storage.sync.get(['plApiKey']);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (key) => {
        const api = window.projectionlabPluginAPI;
        if (!api || typeof api.validateApiKey !== 'function') return { state: 'no_api' };
        try {
          // Awaited: if validateApiKey is async, a rejected key only shows up as a rejected
          // promise, which a bare try/catch never sees (it would report every key as accepted).
          // An explicit `false` result also counts as rejected.
          const accepted = await api.validateApiKey({ key: key });
          return { state: accepted === false ? 'bad_key' : 'ok' };
        } catch (_) {
          return { state: 'bad_key' };
        }
      },
      args: [plApiKey || ''],
    });
    const state = results && results[0] && results[0].result && results[0].result.state;
    if (state === 'ok') return { ok: true, tabId };
    return { ok: false, tabId, reason: state || 'loading' };
  } catch (_) {
    return { ok: false, tabId, reason: 'loading' };
  }
}

async function checkSyncReadiness() {
  const [monarch, pl] = await Promise.all([checkMonarchReady(), checkPLReady()]);
  return { monarch, pl, ready: monarch.ok && pl.ok };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type == 'CHECK_READINESS') {
    checkSyncReadiness()
      .then(sendResponse)
      .catch((err) => sendResponse({ ready: false, error: err.message || String(err) }));
    return true;
  } else if (message.type == 'RUN_SYNC') {
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
  } else if (message.type == 'GET_MONARCH_CSRF_TOKEN') {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: () => {
        const match = document.cookie.match(/(^|;\s*)csrftoken=([^;]*)/);
        return match ? match[2] : null;
      }
    }).then(results => {
      const tokenVal = results[0].result;
      sendResponse({ success: true, token: tokenVal});
    });
    return true; // Keep channel open for async response
  }
  return false;
});

// Auto-sync was removed in v1.2.3: it relied on a no-tab HTTP write path that didn't work.
// Clean up the alarm and settings left by earlier versions.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.remove([
    'autoSyncEnabled', 'autoSyncFrequency', 'autoSyncDayOfWeek',
    'autoSyncDayOfMonth', 'autoSyncTimeHour', 'autoSyncTimeMinute',
  ]).catch(() => {});
});
