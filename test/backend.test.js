'use strict';
// Covers the parts of the backend reachable WITHOUT a real network call: auth/method/CORS/
// env-var handling, which every mode (including the destructive grow/createSheet/rename
// ones) passes through before doing anything else. Does NOT cover the actual Google Sheets
// round-trips — those need a mocked-fetch integration test or a real Sheet, out of scope
// for "unit tests" (see TEST_PLAN.md for how the real round-trips are verified instead).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { setCors, base64url, isAuthorized, isAdminAuthorized } = require(path.join('..', 'api', '_google.js'));

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
  test('sets the CORS headers the frontend relies on, including the auth headers apiFetch() sends', () => {
    const calls = [];
    const res = { setHeader: (k, v) => calls.push([k, v]) };
    setCors(res);
    assert.deepEqual(calls, [
      ['Access-Control-Allow-Origin', '*'],
      ['Access-Control-Allow-Methods', 'GET, POST, OPTIONS'],
      ['Access-Control-Allow-Headers', 'Content-Type, X-App-Secret, X-Admin-Secret']
    ]);
  });
});

describe('isAuthorized — the shared secret every request must present', () => {
  const savedEnv = process.env.APP_SHARED_SECRET;
  test.after(() => { process.env.APP_SHARED_SECRET = savedEnv; });

  test('throws (a misconfiguration, not a caller error) if the env var itself is unset', () => {
    delete process.env.APP_SHARED_SECRET;
    assert.throws(() => isAuthorized({ headers: {} }), /Missing APP_SHARED_SECRET env var/);
  });

  test('rejects a request with no header at all', () => {
    process.env.APP_SHARED_SECRET = 'correct-secret';
    assert.equal(isAuthorized({ headers: {} }), false);
  });

  test('rejects a request with the wrong secret', () => {
    process.env.APP_SHARED_SECRET = 'correct-secret';
    assert.equal(isAuthorized({ headers: { 'x-app-secret': 'wrong-secret' } }), false);
  });

  test('accepts a request with the exact correct secret', () => {
    process.env.APP_SHARED_SECRET = 'correct-secret';
    assert.equal(isAuthorized({ headers: { 'x-app-secret': 'correct-secret' } }), true);
  });

  test('a non-string header value (e.g. an array, from a duplicated header) is rejected, not coerced', () => {
    process.env.APP_SHARED_SECRET = 'correct-secret';
    assert.equal(isAuthorized({ headers: { 'x-app-secret': ['correct-secret'] } }), false);
  });
});

