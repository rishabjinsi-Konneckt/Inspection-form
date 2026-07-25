const { getAccessToken, setCors } = require('./_google');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) throw new Error('Missing GOOGLE_SHEET_ID env var');

    const { date, product, search } = req.query || {};

    const token = await getAccessToken();
    const range = 'A1:BZ5000'; // unqualified -> first sheet, generous row + column headroom
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(
      range
    )}`;

    const apiRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const apiData = await apiRes.json();
    if (!apiRes.ok) {
      res.status(apiRes.status).json({ error: apiData });
      return;
    }

    const values = apiData.values || [];
    if (!values.length) {
      res.status(200).json({ headers: [], rows: [] });
      return;
    }

    const headers = values[0];
    const dateIdx = headers.indexOf('Date');
    const productIdx = headers.indexOf('Product');

    let dataRows = values.slice(1);

    if (date && dateIdx !== -1) {
      dataRows = dataRows.filter(r => (r[dateIdx] || '') === date);
    }
    if (product && productIdx !== -1) {
      dataRows = dataRows.filter(r => (r[productIdx] || '') === product);
    }
    if (search) {
      const needle = String(search).toLowerCase();
      dataRows = dataRows.filter(r => r.some(cell => String(cell || '').toLowerCase().includes(needle)));
    }

    // Cap response size for a snappy UI; most recent first
    const rows = dataRows
      .slice(-500)
      .reverse()
      .map(r => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = r[i] || ''; });
        return obj;
      });

    res.status(200).json({ headers, rows, total: dataRows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
