const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function getAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY || '';
  const key = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;

  if (!email || !key) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY env vars');
  }

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(key)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Token exchange failed: ' + JSON.stringify(data));
  }
  return data.access_token;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Secret, X-Admin-Secret');
}

// Every request must present this shared secret (the frontend attaches it via apiFetch()).
// This is a real, client-visible value — anyone can view-source it, same as any secret
// shipped to a browser — so it does not stop a determined, targeted attacker. It stops the
// zero-effort case: automated scanners and drive-by requests from anyone who never looked
// at this app's code, which is what these endpoints were open to before this existed.
function isAuthorized(req) {
  const expected = process.env.APP_SHARED_SECRET;
  if (!expected) throw new Error('Missing APP_SHARED_SECRET env var');
  const provided = req.headers['x-app-secret'];
  return typeof provided === 'string' && provided === expected;
}

// Structural/destructive modes (grow, createSheet, rename) require this SEPARATE, stronger
// secret in addition to the one above. The frontend never sends it — nothing in the normal
// app flow calls these modes, they're admin-only tools — so knowing the regular app secret
// alone is not enough to restructure the spreadsheet.
function isAdminAuthorized(req) {
  const expected = process.env.ADMIN_SHARED_SECRET;
  if (!expected) throw new Error('Missing ADMIN_SHARED_SECRET env var');
  const provided = req.headers['x-admin-secret'];
  return typeof provided === 'string' && provided === expected;
}

module.exports = { getAccessToken, setCors, base64url, isAuthorized, isAdminAuthorized };
