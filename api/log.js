const { getAccessToken, setCors } = require('./_google');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) throw new Error('Missing GOOGLE_SHEET_ID env var');

    const { date, product, search, sheet } = req.query;
    const token = await getAccessToken();

    // Unqualified -> first sheet, generous row + column headroom. An optional "sheet"
    // query param qualifies the range with a tab name (e.g. "PINs"), so this same
    // endpoint can also read small side-tables like the PINs tab without disturbing the
    // default behavior every existing caller (Inspection Log, Verify Reports) relies on.
    const range = sheet ? `${sheet}!A1:Z1000` : 'A1:BZ5000';

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
    const apiRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const apiData = await apiRes.json();
    if (!apiRes.ok) { res.status(apiRes.status).json({ error: apiData }); return; }

    const values = apiData.values || [];
    if (!values.length) { res.status(200).json({ headers: [], rows: [], total: 0 }); return; }

    const headers = values[0];
    const dateIdx = headers.indexOf('Date');
    const productIdx = headers.indexOf('Product');

    // Tag each row with its real 1-indexed sheet row number (row 1 = headers, so data
    // row i of values[] sits at sheet row i+1) BEFORE filtering, so __row still points
    // at the correct physical row after date/product/search narrow the list down.
    let dataRows = values.slice(1).map((r, i) => ({ r, __row: i + 2 }));

    if (date && dateIdx !== -1) dataRows = dataRows.filter(({ r }) => r[dateIdx] === date);
    if (product && productIdx !== -1) dataRows = dataRows.filter(({ r }) => r[productIdx] === product);
    if (search) {
      const needle = String(search).toLowerCase();
      dataRows = dataRows.filter(({ r }) => r.some(cell => String(cell).toLowerCase().includes(needle)));
    }

    // Cap response size for a snappy UI; most recent first
    const rows = dataRows.slice(0, 500).reverse().map(({ r, __row }) => {
      const obj = { __row };
      headers.forEach((h, i) => { obj[h] = r[i] || ''; });
      return obj;
    });

    res.status(200).json({ headers, rows, total: dataRows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
