import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

test('purchase Measurement Protocol event preserves the tagged client and session', async () => {
  const originalFetch = globalThis.fetch;
  let forwarded = null;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /region1\.google-analytics\.com\/mp\/collect/);
    forwarded = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };

  try {
    const env = {
      GA4_MEASUREMENT_ID: 'G-TEST',
      GA4_API_SECRET: { get: async () => 'secret' },
    };
    const request = new Request('https://cro.local/purchase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: 'dbc',
        email: 'buyer@example.com',
        price_amount: 9200,
        currency: 'gbp',
        client_id: '123456789.1753700000',
        session_id: '1753700000',
        token: 'result-token',
      }),
    });

    const response = await worker.fetch(request, env);
    assert.equal(response.status, 200);
    assert.equal(forwarded.client_id, '123456789.1753700000');
    assert.equal(forwarded.events[0].name, 'purchase');
    assert.equal(forwarded.events[0].params.session_id, 1753700000);
    assert.equal(forwarded.events[0].params.transaction_id, 'result-token');
    assert.equal(forwarded.events[0].params.value, 92);
    assert.equal(forwarded.events[0].params.currency, 'GBP');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
