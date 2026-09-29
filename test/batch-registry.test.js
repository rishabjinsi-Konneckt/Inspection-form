'use strict';
// Covers the batch-registry logic that drives "Continue Existing Batch": merging local
// (per-device) and Sheet-derived (cross-device) knowledge of a batch's progress. This is
// exactly the logic behind two real bugs found and fixed earlier in this app's life —
// verifiedThru silently not showing up on cards, and a search filter that could hide its
// own search box — so it's covered thoroughly here, not just at the happy path.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/load-app');
const { toPlain } = require('./support/plain');

describe('sheetRoundSummary — collapse one round\'s (possibly multi-day) Sheet rows', () => {
  const app = loadApp();

  test('empty/missing input returns null, not a crash', () => {
    assert.equal(app.sheetRoundSummary(null), null);
    assert.equal(app.sheetRoundSummary([]), null);
  });

  test('takes values from the LAST row (most recent), not the first', () => {
    const rows = [
      { Date: '2026-09-10', __row: 10, 'Verified Thru Process': '060', 'Finalised At': '10 Sep' },
      { Date: '2026-09-12', __row: 12, 'Verified Thru Process': '130', 'Finalised At': '' }
    ];
    const summary = app.sheetRoundSummary(rows);
    assert.equal(summary.lastDate, '2026-09-12');
    assert.equal(summary.rowNum, 12);
    assert.equal(summary.verifiedThru, '130');
    // "Finalised At" blank on the LAST day means not complete right now, even though an
    // earlier day's pass WAS finalised — a round finalised on an earlier day doesn't stay
    // locked forever, per the app's own documented behavior.
    assert.equal(summary.complete, false);
  });

  test('missing "Verified Thru Process" is null, not empty string or undefined', () => {
    const summary = app.sheetRoundSummary([{ Date: '2026-09-10', __row: 5, 'Finalised At': '' }]);
    assert.equal(summary.verifiedThru, null);
  });
});

describe('buildSheetBatchRegistry — aggregate raw Sheet rows into a per-batch registry', () => {
  const app = loadApp();

  test('groups rows by batch base, splitting rounds by Shift / Sample', () => {
    const reg = app.buildSheetBatchRegistry([
      { 'Batch No.': '20269051-12ESBB45', Date: '2026-09-15', 'Shift / Sample': 'Approval Sample', Product: '12ESBB45', __row: 5 },
      { 'Batch No.': '20269051-12ESBB45', Date: '2026-09-15', 'Shift / Sample': '10:30 AM', Product: '12ESBB45', __row: 6 }
    ]);
    assert.ok(reg['20269051-12ESBB45']);
    assert.equal(Object.keys(reg['20269051-12ESBB45'].rounds).length, 2);
  });

  test('a row with an unrecognized Shift / Sample label is skipped BEFORE its batch entry is even created', () => {
    // Real behavior, not an assumption: roundIdx < 0 returns early in the forEach, before
    // `reg[base]` is ever assigned — so if this is the batch's ONLY row, the whole batch
    // silently never appears in the registry, not even with zero rounds. A corrupted or
    // renamed "Shift / Sample" cell in the Sheet would make a batch invisible to "Continue
    // Existing Batch" with no error anywhere. Worth knowing, not necessarily worth changing.
    const reg = app.buildSheetBatchRegistry([
      { 'Batch No.': '20269051-12ESBB45', Date: '2026-09-15', 'Shift / Sample': 'Not A Real Shift', Product: '12ESBB45', __row: 5 }
    ]);
    assert.equal(reg['20269051-12ESBB45'], undefined);
  });

  test('rows with no Batch No. are skipped entirely', () => {
    const reg = app.buildSheetBatchRegistry([
      { 'Batch No.': '', Date: '2026-09-15', 'Shift / Sample': 'Approval Sample', Product: '12ESBB45', __row: 5 }
    ]);
    assert.deepEqual(toPlain(reg), {});
  });

  test('lastDay/lastDate/product track the row with the HIGHEST day number, not the last row processed', () => {
    const reg = app.buildSheetBatchRegistry([
      { 'Batch No.': '20269051-12ESBB45-3', Date: '2026-09-17', 'Shift / Sample': 'Approval Sample', Product: '12ESBB45', __row: 8 },
      { 'Batch No.': '20269051-12ESBB45-1', Date: '2026-09-15', 'Shift / Sample': '10:30 AM', Product: '12ESBB45', __row: 6 }
    ]);
    const entry = reg['20269051-12ESBB45'];
    assert.equal(entry.lastDay, 3);
    assert.equal(entry.lastDate, '2026-09-17');
  });

  test('lastSavedAt is the true MAXIMUM across every row/round of the batch, not just the row tied to lastDay', () => {
    // Regression test for the exact scenario verified by hand while shipping this field:
    // the round-2 row saved EARLIER in calendar time than the round-0 row's later save, so
    // picking "whichever row has the highest day number"'s timestamp would be wrong here.
    const earliest = new Date(2026, 8, 11, 10, 0, 0).toISOString();
    const middle = new Date(2026, 8, 12, 11, 0, 0).toISOString();
    const latest = new Date(2026, 8, 12, 16, 45, 0).toISOString();
    const reg = app.buildSheetBatchRegistry([
      { 'Batch No.': '20269021-13ESBB60', Date: '2026-09-11', 'Shift / Sample': 'Approval Sample', __row: 11, 'Last Saved At': earliest },
      { 'Batch No.': '20269021-13ESBB60', Date: '2026-09-12', 'Shift / Sample': 'Approval Sample', __row: 12, 'Last Saved At': latest },
      { 'Batch No.': '20269021-13ESBB60', Date: '2026-09-12', 'Shift / Sample': '01:00 PM', __row: 13, 'Last Saved At': middle }
    ]);
    assert.equal(reg['20269021-13ESBB60'].lastSavedAt, latest);
  });

  test('a completely missing "Last Saved At" (pre-Block-C historical rows) does not crash and leaves lastSavedAt empty', () => {
    const reg = app.buildSheetBatchRegistry([
      { 'Batch No.': '20268003-14ESBB45', Date: '2026-08-30', 'Shift / Sample': 'Approval Sample', __row: 2 }
    ]);
    assert.equal(reg['20268003-14ESBB45'].lastSavedAt, '');
  });

  test('rounds are sorted oldest -> newest by Date within a round (multi-day rounds)', () => {
    const reg = app.buildSheetBatchRegistry([
      { 'Batch No.': '20269021-13ESBB60', Date: '2026-09-12', 'Shift / Sample': 'Approval Sample', __row: 12 },
      { 'Batch No.': '20269021-13ESBB60', Date: '2026-09-11', 'Shift / Sample': 'Approval Sample', __row: 11 }
    ]);
    const round0 = reg['20269021-13ESBB60'].rounds[0];
    assert.deepEqual(toPlain(round0.map(r => r.Date)), ['2026-09-11', '2026-09-12']);
  });
});

