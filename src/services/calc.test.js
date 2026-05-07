// Run with: node --test src/services/calc.test.js
//
// Covers SPEC §3: margin, dayRow, fee resolution at month edges, and
// the P&L roll-up. Edge cases that bit us once and we never want
// silently regressed: float drift on subtraction, fees ending exactly
// on the first/last day of a month, setup fees in a different month.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  margin,
  dayRow,
  monthBounds,
  activeMonthlyFees,
  yearlyFeesInMonth,
  setupFeesInMonth,
  sumAmount,
  buildMonthPnL,
} from './calc.js';

test('margin handles float drift (0.04 - 0.02)', () => {
  // Naive 0.04 - 0.02 in JS gives 0.020000000000000004.
  assert.equal(margin(0.02, 0.04), 0.02);
});

test('margin treats missing values as 0', () => {
  assert.equal(margin(undefined, 0.05), 0.05);
  assert.equal(margin(0.01, null), -0.01);
});

test('dayRow returns canonical shape', () => {
  const r = dayRow({ volume: 1000, purchase_price: 0.02, selling_price: 0.04 });
  assert.deepEqual(r, { volume: 1000, margin: 0.02, revenue: 20, cost: 20, sales: 40 });
});

test('dayRow: zero volume is zero everything', () => {
  const r = dayRow({ volume: 0, purchase_price: 0.02, selling_price: 0.04 });
  assert.deepEqual(r, { volume: 0, margin: 0.02, revenue: 0, cost: 0, sales: 0 });
});

test('monthBounds handles 30/31-day months and Feb', () => {
  assert.deepEqual(monthBounds('2026-04'), { month: '2026-04', firstDay: '2026-04-01', lastDay: '2026-04-30' });
  assert.deepEqual(monthBounds('2026-01'), { month: '2026-01', firstDay: '2026-01-01', lastDay: '2026-01-31' });
  assert.deepEqual(monthBounds('2024-02'), { month: '2024-02', firstDay: '2024-02-01', lastDay: '2024-02-29' }); // leap
  assert.deepEqual(monthBounds('2025-02'), { month: '2025-02', firstDay: '2025-02-01', lastDay: '2025-02-28' }); // non-leap
});

test('monthBounds accepts a YYYY-MM-DD by trimming', () => {
  assert.equal(monthBounds('2026-04-15').month, '2026-04');
});

test('monthBounds rejects garbage', () => {
  assert.throws(() => monthBounds('2026/04'));
  assert.throws(() => monthBounds(''));
});

test('activeMonthlyFees: open-ended fee starting in month is active', () => {
  const fees = [{ type: 'monthly', side: 'cost', amount: 50, effective_from: '2026-04-01', effective_to: null }];
  assert.equal(activeMonthlyFees(fees, 'cost', '2026-04').length, 1);
});

test('activeMonthlyFees: closed fee ending on first day still counts', () => {
  // SPEC: effective_to >= first_day(M) means the fee is active in M
  // (the day it ends is still billed).
  const fees = [{ type: 'monthly', side: 'cost', amount: 50, effective_from: '2026-01-01', effective_to: '2026-04-01' }];
  assert.equal(activeMonthlyFees(fees, 'cost', '2026-04').length, 1);
});

test('activeMonthlyFees: fee that ended last month is excluded', () => {
  const fees = [{ type: 'monthly', side: 'cost', amount: 50, effective_from: '2026-01-01', effective_to: '2026-03-31' }];
  assert.equal(activeMonthlyFees(fees, 'cost', '2026-04').length, 0);
});

test('activeMonthlyFees: fee starting next month is excluded', () => {
  const fees = [{ type: 'monthly', side: 'cost', amount: 50, effective_from: '2026-05-01', effective_to: null }];
  assert.equal(activeMonthlyFees(fees, 'cost', '2026-04').length, 0);
});

test('activeMonthlyFees: side filter', () => {
  const fees = [
    { type: 'monthly', side: 'cost', amount: 50, effective_from: '2026-04-01', effective_to: null },
    { type: 'monthly', side: 'sale', amount: 80, effective_from: '2026-04-01', effective_to: null },
  ];
  assert.equal(activeMonthlyFees(fees, 'cost', '2026-04').length, 1);
  assert.equal(activeMonthlyFees(fees, 'sale', '2026-04').length, 1);
});

test('activeMonthlyFees: type filter excludes setup', () => {
  const fees = [{ type: 'setup', side: 'cost', amount: 100, effective_from: '2026-04-15', effective_to: null }];
  assert.equal(activeMonthlyFees(fees, 'cost', '2026-04').length, 0);
});

test('yearlyFeesInMonth: bills in anniversary month only', () => {
  const fees = [
    { type: 'yearly', side: 'cost', amount: 600, effective_from: '2026-01-15', effective_to: null },
  ];
  // January any year on/after 2026 → bills.
  assert.equal(yearlyFeesInMonth(fees, 'cost', '2026-01').length, 1);
  assert.equal(yearlyFeesInMonth(fees, 'cost', '2027-01').length, 1);
  assert.equal(yearlyFeesInMonth(fees, 'cost', '2030-01').length, 1);
  // Other months → no.
  assert.equal(yearlyFeesInMonth(fees, 'cost', '2026-02').length, 0);
  assert.equal(yearlyFeesInMonth(fees, 'cost', '2027-07').length, 0);
});

test('yearlyFeesInMonth: not active before effective_from', () => {
  const fees = [{ type: 'yearly', side: 'cost', amount: 600, effective_from: '2026-06-01', effective_to: null }];
  assert.equal(yearlyFeesInMonth(fees, 'cost', '2025-06').length, 0);
  assert.equal(yearlyFeesInMonth(fees, 'cost', '2026-06').length, 1);
});

