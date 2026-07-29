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

async function getAccessToken(sa, scope = 'https://www.googleapis.com/auth/analytics.readonly') {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope,
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

async function adminRequest(sa, path, options = {}, scope = 'https://www.googleapis.com/auth/analytics.readonly') {
  const token = await getAccessToken(sa, scope);
  const res = await fetch('https://analyticsadmin.googleapis.com/v1alpha/' + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error('analyticsAdmin ' + res.status + ' ' + text.slice(0, 300));
  return data;
}

export async function measurementConfig(sa, propertyId) {
  const [keyData, linkData] = await Promise.all([
    adminRequest(sa, 'properties/' + propertyId + '/keyEvents?pageSize=200'),
    adminRequest(sa, 'properties/' + propertyId + '/googleAdsLinks?pageSize=200'),
  ]);
  return {
    propertyId: String(propertyId),
    keyEvents: (keyData.keyEvents || []).map((k) => ({
      name: k.name,
      eventName: k.eventName,
      countingMethod: k.countingMethod,
      defaultValue: k.defaultValue || null,
    })),
    googleAdsLinks: (linkData.googleAdsLinks || []).map((l) => ({
      name: l.name,
      customerId: l.customerId,
      adsPersonalizationEnabled: l.adsPersonalizationEnabled,
    })),
  };
}

export async function ensureKeyEvent(sa, propertyId, eventName) {
  const before = await measurementConfig(sa, propertyId);
  const existing = before.keyEvents.find((k) => k.eventName === eventName);
  if (existing) return { created: false, keyEvent: existing, config: before };

  const created = await adminRequest(
    sa,
    'properties/' + propertyId + '/keyEvents',
    {
      method: 'POST',
      body: JSON.stringify({
        eventName,
        countingMethod: 'ONCE_PER_SESSION',
      }),
    },
    'https://www.googleapis.com/auth/analytics.edit'
  );
  return { created: true, keyEvent: created, config: await measurementConfig(sa, propertyId) };
}

// Returns { eventName: count } for 7 days, 30 days, or all available GA4 history.
export async function eventCounts(sa, propertyId, days) {
  const startDate = days === 'all' ? '2020-01-01' : days + 'daysAgo';
  const token = await getAccessToken(sa);
  const res = await fetch(
    'https://analyticsdata.googleapis.com/v1beta/properties/' + propertyId + ':runReport',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate: 'today' }],
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