describe('mergedBatchRegistry — combine local (per-device) + Sheet (cross-device) knowledge', () => {
  test('before the Sheet has ever loaded (sheetBatchReg === null), falls back to LOCAL-only registry', () => {
    const app = loadApp();
    app.localStorage.setItem('fqa12_batch_registry_v1', JSON.stringify({
      '20269051-12ESBB45': { product: '12ESBB45', lastDay: 1, lastDate: '2026-09-15', rounds: { 0: { resumeIdx: 2, complete: false } } }
    }));
    app.S = Object.assign(app.freshState(), { sheetBatchReg: null });
    const merged = app.mergedBatchRegistry();
    assert.ok(merged['20269051-12ESBB45']);
  });

  test('once the Sheet is known (sheetBatchReg !== null), it is authoritative on WHICH batches exist — a local-only batch the Sheet no longer has disappears', () => {
    const app = loadApp();
    app.localStorage.setItem('fqa12_batch_registry_v1', JSON.stringify({
      'LOCAL-ONLY-BATCH': { product: '12ESBB45', lastDay: 1, lastDate: '2026-09-15', rounds: {} }
    }));
    app.S = Object.assign(app.freshState(), { sheetBatchReg: {} }); // Sheet has loaded and knows of nothing
    const merged = app.mergedBatchRegistry();
    assert.equal(merged['LOCAL-ONLY-BATCH'], undefined);
  });

  test('verifiedThru comes ONLY from the Sheet side, never the local registry, even if present there', () => {
    const app = loadApp();
    app.localStorage.setItem('fqa12_batch_registry_v1', JSON.stringify({
      B: { product: 'X', lastDay: 1, lastDate: '2026-09-15', rounds: { 0: { resumeIdx: 1, verifiedThru: '999', complete: false } } }
    }));
    app.S = Object.assign(app.freshState(), { sheetBatchReg: { B: { product: 'X', lastDay: 1, lastDate: '2026-09-15', rounds: {} } } });
    const merged = app.mergedBatchRegistry();
    // Sheet has no round-0 data at all for B, so verifiedThru must be null, NOT "999" —
    // proving the local value was never consulted for this field.
    assert.equal(merged.B.rounds[0].verifiedThru, null);
  });

  test('resumeIdx/dayStartIdx come ONLY from the local registry — the Sheet never tracks a resume point', () => {
    const app = loadApp();
    app.localStorage.setItem('fqa12_batch_registry_v1', JSON.stringify({
      B: { product: 'X', lastDay: 1, lastDate: '2026-09-15', rounds: { 0: { resumeIdx: 4, dayStartIdx: 2, complete: false } } }
    }));
    app.S = Object.assign(app.freshState(), {
      sheetBatchReg: { B: { product: 'X', lastDay: 1, lastDate: '2026-09-15', rounds: { 0: [{ Date: '2026-09-15', __row: 5 }] } } }
    });
    const merged = app.mergedBatchRegistry();
    assert.equal(merged.B.rounds[0].resumeIdx, 4);
    assert.equal(merged.B.rounds[0].dayStartIdx, 2);
  });

  test('lastDay is the MAX of the local and Sheet values, not one or the other unconditionally', () => {
    const app = loadApp();
    app.localStorage.setItem('fqa12_batch_registry_v1', JSON.stringify({
      B: { product: 'X', lastDay: 5, lastDate: '2026-09-15', rounds: {} }
    }));
    app.S = Object.assign(app.freshState(), {
      sheetBatchReg: { B: { product: 'X', lastDay: 2, lastDate: '2026-09-10', rounds: {} } }
    });
    const merged = app.mergedBatchRegistry();
    assert.equal(merged.B.lastDay, 5);
  });

  test('a round known only locally (never synced) still appears, with knownLocally: true and no Sheet data', () => {
    const app = loadApp();
    app.localStorage.setItem('fqa12_batch_registry_v1', JSON.stringify({
      B: { product: 'X', lastDay: 1, lastDate: '2026-09-15', rounds: { 1: { resumeIdx: 0, complete: false } } }
    }));
    app.S = Object.assign(app.freshState(), { sheetBatchReg: { B: { product: 'X', lastDay: 1, lastDate: '2026-09-15', rounds: {} } } });
    const merged = app.mergedBatchRegistry();
    assert.equal(merged.B.rounds[1].knownLocally, true);
    assert.equal(merged.B.rounds[1].sheetRows, null);
  });
});
