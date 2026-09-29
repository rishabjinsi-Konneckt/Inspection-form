const { getAccessToken, setCors } = require('./_google');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) throw new Error('Missing GOOGLE_SHEET_ID env var');

    const body = req.body || {};
    const mode = ['update', 'meta', 'grow', 'createSheet', 'rename'].includes(body.mode) ? body.mode : 'append';
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

    // ── default (append) / update: write row(s) of values into a range ──
    const rows = Array.isArray(body.rows) ? body.rows : (body.row ? [body.row] : null);
    if (!rows || !Array.isArray(rows) || !rows.length) {
      res.status(400).json({ error: 'Expected { rows: [[...], [...]] } or { row: [...] }' });
      return;
    }

    // Unqualified range -> targets the first sheet/tab regardless of its name. A range
    // that includes a "TabName!" prefix targets that tab instead (see PINs tab usage).
    const range = body.range || 'A:Z';
    let url, fetchOpts;
    if (mode === 'update') {
      url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
      fetchOpts = {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: rows })
      };
    } else {
      url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
      fetchOpts = {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: rows })
      };
    }

    const apiRes = await fetch(url, fetchOpts);
    const apiData = await apiRes.json();
    if (!apiRes.ok) { res.status(apiRes.status).json({ error: apiData }); return; }
    res.status(200).json({ success: true, result: apiData, updates: apiData.updates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
