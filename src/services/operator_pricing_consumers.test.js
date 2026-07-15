// Split SCs must take their money from the split-pricing maps, NOT the flat
// snapshot price. Each fixture gives the split number a deliberately wrong
// snapshot (purchase 0 / selling 1) so any fallback to snapshot math would
// blow the assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryMatrix } from './history.js';
import { buildMonthReport } from './reports.js';
import { buildMonthPnL, buildDashboardCards } from './calc.js';

const PAST = '2026-04';
const NOW = '2026-06-15T00:00:00Z'; // makes April a fully-visible past month

// Exact per-operator result for s1: qty 1000, sales 55.5, cost 47, margin 8.5.
const split = {
  splitIds: new Set(['s1']),
  perDay: new Map([['s1|2026-04-01', { sales: 55.5, cost: 47, margin: 8.5 }]]),
  perMonth: new Map([['s1', { qty: 1000, sales: 55.5, cost: 47, margin: 8.5, slices: [] }]]),
};

const NUMS = [
  // wrong snapshot on purpose — must be ignored for the split number
  { id: 's1', number: 'AR - 78887', type: 'SC', country: 'AR', client: 'Google', purchase_price_per_mo: 0, selling_price_per_mo: 1, active: true },
  { id: 's2', number: 'ZA - 33009', type: 'SC', country: 'ZA', client: 'Google', purchase_price_per_mo: 0.02, selling_price_per_mo: 0.03, active: true },
];
const VOLS = [
  { number_id: 's1', date: '2026-04-01', volume: 1000 },
  { number_id: 's2', date: '2026-04-01', volume: 1000 }, // normal: rev 1000*0.01 = 10
];

test('history: split SC revenue comes from perDay/perMonth, not snapshot', () => {
  const r = buildHistoryMatrix({ numbers: NUMS, volumes: VOLS, month: PAST, currentDate: NOW, split });
  const s1 = r.sections.SC.rows.find((x) => x.id === 's1');
  assert.equal(s1.totals.volume, 1000);
  assert.equal(s1.totals.revenue, 8.5);                 // NOT 1000*1 = 1000
  assert.equal(s1.byDay['2026-04-01'].revenue, 8.5);
  // normal number untouched
  const s2 = r.sections.SC.rows.find((x) => x.id === 's2');
  assert.equal(s2.totals.revenue, 10);
  // section total = 8.5 + 10
  assert.equal(r.sections.SC.totals.revenue, 18.5);
});

test('reports: split SC sales/cost/margin from perMonth', () => {
  const r = buildMonthReport({ numbers: NUMS, volumes: VOLS, fees: [], month: PAST, split });
  const s1 = r.perNumber.rows.find((x) => x.number === 'AR - 78887');
  assert.equal(s1.revenue, 8.5);
  const cost1 = r.costs.rows.find((x) => x.number === 'AR - 78887');
  assert.equal(cost1.cost, 47);
  assert.equal(cost1.total_cost, 47); // no fees
  const billing = r.clientBilling.groups.find((g) => g.client === 'Google');
  const sale1 = billing.rows.find((x) => x.number === 'AR - 78887');
  assert.equal(sale1.sales, 55.5);
});

test('P&L: split SC margin added once, volume still counted', () => {
  const r = buildMonthPnL({ numbers: NUMS, volumes: VOLS, fees: [], month: PAST, split });
  // s1 margin 8.5 (exact) + s2 1000*0.01 = 10  → 18.5
  assert.equal(r.revenue, 18.5);
  assert.equal(r.totalVolume, 2000);
});

test('dashboard cards: split SC revenue is operator-resolved, not flat margin', () => {
  const r = buildDashboardCards({ numbers: NUMS, volumes: VOLS, date: '2026-04-01', split });
  // Day = MTD here (single day). s1 from perDay margin 8.5 (NOT 1000*1=1000),
  // s2 normal 1000*0.01 = 10 → 18.5. Volume still counts rollup (2000).
  assert.equal(r.day.revenue, 18.5);
  assert.equal(r.day.volume, 2000);
  assert.equal(r.mtd.revenue, 18.5);
  assert.equal(r.mtd.volume, 2000);
});

test('dashboard cards: MTD sums days up to the picked date only', () => {
  const vols = [
    { number_id: 's2', date: '2026-04-01', volume: 1000 }, // rev 10
    { number_id: 's2', date: '2026-04-02', volume: 500 },  // rev 5  (after picked date)
  ];
  const r = buildDashboardCards({ numbers: NUMS, volumes: vols, date: '2026-04-01', split });
  assert.equal(r.day.revenue, 10);
  assert.equal(r.mtd.revenue, 10);  // 2026-04-02 excluded
  assert.equal(r.mtd.volume, 1000);
});

test('dashboard cards: without split, falls back to flat margin', () => {
  const r = buildDashboardCards({ numbers: NUMS, volumes: VOLS, date: '2026-04-01' });
  // s1 flat 1000*(1-0)=1000 + s2 1000*0.01=10 → 1010 (pre-operator behavior)
  assert.equal(r.day.revenue, 1010);
});

test('dashboard cards: byClient groups both split and flat numbers together', () => {
  const r = buildDashboardCards({ numbers: NUMS, volumes: VOLS, date: '2026-04-01', split });
  // Both s1 (split) and s2 (flat) are client 'Google'.
  assert.equal(r.byClient.length, 1);
  const g = r.byClient[0];
  assert.equal(g.client, 'Google');
  assert.equal(g.volume, 2000);
  assert.equal(g.sales, 55.5 + 1000 * 0.03); // s1 split sales + s2 flat sales
  assert.equal(g.revenue, 18.5); // s1 margin 8.5 + s2 margin 10
});

test('dashboard cards: numbers with no client land in "(no client)" bucket', () => {
  const nums = [{ id: 'x1', client: null, purchase_price_per_mo: 0.01, selling_price_per_mo: 0.02, active: true }];
  const vols = [{ number_id: 'x1', date: '2026-04-01', volume: 100 }];
  const r = buildDashboardCards({ numbers: nums, volumes: vols, date: '2026-04-01' });
  assert.equal(r.byClient.length, 1);
  assert.equal(r.byClient[0].client, '(no client)');
  assert.equal(r.byClient[0].sales, 2); // 100 * 0.02
});
