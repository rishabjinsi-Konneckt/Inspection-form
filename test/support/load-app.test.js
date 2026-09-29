'use strict';
// Guards the ASSUMPTION load-app.js relies on: exactly one inline <script>, with exactly
// one top-level side-effecting call (`boot();`). If a future edit changes that shape —
// e.g. adds a second top-level call, or splits the script into multiple tags — the loader
// would silently test stale or incomplete code instead of failing. This test exists so
// that happens loudly instead.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { HTML_PATH } = require('./load-app');

test('the app HTML has exactly one inline <script> with exactly one top-level call', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(inlineScripts.length, 1, 'expected exactly one inline <script> tag');

  const src = inlineScripts[0][1];
  const topLevelCalls = src.split('\n').filter(line => /^[a-zA-Z_$][\w$]*\(.*\);?\s*$/.test(line));
  assert.deepEqual(topLevelCalls.map(l => l.trim()), ['boot();'],
    'expected boot() to be the only top-level side-effecting call — if this changed, update load-app.js\'s stripping logic to match');
});
