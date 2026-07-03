// GA4 Data API client (Measure organ dependency, AGI-9000326).
// Service-account JWT (RS256) -> access token -> runReport.
// Credential = the service-account JSON in Secrets Store (binding GA4_SA / secret cro-engine-ga4-read).

function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(str) { return b64url(new TextEncoder().encode(str)); }

function pemToPkcs8(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const signingInput = b64urlStr(JSON.stringify(header)) + '.' + b64urlStr(JSON.stringify(claim));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(String(sa.private_key).replace(/\\n/g, '\n')),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const jwt = signingInput + '.' + b64url(sig);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
  });
  if (!res.ok) throw new Error('token ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return (await res.json()).access_token;
}

// Returns { eventName: count } over the last `days` days for the property.
export async function eventCounts(sa, propertyId, days) {
  const token = await getAccessToken(sa);
  const res = await fetch(
    'https://analyticsdata.googleapis.com/v1beta/properties/' + propertyId + ':runReport',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: days + 'daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        limit: 250,
      }),
    }
  );
  if (!res.ok) throw new Error('runReport ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  const map = {};
  for (const row of data.rows || []) {
    map[row.dimensionValues[0].value] = Number(row.metricValues[0].value);
  }
  return map;
}
