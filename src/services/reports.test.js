// node --test src/services/reports.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthReport } from './reports.js';

const NUMS = [
  { id: 'n1', number: '26220', type: 'SC',  country: 'ES', client: 'Acme',  purchase_price_per_mo: 0.02, selling_price_per_mo: 0.04 },
  { id: 'n2', number: '25232', type: 'SC',  country: 'IT', client: 'Acme',  purchase_price_per_mo: 0.01, selling_price_per_mo: 0.05 },
  { id: 'n3', number: 'V-001', type: 'VLN', country: 'ES', client: 'Other', purchase_price_per_mo: 0.005, selling_price_per_mo: 0.015 },
  { id: 'n4', number: 'X-999', type: 'SC',  country: 'FR', client: null,    purchase_price_per_mo: 0.02, selling_price_per_mo: 0.03 },
];
const VOLS = [
  { number_id: 'n1', date: '2026-04-10', volume: 1000 },
  { number_id: 'n2', date: '2026-04-15', volume: 2000 },
  { number_id: 'n3', date: '2026-04-20', volume: 5000 },
  { number_id: 'n1', date: '2026-03-15', volume: 9999 }, // out of month
  { number_id: 'n1', date: '2026-05-01', volume: 9999 }, // out of month
];
const FEES = [
  { number_id: 'n1', type: 'monthly', side: 'cost', amount: 50, effective_from: '2026-01-01', effective_to: null },
  { number_id: 'n2', type: 'monthly', side: 'cost', amount: 30, effective_from: '2026-04-01', effective_to: null },
  { number_id: 'n1', type: 'monthly', side: 'sale', amount: 80, effective_from: '2026-01-01', effective_to: null },
  { number_id: 'n1', type: 'setup',   side: 'cost', amount: 200, effective_from: '2026-04-05' },
  { number_id: 'n2', type: 'setup',   side: 'sale', amount: 500, effective_from: '2026-04-15' },
  { number_id: 'n1', type: 'setup',   side: 'cost', amount: 999, effective_from: '2026-03-15' }, // wrong month
];

test('summary headline matches calc.js P&L', () => {
  const r = buildMonthReport({ numbers: NUMS, volumes: VOLS, fees: FEES, month: '2026-04' });
  // n1: 1000 * 0.02 = 20; n2: 2000 * 0.04 = 80; n3: 5000 * 0.01 = 50; total revenue = 150
  assert.equal(r.summary.headline.total_volume, 8000);
  assert.equal(r.summary.headline.total_revenue, 150);
  assert.equal(r.summary.headline.total_cost_fees, 280); // monthly 80 + setup 200
  assert.equal(r.summary.headline.net, -130);
});

test('summary debit lines: cost_monthly before cost_setup, sorted by number', () => {
  const r = buildMonthReport({ numbers: NUMS, volumes: VOLS, fees: FEES, month: '2026-04' });
  const lines = r.summary.debit.lines;
  // 2 cost_monthly (n1=50, n2=30) + 1 cost_setup (n1=200, March one excluded)
  assert.equal(lines.length, 3);
  assert.equal(lines[0].kind, 'cost_monthly');
  assert.equal(lines[1].kind, 'cost_monthly');
  assert.equal(lines[2].kind, 'cost_setup');
  assert.equal(r.summary.debit.monthly_total, 80);
  assert.equal(r.summary.debit.setup_total, 200);
  assert.equal(r.summary.debit.total, 280);
});

test('Tab 2 perNumber: SC before VLN, then by number, with totals', () => {
  const r = buildMonthReport({ numbers: NUMS, volumes: VOLS, fees: FEES, month: '2026-04' });
  const rows = r.perNumber.rows;
  assert.deepEqual(rows.map((x) => x.number), ['25232', '26220', 'X-999', 'V-001']);
  assert.equal(r.perNumber.totals.volume, 8000);
  assert.equal(r.perNumber.totals.revenue, 150);
  // n4 (X-999) had no volume, so revenue = 0 — still appears in the table.
  const x999 = rows.find((x) => x.number === 'X-999');
  assert.equal(x999.volume, 0);
  assert.equal(x999.revenue, 0);
});

test('Tab 3 costs: per-row total = vol*purchase + monthly + setup', () => {
  const r = buildMonthReport({ numbers: NUMS, volumes: VOLS, fees: FEES, month: '2026-04' });
  const n1 = r.costs.rows.find((x) => x.number === '26220');
  // n1: vol 1000, purchase 0.02 → cost 20; monthly 50; setup 200 → total 270
  assert.equal(n1.cost, 20);
  assert.equal(n1.monthly_fee, 50);
  assert.equal(n1.setup_fee, 200);
  assert.equal(n1.total_cost, 270);
  // n1: 1000*0.02=20, n2: 2000*0.01=20, n3: 5000*0.005=25, n4: 0 -> 65
  assert.equal(r.costs.totals.cost, 65);
  assert.equal(r.costs.totals.monthly_fee, 80);
  assert.equal(r.costs.totals.setup_fee, 200);
  assert.equal(r.costs.totals.total_cost, 65 + 80 + 200);
});

test('Tab 4 client billing: groups by client, no-client bucket, grand totals', () => {
  const r = buildMonthReport({ numbers: NUMS, volumes: VOLS, fees: FEES, month: '2026-04' });
  const clients = r.clientBilling.groups.map((g) => g.client);
  assert.deepEqual(clients, ['(no client)', 'Acme', 'Other']);

  // Acme: n1 (1000 * 0.04 = 40 sales) + n2 (2000 * 0.05 = 100 sales) = 140
  //   + n1 monthly sale 80 + n2 setup sale 500 = 720 total
  const acme = r.clientBilling.groups.find((g) => g.client === 'Acme');
  assert.equal(acme.subtotal.volume, 3000);
  assert.equal(acme.subtotal.sales, 140);
  assert.equal(acme.subtotal.monthly_fee, 80);
  assert.equal(acme.subtotal.setup_fee, 500);
  assert.equal(acme.subtotal.total, 720);

  const other = r.clientBilling.groups.find((g) => g.client === 'Other');
  assert.equal(other.subtotal.volume, 5000);
  assert.equal(other.subtotal.sales, 75); // 5000 * 0.015

  const noClient = r.clientBilling.groups.find((g) => g.client === '(no client)');
  assert.equal(noClient.rows.length, 1); // X-999
  assert.equal(noClient.subtotal.total, 0);

  assert.equal(r.clientBilling.grandTotal.volume, 8000);
  assert.equal(r.clientBilling.grandTotal.sales, 215); // 140 + 75 + 0
  assert.equal(r.clientBilling.grandTotal.total, 720 + 75 + 0);
});

test('empty inputs return zeros, no NaN', () => {
  const r = buildMonthReport({ numbers: [], volumes: [], fees: [], month: '2026-04' });
  assert.equal(r.summary.headline.total_revenue, 0);
  assert.equal(r.summary.headline.net, 0);
  assert.equal(r.perNumber.rows.length, 0);
  assert.equal(r.costs.rows.length, 0);
  assert.equal(r.clientBilling.groups.length, 0);
});