test('yearlyFeesInMonth: closed yearly skipped after effective_to', () => {
  const fees = [{ type: 'yearly', side: 'cost', amount: 600, effective_from: '2026-01-15', effective_to: '2027-12-31' }];
  assert.equal(yearlyFeesInMonth(fees, 'cost', '2027-01').length, 1); // last billing year
  assert.equal(yearlyFeesInMonth(fees, 'cost', '2028-01').length, 0); // closed before
});

test('yearlyFeesInMonth: side filter', () => {
  const fees = [
    { type: 'yearly', side: 'cost', amount: 100, effective_from: '2026-03-01' },
    { type: 'yearly', side: 'sale', amount: 200, effective_from: '2026-03-01' },
  ];
  assert.equal(yearlyFeesInMonth(fees, 'cost', '2027-03').length, 1);
  assert.equal(yearlyFeesInMonth(fees, 'sale', '2027-03').length, 1);
});

test('buildMonthPnL: yearly fee shows up only in anniversary month', () => {
  const numbers = [{ id: 'n1', purchase_price_per_mo: 0.02, selling_price_per_mo: 0.04 }];
  const fees = [{ number_id: 'n1', type: 'yearly', side: 'cost', amount: 600, effective_from: '2026-01-15', effective_to: null }];

  const jan = buildMonthPnL({ numbers, volumes: [], fees, month: '2026-01' });
  assert.equal(jan.fees.cost.yearly, 600);
  assert.equal(jan.debit, 600);

  const feb = buildMonthPnL({ numbers, volumes: [], fees, month: '2026-02' });
  assert.equal(feb.fees.cost.yearly, 0);
  assert.equal(feb.debit, 0);

  const jan2027 = buildMonthPnL({ numbers, volumes: [], fees, month: '2027-01' });
  assert.equal(jan2027.fees.cost.yearly, 600);
});

test('setupFeesInMonth: only fees in the exact month', () => {
  const fees = [
    { type: 'setup', side: 'cost', amount: 100, effective_from: '2026-04-01' },
    { type: 'setup', side: 'cost', amount: 200, effective_from: '2026-04-30' },
    { type: 'setup', side: 'cost', amount: 300, effective_from: '2026-03-31' }, // prior month
    { type: 'setup', side: 'cost', amount: 400, effective_from: '2026-05-01' }, // next month
    { type: 'monthly', side: 'cost', amount: 99, effective_from: '2026-04-15' }, // wrong type
  ];
  const got = setupFeesInMonth(fees, 'cost', '2026-04');
  assert.equal(got.length, 2);
  assert.equal(sumAmount(got), 300);
});

test('buildMonthPnL: full SPEC §3 example', () => {
  const numbers = [
    { id: 'n1', purchase_price_per_mo: 0.02, selling_price_per_mo: 0.04 }, // margin 0.02
    { id: 'n2', purchase_price_per_mo: 0.01, selling_price_per_mo: 0.03 }, // margin 0.02
  ];
  const volumes = [
    { number_id: 'n1', date: '2026-04-10', volume: 1000 }, // rev 20
    { number_id: 'n1', date: '2026-04-11', volume: 500 },  // rev 10
    { number_id: 'n2', date: '2026-04-15', volume: 2000 }, // rev 40
    { number_id: 'n1', date: '2026-03-31', volume: 9999 }, // out of month, ignored
    { number_id: 'n1', date: '2026-05-01', volume: 9999 }, // out of month, ignored
  ];
  const fees = [
    { number_id: 'n1', type: 'monthly', side: 'cost', amount: 50, effective_from: '2026-01-01', effective_to: null },
    { number_id: 'n2', type: 'monthly', side: 'cost', amount: 30, effective_from: '2026-04-01', effective_to: null },
    { number_id: 'n1', type: 'monthly', side: 'sale', amount: 80, effective_from: '2026-01-01', effective_to: null },
    { number_id: 'n1', type: 'setup',   side: 'cost', amount: 200, effective_from: '2026-04-05' },
    { number_id: 'n2', type: 'setup',   side: 'sale', amount: 500, effective_from: '2026-04-15' },
    { number_id: 'n1', type: 'setup',   side: 'cost', amount: 999, effective_from: '2026-03-15' }, // wrong month
  ];

  const r = buildMonthPnL({ numbers, volumes, fees, month: '2026-04' });

  assert.equal(r.month, '2026-04');
  assert.equal(r.totalVolume, 3500);
  assert.equal(r.revenue, 70);                  // 20 + 10 + 40
  assert.equal(r.fees.cost.monthly, 80);        // 50 + 30
  assert.equal(r.fees.cost.setup, 200);         // only the April one
  assert.equal(r.fees.cost.total, 280);
  assert.equal(r.fees.sale.monthly, 80);
  assert.equal(r.fees.sale.setup, 500);
  assert.equal(r.fees.sale.total, 580);
  assert.equal(r.credit, 70);
  assert.equal(r.debit, 280);
  assert.equal(r.net, -210);                    // a loss is fine
});

test('buildMonthPnL: empty inputs return zeros, no NaN', () => {
  const r = buildMonthPnL({ numbers: [], volumes: [], fees: [], month: '2026-04' });
  assert.equal(r.totalVolume, 0);
  assert.equal(r.revenue, 0);
  assert.equal(r.credit, 0);
  assert.equal(r.debit, 0);
  assert.equal(r.net, 0);
});

test('buildMonthPnL: volume on a number not in numbers[] is silently skipped', () => {
  // Defensive: if someone deletes a number after volumes were entered.
  const r = buildMonthPnL({
    numbers: [],
    volumes: [{ number_id: 'gone', date: '2026-04-10', volume: 1000 }],
    fees: [],
    month: '2026-04',
  });
  assert.equal(r.revenue, 0);
});
