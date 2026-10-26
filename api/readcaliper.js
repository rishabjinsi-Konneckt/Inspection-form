const { setCors } = require('./_google');

// Reads the number off a digital caliper's LCD in an uploaded inspection photo, so the app can
// caution the operator when the photo disagrees with the size they selected (or is too blurry
// to read). Advisory only — the app never blocks on this, and treats any failure here as "no
// opinion".
//
// Which AI service answers is decided by which key is set in the Vercel project's environment
// variables (checked in this order):
//   GEMINI_API_KEY     -> Google Gemini (has a free tier). Model: GEMINI_MODEL, default gemini-3.8-flash
//   ANTHROPIC_API_KEY  -> Anthropic Claude (paid).         Model: ANTHROPIC_MODEL, default claude-sonnet-5-5
// With neither set, this returns 503 and the app simply shows no caution.
//
// Only photos hosted on Cloudinary are accepted, so this endpoint can't be used to make the
// server fetch arbitrary URLs.

const PROMPT =
  'This photo shows a digital caliper measuring a hose. Read the number shown on the ' +
  'caliper\'s LCD, in millimetres. If the digits are blurry, glared, cut off, covered, or the ' +
  'display is not visible, do NOT guess: set readable to false and reading to null. Also rate the ' +
  'image_quality of the display digits: "sharp" = every digit crisp with clear edges; "soft" = ' +
  'digits legible but edges fuzzy; "blurry" = digits smeared, doubled or ambiguous. Reply with ' +
  'ONLY a JSON object, no other text: ' +
  '{"readable": true or false, "reading": number or null, "confidence": "high" or "medium" or "low", ' +
  '"image_quality": "sharp" or "soft" or "blurry"}';

// Test-machine / gauge photos (Process 120: Pressure Testing in bar, Fitting Load Test in kgf,
// Air Leakage in bar): read the main number on the display. The unit is only ever one of the
// known ones so nothing from the request is pasted into the prompt unchecked.
const GAUGE_UNITS = ['bar', 'kgf', 'mm'];
function gaugePrompt(unit) {
  return 'This photo shows a testing machine or gauge with a digital display. Read the main number ' +
    'shown on the display. The expected unit is ' + unit + '. If the digits are blurry, glared, cut off, ' +
    'covered, or no display is visible, do NOT guess: set readable to false and reading to null. Also ' +
    'give unit_on_display exactly as printed next to the number (for example "bar", "kgf", "kg", "psi", "N"), ' +
    'or "" if no unit is visible, and rate image_quality of the digits: "sharp" = every digit crisp; ' +
    '"soft" = legible but fuzzy; "blurry" = smeared, doubled or ambiguous. Reply with ONLY a JSON object, ' +
    'no other text: {"readable": true or false, "reading": number or null, "confidence": "high" or ' +
    '"medium" or "low", "unit_on_display": string, "image_quality": "sharp" or "soft" or "blurry"}';
}

async function withTimeout(ms, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fn(controller.signal); } finally { clearTimeout(timer); }
}

async function askGemini(apiKey, imageUrl, prompt) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  // Gemini takes the image bytes inline, so fetch them from Cloudinary first.
  const imgRes = await withTimeout(15000, (signal) => fetch(imageUrl, { signal }));
  if (!imgRes.ok) throw new Error('Could not fetch photo');
  const mime = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const b64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');

  const apiRes = await withTimeout(25000, (signal) => fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: mime, data: b64 } },
          { text: prompt }
        ] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      })
    }
  ));
  const data = await apiRes.json();
  if (!apiRes.ok) throw new Error('Gemini request failed');
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('');
}

async function askAnthropic(apiKey, imageUrl, prompt) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  const apiRes = await withTimeout(25000, (signal) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 120,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'url', url: imageUrl } },
        { type: 'text', text: prompt }
      ] }]
    })
  }));
  const data = await apiRes.json();
  if (!apiRes.ok) throw new Error('Anthropic request failed');
  return ((data.content || []).find(b => b.type === 'text') || {}).text || '';
}

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const geminiKey = process.env.GEMINI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!geminiKey && !anthropicKey) { res.status(503).json({ error: 'Photo reading is not configured' }); return; }

    const imageUrl = String((req.body && req.body.imageUrl) || '');
    if (!/^https:\/\/res\.cloudinary\.com\//.test(imageUrl)) {
      res.status(400).json({ error: 'imageUrl must be a Cloudinary https URL' });
      return;
    }

    const kind = String((req.body && req.body.kind) || 'caliper');
    const unit = String((req.body && req.body.unit) || '');
    const isGauge = kind === 'gauge' && GAUGE_UNITS.includes(unit);
    const prompt = isGauge ? gaugePrompt(unit) : PROMPT;

    let text;
    try {
      text = geminiKey ? await askGemini(geminiKey, imageUrl, prompt) : await askAnthropic(anthropicKey, imageUrl, prompt);
    } catch (e) {
      res.status(502).json({ error: e.message || 'Vision model request failed' });
      return;
    }

    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) { res.status(502).json({ error: 'Unreadable model reply' }); return; }
    const parsed = JSON.parse(m[0]);

    const reading = (typeof parsed.reading === 'number' && isFinite(parsed.reading)) ? parsed.reading : null;
    // Anything short of "sharp" is treated as unreadable so the app cautions "blurry - retake".
    const readable = parsed.readable === true && reading !== null && parsed.image_quality === 'sharp';
    const confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low';
    const out = { readable, reading, confidence, engine: geminiKey ? 'gemini' : 'anthropic' };
    if (isGauge) out.unit_on_display = typeof parsed.unit_on_display === 'string' ? parsed.unit_on_display.slice(0, 12) : '';
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
