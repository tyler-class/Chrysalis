/**
 * Popup UI — states:
 * 1. Not set up (no API key or no mappings) → CTA to open setup (only takes a few minutes).
 * 2. Set up, not on Monarch → CTA to go to Monarch.
 * 3. Set up, on Monarch → sync UI (or last sync results).
 * Plus: syncing, after sync.
 */

(function () {
  const logo = document.getElementById('popup-logo');
  if (logo) logo.src = chrome.runtime.getURL('icons/logo-full.jpg');

  const MONARCH_ORIGIN = 'https://app.monarch.com';
  const CHROME_WEB_STORE_REVIEWS_URL =
    'https://chromewebstore.google.com/detail/chrysalis/jjlpglgnadfdnfflgnpgcamfeacbhood/reviews';
  const CURRENCY_FMT = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

  function getMappingStorage() {
    if (!window.ChrysalisMappingStorage) {
      throw new Error('Mapping storage helper did not load.');
    }
    return window.ChrysalisMappingStorage;
  }

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
        monarchAccounts: Array.isArray(m.monarchAccounts)
          ? m.monarchAccounts.map((a) => ({ id: a.id, name: a.name || a.id }))
          : [],
      }));
    }
    const byPlId = new Map();
    for (const m of raw) {
      const plId = m.plId;
      if (!plId) continue;
      if (!byPlId.has(plId)) {
        byPlId.set(plId, { plId, plName: m.plName || plId, monarchAccounts: [] });
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

  function relativeTime(ts) {
    if (!ts) return '';
    const sec = (Date.now() - ts) / 1000;
    if (sec < 10) return 'just now';
    if (sec < 60) return `${Math.floor(sec)}s ago`;
    const min = sec / 60;
    if (min < 60) return `${Math.floor(min)}m ago`;
    const hr = min / 60;
    if (hr < 24) return `${Math.floor(hr)}h ago`;
    const d = hr / 24;
    return `${Math.floor(d)}d ago`;
  }

  const statusBar = document.getElementById('status-bar');
  const statusText = document.getElementById('status-text');
  const contentEl = document.getElementById('content');

  function setStatus(className, text) {
    statusBar.classList.remove('status-bar-hidden');
    statusBar.className = 'status-bar ' + className;
    statusBar.querySelector('.dot').className = 'dot ' + (className === 'green' ? 'green' : className === 'yellow' ? 'yellow' : 'gray');
    statusText.textContent = text;
  }

  function renderNotSetUp() {
    setStatus('yellow', 'Setup required');
    contentEl.innerHTML = `
      <div class="cta-card">
        <p>To use Chrysalis, complete setup first: add your ProjectionLab API key and map your Monarch accounts to ProjectionLab accounts.</p>
        <p style="margin-top:8px;margin-bottom:12px;font-size:12px;color:var(--muted)">It only takes a few minutes.</p>
        <button type="button" class="btn btn-primary" id="open-setup-cta">Open setup ↗</button>
      </div>
    `;
    contentEl.querySelector('#open-setup-cta').onclick = () => chrome.runtime.openOptionsPage();
  }

  function renderNotOnMonarch(plCount, monarchTotal) {
    setStatus('gray', 'To use Chrysalis, open the Monarch app, then click the extension icon again.');
    contentEl.innerHTML = `
      <a href="${MONARCH_ORIGIN}" target="_blank" rel="noopener noreferrer" class="btn btn-primary" id="open-monarch-link" style="text-decoration:none;display:inline-flex">
        Go to Monarch
      </a>
    `;
  }

  function renderOnMonarch(plCount, monarchTotal) {
    setStatus('green', 'Ready to sync');
    contentEl.innerHTML = `
      <div class="sync-wrap sync-wrap-top">
        <button type="button" class="btn btn-primary btn-sync-now" id="sync-btn">Sync Now</button>
      </div>
    `;
    contentEl.querySelector('#sync-btn').onclick = () => runSync();
  }

  function renderSyncing() {
    statusText.textContent = 'Syncing…';
    contentEl.innerHTML = `
      <div class="sync-wrap sync-wrap-top">
        <button type="button" class="btn btn-primary btn-sync-now" id="sync-btn" disabled>
          <span class="spinner"></span> Syncing…
        </button>
      </div>
    `;
  }

  function renderResults(
    results,
    lastSyncTime,
    topError,
    lastSyncDebug,
    showDebugOnPopup = true,
    syncHistory = [],
    isNewRun = false,
    ratingPromptDismissed = false
  ) {
    const ok = results.every((r) => r.success);
    const anySuccess = results.some((r) => r.success);
    const total = results.length;
    const successCount = results.filter((r) => r.success).length;
    const firstError = !anySuccess && results.length ? (results.find((r) => r.error) || {}).error : null;

    let summaryClass = 'ok';
    let summaryLine = `Last synced: ${total} accounts - ${relativeTime(lastSyncTime)}`;
    if (!anySuccess) {
      summaryClass = 'fail';
      summaryLine = 'Last sync failed';
    } else if (!ok) {
      summaryClass = 'warn';
      summaryLine = `Last synced: ${successCount}/${total} accounts - ${relativeTime(lastSyncTime)}`;
    }

    statusBar.classList.add('status-bar-hidden');

    const rows = results
      .map((r) => {
        const detail = r.isAggregated
          ? `∑ ${(r.monarchAccounts || []).join(' + ')}`
          : (r.monarchAccounts && r.monarchAccounts[0])
            ? `← ${r.monarchAccounts[0]}`
            : '';
        const warning = r.warning ? `<div class="result-warning">${escapeHtml(r.warning)}</div>` : '';
        const error = !r.success && r.error ? `<div class="result-error">${escapeHtml(r.error)}</div>` : '';
        const isDual = typeof r.valueSum === 'number' && typeof r.loanSum === 'number';
        const bal = r.aggregatedBalance;
        const balClass = bal >= 0 ? 'positive' : 'negative';
        const right = isDual
          ? `<div class="result-balance" style="text-align:right">
               <div style="color:var(--green)"><span style="font-weight:500">ASSET:</span> ${CURRENCY_FMT.format(r.valueSum)}</div>
               <div style="color:var(--red)"><span style="font-weight:500">LOAN:</span> ${CURRENCY_FMT.format(r.loanSum)}</div>
             </div>`
          : `<span class="result-balance ${balClass}">${CURRENCY_FMT.format(bal)}</span>`;
        return `
          <div class="result-row ${r.success ? 'success' : 'fail'}">
            <span class="result-icon">${r.success ? '✓' : '✗'}</span>
            <div class="result-body">
              <div class="result-pl-name">${escapeHtml(r.plName)}</div>
              <div class="result-detail">${escapeHtml(detail)}</div>
              ${warning}
              ${error}
            </div>
            ${right}
          </div>
        `;
      })
      .join('');

    const errorBanner = (!anySuccess && (topError || firstError))
      ? `<div class="result-error-banner">${escapeHtml(topError || firstError)}</div>`
      : '';
    const refreshHint = '';

    const hasSyncDetails = showDebugOnPopup && lastSyncDebug && Array.isArray(lastSyncDebug.updates) && lastSyncDebug.updates.length > 0;
    const syncDetailsRows = hasSyncDetails
      ? lastSyncDebug.updates
          .map(
            (u) => `
          <tr class="${u.success ? 'success' : 'fail'}">
            <td class="sync-detail-name">${escapeHtml(u.plName)}</td>
            <td class="sync-detail-payload">${escapeHtml(JSON.stringify(u.payload || { balance: u.balance }))}</td>
            <td class="sync-detail-result">${u.success ? '✓' : escapeHtml(u.error || 'Failed')}</td>
          </tr>`
          )
          .join('')
      : '';
    const debugPayloads = showDebugOnPopup && lastSyncDebug && lastSyncDebug.payloads && lastSyncDebug.payloads.length
      ? lastSyncDebug.payloads
      : (hasSyncDetails && lastSyncDebug ? lastSyncDebug.updates.map((u) => ({ plId: u.plId, plName: u.plName, ...(u.payload || { balance: u.balance }) })) : []);
    const showSyncDebug = showDebugOnPopup && (hasSyncDetails || debugPayloads.length > 0);
    const syncDebugSection = showSyncDebug
      ? `
      <div class="sync-debug-section" style="margin-top:14px;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:11px">
        <div class="sync-debug-title" style="font-weight:600;margin-bottom:6px;color:var(--muted);font-size:12px">Sync Debug – Advanced</div>
        <p style="margin:0 0 10px;color:var(--muted);line-height:1.5">Use this when balances aren’t updating in ProjectionLab. You can share it with support or inspect requests in the extension’s service worker (see below).</p>
        <div style="margin-bottom:10px;color:var(--muted)">
          <span style="color:var(--muted)">Method:</span> ${escapeHtml(lastSyncDebug?.method || '—')}
          ${lastSyncDebug?.plTabUrl ? `<br/><span style="color:var(--muted)">ProjectionLab tab:</span> <span style="word-break:break-all;font-size:10px">${escapeHtml(lastSyncDebug.plTabUrl)}</span>` : ''}
        </div>
        ${hasSyncDetails ? `
        <p style="margin:0 0 6px;color:var(--muted);font-weight:500">Per-account update result</p>
        <table class="sync-details-table" style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:12px">
          <thead>
            <tr style="text-align:left;border-bottom:1px solid var(--border);color:var(--muted)">
              <th style="padding:4px 6px 6px 0">PL account</th>
              <th style="padding:4px 6px 6px 0">Payload sent</th>
              <th style="padding:4px 0 6px 0">Result</th>
            </tr>
          </thead>
          <tbody>${syncDetailsRows}</tbody>
        </table>` : ''}
        ${debugPayloads.length > 0 ? `<p style="margin:0 0 6px;color:var(--muted);font-weight:500">Raw payloads sent (for support or Network inspection)</p><pre style="margin:0 0 10px;padding:8px;background:var(--bg);border-radius:6px;font-size:10px;overflow:auto;max-height:120px;border:1px solid var(--border)">${escapeHtml(JSON.stringify(debugPayloads, null, 2))}</pre>` : ''}
        <p style="margin:0;color:var(--muted);line-height:1.5;font-size:10px">${(lastSyncDebug?.method || '').includes('HTTP') ? 'Sync ran via HTTP because no ProjectionLab tab was open. To inspect those requests: open <code>chrome://extensions</code> → Chrysalis → <strong>Inspect views: service worker</strong> → Network tab, then run Sync again to see each POST and response.' : 'Sync used your open ProjectionLab tab. If you ever see <strong>Method: HTTP</strong> here (no ProjectionLab tab open), you can inspect requests in the service worker’s Network tab (chrome://extensions → Chrysalis → Inspect views: service worker).'}</p>
      </div>`
      : '';

    const historyPageUrl = chrome.runtime.getURL('sync-history/sync-history.html');
    const historyRows = (syncHistory || [])
      .slice(-15)
      .reverse()
      .map((e) => {
        const line = e.error
          ? `${e.successCount}/${e.total} synced · ${escapeHtml(e.error)}`
          : `✓ ${e.total} synced`;
        return `<a class="sync-history-row" href="${historyPageUrl}?t=${e.time}" target="_blank" rel="noopener noreferrer"><span class="sync-history-summary">${line}</span><span class="sync-history-time">${relativeTime(e.time)}</span></a>`;
      })
      .join('');
    const syncHistorySection = (syncHistory || []).length > 0
      ? `<div class="sync-history-block" style="margin-top:16px">
        <div class="sync-history-header">
          <h3 class="sync-history-title">Sync History</h3>
          <a href="${historyPageUrl}" target="_blank" rel="noopener noreferrer" class="sync-history-open-link">View History</a>
        </div>
        <div class="sync-history-rows">${historyRows}</div>
      </div>`
      : '';

    const ratingBanner =
      anySuccess && !ratingPromptDismissed
        ? `<div class="rating-prompt" id="webstore-rating-prompt" role="status">
        <div>Loving Chrysalis? A quick rating on the Chrome Web Store helps others find it.</div>
        <div class="rating-prompt-actions">
          <a href="${CHROME_WEB_STORE_REVIEWS_URL}" target="_blank" rel="noopener noreferrer" class="rating-prompt-store-link">Rate on Chrome Web Store</a>
          <button type="button" class="rating-prompt-dismiss" id="dismiss-webstore-rating-prompt">Dismiss</button>
        </div>
      </div>`
        : '';

    const lastSyncSection = results && results.length
      ? `
      <div class="last-sync-card ${isNewRun ? '' : 'collapsed'}" id="last-sync-card" aria-expanded="${isNewRun ? 'true' : 'false'}">
        <div class="last-sync-head">
          <span class="last-sync-title">Last sync</span>
          <span class="last-sync-summary">${escapeHtml(summaryLine)}</span>
          <span class="last-sync-chevron" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </span>
        </div>
        <div class="last-sync-body">
          ${errorBanner}
          <div class="result-list" style="margin-top:8px">${rows}</div>
          ${refreshHint}
          ${syncDebugSection}
        </div>
      </div>`
      : '';

    contentEl.innerHTML = `
      <div class="sync-wrap sync-wrap-top">
        <button type="button" class="btn btn-primary btn-sync-now" id="sync-btn">Sync Now</button>
      </div>
      ${lastSyncSection}
      ${ratingBanner}
      ${syncHistorySection}
    `;
    contentEl.querySelector('#sync-btn').onclick = () => runSync();

    const dismissRating = document.getElementById('dismiss-webstore-rating-prompt');
    if (dismissRating) {
      dismissRating.onclick = async () => {
        await chrome.storage.local.set({ webstoreRatingPromptDismissed: true });
        renderResults(
          results,
          lastSyncTime,
          topError,
          lastSyncDebug,
          showDebugOnPopup,
          syncHistory,
          false,
          true
        );
      };
    }

    // Setup collapse/expand behavior for Last sync section
    const lastCard = document.getElementById('last-sync-card');
    if (lastCard) {
      const head = lastCard.querySelector('.last-sync-head');
      const chevron = lastCard.querySelector('.last-sync-chevron');
      const updateExpanded = () => {
        const collapsed = lastCard.classList.contains('collapsed');
        lastCard.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      };
      if (head) {
        head.addEventListener('click', () => {
          lastCard.classList.toggle('collapsed');
          updateExpanded();
        });
        head.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            lastCard.classList.toggle('collapsed');
            updateExpanded();
          }
        });
      }
      updateExpanded();
      if (isNewRun) {
        setTimeout(() => {
          if (!lastCard.isConnected) return;
          lastCard.classList.add('collapsed');
          updateExpanded();
        }, 5000);
      }
    }
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  let currentTabId = null;

  async function runSync() {
    if (!currentTabId) return;
    renderSyncing();
    try {
      const res = await chrome.runtime.sendMessage({ type: 'RUN_SYNC', tabId: currentTabId });
      const [local, syncPref] = await Promise.all([
        chrome.storage.local.get([
          'lastSyncTime',
          'lastSyncResults',
          'lastSyncDebug',
          'syncHistory',
          'webstoreRatingPromptDismissed',
        ]),
        chrome.storage.sync.get(['showDebugOnPopup']),
      ]);
      if (res.results && res.results.length) {
        renderResults(
          res.results,
          local.lastSyncTime || Date.now(),
          res.error,
          local.lastSyncDebug,
          !!syncPref.showDebugOnPopup,
          local.syncHistory || [],
          true,
          !!local.webstoreRatingPromptDismissed
        );
      } else {
        setStatus('gray', res.error || 'Sync failed');
        contentEl.innerHTML = `
          <div class="cta-card">
            <p>${escapeHtml(res.error || 'Unknown error')}</p>
            <button type="button" class="btn btn-primary" id="sync-retry">Sync Now</button>
          </div>
        `;
        document.getElementById('sync-retry').onclick = () => runSync();
      }
    } catch (e) {
      setStatus('gray', 'Sync failed');
      contentEl.innerHTML = `
        <div class="cta-card">
          <p>${escapeHtml(e.message || String(e))}</p>
          <button type="button" class="btn btn-primary" id="sync-retry">Sync Now</button>
        </div>
      `;
      document.getElementById('sync-retry').onclick = () => runSync();
    }
  }

  async function init() {
    document.getElementById('open-setup').onclick = () => chrome.runtime.openOptionsPage();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabUrl = tab?.url || '';
    const onMonarch = tabUrl.startsWith(MONARCH_ORIGIN);
    currentTabId = tab?.id ?? null;

    const [sync, local, rawMappings] = await Promise.all([
      chrome.storage.sync.get(['plApiKey', 'showDebugOnPopup']),
      chrome.storage.local.get([
        'lastSyncTime',
        'lastSyncResults',
        'lastSyncDebug',
        'syncHistory',
        'webstoreRatingPromptDismissed',
      ]),
      getMappingStorage().loadMappings(),
    ]);
    const plApiKey = sync.plApiKey;
    const mappings = normalizeMappings(rawMappings || []);
    const isConfigured = !!(plApiKey && plApiKey.trim() && mappings.length > 0);
    const plMappingCount = mappings.length;
    const monarchTotal = mappings.reduce((sum, m) => sum + (m.monarchAccounts?.length || 0), 0);

    if (!isConfigured) {
      renderNotSetUp();
      return;
    }

    if (!onMonarch) {
      renderNotOnMonarch(plMappingCount, monarchTotal);
      return;
    }

    if (local.lastSyncResults && local.lastSyncResults.length > 0) {
      renderResults(
        local.lastSyncResults,
        local.lastSyncTime,
        undefined,
        local.lastSyncDebug,
        !!sync.showDebugOnPopup,
        local.syncHistory || [],
        false,
        !!local.webstoreRatingPromptDismissed
      );
      return;
    }

    renderOnMonarch(plMappingCount, monarchTotal);
  }

  init();
})();
