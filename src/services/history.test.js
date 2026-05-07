// node --test src/services/history.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryMatrix } from './history.js';

const NUMS = [
  { id: 'sc1', number: '26220', type: 'SC',  country: 'ES', client: 'Acme', purchase_price_per_mo: 0.02, selling_price_per_mo: 0.04, active: true },
  { id: 'sc2', number: '25232', type: 'SC',  country: 'IT', client: 'Other', purchase_price_per_mo: 0.01, selling_price_per_mo: 0.05, active: true },
  { id: 'vl1', number: 'V-001', type: 'VLN', country: 'ES', client: 'Acme', purchase_price_per_mo: 0.005, selling_price_per_mo: 0.015, active: true },
];

test('past month: full month, both sections, totals', () => {
  const vols = [
    { number_id: 'sc1', date: '2026-04-01', volume: 1000 },
    { number_id: 'sc1', date: '2026-04-02', volume: 2000 },
    { number_id: 'sc2', date: '2026-04-01', volume: 500 },
    { number_id: 'vl1', date: '2026-04-15', volume: 10000 },
  ];
  const r = buildHistoryMatrix({
    numbers: NUMS, volumes: vols, month: '2026-04',
    currentDate: '2026-05-07T00:00:00Z',
  });
  assert.equal(r.month, '2026-04');
  assert.equal(r.isCurrent, false);
  assert.equal(r.days.length, 30);
  assert.equal(r.sections.SC.rows.length, 2);
  assert.equal(r.sections.VLN.rows.length, 1);
  assert.equal(r.sections.SC.totals.volume, 3500);
  assert.equal(r.sections.SC.totals.revenue, 80);   // 1000*0.02 + 2000*0.02 + 500*0.04 = 20+40+20 = 80
  assert.equal(r.sections.VLN.totals.volume, 10000);
  assert.equal(r.sections.VLN.totals.revenue, 100); // 10000 * 0.01 = 100
  assert.equal(r.grandTotal.volume, 13500);
  assert.equal(r.grandTotal.revenue, 180);
});

test('current month: truncates to yesterday', () => {
  const vols = [
    { number_id: 'sc1', date: '2026-05-01', volume: 100 },
    { number_id: 'sc1', date: '2026-05-05', volume: 200 },
    { number_id: 'sc1', date: '2026-05-06', volume: 300 }, // yesterday
    { number_id: 'sc1', date: '2026-05-07', volume: 999 }, // today — must be hidden
  ];
  const r = buildHistoryMatrix({
    numbers: NUMS, volumes: vols, month: '2026-05',
    currentDate: '2026-05-07T12:00:00Z',
  });
  assert.equal(r.isCurrent, true);
  assert.equal(r.visibleLastDay, '2026-05-06');
  assert.equal(r.days.length, 6); // May 1..6
  assert.equal(r.sections.SC.totals.volume, 600); // 100+200+300, today excluded
});

test('current month, day 1: empty matrix (no completed days)', () => {
  const vols = [{ number_id: 'sc1', date: '2026-05-01', volume: 100 }];
  const r = buildHistoryMatrix({
    numbers: NUMS, volumes: vols, month: '2026-05',
    currentDate: '2026-05-01T05:00:00Z',
  });
  assert.equal(r.isCurrent, true);
  assert.equal(r.visibleLastDay, null);
  assert.equal(r.days.length, 0);
  assert.equal(r.grandTotal.volume, 0);
});

test('client filter narrows numbers and totals', () => {
  const vols = [
    { number_id: 'sc1', date: '2026-04-01', volume: 1000 }, // Acme
    { number_id: 'sc2', date: '2026-04-01', volume: 5000 }, // Other
  ];
  const r = buildHistoryMatrix({
    numbers: NUMS, volumes: vols, month: '2026-04',
    currentDate: '2026-05-07T00:00:00Z', client: 'Acme',
  });
  assert.equal(r.sections.SC.rows.length, 1); // sc1 only
  assert.equal(r.sections.SC.totals.volume, 1000);
  assert.equal(r.sections.VLN.rows.length, 1); // vl1 also Acme
  assert.equal(r.grandTotal.volume, 1000);
});

test('country filter (case-insensitive) narrows numbers', () => {
  const vols = [
    { number_id: 'sc1', date: '2026-04-01', volume: 1000 }, // ES
    { number_id: 'sc2', date: '2026-04-01', volume: 5000 }, // IT
  ];
  const r = buildHistoryMatrix({
    numbers: NUMS, volumes: vols, month: '2026-04',
    currentDate: '2026-05-07T00:00:00Z', country: 'it',
  });
  assert.equal(r.sections.SC.rows.length, 1);
  assert.equal(r.sections.SC.rows[0].number, '25232');
  assert.equal(r.grandTotal.volume, 5000);
});

test('volumes outside month are ignored', () => {
  const vols = [
    { number_id: 'sc1', date: '2026-03-31', volume: 9999 }, // prior month
    { number_id: 'sc1', date: '2026-04-15', volume: 1000 },
    { number_id: 'sc1', date: '2026-05-01', volume: 9999 }, // next month
  ];
  const r = buildHistoryMatrix({
    numbers: NUMS, volumes: vols, month: '2026-04',
    currentDate: '2026-05-07T00:00:00Z',
  });
  assert.equal(r.sections.SC.totals.volume, 1000);
});

test('empty days produce {volume:0, revenue:0} cells (no nulls)', () => {
  const r = buildHistoryMatrix({
    numbers: [NUMS[0]], volumes: [], month: '2026-04',
    currentDate: '2026-05-07T00:00:00Z',
  });
  assert.equal(r.sections.SC.rows[0].byDay['2026-04-15'].volume, 0);
  assert.equal(r.sections.SC.rows[0].byDay['2026-04-15'].revenue, 0);
});
