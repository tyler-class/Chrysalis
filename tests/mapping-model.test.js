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

test('Monarch Cash and Investments accounts can be split; other types cannot', () => {
  assert.equal(M.isSplittableMonarchType('brokerage'), true);
  assert.equal(M.isSplittableMonarchType('depository'), true);
  assert.equal(M.isSplittableMonarchType('DEPOSITORY'), true);
  for (const t of ['equity', 'credit', 'loan', 'real_estate', 'other_asset', '', undefined]) {
    assert.equal(M.isSplittableMonarchType(t), false, String(t));
  }
});

test('split shares can go to ProjectionLab Savings or Investments accounts only', () => {
  assert.equal(M.isSplitTargetPlType('savings'), true);
  assert.equal(M.isSplitTargetPlType('investment'), true);
  for (const t of ['asset', 'debt', '', undefined]) {
    assert.equal(M.isSplitTargetPlType(t), false, String(t));
  }
});

test('a cash account split across Savings and Investments rows plans like any other split', () => {
  const chk = (pct) => M.makeSplitChip('chk', 'Chase Savings', pct);
  const mappings = [
    row('efund', [chk(60)], { plType: 'savings', plNativeType: 'savings' }),
    row('brokcash', [chk(40)]),
  ];
  const { rows } = M.planSync(mappings, { chk: 10000.01 });
  assert.deepEqual(rows.map((r) => r.amountCents), [600001, 400000]);
  assert.ok(rows.every((r) => r.write));
});

test('unbalancedSplits lists split accounts that are not at 100% (and nothing else)', () => {
  assert.deepEqual(M.unbalancedSplits(couple()), []);
  const under = couple();
  under[1].monarchAccounts = [fid(70)]; // fid now 95%
  const over = couple();
  over[4].monarchAccounts = [sch(90)]; // sch now 110%
  const missing = couple();
  missing[3].monarchAccounts[0] = { ...fid(15), pct: null, pctMissing: true };
  assert.deepEqual(M.unbalancedSplits(under).map((u) => [u.sourceId, u.state, u.total]), [['fid', 'under', 95]]);
  assert.deepEqual(M.unbalancedSplits(over).map((u) => [u.sourceId, u.state, u.total]), [['sch', 'over', 110]]);
  assert.deepEqual(M.unbalancedSplits(missing).map((u) => [u.sourceId, u.state]), [['fid', 'invalid']]);
  assert.equal(M.describeUnbalancedSplit(M.unbalancedSplits(under)[0]), 'Fidelity 401(k) is at 95%');
  assert.equal(M.describeUnbalancedSplit(M.unbalancedSplits(missing)[0]), 'Fidelity 401(k) has a share with no percentage');
});

test('row titles: optional, trimmed, capped, saved only when set, and kept in backups', () => {
  const rows = couple();
  rows[0].title = '  All my brokerage  ';
  rows[1].title = 'x'.repeat(300);
  const saved = M.serializeMappings(rows);
  assert.equal(saved[0].title, 'All my brokerage');
  assert.equal(saved[1].title.length, M.TITLE_MAX);
  assert.ok(!('title' in saved[2]), 'untitled rows store no title field');
  assert.equal(M.normalizeMappings(saved)[0].title, 'All my brokerage');
  assert.equal(M.normalizeMappings(saved)[2].title, '');
  const file = M.buildExport(rows, {});
  const back = M.parseImport(JSON.parse(JSON.stringify(file)));
  assert.deepEqual(back.errors, []);
  assert.equal(back.mappings[0].title, 'All my brokerage');
  const long = M.buildExport(couple(), {});
  long.mappings[0].title = 'y'.repeat(260);
  const back2 = M.parseImport(long);
  assert.equal(back2.mappings[0].title.length, M.TITLE_MAX);
  assert.match(back2.warnings.join(' '), /longer than 250 characters/);
});

// ---------- ProjectionLab plugin API contract (V4 / V5) ----------

test('plContractOf: a missing version is V4 (contract 1); V5 reports 2', () => {
  assert.equal(M.plContractOf(undefined), 1);
  assert.equal(M.plContractOf(null), 1);
  assert.equal(M.plContractOf(2), 2);
  assert.equal(M.isSupportedPlContract(1), true);
  assert.equal(M.isSupportedPlContract(2), true);
  assert.equal(M.isSupportedPlContract(3), false);
  assert.match(M.unsupportedPlContractMessage(3), /version 3/);
});

