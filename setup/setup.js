/**
 * Setup page — API key, load Monarch/PL accounts, map accounts (many-to-one). Schema migration for old flat mappings.
 */

(function () {
  // ProjectionLab origins. By default Chrysalis only uses the standard app.*
  // instance. Early Access users opt in via the Step 1 toggle
  // (chrome.storage.sync.plUseEarlyAccess), which makes ea.* the preferred
  // origin with app.* kept as a fallback. ALL_PL_ORIGINS is the full set, used
  // only to recognize a PL URL regardless of the user's preference.
  const APP_PL_ORIGIN = 'https://app.projectionlab.com';
  const EA_PL_ORIGIN = 'https://ea.projectionlab.com';
  const ALL_PL_ORIGINS = [EA_PL_ORIGIN, APP_PL_ORIGIN];
  async function getPlOrigins() {
    const { plUseEarlyAccess } = await chrome.storage.sync.get(['plUseEarlyAccess']);
    return plUseEarlyAccess ? [EA_PL_ORIGIN, APP_PL_ORIGIN] : [APP_PL_ORIGIN];
  }
  const MONARCH_ORIGIN = 'https://app.monarch.com';
  const PL_LOAD_DELAY_MS = 4500;
  const PL_API_RETRY_MS = 2000;
  const PL_API_RETRIES = 5;
  const PL_WAIT_FOR_API_MS = 20000;
  const PL_WAIT_POLL_MS = 400;

  function plOriginForUrl(url) {
    return ALL_PL_ORIGINS.find((o) => typeof url === 'string' && url.startsWith(o)) || null;
  }
  async function getCachedPLOrigin() {
    const { plOrigin } = await chrome.storage.local.get(['plOrigin']);
    if (!plOrigin) return null;
    // Ignore a cached origin that the current Early Access setting disallows
    // (e.g. a stale ea.* cache after the user turned Early Access back off).
    const allowed = await getPlOrigins();
    return allowed.includes(plOrigin) ? plOrigin : null;
  }
  async function setCachedPLOrigin(origin) {
    if (origin && ALL_PL_ORIGINS.includes(origin)) {
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
  // Per split Monarch account: { note, updatedAt }. Stored under accountSplitMeta.<id> in sync storage.
  let splitMeta = {};
  let mappingStorageLoadError = null;

  const Model = window.ChrysalisMappingModel;
  const normalizeMappings = (raw) => Model.normalizeMappings(raw);
  const USD_CENTS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

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

  function formatMappingLoadError(error) {
    const message = error && error.message ? error.message : String(error);
    return `Could not load saved account mappings. ${message} Reload this page after Chrome Sync finishes, or use Advanced to upload a mappings backup or clear mappings.`;
  }

  function formatMappingLoadBlockedError() {
    return 'Account mappings were not saved because the existing saved mappings could not be loaded safely. Reload this page after Chrome Sync finishes, or use Advanced to upload a mappings backup or clear mappings.';
  }

  async function loadMappingsFromStorage() {
    return getMappingStorage().loadMappings();
  }

  async function saveMappingsToStorage(mappings) {
    try {
      await getMappingStorage().saveMappings(mappings);
      mappingStorageLoadError = null;
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

    // A row only counts as mapped once it has a ProjectionLab account AND
    // at least one Monarch account selected in that same row (matching the
    // step-3 completion logic, including asset-with-loan rows).
    const completeMappings = accountMappings.filter((m) => {
      if (!m.plId) return false;
      if (isAssetWithLoanMapping(m)) {
        const valueCount = m.monarchAccounts?.length || 0;
        const loanCount = m.monarchAccountsLoan?.length || 0;
        return valueCount + loanCount > 0;
      }
      return (m.monarchAccounts?.length || 0) > 0;
    });
    const plCount = completeMappings.length;
    // A split Monarch account appears in several rows; count it once.
    const monarchTotal = Model.allSourceIds(completeMappings).length;
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

    // ProjectionLab Early Access opt-in (Step 1). When toggled, persist the
    // preference and drop any cached instance so the next probe/sync re-resolves
    // the endpoint under the new setting instead of reusing a now-disallowed one.
    const earlyAccessCheckbox = document.getElementById('pl-early-access');
    if (earlyAccessCheckbox) {
      chrome.storage.sync.get(['plUseEarlyAccess'], (sync) => {
        earlyAccessCheckbox.checked = !!sync.plUseEarlyAccess;
      });
      earlyAccessCheckbox.addEventListener('change', async () => {
        await chrome.storage.sync.set({ plUseEarlyAccess: earlyAccessCheckbox.checked });
        await clearCachedPLOrigin();
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
      const clearedMappings = [];
      if (!(await saveMappingsToStorage(clearedMappings))) return;
      accountMappings = clearedMappings;
      splitMeta = {};
      await persistSplitMeta();
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
      splitMeta = {};
      await persistSplitMeta();
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
      // v2 backup: { format, version, mappings, splits } — splits carry each split account's note.
      const backup = Model.buildExport(accountMappings, splitMeta, {
        extensionVersion: chrome.runtime.getManifest().version,
      });
      const data = JSON.stringify(backup, null, 2);
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
        const parsed = Model.parseImport(JSON.parse(text));
        if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));
        if (!(await saveMappingsToStorage(Model.serializeMappings(parsed.mappings)))) {
          throw new Error('Could not save mappings. See the Map Accounts error for details.');
        }
        accountMappings = parsed.mappings;
        splitMeta = parsed.splitMeta;
        await persistSplitMeta();
        updateChips();
        renderMappingRows();
        updateStepComplete('step3', accountMappings.length > 0 && accountMappings.every((m) => m.plId && (m.monarchAccounts?.length || 0) > 0));
        const splitCount = Object.keys(splitMeta).length;
        const noteCount = Object.values(splitMeta).filter((v) => v.note).length;
        const summary = `Mappings uploaded: ${accountMappings.length} ProjectionLab account${accountMappings.length === 1 ? '' : 's'}, ${splitCount} split account${splitCount === 1 ? '' : 's'}, ${noteCount} note${noteCount === 1 ? '' : 's'}.`;
        const statusEl = document.getElementById('mappings-status-upload');
        if (parsed.warnings.length) {
          // Warnings stay on screen (no fade) so they can be read and acted on.
          statusEl.textContent = `${summary} Check: ${parsed.warnings.join(' ')}`;
        } else {
          setFinalLoadStatus(statusEl, summary);
        }
      } catch (err) {
        alert('Upload failed:\n' + (err.message || String(err)));
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
    updateReadyPill();
  }

  // Show the "Ready to Sync" pill only once all three step cards are green.
  // Reading the .complete class keeps this in lockstep with whatever turned
  // each step green, with no duplicated completion logic.
  function updateReadyPill() {
    const pill = document.getElementById('chip-ready');
    if (!pill) return;
    const allComplete = ['step1', 'step2', 'step3'].every((id) => {
      const c = document.getElementById(id);
      return c && c.classList.contains('complete');
    });
    pill.style.display = allComplete ? '' : 'none';
  }

  function setupReadyPillHelp() {
    const btn = document.getElementById('chip-how-btn');
    const pop = document.getElementById('chip-how-pop');
    if (!btn || !pop) return;
    function close() {
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    btn.addEventListener('click', () => {
      if (!pop.hidden) { close(); return; }
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('keydown', onKey);
      setTimeout(() => {
        document.addEventListener('click', function onDoc(ev) {
          if (!pop.contains(ev.target) && ev.target !== btn) {
            close();
            document.removeEventListener('click', onDoc);
          }
        });
      }, 0);
    });
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
    if (logo) logo.src = chrome.runtime.getURL('icons/Chrysalis-Logo.svg');
    const syncHistoryLink = document.getElementById('setup-sync-history-link');
    if (syncHistoryLink) syncHistoryLink.href = chrome.runtime.getURL('sync-history/sync-history.html');
  }

  function updateStep2Buttons() {
    const monarchBtn = document.getElementById('load-accounts');
    const plBtn = document.getElementById('load-pl-accounts');
    const monarchText = monarchBtn?.querySelector('.btn-text');
    const plText = plBtn?.querySelector('.btn-text');
    if (monarchText) monarchText.textContent = monarchAccounts.length > 0 ? 'Refresh Monarch Accounts' : 'Load Monarch Accounts';
    if (plText) plText.textContent = plAccounts.length > 0 ? 'Refresh ProjectionLab Accounts' : 'Load ProjectionLab Accounts';
  }

  // For now, keep saved mappings exactly as they were persisted.
  // We no longer try to reconcile them with current Monarch/PL account lists
  // on load, to avoid accidentally dropping or rewriting rows (especially asset 2‑lane rows).
  function reconcileMappingsWithAccounts() {}

  async function loadStorage() {
    const [sync, local] = await Promise.all([
      chrome.storage.sync.get(['plApiKey']),
      chrome.storage.local.get(['cachedMonarchAccounts', 'cachedPLAccounts', 'lastMonarchRefreshTime', 'lastPLRefreshTime']),
    ]);
    let rawMappings = [];
    try {
      rawMappings = await loadMappingsFromStorage();
      mappingStorageLoadError = null;
    } catch (e) {
      mappingStorageLoadError = e;
      console.error('[Chrysalis][setup] Failed to load account mappings:', e);
    }
    try {
      splitMeta = Model.normalizeSplitMeta(await getMappingStorage().loadSplitMeta());
    } catch (e) {
      console.error('[Chrysalis][setup] Failed to load split notes:', e);
    }
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
    if (mappingStorageLoadError) setSaveError(formatMappingLoadError(mappingStorageLoadError));
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
    updateMapGate();
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
    updateMapGate();
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
   *   2. Any already-open PL tab, honoring the preferred-origin order.
   *   3. Open the preferred origin for the current setting (app.* by default,
   *      ea.* if Early Access is enabled).
   */
  async function findAnyPLTabOrOpen({ openInBackground = false } = {}) {
    const cached = await getCachedPLOrigin();
    if (cached) {
      const result = await findOrOpenPLTabForOrigin(cached, { openInBackground });
      return { ...result, origin: cached };
    }
    const origins = await getPlOrigins();
    for (const origin of origins) {
      const tabs = await chrome.tabs.query({ url: origin + '/*' });
      if (tabs.length) {
        const appTab = tabs.find((t) => isPLAppTab(t.url));
        return { tab: appTab || tabs[0], openedByUs: false, origin };
      }
    }
    const fallbackOrigin = origins[0];
    const result = await findOrOpenPLTabForOrigin(fallbackOrigin, { openInBackground });
    return { ...result, origin: fallbackOrigin };
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
   *   2. Probe each allowed origin in preferred order (app.* by default; ea.*
   *      first when Early Access is enabled). Fall through on
   *      auth-shaped errors and on "plugin API not ready" for probe tabs we
   *      opened ourselves. Surface all other errors immediately.
   *   3. If every origin rejects the key, throw a combined auth error.
   * On a cold-start probe success the accounts payload is carried back so the
   * caller doesn't need a second exportData call.
   */
  async function detectPLOrigin(apiKey) {
    const cached = await getCachedPLOrigin();
    if (cached) return { origin: cached };
    const origins = await getPlOrigins();
    for (const origin of origins) {
      const probe = await probeOriginWithKey(origin, apiKey);
      if (probe.success) {
        await setCachedPLOrigin(origin);
        return { origin, accounts: probe.accounts };
      }
      if (probe.fallThrough) continue;
      throw new Error(probe.error || 'Unknown ProjectionLab error');
    }
    const hostList = origins.map((o) => o.replace('https://', '')).join(' or ');
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
  const isAssetWithLoanMapping = Model.isAssetWithLoanMapping;

  /** A row can hold split shares when its target is a ProjectionLab Investments account (or not chosen yet). */
  function rowAcceptsSplit(mapping) {
    if (!mapping || isAssetWithLoanMapping(mapping)) return false;
    return !mapping.plId || String(mapping.plType || '').toLowerCase() === Model.SPLIT_TARGET_PL_TYPE;
  }
  function rowHasSplit(mapping) {
    return !!mapping && (mapping.monarchAccounts || []).some((c) => Model.isSplitChip(c));
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
    // Rows holding split shares can only target ProjectionLab Investments accounts.
    const splitOnly = rowHasSplit(currentMapping);
    const available = plAccounts.filter(
      (a) =>
        (!usedElsewhere.has(a.id) || (currentMapping && currentMapping.plId === a.id)) &&
        (!splitOnly || String(a.type || '').toLowerCase() === Model.SPLIT_TARGET_PL_TYPE)
    );
    const filtered = !query
      ? available
      : available.filter(
          (a) =>
            fuzzyMatch(query, a.name) ||
            fuzzyMatch(query, getPLCategory(a))
        );
    return groupPLByCategory(filtered);
  }
  function groupPLByCategory(accounts) {
    const byCategory = new Map();
    for (const a of accounts) {
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
  /**
   * Monarch accounts that can be added to `currentMapping`.
   * - Accounts used whole in another row stay hidden (same as before splits existed).
   * - A split account with share left over is offered with `remaining` set, so it is
   *   added as a split share pre-filled with that remainder — only in rows that accept splits.
   * - Asset-with-loan lanes pass { allowSplit: false } and only see unused accounts.
   */
  function getUnselectedMonarchIds(selectedIds, currentMapping, opts) {
    const allowSplit = (!opts || opts.allowSplit !== false) && rowAcceptsSplit(currentMapping);
    const allocations = Model.computeAllocations(accountMappings.filter((m) => m !== currentMapping));
    const out = [];
    for (const a of monarchAccounts) {
      if (selectedIds.has(a.id)) continue;
      const base = { id: a.id, name: a.name, type: (a.type && String(a.type).trim()) || 'other_asset', remaining: null };
      const entry = allocations.get(a.id);
      if (!entry) { out.push(base); continue; }
      if (!allowSplit || !entry.isSplit || entry.pctMissing || entry.legs.some((l) => l.dual)) continue;
      const remaining = Model.roundPct(100 - entry.total);
      if (remaining > 0) out.push({ ...base, remaining });
    }
    return out;
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
    rowElByMapping.set(mapping, tr);
    if (flashPlId && mapping.plId === flashPlId) tr.classList.add('row-flash');
    if (!mapping.monarchAccountsLoan) mapping.monarchAccountsLoan = [];
    // Monarch account ids in this row (split chips resolve to their source account).
    const selected = new Set((mapping.monarchAccounts || []).map((a) => Model.sourceIdOf(a)));
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
      const labels = (mapping.monarchAccounts || []).map((c) => Model.chipLabel(c));
      if (isDual) {
        arrowSpan.title = multi ? 'Value and loan balances will be summed per field' : '';
      } else if (multi) {
        arrowSpan.title = `${mapping.plName || 'This account'} = ${labels.join(' + ')}`;
      } else {
        arrowSpan.title = rowHasSplit(mapping) ? labels[0] : '';
      }
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
    const splitMsgBox = document.createElement('div');
    splitMsgBox.className = 'split-msgs';
    function renderChips() {
      chipsRow.innerHTML = '';
      const mi = accountMappings.indexOf(mapping);
      (mapping.monarchAccounts || []).forEach((ma, ci) => {
        chipsRow.appendChild(buildMonarchChip(mapping, ma, mi, ci, async () => {
          selected.delete(Model.sourceIdOf(ma));
          mapping.monarchAccounts = mapping.monarchAccounts.filter((a) => a !== ma);
          if (Model.isSplitChip(ma)) touchSplit(Model.sourceIdOf(ma));
          refreshMappingRows();
          await persistMappings();
        }));
      });
      renderRowSplitMessages(mapping, splitMsgBox);
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
          if (!acc) return;
          const option = getUnselectedMonarchIds(selected, mapping).find((a) => a.id === id);
          selected.add(id);
          if (!mapping.monarchAccounts) mapping.monarchAccounts = [];
          if (option && option.remaining != null) {
            // Already split elsewhere: add a share pre-filled with what's left.
            mapping.monarchAccounts.push(Model.makeSplitChip(acc.id, acc.name, option.remaining));
            touchSplit(acc.id);
          } else {
            mapping.monarchAccounts.push({ id: acc.id, name: acc.name });
          }
          refreshMappingRows();
          autoSaveMappingsIfRowComplete(mapping, rowElByMapping.get(mapping));
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
              if (a.remaining != null) {
                const meta = document.createElement('span');
                meta.className = 'opt-split-meta';
                meta.textContent = `Split · ${Model.formatPct(a.remaining)} left`;
                opt.appendChild(meta);
              }
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
    // Kept for existing callers; renderChips() rebuilds the add-account dropdown itself.
    function renderDropdown() {}
    renderChips();
    monarchNormalLayout.appendChild(chipsRow);
    monarchNormalLayout.appendChild(splitMsgBox);
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
      const unselected = getUnselectedMonarchIds(getCombinedSelectedIds(), mapping, { allowSplit: false });
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
          const unselectedNow = getUnselectedMonarchIds(getCombinedSelectedIds(), mapping, { allowSplit: false });
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
      const unselected = getUnselectedMonarchIds(getCombinedSelectedIds(), mapping, { allowSplit: false });
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
          const unselectedNow = getUnselectedMonarchIds(getCombinedSelectedIds(), mapping, { allowSplit: false });
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
              // The target's type decides whether split icons show, so redraw the rows.
              refreshMappingRows();
              autoSaveMappingsIfRowComplete(mapping, rowElByMapping.get(mapping));
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
        refreshMappingRows();
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
    const preview = buildRowPreview(mapping);
    if (preview) cellPL.appendChild(preview);
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

  // Gate the mapping UI: only show the table once the PL key is saved AND
  // both account lists are loaded (loading PL accounts requires a working key,
  // so a loaded PL list is the de-facto "validated" signal). Otherwise show
  // an instructional message in its place.
  function updateMapGate() {
    const canMap = !!(plApiKey && plApiKey.trim()) && monarchAccounts.length > 0 && plAccounts.length > 0;
    const gate = document.getElementById('map-gate');
    const content = document.getElementById('map-content');
    if (gate) gate.style.display = canMap ? 'none' : '';
    if (content) content.style.display = canMap ? '' : 'none';
  }

  // ---------------------------------------------------------------------------
  // Percentage splits (investment accounts only).
  //
  // A split share is a chip { id: 'split:<monarchId>', sourceId, name, pct } in a
  // normal row. The same Monarch account can appear in several rows; its shares
  // across rows must total 100%. The split panel edits all of an account's shares
  // in one place, adds shares to other ProjectionLab accounts ("Split to") and
  // holds the user's note.
  // ---------------------------------------------------------------------------

  const SPLIT_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/></svg>';
  const NOTE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  const SPLIT_COLOR_COUNT = 12; // matches the .sp-c0 – .sp-c11 classes in setup.html
  const SPLIT_COMMIT_DELAY_MS = 600;
  const NOTE_SAVE_DELAY_MS = 700;

  let rowElByMapping = new WeakMap();
  let currentAllocations = new Map();
  let previewPlans = new Map();
  let flashPlId = null;
  let splitPanel = null; // { sourceId, anchor: mapping, flash: string }
  let splitToMenuPlace = null; // repositions the open "Split to" menu, if any
  const SPLIT_FLASH_SHOW_MS = 5000;
  let splitFlashTimers = null;
  let splitCommitTimer = null;
  const pendingSplitTouches = new Set();
  let noteSaveTimer = null;

  function cachedBalance(sourceId) {
    const acc = monarchAccounts.find((a) => a.id === sourceId);
    const n = acc ? Number(acc.displayBalance) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  function cachedBalanceMap() {
    const map = {};
    for (const a of monarchAccounts) {
      const n = Number(a.displayBalance);
      if (Number.isFinite(n)) map[a.id] = n;
    }
    return map;
  }

  function touchSplit(sourceId) {
    splitMeta[sourceId] = { note: (splitMeta[sourceId] && splitMeta[sourceId].note) || '', updatedAt: Date.now() };
  }

  async function persistSplitMeta() {
    splitMeta = Model.pruneSplitMeta(splitMeta, accountMappings);
    try {
      await getMappingStorage().saveSplitMeta(splitMeta);
    } catch (e) {
      setSaveError(`Could not save split notes. ${e && e.message ? e.message : String(e)}`);
      console.error('[Chrysalis][setup] Failed to save split notes:', e);
    }
  }

  /** Persist after the user pauses typing a percentage (keeps sync-storage writes low). */
  function scheduleSplitCommit(sourceId) {
    pendingSplitTouches.add(sourceId);
    if (splitCommitTimer) clearTimeout(splitCommitTimer);
    splitCommitTimer = setTimeout(async () => {
      splitCommitTimer = null;
      for (const id of pendingSplitTouches) touchSplit(id);
      pendingSplitTouches.clear();
      await persistMappings();
    }, SPLIT_COMMIT_DELAY_MS);
  }

  function allocationTip(entry, state) {
    if (!entry) return '';
    if (state === 'ok') return `${entry.name} is 100% allocated`;
    if (state === 'under') return `${entry.name} is ${Model.formatPct(entry.total)} allocated`;
    if (state === 'over') return `${entry.name} is over-allocated (${Model.formatPct(entry.total)})`;
    return `${entry.name} has a share with no percentage`;
  }

  /** Re-render every row (and the split panel), keeping focus and caret where they were. */
  function refreshMappingRows() {
    const active = document.activeElement;
    const activeId = active && active.id;
    let selStart = null;
    let selEnd = null;
    try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {}
    renderMappingRows();
    if (activeId) {
      const next = document.getElementById(activeId);
      if (next && next !== active) {
        next.focus();
        try { if (selStart != null) next.setSelectionRange(selStart, selEnd); } catch (_) {}
      }
    }
  }

  function onShareInput(chip, raw, legsForAutofill) {
    chip._raw = raw;
    const pct = Model.parsePct(raw);
    if (pct !== null) {
      chip.pct = pct;
      delete chip.pctMissing;
      // Two shares: editing one fills in the other so they total 100%.
      if (legsForAutofill && legsForAutofill.length === 2) {
        const other = legsForAutofill.find((l) => l.chip !== chip);
        if (other && Model.isSplitChip(other.chip)) {
          other.chip.pct = Model.roundPct(Math.max(0, 100 - pct));
          delete other.chip._raw;
          delete other.chip.pctMissing;
        }
      }
    }
    refreshMappingRows();
    scheduleSplitCommit(Model.sourceIdOf(chip));
  }

  function buildShareInput(chip, id, ariaLabel, state, legsForAutofill) {
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.maxLength = 6;
    input.id = id;
    input.className = 'pct-input';
    input.value = chip._raw != null ? chip._raw : (chip.pct == null ? '' : String(chip.pct));
    const rawInvalid = chip._raw != null && Model.parsePct(chip._raw) === null;
    if (rawInvalid || state === 'over' || state === 'invalid') input.classList.add('err');
    if (rawInvalid) input.title = 'Enter a number from 0 to 100';
    input.setAttribute('aria-label', ariaLabel);
    input.addEventListener('input', () => onShareInput(chip, input.value, legsForAutofill));
    input.addEventListener('blur', () => { delete chip._raw; });
    return input;
  }

  function buildMonarchChip(mapping, chip, mi, ci, onRemove) {
    const sourceId = Model.sourceIdOf(chip);
    const tag = document.createElement('span');
    tag.className = 'chip-tag';
    tag.dataset.src = sourceId;
    const name = document.createElement('span');
    name.textContent = chip.name;
    tag.appendChild(name);

    if (Model.isSplitChip(chip)) {
      tag.classList.add('is-split');
      const entry = currentAllocations.get(sourceId);
      const state = Model.allocationState(entry);
      const wrap = document.createElement('span');
      wrap.className = 'pct-wrap';
      wrap.appendChild(buildShareInput(
        chip,
        `split-pct-${mi}-${ci}`,
        `Share of ${chip.name} sent to ${mapping.plName || 'this ProjectionLab account'}, percent`,
        state,
        null
      ));
      wrap.appendChild(document.createTextNode('%'));
      tag.appendChild(wrap);
      const dot = document.createElement('span');
      dot.className = 'alloc-dot' + (state === 'ok' ? '' : ' ' + state);
      const tip = allocationTip(entry, state);
      dot.title = tip;
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', tip);
      tag.appendChild(dot);
      const noteIcon = document.createElement('button');
      noteIcon.type = 'button';
      noteIcon.className = 'note-ic';
      noteIcon.dataset.src = sourceId;
      noteIcon.innerHTML = NOTE_ICON_SVG;
      updateNoteIcon(noteIcon);
      noteIcon.addEventListener('mouseenter', () => showNotePop(noteIcon, sourceId, mapping));
      noteIcon.addEventListener('mouseleave', scheduleHideNotePop);
      noteIcon.addEventListener('focus', () => showNotePop(noteIcon, sourceId, mapping));
      noteIcon.addEventListener('blur', (e) => { if (!notePopEl.contains(e.relatedTarget)) scheduleHideNotePop(); });
      noteIcon.addEventListener('click', (e) => { e.stopPropagation(); showNotePop(noteIcon, sourceId, mapping); });
      tag.appendChild(noteIcon);
    }

    const acc = monarchAccounts.find((a) => a.id === sourceId);
    const canSplit = !isAssetWithLoanMapping(mapping) && (
      Model.isSplitChip(chip) || (acc && Model.isSplittableMonarchType(acc.type) && rowAcceptsSplit(mapping))
    );
    if (canSplit) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'split-btn';
      btn.dataset.src = sourceId;
      btn.dataset.mi = String(mi);
      // Decided at click time: closeSplitPanel() doesn't re-render, so a value captured here goes stale.
      const isOpenNow = () => !!(splitPanel && splitPanel.sourceId === sourceId && splitPanel.anchor === mapping);
      btn.setAttribute('aria-expanded', isOpenNow() ? 'true' : 'false');
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.title = Model.isSplitChip(chip) ? 'Edit split' : 'Split across ProjectionLab accounts';
      btn.setAttribute('aria-label', (Model.isSplitChip(chip) ? 'Edit split of ' : 'Split ') + chip.name);
      btn.innerHTML = SPLIT_ICON_SVG;
      btn.onclick = async (e) => {
        e.stopPropagation();
        if (isOpenNow()) { closeSplitPanel(); return; }
        if (!Model.isSplitChip(chip)) {
          // Start a split: this row keeps 100% until the user adds shares elsewhere.
          const idx = mapping.monarchAccounts.indexOf(chip);
          if (idx !== -1) mapping.monarchAccounts[idx] = Model.makeSplitChip(sourceId, chip.name, 100);
          touchSplit(sourceId);
          await persistMappings();
        }
        openSplitPanel(sourceId, mapping);
      };
      tag.appendChild(btn);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.setAttribute('aria-label', `Remove ${chip.name}`);
    remove.textContent = '×';
    remove.onclick = onRemove;
    tag.appendChild(remove);
    return tag;
  }

  function updateNoteIcon(icon) {
    const note = (splitMeta[icon.dataset.src] && splitMeta[icon.dataset.src].note) || '';
    icon.hidden = !note;
    icon.setAttribute('aria-label', note ? `Note: ${note}` : '');
  }

  function refreshNoteIcons() {
    document.querySelectorAll('.note-ic[data-src]').forEach(updateNoteIcon);
  }

  // ---------- note popover (hover a chip's note icon) ----------

  const NOTE_POP_HIDE_DELAY_MS = 150;
  const notePopEl = document.createElement('div');
  notePopEl.className = 'note-pop';
  notePopEl.setAttribute('role', 'tooltip');
  notePopEl.id = 'note-pop';
  notePopEl.hidden = true;
  document.body.appendChild(notePopEl);
  let notePopHideTimer = null;

  function showNotePop(icon, sourceId, mapping) {
    if (notePopHideTimer) { clearTimeout(notePopHideTimer); notePopHideTimer = null; }
    const note = (splitMeta[sourceId] && splitMeta[sourceId].note) || '';
    if (!note) { hideNotePop(); return; }
    notePopEl.innerHTML = '';
    notePopEl.appendChild(el('div', 'note-pop-text', note));
    const edit = el('button', 'note-pop-edit', 'Edit note');
    edit.type = 'button';
    edit.onclick = (e) => {
      e.stopPropagation();
      hideNotePop();
      openSplitPanel(sourceId, mapping);
      const ta = document.getElementById('split-note');
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.scrollTop = ta.scrollHeight;
      }
    };
    notePopEl.appendChild(edit);
    icon.setAttribute('aria-describedby', notePopEl.id);
    notePopEl.hidden = false;
    const r = icon.getBoundingClientRect();
    const w = notePopEl.offsetWidth;
    const h = notePopEl.offsetHeight;
    const left = Math.min(Math.max(16, r.left - 10), window.innerWidth - w - 16);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 12 && r.top - h - 6 > 12) top = r.top - h - 6;
    notePopEl.style.left = `${Math.max(16, left)}px`;
    notePopEl.style.top = `${Math.max(12, top)}px`;
  }

  function hideNotePop() {
    if (notePopHideTimer) { clearTimeout(notePopHideTimer); notePopHideTimer = null; }
    notePopEl.hidden = true;
  }

  /** Short delay so the pointer can cross the gap from the icon into the popover. */
  function scheduleHideNotePop() {
    if (notePopHideTimer) clearTimeout(notePopHideTimer);
    notePopHideTimer = setTimeout(hideNotePop, NOTE_POP_HIDE_DELAY_MS);
  }

  notePopEl.addEventListener('mouseenter', () => { if (notePopHideTimer) { clearTimeout(notePopHideTimer); notePopHideTimer = null; } });
  notePopEl.addEventListener('mouseleave', scheduleHideNotePop);
  notePopEl.addEventListener('focusout', (e) => { if (!notePopEl.contains(e.relatedTarget)) scheduleHideNotePop(); });
  window.addEventListener('scroll', hideNotePop, true);

  /** Under/over/missing-percentage messages for the split accounts in one row. */
  function renderRowSplitMessages(mapping, box) {
    box.innerHTML = '';
    const seen = new Set();
    for (const chip of mapping.monarchAccounts || []) {
      if (!Model.isSplitChip(chip)) continue;
      const sourceId = Model.sourceIdOf(chip);
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      const entry = currentAllocations.get(sourceId);
      const state = Model.allocationState(entry);
      if (state === 'ok') continue;
      const msg = document.createElement('div');
      msg.className = 'split-msg ' + (state === 'under' ? 'under' : 'over');
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = state === 'under' ? '⚠' : '✕';
      const text = document.createElement('span');
      if (state === 'under') {
        const bal = cachedBalance(sourceId);
        const dollars = bal == null ? '' : ` (${USD_CENTS.format(Model.allocateCents(bal, [100 - entry.total])[0].cents / 100)})`;
        text.textContent = `${entry.name} is ${Model.formatPct(entry.total)} allocated. ${Model.formatPct(100 - entry.total)}${dollars} won't sync anywhere. `;
      } else if (state === 'over') {
        text.textContent = `${entry.name} is ${Model.formatPct(entry.total)} allocated. Lower a share by ${Model.formatPct(entry.total - 100)}. Rows using this account won't sync until its shares total 100%. `;
      } else {
        text.textContent = `${entry.name} has a split share with no percentage. Enter its shares again so it can sync. `;
      }
      const fix = document.createElement('button');
      fix.type = 'button';
      fix.className = 'split-fix';
      fix.textContent = 'Fix split';
      fix.onclick = (e) => { e.stopPropagation(); openSplitPanel(sourceId, mapping); };
      text.appendChild(fix);
      msg.appendChild(icon);
      msg.appendChild(text);
      box.appendChild(msg);
    }
  }

  /** "Estimated sync $X" line under a row's ProjectionLab account, from cached balances. */
  function buildRowPreview(mapping) {
    if (isAssetWithLoanMapping(mapping) || !mapping.plId || !(mapping.monarchAccounts || []).length) return null;
    const plan = previewPlans.get(accountMappings.indexOf(mapping));
    if (!plan) return null;
    const el = document.createElement('div');
    el.className = 'pl-preview';
    if (plan.blocked.length) {
      el.classList.add('blocked');
      const b = plan.blocked[0];
      el.textContent = b.reason === 'over'
        ? `Won't sync: ${b.name} is over-allocated`
        : `Won't sync: ${b.name} has a share with no percentage`;
    } else if (!plan.write && plan.zero.length && !plan.missing.length) {
      el.classList.add('blocked');
      el.textContent = 'Won’t sync: share is 0%. Give it a share above 0 to sync.';
    } else if (plan.write && plan.sources.every((src) => src.status !== 'missing')) {
      el.textContent = `Estimated sync ${USD_CENTS.format(plan.amountCents / 100)}, from last account refresh.`;
    } else {
      return null;
    }
    return el;
  }

  // ---------- split panel ----------

  const splitPanelEl = document.createElement('div');
  splitPanelEl.className = 'split-panel';
  splitPanelEl.setAttribute('role', 'dialog');
  splitPanelEl.setAttribute('aria-modal', 'false');
  splitPanelEl.setAttribute('aria-labelledby', 'split-panel-title');
  splitPanelEl.hidden = true;
  document.body.appendChild(splitPanelEl);

  function openSplitPanel(sourceId, anchorMapping) {
    splitPanel = { sourceId, anchor: anchorMapping, flash: '' };
    refreshMappingRows();
  }

  /** Closing never re-renders the table, so the click that closed the panel still lands. */
  function closeSplitPanel() {
    if (!splitPanel) return;
    splitPanel = null;
    splitPanelEl.hidden = true;
    document.querySelectorAll('.split-btn[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    refreshNoteIcons();
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderSplitPanel() {
    if (!splitPanel) { splitPanelEl.hidden = true; return; }
    const { sourceId } = splitPanel;
    const entry = Model.computeAllocations(accountMappings).get(sourceId);
    const legs = entry ? entry.legs.filter((l) => !l.dual) : [];
    if (!legs.length || !legs.some((l) => Model.isSplitChip(l.chip))) {
      splitPanel = null;
      splitPanelEl.hidden = true;
      return;
    }
    if (!legs.some((l) => accountMappings[l.mappingIndex] === splitPanel.anchor)) {
      splitPanel.anchor = accountMappings[legs[0].mappingIndex];
    }
    // The anchor can change above, after the rows were drawn; keep the buttons in step.
    const anchorIndex = String(accountMappings.indexOf(splitPanel.anchor));
    document.querySelectorAll('.split-btn[data-src]').forEach((b) => {
      b.setAttribute('aria-expanded', b.dataset.src === sourceId && b.dataset.mi === anchorIndex ? 'true' : 'false');
    });
    splitToMenuPlace = null;
    const state = Model.allocationState(entry);
    const balance = cachedBalance(sourceId);
    const amounts = balance != null && state !== 'over' && state !== 'invalid'
      ? Model.allocateCents(balance, legs.map((l) => Model.shareOf(l.chip) || 0))
      : null;
    const meta = splitMeta[sourceId] || { note: '', updatedAt: null };

    splitPanelEl.innerHTML = '';

    const head = el('div', 'sp-head');
    const titles = el('div');
    const title = el('div', 'sp-title', `Split ${entry.name}`);
    title.id = 'split-panel-title';
    titles.appendChild(title);
    titles.appendChild(el('div', 'sp-sub', balance != null ? `${USD_CENTS.format(balance)} at last account refresh` : ''));
    const close = el('button', 'sp-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.onclick = closeSplitPanel;
    head.appendChild(titles);
    head.appendChild(close);
    splitPanelEl.appendChild(head);

    const bar = el('div', 'sp-bar' + (state === 'over' ? ' over' : ''));
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `Allocated ${Model.formatPct(entry.total)}`);
    legs.forEach((l, i) => {
      const seg = el('i', `sp-seg sp-c${i % SPLIT_COLOR_COUNT}`);
      seg.style.width = `${Math.min(100, Model.shareOf(l.chip) || 0)}%`;
      bar.appendChild(seg);
    });
    splitPanelEl.appendChild(bar);

    const total = el('div', `sp-total ${state}`);
    total.appendChild(el('span', null, `Total ${Model.formatPct(entry.total)}`));
    let totalNote = '✓ Fully allocated';
    if (state === 'under') {
      const left = balance != null ? ` (${USD_CENTS.format(Model.allocateCents(balance, [100 - entry.total])[0].cents / 100)})` : '';
      totalNote = `${Model.formatPct(100 - entry.total)}${left} unallocated`;
    } else if (state === 'over') totalNote = `Over by ${Model.formatPct(entry.total - 100)}`;
    else if (state === 'invalid') totalNote = 'A share has no percentage';
    total.appendChild(el('span', null, totalNote));
    splitPanelEl.appendChild(total);

    const list = el('ul', 'sp-legs');
    legs.forEach((l, i) => {
      const legMapping = accountMappings[l.mappingIndex];
      const li = el('li', 'sp-leg' + (legMapping === splitPanel.anchor ? ' here' : ''));
      li.appendChild(el('span', `sp-swatch sp-c${i % SPLIT_COLOR_COUNT}`));
      const nameBox = el('span', 'sp-leg-name', legMapping.plName || 'No ProjectionLab account yet');
      const others = (legMapping.monarchAccounts || []).length - 1;
      const sub = legMapping === splitPanel.anchor ? 'This row' : (others > 0 ? `Summed with ${others} other source${others === 1 ? '' : 's'}` : '');
      if (sub) nameBox.appendChild(el('small', null, sub));
      li.appendChild(nameBox);
      const pctWrap = el('span', 'sp-pct');
      if (Model.isSplitChip(l.chip)) {
        pctWrap.appendChild(buildShareInput(
          l.chip,
          `split-leg-${l.mappingIndex}-${l.chipIndex}`,
          `Share to ${legMapping.plName || 'this row'}, percent`,
          state,
          legs.filter((x) => Model.isSplitChip(x.chip))
        ));
        pctWrap.appendChild(document.createTextNode('%'));
      } else {
        pctWrap.textContent = '100% (whole)';
      }
      li.appendChild(pctWrap);
      const amount = amounts ? amounts[i].cents / 100 : null;
      li.appendChild(el('span', 'sp-amt', amount == null ? '—' : USD_CENTS.format(amount)));
      const rm = el('button', 'sp-rm', '×');
      rm.type = 'button';
      rm.setAttribute('aria-label', `Remove share to ${legMapping.plName || 'this row'}`);
      rm.onclick = async (e) => {
        e.stopPropagation();
        legMapping.monarchAccounts = legMapping.monarchAccounts.filter((c) => c !== l.chip);
        touchSplit(sourceId);
        refreshMappingRows();
        await persistMappings();
      };
      li.appendChild(rm);
      list.appendChild(li);
    });
    splitPanelEl.appendChild(list);

    // "Split to": add this account to another ProjectionLab Investments account.
    const usedPl = new Set(legs.map((l) => accountMappings[l.mappingIndex].plId).filter(Boolean));
    const targets = plAccounts.filter((a) =>
      String(a.type || '').toLowerCase() === Model.SPLIT_TARGET_PL_TYPE &&
      !usedPl.has(a.id) &&
      !isAssetWithLoanMapping({ plNativeType: a.nativeType })
    );
    if (targets.length) {
      const addWrap = el('div', 'sp-add');
      const label = el('label', 'sp-label', 'Split to');
      label.htmlFor = 'split-to-input';
      addWrap.appendChild(label);
      addWrap.appendChild(buildSplitToPicker(sourceId, entry, targets));
      splitPanelEl.appendChild(addWrap);
    }
    if (splitPanel.flash) {
      const flash = el('div', 'sp-flash load-status' + (splitPanel.flashFading ? ' load-status-fade-out' : ''), splitPanel.flash);
      flash.setAttribute('role', 'status');
      splitPanelEl.appendChild(flash);
    }

    const notes = el('div', 'sp-notes');
    const noteLabel = el('label', 'sp-note-label', 'Note');
    noteLabel.htmlFor = 'split-note';
    const counter = el('span', 'sp-counter', `${(meta.note || '').length} / ${Model.NOTE_MAX}`);
    if ((meta.note || '').length >= Model.NOTE_MAX - 50) counter.classList.add('near');
    noteLabel.appendChild(counter);
    const textarea = el('textarea');
    textarea.id = 'split-note';
    textarea.maxLength = Model.NOTE_MAX;
    textarea.placeholder = 'Remind yourself what this split is. For example: where the percentages came from, or which part is Roth.';
    textarea.value = meta.note || '';
    textarea.addEventListener('input', () => {
      const note = textarea.value.slice(0, Model.NOTE_MAX);
      splitMeta[sourceId] = { note, updatedAt: (splitMeta[sourceId] && splitMeta[sourceId].updatedAt) || Date.now() };
      counter.textContent = `${note.length} / ${Model.NOTE_MAX}`;
      counter.classList.toggle('near', note.length >= Model.NOTE_MAX - 50);
      refreshNoteIcons();
      if (noteSaveTimer) clearTimeout(noteSaveTimer);
      noteSaveTimer = setTimeout(() => { noteSaveTimer = null; persistSplitMeta(); }, NOTE_SAVE_DELAY_MS);
    });
    notes.appendChild(noteLabel);
    notes.appendChild(textarea);
    if (meta.updatedAt) {
      notes.appendChild(el('div', 'sp-meta', `Split last edited ${new Date(meta.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`));
    }
    splitPanelEl.appendChild(notes);

    const foot = el('div', 'sp-foot');
    const done = el('button', 'sp-done', 'Done');
    done.type = 'button';
    done.onclick = closeSplitPanel;
    foot.appendChild(done);
    splitPanelEl.appendChild(foot);

    splitPanelEl.hidden = false;
    positionSplitPanel();
  }

  /**
   * "Split to" picker: the same searchable dropdown as a row's ProjectionLab picker.
   * The menu is position: fixed so the split panel's own scroll box doesn't clip it.
   */
  function buildSplitToPicker(sourceId, entry, targets) {
    const widget = el('div', 'monarch-add-widget');
    const input = el('input', 'add-dropdown-search');
    input.type = 'text';
    input.id = 'split-to-input';
    input.placeholder = 'Select ProjectionLab account';
    input.autocomplete = 'off';
    const menu = el('div', 'monarch-add-panel');
    menu.setAttribute('role', 'listbox');
    menu.style.display = 'none';

    function place() {
      if (menu.style.display === 'none') return;
      const r = input.getBoundingClientRect();
      menu.style.left = `${r.left}px`;
      menu.style.width = `${r.width}px`;
      const h = menu.offsetHeight;
      const below = window.innerHeight - r.bottom - 12;
      menu.style.top = h > below && r.top - 12 > below ? `${r.top - 4 - h}px` : `${r.bottom + 4}px`;
    }
    function close() {
      menu.style.display = 'none';
      input.value = '';
    }
    function render() {
      const query = input.value.trim();
      const matches = targets.filter((a) => fuzzyMatch(query, a.name) || fuzzyMatch(query, getPLCategory(a)));
      const { sortedCategories, byCategory } = groupPLByCategory(matches);
      menu.innerHTML = '';
      for (const cat of sortedCategories) {
        menu.appendChild(el('div', 'monarch-add-panel-header', cat));
        for (const a of byCategory.get(cat)) {
          const opt = el('div', 'monarch-add-panel-option', a.name);
          const existing = accountMappings.find((m) => m.plId === a.id);
          opt.appendChild(el('span', 'opt-sub', existing ? 'Adds to existing row' : 'New row'));
          opt.setAttribute('data-id', a.id);
          opt.setAttribute('role', 'option');
          opt.onclick = () => { close(); splitTo(sourceId, entry, a.id); };
          menu.appendChild(opt);
        }
      }
      menu.style.display = sortedCategories.length > 0 || query ? 'block' : 'none';
      place();
    }
    input.onfocus = () => {
      render();
      setTimeout(() => {
        document.addEventListener('click', function closeSplitToMenu(ev) {
          if (!widget.contains(ev.target)) {
            close();
            document.removeEventListener('click', closeSplitToMenu);
          }
        });
      }, 0);
    };
    input.oninput = render;
    input.onkeydown = (e) => {
      if (e.key === 'Escape') {
        // Close just this menu, not the whole split panel.
        e.stopPropagation();
        close();
        input.blur();
      }
    };
    splitToMenuPlace = place;
    widget.appendChild(input);
    widget.appendChild(menu);
    return widget;
  }

  /**
   * Show a short confirmation in the split panel for 5s, then fade it out like the
   * page's other status messages. Kept in splitPanel state because the panel re-renders.
   */
  function showSplitFlash(text) {
    if (!splitPanel) return;
    if (splitFlashTimers) splitFlashTimers.forEach(clearTimeout);
    // A newer flash clears these timers, so any .sp-flash on screen when they fire is this one.
    const panelState = splitPanel;
    panelState.flash = text;
    panelState.flashFading = false;
    splitFlashTimers = [
      setTimeout(() => {
        panelState.flashFading = true;
        const node = splitPanelEl.querySelector('.sp-flash');
        if (node) node.classList.add('load-status-fade-out');
      }, SPLIT_FLASH_SHOW_MS),
      setTimeout(() => {
        panelState.flash = '';
        panelState.flashFading = false;
        const node = splitPanelEl.querySelector('.sp-flash');
        if (node) node.remove();
        splitFlashTimers = null;
      }, SPLIT_FLASH_SHOW_MS + LOAD_STATUS_FADE_MS),
    ];
  }

  async function splitTo(sourceId, entry, plId) {
    const acc = plAccounts.find((a) => a.id === plId);
    if (!acc) return;
    const remaining = Model.roundPct(Math.max(0, 100 - entry.total));
    const chip = Model.makeSplitChip(sourceId, entry.name, remaining);
    const existing = accountMappings.find((m) => m.plId === acc.id);
    if (existing) {
      existing.monarchAccounts = existing.monarchAccounts || [];
      existing.monarchAccounts.push(chip);
      showSplitFlash(`Added ${Model.formatPct(remaining)} allocation to the existing ${acc.name} row.`);
    } else {
      // Reuse an untouched blank row if there is one, otherwise add a row.
      const blank = accountMappings.find((m) => !m.plId && !(m.monarchAccounts || []).length && !(m.monarchAccountsLoan || []).length);
      const row = blank || { monarchAccounts: [], monarchAccountsLoan: [] };
      Object.assign(row, {
        plId: acc.id,
        plName: acc.name,
        plType: acc.type || Model.SPLIT_TARGET_PL_TYPE,
        plNativeType: acc.nativeType || '',
        monarchAccounts: [chip],
        monarchAccountsLoan: [],
      });
      if (!blank) accountMappings.push(row);
      showSplitFlash(`Created a new row for ${acc.name} with ${Model.formatPct(remaining)} allocation.`);
    }
    touchSplit(sourceId);
    flashPlId = acc.id;
    setTimeout(() => { flashPlId = null; }, 1900);
    refreshMappingRows();
    await persistMappings();
  }

  function positionSplitPanel() {
    if (!splitPanel || splitPanelEl.hidden) return;
    const anchor = document.querySelector('.split-btn[aria-expanded="true"]');
    const w = splitPanelEl.offsetWidth;
    const h = splitPanelEl.offsetHeight;
    if (!anchor) {
      splitPanelEl.style.left = `${Math.max(16, (window.innerWidth - w) / 2)}px`;
      splitPanelEl.style.top = '16px';
      return;
    }
    const r = anchor.getBoundingClientRect();
    const left = Math.min(Math.max(16, r.left - 12), window.innerWidth - w - 16);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 12 && r.top - h - 8 > 12) top = r.top - h - 8;
    splitPanelEl.style.left = `${Math.max(16, left)}px`;
    splitPanelEl.style.top = `${Math.max(12, top)}px`;
    if (splitToMenuPlace) splitToMenuPlace();
  }

  // mousedown (not click) so a table re-render can't detach the target first.
  document.addEventListener('mousedown', (e) => {
    if (!splitPanel) return;
    if (splitPanelEl.contains(e.target)) return;
    if (e.target.closest && (e.target.closest('.split-btn') || e.target.closest('.split-fix'))) return;
    closeSplitPanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && splitPanel) closeSplitPanel();
  });
  window.addEventListener('resize', positionSplitPanel);
  window.addEventListener('scroll', positionSplitPanel, true);

  function renderMappingRows() {
    const tbody = document.getElementById('map-tbody');
    tbody.innerHTML = '';
    if (accountMappings.length === 0) {
      accountMappings.push({ plId: '', plName: '', plType: '', plNativeType: '', monarchAccounts: [], monarchAccountsLoan: [] });
    }
    // Split state is computed once per render and read by every row.
    rowElByMapping = new WeakMap();
    hideNotePop(); // its icon is about to be replaced
    currentAllocations = Model.computeAllocations(accountMappings);
    previewPlans = new Map(Model.planSync(accountMappings, cachedBalanceMap()).rows.map((p) => [p.mappingIndex, p]));
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
    updateMapGate();
    renderSplitPanel();
  }

  document.getElementById('add-row').onclick = () => {
    const mapping = { plId: '', plName: '', plType: '', plNativeType: '', monarchAccounts: [], monarchAccountsLoan: [] };
    accountMappings.push(mapping);
    const tbody = document.getElementById('map-tbody');
    addMappingRow(mapping);
  };

  function showRowSavedCheck(tr) {
    if (!tr) return;
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
    if (mappingStorageLoadError) {
      setSaveError(formatMappingLoadBlockedError());
      return false;
    }
    if (!(await saveMappingsToStorage(Model.serializeMappings(accountMappings)))) return false;
    await persistSplitMeta();
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
  setupReadyPillHelp();
  setupAdvancedSection();
  setHeaderLogoUrl();
  setStep2ButtonIconUrls();
  loadStorage();
})();
