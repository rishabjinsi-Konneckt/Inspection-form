'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/load-app');
const { toPlain } = require('./support/plain');

describe('colLetter — 1-indexed column number to spreadsheet letters', () => {
  const app = loadApp();
  const cases = [
    [1, 'A'], [26, 'Z'], [27, 'AA'], [52, 'AZ'], [53, 'BA'],
    [75, 'BW'], [76, 'BX'], [79, 'CA'], [80, 'CB'], // the exact boundary the Block A/B/C split depends on
    [104, 'CZ']
  ];
  for (const [n, expected] of cases) {
    test(`colLetter(${n}) === "${expected}"`, () => {
      assert.equal(app.colLetter(n), expected);
    });
  }
});

describe('ddmmyyyy — bare YYYY-MM-DD to DD-MM-YYYY', () => {
  const app = loadApp();

  test('reformats a normal date', () => {
    assert.equal(app.ddmmyyyy('2026-09-15'), '15-09-2026');
  });
  test('handles single-digit day/month unpadded from source (still fixed-width from Sheet)', () => {
    assert.equal(app.ddmmyyyy('2026-01-05'), '05-01-2026');
  });
  test('empty string falls back to em-dash', () => {
    assert.equal(app.ddmmyyyy(''), '—');
  });
  test('null/undefined falls back to em-dash', () => {
    assert.equal(app.ddmmyyyy(null), '—');
    assert.equal(app.ddmmyyyy(undefined), '—');
  });
  test('input with no dashes at all (not 3 parts) is returned as-is, not crashed on', () => {
    assert.equal(app.ddmmyyyy('garbage'), 'garbage');
  });
  test('input with only 2 dash-separated parts is returned as-is', () => {
    assert.equal(app.ddmmyyyy('2026-09'), '2026-09');
  });
  test('KNOWN GAP: any string with exactly 2 dashes is blindly reassembled, even if not a real date', () => {
    // ddmmyyyy() only checks segment COUNT (=== 3), never that the segments are actually
    // numeric/well-formed. In practice this is only ever called with genuine Sheet-sourced
    // YYYY-MM-DD strings, so it's not reachable through the UI today — but it's a real gap,
    // not a hypothetical: 'not-a-date'.split('-') happens to produce exactly 3 parts too.
    assert.equal(app.ddmmyyyy('not-a-date'), 'date-a-not');
  });
});

describe('ddmmyyyyTime — full ISO instant to "DD-MM-YYYY, HH:MM AM/PM" in local time', () => {
  const app = loadApp();

  function atLocal(h, m) {
    return new Date(2026, 8, 15, h, m, 0).toISOString(); // 2026-09-15, local wall-clock time
  }

  test('midnight is 12:00 AM, not 00:00 AM', () => {
    assert.equal(app.ddmmyyyyTime(atLocal(0, 0)), '15-09-2026, 12:00 AM');
  });
  test('one minute past midnight', () => {
    assert.equal(app.ddmmyyyyTime(atLocal(0, 1)), '15-09-2026, 12:01 AM');
  });
  test('11:59 AM stays AM', () => {
    assert.equal(app.ddmmyyyyTime(atLocal(11, 59)), '15-09-2026, 11:59 AM');
  });
  test('noon is 12:00 PM, not 00:00 PM', () => {
    assert.equal(app.ddmmyyyyTime(atLocal(12, 0)), '15-09-2026, 12:00 PM');
  });
  test('one minute past noon', () => {
    assert.equal(app.ddmmyyyyTime(atLocal(12, 1)), '15-09-2026, 12:01 PM');
  });
  test('11:59 PM stays PM, does not roll to 12:59', () => {
    assert.equal(app.ddmmyyyyTime(atLocal(23, 59)), '15-09-2026, 11:59 PM');
  });
  test('empty string returns empty string, not "Invalid Date"', () => {
    assert.equal(app.ddmmyyyyTime(''), '');
  });
  test('null/undefined return empty string', () => {
    assert.equal(app.ddmmyyyyTime(null), '');
    assert.equal(app.ddmmyyyyTime(undefined), '');
  });
  test('garbage input returns empty string, not "Invalid Date"', () => {
    assert.equal(app.ddmmyyyyTime('not-a-real-timestamp'), '');
  });
});

describe('genBatchBase — YYYY + reverse(DDMM) + "-" + productCode', () => {
  const app = loadApp();

  test('matches the documented format exactly', () => {
    // 2026-09-15 -> ddmm "1509" -> reversed "9051"
    assert.equal(app.genBatchBase('2026-09-15', '12ESBB45'), '20269051-12ESBB45');
  });
  test('single-digit day and month, zero-padded by the date input, still reverse correctly', () => {
    // 2026-01-05 -> ddmm "0501" -> reversed "1050"
    assert.equal(app.genBatchBase('2026-01-05', '13ESBB60'), '20261050-13ESBB60');
  });
});

describe('parseBatchNo — split "<base>-<day>" vs a bare base (day 1)', () => {
  const app = loadApp();

  test('a bare base with no day suffix is day 1', () => {
    assert.deepEqual(toPlain(app.parseBatchNo('20269051-12ESBB45')), { base: '20269051-12ESBB45', day: 1 });
  });
  test('a numeric day suffix is parsed out', () => {
    assert.deepEqual(toPlain(app.parseBatchNo('20269051-12ESBB45-3')), { base: '20269051-12ESBB45', day: 3 });
  });
  test('a letter suffix (separate-run marker, not a day) is NOT mistaken for a day', () => {
    // nextBatchSuffix()-style "-A" separate-run marker must stay part of the base, since
    // \d+ only matches digits — this is what keeps 20269051-12ESBB45-A distinct from a
    // continuation day of the plain batch.
    assert.deepEqual(toPlain(app.parseBatchNo('20269051-12ESBB45-A')), { base: '20269051-12ESBB45-A', day: 1 });
  });
  test('empty/whitespace input', () => {
    assert.deepEqual(toPlain(app.parseBatchNo('')), { base: '', day: 1 });
    assert.deepEqual(toPlain(app.parseBatchNo('   ')), { base: '', day: 1 });
  });
});

describe('nextBatchSuffix — next unused letter for a separate same-day run', () => {
  const app = loadApp();

  test('first collision gets "A"', () => {
    assert.equal(app.nextBatchSuffix('BASE', {}), 'A');
  });
  test('skips letters already taken', () => {
    assert.equal(app.nextBatchSuffix('BASE', { 'BASE-A': {}, 'BASE-B': {} }), 'C');
  });
  test('returns null once all 26 letters are exhausted, rather than looping forever or crashing', () => {
    const registry = {};
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') registry[`BASE-${letter}`] = {};
    assert.equal(app.nextBatchSuffix('BASE', registry), null);
  });
});
