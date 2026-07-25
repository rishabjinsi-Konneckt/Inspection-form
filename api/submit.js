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
    const mode = body.mode === 'update' ? 'update' : 'append';
    const rows = Array.isArray(body) ? body : Array.isArray(body.rows) ? body.rows : [body.row];
    if (!rows || !rows.length || !Array.isArray(rows[0])) {
      res.status(400).json({ error: 'Expected { rows: [[...], [...]] } or { row: [...] }' });
      return;
    }

    const token = await getAccessToken();
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
