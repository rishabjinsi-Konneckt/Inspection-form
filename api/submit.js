const { getAccessToken, setCors } = require('./_google');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) throw new Error('Missing GOOGLE_SHEET_ID env var');

    const body = req.body || {};
    const mode = ['update', 'meta', 'grow', 'createSheet', 'rename', 'deleteRows'].includes(body.mode) ? body.mode : 'append';
    const token = await getAccessToken();

    // ── meta: fetch sheet properties (sheetId/title/columnCount) ──
    if (mode === 'meta') {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`;
      const apiRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const apiData = await apiRes.json();
      if (!apiRes.ok) { res.status(apiRes.status).json({ error: apiData }); return; }
      res.status(200).json({ success: true, sheets: apiData.sheets.map(s => s.properties) });
      return;
    }

    // ── grow: expand a sheet's column count (non-destructive — only adds columns) ──
    if (mode === 'grow') {
      const targetSheetId = body.sheetId;
      const addColumns = body.addColumns;
      if (targetSheetId === undefined) throw new Error('grow requires sheetId');
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`;
      const apiRes = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{ appendDimension: { sheetId: targetSheetId, dimension: 'COLUMNS', length: addColumns } }]
        })
      });
      const apiData = await apiRes.json();
      if (!apiRes.ok) { res.status(apiRes.status).json({ error: apiData }); return; }
      res.status(200).json({ success: true, result: apiData });
      return;
    }

    // ── createSheet: add a new tab to the spreadsheet — used to create the "PINs" tab.
    // Non-destructive and idempotent: if a tab with this title already exists, it just
    // reports that back instead of erroring, so the frontend can call it freely without
    // needing to check first. ──
    if (mode === 'createSheet') {
      const title = body.title;
      if (!title) throw new Error('createSheet requires title');
      const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`;
      const metaRes = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
      const metaData = await metaRes.json();
      if (!metaRes.ok) { res.status(metaRes.status).json({ error: metaData }); return; }
      const existing = (metaData.sheets || []).find(s => s.properties && s.properties.title === title);
      if (existing) {
        res.status(200).json({ success: true, alreadyExisted: true, sheetId: existing.properties.sheetId });
        return;
      }
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`;
      const apiRes = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] })
      });
      const apiData = await apiRes.json();
      if (!apiRes.ok) { res.status(apiRes.status).json({ error: apiData }); return; }
      const reply = apiData.replies && apiData.replies[0] && apiData.replies[0].addSheet;
      const newSheetId = reply && reply.properties && reply.properties.sheetId;
      res.status(200).json({ success: true, alreadyExisted: false, sheetId: newSheetId });
      return;
    }

    // ── rename: change an existing tab's title (e.g. fixing a stale/backup tab naming
    // mix-up). Not idempotent the way createSheet is — renaming a tab to a title another
    // tab already holds is a genuine conflict, not a no-op — but that's exactly what the
    // Sheets API itself already rejects on its own (a clean 400, no partial/silent effect),
    // so this deliberately does not duplicate that check client-side. ──
    if (mode === 'rename') {
      const targetSheetId = body.sheetId;
      const title = body.title;
      if (targetSheetId === undefined) throw new Error('rename requires sheetId');
      if (!title) throw new Error('rename requires title');
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`;
      const apiRes = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{ updateSheetProperties: { properties: { sheetId: targetSheetId, title }, fields: 'title' } }]
        })
      });
      const apiData = await apiRes.json();
      if (!apiRes.ok) { res.status(apiRes.status).json({ error: apiData }); return; }
      res.status(200).json({ success: true, result: apiData });
      return;
    }

    // ── deleteRows: remove specific rows from a tab (used ONLY when a closed batch's daily
    // rows are moved out of Sheet1 into the "Closed Batches" tab). Guarded so it can never
    // delete the wrong thing: every row must be sent together with the Batch No. the caller
    // expects to find there, and if even ONE row no longer holds that Batch No. (rows shifted,
    // someone edited the Sheet) nothing is deleted at all. Rows are deleted bottom-up inside a
    // single batchUpdate so earlier deletions can't shift later ones. The header row can
    // never be deleted. ──
    if (mode === 'deleteRows') {
      const items = Array.isArray(body.rows) ? body.rows : [];
      if (!items.length) throw new Error('deleteRows requires rows: [{ row, batchNo }]');
      if (items.length > 200) throw new Error('deleteRows: too many rows in one request');
      for (const it of items) {
        if (!it || !Number.isInteger(it.row) || it.row < 2 || !it.batchNo) throw new Error('deleteRows: each item needs row (>=2) and batchNo');
      }
      const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`;
      const metaRes = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
      const metaData = await metaRes.json();
      if (!metaRes.ok) { res.status(metaRes.status).json({ error: metaData }); return; }
      const sheets = (metaData.sheets || []).map(s => s.properties);
      const target = body.tab ? sheets.find(p => p.title === body.tab) : sheets.slice().sort((a, b) => a.index - b.index)[0];
      if (!target) throw new Error('deleteRows: tab not found');
      const q = "'" + target.title.replace(/'/g, "''") + "'";
      const hdrRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(q + '!A1:CZ1')}`, { headers: { Authorization: `Bearer ${token}` } });
      const hdrData = await hdrRes.json();
      if (!hdrRes.ok) { res.status(hdrRes.status).json({ error: hdrData }); return; }
      const hdrs = (hdrData.values && hdrData.values[0]) || [];
      const bi = hdrs.indexOf('Batch No.');
      if (bi < 0) throw new Error('deleteRows: Batch No. column not found');
      let col = ''; { let n = bi + 1; while (n > 0) { const r = (n - 1) % 26; col = String.fromCharCode(65 + r) + col; n = Math.floor((n - 1) / 26); } }
      const ranges = items.map(it => `ranges=${encodeURIComponent(`${q}!${col}${it.row}`)}`).join('&');
      const chkRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?${ranges}`, { headers: { Authorization: `Bearer ${token}` } });
      const chkData = await chkRes.json();
      if (!chkRes.ok) { res.status(chkRes.status).json({ error: chkData }); return; }
      const found = (chkData.valueRanges || []).map(vr => (vr.values && vr.values[0] && vr.values[0][0]) || '');
      const bad = items.filter((it, i) => String(found[i]) !== String(it.batchNo));
      if (bad.length) { res.status(409).json({ error: 'Rows changed since they were read — nothing was deleted.', mismatched: bad.map(b => b.row) }); return; }
      const requests = items.map(it => it.row).sort((a, b) => b - a).map(r => ({
        deleteDimension: { range: { sheetId: target.sheetId, dimension: 'ROWS', startIndex: r - 1, endIndex: r } }
      }));
      const delRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests })
      });
      const delData = await delRes.json();
      if (!delRes.ok) { res.status(delRes.status).json({ error: delData }); return; }
      res.status(200).json({ success: true, deleted: items.length });
      return;
    }

    // ── default (append) / update: write row(s) of values into a range ──
    const rows = Array.isArray(body.rows) ? body.rows : (body.row ? [body.row] : null);
    if (!rows || !Array.isArray(rows) || !rows.length) {
      res.status(400).json({ error: 'Expected { rows: [[...], [...]] } or { row: [...] }' });
      return;
    }

    // Unqualified range -> targets the first sheet/tab regardless of its name. A range
    // that includes a "TabName!" prefix targets that tab instead (see PINs tab usage).
    const range = body.range || 'A:Z';
    let url, fetchOpts, appendedRange = null;
    if (mode === 'update') {
      url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
      fetchOpts = {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: rows })
      };
    } else {
      // ── append: write the new row(s) at an EXPLICIT row, always starting in column A. ──
      // Google's own :append guesses where "the table" is, and once a stray cell exists outside
      // it (e.g. a lone "Last Saved At" cell below the data) it starts the row in the wrong
      // column — that shifted whole shifts 22 columns to the right. Finding the first empty
      // row in column A ourselves avoids that guessing completely.
      const authH = { Authorization: `Bearer ${token}` };
      const bang = range.indexOf('!');
      let tab = bang > 0 ? range.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'") : null;
      const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`, { headers: authH });
      const metaData = await metaRes.json();
      if (!metaRes.ok) { res.status(metaRes.status).json({ error: metaData }); return; }
      const props = metaData.sheets.map(x => x.properties);
      const target = tab ? props.find(p => p.title === tab) : props[0];
      if (!target) throw new Error('Tab not found: ' + tab);
      tab = target.title;
      const q = "'" + tab.replace(/'/g, "''") + "'";
      const colRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(q + '!A:A')}`, { headers: authH });
      const colData = await colRes.json();
      if (!colRes.ok) { res.status(colRes.status).json({ error: colData }); return; }
      let used = (colData.values || []).length;
      // A stray "Last Saved At" cell below the data (column CB, Sheet1 only) also counts as used,
      // so a new row never lands on top of it. Ignored on tabs that don't have that column.
      try {
        if ((target.gridProperties.columnCount || 0) >= 80) {
          const cbRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(q + '!CB:CB')}`, { headers: authH });
          if (cbRes.ok) used = Math.max(used, ((await cbRes.json()).values || []).length);
        }
      } catch (e) { /* ignore */ }
      const firstRow = used + 1;
      const lastRow = firstRow + rows.length - 1;
      const need = lastRow - (target.gridProperties.rowCount || 0);
      if (need > 0) {
        const gRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
          method: 'POST', headers: { ...authH, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ appendDimension: { sheetId: target.sheetId, dimension: 'ROWS', length: Math.max(need, 100) } }] })
        });
        if (!gRes.ok) { res.status(gRes.status).json({ error: await gRes.json() }); return; }
      }
      const widest = Math.max(...rows.map(r => r.length), 1);
      const colLetter = (n) => { let t = ''; while (n > 0) { const m = (n - 1) % 26; t = String.fromCharCode(65 + m) + t; n = Math.floor((n - 1) / 26); } return t; };
      const writeRange = `${q}!A${firstRow}:${colLetter(widest)}${lastRow}`;
      url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(writeRange)}?valueInputOption=RAW`;
      fetchOpts = {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: rows })
      };
      appendedRange = `${tab}!A${firstRow}:${colLetter(widest)}${lastRow}`;
    }

    const apiRes = await fetch(url, fetchOpts);
    const apiData = await apiRes.json();
    if (!apiRes.ok) { res.status(apiRes.status).json({ error: apiData }); return; }
    // Same reply shape Google's :append used to give ({updates:{updatedRange}}), so callers don't change.
    const updates = appendedRange ? { updatedRange: appendedRange, updatedRows: rows.length } : apiData.updates;
    res.status(200).json({ success: true, result: appendedRange ? { updates } : apiData, updates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
