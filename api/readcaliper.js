const { setCors } = require('./_google');

// Reads the number off a digital caliper's LCD in an uploaded inspection photo, so the app can
// caution the operator when the photo disagrees with the size they selected (or is too blurry
// to read). Advisory only — the app never blocks on this, and treats any failure here as "no
// opinion". Needs ANTHROPIC_API_KEY in the Vercel project's environment variables.
//
// Only photos hosted on Cloudinary are accepted, so this endpoint can't be used to make the
// server fetch arbitrary URLs.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { res.status(503).json({ error: 'Photo reading is not configured' }); return; }

    const imageUrl = String((req.body && req.body.imageUrl) || '');
    if (!/^https:\/\/res\.cloudinary\.com\//.test(imageUrl)) {
      res.status(400).json({ error: 'imageUrl must be a Cloudinary https URL' });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let apiRes, data;
    try {
      apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 120,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: imageUrl } },
              { type: 'text', text:
                'This photo shows a digital caliper measuring a hose. Read the number shown on ' +
                'the caliper\'s LCD, in millimetres. If the digits are blurry, glared, cut off, ' +
                'covered, or the display is not visible, do NOT guess: set readable to false and ' +
                'reading to null. Reply with ONLY a JSON object, no other text: ' +
                '{"readable": true or false, "reading": number or null, "confidence": "high" or "medium" or "low"}' }
            ]
          }]
        })
      });
      data = await apiRes.json();
    } finally {
      clearTimeout(timer);
    }
    if (!apiRes.ok) { res.status(502).json({ error: 'Vision model request failed' }); return; }

    const text = ((data.content || []).find(b => b.type === 'text') || {}).text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { res.status(502).json({ error: 'Unreadable model reply' }); return; }
    const parsed = JSON.parse(m[0]);

    const reading = (typeof parsed.reading === 'number' && isFinite(parsed.reading)) ? parsed.reading : null;
    const readable = parsed.readable === true && reading !== null;
    const confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low';
    res.status(200).json({ readable, reading, confidence });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
