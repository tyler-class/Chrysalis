/**
 * Sync history page — list view and detail view (?t=timestamp) for auditing past syncs.
 */

(function () {
  const CURRENCY_FMT = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

  const USD_CENTS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

  function formatPct(n) {
    return `${Math.round(Number(n) * 100) / 100}%`;
  }

  /**
   * Per-source breakdown for rows that sum several accounts or use split shares.
   * `r.sources` is recorded by the service worker for single-lane rows (since v1.2).
   */
  function renderSources(r) {
    const sources = Array.isArray(r.sources) ? r.sources : [];
    if (!sources.length || !(sources.length > 1 || sources.some((s) => s.pct != null))) return '';
    const lines = sources.map((s) => {
      const label = s.pct != null
        ? `${formatPct(s.pct)} of ${s.name}${typeof s.balance === 'number' ? ` (${USD_CENTS.format(s.balance)})` : ''}`
        : `${s.name} · whole account`;
      let right;
      if (s.status === 'ok') {
        right = USD_CENTS.format(s.amount);
        if (s.roundingCents) {
          right = `<span class="src-round">${s.roundingCents > 0 ? 'rounded up' : 'rounded down'} ${Math.abs(s.roundingCents)}¢</span> ${right}`;
        }
      } else if (s.status === 'zero') right = 'not synced (0%)';
      else if (s.status === 'missing') right = 'not found in Monarch';
      else right = 'blocked';
      return `<span>${escapeHtml(label)}</span><span class="r">${right}</span>`;
    }).join('');
    return `<div class="src-grid">${lines}</div>`;
  }

  function renderSplitSnapshot(entry) {
    const splits = Array.isArray(entry.splits) ? entry.splits : [];
    if (!splits.length) return '';
    const items = splits.map((sp) => {
      const shares = (sp.shares || []).map((x) => `${x.pct == null ? '?' : formatPct(x.pct)} → ${x.plName || x.plId}`).join(', ');
      const state = sp.state === 'ok' ? '' : ` <span class="snap-${escapeHtml(sp.state)}">(${sp.state === 'under' ? 'under-allocated' : sp.state === 'over' ? 'over-allocated' : 'share missing'})</span>`;
      const edited = sp.updatedAt ? `<div class="snap-meta">Split last edited ${escapeHtml(new Date(sp.updatedAt).toLocaleString())}</div>` : '';
      return `<div class="snap-item"><strong>${escapeHtml(sp.name)}</strong>${typeof sp.balance === 'number' ? ` · ${USD_CENTS.format(sp.balance)}` : ''} · total ${formatPct(sp.totalPct)}${state}<div>${escapeHtml(shares)}</div>${edited}</div>`;
    }).join('');
    return `<div class="sync-details-section"><h3>Split settings at sync time</h3>${items}</div>`;
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
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
    if (d < 30) return `${Math.floor(d)}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function formatRunSummary(e) {
    if (e.error) return `${e.successCount}/${e.total} synced · ${e.error}`;
    return `✓ ${e.total} synced`;
  }

  function summaryClass(e) {
    if (!e.error) return 'ok';
    if (e.successCount > 0) return 'warn';
    return 'fail';
  }

  function renderList(history) {
    const listUrl = chrome.runtime.getURL('sync-history/sync-history.html');
    const setupUrl = chrome.runtime.getURL('setup/setup.html');
    const rows = (history || [])
      .slice()
      .reverse()
      .map(
        (e) =>
          `<a class="list-row" href="${listUrl}?t=${e.time}" data-time="${e.time}">
            <span class="summary ${summaryClass(e)}">${escapeHtml(formatRunSummary(e))}</span>
            <span class="time">${relativeTime(e.time)}</span>
          </a>`
      )
      .join('');
    return `
      <nav class="nav"><a href="${setupUrl}">← Setup</a></nav>
      <h1>Sync history</h1>
      <p class="sub">Click a row to view full details for that sync.</p>
      <div class="list">${rows || '<div class="empty">No sync history yet.</div>'}</div>
    `;
  }

  function renderDetail(entry, showDebug) {
    const listUrl = chrome.runtime.getURL('sync-history/sync-history.html');
    const setupUrl = chrome.runtime.getURL('setup/setup.html');
    const results = entry.results || [];
    const rows = results
      .map((r) => {
        const detail = r.isAggregated
          ? `∑ ${(r.monarchAccounts || []).map((x) => (typeof x === 'string' ? x : x?.name || '')).join(' + ')}`
          : (r.monarchAccounts && r.monarchAccounts[0])
            ? `← ${typeof r.monarchAccounts[0] === 'string' ? r.monarchAccounts[0] : r.monarchAccounts[0]?.name || ''}`
            : '';
        const warning = r.warning ? `<div style="font-size:11px;color:var(--yellow);margin-top:4px">${escapeHtml(r.warning)}</div>` : '';
        const error = !r.success && r.error ? `<div style="font-size:11px;color:var(--red);margin-top:4px">${escapeHtml(r.error)}</div>` : '';
        const isDual = typeof r.valueSum === 'number' && typeof r.loanSum === 'number';
        const bal = r.aggregatedBalance;
        const balClass = bal >= 0 ? 'positive' : 'negative';
        const right = isDual
          ? `<div class="result-balance" style="text-align:right">
               <div style="color:var(--green);font-size:12px"><span style="font-weight:500">ASSET:</span> ${CURRENCY_FMT.format(r.valueSum)}</div>
               <div style="color:var(--red);font-size:12px"><span style="font-weight:500">LOAN:</span> ${CURRENCY_FMT.format(r.loanSum)}</div>
             </div>`
          : `<span class="result-balance ${balClass}">${CURRENCY_FMT.format(bal)}</span>`;
        return `
          <div class="result-row ${r.success ? 'success' : 'fail'}">
            <span class="result-icon">${r.success ? '✓' : '✗'}</span>
            <div class="result-body">
              <div class="result-pl-name">${escapeHtml(r.plName || '')}</div>
              <div class="result-detail">${escapeHtml(detail)}</div>
              ${renderSources(r)}
              ${warning}
              ${error}
            </div>
            ${right}
          </div>
        `;
      })
      .join('');

    const debug = entry.debug;
    const hasDetails = !!showDebug && debug && Array.isArray(debug.updates) && debug.updates.length > 0;
    const detailsRows = hasDetails
      ? debug.updates
          .map(
            (u) => `
          <tr class="${u.success ? 'success' : 'fail'}">
            <td class="sync-detail-name">${escapeHtml(u.plName || '')}</td>
            <td style="word-break:break-all;font-size:10px">${escapeHtml(JSON.stringify(u.payload || { balance: u.balance }))}</td>
            <td>${u.success ? '✓' : escapeHtml(u.error || 'Failed')}</td>
          </tr>`
          )
          .join('')
      : '';
    const detailsSection = hasDetails
      ? `
      <div class="sync-details-section">
        <h3>Sync details</h3>
        <p style="margin:0 0 8px 0;color:var(--muted)">
          These debug details respect the <strong>Show sync debug details</strong> setting (Advanced section). When enabled, extra per-account payload info appears here and in the popup after a sync.
          <br/><strong>Method:</strong> ${escapeHtml(debug.method || '—')}${debug.plTabUrl ? `<br/><strong>ProjectionLab tab:</strong> <span style="word-break:break-all">${escapeHtml(debug.plTabUrl)}</span>` : ''}
        </p>
        <table class="sync-details-table">
          <thead>
            <tr><th>ProjectionLab account</th><th>Payload sent</th><th>Result</th></tr>
          </thead>
          <tbody>${detailsRows}</tbody>
        </table>
      </div>`
      : '';

    const dateStr = new Date(entry.time).toLocaleString();
    return `
      <nav class="nav"><a href="${listUrl}">← Back to sync history</a> · <a href="${setupUrl}">Setup</a></nav>
      <div class="detail-header">
        <h1>Sync run</h1>
        <div class="date">${escapeHtml(dateStr)}</div>
        <div class="summary ${summaryClass(entry)}" style="margin-top:8px;font-weight:500">${escapeHtml(formatRunSummary(entry))}</div>
      </div>
      <div class="result-list">${rows || '<div class="empty">No result data for this run.</div>'}</div>
      ${renderSplitSnapshot(entry)}
      ${detailsSection}
    `;
  }

  async function init() {
    const app = document.getElementById('app');
    const params = new URLSearchParams(location.search);
    const t = params.get('t');
    const [{ syncHistory = [] }, syncPrefs] = await Promise.all([
      chrome.storage.local.get(['syncHistory']),
      chrome.storage.sync.get(['showDebugOnPopup']),
    ]);
    const showDebug = !!syncPrefs.showDebugOnPopup;

    if (t) {
      const time = Number(t);
      const entry = syncHistory.find((e) => e.time === time);
      if (entry) {
        app.innerHTML = renderDetail(entry, showDebug);
      } else {
        app.innerHTML = `
          <nav class="nav"><a href="${chrome.runtime.getURL('sync-history/sync-history.html')}">← Back to sync history</a></nav>
          <h1>Sync run not found</h1>
          <p class="sub">That run may have been removed by retention settings or the history was cleared.</p>
        `;
      }
    } else {
      app.innerHTML = renderList(syncHistory);
    }
  }

  init();
})();
