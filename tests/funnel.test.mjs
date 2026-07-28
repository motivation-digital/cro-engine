import assert from 'node:assert/strict';
import test from 'node:test';
import { paymentStages } from '../src/funnel.js';

test('maps payment truth into separate funnel outcomes', () => {
  const stages = paymentStages({
    attempts: 17,
    distinct_people: 14,
    attempts_7d: 2,
    attempts_30d: 15,
    incomplete_attempts: 12,
    incomplete_people: 10,
    incomplete_7d: 1,
    incomplete_30d: 11,
    buyers: 1,
    buyers_7d: 0,
    buyers_30d: 1,
    buyer_gross_gbp_pence: 9200,
    buyer_net_gbp_pence: 9200,
    buyer_net_7d_gbp_pence: 0,
    buyer_net_30d_gbp_pence: 9200,
    refunds: 1,
    refunds_7d: 1,
    refunds_30d: 1,
    refunded_gbp_pence: 6300,
    refunded_7d_gbp_pence: 6300,
    refunded_30d_gbp_pence: 6300,
    operator_tests: 2,
    existing_customers: 1,
    off_funnel: 0,
  }, { total: 4 });

  assert.equal(stages.checkout_starts.incomplete_attempts, 12);
  assert.equal(stages.buyers.total, 1);
  assert.equal(stages.buyers.revenue_gbp, 92);
  assert.equal(stages.refunds.total, 1);
  assert.equal(stages.refunds.amount_gbp, 63);
  assert.deepEqual(stages.payment_exclusions, {
    operator_tests: 2,
    existing_customers: 1,
    off_funnel: 0,
    total: 3,
    test_mode_succeeded: 4,
    note: 'successful payments retained in the ledger but excluded from new funnel buyers',
    _error: undefined,
  });
});
