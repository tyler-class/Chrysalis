/**
 * Tests for shared/mapping-model.js — run with: node --test tests/
 * No dependencies; uses Node's built-in test runner.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../shared/mapping-model.js');

const fid = (pct) => M.makeSplitChip('fid', 'Fidelity 401(k)', pct);
const sch = (pct) => M.makeSplitChip('sch', 'Schwab 401(k)', pct);
const row = (plId, chips, extra) => ({
  plId, plName: plId, plType: 'investment', plNativeType: '401k',
  monarchAccounts: chips, monarchAccountsLoan: [], ...(extra || {}),
});

// The couple's example from the design: two 401(k)s, a Roth IRA, a mega backdoor bucket.
const couple = () => [
  row('taxable', [{ id: 'vbrk', name: 'Vanguard Brokerage' }]),
  row('ttrad', [fid(75)]),
  row('troth', [fid(10), { id: 'rira', name: 'Vanguard Roth IRA' }]),
  row('mega', [fid(15), sch(20)]),
  row('strad', [sch(80)]),
];
const balances = { vbrk: 84210.55, fid: 512340.18, sch: 298765.40, rira: 61880.00 };

test('allocateCents: largest remainder adds back to the exact balance', () => {
  const parts = M.allocateCents(512340.18, [75, 10, 15]).map((p) => p.cents);
  assert.deepEqual(parts, [38425513, 5123402, 7685103]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 51234018);
});

test('allocateCents: negative balances split by absolute value, sign restored', () => {
  const parts = M.allocateCents(-100.01, [50, 50]).map((p) => p.cents);
  assert.deepEqual(parts, [-5001, -5000]);
});

test('allocateCents: zero shares get nothing, under-allocation leaves the rest', () => {
  const parts = M.allocateCents(100, [60, 0, 25]).map((p) => p.cents);
  assert.deepEqual(parts, [6000, 0, 2500]);
});

test('allocateCents: thirds still total the balance', () => {
  const parts = M.allocateCents(100, [33.33, 33.33, 33.34]).map((p) => p.cents);
  assert.equal(parts.reduce((a, b) => a + b, 0), 10000);
});

test('planSync: couple example sums split shares and whole accounts per target', () => {
  const { rows } = M.planSync(couple(), balances);
  const by = Object.fromEntries(rows.map((r) => [r.mapping.plId, r]));
  assert.equal(by.taxable.amountCents, 8421055);
  assert.equal(by.ttrad.amountCents, 38425513);
  assert.equal(by.troth.amountCents, 5123402 + 6188000);
  assert.equal(by.mega.amountCents, 7685103 + 5975308);
  assert.equal(by.strad.amountCents, 23901232);
  assert.ok(rows.every((r) => r.write && r.blocked.length === 0 && r.under.length === 0));
});

test('planSync: over-allocated account blocks every row that uses it', () => {
  const maps = couple();
  maps[1].monarchAccounts[0].pct = 85; // fid now 110%
  const { rows } = M.planSync(maps, balances);
  const by = Object.fromEntries(rows.map((r) => [r.mapping.plId, r]));
  for (const id of ['ttrad', 'troth', 'mega']) {
    assert.equal(by[id].write, false, id);
    assert.equal(by[id].blocked[0].reason, 'over');
  }
  assert.equal(by.strad.write, true);
  assert.equal(by.taxable.write, true);
});

test('planSync: under-allocated account syncs with the unallocated amount reported', () => {
  const maps = couple();
  maps[4].monarchAccounts[0].pct = 65; // sch now 85%
  const { rows } = M.planSync(maps, balances);
  const strad = rows.find((r) => r.mapping.plId === 'strad');
  assert.equal(strad.write, true);
  assert.equal(strad.under[0].totalPct, 85);
  assert.equal(strad.under[0].unallocatedCents, 4481481);
});

test('planSync: a 0% share never writes', () => {
  const maps = couple();
  maps.push(row('hsa', [fid(0)]));
  const { rows } = M.planSync(maps, balances);
  const hsa = rows.find((r) => r.mapping.plId === 'hsa');
  assert.equal(hsa.write, false);
  assert.deepEqual(hsa.zero, ['Fidelity 401(k)']);
});

test('planSync: whole account also used in a split counts 100% and blocks', () => {
  const maps = [row('a', [{ id: 'fid', name: 'Fidelity 401(k)' }]), row('b', [fid(20)])];
  const { rows } = M.planSync(maps, balances);
  assert.ok(rows.every((r) => !r.write));
});

test('normalize: a split chip that lost its pct (old Setup re-save) is flagged and blocks', () => {
  const stripped = [{ plId: 'a', monarchAccounts: [{ id: 'split:fid', name: 'Fidelity 401(k)' }] }];
  const maps = M.normalizeMappings(stripped);
  assert.equal(maps[0].monarchAccounts[0].sourceId, 'fid');
  assert.equal(maps[0].monarchAccounts[0].pctMissing, true);
  const { rows } = M.planSync(maps, balances);
  assert.equal(rows[0].write, false);
  assert.equal(rows[0].blocked[0].reason, 'invalid');
});

test('normalize: single 100% share stays as entered (not converted to whole)', () => {
  const maps = M.normalizeMappings([row('a', [fid(100)])]);
  assert.equal(M.isSplitChip(maps[0].monarchAccounts[0]), true);
  assert.equal(maps[0].monarchAccounts[0].pct, 100);
});

test('normalize: legacy flat schema still migrates', () => {
  const maps = M.normalizeMappings([
    { plId: 'p1', plName: 'P1', monarchId: 'm1', monarchName: 'M1' },
    { plId: 'p1', plName: 'P1', monarchId: 'm2', monarchName: 'M2' },
  ]);
  assert.equal(maps.length, 1);
  assert.deepEqual(maps[0].monarchAccounts.map((a) => a.id), ['m1', 'm2']);
});

test('serialize strips UI-only fields and keeps the split encoding', () => {
  const chip = fid(75);
  chip._raw = '75.';
  const [out] = M.serializeMappings([row('a', [chip])]);
  assert.deepEqual(out.monarchAccounts[0], { id: 'split:fid', sourceId: 'fid', name: 'Fidelity 401(k)', pct: 75 });
});

test('allSourceIds resolves split chips to their Monarch account once', () => {
  assert.deepEqual(M.allSourceIds(couple()).sort(), ['fid', 'rira', 'sch', 'vbrk']);
});

test('export/import round trip keeps splits and notes', () => {
  const meta = { fid: { note: 'From balance-by-source, Q3', updatedAt: 1760000000000 }, gone: { note: 'x', updatedAt: 1 } };
  const file = JSON.parse(JSON.stringify(M.buildExport(couple(), meta)));
  assert.equal(file.format, 'chrysalis-mappings');
  assert.equal(file.version, 2);
  assert.equal(file.splits.fid.note, 'From balance-by-source, Q3');
  assert.equal(file.splits.gone, undefined);
  const back = M.parseImport(file);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.warnings, []);
  assert.equal(back.mappings.length, 5);
  assert.equal(back.splitMeta.fid.note, 'From balance-by-source, Q3');
  assert.equal(back.splitMeta.fid.updatedAt, 1760000000000);
  assert.deepEqual(M.planSync(back.mappings, balances).rows.map((r) => r.amountCents),
    M.planSync(couple(), balances).rows.map((r) => r.amountCents));
});

test('import accepts the original bare-array backups', () => {
  const back = M.parseImport([{ plId: 'p', plName: 'P', monarchAccounts: [{ id: 'm', name: 'M' }] }]);
  assert.deepEqual(back.errors, []);
  assert.equal(back.mappings[0].monarchAccounts[0].id, 'm');
});

test('import rejects bad percentages, duplicate targets, newer formats and junk', () => {
  const bad = M.parseImport({ format: 'chrysalis-mappings', version: 2, mappings: [row('a', [{ id: 'split:fid', sourceId: 'fid', name: 'F', pct: 140 }])] });
  assert.match(bad.errors[0], /invalid percentage/);
  const dup = M.parseImport([row('a', [{ id: 'x', name: 'X' }]), row('a', [{ id: 'y', name: 'Y' }])]);
  assert.match(dup.errors.join(' '), /more than one row/);
  const newer = M.parseImport({ format: 'chrysalis-mappings', version: 3, mappings: [] });
  assert.match(newer.errors[0], /newer version/);
  assert.match(M.parseImport({ hello: 1 }).errors[0], /doesn't look like/);
});

test('import reports allocation problems as warnings, not errors', () => {
  const maps = couple();
  maps[4].monarchAccounts[0].pct = 65;
  const back = M.parseImport(M.buildExport(maps, {}));
  assert.deepEqual(back.errors, []);
  assert.match(back.warnings.join(' '), /Schwab 401\(k\) is split 85%/);
});

test('notes over the limit are shortened on import with a warning', () => {
  const file = M.buildExport(couple(), {});
  file.splits.fid.note = 'n'.repeat(600);
  const back = M.parseImport(file);
  assert.equal(back.splitMeta.fid.note.length, M.NOTE_MAX);
  assert.match(back.warnings.join(' '), /shortened/);
});

test('isAssetWithLoanMapping matches the existing native types', () => {
  assert.equal(M.isAssetWithLoanMapping({ plNativeType: 'real_estate' }), true);
  assert.equal(M.isAssetWithLoanMapping({ plNativeType: '401k' }), false);
});
