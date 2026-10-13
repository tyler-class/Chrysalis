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
    const unbalanced = unbalancedSplitNames();
    chipMaps.classList.toggle('ok', plCount > 0 && !unbalanced.length);
    chipMaps.classList.toggle('warn', plCount > 0 && unbalanced.length > 0);
    if (plCount > 0 && unbalanced.length) {
      chipMapsText.textContent = 'Account Mappings — Incomplete Split Percentages';
      chipMaps.dataset.tip = `Split not at 100%: ${unbalanced.join(', ')}`;
    } else if (plCount > 0) {
      chipMapsText.textContent = `Account Mappings — ${monarchTotal} Monarch → ${plCount} ProjectionLab`;
      delete chipMaps.dataset.tip;
    } else {
      chipMapsText.textContent = 'Account Mappings — 0 mapped';
      delete chipMaps.dataset.tip;
    }
  }

  /** Names of split Monarch accounts whose shares don't total 100% (under, over or missing a percentage). */
  function unbalancedSplitNames() {
    return Model.unbalancedSplits(accountMappings).map((u) => u.name);
  }

  function setStepCollapsed(stepId, collapsed) {
    const card = document.getElementById(stepId);
    const head = card && card.querySelector('.step-head');
    if (!card || !head) return;
    // Programmatic changes are instant; stop any drawer animation in progress.
    if (card._drawerAnim) { card._drawerAnim.cancel(); card._drawerAnim = null; }
    card.classList.remove('collapsing');
    if (collapsed) {
      card.classList.add('collapsed');
      head.setAttribute('aria-expanded', 'false');
    } else {
      card.classList.remove('collapsed');
      head.setAttribute('aria-expanded', 'true');
    }
  }

  const DRAWER_OPEN_MS = 220;
  const DRAWER_CLOSE_MS = 180;
  const DRAWER_EASING = 'cubic-bezier(.25,.8,.25,1)';

  /**
   * Open or close a section card as a drawer by animating the card's height between its
   * open and closed sizes. The `collapsed` class stays the source of truth: it's added at
   * the end of a close (so the content stays visible while the card shrinks over it) and
   * removed at the start of an open. `collapsing` turns the chevron right away.
   * A click mid-animation reverses from wherever the card is.
   */
  function animateDrawer(card, collapse, setAria) {
    setAria(collapse);
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = card.getBoundingClientRect().height;
    if (card._drawerAnim) { card._drawerAnim.cancel(); card._drawerAnim = null; }
    card.classList.remove('collapsing');
    if (reduce || typeof card.animate !== 'function') {
      card.classList.toggle('collapsed', collapse);
      return;
    }
    // Measure the end height without painting the in-between state.
    card.classList.toggle('collapsed', collapse);
    const to = card.getBoundingClientRect().height;
    if (collapse) {
      card.classList.remove('collapsed');
      card.classList.add('collapsing');
    }
    card.style.overflow = 'hidden';
    const anim = card.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: collapse ? DRAWER_CLOSE_MS : DRAWER_OPEN_MS, easing: DRAWER_EASING }
    );
    card._drawerAnim = anim;
    anim.onfinish = () => {
      card._drawerAnim = null;
      card.style.overflow = '';
      if (collapse) {
        card.classList.remove('collapsing');
        card.classList.add('collapsed');
      }
    };
    anim.oncancel = () => { card.style.overflow = ''; };
  }

  function toggleStepCollapsed(stepId) {
    const card = document.getElementById(stepId);
    if (!card) return;
    const head = card.querySelector('.step-head');
    const collapse = !(card.classList.contains('collapsed') || card.classList.contains('collapsing'));
    animateDrawer(card, collapse, (c) => { if (head) head.setAttribute('aria-expanded', c ? 'false' : 'true'); });
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

  const SELECT_CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

  /**
   * Replace a native <select>'s look with the page's own dropdown (same menu as the account
   * pickers). The <select> stays in the page, hidden, as the source of truth: existing code
   * keeps reading and setting .value / .disabled and listening for "change".
   */
  function enhanceSelect(select) {
    if (!select || select._styled) return;
    select._styled = true;

    const wrap = document.createElement('div');
    wrap.className = 'styled-select';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'styled-select-btn';
    btn.id = `${select.id}-button`;
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const valueEl = document.createElement('span');
    valueEl.className = 'styled-select-value';
    const chevron = document.createElement('span');
    chevron.className = 'styled-select-chevron';
    chevron.innerHTML = SELECT_CHEVRON_SVG;
    btn.appendChild(valueEl);
    btn.appendChild(chevron);

    // The menu lives on <body>: the Advanced card clips overflow and its hover transform
    // would otherwise anchor a fixed-position menu to the card.
    const menu = document.createElement('div');
    menu.className = 'monarch-add-panel styled-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.id = `${select.id}-menu`;
    btn.setAttribute('aria-controls', menu.id);
    menu.classList.add('floating-owned');
    menu._ownerCard = wrap.closest('.step-card');
    document.body.appendChild(menu);

    const label = document.querySelector(`label[for="${select.id}"]`);
    const labelText = label ? label.textContent.trim() : '';
    if (label) label.htmlFor = btn.id;

    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    wrap.appendChild(btn);
    select.classList.add('styled-select-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    let activeIndex = -1;

    function sync() {
      const opt = select.options[select.selectedIndex];
      valueEl.textContent = opt ? opt.textContent : '';
      btn.disabled = select.disabled;
      btn.setAttribute('aria-label', `${labelText}${labelText ? ': ' : ''}${valueEl.textContent}`);
      if (btn.disabled) close();
    }

    // Keep the button in step when code sets .value or .disabled, or adds options.
    const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return valueDesc.get.call(this); },
      set(v) { valueDesc.set.call(this, v); sync(); },
    });
    const disabledDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'disabled');
    Object.defineProperty(select, 'disabled', {
      configurable: true,
      get() { return disabledDesc.get.call(this); },
      set(v) { disabledDesc.set.call(this, v); sync(); },
    });
    new MutationObserver(sync).observe(select, { attributes: true, attributeFilter: ['disabled'], childList: true });

    function isOpen() { return menu.style.display === 'block'; }

    function place() {
      const r = btn.getBoundingClientRect();
      menu.style.left = `${r.left}px`;
      menu.style.minWidth = `${r.width}px`;
      menu.style.maxHeight = '';
      const h = menu.offsetHeight;
      const spaceBelow = window.innerHeight - r.bottom - 4 - FLOAT_EDGE_Y;
      const spaceAbove = r.top - 4 - FLOAT_EDGE_Y;
      const openAbove = h > spaceBelow && (h <= spaceAbove || spaceAbove > spaceBelow);
      const room = Math.max(0, openAbove ? spaceAbove : spaceBelow);
      if (h > room) menu.style.maxHeight = `${room}px`;
      menu.style.top = openAbove ? `${r.top - 4 - Math.min(h, room)}px` : `${r.bottom + 4}px`;
    }

    function setActive(i) {
      const opts = menu.querySelectorAll('.monarch-add-panel-option');
      if (!opts.length) return;
      activeIndex = (i + opts.length) % opts.length;
      opts.forEach((o, k) => o.classList.toggle('is-active', k === activeIndex));
      const cur = opts[activeIndex];
      btn.setAttribute('aria-activedescendant', cur.id);
      cur.scrollIntoView({ block: 'nearest' });
    }

    function open() {
      if (btn.disabled || btn.closest('.advanced-locked')) return;
      menu.innerHTML = '';
      Array.from(select.options).forEach((o, i) => {
        const opt = document.createElement('div');
        opt.className = 'monarch-add-panel-option' + (o.selected ? ' is-selected' : '');
        opt.id = `${menu.id}-${i}`;
        opt.setAttribute('role', 'option');
        opt.setAttribute('aria-selected', o.selected ? 'true' : 'false');
        opt.textContent = o.textContent;
        opt.onmousedown = (e) => e.preventDefault(); // keep focus on the button
        opt.onclick = () => choose(o.value);
        opt.onmousemove = () => { if (activeIndex !== i) setActive(i); };
        menu.appendChild(opt);
      });
      menu.style.display = 'block';
      btn.setAttribute('aria-expanded', 'true');
      place();
      setActive(Math.max(0, select.selectedIndex));
    }

    function close() {
      if (!isOpen()) return;
      menu.style.display = 'none';
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('aria-activedescendant');
      activeIndex = -1;
    }

    function choose(value) {
      close();
      if (select.value !== value) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      btn.focus();
    }

    btn.addEventListener('click', () => (isOpen() ? close() : open()));
    btn.addEventListener('keydown', (e) => {
      if (!isOpen()) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
      else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
      else if (e.key === 'End') { e.preventDefault(); setActive(-1); }
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const o = select.options[activeIndex];
        if (o) choose(o.value);
      } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Tab') close();
    });
    btn.addEventListener('blur', close);
    document.addEventListener('mousedown', (e) => {
      if (isOpen() && !menu.contains(e.target) && !btn.contains(e.target)) close();
    });
    window.addEventListener('scroll', (e) => { if (isOpen() && !menu.contains(e.target)) close(); }, true);
    window.addEventListener('resize', close);

    sync();
  }

  function toggleAdvancedCollapsed() {
    const card = document.getElementById('advanced-card');
    if (!card) return;
    const head = card.querySelector('.advanced-head');
    const collapse = !(card.classList.contains('collapsed') || card.classList.contains('collapsing'));
    animateDrawer(card, collapse, (c) => { if (head) head.setAttribute('aria-expanded', c ? 'false' : 'true'); });
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
        // applyLockUi enables every control on unlock; let sections with their own rules re-apply them.
        card.dispatchEvent(new CustomEvent('advanced-lock-change'));
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
    [autoSyncFrequency, autoSyncDayWeek, autoSyncDayMonth].forEach(enhanceSelect);

    function updateAutoSyncVisibility() {
      const enabled = autoSyncCheckbox && autoSyncCheckbox.checked;
      const freq = (autoSyncFrequency && autoSyncFrequency.value) || 'daily';
      // Visibility depends only on which frequency is selected
      if (dayWeekWrap) dayWeekWrap.style.display = freq === 'weekly' ? 'flex' : 'none';
      if (dayMonthWrap) dayMonthWrap.style.display = (freq === 'monthly' || freq === 'quarterly') ? 'flex' : 'none';
      // Editable only when Advanced is unlocked AND "Run sync automatically" is on.
      const locked = !!(card && card.classList.contains('advanced-locked'));
      const editable = enabled && !locked;
      if (autoSyncFrequency) autoSyncFrequency.disabled = !editable;
      if (autoSyncDayWeek) autoSyncDayWeek.disabled = !editable;
      if (autoSyncDayMonth) autoSyncDayMonth.disabled = !editable;
      if (autoSyncTime) autoSyncTime.disabled = !editable;
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
      if (card) card.addEventListener('advanced-lock-change', updateAutoSyncVisibility);
      updateAutoSyncVisibility(); // before stored settings load, so nothing is briefly editable
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
    if (stepId === 'step3') updateMapStepSplitWarning();
    updateReadyPill();
  }

  /**
   * A finished Map Accounts step shows an amber warning instead of the green check while
   * any split Monarch account's shares don't total 100% (under, over or missing a percentage).
   */
  function updateMapStepSplitWarning() {
    const card = document.getElementById('step3');
    const num = card && card.querySelector('.step-num');
    if (!num) return;
    const unbalanced = unbalancedSplitNames();
    const warn = unbalanced.length > 0;
    card.classList.toggle('split-warn', warn);
    if (warn && card.classList.contains('complete')) {
      num.dataset.tip = `Split not at 100%: ${unbalanced.join(', ')}`;
      num.setAttribute('aria-label', num.dataset.tip);
    } else {
      delete num.dataset.tip;
      num.removeAttribute('aria-label');
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
    // Not ready while a split account's shares don't total 100%.
    const splitWarn = document.getElementById('step3')?.classList.contains('split-warn');
    pill.style.display = allComplete && !splitWarn ? '' : 'none';
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
    if (!tabs.length) return null;
    const sorted = [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return sorted[0] || null;
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

  /** A successful load: record the time and show it once the status message fades. */
  function markRefreshed(statusEl, storageKey) {
    const now = Date.now();
    chrome.storage.local.set({ [storageKey]: now });
    statusEl.textContent = formatLastRefreshed(now);
  }

  /**
   * A failed load must not look like a refresh: after the error fades, show the time of the
   * last load that actually succeeded (or nothing if there hasn't been one).
   */
  async function showPreviousRefresh(statusEl, storageKey) {
    let ts = null;
    try { ts = (await chrome.storage.local.get([storageKey]))[storageKey]; } catch (_) {}
    statusEl.textContent = formatLastRefreshed(ts);
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
        setFinalLoadStatus(status, 'Open a tab to app.monarch.com first.', () => showPreviousRefresh(status, 'lastMonarchRefreshTime'));
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
        setFinalLoadStatus(status, `Loaded ${monarchAccounts.length} Monarch accounts.`, () => markRefreshed(status, 'lastMonarchRefreshTime'));
        updateStepComplete('step2', monarchAccounts.length > 0 && plAccounts.length > 0);
        renderMappingRows();
      } else {
        setFinalLoadStatus(status, 'Monarch: ' + (monarchRes?.error || 'Failed to load accounts.'), () => showPreviousRefresh(status, 'lastMonarchRefreshTime'));
        updateStepComplete('step2', monarchAccounts.length > 0 && plAccounts.length > 0);
      }
    } catch (e) {
      if (e.message === 'timeout') {
        setFinalLoadStatus(status, 'Timed out after 60 seconds. Try again or refresh the Monarch tab and try again.', () => showPreviousRefresh(status, 'lastMonarchRefreshTime'));
      } else {
        setFinalLoadStatus(status, 'Error: ' + (e.message || String(e)), () => showPreviousRefresh(status, 'lastMonarchRefreshTime'));
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
      setFinalLoadStatus(status, `Loaded ${plAccounts.length} ProjectionLab accounts.`, () => markRefreshed(status, 'lastPLRefreshTime'));
      updateStepComplete('step2', monarchAccounts.length > 0 && plAccounts.length > 0);
      renderMappingRows();
    } catch (e) {
      setFinalLoadStatus(status, 'ProjectionLab: ' + (e.message || String(e)), () => showPreviousRefresh(status, 'lastPLRefreshTime'));
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

  /** A row can hold split shares when its target is a ProjectionLab Savings or Investments account (or not chosen yet). */
  function rowAcceptsSplit(mapping) {
    if (!mapping || isAssetWithLoanMapping(mapping)) return false;
    return !mapping.plId || Model.isSplitTargetPlType(mapping.plType);
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
    // Rows holding split shares can only target ProjectionLab Savings or Investments accounts.
    const splitOnly = rowHasSplit(currentMapping);
    const available = plAccounts.filter(
      (a) =>
        (!usedElsewhere.has(a.id) || (currentMapping && currentMapping.plId === a.id)) &&
        (!splitOnly || Model.isSplitTargetPlType(a.type))
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
    let html = '<option value="">+ Add Monarch Account</option>';
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

  // ---------- lane rules (asset-with-loan rows) ----------
  // The Loan lane takes Monarch liability accounts; the Asset value lane takes everything else.
  // Used by both lanes' dropdowns and by drag-and-drop, so the two always agree. Accounts
  // already mapped against these rules are left alone; they just can't be newly added.
  const MONARCH_LIABILITY_TYPES = ['loan', 'credit', 'other_liability'];

  function monarchTypeOf(sourceId) {
    const acc = monarchAccounts.find((a) => a.id === sourceId);
    return (acc && acc.type && String(acc.type).trim().toLowerCase()) || 'other_asset';
  }

  /** lane: 'main' (single-lane row), 'value' or 'loan' (asset-with-loan row). */
  function laneAcceptsType(lane, type) {
    const liability = MONARCH_LIABILITY_TYPES.includes(String(type || '').toLowerCase());
    if (lane === 'loan') return liability;
    if (lane === 'value') return !liability;
    return true;
  }

  // ---------- drag and drop Monarch chips ----------
  // Drag a chip to reorder it within its lane or move it to another lane (in the same row or
  // another row). Only drops the dropdowns would also allow are accepted (see canDropChip).

  let chipDrag = null; // { chip, fromMapping, fromLane }
  let activeDropZone = null;
  // The dashed chip-shaped placeholder where the dragged chip will land. It's a real flex item
  // in the lane, so the chips around it move aside; it grows in and shrinks out so they slide.
  let dropSlot = null; // { el, rowEl, index }
  const DROP_SLOT_WIDTH = 90;
  const DROP_SLOT_MIN_WIDTH = 40;
  const DROP_SLOT_MS = 120;
  const CHIP_GAP = 8; // matches .chips-row gap
  const WHOLE_CHIP_HEIGHT = 32; // a whole-account chip; split chips are a little taller

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function retireDropSlot(el) {
    if (!el) return;
    el.classList.add('leaving');
    if (reducedMotion() || typeof el.animate !== 'function') { el.remove(); return; }
    const w = el.getBoundingClientRect().width;
    el.animate(
      [{ width: `${w}px`, marginRight: '0px', opacity: 1 }, { width: '0px', marginRight: `-${CHIP_GAP}px`, opacity: 0 }],
      { duration: DROP_SLOT_MS, easing: 'ease-out', fill: 'forwards' }
    ).onfinish = () => el.remove();
  }

  /**
   * Width for a just-inserted placeholder: up to DROP_SLOT_WIDTH, but only as wide as the room
   * left on its line, so it doesn't push a chip onto a new line and make the row taller. It
   * only wraps when less than DROP_SLOT_MIN_WIDTH is left. Measured with the placeholder at
   * zero width and any shrinking-out placeholder hidden, all before the next paint.
   */
  function dropSlotWidth(el, rowEl) {
    const leaving = Array.from(rowEl.querySelectorAll(':scope > .chip-drop-slot.leaving'));
    leaving.forEach((n) => { n.style.display = 'none'; });
    el.style.width = '0px';
    const rowBox = rowEl.getBoundingClientRect();
    const contentRight = rowBox.right - (parseFloat(getComputedStyle(rowEl).paddingRight) || 0);
    const slotBox = el.getBoundingClientRect();
    let lineRight = slotBox.right;
    for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
      if (n.style.display === 'none') continue;
      const r = n.getBoundingClientRect();
      if (r.top >= slotBox.bottom) break; // next line
      lineRight = Math.max(lineRight, r.right);
    }
    leaving.forEach((n) => { n.style.display = ''; });
    const free = Math.floor(contentRight - lineRight) - 1; // 1px spare: sub-pixel rounding could still wrap it
    return free >= DROP_SLOT_MIN_WIDTH ? Math.min(DROP_SLOT_WIDTH, free) : DROP_SLOT_WIDTH;
  }

  /** Is the (zero-height) placeholder on the same line as at least one chip? */
  function sharesLineWithChip(el, rowEl) {
    const y = el.getBoundingClientRect().top; // its line's vertical center
    return Array.from(rowEl.querySelectorAll(':scope > .chip-tag')).some((t) => {
      const r = t.getBoundingClientRect();
      return r.top <= y && r.bottom >= y;
    });
  }

  /** Show the placeholder at `index` in a lane (no-op if it's already there). */
  function placeDropSlot(rowEl, index) {
    if (dropSlot && dropSlot.rowEl === rowEl && dropSlot.index === index) return;
    if (dropSlot) retireDropSlot(dropSlot.el);
    const el = document.createElement('div');
    el.className = 'chip-drop-slot';
    const tags = rowEl.querySelectorAll(':scope > .chip-tag');
    // The placeholder itself has zero height (see .chip-drop-slot), so it can never change a
    // line's height, not even by a rounded sub-pixel. Its dashed chip shape is drawn centered
    // on it at the exact height of the chips it sits between; an empty lane uses a whole chip's.
    const neighbor = tags[index] || tags[index - 1];
    const height = neighbor ? neighbor.getBoundingClientRect().height : WHOLE_CHIP_HEIGHT;
    el.style.setProperty('--slot-h', `${height}px`);
    rowEl.insertBefore(el, tags[index] || null);
    const width = dropSlotWidth(el, rowEl);
    el.style.width = `${width}px`;
    // Alone on its own line (no room left on the last one): take real height so the lane makes
    // room for it, instead of a zero-height line that overlaps the chips and the Add field.
    const ownLine = !sharesLineWithChip(el, rowEl);
    el.classList.toggle('own-line', ownLine);
    if (!reducedMotion() && typeof el.animate === 'function') {
      el.animate(
        ownLine
          ? [{ opacity: 0 }, { opacity: 1 }] // growing its width would start it on the line above
          : [{ width: '0px', marginRight: `-${CHIP_GAP}px`, opacity: 0 }, { width: `${width}px`, marginRight: '0px', opacity: 1 }],
        { duration: DROP_SLOT_MS, easing: 'ease-out' }
      );
    }
    dropSlot = { el, rowEl, index, height };
  }

  function laneArray(mapping, lane) {
    if (lane === 'loan') {
      if (!Array.isArray(mapping.monarchAccountsLoan)) mapping.monarchAccountsLoan = [];
      return mapping.monarchAccountsLoan;
    }
    if (!Array.isArray(mapping.monarchAccounts)) mapping.monarchAccounts = [];
    return mapping.monarchAccounts;
  }

  /** Can the chip being dragged be dropped into `lane` of `mapping`? */
  function canDropChip(mapping, lane) {
    if (!chipDrag) return false;
    const { chip, fromMapping, fromLane } = chipDrag;
    if (mapping === fromMapping && lane === fromLane) return true; // reorder
    const sourceId = Model.sourceIdOf(chip);
    const dual = isAssetWithLoanMapping(mapping);
    if ((lane === 'main') === dual) return false; // lane doesn't match the row's layout
    // The account can't already be in the target row (the dragged chip itself doesn't count).
    const inRow = [...(mapping.monarchAccounts || []), ...(mapping.monarchAccountsLoan || [])]
      .some((c) => c !== chip && Model.sourceIdOf(c) === sourceId);
    if (inRow) return false;
    if (Model.isSplitChip(chip)) return lane === 'main' && rowAcceptsSplit(mapping);
    return laneAcceptsType(lane, monarchTypeOf(sourceId));
  }

  /** Index in the lane (counting real chips only) where a drop at (x, y) lands. */
  function dropIndexAt(chipsRowEl, x, y) {
    // While the pointer is over the placeholder, keep it where it is: the chips that just
    // moved aside would otherwise flip the answer back and forth.
    if (dropSlot && dropSlot.rowEl === chipsRowEl) {
      const r = dropSlot.el.getBoundingClientRect();
      const half = dropSlot.height / 2; // the drawn chip is centered on r (r may have zero height)
      const cy = r.top + r.height / 2;
      if (x >= r.left - CHIP_GAP / 2 && x <= r.right + CHIP_GAP / 2 && y >= cy - half && y <= cy + half) return dropSlot.index;
    }
    const tags = Array.from(chipsRowEl.querySelectorAll(':scope > .chip-tag'));
    for (let i = 0; i < tags.length; i++) {
      const r = tags[i].getBoundingClientRect();
      if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) return i;
    }
    return tags.length;
  }

  function clearChipDropIndicators() {
    if (activeDropZone) activeDropZone.classList.remove('chip-drop-target');
    activeDropZone = null;
    if (dropSlot) retireDropSlot(dropSlot.el);
    dropSlot = null;
  }

  /** Make a lane accept chip drops. zoneEl is the whole lane area; chipsRowEl holds its chips. */
  function registerChipDropZone(zoneEl, chipsRowEl, mapping, lane) {
    zoneEl.addEventListener('dragover', (e) => {
      if (!chipDrag) return;
      e.stopPropagation();
      if (!canDropChip(mapping, lane)) {
        e.dataTransfer.dropEffect = 'none';
        clearChipDropIndicators();
        return;
      }
      e.preventDefault(); // allow the drop
      e.dataTransfer.dropEffect = 'move';
      if (activeDropZone !== zoneEl) {
        clearChipDropIndicators();
        activeDropZone = zoneEl;
        zoneEl.classList.add('chip-drop-target');
      }
      placeDropSlot(chipsRowEl, dropIndexAt(chipsRowEl, e.clientX, e.clientY));
    });
    zoneEl.addEventListener('drop', async (e) => {
      if (!chipDrag || !canDropChip(mapping, lane)) return;
      e.preventDefault();
      e.stopPropagation();
      // Drop where the placeholder is shown, so what the user saw is what they get.
      const index = dropSlot && dropSlot.rowEl === chipsRowEl ? dropSlot.index : dropIndexAt(chipsRowEl, e.clientX, e.clientY);
      const { chip, fromMapping, fromLane } = chipDrag;
      // The re-render below removes the dragged element, so its dragend may never fire.
      chipDrag = null;
      clearChipDropIndicators();
      const from = laneArray(fromMapping, fromLane);
      const to = laneArray(mapping, lane);
      const fromIndex = from.indexOf(chip);
      if (fromIndex === -1) return;
      let insertAt = index;
      if (from === to) {
        if (insertAt === fromIndex || insertAt === fromIndex + 1) return; // dropped where it was
        if (insertAt > fromIndex) insertAt -= 1;
      }
      from.splice(fromIndex, 1);
      to.splice(insertAt, 0, chip);
      if (Model.isSplitChip(chip)) touchSplit(Model.sourceIdOf(chip));
      refreshMappingRows();
      if (await persistMappings()) showRowSavedCheck(rowElByMapping.get(mapping));
    });
  }

  // Dragging over anything that isn't a valid lane clears the indicators.
  document.addEventListener('dragover', () => { if (chipDrag) clearChipDropIndicators(); });

  const GRIP_SVG = '<svg viewBox="0 0 8 14" aria-hidden="true"><circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/><circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/><circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/></svg>';

  /** Let a chip be dragged. Drags start anywhere except its inputs and buttons. */
  function makeChipDraggable(tag, chip, mapping, lane) {
    tag.classList.add('chip-draggable');
    const grip = document.createElement('span');
    grip.className = 'chip-grip';
    grip.innerHTML = GRIP_SVG;
    tag.insertBefore(grip, tag.firstChild);
    // Only arm dragging on mousedown outside controls, so text in the % field stays selectable.
    tag.addEventListener('mousedown', (e) => {
      tag.draggable = !(e.target.closest && e.target.closest('input, button, textarea'));
    });
    tag.addEventListener('mouseup', () => { tag.draggable = false; });
    tag.addEventListener('dragstart', (e) => {
      chipDrag = { chip, fromMapping: mapping, fromLane: lane };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', chip.name || '');
      hideNotePop();
      hideTip();
      // The browser snapshots the chip for the drag ghost first; fade the original after.
      setTimeout(() => tag.classList.add('chip-dragging'), 0);
    });
    tag.addEventListener('dragend', () => {
      chipDrag = null;
      tag.draggable = false;
      tag.classList.remove('chip-dragging');
      clearChipDropIndicators();
    });
  }

  /**
   * Category header for a Monarch picker, with a right-aligned "Select All" that adds every
   * account listed under it right now (already-selected accounts aren't listed, and a search
   * narrows the list), as one change.
   */
  function monarchCategoryHeader(cat, accounts, onSelectAll) {
    const header = document.createElement('div');
    header.className = 'monarch-add-panel-header has-select-all';
    const label = document.createElement('span');
    label.textContent = displayNameForType(cat);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'select-all-btn';
    btn.textContent = 'Select All';
    btn.setAttribute('aria-label', `Add all ${accounts.length} ${displayNameForType(cat)} account${accounts.length === 1 ? '' : 's'}`);
    btn.onmousedown = (e) => e.preventDefault(); // keep the search field focused
    btn.onclick = (e) => {
      e.stopPropagation();
      onSelectAll(accounts.map((a) => a.id));
    };
    header.appendChild(label);
    if (accounts.length) header.appendChild(btn); // nothing left to add: no button
    return header;
  }

  // ---------- Monarch account picker (multi-select) ----------
  // One picker for normal rows and the Asset value / Loan lanes. While a picker is open (a
  // "pick session"), clicking an account adds its chip right away and marks it with a check
  // instead of removing it from the list; clicking a checked account removes the chip again.
  // Adding re-renders the row, so the session (picked ids, search, scroll) lives here and the
  // rebuilt picker reopens itself. Clicking outside or pressing Escape ends the session; the
  // next time a picker opens, accounts already in the row aren't listed (as before).

  let monarchPick = null; // { key, picked: Set<id>, query, scrollTop }

  function endMonarchPick() {
    if (!monarchPick) return;
    const { key } = monarchPick;
    monarchPick = null;
    const widget = document.querySelector(`.monarch-add-widget[data-pick-key="${key}"]`);
    if (!widget) return;
    const panel = widget.querySelector('.monarch-add-panel');
    const input = widget.querySelector('.add-dropdown-search');
    if (panel) panel.style.display = 'none';
    if (input) {
      input.value = '';
      if (document.activeElement === input) input.blur();
    }
  }

  // mousedown (not click): the click that picks an account re-renders the row first.
  document.addEventListener('mousedown', (e) => {
    if (!monarchPick) return;
    const widget = e.target.closest && e.target.closest('.monarch-add-widget[data-pick-key]');
    if (widget && widget.dataset.pickKey === monarchPick.key) return;
    endMonarchPick();
  });

  /**
   * Build a Monarch picker for one lane, or null when there's nothing to add (and no session
   * open on it). getOptions() lists addable accounts; addIds(ids) / removeId(id) change the row.
   */
  function buildMonarchPicker({ mapping, lane, getOptions, addIds, removeId }) {
    const key = `${accountMappings.indexOf(mapping)}-${lane}`;
    const session = monarchPick && monarchPick.key === key ? monarchPick : null;
    if (!getOptions().length && !session) return null;

    const widget = document.createElement('div');
    widget.className = 'monarch-add-widget';
    widget.dataset.pickKey = key;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'add-dropdown-search';
    input.id = `monarch-pick-${key}`;
    input.placeholder = '+ Add Monarch Account';
    input.autocomplete = 'off';
    const panel = document.createElement('div');
    panel.className = 'monarch-add-panel';
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-multiselectable', 'true');

    function startSession() {
      if (monarchPick && monarchPick.key === key) return monarchPick;
      endMonarchPick();
      monarchPick = { key, picked: new Set(), query: '', scrollTop: 0 };
      return monarchPick;
    }

    function pick(ids) {
      const s = startSession();
      const toAdd = ids.filter((id) => !s.picked.has(id));
      if (!toAdd.length) return;
      toAdd.forEach((id) => s.picked.add(id));
      addIds(toAdd);
    }

    function unpick(id) {
      const s = startSession();
      s.picked.delete(id);
      removeId(id);
    }

    function updatePanel() {
      const picked = monarchPick && monarchPick.key === key ? monarchPick.picked : new Set();
      const available = new Map(getOptions().map((a) => [a.id, a]));
      // Accounts picked in this session stay listed (checked) in their usual place.
      const list = monarchAccounts
        .filter((a) => available.has(a.id) || picked.has(a.id))
        .map((a) => available.get(a.id) || {
          id: a.id, name: a.name, type: (a.type && String(a.type).trim()) || 'other_asset', remaining: null,
        });
      const query = input.value.trim();
      const { sortedCategories, byCategory } = getFilteredGrouped(list, query);
      panel.innerHTML = '';
      for (const cat of sortedCategories) {
        const items = byCategory.get(cat);
        panel.appendChild(monarchCategoryHeader(cat, items.filter((a) => !picked.has(a.id)), pick));
        for (const a of items) {
          const isPicked = picked.has(a.id);
          const opt = document.createElement('div');
          opt.className = 'monarch-add-panel-option' + (isPicked ? ' is-picked' : '');
          opt.textContent = a.name;
          if (a.remaining != null && !isPicked) {
            const meta = document.createElement('span');
            meta.className = 'opt-split-meta';
            meta.textContent = `Split · ${Model.formatPct(a.remaining)} left`;
            opt.appendChild(meta);
          }
          if (isPicked) {
            const check = document.createElement('span');
            check.className = 'opt-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = '✓';
            opt.appendChild(check);
          }
          opt.setAttribute('data-id', a.id);
          opt.setAttribute('role', 'option');
          opt.setAttribute('aria-selected', isPicked ? 'true' : 'false');
          opt.onmousedown = (e) => e.preventDefault(); // keep focus in the search field
          opt.onclick = () => (isPicked ? unpick(a.id) : pick([a.id]));
          panel.appendChild(opt);
        }
      }
      panel.style.display = sortedCategories.length > 0 || query ? 'block' : 'none';
    }

    input.onfocus = () => {
      startSession();
      updatePanel();
    };
    input.oninput = () => {
      startSession().query = input.value;
      updatePanel();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Escape') endMonarchPick();
    };
    // Tabbing away ends the session; a blur caused by the row re-rendering doesn't.
    input.addEventListener('blur', (e) => {
      if (!input.isConnected || !monarchPick || monarchPick.key !== key) return;
      if (e.relatedTarget && !widget.contains(e.relatedTarget)) endMonarchPick();
    });
    panel.addEventListener('scroll', () => {
      if (monarchPick && monarchPick.key === key) monarchPick.scrollTop = panel.scrollTop;
    });

    widget.appendChild(input);
    widget.appendChild(panel);
    if (session) {
      // Rebuilt mid-session: reopen as it was, once the row is back in the page.
      input.value = session.query;
      updatePanel();
      queueMicrotask(() => {
        if (!input.isConnected || monarchPick !== session) return;
        if (document.activeElement !== input) input.focus();
        panel.scrollTop = session.scrollTop;
      });
    } else {
      panel.style.display = 'none';
    }
    return widget;
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
    attachTip(arrowSpan, ICON_TIP_DELAY_MS); // text set in updateArrow (none when there's nothing to explain)
    function updateArrow() {
      const isDual = isAssetWithLoanMapping(mapping);
      const valueCount = mapping.monarchAccounts?.length || 0;
      const loanCount = isDual ? (mapping.monarchAccountsLoan?.length || 0) : 0;
      const total = valueCount + loanCount;
      const multi = total > 1;
      arrowSpan.setAttribute('data-aggregate', multi ? '1' : '0');
      arrowSpan.textContent = multi ? '∑→' : '→';
      const labels = (mapping.monarchAccounts || []).map((c) => Model.chipLabel(c));
      let tip = '';
      if (isDual) {
        tip = multi ? 'Value and loan balances will be summed per field' : '';
      } else if (multi) {
        tip = `${mapping.plName || 'This account'} = ${labels.join(' + ')}`;
      } else {
        tip = rowHasSplit(mapping) ? labels[0] : '';
      }
      if (tip) arrowSpan.dataset.tip = tip;
      else delete arrowSpan.dataset.tip;
    }

    const cellMonarch = document.createElement('td');
    cellMonarch.className = 'map-cell';
    // Optional row title, in the gutter across the top of the row (positioned on the <tr>).
    tr.classList.add('map-row');
    cellMonarch.appendChild(buildRowTitle(mapping));
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
        const tag = buildMonarchChip(mapping, ma, mi, ci, async () => {
          selected.delete(Model.sourceIdOf(ma));
          mapping.monarchAccounts = mapping.monarchAccounts.filter((a) => a !== ma);
          if (Model.isSplitChip(ma)) touchSplit(Model.sourceIdOf(ma));
          refreshMappingRows();
          await persistMappings();
        });
        makeChipDraggable(tag, ma, mapping, 'main');
        chipsRow.appendChild(tag);
      });
      renderRowSplitMessages(mapping, splitMsgBox);
      addMonarchRow.innerHTML = '';
      function addAccounts(ids) {
        const options = getUnselectedMonarchIds(selected, mapping);
        if (!mapping.monarchAccounts) mapping.monarchAccounts = [];
        let added = 0;
        for (const id of ids) {
          const acc = monarchAccounts.find((a) => a.id === id);
          if (!acc || selected.has(id)) continue;
          const option = options.find((a) => a.id === id);
          selected.add(id);
          if (option && option.remaining != null) {
            // Already split elsewhere: add a share pre-filled with what's left.
            mapping.monarchAccounts.push(Model.makeSplitChip(acc.id, acc.name, option.remaining));
            touchSplit(acc.id);
          } else {
            mapping.monarchAccounts.push({ id: acc.id, name: acc.name });
          }
          added++;
        }
        if (!added) return;
        refreshMappingRows();
        autoSaveMappingsIfRowComplete(mapping, rowElByMapping.get(mapping));
      }
      async function removeAccount(id) {
        const removed = (mapping.monarchAccounts || []).filter((c) => Model.sourceIdOf(c) === id);
        if (!removed.length) return;
        mapping.monarchAccounts = mapping.monarchAccounts.filter((c) => Model.sourceIdOf(c) !== id);
        selected.delete(id);
        if (removed.some((c) => Model.isSplitChip(c))) touchSplit(id);
        refreshMappingRows();
        await persistMappings();
      }
      const picker = buildMonarchPicker({
        mapping,
        lane: 'main',
        getOptions: () => getUnselectedMonarchIds(selected, mapping),
        addIds: addAccounts,
        removeId: removeAccount,
      });
      if (picker) {
        const dropdownWrap = document.createElement('span');
        dropdownWrap.appendChild(picker);
        addMonarchRow.appendChild(dropdownWrap);
      }
    }
    // Kept for existing callers; renderChips() rebuilds the add-account dropdown itself.
    function renderDropdown() {}
    renderChips();
    monarchNormalLayout.appendChild(chipsRow);
    monarchNormalLayout.appendChild(splitMsgBox);
    monarchNormalLayout.appendChild(addMonarchRow);
    registerChipDropZone(monarchNormalLayout, chipsRow, mapping, 'main');

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
    registerChipDropZone(valueLane, valueChipsRow, mapping, 'value');
    registerChipDropZone(loanLane, loanChipsRow, mapping, 'loan');

    function renderValueLane() {
      valueChipsRow.innerHTML = '';
      (mapping.monarchAccounts || []).forEach((ma) => {
        const tag = document.createElement('span');
        tag.className = 'chip-tag';
        tag.innerHTML = `${escapeHtml(ma.name)} <button type="button" class="remove">×</button>`;
        setupChipRemoveButton(tag.querySelector('.remove'), ma.name, async () => {
          mapping.monarchAccounts = mapping.monarchAccounts.filter((a) => a.id !== ma.id);
          renderValueLane();
          renderLoanLane();
          await persistMappings();
        });
        makeChipDraggable(tag, ma, mapping, 'value');
        valueChipsRow.appendChild(tag);
      });
      valueAddRow.innerHTML = '';
      const picker = buildMonarchPicker({
        mapping,
        lane: 'value',
        getOptions: () => getUnselectedMonarchIds(getCombinedSelectedIds(), mapping, { allowSplit: false })
          .filter((a) => laneAcceptsType('value', a.type)),
        addIds: (ids) => {
          if (!mapping.monarchAccounts) mapping.monarchAccounts = [];
          const inRow = getCombinedSelectedIds();
          const accs = ids.map((id) => monarchAccounts.find((a) => a.id === id)).filter((a) => a && !inRow.has(a.id));
          if (!accs.length) return;
          accs.forEach((acc) => mapping.monarchAccounts.push({ id: acc.id, name: acc.name }));
          renderValueLane();
          renderLoanLane();
          autoSaveMappingsIfRowComplete(mapping, tr);
        },
        removeId: async (id) => {
          mapping.monarchAccounts = (mapping.monarchAccounts || []).filter((a) => a.id !== id);
          renderValueLane();
          renderLoanLane();
          await persistMappings();
        },
      });
      if (picker) {
        const wrap = document.createElement('span');
        wrap.appendChild(picker);
        valueAddRow.appendChild(wrap);
      }
      if (typeof updateArrow === 'function') updateArrow();
    }
    function renderLoanLane() {
      loanChipsRow.innerHTML = '';
      (mapping.monarchAccountsLoan || []).forEach((ma) => {
        const tag = document.createElement('span');
        tag.className = 'chip-tag';
        tag.innerHTML = `${escapeHtml(ma.name)} <button type="button" class="remove">×</button>`;
        setupChipRemoveButton(tag.querySelector('.remove'), ma.name, async () => {
          mapping.monarchAccountsLoan = mapping.monarchAccountsLoan.filter((a) => a.id !== ma.id);
          renderValueLane();
          renderLoanLane();
          await persistMappings();
        });
        makeChipDraggable(tag, ma, mapping, 'loan');
        loanChipsRow.appendChild(tag);
      });
      loanAddRow.innerHTML = '';
      const picker = buildMonarchPicker({
        mapping,
        lane: 'loan',
        getOptions: () => getUnselectedMonarchIds(getCombinedSelectedIds(), mapping, { allowSplit: false })
          .filter((a) => laneAcceptsType('loan', a.type)),
        addIds: (ids) => {
          if (!mapping.monarchAccountsLoan) mapping.monarchAccountsLoan = [];
          const inRow = getCombinedSelectedIds();
          const accs = ids.map((id) => monarchAccounts.find((a) => a.id === id)).filter((a) => a && !inRow.has(a.id));
          if (!accs.length) return;
          accs.forEach((acc) => mapping.monarchAccountsLoan.push({ id: acc.id, name: acc.name }));
          renderValueLane();
          renderLoanLane();
          autoSaveMappingsIfRowComplete(mapping, tr);
        },
        removeId: async (id) => {
          mapping.monarchAccountsLoan = (mapping.monarchAccountsLoan || []).filter((a) => a.id !== id);
          renderValueLane();
          renderLoanLane();
          await persistMappings();
        },
      });
      if (picker) {
        const wrap = document.createElement('span');
        wrap.appendChild(picker);
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
    plInput.placeholder = '+ Add ProjectionLab Account';
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
        plInput.placeholder = '+ Add ProjectionLab Account';
      }
      // Once an account is chosen the field is inert; clear it with × to pick another.
      plInput.classList.toggle('is-locked', !!mapping.plId);
    }
    // A click on a chosen account does nothing: no focus, no list (see updatePLInputLabel).
    plInput.addEventListener('mousedown', (e) => {
      if (mapping.plId) e.preventDefault();
    });
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
      if (mapping.plId) return; // chosen: inert until cleared with ×
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
    attachTip(plClearBtn, ICON_TIP_DELAY_MS);
    function updatePLClearVisibility() {
      const showSearch = !plInput.readOnly && plInput.value.length > 0;
      const showSelection = !!(plInput.readOnly && mapping.plId);
      const show = showSearch || showSelection;
      plClearBtn.hidden = !show;
      const label = showSelection ? 'Remove selected ProjectionLab account' : 'Clear search';
      plClearBtn.setAttribute('aria-label', label);
      plClearBtn.dataset.tip = label;
      plInput.classList.toggle('has-clear', show);
    }
    plClearBtn.onclick = async (e) => {
      e.preventDefault();
      hideTip();
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
    removeBtn.dataset.tip = 'Remove row';
    removeBtn.setAttribute('aria-label', 'Remove row');
    attachTip(removeBtn, ICON_TIP_DELAY_MS);
    removeBtn.onclick = async () => {
      hideTip(); // the button is about to be removed with its row
      const idx = accountMappings.indexOf(mapping);
      if (idx !== -1) accountMappings.splice(idx, 1);
      refreshMappingRows(); // redraw so the swap buttons between rows stay correct
      await persistMappings();
    };
    cellRemove.appendChild(removeBtn);
    // "Swap rows": sits where this row's bottom divider meets the table's right border and swaps
    // this row with the one below.
    const rowIndex = accountMappings.indexOf(mapping);
    if (rowIndex !== -1 && rowIndex < accountMappings.length - 1) {
      cellRemove.appendChild(buildRowSwapButton(rowIndex));
    }
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
  // Percentage splits (Monarch Cash and Investments accounts → ProjectionLab Savings or Investments).
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

  // True while refreshMappingRows() rebuilds the DOM. Chrome fires blur on a focused input
  // when it's removed, and that blur must not be treated as the user leaving the field.
  let renderingRows = false;

  /** Re-render every row (and the split panel), keeping focus and caret where they were. */
  function refreshMappingRows() {
    const active = document.activeElement;
    const activeId = active && active.id;
    let selStart = null;
    let selEnd = null;
    try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {}
    renderingRows = true;
    try {
      renderMappingRows();
    } finally {
      renderingRows = false;
    }
    if (activeId) {
      const next = document.getElementById(activeId);
      if (next && next !== active) {
        next.focus();
        try { if (selStart != null) next.setSelectionRange(selStart, selEnd); } catch (_) {}
      }
    }
  }

  /**
   * Editing a share only changes that share. Other shares are never adjusted here; a new
   * share's starting value (what's left of 100%) is set once, when it's added.
   */
  function onShareInput(chip, raw) {
    chip._raw = raw;
    // An empty field counts as 0% (it never syncs); it's saved as 0 rather than blank,
    // because a blank percentage means "missing" and blocks the account at sync.
    const pct = String(raw).trim() === '' ? 0 : Model.parsePct(raw);
    if (pct !== null) {
      chip.pct = pct;
      delete chip.pctMissing;
    }
    refreshMappingRows();
    scheduleSplitCommit(Model.sourceIdOf(chip));
  }

  function buildShareInput(chip, id, ariaLabel, state) {
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
    if (rawInvalid) input.dataset.tip = 'Enter a number from 0 to 100';
    attachTip(input, ICON_TIP_DELAY_MS); // shows only while the entry is invalid (data-tip set)
    input.setAttribute('aria-label', ariaLabel);
    input.addEventListener('input', () => onShareInput(chip, input.value));
    input.placeholder = '0';
    // Only a real blur (the user left the field) tidies the value; see renderingRows.
    input.addEventListener('blur', () => {
      if (renderingRows || !input.isConnected) return;
      delete chip._raw;
      // Show the tidied value right away: "25." → "25", empty → "0", invalid → last valid value.
      if (chip.pct != null && input.value !== String(chip.pct)) {
        input.value = String(chip.pct);
        // Clear only the "not a number" marking (it sets the title); over-100% stays red.
        if (input.dataset.tip) { input.classList.remove('err'); delete input.dataset.tip; hideTip(); }
      }
    });
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

    let noteIcon = null;
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
        state
      ));
      wrap.appendChild(document.createTextNode('%'));
      tag.appendChild(wrap);
      noteIcon = document.createElement('button');
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
      btn.dataset.tip = Model.isSplitChip(chip) ? 'Edit split' : 'Split across ProjectionLab accounts';
      attachTip(btn, ICON_TIP_DELAY_MS);
      btn.setAttribute('aria-label', (Model.isSplitChip(chip) ? 'Edit split of ' : 'Split ') + chip.name);
      btn.innerHTML = SPLIT_ICON_SVG;
      btn.onclick = async (e) => {
        e.stopPropagation();
        hideTip();
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
    // Note icon goes after the split button: [name] [%] [split] [note] [×]
    if (noteIcon) tag.appendChild(noteIcon);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = '×';
    setupChipRemoveButton(remove, chip.name, onRemove);
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
  notePopEl.classList.add('floating-owned');
  notePopEl._ownerCard = document.getElementById('step3');
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
    placeFloating(notePopEl, icon.getBoundingClientRect(), 6, 10);
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

  // ---------- hover tips (same look as the note popover, shown immediately) ----------
  // Elements opt in with data-tip; an element without it shows nothing. Used instead of
  // the native title tooltip, which is unstyled and waits a second or two to appear.

  const tipEl = document.createElement('div');
  tipEl.className = 'note-pop';
  tipEl.setAttribute('role', 'tooltip');
  tipEl.id = 'hover-tip';
  tipEl.hidden = true;
  tipEl.classList.add('floating-owned');
  document.body.appendChild(tipEl);

  function showTip(anchor) {
    const text = anchor.dataset.tip;
    if (!text) { hideTip(); return; }
    tipEl._ownerCard = anchor.closest('.step-card');
    tipEl.innerHTML = '';
    tipEl.appendChild(el('div', 'note-pop-text', text));
    tipEl.hidden = false;
    placeFloating(tipEl, anchor.getBoundingClientRect(), 6, 0);
  }

  let tipDelayTimer = null;

  function hideTip() {
    if (tipDelayTimer) { clearTimeout(tipDelayTimer); tipDelayTimer = null; }
    tipEl.hidden = true;
  }

  const REMOVE_MONARCH_TIP = 'Remove selected Monarch Money account';
  // Icon buttons (×, swap, split, …) wait a moment before showing their tip, so it doesn't flash
  // while aiming to click. Warnings that need attention (amber pill, Map Accounts icon) show at once.
  const ICON_TIP_DELAY_MS = 1500;

  /** A chip's × button: styled hover tip, an accessible name, and the tip hidden on click. */
  function setupChipRemoveButton(btn, accountName, onRemove) {
    btn.dataset.tip = REMOVE_MONARCH_TIP;
    btn.setAttribute('aria-label', `Remove ${accountName}`);
    attachTip(btn, ICON_TIP_DELAY_MS);
    btn.onclick = (e) => {
      hideTip(); // the chip (and this button) is about to be removed
      return onRemove(e);
    };
  }

  /** Show node's data-tip on hover: right away, or after delayMs (e.g. for × buttons). */
  function attachTip(node, delayMs) {
    if (!node) return;
    let hovering = false;
    node.addEventListener('mouseenter', () => {
      hovering = true;
      if (!delayMs) { showTip(node); return; }
      if (tipDelayTimer) clearTimeout(tipDelayTimer);
      tipDelayTimer = setTimeout(() => {
        tipDelayTimer = null;
        if (hovering && node.isConnected) showTip(node);
      }, delayMs);
    });
    node.addEventListener('mouseleave', () => {
      hovering = false;
      hideTip();
    });
  }

  attachTip(document.getElementById('chip-maps'));
  attachTip(document.querySelector('.header-links .help-icon-link'), ICON_TIP_DELAY_MS);
  attachTip(document.querySelector('#step3 .step-num'));
  window.addEventListener('scroll', hideTip, true);

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
  splitPanelEl.classList.add('floating-owned');
  splitPanelEl._ownerCard = document.getElementById('step3');
  document.body.appendChild(splitPanelEl);

  function openSplitPanel(sourceId, anchorMapping) {
    splitPanel = { sourceId, anchor: anchorMapping, flash: '' };
    refreshMappingRows();
  }

  /** Closing never re-renders the table, so the click that closed the panel still lands. */
  function closeSplitPanel() {
    closeCalc();
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

    hideTip(); // a hovered button inside the panel is about to be replaced
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
          state
        ));
        pctWrap.appendChild(document.createTextNode('%'));
        pctWrap.appendChild(buildCalcButton(l, legMapping, entry));
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

    // "Split to": add this account to another ProjectionLab Savings or Investments account.
    const usedPl = new Set(legs.map((l) => accountMappings[l.mappingIndex].plId).filter(Boolean));
    const targets = plAccounts.filter((a) =>
      Model.isSplitTargetPlType(a.type) &&
      !usedPl.has(a.id) &&
      !isAssetWithLoanMapping({ plNativeType: a.nativeType })
    );
    if (targets.length) {
      const addWrap = el('div', 'sp-add');
      // A plain heading, not a <label>: clicking it must not open the picker. Only the
      // field itself opens it; aria-labelledby keeps the name for screen readers.
      const label = el('div', 'sp-label', 'Add a split to…');
      label.id = 'split-to-label';
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
    syncCalcAfterRender();
  }

  // ---------- share calculator ($ amount → %) ----------
  //
  // A small popover from the calculator button on a split share in the panel. It fetches the
  // Monarch account's current balance, the user types the dollars they want this share to be,
  // and "Use this percent" puts the rounded percentage into that share.

  // Outline calculator (+ − × =), same stroke style as the split and note icons.
  const CALC_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="3"/><path d="M8 6.5h8M7 11.75h3M8.5 10.25v3M14 11.75h3M7.25 15.75l2.5 2.5M9.75 15.75l-2.5 2.5M14 15.85h3M14 18.15h3"/></svg>';
  const CALC_FETCH_TIMEOUT_MS = 30000;

  const calcPopEl = document.createElement('div');
  calcPopEl.className = 'calc-pop';
  calcPopEl.setAttribute('role', 'dialog');
  calcPopEl.setAttribute('aria-labelledby', 'calc-pop-title');
  calcPopEl.hidden = true;
  calcPopEl.classList.add('floating-owned');
  calcPopEl._ownerCard = document.getElementById('step3');
  document.body.appendChild(calcPopEl);

  // { chip, legMapping, sourceId, name, btnId, balance, status, error, fetchToken }
  let calc = null;

  function buildCalcButton(leg, legMapping, entry) {
    const btn = el('button', 'sp-calc-btn');
    btn.type = 'button';
    btn.id = `split-calc-${leg.mappingIndex}-${leg.chipIndex}`;
    btn.innerHTML = CALC_ICON_SVG;
    btn.dataset.tip = 'Help me calculate the percentage from a dollar amount';
    attachTip(btn);
    btn.setAttribute('aria-label', `Calculate the share to ${legMapping.plName || 'this row'} from a dollar amount`);
    btn.setAttribute('aria-haspopup', 'dialog');
    const open = !!(calc && calc.chip === leg.chip);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.onclick = (e) => {
      e.stopPropagation();
      hideTip();
      if (calc && calc.chip === leg.chip) { closeCalc(); return; }
      openCalc(leg.chip, legMapping, entry, btn.id);
    };
    return btn;
  }

  function openCalc(chip, legMapping, entry, btnId) {
    calc = {
      chip, legMapping, sourceId: entry.sourceId, name: entry.name, btnId,
      balance: null, status: 'loading', error: '', fetchToken: {},
    };
    document.querySelectorAll('.sp-calc-btn').forEach((b) => b.setAttribute('aria-expanded', b.id === btnId ? 'true' : 'false'));
    renderCalc();
    fetchCalcBalance();
  }

  function closeCalc() {
    if (!calc) return;
    calc = null;
    calcPopEl.hidden = true;
    calcPopEl.innerHTML = '';
    document.querySelectorAll('.sp-calc-btn[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }

  /** Current balance of one Monarch account, read from the open Monarch tab. */
  async function fetchCurrentMonarchBalance(sourceId) {
    const tab = await findMonarchTab();
    if (!tab) throw new Error('Open app.monarch.com in a tab (and sign in) to get the current balance.');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-scripts/monarch.js'] });
    const res = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'FETCH_BALANCES', accountIds: [sourceId] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Monarch took too long to answer. Try again.')), CALC_FETCH_TIMEOUT_MS)),
    ]);
    if (!res || !res.success) throw new Error(`Monarch: ${(res && res.error) || 'could not get the balance.'}`);
    const acc = (res.accounts || []).find((a) => a.id === sourceId);
    if (!acc) throw new Error('Monarch didn\'t return this account. It may be hidden or closed in Monarch.');
    const n = Number(acc.balance);
    if (!Number.isFinite(n)) throw new Error('Monarch returned a balance Chrysalis couldn\'t read.');
    return n;
  }

  async function fetchCalcBalance() {
    if (!calc) return;
    const token = {};
    calc.fetchToken = token;
    calc.status = 'loading';
    calc.error = '';
    renderCalc();
    try {
      const balance = await fetchCurrentMonarchBalance(calc.sourceId);
      if (!calc || calc.fetchToken !== token) return; // closed or retried meanwhile
      calc.balance = balance;
      calc.status = 'ready';
      await applyFreshMonarchBalance(calc.sourceId, balance);
    } catch (e) {
      if (!calc || calc.fetchToken !== token) return;
      calc.status = 'error';
      calc.error = (e && e.message) || String(e);
    }
    renderCalc();
  }

  /**
   * A balance fetched just now (by the calculator) replaces the cached one, in memory and in
   * the saved account cache, so the split panel header, share amounts and row previews all
   * show it. The Step 2 "Last refreshed" time is left alone: only this one account was refreshed.
   */
  async function applyFreshMonarchBalance(sourceId, balance) {
    const acc = monarchAccounts.find((a) => a.id === sourceId);
    if (!acc || Number(acc.displayBalance) === balance) return;
    acc.displayBalance = balance;
    refreshMappingRows();
    try {
      await chrome.storage.local.set({ cachedMonarchAccounts: monarchAccounts });
    } catch (e) {
      console.warn('[Chrysalis][setup] Could not save the refreshed balance:', e);
    }
  }

  /** Dollars → percent of |balance|, or a reason it can't be worked out. */
  function calcPercent(amountRaw, balance) {
    const text = String(amountRaw || '').replace(/[$,\s]/g, '');
    if (text === '') return { pct: null, msg: '' };
    const amount = Number(text);
    if (!Number.isFinite(amount) || amount < 0) return { pct: null, msg: 'Enter a dollar amount, like 25000 or 25,000.50.' };
    const base = Math.abs(balance);
    if (base === 0) return { pct: null, msg: 'The balance is $0, so there\'s nothing to split.' };
    if (Math.abs(amount) > base + 0.005) return { pct: null, msg: 'That\'s more than the whole balance.' };
    return { pct: Model.roundPct((Math.abs(amount) / base) * 100), msg: '' };
  }

  function renderCalc() {
    if (!calc) { calcPopEl.hidden = true; return; }
    const keepAmount = calcPopEl.querySelector('#calc-amount');
    const amountValue = keepAmount ? keepAmount.value : '';
    calcPopEl.innerHTML = '';

    const head = el('div', 'calc-head');
    const title = el('div', 'calc-title', `Split to ${calc.legMapping.plName || 'this row'}`);
    title.id = 'calc-pop-title';
    head.appendChild(title);
    const close = el('button', 'sp-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close calculator');
    close.onclick = (e) => { e.stopPropagation(); closeCalc(); };
    head.appendChild(close);
    calcPopEl.appendChild(head);

    const balBox = el('div', 'calc-balance');
    balBox.appendChild(el('div', 'calc-label', `Current balance · ${calc.name}`));
    if (calc.status === 'loading') {
      const loading = el('div', 'calc-loading');
      loading.innerHTML = '<span class="spinner"></span> Getting it from Monarch…';
      balBox.appendChild(loading);
    } else if (calc.status === 'error') {
      balBox.appendChild(el('div', 'calc-error', calc.error));
      const retry = el('button', 'calc-link', 'Try again');
      retry.type = 'button';
      retry.onclick = (e) => { e.stopPropagation(); fetchCalcBalance(); };
      balBox.appendChild(retry);
    } else {
      const value = el('output', 'calc-value', USD_CENTS.format(calc.balance));
      value.setAttribute('aria-live', 'polite');
      balBox.appendChild(value);
    }
    calcPopEl.appendChild(balBox);

    if (calc.status === 'ready') {
      const field = el('div', 'calc-field');
      const label = el('label', 'calc-label', `Amount to split to ${calc.legMapping.plName || 'this row'}`);
      label.htmlFor = 'calc-amount';
      field.appendChild(label);
      const inputWrap = el('div', 'calc-input-wrap');
      inputWrap.appendChild(el('span', 'calc-dollar', '$'));
      const input = el('input', 'calc-input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      input.id = 'calc-amount';
      input.placeholder = '0.00';
      input.value = amountValue;
      inputWrap.appendChild(input);
      field.appendChild(inputWrap);
      calcPopEl.appendChild(field);

      const result = el('div', 'calc-result');
      result.appendChild(el('span', 'calc-label', 'Percent of balance'));
      const pctOut = el('output', 'calc-pct');
      pctOut.htmlFor = 'calc-amount';
      result.appendChild(pctOut);
      calcPopEl.appendChild(result);
      const msg = el('div', 'calc-msg');
      calcPopEl.appendChild(msg);

      const use = el('button', 'sp-done calc-use', 'Use this percent');
      use.type = 'button';
      const foot = el('div', 'calc-foot');
      foot.appendChild(use);
      calcPopEl.appendChild(foot);

      const update = () => {
        const { pct, msg: why } = calcPercent(input.value, calc.balance);
        pctOut.textContent = pct == null ? '—' : Model.formatPct(pct);
        msg.textContent = why;
        use.disabled = pct == null;
        return pct;
      };
      const apply = () => {
        const pct = update();
        if (pct == null || !calc) return;
        const { chip, btnId } = calc;
        closeCalc();
        onShareInput(chip, String(pct));
        // Hand focus back to the share's % field (same row/chip suffix as the button).
        const shareInput = document.getElementById(btnId.replace('split-calc-', 'split-leg-'));
        if (shareInput) shareInput.focus();
      };
      input.addEventListener('input', update);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
      use.onclick = (e) => { e.stopPropagation(); apply(); };
      update();
    }

    calcPopEl.hidden = false;
    positionCalc();
    const amount = calcPopEl.querySelector('#calc-amount');
    if (amount && document.activeElement !== amount) amount.focus();
  }

  function positionCalc() {
    if (!calc || calcPopEl.hidden) return;
    const btn = document.getElementById(calc.btnId);
    if (!btn) return;
    placeFloating(calcPopEl, btn.getBoundingClientRect(), 6, 200);
  }

  /** The split panel re-renders often; keep the calculator on its share, or close it if the share is gone. */
  function syncCalcAfterRender() {
    if (!calc) return;
    const stillThere = (calc.legMapping.monarchAccounts || []).includes(calc.chip);
    if (!stillThere || !document.getElementById(calc.btnId)) { closeCalc(); return; }
    positionCalc();
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
    input.setAttribute('aria-labelledby', 'split-to-label');
    input.autocomplete = 'off';
    const menu = el('div', 'monarch-add-panel');
    menu.setAttribute('role', 'listbox');
    menu.style.display = 'none';

    function place() {
      if (menu.style.display === 'none') return;
      const r = input.getBoundingClientRect();
      menu.style.left = `${r.left}px`;
      menu.style.width = `${r.width}px`;
      menu.style.maxHeight = '';
      const h = menu.offsetHeight;
      const spaceBelow = window.innerHeight - r.bottom - 4 - FLOAT_EDGE_Y;
      const spaceAbove = r.top - 4 - FLOAT_EDGE_Y;
      // Open on whichever side fits (below first); if neither fits, use the roomier
      // side and shrink the menu to it so it scrolls instead of running off the window.
      const openAbove = h > spaceBelow && (h <= spaceAbove || spaceAbove > spaceBelow);
      const room = Math.max(0, openAbove ? spaceAbove : spaceBelow);
      if (h > room) menu.style.maxHeight = `${room}px`;
      const shownH = Math.min(h, room);
      menu.style.top = openAbove ? `${r.top - 4 - shownH}px` : `${r.bottom + 4}px`;
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
        plType: acc.type,
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

  const FLOAT_EDGE_X = 16; // min gap between a floating element and the window's left/right edges
  const FLOAT_EDGE_Y = 12; // ... and its top/bottom edges

  /**
   * Place a position: fixed element next to an anchor rect, always fully inside the window.
   * Prefers below the anchor, then above it. If it fits on neither side (or the anchor has
   * scrolled out of view), it's pinned inside the window as close to the anchor as possible.
   * The element's max-height must leave room for FLOAT_EDGE_Y at the top and bottom.
   */
  function placeFloating(node, anchorRect, gap, nudgeLeft) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const maxTop = Math.max(FLOAT_EDGE_Y, vh - FLOAT_EDGE_Y - h);
    const below = anchorRect.bottom + gap;
    const above = anchorRect.top - gap - h;
    let top;
    if (below >= FLOAT_EDGE_Y && below <= maxTop) top = below;
    else if (above >= FLOAT_EDGE_Y && above <= maxTop) top = above;
    else top = Math.min(Math.max(below, FLOAT_EDGE_Y), maxTop);
    const left = Math.min(Math.max(FLOAT_EDGE_X, anchorRect.left - nudgeLeft), Math.max(FLOAT_EDGE_X, vw - w - FLOAT_EDGE_X));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }

  function positionSplitPanel() {
    if (!splitPanel || splitPanelEl.hidden) return;
    const anchor = document.querySelector('.split-btn[aria-expanded="true"]');
    if (anchor) {
      placeFloating(splitPanelEl, anchor.getBoundingClientRect(), 8, 12);
    } else {
      splitPanelEl.style.left = `${Math.max(FLOAT_EDGE_X, (window.innerWidth - splitPanelEl.offsetWidth) / 2)}px`;
      splitPanelEl.style.top = `${FLOAT_EDGE_Y}px`;
    }
    if (splitToMenuPlace) splitToMenuPlace();
    positionCalc();
  }

  // The panel's height changes without a re-render (fading message, resized note box),
  // so re-place it whenever its size changes.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => positionSplitPanel()).observe(splitPanelEl);
  }

  // mousedown (not click) so a table re-render can't detach the target first.
  document.addEventListener('mousedown', (e) => {
    if (calc && !calcPopEl.contains(e.target) && !(e.target.closest && e.target.closest('.sp-calc-btn'))) closeCalc();
    if (!splitPanel) return;
    if (splitPanelEl.contains(e.target) || calcPopEl.contains(e.target)) return;
    if (e.target.closest && (e.target.closest('.split-btn') || e.target.closest('.split-fix'))) return;
    closeSplitPanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Escape closes the innermost popover first.
    if (calc) closeCalc();
    else if (splitPanel) closeSplitPanel();
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
    // Both reflect split totals, which change on every keystroke (before the save).
    updateChips();
    updateMapStepSplitWarning();
    renderSplitPanel();
  }

  document.getElementById('add-row').onclick = () => {
    const mapping = { plId: '', plName: '', plType: '', plNativeType: '', monarchAccounts: [], monarchAccountsLoan: [] };
    accountMappings.push(mapping);
    refreshMappingRows(); // redraw so the previous last row gets its swap button
  };

  // ---------- row title ----------
  // An optional label for a row, written by the user (no automatic title). It lives in the gutter
  // across the top of the row: blank until hovered, when a pencil appears; with a title, the
  // title shows there. Saved with the row (Model.TITLE_MAX characters) and kept in backups.
  const PENCIL_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  let titleEdit = null; // { mapping, draft } while a title is being edited (survives re-renders)

  function buildRowTitle(mapping) {
    const gutter = document.createElement('div');
    gutter.className = 'row-title';
    const editing = titleEdit && titleEdit.mapping === mapping;

    if (editing) {
      gutter.classList.add('is-editing');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'row-title-input';
      input.id = `row-title-${accountMappings.indexOf(mapping)}`;
      input.maxLength = Model.TITLE_MAX;
      input.placeholder = 'Title (Optional)';
      input.autocomplete = 'off';
      input.setAttribute('aria-label', 'Row title');
      input.value = titleEdit.draft;
      input.addEventListener('input', () => {
        if (titleEdit) titleEdit.draft = input.value;
        sizeTitleInput(input);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finishTitleEdit(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishTitleEdit(false); }
      });
      input.addEventListener('blur', () => {
        if (renderingRows || !input.isConnected) return; // a re-render, not the user leaving
        finishTitleEdit(true);
      });
      gutter.appendChild(input);
      queueMicrotask(() => {
        if (!input.isConnected) return;
        sizeTitleInput(input);
        if (document.activeElement === input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
      return gutter;
    }

    const title = mapping.title || '';
    if (title) {
      const text = document.createElement('span');
      text.className = 'row-title-text';
      text.textContent = title;
      gutter.appendChild(text);
      // Full title in a tip only when it's cut off.
      queueMicrotask(() => {
        if (text.isConnected && text.scrollWidth > text.clientWidth) {
          text.dataset.tip = title;
          attachTip(text);
        }
      });
    }
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'row-title-edit';
    edit.innerHTML = PENCIL_ICON_SVG;
    const label = title ? 'Edit title' : 'Add a title';
    edit.setAttribute('aria-label', label);
    edit.dataset.tip = label;
    attachTip(edit, ICON_TIP_DELAY_MS);
    edit.onclick = (e) => {
      e.stopPropagation();
      hideTip();
      titleEdit = { mapping, draft: title };
      refreshMappingRows();
    };
    gutter.appendChild(edit);
    return gutter;
  }

  const TITLE_INPUT_MIN_WIDTH = 400;

  /** The title box starts 400px wide and grows with its text, up to the row's width. */
  function sizeTitleInput(input) {
    const gutter = input.parentElement;
    if (!gutter) return;
    const cs = getComputedStyle(input);
    const ctx = (sizeTitleInput.canvas || (sizeTitleInput.canvas = document.createElement('canvas'))).getContext('2d');
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const text = input.value || input.placeholder;
    const chrome = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
      + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0) + 4; // + caret room
    const max = gutter.clientWidth;
    const want = Math.ceil(ctx.measureText(text).width + chrome);
    input.style.width = `${Math.min(max, Math.max(TITLE_INPUT_MIN_WIDTH, want))}px`;
  }

  async function finishTitleEdit(save) {
    if (!titleEdit) return;
    const { mapping, draft } = titleEdit;
    titleEdit = null;
    const changed = save && Model.normalizeTitle(draft) !== (mapping.title || '');
    if (changed) mapping.title = Model.normalizeTitle(draft);
    refreshMappingRows();
    if (changed) {
      if (await persistMappings()) showRowSavedCheck(rowElByMapping.get(mapping));
    }
  }

  // ---------- swap rows ----------
  // A ⇅ button on the divider between two rows (at the table's right border) swaps them. The row
  // order is the saved order of the mappings, so it persists and is kept in backups.
  const SWAP_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 20V4M4 8l4-4 4 4M16 4v16M12 16l4 4 4-4"/></svg>';
  const ROW_SWAP_MS = 200;

  function rowLabel(m) {
    return (m && (m.title || m.plName)) || 'unnamed';
  }

  function buildRowSwapButton(index) {
    const above = accountMappings[index];
    const below = accountMappings[index + 1];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-swap';
    btn.id = `row-swap-${index}`;
    btn.innerHTML = SWAP_ICON_SVG;
    const label = `Swap the "${rowLabel(above)}" and "${rowLabel(below)}" rows`;
    btn.setAttribute('aria-label', label);
    btn.dataset.tip = label;
    attachTip(btn, ICON_TIP_DELAY_MS);
    btn.onclick = () => swapRows(index);
    return btn;
  }

  async function swapRows(index) {
    const a = accountMappings[index];
    const b = accountMappings[index + 1];
    if (!a || !b) return;
    hideTip();
    endMonarchPick();
    closeSplitPanel();
    const topBefore = new Map([a, b].map((m) => {
      const tr = rowElByMapping.get(m);
      return [m, tr ? tr.getBoundingClientRect().top : null];
    }));
    accountMappings[index] = b;
    accountMappings[index + 1] = a;
    refreshMappingRows(); // keeps focus on this swap button (same id), so a second click swaps back
    // Slide the two rows from where they were to where they are now, then highlight them.
    for (const m of [a, b]) {
      const tr = rowElByMapping.get(m);
      if (!tr) continue;
      tr.classList.add('row-flash');
      const from = topBefore.get(m);
      if (from == null || reducedMotion() || typeof tr.animate !== 'function') continue;
      const dy = from - tr.getBoundingClientRect().top;
      if (dy) tr.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: ROW_SWAP_MS, easing: 'ease-out' });
    }
    await persistMappings();
  }

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

  // ---------- section hover shadow ----------
  // Popovers live on <body> (so cards can't clip them), which makes moving onto one count as
  // leaving its card. Each popover root has class floating-owned and an _ownerCard; while the
  // pointer is over a card or any popover it owns, that card keeps its hover shadow.
  let hoveredCard = null;
  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    let card = t && t.closest ? t.closest('.step-card') : null;
    if (!card && t && t.closest) {
      const floating = t.closest('.floating-owned');
      card = (floating && floating._ownerCard) || null;
    }
    if (card === hoveredCard) return;
    if (hoveredCard) hoveredCard.classList.remove('is-hovered');
    hoveredCard = card;
    if (card) card.classList.add('is-hovered');
  });
  document.documentElement.addEventListener('mouseleave', () => {
    if (hoveredCard) hoveredCard.classList.remove('is-hovered');
    hoveredCard = null;
  });

  // ---------- mapping-table pickers: open above when there's no room below ----------
  // The Monarch / Asset value / Loan / ProjectionLab pickers in the table are positioned just
  // under their field by CSS. Whenever one is shown or changes size, check the room below it:
  // flip it above the field if it fits there, otherwise keep the roomier side and shrink it so
  // it scrolls instead of running off the window. Writes only when something changes, so the
  // observer below can't loop on its own edits.
  const ROW_PICKER_MAX_H = 240; // matches .monarch-add-panel max-height
  const ROW_PICKER_GAP = 4; // matches .monarch-add-panel margin

  function fitRowPicker(panel) {
    if (panel.style.display !== 'block' || !panel.parentElement) return;
    const field = panel.parentElement.getBoundingClientRect();
    const h = Math.min(panel.scrollHeight + 2, ROW_PICKER_MAX_H); // + borders
    const below = window.innerHeight - field.bottom - ROW_PICKER_GAP - FLOAT_EDGE_Y;
    const above = field.top - ROW_PICKER_GAP - FLOAT_EDGE_Y;
    const up = h > below && (h <= above || above > below);
    const room = Math.max(80, Math.floor(up ? above : below));
    const maxH = h > room ? `${room}px` : '';
    if (panel.classList.contains('open-up') !== up) panel.classList.toggle('open-up', up);
    if (panel.style.maxHeight !== maxH) panel.style.maxHeight = maxH;
  }

  function fitOpenRowPickers() {
    document.querySelectorAll('#map-tbody .monarch-add-panel').forEach(fitRowPicker);
  }

  new MutationObserver(fitOpenRowPickers).observe(document.getElementById('map-tbody'), {
    subtree: true, childList: true, attributes: true, attributeFilter: ['style'],
  });
  window.addEventListener('scroll', fitOpenRowPickers, true);
  window.addEventListener('resize', fitOpenRowPickers);

  setupStepToggles();
  setupReadyPillHelp();
  setupAdvancedSection();
  setHeaderLogoUrl();
  setStep2ButtonIconUrls();
  loadStorage();
})();
