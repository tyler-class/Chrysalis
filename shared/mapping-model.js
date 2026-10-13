/**
 * Mapping model — the single definition of the account-mapping schema, shared by
 * the service worker, setup page and popup (and the Node tests in tests/).
 *
 * Schema (one row per ProjectionLab account):
 *   { plId, plName, plType, plNativeType, monarchAccounts: [chip], monarchAccountsLoan: [chip] }
 *
 * A chip is either a whole Monarch account:   { id, name }
 * or a split share of one (cash/investment):  { id: 'split:<monarchId>', sourceId: '<monarchId>', name, pct }
 *
 * Rules:
 *   - Each ProjectionLab account has at most one row.
 *   - Each Monarch account's shares across all rows total 100% (a whole chip counts as 100%).
 *     Percentages inside one row are never summed against each other.
 *
 * Split chips use a "split:" id on purpose: an older Chrysalis that doesn't know about
 * splits can't resolve that id, so it reports the account as missing instead of syncing
 * the full balance into every row. If an older Setup page re-saves the mappings it drops
 * `pct`; normalizeChip() flags that as `pctMissing` and the sync blocks the account until
 * the user re-enters its shares.
 */
(function (global) {
  const SPLIT_PREFIX = 'split:';
  const NOTE_MAX = 500;
  const EXPORT_FORMAT = 'chrysalis-mappings';
  const EXPORT_VERSION = 2;
  // Monarch account types that can be split: Investments (brokerage, 401(k), IRA, HSA, 529…)
  // and Cash (depository: checking, savings, money market, CDs).
  const SPLITTABLE_MONARCH_TYPES = ['brokerage', 'depository'];
  // ProjectionLab account types a split share can go to: Savings and Investments.
  const SPLIT_TARGET_PL_TYPES = ['savings', 'investment'];
  const EPS = 0.0001;

  const PL_ASSET_WITH_LOAN_TYPES = [
    'land', 'car', 'vehicle', 'auto', 'real-estate', 'building', 'motorcycle',
    'boat', 'jewelry', 'precious-metals', 'furniture', 'instrument', 'machinery', 'other',
  ];

  function isAssetWithLoanMapping(mapping) {
    const t = ((mapping && mapping.plNativeType) || '').toLowerCase().replace(/_/g, '-');
    for (const key of PL_ASSET_WITH_LOAN_TYPES) {
      if (t === key || t.indexOf(key) !== -1) return true;
    }
    return false;
  }

  function isSplittableMonarchType(type) {
    return SPLITTABLE_MONARCH_TYPES.includes(String(type || '').toLowerCase());
  }

  function isSplitTargetPlType(type) {
    return SPLIT_TARGET_PL_TYPES.includes(String(type || '').toLowerCase());
  }

  function roundPct(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function parsePct(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n) || n < 0 || n > 100) return null;
    return roundPct(n);
  }

  function formatPct(n) {
    return `${roundPct(n)}%`;
  }

  // ---------- chips ----------

  function isSplitChip(chip) {
    return !!chip && (
      (typeof chip.id === 'string' && chip.id.startsWith(SPLIT_PREFIX)) ||
      chip.sourceId != null ||
      chip.pct != null
    );
  }

  function sourceIdOf(chip) {
    if (!chip) return '';
    if (chip.sourceId != null && chip.sourceId !== '') return String(chip.sourceId);
    const id = chip.id == null ? '' : String(chip.id);
    return id.startsWith(SPLIT_PREFIX) ? id.slice(SPLIT_PREFIX.length) : id;
  }

  function makeSplitChip(sourceId, name, pct) {
    return { id: SPLIT_PREFIX + sourceId, sourceId: String(sourceId), name: name || String(sourceId), pct: roundPct(pct) };
  }

  function normalizeChip(a) {
    if (!a || a.id == null) return null;
    if (!isSplitChip(a)) {
      return { id: a.id, name: a.name || a.id };
    }
    const sourceId = sourceIdOf(a);
    const chip = { id: SPLIT_PREFIX + sourceId, sourceId, name: a.name || sourceId, pct: parsePct(a.pct) };
    if (chip.pct === null) chip.pctMissing = true;
    return chip;
  }

  /** Share of the Monarch account this chip claims: 100 for whole chips, null when unknown. */
  function shareOf(chip) {
    if (!isSplitChip(chip)) return 100;
    return chip.pct == null || chip.pctMissing ? null : chip.pct;
  }

  function chipLabel(chip) {
    if (!isSplitChip(chip)) return chip.name;
    if (shareOf(chip) == null) return `${chip.name} (share missing)`;
    return `${formatPct(chip.pct)} of ${chip.name}`;
  }

  // ---------- mappings ----------

  /**
   * Normalize stored mappings to the current schema. Accepts the current schema and the
   * old flat schema ({ plId, monarchId, monarchName }), which is grouped by plId.
   */
  function normalizeMappings(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const out = [];
    for (const m of raw) {
      if (!m || typeof m !== 'object') continue;
      if ('monarchAccounts' in m || 'monarchAccountsLoan' in m) {
        out.push({
          plId: m.plId || '',
          plName: m.plName || m.plId || '',
          plType: m.plType || 'asset',
          plNativeType: m.plNativeType || '',
          monarchAccounts: Array.isArray(m.monarchAccounts)
            ? m.monarchAccounts.map(normalizeChip).filter(Boolean)
            : [],
          monarchAccountsLoan: Array.isArray(m.monarchAccountsLoan)
            ? m.monarchAccountsLoan.map(normalizeChip).filter(Boolean)
            : [],
        });
        continue;
      }
      const plId = m.plId;
      if (!plId) continue;
      let target = out.find((x) => x.plId === plId);
      if (!target) {
        target = {
          plId,
          plName: m.plName || plId,
          plType: m.plType || 'asset',
          plNativeType: m.plNativeType || '',
          monarchAccounts: [],
          monarchAccountsLoan: [],
        };
        out.push(target);
      }
      const mid = m.monarchId || m.monarchAccountId;
      const mname = m.monarchName || m.monarchAccountName || mid;
      if (mid && !target.monarchAccounts.some((a) => a.id === mid)) {
        target.monarchAccounts.push({ id: mid, name: mname });
      }
    }
    return out;
  }

  /** Strip UI-only fields (anything starting with "_") before saving or exporting. */
  function serializeMappings(mappings) {
    const cleanChip = (c) => {
      const out = isSplitChip(c)
        ? { id: SPLIT_PREFIX + sourceIdOf(c), sourceId: sourceIdOf(c), name: c.name, pct: c.pct == null ? null : roundPct(c.pct) }
        : { id: c.id, name: c.name };
      return out;
    };
    return (mappings || []).map((m) => ({
      plId: m.plId || '',
      plName: m.plName || '',
      plType: m.plType || '',
      plNativeType: m.plNativeType || '',
      monarchAccounts: (m.monarchAccounts || []).map(cleanChip),
      monarchAccountsLoan: (m.monarchAccountsLoan || []).map(cleanChip),
    }));
  }

  /** Every Monarch account id referenced by the mappings (split chips resolve to their source). */
  function allSourceIds(mappings) {
    const ids = new Set();
    for (const m of mappings || []) {
      for (const c of m.monarchAccounts || []) ids.add(sourceIdOf(c));
      for (const c of m.monarchAccountsLoan || []) ids.add(sourceIdOf(c));
    }
    ids.delete('');
    return [...ids];
  }

  /**
   * Allocation of each Monarch account across all rows.
   * Returns Map<sourceId, { sourceId, name, total, isSplit, pctMissing, legs: [{ mappingIndex, chipIndex, chip, plId, plName }] }>.
   * Asset-with-loan lane chips count as whole (100%).
   */
  function computeAllocations(mappings) {
    const map = new Map();
    const entryFor = (sourceId, name) => {
      if (!map.has(sourceId)) {
        map.set(sourceId, { sourceId, name: name || sourceId, total: 0, isSplit: false, pctMissing: false, legs: [] });
      }
      return map.get(sourceId);
    };
    (mappings || []).forEach((m, mappingIndex) => {
      const dual = isAssetWithLoanMapping(m);
      const lanes = dual ? [m.monarchAccounts || [], m.monarchAccountsLoan || []] : [m.monarchAccounts || []];
      lanes.forEach((lane) => {
        lane.forEach((chip, chipIndex) => {
          const sourceId = sourceIdOf(chip);
          if (!sourceId) return;
          const e = entryFor(sourceId, chip.name);
          const share = dual ? 100 : shareOf(chip);
          if (!dual && isSplitChip(chip)) e.isSplit = true;
          if (share == null) e.pctMissing = true;
          else e.total = roundPct(e.total + share);
          e.legs.push({ mappingIndex, chipIndex, chip, plId: m.plId, plName: m.plName, dual });
        });
      });
    });
    return map;
  }

  /** 'ok' | 'under' | 'over' | 'invalid' for one allocation entry. */
  function allocationState(entry) {
    if (!entry) return 'ok';
    if (entry.pctMissing) return 'invalid';
    if (entry.total > 100 + EPS) return 'over';
    if (entry.isSplit && entry.total < 100 - EPS) return 'under';
    return 'ok';
  }

  /**
   * Split a balance into cents by percentage shares using the largest-remainder method,
   * so the shares always add back to exactly round(balance * sum(shares)/100).
   * Negative balances are split by absolute value and the sign is reapplied.
   * Zero shares always get 0 cents.
   */
  function allocateCents(balance, shares) {
    const num = Number(balance) || 0;
    const sign = num < 0 ? -1 : 1;
    const totalCents = Math.round(Math.abs(num) * 100);
    const clean = shares.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
    const sum = clean.reduce((a, b) => a + b, 0);
    const target = Math.round((totalCents * Math.min(sum, 100)) / 100);
    const exact = clean.map((s) => (totalCents * s) / 100);
    const floors = exact.map((e) => Math.floor(e + 1e-9));
    let left = target - floors.reduce((a, b) => a + b, 0);
    const order = exact
      .map((e, i) => ({ i, frac: e - floors[i] }))
      .filter((o) => clean[o.i] > 0)
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length) {
      floors[order[k].i] += 1;
      left -= 1;
    }
    return floors.map((c, i) => ({ cents: sign * c, exactCents: sign * exact[i] }));
  }

  /**
   * Plan the balances for every single-lane (non asset-with-loan) row.
   * balanceMap: { [monarchId]: number }.
   * Returns { rows: [plan], allocations } where each plan is
   *   { mappingIndex, mapping, sources, amountCents, write, blocked, under, missing, zero }.
   * A row writes only when nothing in it is blocked and at least one source contributes.
   */
  function planSync(mappings, balanceMap) {
    const allocations = computeAllocations(mappings);
    const legCents = new Map(); // chip -> { cents, exactCents }
    for (const entry of allocations.values()) {
      if (!entry.isSplit || allocationState(entry) === 'over' || allocationState(entry) === 'invalid') continue;
      if (!(entry.sourceId in balanceMap)) continue;
      const legs = entry.legs.filter((l) => !l.dual);
      const parts = allocateCents(balanceMap[entry.sourceId], legs.map((l) => shareOf(l.chip)));
      legs.forEach((l, i) => legCents.set(l.chip, parts[i]));
    }

    const rows = [];
    (mappings || []).forEach((mapping, mappingIndex) => {
      if (isAssetWithLoanMapping(mapping)) return;
      const plan = {
        mappingIndex, mapping, sources: [], amountCents: 0, write: false,
        blocked: [], under: [], missing: [], zero: [],
      };
      for (const chip of mapping.monarchAccounts || []) {
        const sourceId = sourceIdOf(chip);
        const entry = allocations.get(sourceId);
        const state = allocationState(entry);
        const split = isSplitChip(chip);
        const src = {
          sourceId, name: chip.name, isSplit: split, pct: split ? chip.pct : null,
          label: chipLabel(chip), balance: null, amountCents: null, roundingCents: 0, status: 'ok',
        };
        if (state === 'over' || state === 'invalid') {
          src.status = 'blocked';
          if (!plan.blocked.some((b) => b.sourceId === sourceId)) {
            plan.blocked.push({ sourceId, name: chip.name, reason: state, totalPct: entry.total });
          }
        } else if (!(sourceId in balanceMap)) {
          src.status = 'missing';
          plan.missing.push(chip.name);
        } else {
          src.balance = balanceMap[sourceId];
          if (split && shareOf(chip) === 0) {
            src.status = 'zero';
            src.amountCents = 0;
            plan.zero.push(chip.name);
          } else if (split) {
            const part = legCents.get(chip);
            src.amountCents = part.cents;
            src.roundingCents = Math.round((part.cents - part.exactCents) * 10) / 10;
          } else {
            src.amountCents = Math.round(Number(src.balance) * 100);
          }
          if (src.status === 'ok') plan.amountCents += src.amountCents;
          if (split && state === 'under' && !plan.under.some((u) => u.sourceId === sourceId)) {
            const unallocated = allocateCents(src.balance, [100 - entry.total])[0].cents;
            plan.under.push({ sourceId, name: chip.name, totalPct: entry.total, unallocatedCents: unallocated });
          }
        }
        plan.sources.push(src);
      }
      plan.write = plan.blocked.length === 0 && plan.sources.some((s) => s.status === 'ok');
      rows.push(plan);
    });
    return { rows, allocations };
  }

  // ---------- validation (setup) ----------

  /** Problems that should block a save or import. Returns an array of messages. */
  function validateStructure(mappings) {
    const errors = [];
    const seenPl = new Map();
    (mappings || []).forEach((m, i) => {
      const where = m.plName || m.plId || `row ${i + 1}`;
      if (m.plId) {
        if (seenPl.has(m.plId)) errors.push(`ProjectionLab account "${where}" is mapped in more than one row.`);
        seenPl.set(m.plId, true);
      }
      const seenSrc = new Set();
      for (const c of m.monarchAccounts || []) {
        const sid = sourceIdOf(c);
        if (seenSrc.has(sid)) errors.push(`"${c.name}" appears twice in the "${where}" row.`);
        seenSrc.add(sid);
        if (isSplitChip(c) && c.pctMissing) {
          errors.push(`"${c.name}" in the "${where}" row has a split share without a valid percentage (0–100).`);
        }
        if (isSplitChip(c) && isAssetWithLoanMapping(m)) {
          errors.push(`"${c.name}" is split into "${where}", but asset-with-loan accounts can't take split shares.`);
        }
      }
      for (const c of m.monarchAccountsLoan || []) {
        if (isSplitChip(c)) errors.push(`"${c.name}" is split into the loan side of "${where}", which isn't supported.`);
      }
    });
    return errors;
  }

  /**
   * Split Monarch accounts whose shares don't total 100% (under, over, or a share with no
   * percentage). While any exist, nothing syncs: Setup hides "Ready to Sync", the popup shows
   * a warning instead of Sync Now, and the sync itself refuses to run.
   * Returns [{ sourceId, name, total, state }].
   */
  function unbalancedSplits(mappings) {
    const out = [];
    for (const e of computeAllocations(mappings).values()) {
      if (!e.isSplit) continue;
      const state = allocationState(e);
      if (state !== 'ok') out.push({ sourceId: e.sourceId, name: e.name, total: e.total, state });
    }
    return out;
  }

  /** One line per unbalanced split, e.g. "Fidelity 401(k) is at 90%". */
  function describeUnbalancedSplit(u) {
    return u.state === 'invalid' ? `${u.name} has a share with no percentage` : `${u.name} is at ${formatPct(u.total)}`;
  }

  /** Allocation warnings (under/over/missing pct), one message per Monarch account. */
  function allocationWarnings(mappings) {
    const out = [];
    for (const entry of computeAllocations(mappings).values()) {
      const state = allocationState(entry);
      if (state === 'over') out.push(`${entry.name} is split ${formatPct(entry.total)}. Rows using it won't sync until its shares total 100%.`);
      else if (state === 'under') out.push(`${entry.name} is split ${formatPct(entry.total)}. The rest won't sync until you assign it.`);
      else if (state === 'invalid') out.push(`${entry.name} has a split share with no percentage. Re-enter its shares before it can sync.`);
    }
    return out;
  }

  // ---------- split notes / metadata ----------

  function normalizeSplitMeta(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object') continue;
      const note = typeof v.note === 'string' ? v.note.slice(0, NOTE_MAX) : '';
      const updatedAt = Number.isFinite(Number(v.updatedAt)) ? Number(v.updatedAt)
        : (typeof v.updatedAt === 'string' && !Number.isNaN(Date.parse(v.updatedAt)) ? Date.parse(v.updatedAt) : null);
      out[String(id)] = { note, updatedAt };
    }
    return out;
  }

  /** Drop metadata for Monarch accounts that are no longer split anywhere. */
  function pruneSplitMeta(meta, mappings) {
    const splitIds = new Set();
    for (const e of computeAllocations(mappings).values()) if (e.isSplit) splitIds.add(e.sourceId);
    const out = {};
    for (const [id, v] of Object.entries(meta || {})) if (splitIds.has(id)) out[id] = v;
    return out;
  }

  // ---------- backup file ----------

  function buildExport(mappings, splitMeta, extra) {
    const clean = serializeMappings(mappings).filter(
      (m) => m.plId && ((m.monarchAccounts.length || 0) + (m.monarchAccountsLoan.length || 0)) > 0
    );
    const allocations = computeAllocations(clean);
    const splits = {};
    for (const e of allocations.values()) {
      if (!e.isSplit) continue;
      const meta = (splitMeta || {})[e.sourceId] || {};
      splits[e.sourceId] = {
        name: e.name,
        note: meta.note || '',
        updatedAt: meta.updatedAt ? new Date(meta.updatedAt).toISOString() : null,
      };
    }
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      ...(extra || {}),
      mappings: clean,
      splits,
    };
  }

  /**
   * Parse an uploaded backup. Accepts the v2 envelope and the original bare array.
   * Returns { mappings, splitMeta, warnings, errors }. When errors is non-empty nothing
   * should be saved.
   */
  function parseImport(data) {
    const result = { mappings: [], splitMeta: {}, warnings: [], errors: [] };
    let rawMappings;
    let rawSplits = {};
    if (Array.isArray(data)) {
      rawMappings = data;
    } else if (data && typeof data === 'object' && data.format === EXPORT_FORMAT) {
      if (Number(data.version) > EXPORT_VERSION) {
        result.errors.push(`This file was made by a newer version of Chrysalis (format version ${data.version}). Update Chrysalis, then upload it again.`);
        return result;
      }
      if (!Array.isArray(data.mappings)) {
        result.errors.push('The file has no "mappings" list.');
        return result;
      }
      rawMappings = data.mappings;
      rawSplits = data.splits && typeof data.splits === 'object' ? data.splits : {};
    } else {
      result.errors.push('This doesn\'t look like a Chrysalis mappings file.');
      return result;
    }

    // Reject malformed percentages before normalizing hides them.
    rawMappings.forEach((m, i) => {
      (m && Array.isArray(m.monarchAccounts) ? m.monarchAccounts : []).forEach((c) => {
        if (c && isSplitChip(c) && parsePct(c.pct) === null) {
          result.errors.push(`"${c.name || sourceIdOf(c)}" in "${(m && (m.plName || m.plId)) || `row ${i + 1}`}" has an invalid percentage (${JSON.stringify(c.pct)}). Use a number from 0 to 100.`);
        }
      });
    });

    const mappings = normalizeMappings(rawMappings);
    if (mappings.length === 0) result.errors.push('No valid mappings in file.');
    for (const e of validateStructure(mappings)) if (!result.errors.includes(e)) result.errors.push(e);

    const meta = normalizeSplitMeta(rawSplits);
    for (const [id, v] of Object.entries(rawSplits)) {
      if (v && typeof v.note === 'string' && v.note.length > NOTE_MAX) {
        result.warnings.push(`The note for ${v.name || id} was longer than ${NOTE_MAX} characters and was shortened.`);
      }
    }
    result.mappings = mappings;
    result.splitMeta = pruneSplitMeta(meta, mappings);
    result.warnings.push(...allocationWarnings(mappings));
    return result;
  }

  const api = {
    SPLIT_PREFIX,
    NOTE_MAX,
    EXPORT_FORMAT,
    EXPORT_VERSION,
    SPLITTABLE_MONARCH_TYPES,
    SPLIT_TARGET_PL_TYPES,
    PL_ASSET_WITH_LOAN_TYPES,
    isAssetWithLoanMapping,
    isSplittableMonarchType,
    isSplitTargetPlType,
    roundPct,
    parsePct,
    formatPct,
    isSplitChip,
    sourceIdOf,
    makeSplitChip,
    normalizeChip,
    shareOf,
    chipLabel,
    normalizeMappings,
    serializeMappings,
    allSourceIds,
    computeAllocations,
    allocationState,
    allocateCents,
    planSync,
    validateStructure,
    allocationWarnings,
    unbalancedSplits,
    describeUnbalancedSplit,
    normalizeSplitMeta,
    pruneSplitMeta,
    buildExport,
    parseImport,
  };

  global.ChrysalisMappingModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
