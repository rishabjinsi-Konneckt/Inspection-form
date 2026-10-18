'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/load-app');
const { toPlain } = require('./support/plain');

describe('freshState — the single source of truth for a blank session', () => {
  const app = loadApp();

  test('starts on the setup screen with no product/batch selected', () => {
    const s = app.freshState();
    assert.equal(s.screen, 'setup');
    assert.equal(s.product, '');
    assert.equal(s.batchBase, '');
  });

  test('roundData has one entry per ROUND_LABELS, each starting empty', () => {
    const s = app.freshState();
    assert.equal(s.roundData.length, 6); // Approval Sample, 10:30 AM, 01:00 PM, 03:00 PM, 06:00 PM, Last Of Shift
    for (const round of s.roundData) {
      assert.deepEqual(toPlain(round.entries), {});
      assert.deepEqual(toPlain(round.braiding), {});
    }
  });

  test('two calls return independently-mutable objects, not shared references', () => {
    // Regression guard: if roundData or procOperators were ever accidentally shared between
    // calls (e.g. a top-level array reused instead of rebuilt), mutating one session's state
    // would corrupt every other session sharing the reference.
    const a = app.freshState();
    const b = app.freshState();
    a.roundData[0].entries.foo = { result: 'PASS' };
    a.procOperators['030'] = 'Alam';
    assert.deepEqual(toPlain(b.roundData[0].entries), {});
    assert.deepEqual(toPlain(b.procOperators), {});
  });

  test('loadState() merges a saved payload onto freshState(), so a payload missing newer fields still yields a complete S', () => {
    app.localStorage.setItem('fqa12_inspection_state_v1', JSON.stringify({ screen: 'process', product: '12ESBB45' }));
    const loaded = app.loadState();
    assert.equal(loaded.screen, 'process');
    assert.equal(loaded.product, '12ESBB45');
    // Fields never present in the old saved payload still exist, filled in from freshState()
    assert.deepEqual(toPlain(loaded.logFilters), { date: '', product: '', search: '' });
    assert.equal(loaded.selectedBatch, '');
  });

  test('loadState() returns null for missing, empty, or corrupt storage rather than throwing', () => {
    app.localStorage.clear();
    assert.equal(app.loadState(), null);
    app.localStorage.setItem('fqa12_inspection_state_v1', 'not valid json{{{');
    assert.equal(app.loadState(), null);
  });
});

describe('hasMeaningfulProgress — decides whether to show the "Resume?" prompt on boot', () => {
  const app = loadApp();

  test('null/missing saved state has no progress', () => {
    assert.equal(app.hasMeaningfulProgress(null), false);
  });
  test('freshly-booted setup screen with no product is not "progress"', () => {
    assert.equal(app.hasMeaningfulProgress({ screen: 'setup', product: '' }), false);
  });
  test('a product picked on setup (before even starting) already counts as progress worth offering to resume', () => {
    assert.equal(app.hasMeaningfulProgress({ screen: 'setup', product: '12ESBB45' }), true);
  });
  test('any screen past setup counts as progress', () => {
    assert.equal(app.hasMeaningfulProgress({ screen: 'process', product: '' }), true);
  });
});

describe('recordedReadingCount — how many readings exist across every round', () => {
  const app = loadApp();

  test('a brand new session has zero', () => {
    app.S = app.freshState();
    assert.equal(app.recordedReadingCount(), 0);
  });

  test('counts entries AND braiding machines, across ALL rounds, not just the current one', () => {
    const s = app.freshState();
    s.roundData[0].entries.a = { result: 'PASS' };
    s.roundData[0].entries.b = { result: 'FAIL' };
    s.roundData[2].braiding['BR-01'] = { result: 'PASS' };
    app.S = s;
    assert.equal(app.recordedReadingCount(), 3);
  });

  test('an entry object with no `result` (e.g. only a photo attached mid-upload) does not count as a recorded reading', () => {
    const s = app.freshState();
    s.roundData[0].entries.a = { photoStatus: 'uploading' }; // no `result` yet
    app.S = s;
    assert.equal(app.recordedReadingCount(), 0);
  });

  test('a malformed/missing roundData does not crash — returns 0', () => {
    app.S = Object.assign(app.freshState(), { roundData: null });
    assert.equal(app.recordedReadingCount(), 0);
  });
});

describe('isCheckDone — whether a single check has been meaningfully answered', () => {
  const app = loadApp();

  function withEntry(entry) {
    const s = app.freshState();
    s.roundData[s.currentRound].entries['030_Hardness'] = entry;
    app.S = s;
  }

  test('no entry at all is not done', () => {
    app.S = app.freshState();
    assert.equal(app.isCheckDone({ key: 'Hardness', type: 'pf' }, '030_Hardness'), false);
  });

  test('NO_RUN counts as done regardless of check type', () => {
    withEntry({ result: 'NO_RUN' });
    assert.equal(app.isCheckDone({ key: 'Hardness', type: 'pf_sub' }, '030_Hardness'), true);
  });

  test('a pf_sub check needs a label (a chosen sub-range), not just any result', () => {
    withEntry({ result: 'PASS' }); // no label
    assert.equal(app.isCheckDone({ key: 'Hardness', type: 'pf_sub' }, '030_Hardness'), false);
    withEntry({ result: 'PASS', label: '11.00-11.09' });
    assert.equal(app.isCheckDone({ key: 'Hardness', type: 'pf_sub' }, '030_Hardness'), true);
  });

  test('a manual check needs a label (typed value)', () => {
    withEntry({ result: 'PASS' }); // no label
    assert.equal(app.isCheckDone({ key: 'Hardness', type: 'manual' }, '030_Hardness'), false);
    withEntry({ result: 'PASS', label: '45' });
    assert.equal(app.isCheckDone({ key: 'Hardness', type: 'manual' }, '030_Hardness'), true);
  });

  test('a pf_manual check is done on FAIL alone (no label needed) OR any label', () => {
    withEntry({ result: 'FAIL' });
    assert.equal(app.isCheckDone({ key: 'Hardness', type: 'pf_manual' }, '030_Hardness'), true);
    withEntry({ result: 'PASS' }); // neither FAIL nor a label
    assert.equal(app.isCheckDone({ key: 'Hardness', type: 'pf_manual' }, '030_Hardness'), false);
  });

  test('a plain pf check just needs any entry to exist', () => {
    withEntry({ result: 'PASS' });
    assert.equal(app.isCheckDone({ key: 'Hardness', type: 'pf' }, '030_Hardness'), true);
  });
});
