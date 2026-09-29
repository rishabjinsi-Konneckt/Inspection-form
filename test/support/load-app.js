'use strict';
// Loads the app's inline <script> into a Node `vm` context so its functions can be unit
// tested directly, without restructuring the shipped single-file app into modules.
//
// The script is a classic (non-module) browser script. At top level it only ever declares
// constants/functions and computes a few pure values (e.g. `let S = freshState()`) — the
// ONE exception is a bare `boot();` call at the very end, which reaches for a real
// document/localStorage/history this harness does not attempt to fully replicate. That
// call is stripped before the script runs; everything it would have wired up (rendering
// the initial screen, the hardware-back-button guard, etc.) is UI wiring, not logic, and is
// exactly what this harness is NOT trying to test — see TEST_PLAN.md for how that's
// verified instead. This is checked by test/support/load-app.test.js on every run: if a
// future edit adds a second top-level side-effecting call, that test fails loudly rather
// than this silently testing stale/incomplete state.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_PATH = path.join(__dirname, '..', '..', 'F-QA-12_Inspection_Form.html');

function extractInlineScript(html) {
  const matches = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one inline <script> in ${HTML_PATH}, found ${matches.length}`);
  }
  return matches[0][1];
}

function makeLocalStorageStub() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
    get length() { return store.size; }
  };
}

// Loads a FRESH copy of the app for each call — cheap (the script is ~200KB of source,
// parses in low single-digit milliseconds) and avoids any risk of state leaking between
// tests that each want their own clean `S`.
function loadApp() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const rawScript = extractInlineScript(html);

  const bootCallPattern = /^\s*boot\(\);\s*$/m;
  if (!bootCallPattern.test(rawScript)) {
    throw new Error('Expected a top-level `boot();` call to strip — the app script may have changed shape; update load-app.js');
  }
  // Replaced (not just deleted) with a bridge that exposes the script's top-level `let S`
  // binding to the outside world. This MUST be part of the same source string / same
  // vm.runInContext call as `let S = ...` — a separate later runInContext call in the same
  // context is not guaranteed to share that top-level lexical binding, only genuine
  // globalThis properties are reliably visible across calls.
  const script = rawScript.replace(bootCallPattern,
    'globalThis.__getS = function () { return S; };\n' +
    'globalThis.__setS = function (v) { S = v; };\n'
  );

  const sandbox = {
    console,
    localStorage: makeLocalStorageStub(),
    history: { pushState() {}, back() {} },
    document: {
      getElementById() { return null; },
      addEventListener() {},
      createElement() { return { getContext() { return {}; } }; }
    },
    fetch: async () => { throw new Error('fetch() was called inside the unit test sandbox — this function needs an integration test, not a unit test'); },
    XLSX: { utils: {}, writeFile() {} },
    Image: class { },
    FileReader: class { },
    URL: { createObjectURL: () => '', revokeObjectURL: () => { } },
    crypto: globalThis.crypto
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'F-QA-12_Inspection_Form.html (inline script)' });

  // Wrap S access as a normal JS property (`app.S`) instead of making every call site use
  // __getS()/__setS() — matches how tests would naturally want to read/write it.
  Object.defineProperty(sandbox, 'S', {
    get: () => sandbox.__getS(),
    set: (v) => sandbox.__setS(v)
  });

  return sandbox;
}

module.exports = { loadApp, HTML_PATH };
