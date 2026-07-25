const { getAccessToken, setCors } = require('./_google');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) throw new Error('Missing GOOGLE_SHEET_ID env var');

    const body = req.body || {};
    const mode = ['update', 'meta', 'grow'].includes(body.mode) ? body.mode : 'append';
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
      const addColumns = body.addColumns || 10;
      if (targetSheetId === undefined) throw new Error('grow requires sheetId');
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`;
      const apiRes = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            appendDimension: { sheetId: targetSheetId, dimension: 'COLUMNS', length: addColumns }
          }]
        })
      });
      const apiData = await apiRes.json();
      if (!apiRes.ok) { res.status(apiRes.status).json({ error: apiData }); return; }
      res.status(200).json({ success: true, mode, result: apiData });
      return;
    }

    const rows = Array.isArray(body) ? body : Array.isArray(body.rows) ? body.rows : [body.row];
    if (!rows || !rows.length || !Array.isArray(rows[0])) {
      res.status(400).json({ error: 'Expected { rows: [[...], [...]] } or { row: [...] }' });
      return;
    }

    // Unqualified range -> targets the first sheet/tab regardless of its name
    const range = body.range || 'A:Z';

    let url, fetchOpts;
    if (mode === 'update') {
      url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(
        range
      )}?valueInputOption=RAW`;
      fetchOpts = {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: rows })
      };
    } else {
      url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(
        range
      )}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
      fetchOpts = {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: rows })
      };
    }

    const apiRes = await fetch(url, fetchOpts);
    const apiData = await apiRes.json();

    if (!apiRes.ok) {
      res.status(apiRes.status).json({ error: apiData });
      return;
    }
    res.status(200).json({ success: true, mode, result: apiData.updates || apiData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