describe('isAdminAuthorized — the stronger secret structural modes require', () => {
  const savedEnv = process.env.ADMIN_SHARED_SECRET;
  test.after(() => { process.env.ADMIN_SHARED_SECRET = savedEnv; });

  test('throws if the env var itself is unset', () => {
    delete process.env.ADMIN_SHARED_SECRET;
    assert.throws(() => isAdminAuthorized({ headers: {} }), /Missing ADMIN_SHARED_SECRET env var/);
  });

  test('the regular app secret does NOT satisfy the admin check, even if reused as the value', () => {
    process.env.ADMIN_SHARED_SECRET = 'admin-secret';
    assert.equal(isAdminAuthorized({ headers: { 'x-admin-secret': 'app-secret' } }), false);
  });

  test('accepts a request with the exact correct admin secret', () => {
    process.env.ADMIN_SHARED_SECRET = 'admin-secret';
    assert.equal(isAdminAuthorized({ headers: { 'x-admin-secret': 'admin-secret' } }), true);
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
  const savedSheetId = process.env.GOOGLE_SHEET_ID;
  const savedSecret = process.env.APP_SHARED_SECRET;
  test.after(() => { process.env.GOOGLE_SHEET_ID = savedSheetId; process.env.APP_SHARED_SECRET = savedSecret; });

  test('OPTIONS (CORS preflight) returns 200 with no body, without checking auth or GOOGLE_SHEET_ID', async () => {
    delete process.env.GOOGLE_SHEET_ID;
    delete process.env.APP_SHARED_SECRET;
    const { res, calls } = mockRes();
    await handler({ method: 'OPTIONS' }, res);
    assert.equal(calls.statusCode, 200);
    assert.equal(calls.ended, true);
  });

  test('a non-GET method is rejected with 405 before auth is even checked', async () => {
    delete process.env.APP_SHARED_SECRET;
    const { res, calls } = mockRes();
    await handler({ method: 'POST', query: {} }, res);
    assert.equal(calls.statusCode, 405);
    assert.deepEqual(calls.json, { error: 'Method not allowed' });
  });

  test('a GET request with no auth header is rejected with 401, before ever reaching GOOGLE_SHEET_ID', async () => {
    process.env.APP_SHARED_SECRET = 'correct-secret';
    delete process.env.GOOGLE_SHEET_ID; // would 500 if this were reached — proves 401 comes first
    const { res, calls } = mockRes();
    await handler({ method: 'GET', query: {}, headers: {} }, res);
    assert.equal(calls.statusCode, 401);
    assert.deepEqual(calls.json, { error: 'Unauthorized' });
  });

  test('GET, correctly authorized, with GOOGLE_SHEET_ID unset fails loudly (500 + clear message), not silently', async () => {
    process.env.APP_SHARED_SECRET = 'correct-secret';
    delete process.env.GOOGLE_SHEET_ID;
    const { res, calls } = mockRes();
    await handler({ method: 'GET', query: {}, headers: { 'x-app-secret': 'correct-secret' } }, res);
    assert.equal(calls.statusCode, 500);
    assert.equal(calls.json.error, 'Missing GOOGLE_SHEET_ID env var');
  });

  test('every response — even an error — carries the no-cache headers (see the incident this was added to prevent)', async () => {
    process.env.APP_SHARED_SECRET = 'correct-secret';
    delete process.env.GOOGLE_SHEET_ID;
    const { res, calls } = mockRes();
    await handler({ method: 'GET', query: {}, headers: { 'x-app-secret': 'correct-secret' } }, res);
    const cacheControl = calls.headers.find(([k]) => k === 'Cache-Control');
    assert.ok(cacheControl, 'expected a Cache-Control header to be set');
    assert.match(cacheControl[1], /no-store/);
  });
});

describe('api/submit.js — request handling before any network call', () => {
  const handler = require(path.join('..', 'api', 'submit.js'));
  const savedSheetId = process.env.GOOGLE_SHEET_ID;
  const savedSecret = process.env.APP_SHARED_SECRET;
  const savedAdminSecret = process.env.ADMIN_SHARED_SECRET;
  test.after(() => {
    process.env.GOOGLE_SHEET_ID = savedSheetId;
    process.env.APP_SHARED_SECRET = savedSecret;
    process.env.ADMIN_SHARED_SECRET = savedAdminSecret;
  });

  test('OPTIONS (CORS preflight) returns 200 with no body', async () => {
    const { res, calls } = mockRes();
    await handler({ method: 'OPTIONS' }, res);
    assert.equal(calls.statusCode, 200);
    assert.equal(calls.ended, true);
  });

  test('a GET request is rejected with 405 before auth is checked — this endpoint is POST-only', async () => {
    delete process.env.APP_SHARED_SECRET;
    const { res, calls } = mockRes();
    await handler({ method: 'GET' }, res);
    assert.equal(calls.statusCode, 405);
    assert.deepEqual(calls.json, { error: 'Method not allowed' });
  });

  test('a POST with no auth header is rejected with 401, before ever reaching GOOGLE_SHEET_ID or the mode dispatch', async () => {
    process.env.APP_SHARED_SECRET = 'correct-secret';
    delete process.env.GOOGLE_SHEET_ID;
    const { res, calls } = mockRes();
    await handler({ method: 'POST', body: { mode: 'grow' }, headers: {} }, res);
    assert.equal(calls.statusCode, 401);
    assert.deepEqual(calls.json, { error: 'Unauthorized' });
  });

  test('POST, correctly authorized, with GOOGLE_SHEET_ID unset fails loudly (500 + clear message) — reached before any mode-specific logic or network call', async () => {
    process.env.APP_SHARED_SECRET = 'correct-secret';
    delete process.env.GOOGLE_SHEET_ID;
    const { res, calls } = mockRes();
    await handler({ method: 'POST', body: { mode: 'grow', sheetId: 0, addColumns: 10 }, headers: { 'x-app-secret': 'correct-secret' } }, res);
    assert.equal(calls.statusCode, 500);
    assert.equal(calls.json.error, 'Missing GOOGLE_SHEET_ID env var');
  });

  test('a structural mode (grow) with a valid APP secret but no admin secret is rejected with 403, not allowed through', async () => {
    process.env.APP_SHARED_SECRET = 'correct-secret';
    process.env.ADMIN_SHARED_SECRET = 'admin-secret';
    process.env.GOOGLE_SHEET_ID = 'fake-sheet-id'; // must be set so this reaches the admin check, not an earlier 500
    const { res, calls } = mockRes();
    await handler({ method: 'POST', body: { mode: 'grow', sheetId: 0, addColumns: 10 }, headers: { 'x-app-secret': 'correct-secret' } }, res);
    assert.equal(calls.statusCode, 403);
    assert.deepEqual(calls.json, { error: 'Forbidden — this operation requires admin authorization' });
  });

  test('the default append/update path (what every normal operator save uses) is NOT gated behind the admin secret', async () => {
    process.env.APP_SHARED_SECRET = 'correct-secret';
    process.env.ADMIN_SHARED_SECRET = 'admin-secret';
    delete process.env.GOOGLE_SHEET_ID; // proves this reached the sheetId check, i.e. got PAST the admin gate with no admin header at all
    const { res, calls } = mockRes();
    await handler({ method: 'POST', body: { rows: [['a', 'b']] }, headers: { 'x-app-secret': 'correct-secret' } }, res);
    assert.equal(calls.statusCode, 500);
    assert.equal(calls.json.error, 'Missing GOOGLE_SHEET_ID env var');
  });
});
