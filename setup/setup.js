/**
 * Setup page — API key, load Monarch/PL accounts, map accounts (many-to-one). Schema migration for old flat mappings.
 */

(function () {
  // Supported ProjectionLab origins. Order matters: ea.* is probed first
  // (EA gets preferential treatment; see detectPLOrigin).
  const PL_ORIGINS = [
    'https://ea.projectionlab.com',
    'https://app.projectionlab.com',
  ];
  const DEFAULT_PL_ORIGIN = PL_ORIGINS[0];
  const MONARCH_ORIGIN = 'https://app.monarch.com';
  const PL_LOAD_DELAY_MS = 4500;
  const PL_API_RETRY_MS = 2000;
  const PL_API_RETRIES = 5;
  const PL_WAIT_FOR_API_MS = 20000;
  const PL_WAIT_POLL_MS = 400;

  function plOriginForUrl(url) {
    return PL_ORIGINS.find((o) => typeof url === 'string' && url.startsWith(o)) || null;
  }
  async function getCachedPLOrigin() {
    const { plOrigin } = await chrome.storage.local.get(['plOrigin']);
    return plOrigin && PL_ORIGINS.includes(plOrigin) ? plOrigin : null;
  }
  async function setCachedPLOrigin(origin) {
    if (origin && PL_ORIGINS.includes(origin)) {
      await chrome.storage.local.set({ plOrigin: origin });
    }
  }
  async function clearCachedPLOrigin() {
    try { await chrome.storage.local.remove(['plOrigin']); } catch (_) {}
  }
  function isAuthLikeError(message) {
    if (!message) return false;
    return /unauthor|invalid.*key|forbidden|401|403/i.test(String(message));
  }

  let monarchAccounts = [];
  let plAccounts = [];
  let plApiKey = '';
  let accountMappings = [];

  function normalizeMappings(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const out = [];
    for (const m of raw) {
      // If this looks like a new-schema row (our current format), keep it as-is
      if (
        (m && typeof m === 'object') &&
        ('monarchAccounts' in m || 'monarchAccountsLoan' in m)
      ) {
        out.push({
          plId: m.plId || '',
          plName: m.plName || m.plId || '',
          plType: m.plType || 'asset',
          plNativeType: m.plNativeType || '',
          monarchAccounts: Array.isArray(m.monarchAccounts)
            ? m.monarchAccounts.map((a) => ({
                id: a.id,
                name: a.name || a.id,
              }))
            : [],
          monarchAccountsLoan: Array.isArray(m.monarchAccountsLoan)
            ? m.monarchAccountsLoan.map((a) => ({
                id: a.id,
                name: a.name || a.id,
              }))
            : [],
        });
        continue;
      }
      // Legacy/old-schema row – migrate
      const plId = m.plId;
      if (!plId) continue;
      const existing = out.find((x) => x.plId === plId);
      const target =
        existing ||
        (() => {
          const created = {
            plId,
            plName: m.plName || plId,
            plType: m.plType || 'asset',
            plNativeType: m.plNativeType || '',
            monarchAccounts: [],
            monarchAccountsLoan: [],
          };
          out.push(created);
          return created;
        })();
      const mid = m.monarchId || m.monarchAccountId;
      const mname = m.monarchName || m.monarchAccountName || mid;
      if (
        mid &&
        !target.monarchAccounts.some((a) => a.id === mid)
      ) {
        target.monarchAccounts.push({ id: mid, name: mname });
      }
    }
    return out;
  }

  function getMappingStorage() {
    if (!window.ChrysalisMappingStorage) {
      throw new Error('Mapping storage helper did not load.');
    }
    return window.ChrysalisMappingStorage;
  }

  function setSaveError(message) {
    const el = document.getElementById('save-error');
    if (el) el.textContent = message || '';
  }

  function formatMappingStorageError(error) {
    const message = error && error.message ? error.message : String(error);
    return `Could not save account mappings. ${message}`;
  }

  async function loadMappingsFromStorage() {
    return getMappingStorage().loadMappings();
  }

  async function saveMappingsToStorage(mappings) {
    try {
      await getMappingStorage().saveMappings(mappings);
      setSaveError('');
      return true;
    } catch (e) {
      setSaveError(formatMappingStorageError(e));
      console.error('[Chrysalis][setup] Failed to save account mappings:', e);
      return false;
    }
  }

  function updateChips() {
    const hasKey = !!(plApiKey && plApiKey.trim());
    const chipPl = document.getElementById('chip-pl');
    const chipPlText = document.getElementById('chip-pl-text');
    if (hasKey) {
      chipPl.classList.add('ok');
      chipPlText.textContent = 'ProjectionLab API — configured';
    } else {
      chipPl.classList.remove('ok');
      chipPlText.textContent = 'ProjectionLab API — not configured';
    }

    const mappings = accountMappings;
    const plCount = mappings.length;
    const monarchTotal = mappings.reduce((sum, m) => {
      const value = m.monarchAccounts?.length || 0;
      const loan = isAssetWithLoanMapping(m) ? (m.monarchAccountsLoan?.length || 0) : 0;
      return sum + value + loan;
    }, 0);
    const chipMaps = document.getElementById('chip-maps');
    const chipMapsText = document.getElementById('chip-maps-text');
    if (plCount > 0) {
      chipMaps.classList.add('ok');
      chipMapsText.textContent = `Account Mappings — ${monarchTotal} Monarch → ${plCount} ProjectionLab`;
    } else {
      chipMaps.classList.remove('ok');
      chipMapsText.textContent = 'Account Mappings — 0 mapped';
    }
  }

  function setStepCollapsed(stepId, collapsed) {
    const card = document.getElementById(stepId);
    const head = card && card.querySelector('.step-head');
    if (!card || !head) return;
    if (collapsed) {
      card.classList.add('collapsed');
      head.setAttribute('aria-expanded', 'false');
    } else {
      card.classList.remove('collapsed');
      head.setAttribute('aria-expanded', 'true');
    }
  }

  function toggleStepCollapsed(stepId) {
    const card = document.getElementById(stepId);
    if (!card) return;
    const isCollapsed = card.classList.toggle('collapsed');
    const head = card.querySelector('.step-head');
    if (head) head.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
  }

  function setupStepToggles() {
    ['step1', 'step2', 'step3'].forEach((stepId) => {
      const card = document.getElementById(stepId);
      const head = card && card.querySelector('.step-head');
      if (!head) return;
      head.addEventListener('click', () => toggleStepCollapsed(stepId));
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleStepCollapsed(stepId);
        }
      });
    });
  }

  function toggleAdvancedCollapsed() {
    const card = document.getElementById('advanced-card');
    if (!card) return;
    card.classList.toggle('collapsed');
    const head = card.querySelector('.advanced-head');
    if (head) head.setAttribute('aria-expanded', card.classList.contains('collapsed') ? 'false' : 'true');
  }

  function setupAdvancedSection() {
    const card = document.getElementById('advanced-card');
    const head = card && card.querySelector('.advanced-head');
    const editBtn = document.getElementById('advanced-edit-btn');
    if (head) {
      head.addEventListener('click', () => toggleAdvancedCollapsed());
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleAdvancedCollapsed();
        }
      });
    }
    if (editBtn && card) {
      const lockEl = document.querySelector('.advanced-lock-state');
      const lockNote = document.getElementById('advanced-lock-note');
      const applyLockUi = () => {
        const locked = card.classList.contains('advanced-locked');
        editBtn.textContent = locked ? 'Unlock Advanced Settings' : 'Lock Advanced Settings';
        if (lockEl) lockEl.textContent = locked ? '🔒' : '🔓';
        if (lockNote) lockNote.style.display = locked ? '' : 'none';
        // Hard-disable all controls inside the advanced body when locked,
        // so labels can't toggle checkboxes either.
        const bodyControls = card.querySelectorAll('.advanced-body input, .advanced-body select, .advanced-body textarea, .advanced-body button.advanced-btn');
        bodyControls.forEach((el) => {
          el.disabled = locked;
        });
        const bodyLinks = card.querySelectorAll('.advanced-body a.advanced-btn');
        bodyLinks.forEach((el) => {
          if (locked) {
            el.setAttribute('aria-disabled', 'true');
            el.dataset._prevTabIndex = el.getAttribute('tabindex') || '';
            el.setAttribute('tabindex', '-1');
          } else {
            el.removeAttribute('aria-disabled');
            if (el.dataset._prevTabIndex !== undefined) {
              if (el.dataset._prevTabIndex) {
                el.setAttribute('tabindex', el.dataset._prevTabIndex);
              } else {
                el.removeAttribute('tabindex');
              }
              delete el.dataset._prevTabIndex;
            }
          }
        });
      };
      applyLockUi();
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        card.classList.toggle('advanced-locked');
        applyLockUi();
      });
    }

    function setupCopyButton(btnId, preId, msgId) {
      const btn = document.getElementById(btnId);
      const pre = document.getElementById(preId);
      const msg = document.getElementById(msgId);
      if (!btn || !pre || !msg) return;
      btn.addEventListener('click', async () => {
        const text = pre.textContent || '';
        if (!text.trim()) return;
        try {
          await navigator.clipboard.writeText(text);
          msg.textContent = 'Copied!';
          msg.style.visibility = 'visible';
          setTimeout(() => { msg.textContent = ''; msg.style.visibility = ''; }, 2000);
        } catch (_) {
          msg.textContent = 'Copy failed';
          msg.style.visibility = 'visible';
        }
      });
    }
    setupCopyButton('copy-diagnose-output', 'diagnose-output', 'copy-diagnose-output-msg');
    setupCopyButton('copy-diagnose-pl-output', 'diagnose-pl-output', 'copy-diagnose-pl-output-msg');
    setupCopyButton('copy-schema-output', 'schema-output', 'copy-schema-output-msg');

    const showDebugCheckbox = document.getElementById('show-debug-popup');
    if (showDebugCheckbox) {
      chrome.storage.sync.get(['showDebugOnPopup'], (sync) => {
        showDebugCheckbox.checked = !!sync.showDebugOnPopup;
      });
      showDebugCheckbox.addEventListener('change', () => {
        chrome.storage.sync.set({ showDebugOnPopup: showDebugCheckbox.checked });
      });
    }

    const autoSyncCheckbox = document.getElementById('auto-sync-enabled');
    const autoSyncFrequency = document.getElementById('auto-sync-frequency');
    const autoSyncDayWeek = document.getElementById('auto-sync-day-week');
    const autoSyncDayMonth = document.getElementById('auto-sync-day-month');
    const autoSyncTime = document.getElementById('auto-sync-time');
    const dayWeekWrap = document.getElementById('auto-sync-day-week-wrap');
    const dayMonthWrap = document.getElementById('auto-sync-day-month-wrap');

    if (autoSyncDayMonth) {
      for (let i = 1; i <= 28; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = String(i);
        autoSyncDayMonth.appendChild(opt);
      }
    }

    function updateAutoSyncVisibility() {
      const enabled = autoSyncCheckbox && autoSyncCheckbox.checked;
      const freq = (autoSyncFrequency && autoSyncFrequency.value) || 'daily';
      // Visibility depends only on which frequency is selected
      if (dayWeekWrap) dayWeekWrap.style.display = freq === 'weekly' ? 'flex' : 'none';
      if (dayMonthWrap) dayMonthWrap.style.display = (freq === 'monthly' || freq === 'quarterly') ? 'flex' : 'none';
      // Enabled state (including visual disabled styling) depends on master toggle
      if (autoSyncFrequency) autoSyncFrequency.disabled = !enabled;
      if (autoSyncDayWeek) autoSyncDayWeek.disabled = !enabled;
      if (autoSyncDayMonth) autoSyncDayMonth.disabled = !enabled;
      if (autoSyncTime) autoSyncTime.disabled = !enabled;
    }

    function saveAutoSync() {
      const enabled = autoSyncCheckbox && autoSyncCheckbox.checked;
      const freq = (autoSyncFrequency && autoSyncFrequency.value) || 'daily';
      const dayOfWeek = autoSyncDayWeek ? parseInt(autoSyncDayWeek.value, 10) : 0;
      const dayOfMonth = autoSyncDayMonth ? parseInt(autoSyncDayMonth.value, 10) : 1;
      const timeStr = (autoSyncTime && autoSyncTime.value) || '09:00';
      const [h, m] = timeStr.split(':').map((n) => parseInt(n, 10) || 0);
      chrome.storage.sync.set({
        autoSyncEnabled: enabled,
        autoSyncFrequency: enabled ? freq : '',
        autoSyncDayOfWeek: dayOfWeek,
        autoSyncDayOfMonth: dayOfMonth,
        autoSyncTimeHour: h,
        autoSyncTimeMinute: m,
      });
    }

    if (autoSyncCheckbox && autoSyncFrequency && autoSyncTime) {
      chrome.storage.sync.get(
        ['autoSyncEnabled', 'autoSyncFrequency', 'autoSyncDayOfWeek', 'autoSyncDayOfMonth', 'autoSyncTimeHour', 'autoSyncTimeMinute'],
        (sync) => {
          autoSyncCheckbox.checked = !!sync.autoSyncEnabled;
          autoSyncFrequency.value = sync.autoSyncFrequency || 'daily';
          if (autoSyncDayWeek) autoSyncDayWeek.value = String(Math.max(0, Math.min(6, sync.autoSyncDayOfWeek ?? 1)));
          if (autoSyncDayMonth) autoSyncDayMonth.value = String(Math.max(1, Math.min(28, sync.autoSyncDayOfMonth ?? 1)));
          const h = Math.max(0, Math.min(23, sync.autoSyncTimeHour ?? 9));
          const m = Math.max(0, Math.min(59, sync.autoSyncTimeMinute ?? 0));
          autoSyncTime.value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          updateAutoSyncVisibility();
        }
      );
      autoSyncCheckbox.addEventListener('change', () => { saveAutoSync(); updateAutoSyncVisibility(); });
      autoSyncFrequency.addEventListener('change', () => { updateAutoSyncVisibility(); saveAutoSync(); });
      if (autoSyncDayWeek) autoSyncDayWeek.addEventListener('change', saveAutoSync);
      if (autoSyncDayMonth) autoSyncDayMonth.addEventListener('change', saveAutoSync);
      autoSyncTime.addEventListener('change', saveAutoSync);
    }

    const syncHistoryRetentionInput = document.getElementById('sync-history-retention-days');
    if (syncHistoryRetentionInput) {
      chrome.storage.sync.get(['syncHistoryRetentionDays'], (sync) => {
        const v = sync.syncHistoryRetentionDays;
        syncHistoryRetentionInput.value = (v != null && Number.isInteger(v) && v >= 1) ? String(v) : '';
      });
      syncHistoryRetentionInput.addEventListener('change', () => {
        const raw = syncHistoryRetentionInput.value.trim();
        const n = raw === '' ? null : parseInt(raw, 10);
        const toSave = (n != null && !Number.isNaN(n) && n >= 1) ? n : null;
        chrome.storage.sync.set({ syncHistoryRetentionDays: toSave });
      });
      syncHistoryRetentionInput.addEventListener('blur', () => {
        const raw = syncHistoryRetentionInput.value.trim();
        const n = raw === '' ? null : parseInt(raw, 10);
        const toSave = (n != null && !Number.isNaN(n) && n >= 1) ? n : null;
        chrome.storage.sync.set({ syncHistoryRetentionDays: toSave });
      });
    }

    document.getElementById('clear-cache').addEventListener('click', async () => {
      if (card.classList.contains('advanced-locked')) return;
      if (!confirm('Clear all cached data? You will need to load Monarch and ProjectionLab accounts again. Your API key and saved mappings will be kept.')) return;
      await chrome.storage.local.clear();
      monarchAccounts = [];
      plAccounts = [];
      updateChips();
      updateStepComplete('step2', false);
      updateStep2Buttons();
      renderMappingRows();
    });

    document.getElementById('clear-mappings').addEventListener('click', async () => {
      if (card.classList.contains('advanced-locked')) return;
      if (!confirm('Clear all saved account mappings? The mapping table will be reset. Your API key and cached account lists are not affected.')) return;
      accountMappings = [];
      if (!(await saveMappingsToStorage(accountMappings))) return;
      updateChips();
      renderMappingRows();
      updateStepComplete('step3', false);
      setFinalLoadStatus(document.getElementById('mappings-status-clear'), 'Mappings cleared');
    });

    document.getElementById('reset-everything').addEventListener('click', async () => {
      if (card.classList.contains('advanced-locked')) return;
      if (!confirm('Reset everything? This will clear your API key, all cached account data, and all mappings. You will need to set up from step 1 again. This cannot be undone.')) return;
      document.getElementById('pl-key').value = '';
      plApiKey = '';
      monarchAccounts = [];
      plAccounts = [];
      accountMappings = [];
      await chrome.storage.sync.set({ plApiKey: '', autoSyncEnabled: false });
      if (!(await saveMappingsToStorage(accountMappings))) return;
      await chrome.storage.local.clear();
      updateChips();
      updateStepComplete('step1', false);
      updateStepComplete('step2', false);
      updateStepComplete('step3', false);
      setStepCollapsed('step1', false);
      updateStep2Buttons();
      renderMappingRows();
      setFinalLoadStatus(document.getElementById('reset-everything-status'), 'Reset complete.');
    });

    document.getElementById('download-mappings').addEventListener('click', () => {
      const data = JSON.stringify(accountMappings.filter((m) => m.plId && (m.monarchAccounts?.length || 0) > 0), null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'chrysalis-mappings.json';
      a.click();
      URL.revokeObjectURL(url);
      setFinalLoadStatus(document.getElementById('mappings-status-download'), 'Mappings downloaded');
    });

    const uploadInput = document.getElementById('upload-mappings-input');
    document.getElementById('upload-mappings').addEventListener('click', () => {
      uploadInput.value = '';
      uploadInput.click();
    });
    uploadInput.addEventListener('change', async () => {
      const file = uploadInput.files && uploadInput.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const raw = JSON.parse(text);
        if (!Array.isArray(raw)) throw new Error('File must be a JSON array of mappings.');
        const normalized = normalizeMappings(raw);
        if (normalized.length === 0) throw new Error('No valid mappings in file.');
        if (!(await saveMappingsToStorage(normalized))) {
          throw new Error('Could not save mappings. See the Map Accounts error for details.');
        }
        accountMappings = normalized;
        updateChips();
        renderMappingRows();
        updateStepComplete('step3', accountMappings.length > 0 && accountMappings.every((m) => m.plId && (m.monarchAccounts?.length || 0) > 0));
        setFinalLoadStatus(document.getElementById('mappings-status-upload'), 'Mappings uploaded');
      } catch (err) {
        alert('Upload failed: ' + (err.message || String(err)));
      }
      uploadInput.value = '';
    });
  }

  function updateStepComplete(stepId, complete) {
    const card = document.getElementById(stepId);
    const num = card && card.querySelector('.step-num');
    if (!num) return;
    if (complete) {
      card.classList.add('complete');
      num.textContent = '✓';
    } else {
      card.classList.remove('complete');
      num.textContent = stepId === 'step1' ? '1' : stepId === 'step2' ? '2' : '3';
    }
  }

  function getStep2IconUrl(name) {
    return chrome.runtime.getURL('icons/' + name);
  }

  function restoreStep2Buttons() {
    const monarchBtn = document.getElementById('load-accounts');
    const plBtn = document.getElementById('load-pl-accounts');
    if (monarchBtn) {
      monarchBtn.innerHTML = `<img class="btn-icon" src="${getStep2IconUrl('monarch-icon.png')}" alt="" /><span class="btn-text"></span>`;
    }
    if (plBtn) {
      plBtn.innerHTML = `<img class="btn-icon" src="${getStep2IconUrl('projectionLab-icon.png')}" alt="" /><span class="btn-text"></span>`;
    }
    updateStep2Buttons();
  }

  function setStep2ButtonIconUrls() {
    const monarchImg = document.querySelector('#load-accounts .btn-icon');
    const plImg = document.querySelector('#load-pl-accounts .btn-icon');
    if (monarchImg) monarchImg.src = getStep2IconUrl('monarch-icon.png');
    if (plImg) plImg.src = getStep2IconUrl('projectionLab-icon.png');
  }

  function setHeaderLogoUrl() {
    const logo = document.getElementById('header-logo');
    if (logo) logo.src = chrome.runtime.getURL('icons/logo-full.jpg');
    const syncHistoryLink = document.getElementById('setup-sync-history-link');
    if (syncHistoryLink) syncHistoryLink.href = chrome.runtime.getURL('sync-history/sync-history.html');
  }

  function updateStep2Buttons() {
    const monarchBtn = document.getElementById('load-accounts');
    const plBtn = document.getElementById('load-pl-accounts');
    const monarchText = monarchBtn?.querySelector('.btn-text');
    const plText = plBtn?.querySelector('.btn-text');
    if (monarchText) monarchText.textContent = monarchAccounts.length > 0 ? 'Refresh Accounts from Monarch' : 'Load Accounts from Monarch';
    if (plText) plText.textContent = plAccounts.length > 0 ? 'Refresh Accounts from ProjectionLab' : 'Load Accounts from ProjectionLab';
  }

  // For now, keep saved mappings exactly as they were persisted.
  // We no longer try to reconcile them with current Monarch/PL account lists
  // on load, to avoid accidentally dropping or rewriting rows (especially asset 2‑lane rows).
  function reconcileMappingsWithAccounts() {}

  async function loadStorage() {
    const [sync, local, rawMappings] = await Promise.all([
      chrome.storage.sync.get(['plApiKey']),
      chrome.storage.local.get(['cachedMonarchAccounts', 'cachedPLAccounts', 'lastMonarchRefreshTime', 'lastPLRefreshTime']),
      loadMappingsFromStorage(),
    ]);
    plApiKey = sync.plApiKey || '';
    accountMappings = normalizeMappings(rawMappings || []);
    try {
      console.log('[Chrysalis][setup] loadStorage raw accountMappings from sync:', rawMappings);
      console.log('[Chrysalis][setup] loadStorage normalized accountMappings:', accountMappings);
    } catch (_) {}
    if (Array.isArray(local.cachedMonarchAccounts) && local.cachedMonarchAccounts.length > 0) {
      monarchAccounts = local.cachedMonarchAccounts;
    }
    if (Array.isArray(local.cachedPLAccounts) && local.cachedPLAccounts.length > 0) {
      plAccounts = local.cachedPLAccounts;
    }
    reconcileMappingsWithAccounts();
    document.getElementById('pl-key').value = plApiKey;
    updateChips();
    const step1Complete = !!(plApiKey && plApiKey.trim());
    updateStepComplete('step1', step1Complete);
    if (step1Complete) setStepCollapsed('step1', true);
    const step2Complete = monarchAccounts.length > 0 && plAccounts.length > 0;
    updateStepComplete('step2', step2Complete);
    if (step2Complete) setStepCollapsed('step2', true);
    updateStep2Buttons();
    renderMappingRows();
    const monarchStatus = document.getElementById('load-status-monarch');
    const plStatus = document.getElementById('load-status-pl');
    if (monarchStatus && local.lastMonarchRefreshTime) {
      monarchStatus.textContent = formatLastRefreshed(local.lastMonarchRefreshTime);
    }
    if (plStatus && local.lastPLRefreshTime) {
      plStatus.textContent = formatLastRefreshed(local.lastPLRefreshTime);
    }
    const step3Complete = accountMappings.length > 0 && accountMappings.every((m) => {
      if (!m.plId) return false;
      if (isAssetWithLoanMapping(m)) {
        const valueCount = m.monarchAccounts?.length || 0;
        const loanCount = m.monarchAccountsLoan?.length || 0;
        return valueCount + loanCount > 0;
      }
      return (m.monarchAccounts?.length || 0) > 0;
    });
    updateStepComplete('step3', step3Complete);
    // Only collapse Map Accounts on initial load when already configured; never auto-close during the session
    if (step3Complete) setStepCollapsed('step3', true);
  }

  document.getElementById('save-key').onclick = async () => {
    const key = document.getElementById('pl-key').value.trim();
    if (!key) return;
    plApiKey = key;
    await chrome.storage.sync.set({ plApiKey: key });
    // A saved key may belong to a different instance than the previously cached
    // one — drop the cache so the next "Load Accounts" re-runs detection.
    await clearCachedPLOrigin();
    updateChips();
    updateStepComplete('step1', true);
    setFinalLoadStatus(document.getElementById('key-saved-msg'), 'Key saved!');
  };

  document.getElementById('clear-key').onclick = async () => {
    document.getElementById('pl-key').value = '';
    plApiKey = '';
    await chrome.storage.sync.remove('plApiKey');
    await clearCachedPLOrigin();
    updateChips();
    updateStepComplete('step1', false);
    setStepCollapsed('step1', false);
    setFinalLoadStatus(document.getElementById('key-saved-msg'), 'API key cleared.');
  };

  async function findMonarchTab() {
    const tabs = await chrome.tabs.query({ url: MONARCH_ORIGIN + '/*' });
    return tabs.length ? tabs[0] : null;
  }

  function isPLAppTab(url) {
    const origin = plOriginForUrl(url);
    if (!origin) return false;
    const path = url.slice(origin.length).split('?')[0];
    return path === '' || path === '/' || (!path.startsWith('/docs') && !path.startsWith('/settings'));
  }

  /**
   * Find an existing tab for the given origin, or open one in the background.
   * Returns { tab, openedByUs }. openedByUs=true means we created the tab and
   * the caller is responsible for closing it on failure.
   */
  async function findOrOpenPLTabForOrigin(origin, { openInBackground = false } = {}) {
    const tabs = await chrome.tabs.query({ url: origin + '/*' });
    if (tabs.length) {
      const appTab = tabs.find((t) => isPLAppTab(t.url));
      return { tab: appTab || tabs[0], openedByUs: false };
    }
    const tab = await chrome.tabs.create({ url: origin + '/', active: !openInBackground });
    const loaded = await new Promise((resolve) => {
      const listener = (id, info, t) => {
        if (id !== tab.id) return;
        if (info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(() => resolve(t), PL_LOAD_DELAY_MS);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      if (tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => resolve(tab), PL_LOAD_DELAY_MS);
      }
    });
    return { tab: loaded, openedByUs: true };
  }

  /**
   * Get a usable PL tab for diagnostic flows (diagnose, inspect schema) that
   * don't have enough context to run full origin detection. Preference order:
   *   1. Cached origin (the user's confirmed instance).
   *   2. Any already-open PL tab, honoring PL_ORIGINS order (ea.* over app.*).
   *   3. Open the default preferred origin (ea.*).
   */
  async function findAnyPLTabOrOpen({ openInBackground = false } = {}) {
    const cached = await getCachedPLOrigin();
    if (cached) {
      const result = await findOrOpenPLTabForOrigin(cached, { openInBackground });
      return { ...result, origin: cached };
    }
    for (const origin of PL_ORIGINS) {
      const tabs = await chrome.tabs.query({ url: origin + '/*' });
      if (tabs.length) {
        const appTab = tabs.find((t) => isPLAppTab(t.url));
        return { tab: appTab || tabs[0], openedByUs: false, origin };
      }
    }
    const result = await findOrOpenPLTabForOrigin(DEFAULT_PL_ORIGIN, { openInBackground });
    return { ...result, origin: DEFAULT_PL_ORIGIN };
  }

  /**
   * Probe a single origin with the given API key to see if the key is valid there.
   * Classifies errors into "fall through" (try the next origin) vs fatal (bubble up).
   * Closes probe tabs we opened on failure; leaves successful probe tabs alive so
   * the caller can reuse them.
   */
  async function probeOriginWithKey(origin, apiKey) {
    let opened;
    try {
      opened = await findOrOpenPLTabForOrigin(origin, { openInBackground: true });
    } catch (e) {
      return { success: false, fallThrough: false, error: `Could not open ${origin}: ${e.message || String(e)}` };
    }
    const { tab, openedByUs } = opened;

    let outcome;
    try {
      const scriptResults = await runPLExportScript(tab.id, apiKey);
      const payload = scriptResults && scriptResults[0] && scriptResults[0].result;
      if (!payload) {
        outcome = { success: false, fallThrough: false, error: `Could not run script on ${origin} tab.` };
      } else if (payload.error === 'not_ready') {
        // Plugin API never appeared. If we opened the tab ourselves, treat this as
        // "user has no account on this instance" (e.g. ea.* bounced them to sign-in)
        // and fall through to the next origin. If the user already had this tab open,
        // surface the existing "not ready" guidance.
        outcome = {
          success: false,
          fallThrough: openedByUs,
          error: `ProjectionLab plugin API not ready on ${origin}.`,
        };
      } else if (payload.error) {
        try { console.log('[Chrysalis] detect probe error', origin, payload.error); } catch (_) {}
        outcome = {
          success: false,
          fallThrough: isAuthLikeError(payload.error),
          error: payload.error,
        };
      } else {
        outcome = { success: true, accounts: payload.accounts || [], tab };
      }
    } catch (e) {
      outcome = { success: false, fallThrough: false, error: e.message || String(e) };
    }

    if (!outcome.success && openedByUs && tab && tab.id != null) {
      try { await chrome.tabs.remove(tab.id); } catch (_) {}
    }
    return outcome;
  }

  /**
   * Detect which ProjectionLab instance the user's API key belongs to.
   *   1. Cache hit → return immediately.
   *   2. Probe each origin in PL_ORIGINS order (ea.* first). Fall through on
   *      auth-shaped errors and on "plugin API not ready" for probe tabs we
   *      opened ourselves. Surface all other errors immediately.
   *   3. If every origin rejects the key, throw a combined auth error.
   * On a cold-start probe success the accounts payload is carried back so the
   * caller doesn't need a second exportData call.
   */
  async function detectPLOrigin(apiKey) {
    const cached = await getCachedPLOrigin();
    if (cached) return { origin: cached };
    for (const origin of PL_ORIGINS) {
      const probe = await probeOriginWithKey(origin, apiKey);
      if (probe.success) {
        await setCachedPLOrigin(origin);
        return { origin, accounts: probe.accounts };
      }
      if (probe.fallThrough) continue;
      throw new Error(probe.error || 'Unknown ProjectionLab error');
    }
    const hostList = PL_ORIGINS.map((o) => o.replace('https://', '')).join(' or ');
    throw new Error(
      `Your ProjectionLab API key wasn't accepted by ${hostList}. Double-check the key and try again.`
    );
  }

  function runPLExportScript(tabId, apiKey) {
    return chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (key, waitMs, pollMs) => {
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
          if (typeof window.projectionlabPluginAPI !== 'undefined' && typeof window.projectionlabPluginAPI.exportData === 'function') {
            try {
              const data = await window.projectionlabPluginAPI.exportData({ key: key });
              const today = data.today || data;
              const accounts = [];
              const push = (arr, category) => {
                if (Array.isArray(arr)) arr.forEach((a) => accounts.push({ id: a.id, name: a.name || a.id, type: category || 'asset', nativeType: a.type || '' }));
              };
              push(today.savingsAccounts, 'savings');
              push(today.investmentAccounts, 'investment');
              push(today.assets, 'asset');
              push(today.debts, 'debt');
              return { accounts };
            } catch (e) {
              return { error: e.message || String(e) };
            }
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }
        return { error: 'not_ready' };
      },
      args: [apiKey, PL_WAIT_FOR_API_MS, PL_WAIT_POLL_MS],
    });
  }

  async function fetchPLAccounts() {
    const key = plApiKey && plApiKey.trim() ? plApiKey : (await chrome.storage.sync.get(['plApiKey'])).plApiKey;
    if (!key) throw new Error('Save your ProjectionLab API key first.');

    // Detect which instance this key belongs to (or use cached origin).
    // On a cold-start probe success, detection already ran exportData and
    // returns the accounts payload directly — no second call needed.
    const detection = await detectPLOrigin(key);
    if (detection.accounts) return detection.accounts;

    // Cache-hit path: origin is known, run the export against its tab.
    const { tab: plTab } = await findOrOpenPLTabForOrigin(detection.origin);
    for (let attempt = 1; attempt <= PL_API_RETRIES; attempt++) {
      const results = await runPLExportScript(plTab.id, key);
      const payload = results && results[0] && results[0].result;
      if (!payload) throw new Error('Could not run script on ProjectionLab tab.');
      if (payload.error === 'not_ready') {
        if (attempt < PL_API_RETRIES) {
          await new Promise((r) => setTimeout(r, PL_API_RETRY_MS));
          continue;
        }
        throw new Error(
          'ProjectionLab plugin API not ready. Use a tab on the main app (your plan or dashboard at app.projectionlab.com or ea.projectionlab.com), not the Plugins settings page. Sign in, enable Plugins in Account Settings if needed, then open your plan or dashboard and try again.'
        );
      }
      if (payload.error) {
        // Auth failure in the cached-origin path means the key was revoked
        // or the user moved instances — drop the cache so the next click re-probes.
        if (isAuthLikeError(payload.error)) await clearCachedPLOrigin();
        throw new Error(payload.error);
      }
      return payload.accounts || [];
    }
    return [];
  }

  const LOAD_ACCOUNTS_TIMEOUT_MS = 60000;
  const LOAD_STATUS_SHOW_MS = 3000;
  const LOAD_STATUS_FADE_MS = 1000;

  function formatLastRefreshed(ts) {
    if (!ts) return '';
    const sec = (Date.now() - ts) / 1000;
    if (sec < 60) return 'Last refreshed: just now';
    if (sec < 120) return 'Last refreshed: 1 min ago';
    if (sec < 3600) return `Last refreshed: ${Math.floor(sec / 60)} min ago`;
    return 'Last refreshed: ' + new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function setFinalLoadStatus(statusEl, text, onAfterFade) {
    if (!statusEl) return;
    if (statusEl._fadeTimeout1) clearTimeout(statusEl._fadeTimeout1);
    if (statusEl._fadeTimeout2) clearTimeout(statusEl._fadeTimeout2);
    statusEl.classList.remove('load-status-fade-out');
    statusEl.style.opacity = '';
    statusEl.textContent = text;
    statusEl._fadeTimeout1 = setTimeout(() => {
      statusEl._fadeTimeout1 = null;
      statusEl.classList.add('load-status-fade-out');
      statusEl._fadeTimeout2 = setTimeout(() => {
        statusEl._fadeTimeout2 = null;
        statusEl.classList.remove('load-status-fade-out');
        if (typeof onAfterFade === 'function') {
          onAfterFade();
        } else {
          statusEl.textContent = '';
        }
      }, LOAD_STATUS_FADE_MS);
    }, LOAD_STATUS_SHOW_MS);
  }

  document.getElementById('load-accounts').onclick = async () => {
    const btn = document.getElementById('load-accounts');
    const status = document.getElementById('load-status-monarch');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Loading…';
    status.textContent = 'Contacting Monarch… (can take 30–60 sec while we try auth options)';

    try {
      const monarchTab = await findMonarchTab();
      if (!monarchTab) {
        setFinalLoadStatus(status, 'Open a tab to app.monarch.com first.');
        return;
      }

      status.textContent = 'Fetching Monarch accounts… (can take 30–60 sec)';

      await chrome.scripting.executeScript({
        target: { tabId: monarchTab.id },
        files: ['content-scripts/monarch.js'],
      });

      const monarchPromise = chrome.tabs.sendMessage(monarchTab.id, { type: 'FETCH_ACCOUNTS' });
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), LOAD_ACCOUNTS_TIMEOUT_MS);
      });
      const monarchRes = await Promise.race([monarchPromise, timeoutPromise]);

      if (monarchRes && monarchRes.success) {
        monarchAccounts = monarchRes.accounts || [];
        await chrome.storage.local.set({ cachedMonarchAccounts: monarchAccounts });
        reconcileMappingsWithAccounts();
        setFinalLoadStatus(status, `Loaded ${monarchAccounts.length} Monarch accounts.`, () => {
          const now = Date.now();
          chrome.storage.local.set({ lastMonarchRefreshTime: now });
          status.textContent = formatLastRefreshed(now);
        });
        updateStepComplete('step2', monarchAccounts.length > 0 && plAccounts.length > 0);
        renderMappingRows();
      } else {
        setFinalLoadStatus(status, 'Monarch: ' + (monarchRes?.error || 'Failed to load accounts.'), () => {
          const now = Date.now();
          chrome.storage.local.set({ lastMonarchRefreshTime: now });
          status.textContent = formatLastRefreshed(now);
        });
        updateStepComplete('step2', monarchAccounts.length > 0 && plAccounts.length > 0);
      }
    } catch (e) {
      if (e.message === 'timeout') {
        setFinalLoadStatus(status, 'Timed out after 60 seconds. Try again or refresh the Monarch tab and try again.', () => {
          const now = Date.now();
          chrome.storage.local.set({ lastMonarchRefreshTime: now });
          status.textContent = formatLastRefreshed(now);
        });
      } else {
        setFinalLoadStatus(status, 'Error: ' + (e.message || String(e)), () => {
          const now = Date.now();
          chrome.storage.local.set({ lastMonarchRefreshTime: now });
          status.textContent = formatLastRefreshed(now);
        });
      }
      updateStepComplete('step2', monarchAccounts.length > 0 && plAccounts.length > 0);
    } finally {
      restoreStep2Buttons();
      btn.disabled = false;
    }
  };

  document.getElementById('load-pl-accounts').onclick = async () => {
    const btn = document.getElementById('load-pl-accounts');
    const status = document.getElementById('load-status-pl');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Loading…';
    status.textContent = 'Fetching ProjectionLab accounts…';

    try {
      plAccounts = await fetchPLAccounts();
      await chrome.storage.local.set({ cachedPLAccounts: plAccounts });
      reconcileMappingsWithAccounts();
      setFinalLoadStatus(status, `Loaded ${plAccounts.length} ProjectionLab accounts.`, () => {
        const now = Date.now();
        chrome.storage.local.set({ lastPLRefreshTime: now });
        status.textContent = formatLastRefreshed(now);
      });
      updateStepComplete('step2', monarchAccounts.length > 0 && plAccounts.length > 0);
      renderMappingRows();
    } catch (e) {
      setFinalLoadStatus(status, 'ProjectionLab: ' + (e.message || String(e)), () => {
        const now = Date.now();
        chrome.storage.local.set({ lastPLRefreshTime: now });
        status.textContent = formatLastRefreshed(now);
      });
      updateStepComplete('step2', monarchAccounts.length > 0 && plAccounts.length > 0);
    } finally {
      restoreStep2Buttons();
      btn.disabled = false;
    }
  };

  document.getElementById('diagnose-storage').onclick = async () => {
    const wrap = document.getElementById('diagnose-output-wrap');
    const out = document.getElementById('diagnose-output');
    wrap.style.display = 'block';
    out.textContent = 'Running… (have app.monarch.com open in a tab)';
    try {
      const monarchTab = await findMonarchTab();
      if (!monarchTab) {
        out.textContent = 'No tab found for app.monarch.com. Open Monarch in a tab and try again.';
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: monarchTab.id },
        files: ['content-scripts/monarch.js'],
      });
      const res = await chrome.tabs.sendMessage(monarchTab.id, { type: 'DIAGNOSE_STORAGE' });
      if (!res || !res.report) {
        out.textContent = 'No report returned.';
        return;
      }
      const r = res.report;
      const lines = [
        'URL: ' + (r.url || ''),
        '',
        'localStorage (' + (r.local?.length ?? 0) + ' keys):',
        ...(r.local || []).map((e) => '  ' + e.key + ' => ' + e.valueShape),
        '',
        'sessionStorage (' + (r.session?.length ?? 0) + ' keys):',
        ...(r.session || []).map((e) => '  ' + e.key + ' => ' + e.valueShape),
        '',
        'cookies (' + (r.cookies?.length ?? 0) + '):',
        ...(r.cookies || []).map((e) => '  ' + e.name + ' => ' + e.valueShape),
      ];
      if (r.error) lines.push('', 'Error: ' + r.error);
      out.textContent = lines.join('\n');
    } catch (e) {
      out.textContent = 'Error: ' + (e.message || String(e));
    }
  };

  document.getElementById('diagnose-pl').onclick = async () => {
    const wrap = document.getElementById('diagnose-pl-output-wrap');
    const out = document.getElementById('diagnose-pl-output');
    wrap.style.display = 'block';
    out.textContent = 'Checking ProjectionLab tab…';
    try {
      const { tab: plTab } = await findAnyPLTabOrOpen();
      const results = await chrome.scripting.executeScript({
        target: { tabId: plTab.id },
        world: 'MAIN',
        func: () => {
          const report = { url: location.href, hasAPI: false, apiKeys: [], windowKeys: [] };
          if (typeof window.projectionlabPluginAPI !== 'undefined') {
            report.hasAPI = true;
            try {
              report.apiKeys = Object.keys(window.projectionlabPluginAPI);
            } catch (_) {}
          }
          try {
            report.windowKeys = Object.keys(window).filter(
              (k) => /projection|plugin|export/i.test(k)
            );
          } catch (_) {}
          return report;
        },
      });
      const r = results?.[0]?.result;
      if (!r) {
        out.textContent = 'Could not run script on ProjectionLab tab.';
        return;
      }
      const isAppUrl = r.url && !r.url.includes('/docs') && !r.url.includes('/settings');
      const hint = !r.hasAPI
        ? isAppUrl
          ? 'API not loaded yet. Ensure Plugins are enabled (Account Settings → Plugins), refresh this tab, wait for the app to load, then try Load Accounts — the extension will wait up to 20s for the API.'
          : 'This tab is not the app. Use a tab on the main ProjectionLab app (your plan/dashboard at app.projectionlab.com or ea.projectionlab.com), not /docs/ or /settings/plugins.'
        : '';
      const lines = [
        '(Checking page\'s main context.)',
        'URL: ' + (r.url || ''),
        'window.projectionlabPluginAPI: ' + (r.hasAPI ? 'present' : 'MISSING'),
        r.hasAPI ? '  methods: ' + (r.apiKeys?.join(', ') || '[]') : '',
        'Other window keys (projection/plugin/export): ' + (r.windowKeys?.join(', ') || 'none'),
        hint ? '' : null,
        hint || null,
      ].filter(Boolean);
      out.textContent = lines.join('\n');
    } catch (e) {
      out.textContent = 'Error: ' + (e.message || String(e));
    }
  };

  document.getElementById('inspect-schema').onclick = async () => {
    const wrap = document.getElementById('schema-output-wrap');
    const out = document.getElementById('schema-output');
    wrap.style.display = 'block';
    out.textContent = 'Fetching export schema…';
    try {
      const key = plApiKey && plApiKey.trim() ? plApiKey : (await chrome.storage.sync.get(['plApiKey'])).plApiKey;
      if (!key) {
        out.textContent = 'Save your ProjectionLab API key first (Step 1).';
        return;
      }
      const { tab: plTab } = await findAnyPLTabOrOpen();
      const results = await chrome.scripting.executeScript({
        target: { tabId: plTab.id },
        world: 'MAIN',
        func: async (apiKey) => {
          if (typeof window.projectionlabPluginAPI === 'undefined' || typeof window.projectionlabPluginAPI.exportData !== 'function') {
            return { error: 'Plugin API or exportData not available' };
          }
          const data = await window.projectionlabPluginAPI.exportData({ key: apiKey });
          const today = data.today || data;
          const sample = (arr, label) => {
            const items = Array.isArray(arr) ? arr : [];
            const accountTypes = items.length ? [...new Set(items.map((a) => a.type || '').filter(Boolean))] : [];
            const keys = items.length ? Object.keys(items[0]) : [];
            return { type: label, keys, samples: items, accountTypes };
          };
          return {
            savingsAccounts: sample(today.savingsAccounts, 'savingsAccounts'),
            investmentAccounts: sample(today.investmentAccounts, 'investmentAccounts'),
            assets: sample(today.assets, 'assets'),
            debts: sample(today.debts, 'debts'),
          };
        },
        args: [key],
      });
      const payload = results?.[0]?.result;
      if (!payload) {
        out.textContent = 'Could not run script on ProjectionLab tab.';
        return;
      }
      if (payload.error) {
        out.textContent = payload.error;
        return;
      }
      const lines = [
        'ProjectionLab exportData schema (all accounts per category).',
        'We use CATEGORY for updateAccount: savingsAccounts→balance, investmentAccounts→balance, assets→balance, debts→amount.',
        'Account "type" (taxable, roth-ira, savings, debt) is per-account; we only use which category the account is in.',
        '',
        ...Object.entries(payload).map(([cat, v]) => {
          if (!v || v.error) return `${cat}: (none or error)`;
          const keyList = v.keys && v.keys.length ? v.keys.join(', ') : '—';
          const balanceLike = v.keys && v.keys.filter((k) => /balance|amount|value|current/i.test(k));
          const typeList = (v.accountTypes && v.accountTypes.length) ? v.accountTypes.join(', ') : '—';
          const sampleLines = (v.samples || []).map((s, i) =>
            `Account ${i + 1}: ` + JSON.stringify(s, null, 2).split('\n').join('\n  ')
          );
          return [
            `--- ${cat} ---`,
            `Account types in this category: ${typeList}`,
            `Keys: ${keyList}`,
            balanceLike.length ? `  (balance-like: ${balanceLike.join(', ')})` : '',
            ...sampleLines,
          ].filter(Boolean).join('\n');
        }),
      ];
      out.textContent = lines.join('\n');
    } catch (e) {
      out.textContent = 'Error: ' + (e.message || String(e));
    }
  };

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  const MONARCH_TYPE_DISPLAY_NAMES = {
    brokerage: 'Investments',
    credit: 'Credit Cards',
    depository: 'Cash',
    loan: 'Loans',
    real_estate: 'Real Estate',
    vehicle: 'Vehicles',
    valuables: 'Valuables',
    equity: 'Equity',
    other_liability: 'Other Liabilities',
    other_asset: 'Other Assets',
  };
  const MONARCH_CATEGORY_ORDER = ['depository', 'credit', 'brokerage', 'loan', 'vehicle', 'real_estate', 'valuables', 'equity', 'other_liability', 'other_asset'];
  const PL_CATEGORY_ORDER = ['Savings', 'Investments', 'Real Assets', 'Unsecured Debts'];
  const PL_TYPE_TO_CATEGORY = {
    savings: 'Savings',
    investment: 'Investments',
    asset: 'Real Assets',
    debt: 'Unsecured Debts',
  };
  function getPLCategory(plAccount) {
    const type = (plAccount.type || 'asset').toLowerCase();
    return PL_TYPE_TO_CATEGORY[type] || 'Real Assets';
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
  function getMonarchIdsUsedInOtherRows(currentMapping) {
    const used = new Set();
    for (const m of accountMappings) {
      if (m === currentMapping) continue;
      for (const ma of m.monarchAccounts || []) used.add(ma.id);
      for (const ma of m.monarchAccountsLoan || []) used.add(ma.id);
    }
    return used;
  }

  function getPlIdsUsedInOtherRows(currentMapping) {
    const used = new Set();
    for (const m of accountMappings) {
      if (m === currentMapping) continue;
      if (m.plId) used.add(m.plId);
    }
    return used;
  }

  function getFilteredGroupedPL(query, currentMapping) {
    const usedElsewhere = getPlIdsUsedInOtherRows(currentMapping || null);
    const available = plAccounts.filter(
      (a) => !usedElsewhere.has(a.id) || (currentMapping && currentMapping.plId === a.id)
    );
    const filtered = !query
      ? available
      : available.filter(
          (a) =>
            fuzzyMatch(query, a.name) ||
            fuzzyMatch(query, getPLCategory(a))
        );
    const byCategory = new Map();
    for (const a of filtered) {
      const cat = getPLCategory(a);
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(a);
    }
    const sortedCategories = Array.from(byCategory.keys()).sort((a, b) => {
      const i = PL_CATEGORY_ORDER.indexOf(a);
      const j = PL_CATEGORY_ORDER.indexOf(b);
      const iVal = i >= 0 ? i : 999;
      const jVal = j >= 0 ? j : 999;
      return iVal - jVal;
    });
    return { sortedCategories, byCategory };
  }
  function getUnselectedMonarchIds(selectedIds, currentMapping) {
    const usedElsewhere = getMonarchIdsUsedInOtherRows(currentMapping || null);
    return monarchAccounts
      .filter((a) => !selectedIds.has(a.id) && !usedElsewhere.has(a.id))
      .map((a) => ({ id: a.id, name: a.name, type: (a.type && String(a.type).trim()) || 'other_asset' }));
  }
  function displayNameForType(apiType) {
    return MONARCH_TYPE_DISPLAY_NAMES[apiType] || apiType;
  }
  function fuzzyMatch(query, str) {
    if (!query || !str) return true;
    const q = query.toLowerCase().trim();
    const s = String(str).toLowerCase();
    let j = 0;
    for (let i = 0; i < q.length; i++) {
      j = s.indexOf(q[i], j);
      if (j === -1) return false;
      j += 1;
    }
    return true;
  }
  function getFilteredGrouped(unselected, query) {
    const filtered = !query
      ? unselected
      : unselected.filter(
          (a) => fuzzyMatch(query, a.name) || fuzzyMatch(query, displayNameForType(a.type))
        );
    const byCategory = new Map();
    for (const a of filtered) {
      const cat = a.type || 'other_asset';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(a);
    }
    const sortedCategories = Array.from(byCategory.keys()).sort((a, b) => {
      const i = MONARCH_CATEGORY_ORDER.indexOf(a);
      const j = MONARCH_CATEGORY_ORDER.indexOf(b);
      const iVal = i >= 0 ? i : 999;
      const jVal = j >= 0 ? j : 999;
      if (iVal !== jVal) return iVal - jVal;
      return a.localeCompare(b);
    });
    return { sortedCategories, byCategory };
  }
  function buildMonarchOptionsByCategory(unselected) {
    if (!unselected.length) return '';
    const byCategory = new Map();
    for (const a of unselected) {
      const cat = a.type || 'other_asset';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(a);
    }
    const sortedCategories = Array.from(byCategory.keys()).sort((a, b) => {
      const i = MONARCH_CATEGORY_ORDER.indexOf(a);
      const j = MONARCH_CATEGORY_ORDER.indexOf(b);
      const iVal = i >= 0 ? i : 999;
      const jVal = j >= 0 ? j : 999;
      if (iVal !== jVal) return iVal - jVal;
      return a.localeCompare(b);
    });
    let html = '<option value="">+ add Monarch account</option>';
    for (const cat of sortedCategories) {
      const accounts = byCategory.get(cat);
      html += `<optgroup label="${escapeHtml(displayNameForType(cat))}">`;
      for (const a of accounts) {
        html += `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`;
      }
      html += '</optgroup>';
    }
    return html;
  }

  function addMappingRow(mapping) {
    // Ensure mapping has the expected shape so a bad entry can't break rendering.
    if (!mapping || typeof mapping !== 'object') {
      mapping = {};
    }
    mapping.plId = mapping.plId || '';
    mapping.plName = mapping.plName || '';
    mapping.plType = mapping.plType || 'asset';
    mapping.plNativeType = mapping.plNativeType || '';
    if (!Array.isArray(mapping.monarchAccounts)) mapping.monarchAccounts = [];
    if (!Array.isArray(mapping.monarchAccountsLoan)) mapping.monarchAccountsLoan = [];
    const tbody = document.getElementById('map-tbody');
    const tr = document.createElement('tr');
    if (!mapping.monarchAccountsLoan) mapping.monarchAccountsLoan = [];
    const selected = new Set((mapping.monarchAccounts || []).map((a) => a.id));
    const plId = mapping.plId || '';
    const plName = mapping.plName || '';

    // Arrow cell is needed by both normal and asset-with-loan layouts; define it early
    // so updateArrow can be safely called from any render function.
    const cellArrow = document.createElement('td');
    cellArrow.className = 'map-arrow';
    const arrowSpan = document.createElement('span');
    cellArrow.appendChild(arrowSpan);
    function updateArrow() {
      const isDual = isAssetWithLoanMapping(mapping);
      const valueCount = mapping.monarchAccounts?.length || 0;
      const loanCount = isDual ? (mapping.monarchAccountsLoan?.length || 0) : 0;
      const total = valueCount + loanCount;
      const multi = total > 1;
      arrowSpan.setAttribute('data-aggregate', multi ? '1' : '0');
      arrowSpan.textContent = multi ? '∑→' : '→';
      arrowSpan.title = multi ? (isDual ? 'Value and loan balances will be summed per field' : 'Balances will be summed') : '';
    }

    const cellMonarch = document.createElement('td');
    cellMonarch.className = 'map-cell';
    const monarchCellWrap = document.createElement('div');
    const monarchNormalLayout = document.createElement('div');
    monarchNormalLayout.className = 'monarch-normal-layout';
    const chipsRow = document.createElement('div');
    chipsRow.className = 'chips-row';
    const addMonarchRow = document.createElement('div');
    addMonarchRow.className = 'monarch-add-row';
    function renderChips() {
      chipsRow.innerHTML = '';
      (mapping.monarchAccounts || []).forEach((ma) => {
        const tag = document.createElement('span');
        tag.className = 'chip-tag';
        tag.innerHTML = `${escapeHtml(ma.name)} <button type="button" class="remove" data-id="${escapeHtml(ma.id)}" aria-label="Remove">×</button>`;
        tag.querySelector('.remove').onclick = async () => {
          selected.delete(ma.id);
          mapping.monarchAccounts = mapping.monarchAccounts.filter((a) => a.id !== ma.id);
          renderChips();
          renderDropdown();
          await persistMappings();
        };
        chipsRow.appendChild(tag);
      });
      addMonarchRow.innerHTML = '';
      const unselected = getUnselectedMonarchIds(selected, mapping);
      if (unselected.length) {
        const dropdownWrap = document.createElement('span');
        const widget = document.createElement('div');
        widget.className = 'monarch-add-widget';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'add-dropdown-search';
        input.placeholder = '+ add Monarch account';
        input.autocomplete = 'off';
        const panel = document.createElement('div');
        panel.className = 'monarch-add-panel';
        panel.setAttribute('role', 'listbox');
        function addAccount(id) {
          const acc = monarchAccounts.find((a) => a.id === id);
          if (acc) {
            selected.add(id);
            if (!mapping.monarchAccounts) mapping.monarchAccounts = [];
            mapping.monarchAccounts.push({ id: acc.id, name: acc.name });
            input.value = '';
            panel.style.display = 'none';
            renderChips();
            renderDropdown();
            autoSaveMappingsIfRowComplete(mapping, tr);
          }
        }
        function updatePanel() {
          const unselectedNow = getUnselectedMonarchIds(selected, mapping);
          const query = input.value.trim();
          const { sortedCategories, byCategory } = getFilteredGrouped(unselectedNow, query);
          panel.innerHTML = '';
          for (const cat of sortedCategories) {
            const header = document.createElement('div');
            header.className = 'monarch-add-panel-header';
            header.textContent = displayNameForType(cat);
            panel.appendChild(header);
            for (const a of byCategory.get(cat)) {
              const opt = document.createElement('div');
              opt.className = 'monarch-add-panel-option';
              opt.textContent = a.name;
              opt.setAttribute('data-id', a.id);
              opt.setAttribute('role', 'option');
              opt.onclick = () => addAccount(a.id);
              panel.appendChild(opt);
            }
          }
          panel.style.display = sortedCategories.length > 0 || query ? 'block' : 'none';
        }
        input.onfocus = () => {
          updatePanel();
          setTimeout(() => {
            document.addEventListener('click', function closePanel(ev) {
              if (!widget.contains(ev.target)) {
                panel.style.display = 'none';
                document.removeEventListener('click', closePanel);
              }
            });
          }, 0);
        };
        input.oninput = () => updatePanel();
        input.onkeydown = (e) => {
          if (e.key === 'Escape') {
            panel.style.display = 'none';
            input.blur();
          }
        };
        widget.appendChild(input);
        widget.appendChild(panel);
        updatePanel();
        panel.style.display = 'none';
        dropdownWrap.appendChild(widget);
        addMonarchRow.appendChild(dropdownWrap);
      }
    }
    function renderDropdown() {
      const wrap = addMonarchRow.querySelector('span');
      if (!wrap) return;
      const widget = wrap.querySelector('.monarch-add-widget');
      const unselected = getUnselectedMonarchIds(selected, mapping);
      if (widget && unselected.length) {
        const input = widget.querySelector('.add-dropdown-search');
        const panel = widget.querySelector('.monarch-add-panel');
        if (input && panel) {
          const query = input.value.trim();
          const { sortedCategories, byCategory } = getFilteredGrouped(unselected, query);
          panel.innerHTML = '';
          for (const cat of sortedCategories) {
            const header = document.createElement('div');
            header.className = 'monarch-add-panel-header';
            header.textContent = displayNameForType(cat);
            panel.appendChild(header);
            for (const a of byCategory.get(cat)) {
              const opt = document.createElement('div');
              opt.className = 'monarch-add-panel-option';
              opt.textContent = a.name;
              opt.setAttribute('data-id', a.id);
              opt.setAttribute('role', 'option');
              opt.onclick = () => {
                const acc = monarchAccounts.find((x) => x.id === a.id);
                if (acc) {
                  selected.add(a.id);
                  if (!mapping.monarchAccounts) mapping.monarchAccounts = [];
                  mapping.monarchAccounts.push({ id: acc.id, name: acc.name });
                  input.value = '';
                  panel.style.display = 'none';
                  renderChips();
                  renderDropdown();
                  autoSaveMappingsIfRowComplete(mapping, tr);
                }
              };
              panel.appendChild(opt);
            }
          }
          panel.style.display = 'none';
        }
      } else if (widget && !unselected.length) {
        widget.remove();
      }
    }
    renderChips();
    monarchNormalLayout.appendChild(chipsRow);
    monarchNormalLayout.appendChild(addMonarchRow);

    const monarchAssetWithLoanLayout = document.createElement('div');
    monarchAssetWithLoanLayout.className = 'monarch-asset-with-loan-layout';
    function getCombinedSelectedIds() {
      const ids = new Set();
      (mapping.monarchAccounts || []).forEach((a) => ids.add(a.id));
      (mapping.monarchAccountsLoan || []).forEach((a) => ids.add(a.id));
      return ids;
    }
    const valueLane = document.createElement('div');
    valueLane.className = 're-lane';
    const valueLabel = document.createElement('div');
    valueLabel.className = 're-lane-label';
    valueLabel.textContent = 'Asset value';
    const valueChipsRow = document.createElement('div');
    valueChipsRow.className = 'chips-row';
    const valueAddRow = document.createElement('div');
    valueAddRow.className = 'monarch-add-row';
    valueLane.appendChild(valueLabel);
    valueLane.appendChild(valueChipsRow);
    valueLane.appendChild(valueAddRow);
    const loanLane = document.createElement('div');
    loanLane.className = 're-lane';
    const loanLabel = document.createElement('div');
    loanLabel.className = 're-lane-label';
    loanLabel.textContent = 'Loan';
    const loanChipsRow = document.createElement('div');
    loanChipsRow.className = 'chips-row';
    const loanAddRow = document.createElement('div');
    loanAddRow.className = 'monarch-add-row';
    loanLane.appendChild(loanLabel);
    loanLane.appendChild(loanChipsRow);
    loanLane.appendChild(loanAddRow);
    monarchAssetWithLoanLayout.appendChild(valueLane);
    monarchAssetWithLoanLayout.appendChild(loanLane);

    function renderValueLane() {
      valueChipsRow.innerHTML = '';
      (mapping.monarchAccounts || []).forEach((ma) => {
        const tag = document.createElement('span');
        tag.className = 'chip-tag';
        tag.innerHTML = `${escapeHtml(ma.name)} <button type="button" class="remove" aria-label="Remove">×</button>`;
        tag.querySelector('.remove').onclick = async () => {
          mapping.monarchAccounts = mapping.monarchAccounts.filter((a) => a.id !== ma.id);
          renderValueLane();
          renderLoanLane();
          await persistMappings();
        };
        valueChipsRow.appendChild(tag);
      });
      valueAddRow.innerHTML = '';
      const unselected = getUnselectedMonarchIds(getCombinedSelectedIds(), mapping);
      if (unselected.length) {
        const wrap = document.createElement('span');
        const widget = document.createElement('div');
        widget.className = 'monarch-add-widget';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'add-dropdown-search';
        input.placeholder = '+ add Monarch account';
        input.autocomplete = 'off';
        const panel = document.createElement('div');
        panel.className = 'monarch-add-panel';
        panel.setAttribute('role', 'listbox');
        function addToValue(id) {
          const acc = monarchAccounts.find((a) => a.id === id);
          if (acc) {
            if (!mapping.monarchAccounts) mapping.monarchAccounts = [];
            mapping.monarchAccounts.push({ id: acc.id, name: acc.name });
            input.value = '';
            panel.style.display = 'none';
            renderValueLane();
            renderLoanLane();
            autoSaveMappingsIfRowComplete(mapping, tr);
          }
        }
        function updatePanel() {
          const unselectedNow = getUnselectedMonarchIds(getCombinedSelectedIds(), mapping);
          const query = input.value.trim();
          const { sortedCategories, byCategory } = getFilteredGrouped(unselectedNow, query);
          panel.innerHTML = '';
          for (const cat of sortedCategories) {
            const header = document.createElement('div');
            header.className = 'monarch-add-panel-header';
            header.textContent = displayNameForType(cat);
            panel.appendChild(header);
            for (const a of byCategory.get(cat)) {
              const opt = document.createElement('div');
              opt.className = 'monarch-add-panel-option';
              opt.textContent = a.name;
              opt.setAttribute('data-id', a.id);
              opt.onclick = () => addToValue(a.id);
              panel.appendChild(opt);
            }
          }
          panel.style.display = sortedCategories.length > 0 || query ? 'block' : 'none';
        }
        input.onfocus = () => { updatePanel(); setTimeout(() => { document.addEventListener('click', function close(ev) { if (!widget.contains(ev.target)) { panel.style.display = 'none'; document.removeEventListener('click', close); } }); }, 0); };
        input.oninput = () => updatePanel();
        input.onkeydown = (e) => { if (e.key === 'Escape') { panel.style.display = 'none'; input.blur(); } };
        widget.appendChild(input);
        widget.appendChild(panel);
        updatePanel();
        panel.style.display = 'none';
        wrap.appendChild(widget);
        valueAddRow.appendChild(wrap);
      }
      if (typeof updateArrow === 'function') updateArrow();
    }
    function renderLoanLane() {
      loanChipsRow.innerHTML = '';
      (mapping.monarchAccountsLoan || []).forEach((ma) => {
        const tag = document.createElement('span');
        tag.className = 'chip-tag';
        tag.innerHTML = `${escapeHtml(ma.name)} <button type="button" class="remove" aria-label="Remove">×</button>`;
        tag.querySelector('.remove').onclick = async () => {
          mapping.monarchAccountsLoan = mapping.monarchAccountsLoan.filter((a) => a.id !== ma.id);
          renderValueLane();
          renderLoanLane();
          await persistMappings();
        };
        loanChipsRow.appendChild(tag);
      });
      loanAddRow.innerHTML = '';
      const unselected = getUnselectedMonarchIds(getCombinedSelectedIds(), mapping);
      if (unselected.length) {
        const wrap = document.createElement('span');
        const widget = document.createElement('div');
        widget.className = 'monarch-add-widget';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'add-dropdown-search';
        input.placeholder = '+ add Monarch account';
        input.autocomplete = 'off';
        const panel = document.createElement('div');
        panel.className = 'monarch-add-panel';
        panel.setAttribute('role', 'listbox');
        function addToLoan(id) {
          const acc = monarchAccounts.find((a) => a.id === id);
          if (acc) {
            if (!mapping.monarchAccountsLoan) mapping.monarchAccountsLoan = [];
            mapping.monarchAccountsLoan.push({ id: acc.id, name: acc.name });
            input.value = '';
            panel.style.display = 'none';
            renderValueLane();
            renderLoanLane();
            autoSaveMappingsIfRowComplete(mapping, tr);
          }
        }
        function updatePanel() {
          const unselectedNow = getUnselectedMonarchIds(getCombinedSelectedIds(), mapping);
          const query = input.value.trim();
          const { sortedCategories, byCategory } = getFilteredGrouped(unselectedNow, query);
          panel.innerHTML = '';
          for (const cat of sortedCategories) {
            const header = document.createElement('div');
            header.className = 'monarch-add-panel-header';
            header.textContent = displayNameForType(cat);
            panel.appendChild(header);
            for (const a of byCategory.get(cat)) {
              const opt = document.createElement('div');
              opt.className = 'monarch-add-panel-option';
              opt.textContent = a.name;
              opt.setAttribute('data-id', a.id);
              opt.onclick = () => addToLoan(a.id);
              panel.appendChild(opt);
            }
          }
          panel.style.display = sortedCategories.length > 0 || query ? 'block' : 'none';
        }
        input.onfocus = () => { updatePanel(); setTimeout(() => { document.addEventListener('click', function close(ev) { if (!widget.contains(ev.target)) { panel.style.display = 'none'; document.removeEventListener('click', close); } }); }, 0); };
        input.oninput = () => updatePanel();
        input.onkeydown = (e) => { if (e.key === 'Escape') { panel.style.display = 'none'; input.blur(); } };
        widget.appendChild(input);
        widget.appendChild(panel);
        updatePanel();
        panel.style.display = 'none';
        wrap.appendChild(widget);
        loanAddRow.appendChild(wrap);
      }
      if (typeof updateArrow === 'function') updateArrow();
    }
    function updateMonarchLayout() {
      const isDual = isAssetWithLoanMapping(mapping);
      if (isDual) {
        mapping.monarchAccountsLoan = mapping.monarchAccountsLoan || [];
        monarchNormalLayout.classList.add('hidden');
        monarchAssetWithLoanLayout.classList.add('visible');
        renderValueLane();
        renderLoanLane();
      } else {
        monarchNormalLayout.classList.remove('hidden');
        monarchAssetWithLoanLayout.classList.remove('visible');
      }
    }

    monarchCellWrap.appendChild(monarchNormalLayout);
    monarchCellWrap.appendChild(monarchAssetWithLoanLayout);
    cellMonarch.appendChild(monarchCellWrap);
    tr.appendChild(cellMonarch);
    updateMonarchLayout();
    updateArrow();
    tr.appendChild(cellArrow);

    const cellPL = document.createElement('td');
    cellPL.className = 'map-cell map-cell-pl';
    const plWidget = document.createElement('div');
    plWidget.className = 'monarch-add-widget';
    const plInput = document.createElement('input');
    plInput.type = 'text';
    plInput.className = 'add-dropdown-search';
    plInput.placeholder = 'Select ProjectionLab account';
    plInput.autocomplete = 'off';
    plInput.readOnly = true;
    const plPanel = document.createElement('div');
    plPanel.className = 'monarch-add-panel';
    plPanel.setAttribute('role', 'listbox');
    function updatePLInputLabel() {
      if (mapping.plId && mapping.plName) {
        plInput.value = mapping.plName;
        plInput.placeholder = '';
      } else {
        plInput.value = '';
        plInput.placeholder = 'Select ProjectionLab account';
      }
    }
    function updatePLPanel() {
      const query = plInput === document.activeElement ? plInput.value.trim() : '';
      const { sortedCategories, byCategory } = getFilteredGroupedPL(query, mapping);
      plPanel.innerHTML = '';
      for (const cat of sortedCategories) {
        const header = document.createElement('div');
        header.className = 'monarch-add-panel-header';
        header.textContent = cat;
        plPanel.appendChild(header);
        for (const a of byCategory.get(cat)) {
          const opt = document.createElement('div');
          opt.className = 'monarch-add-panel-option';
          opt.textContent = a.name;
          opt.setAttribute('data-id', a.id);
          opt.setAttribute('role', 'option');
          opt.onclick = () => {
            const acc = plAccounts.find((x) => x.id === a.id);
            if (acc) {
              mapping.plId = acc.id;
              mapping.plName = acc.name;
              mapping.plType = acc.type || 'asset';
              mapping.plNativeType = acc.nativeType || '';
              updatePLInputLabel();
              updatePLClearVisibility();
              plPanel.style.display = 'none';
              if (typeof updateMonarchLayout === 'function') updateMonarchLayout();
              autoSaveMappingsIfRowComplete(mapping, tr);
            }
          };
          plPanel.appendChild(opt);
        }
      }
      plPanel.style.display = 'none';
    }
    plInput.onfocus = () => {
      plInput.readOnly = false;
      plInput.value = '';
      updatePLClearVisibility();
      updatePLPanel();
      const { sortedCategories } = getFilteredGroupedPL('', mapping);
      plPanel.style.display = sortedCategories.length > 0 ? 'block' : 'none';
      setTimeout(() => {
        document.addEventListener('click', function closePLPanel(ev) {
          if (!plWidget.contains(ev.target)) {
            plPanel.style.display = 'none';
            plInput.readOnly = true;
            updatePLInputLabel();
            updatePLClearVisibility();
            document.removeEventListener('click', closePLPanel);
          }
        });
      }, 0);
    };
    plInput.onkeydown = (e) => {
      if (e.key === 'Escape') {
        plPanel.style.display = 'none';
        plInput.readOnly = true;
        updatePLInputLabel();
        updatePLClearVisibility();
        plInput.blur();
      }
    };
    const plSearchWrap = document.createElement('div');
    plSearchWrap.className = 'pl-search-wrap';
    const plClearBtn = document.createElement('button');
    plClearBtn.type = 'button';
    plClearBtn.className = 'pl-search-clear';
    plClearBtn.innerHTML = '×';
    plClearBtn.setAttribute('aria-label', 'Clear selection');
    plClearBtn.hidden = true;
    function updatePLClearVisibility() {
      const showSearch = !plInput.readOnly && plInput.value.length > 0;
      const showSelection = !!(plInput.readOnly && mapping.plId);
      const show = showSearch || showSelection;
      plClearBtn.hidden = !show;
      plClearBtn.setAttribute('aria-label', showSelection ? 'Clear ProjectionLab account' : 'Clear search');
      plInput.classList.toggle('has-clear', show);
    }
    plClearBtn.onclick = async (e) => {
      e.preventDefault();
      if (mapping.plId) {
        mapping.plId = '';
        mapping.plName = '';
        mapping.plType = '';
        mapping.plNativeType = '';
        updatePLInputLabel();
        updatePLClearVisibility();
        if (typeof updateMonarchLayout === 'function') updateMonarchLayout();
        await persistMappings();
      } else {
        plInput.value = '';
        plInput.focus();
        updatePLPanel();
        updatePLClearVisibility();
      }
    };
    plInput.oninput = () => {
      updatePLPanel();
      const query = plInput.value.trim();
      const { sortedCategories } = getFilteredGroupedPL(query, mapping);
      plPanel.style.display = sortedCategories.length > 0 || query ? 'block' : 'none';
      updatePLClearVisibility();
    };
    plSearchWrap.appendChild(plInput);
    plSearchWrap.appendChild(plClearBtn);
    if (plId) {
      const acc = plAccounts.find((a) => a.id === plId);
      if (acc) {
        mapping.plId = acc.id;
        mapping.plName = plName || acc.name;
        mapping.plType = mapping.plType || acc.type || 'asset';
        mapping.plNativeType = mapping.plNativeType || acc.nativeType || '';
      }
    }
    updatePLInputLabel();
    updatePLClearVisibility();
    updatePLPanel();
    plPanel.style.display = 'none';
    plWidget.appendChild(plSearchWrap);
    plWidget.appendChild(plPanel);
    cellPL.appendChild(plWidget);
    tr.appendChild(cellPL);

    const cellSaved = document.createElement('td');
    cellSaved.className = 'col-saved';
    const savedCheck = document.createElement('span');
    savedCheck.className = 'row-saved-check';
    savedCheck.style.display = 'none';
    savedCheck.textContent = '✓';
    savedCheck.setAttribute('aria-label', 'Saved');
    cellSaved.appendChild(savedCheck);
    tr.appendChild(cellSaved);

    const cellRemove = document.createElement('td');
    cellRemove.className = 'col-remove';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-row';
    removeBtn.innerHTML = '×';
    removeBtn.title = 'Remove row';
    removeBtn.onclick = async () => {
      const idx = accountMappings.indexOf(mapping);
      if (idx !== -1) accountMappings.splice(idx, 1);
      tr.remove();
      await persistMappings();
    };
    cellRemove.appendChild(removeBtn);
    tr.appendChild(cellRemove);

    tbody.appendChild(tr);

    const origRender = renderChips;
    renderChips = () => {
      origRender();
      updateArrow();
    };
  }

  function renderMappingRows() {
    const tbody = document.getElementById('map-tbody');
    tbody.innerHTML = '';
    if (accountMappings.length === 0) {
      accountMappings.push({ plId: '', plName: '', plType: '', plNativeType: '', monarchAccounts: [], monarchAccountsLoan: [] });
    }
    const safe = [];
    accountMappings.forEach((m) => {
      try {
        addMappingRow(m);
        safe.push(m);
      } catch (e) {
        // If a row cannot be rendered for any reason, drop it from the in-memory list
        // so it doesn't "reserve" Monarch/PL accounts invisibly.
        console.error('[Chrysalis] Failed to render mapping row, dropping entry:', e, m);
      }
    });
    if (safe.length !== accountMappings.length) {
      accountMappings.length = 0;
      accountMappings.push(...safe);
      persistMappings();
    }
    const addRowBtn = document.getElementById('add-row');
    const allMappedMsg = document.getElementById('all-pl-mapped');
    if (addRowBtn && allMappedMsg) {
      const used = new Set(accountMappings.map((m) => m.plId).filter(Boolean));
      const remaining = plAccounts.filter((a) => !used.has(a.id));
      const noneLeft = plAccounts.length > 0 && remaining.length === 0;
      addRowBtn.style.display = noneLeft ? 'none' : '';
      allMappedMsg.style.display = noneLeft ? 'block' : 'none';
    }
  }

  document.getElementById('add-row').onclick = () => {
    const mapping = { plId: '', plName: '', plType: '', plNativeType: '', monarchAccounts: [], monarchAccountsLoan: [] };
    accountMappings.push(mapping);
    const tbody = document.getElementById('map-tbody');
    addMappingRow(mapping);
  };

  function showRowSavedCheck(tr) {
    const check = tr.querySelector('.row-saved-check');
    if (!check) return;
    if (tr._savedCheckTimeout) clearTimeout(tr._savedCheckTimeout);
    check.style.display = 'inline';
    tr._savedCheckTimeout = setTimeout(() => {
      check.style.display = 'none';
      tr._savedCheckTimeout = null;
    }, 3000);
  }

  async function persistMappings() {
    if (!(await saveMappingsToStorage([...accountMappings]))) return false;
    try {
      console.log('[Chrysalis][setup] persistMappings saving accountMappings:', accountMappings);
    } catch (_) {}
    updateChips();
    const step3Complete = accountMappings.some((m) => {
      if (!m.plId) return false;
      if (isAssetWithLoanMapping(m)) {
        const valueCount = m.monarchAccounts?.length || 0;
        const loanCount = m.monarchAccountsLoan?.length || 0;
        return valueCount + loanCount > 0;
      }
      return (m.monarchAccounts?.length || 0) > 0;
    });
    updateStepComplete('step3', step3Complete);
    return true;
  }

  async function autoSaveMappingsIfRowComplete(mapping, tr) {
    // Save whenever this row has *any* meaningful data (PL account and/or Monarch accounts),
    // instead of relying on asset/loan lane heuristics. This avoids edge cases where
    // dual‑lane (asset with loan) rows fail to persist.
    const hasPl = !!(mapping.plId && String(mapping.plId).trim());
    const hasMonarchValue = Array.isArray(mapping.monarchAccounts) && mapping.monarchAccounts.length > 0;
    const hasMonarchLoan = Array.isArray(mapping.monarchAccountsLoan) && mapping.monarchAccountsLoan.length > 0;
    if (!hasPl && !hasMonarchValue && !hasMonarchLoan) return;
    if (await persistMappings()) showRowSavedCheck(tr);
  }

  setupStepToggles();
  setupAdvancedSection();
  setHeaderLogoUrl();
  setStep2ButtonIconUrls();
  loadStorage();
})();