test('normalizeV5Account: kinds map to the V4 categories; nativeType is always empty', () => {
  const debt = M.normalizeV5Account({ id: 7, name: 'Mortgage', kind: 'debt', type: 'mortgage', balance: 1, securedByAssetId: 9 });
  assert.deepEqual(debt, {
    id: '7', name: 'Mortgage', type: 'debt', nativeType: '', kind: 'debt',
    v5Type: 'mortgage', subtype: '', securedByAssetId: '9',
  });
  const house = M.normalizeV5Account({ id: '9', name: 'House', kind: 'real-asset', type: 'real-estate', value: 1 });
  assert.equal(house.type, 'asset');
  // On V5 a loan is its own account, so nothing is two-lane.
  assert.equal(house.nativeType, '');
  assert.equal(M.isAssetWithLoanMapping({ plNativeType: house.nativeType }), false);
  // An account whose type happens to contain an asset keyword is never treated as asset-with-loan.
  const other = M.normalizeV5Account({ id: 'o', name: 'Other', kind: 'account', type: 'other' });
  assert.equal(other.nativeType, '');
  assert.equal(M.isAssetWithLoanMapping({ plNativeType: other.nativeType }), false);
  assert.equal(M.normalizeV5Account({ id: 'x', kind: 'mystery' }), null);
  assert.equal(M.normalizeV5Account({ kind: 'debt' }), null);
});

test('v5CategoryOf: only type "savings" is Savings; every other account type is Investments', () => {
  assert.equal(M.v5CategoryOf({ kind: 'account', type: 'savings' }), 'savings');
  for (const t of ['taxable', '401k', 'roth-ira', 'hsa', '529', 'crypto', 'sep', 'tfsa']) {
    assert.equal(M.v5CategoryOf({ kind: 'account', type: t }), 'investment');
  }
  assert.equal(M.v5CategoryOf({ kind: 'debt', type: 'mortgage' }), 'debt');
  assert.equal(M.v5CategoryOf({ kind: 'real-asset', type: 'car' }), 'asset');
  for (const t of ['savings', 'investment']) assert.equal(M.isSplitTargetPlType(t), true);
});

test('planV5Writes: the field comes from the account kind, not the saved mapping', () => {
  const accounts = [
    { id: 's', name: 'Savings', kind: 'account' },
    { id: 'd', name: 'Card', kind: 'debt' },
    { id: 'h', name: 'House', kind: 'real-asset' },
  ];
  const plan = M.planV5Writes([
    { plId: 's', balance: -12.5 },
    { plId: 'd', balance: -300 },
    { plId: 'h', balance: 450000 },
  ], accounts);
  assert.deepEqual(plan, [
    { plId: 's', values: { balance: -12.5 } },
    { plId: 'd', values: { balance: 300 } }, // debts are positive for money owed
    { plId: 'h', values: { value: 450000 } }, // real assets use value, never balance
  ]);
});

test('planV5Writes: missing (archived/deleted) accounts and bad numbers are errors, never writes', () => {
  const plan = M.planV5Writes([
    { plId: 'gone', balance: 1 },
    { plId: 's', balance: NaN },
  ], [{ id: 's', name: 'S', kind: 'account' }]);
  assert.equal(plan[0].error, M.V5_MISSING_ACCOUNT_ERROR);
  assert.equal(plan[0].values, undefined);
  assert.match(plan[1].error, /valid number/);
});

