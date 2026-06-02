/**
 * Chrysalis announcement banner — a tiny, reusable framework.
 *
 * Publishing a new announcement (e.g. for the next release) is intentionally a
 * one-step edit: prepend a new object to the ANNOUNCEMENTS array below with a
 * brand-new, never-reused `id`. Everything else (rendering, the dismiss button,
 * dismissal persistence, auto-expiry) runs through the same code path every time
 * — no adding/removing code per release.
 *
 * Each announcement is:
 *   {
 *     id:       unique string, NEVER reused (this is the dismissal key)
 *     title:    short heading (HTML allowed — author-controlled, not user input)
 *     body:     announcement text (HTML allowed)
 *     linkText: optional CTA link label
 *     linkUrl:  optional CTA link target
 *     expires:  ISO date; the banner disappears ON this date (so it shows
 *               through the day before). Leave out for no expiry.
 *   }
 *
 * Dismissal model (recommended approach): we store the SET of dismissed
 * announcement ids in chrome.storage.local under `dismissedAnnouncements`.
 * Keying dismissal by a unique id — rather than a single boolean we'd have to
 * remember to reset — means a brand-new announcement is never in the dismissed
 * set, so an old dismissal can NEVER suppress a future announcement. There is no
 * time-based flag to clear. For hygiene we also lazily prune ids whose
 * announcement no longer exists or has expired, but correctness does not depend
 * on it.
 */
(function () {
  const STORAGE_KEY = 'dismissedAnnouncements';

  // ─── Edit this list to publish announcements ──────────────────────────────
  const ANNOUNCEMENTS = [
    {
      id: 'v1.1.0',
      title: 'New release — v1.1.0',
      body:
        '<strong>A total visual refresh.</strong> v1.1.0 is a top-to-bottom redesign ' +
        "of Chrysalis's interface, plus a new logo. There are no changes to core " +
        'functionality — but the tool should be more enjoyable to use and easier to ' +
        'navigate and understand with the new UI.<br><br>' +
        '<strong>Catching up from v1.0.6:</strong> restored Monarch syncing, a manual ' +
        '<strong>ProjectionLab Early Access</strong> toggle, and support for Chromium ' +
        'browsers beyond Chrome (Arc, Brave, Edge, Opera, Vivaldi).',
      linkText: 'Read the release notes ↗',
      linkUrl: 'https://github.com/tyler-class/Chrysalis#readme',
      expires: '2026-07-30', // disappears on 2026-07-30 (shows through 2026-07-29)
    },
  ];
  // ──────────────────────────────────────────────────────────────────────────

  function isActive(a, now) {
    if (!a || !a.id) return false;
    if (a.expires) {
      const exp = Date.parse(a.expires);
      if (!Number.isNaN(exp) && now >= exp) return false;
    }
    return true;
  }

  async function getDismissed() {
    try {
      const r = await chrome.storage.local.get([STORAGE_KEY]);
      return Array.isArray(r[STORAGE_KEY]) ? r[STORAGE_KEY] : [];
    } catch (_) {
      return [];
    }
  }

  async function getActive() {
    const now = Date.now();
    const dismissed = await getDismissed();
    return (
      ANNOUNCEMENTS.find((a) => isActive(a, now) && !dismissed.includes(a.id)) ||
      null
    );
  }

  async function dismiss(id) {
    try {
      const dismissed = await getDismissed();
      if (!dismissed.includes(id)) dismissed.push(id);
      // Hygiene: keep only ids that still map to a live (existing, unexpired)
      // announcement so the stored list can't grow forever.
      const now = Date.now();
      const liveIds = new Set(
        ANNOUNCEMENTS.filter((a) => isActive(a, now)).map((a) => a.id)
      );
      const pruned = dismissed.filter((d) => liveIds.has(d));
      await chrome.storage.local.set({ [STORAGE_KEY]: pruned });
    } catch (_) {}
  }

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected || document.getElementById('chrysalis-announcement-styles')) {
      stylesInjected = true;
      return;
    }
    const style = document.createElement('style');
    style.id = 'chrysalis-announcement-styles';
    style.textContent = `
      .chrysalis-announcement {
        position: relative;
        margin-bottom: 14px;
        padding: 13px 38px 13px 16px;
        border: 1px solid var(--line, #e6e2d8);
        border-left: 3px solid var(--ink, #16150f);
        border-radius: 14px;
        background: var(--card, #ffffff);
        box-shadow: var(--shadow-md, 0 6px 16px -6px rgba(28,25,15,.12), 0 2px 6px -2px rgba(28,25,15,.08));
        font-size: 12px;
        line-height: 1.5;
        color: var(--ink, #16150f);
      }
      .chrysalis-announcement-title {
        font-weight: 700; font-size: 13.5px; margin-bottom: 4px;
        display: flex; align-items: center; gap: 6px;
      }
      .chrysalis-announcement-title::before { content: "📣"; font-size: 14px; }
      .chrysalis-announcement-body { color: var(--ink-2, #56524a); }
      .chrysalis-announcement-link {
        display: inline-block; margin-top: 8px;
        font-weight: 700; color: var(--ink, #16150f); text-decoration: underline;
      }
      .chrysalis-announcement-link:hover { text-decoration: underline; }
      .chrysalis-announcement-dismiss {
        position: absolute; top: 8px; right: 8px;
        background: none; border: none; cursor: pointer;
        font-size: 18px; line-height: 1; color: var(--ink-2, #56524a);
        padding: 2px 7px; border-radius: 6px; font-family: inherit;
      }
      .chrysalis-announcement-dismiss:hover { color: var(--ink, #16150f); background: rgba(0,0,0,0.05); }
    `;
    document.head.appendChild(style);
    stylesInjected = true;
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  async function renderInto(container) {
    if (!container) return;
    const a = await getActive();
    if (!a) {
      container.innerHTML = '';
      return;
    }
    injectStyles();
    container.innerHTML = `
      <div class="chrysalis-announcement" role="status">
        <button type="button" class="chrysalis-announcement-dismiss" aria-label="Dismiss announcement" title="Dismiss">×</button>
        <div class="chrysalis-announcement-title">${a.title}</div>
        <div class="chrysalis-announcement-body">${a.body}</div>
        ${
          a.linkUrl
            ? `<a class="chrysalis-announcement-link" href="${escapeAttr(a.linkUrl)}" target="_blank" rel="noopener noreferrer">${a.linkText || 'Learn more ↗'}</a>`
            : ''
        }
      </div>
    `;
    const btn = container.querySelector('.chrysalis-announcement-dismiss');
    if (btn) {
      btn.addEventListener('click', async () => {
        container.innerHTML = '';
        await dismiss(a.id);
      });
    }
  }

  window.ChrysalisAnnouncements = { getActive, dismiss, renderInto, ANNOUNCEMENTS };
})();
