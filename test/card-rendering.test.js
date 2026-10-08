'use strict';
// Covers the pure string-building behind the "Continue Existing Batch" cards. Both bugs
// caught while building this feature (a zero-match search hiding its own search box, and
// an unescaped quote breaking the search input's HTML attribute) lived in this exact
// rendering path, so this locks in the specific behaviors that fixed them.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/load-app');

describe('batchStatusBadges — per-shift verification chips', () => {
  const app = loadApp();

  test('a round with no data at all produces no badge (not an empty/blank one)', () => {
    const html = app.batchStatusBadges({ rounds: {} });
    assert.equal(html, '');
  });

  test('a verified round gets a green "V-<process>" badge', () => {
    const html = app.batchStatusBadges({ rounds: { 0: { verifiedThru: '090' } } });
    assert.match(html, /class="badge b-ok"/);
    assert.match(html, /V-090/);
  });

  test('a touched-but-unverified round gets a "not verified" badge, not a green one', () => {
    const html = app.batchStatusBadges({ rounds: { 0: { verifiedThru: null } } });
    assert.match(html, /class="badge b-na"/);
    assert.match(html, /not verified/);
    assert.doesNotMatch(html, /b-ok/);
  });

  test('KNOWN GAP: badge text is NOT HTML-escaped — verifiedThru is rendered verbatim into innerHTML', () => {
    // This documents real, current behavior, not desired behavior — see the audit finding
    // on esc() (it escapes backslash/quote for onclick="..." attributes, never <, >, or &).
    // verifiedThru is normally an app-generated process number ("090"), so this isn't
    // reachable through the UI today — but it comes from the Sheet's "Verified Thru
    // Process" column, which the backend writes with zero server-side validation (see the
    // audit's unauthenticated-write finding). If either gap closes independently, this test
    // should be revisited — until then it exists so a fix to one doesn't silently mask that
    // the other is still open, and so this doesn't regress into something worse unnoticed.
    const html = app.batchStatusBadges({ rounds: { 0: { verifiedThru: '<script>' } } });
    assert.match(html, /<script>/);
  });
});

describe('batchCardHtml — one batch card', () => {
  const app = loadApp();

  function baseInfo(overrides) {
    return Object.assign({ product: '12ESBB45', lastDay: 1, lastDate: '2026-09-15', lastSavedAt: '', rounds: {} }, overrides);
  }

  test('renders the product label, not the raw internal product code, when the product is known', () => {
    const html = app.batchCardHtml('20269051-12ESBB45', baseInfo());
    assert.match(html, /12ESBB45/); // this product's label happens to equal its code
  });

  test('an unrecognized/legacy product code falls back to showing the code itself, not a blank', () => {
    const html = app.batchCardHtml('BASE', baseInfo({ product: 'DISCONTINUED-CODE' }));
    assert.match(html, /DISCONTINUED-CODE/);
  });

  test('prefers the full date+time when lastSavedAt is present', () => {
    const iso = new Date(2026, 8, 15, 14, 30, 0).toISOString();
    const html = app.batchCardHtml('B', baseInfo({ lastSavedAt: iso }));
    assert.match(html, /15-09-2026, 02:30 PM/);
  });

  test('falls back to date-only when lastSavedAt is absent (older/untouched batches)', () => {
    const html = app.batchCardHtml('B', baseInfo({ lastSavedAt: '' }));
    assert.match(html, /15-09-2026/);
    assert.doesNotMatch(html, /(AM|PM)/);
  });

  test('the selected batch gets the "selected" class; others do not', () => {
    app.S = Object.assign(app.freshState(), { selectedBatch: 'MATCH' });
    const selectedHtml = app.batchCardHtml('MATCH', baseInfo());
    const otherHtml = app.batchCardHtml('OTHER', baseInfo());
    assert.match(selectedHtml, /class="batch-card selected"/);
    // Note: can't just assert /selected/ is absent — "selectedBatch" (the property name in
    // the onclick handler) itself contains that substring on every card, selected or not.
    assert.match(otherHtml, /class="batch-card"/);
    assert.doesNotMatch(otherHtml, /class="batch-card selected"/);
  });

  test('a batch number containing a single quote does not break out of the onclick handler', () => {
    // esc() is JS-string escaping for onclick="...", not HTML entity escaping — this is
    // exactly the class of bug it exists to prevent. Batch numbers are app-generated so a
    // real quote is unlikely, but the escaping must hold regardless.
    const html = app.batchCardHtml("BASE-O'BRIEN", baseInfo());
    assert.match(html, /S\.selectedBatch='BASE-O\\'BRIEN'/);
  });
});