test('planV5Writes: asset-with-loan rows write the asset value and report the loan as not synced', () => {
  const accounts = [{ id: 'h', name: 'House', kind: 'real-asset' }, { id: 's', name: 'S', kind: 'account' }];
  const both = M.planV5Writes([{ plId: 'h', isAssetWithLoan: true, valueSum: 500000, loanSum: -200000, hasValue: true, hasLoan: true }], accounts)[0];
  assert.deepEqual(both.values, { value: 500000 });
  assert.equal(both.warning, M.V5_LOAN_NOT_SYNCED_WARNING);
  const loanOnly = M.planV5Writes([{ plId: 'h', isAssetWithLoan: true, valueSum: 0, loanSum: 1, hasValue: false, hasLoan: true }], accounts)[0];
  assert.equal(loanOnly.values, undefined);
  assert.equal(loanOnly.error, M.V5_LOAN_NOT_SYNCED_WARNING);
  const wrongKind = M.planV5Writes([{ plId: 's', isAssetWithLoan: true, valueSum: 1, loanSum: 2, hasValue: true, hasLoan: true }], accounts)[0];
  assert.match(wrongKind.error, /isn't a real asset/);
});

test('planV5Writes: a two-lane row on a non-asset with an empty Loan lane writes a normal balance', () => {
  // V4 treats "credit-card" as asset-with-loan because the type contains "car".
  assert.equal(M.isAssetWithLoanMapping({ plNativeType: 'credit-card' }), true);
  const plan = M.planV5Writes(
    [{ plId: 'cc', isAssetWithLoan: true, valueSum: -340, loanSum: 0, hasValue: true, hasLoan: false }],
    [{ id: 'cc', name: 'Card', kind: 'debt' }]
  );
  assert.deepEqual(plan, [{ plId: 'cc', values: { balance: 340 } }]);
});

test('migrateToV5Mappings: two-lane rows become an asset row plus a loan row', () => {
  const chip = (id, name) => ({ id, name });
  const mappings = [
    { plId: 'house', plName: 'House', plType: 'asset', plNativeType: 'real-estate', monarchAccounts: [chip('z', 'Zillow')], monarchAccountsLoan: [chip('mort', 'Chase mortgage')] },
    { plId: 'car', plName: 'Car', plType: 'asset', plNativeType: 'car', monarchAccounts: [chip('kbb', 'KBB')], monarchAccountsLoan: [chip('al', 'Auto loan')] },
    { plId: 'boat', plName: 'Boat', plType: 'asset', plNativeType: 'boat', monarchAccounts: [chip('b', 'Boat value')], monarchAccountsLoan: [] },
    { plId: 'cc', plName: 'Card', plType: 'debt', plNativeType: 'credit-card', monarchAccounts: [chip('amex', 'Amex')], monarchAccountsLoan: [] },
    { plId: 'sav', plName: 'Savings', plType: 'savings', plNativeType: 'savings', monarchAccounts: [chip('chk', 'Checking')], monarchAccountsLoan: [] },
  ];
  const accounts = [
    { id: 'house', name: 'House', kind: 'real-asset', type: 'asset' },
    { id: 'car', name: 'Car', kind: 'real-asset', type: 'asset' },
    { id: 'boat', name: 'Boat', kind: 'real-asset', type: 'asset' },
    { id: 'cc', name: 'Card', kind: 'debt', type: 'debt' },
    { id: 'sav', name: 'Savings', kind: 'account', type: 'savings' },
    { id: 'm1', name: 'Mortgage', kind: 'debt', type: 'debt', securedByAssetId: 'house' },
    { id: 'l1', name: 'Car loan A', kind: 'debt', type: 'debt', securedByAssetId: 'car' },
    { id: 'l2', name: 'Car loan B', kind: 'debt', type: 'debt', securedByAssetId: 'car' },
  ];
  const before = JSON.stringify(mappings);
  const { mappings: out, summary } = M.migrateToV5Mappings(mappings, accounts);
  assert.equal(JSON.stringify(mappings), before, 'input is not edited');
  assert.deepEqual(summary, { rows: 4, loansLinked: 1, loansToPick: 1 });
  assert.deepEqual(out.map((m) => [m.plId, m.monarchAccounts.map((c) => c.id).join('+'), m.monarchAccountsLoan.length]), [
    ['house', 'z', 0],
    ['m1', 'mort', 0], // exactly one debt secures the house: pre-filled
    ['car', 'kbb', 0],
    ['', 'al', 0], // two debts secure the car: the person picks
    ['boat', 'b', 0], // no loan lane chips: no loan row
    ['cc', 'amex', 0], // two-lane only by type-text match: just loses the lane
    ['sav', 'chk', 0],
  ]);
  assert.match(out[3].title, /^Loan for Car: pick its ProjectionLab loan account$/);
  assert.equal(out.every((m) => !M.isAssetWithLoanMapping(m)), true);
});

test('migrateToV5Mappings: a debt that already has a row is not pre-filled again', () => {
  const mappings = [
    { plId: 'house', plName: 'House', plType: 'asset', plNativeType: 'real-estate', monarchAccounts: [], monarchAccountsLoan: [{ id: 'mort', name: 'Mortgage' }] },
    { plId: 'm1', plName: 'Mortgage', plType: 'debt', plNativeType: '', monarchAccounts: [{ id: 'x', name: 'X' }], monarchAccountsLoan: [] },
  ];
  const accounts = [{ id: 'house', name: 'House', kind: 'real-asset' }, { id: 'm1', name: 'Mortgage', kind: 'debt', securedByAssetId: 'house' }];
  const { mappings: out, summary } = M.migrateToV5Mappings(mappings, accounts);
  assert.equal(summary.loansToPick, 1);
  assert.equal(out[1].plId, '');
});

test('planV5LoanMigration: nothing to do on the older format or without two-lane rows', () => {
  const twoLane = [{ plId: 'house', plName: 'House', plType: 'asset', plNativeType: 'real-estate', monarchAccounts: [{ id: 'z', name: 'Zillow' }], monarchAccountsLoan: [{ id: 'mort', name: 'Mortgage' }] }];
  const oneLane = [{ plId: 'sav', plName: 'Savings', plType: 'savings', plNativeType: 'savings', monarchAccounts: [{ id: 'chk', name: 'Checking' }], monarchAccountsLoan: [] }];
  const v5 = [{ id: 'house', name: 'House', kind: 'real-asset' }, { id: 'sav', name: 'Savings', kind: 'account', type: 'savings' }];
  const v4 = [{ id: 'house', name: 'House', type: 'asset' }];
  assert.equal(M.planV5LoanMigration(twoLane, v4, {}), null, 'older format: rows stay two-lane');
  assert.equal(M.planV5LoanMigration(oneLane, v5, {}), null, 'no two-lane rows');
  assert.equal(M.planV5LoanMigration(twoLane, [], {}), null, 'no accounts');
});

test('planV5LoanMigration: moved rows sync the loan to its own debt, with a backup of the old rows', () => {
  const mappings = M.normalizeMappings([
    { plId: 'house', plName: 'House', plType: 'asset', plNativeType: 'real-estate', monarchAccounts: [{ id: 'z', name: 'Zillow' }], monarchAccountsLoan: [{ id: 'mort', name: 'Mortgage' }] },
    { plId: 'sav', plName: 'Savings', plType: 'savings', plNativeType: 'savings', monarchAccounts: [{ id: 'chk', name: 'Checking' }], monarchAccountsLoan: [] },
  ]);
  const accounts = [
    { id: 'house', name: 'House', kind: 'real-asset', type: 'asset' },
    { id: 'sav', name: 'Savings', kind: 'account', type: 'savings' },
    { id: 'm1', name: 'Mortgage', kind: 'debt', type: 'debt', securedByAssetId: 'house' },
  ];
  const plan = M.planV5LoanMigration(mappings, accounts, {}, { extensionVersion: '1.3.0' });
  assert.deepEqual(plan.summary, { rows: 1, loansLinked: 1, loansToPick: 0 });

  // The backup restores the two-lane rows exactly.
  const restored = M.parseImport(plan.backup).mappings;
  assert.equal(restored.length, 2);
  assert.equal(M.isAssetWithLoanMapping(restored[0]), true);
  assert.deepEqual(restored[0].monarchAccountsLoan.map((c) => c.id), ['mort']);

  // Planning a sync from the moved rows: the asset gets `value`, the loan a positive `balance` on the debt.
  const balances = { z: 500000, mort: -320000, chk: 1200 };
  const { rows } = M.planSync(plan.mappings, balances);
  const updates = rows.map((r) => ({ plId: r.mapping.plId, balance: r.amountCents / 100 }));
  assert.deepEqual(M.planV5Writes(updates, accounts), [
    { plId: 'house', values: { value: 500000 } },
    { plId: 'm1', values: { balance: 320000 } },
    { plId: 'sav', values: { balance: 1200 } },
  ]);
});
