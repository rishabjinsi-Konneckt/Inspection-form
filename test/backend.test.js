'use strict';
// Covers the parts of the backend reachable WITHOUT a real network call: method/CORS/env-var
// handling, which every mode (including the destructive grow/createSheet/rename ones) passes
// through before doing anything else. Does NOT cover the actual Google Sheets round-trips —
// those need a mocked-fetch integration test or a real Sheet, out of scope for "unit tests"
// (see TEST_PLAN.md for how the real round-trips are verified instead).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { setCors, base64url } = require(path.join('..', 'api', '_google.js'));

describe('base64url — JWT-safe base64 encoding for the Google service-account auth flow', () => {
  test('produces URL-safe output: no +, /, or = padding', () => {
    // A short binary-ish payload chosen to force both a "+" and a "/" in standard base64.
    const encoded = base64url('\xfb\xff\xfe');
    assert.doesNotMatch(encoded, /[+/=]/);
  });

  test('round-trips a real JSON payload the way the JWT header/claim actually get encoded', () => {
    const payload = JSON.stringify({ alg: 'RS256', typ: 'JWT' });
    const encoded = base64url(payload);
    const decoded = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    assert.equal(decoded, payload);
  });
});

describe('setCors — every API response allows cross-device access', () => {
  test('sets the three CORS headers the frontend relies on', () => {
    const calls = [];
    const res = { setHeader: (k, v) => calls.push([k, v]) };
    setCors(res);
    assert.deepEqual(calls, [
      ['Access-Control-Allow-Origin', '*'],
      ['Access-Control-Allow-Methods', 'GET, POST, OPTIONS'],
      ['Access-Control-Allow-Headers', 'Content-Type']
    ]);
  });
});

// Minimal mock matching the subset of the Vercel/Node response API these handlers use:
// setHeader(), status(code).json(obj), status(code).end(). Records everything so tests can
// assert on exactly what was sent without a real HTTP server.
function mockRes() {
  const calls = { headers: [], statusCode: null, json: undefined, ended: false };
  const res = {
    setHeader: (k, v) => calls.headers.push([k, v]),
    status(code) {
      calls.statusCode = code;
      return {
        json: (obj) => { calls.json = obj; },
        end: () => { calls.ended = true; }
      };
    }
  };
  return { res, calls };
}

describe('api/log.js — request handling before any network call', () => {
  const handler = require(path.join('..', 'api', 'log.js'));
  const savedEnv = process.env.GOOGLE_SHEET_ID;
  test.after(() => { process.env.GOOGLE_SHEET_ID = savedEnv; });

  test('OPTIONS (CORS preflight) returns 200 with no body, without touching GOOGLE_SHEET_ID', async () => {
    delete process.env.GOOGLE_SHEET_ID;
    const { res, calls } = mockRes();
    await handler({ method: 'OPTIONS' }, res);
    assert.equal(calls.statusCode, 200);
    assert.equal(calls.ended, true);
  });

  test('a non-GET method is rejected with 405, not silently accepted', async () => {
    const { res, calls } = mockRes();
    await handler({ method: 'POST', query: {} }, res);
    assert.equal(calls.statusCode, 405);
    assert.deepEqual(calls.json, { error: 'Method not allowed' });
  });

  test('GET with GOOGLE_SHEET_ID unset fails loudly (500 + clear message), not silently', async () => {
    delete process.env.GOOGLE_SHEET_ID;
    const { res, calls } = mockRes();
    await handler({ method: 'GET', query: {} }, res);
    assert.equal(calls.statusCode, 500);
    assert.equal(calls.json.error, 'Missing GOOGLE_SHEET_ID env var');
  });

  test('every response — even an error — carries the no-cache headers (see the incident this was added to prevent)', async () => {
    delete process.env.GOOGLE_SHEET_ID;
    const { res, calls } = mockRes();
    await handler({ method: 'GET', query: {} }, res);
    const cacheControl = calls.headers.find(([k]) => k === 'Cache-Control');
    assert.ok(cacheControl, 'expected a Cache-Control header to be set');
    assert.match(cacheControl[1], /no-store/);
  });
});

describe('api/submit.js — request handling before any network call', () => {
  const handler = require(path.join('..', 'api', 'submit.js'));
  const savedEnv = process.env.GOOGLE_SHEET_ID;
  test.after(() => { process.env.GOOGLE_SHEET_ID = savedEnv; });

  test('OPTIONS (CORS preflight) returns 200 with no body', async () => {
    const { res, calls } = mockRes();
    await handler({ method: 'OPTIONS' }, res);
    assert.equal(calls.statusCode, 200);
    assert.equal(calls.ended, true);
  });

  test('a GET request is rejected with 405 — this endpoint is POST-only', async () => {
    const { res, calls } = mockRes();
    await handler({ method: 'GET' }, res);
    assert.equal(calls.statusCode, 405);
    assert.deepEqual(calls.json, { error: 'Method not allowed' });
  });

  test('POST with GOOGLE_SHEET_ID unset fails loudly (500 + clear message) — reached before any mode-specific logic or network call', async () => {
    delete process.env.GOOGLE_SHEET_ID;
    const { res, calls } = mockRes();
    await handler({ method: 'POST', body: { mode: 'grow', sheetId: 0, addColumns: 10 } }, res);
    assert.equal(calls.statusCode, 500);
    assert.equal(calls.json.error, 'Missing GOOGLE_SHEET_ID env var');
  });
});
