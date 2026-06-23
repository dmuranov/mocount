import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mncOf, priceAt, priceOperatorVolumes } from './operator_pricing.js';

test('mncOf splits MCC-MNC', () => {
  assert.equal(mncOf('722-310'), '310');
  assert.equal(mncOf('334-020'), '020');
  assert.equal(mncOf('33402'), '33402'); // no dash → whole
  assert.equal(mncOf(''), '');
});

test('priceAt honors effective windows (inclusive, open-ended)', () => {
  const h = [
    { side: 'selling', price: 0.05, effective_from: '2020-01-01', effective_to: '2026-03-14' },
    { side: 'selling', price: 0.06, effective_from: '2026-03-15', effective_to: null },
  ];
  assert.equal(priceAt(h, 'selling', '2026-03-14'), 0.05);
  assert.equal(priceAt(h, 'selling', '2026-03-15'), 0.06);
  assert.equal(priceAt(h, 'selling', '2099-01-01'), 0.06);
  assert.equal(priceAt(h, 'purchase', '2026-03-15'), null); // no purchase rows
});

const DEFAULT_HIST = [
  { side: 'selling', price: 0.051, effective_from: '2020-01-01', effective_to: null },
  { side: 'purchase', price: 0.047, effective_from: '2020-01-01', effective_to: null },
];
const CLARO = {
  label: 'Claro',
  mncs: ['310', '320', '330'],
  history: [
    { side: 'selling', price: 0.0505, effective_from: '2020-01-01', effective_to: null },
    { side: 'purchase', price: 0.050, effective_from: '2020-01-01', effective_to: null },
  ],
};

test('routes MNC to its group, else default; sums revenue/cost exactly', () => {
  const r = priceOperatorVolumes({
    defaultHistory: DEFAULT_HIST,
    groups: [CLARO],
    opVolumes: [
      { date: '2026-03-01', mcc_mnc: '722-310', volume: 1000 }, // Claro
      { date: '2026-03-01', mcc_mnc: '722-070', volume: 2000 }, // default
    ],
  });
  // Claro: 1000 * 0.0505 = 50.5 ; default: 2000 * 0.051 = 102 → 152.5
  assert.equal(r.totals.qty, 3000);
  assert.equal(round4(r.totals.revenue), 152.5);
  // cost: 1000*0.05 + 2000*0.047 = 50 + 94 = 144
  assert.equal(round4(r.totals.cost), 144);
  // blended sell = 152.5 / 3000
  assert.equal(round4(r.totals.blendedSell), round4(152.5 / 3000));
  // two slices, Claro first by revenue
  assert.equal(r.slices.length, 2);
  assert.equal(r.slices[0].label, 'default'); // 102 > 50.5
  const claro = r.slices.find((s) => s.mcc_mnc === '722-310');
  assert.equal(round4(claro.selling), 0.0505);
  assert.equal(round4(claro.purchase), 0.05);
});

test('same mcc_mnc across days aggregates into one slice', () => {
  const r = priceOperatorVolumes({
    defaultHistory: DEFAULT_HIST,
    groups: [CLARO],
    opVolumes: [
      { date: '2026-03-01', mcc_mnc: '722-310', volume: 500 },
      { date: '2026-03-02', mcc_mnc: '722-310', volume: 500 },
    ],
  });
  assert.equal(r.slices.length, 1);
  assert.equal(r.slices[0].qty, 1000);
  assert.equal(round4(r.slices[0].revenue), 50.5);
});

test('zero / negative volume ignored, no NaN on empty', () => {
  const r = priceOperatorVolumes({ defaultHistory: DEFAULT_HIST, groups: [], opVolumes: [] });
  assert.equal(r.totals.qty, 0);
  assert.equal(r.totals.revenue, 0);
  assert.equal(r.totals.blendedSell, 0);
  assert.equal(r.slices.length, 0);
});

function round4(n) { return Math.round(n * 1e4) / 1e4; }
