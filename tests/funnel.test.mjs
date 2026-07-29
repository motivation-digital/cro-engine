import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRange, paymentStages } from '../src/funnel.js';

test('maps payment truth into separate funnel outcomes', () => {
  const stages = paymentStages({
    attempts: 17,
    distinct_people: 14,
    attempts_7d: 2,
    attempts_30d: 15,
    distinct_people_7d: 2,
    distinct_people_30d: 13,
    incomplete_attempts: 12,
    incomplete_people: 10,
    incomplete_7d: 1,
    incomplete_30d: 11,
    incomplete_people_7d: 1,
    incomplete_people_30d: 9,
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
    operator_tests_7d: 0,
    operator_tests_30d: 2,
    existing_customers: 1,
    existing_customers_7d: 0,
    existing_customers_30d: 1,
    off_funnel: 0,
    off_funnel_7d: 0,
    off_funnel_30d: 0,
  }, { total: 4, d7: 1, d30: 3 }, '30');

  assert.equal(stages.checkout_starts.incomplete_attempts, 12);
  assert.equal(stages.buyers.total, 1);
  assert.equal(stages.buyers.revenue_gbp, 92);
  assert.equal(stages.checkout_starts.selected.distinct_people, 13);
  assert.equal(stages.buyers.selected.total, 1);
  assert.equal(stages.refunds.total, 1);
  assert.equal(stages.refunds.amount_gbp, 63);
  assert.deepEqual(stages.payment_exclusions.selected, {
    operator_tests: 2,
    existing_customers: 1,
    off_funnel: 0,
    test_mode_succeeded: 3,
  });
});

test('normalizes funnel periods to 7, 30 or all', () => {
  assert.equal(normalizeRange('7'), '7');
  assert.equal(normalizeRange('30'), '30');
  assert.equal(normalizeRange('all'), 'all');
  assert.equal(normalizeRange('90'), '30');
});
