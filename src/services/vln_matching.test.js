// VLN suggestion (MO importer) + catalog analysis (Sync Prices) — pure logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVlnSuggestions } from './momessages_import.js';
import { analyzeVln } from './prices_import.js';

// Catalog as Sync Prices would have stored it (master VLN form + parent).
const CATALOG = [
  { country: 'ZA', raw_value: '27840034053', client: 'Google', parent_number_id: 'za-google', buy: 0.007, sell: 0.0077 },
  { country: 'ZA', raw_value: '27840085632', client: 'Acme',   parent_number_id: 'za-acme',   buy: 0.008, sell: 0.009 },
  { country: 'EG', raw_value: '201553194880', client: 'Google', parent_number_id: 'eg-google', buy: 0.016, sell: 0.018 },
];
const NUMBYID = new Map([['za-google', 'ZA - LVNs'], ['za-acme', 'ZA - LVNs (Acme)'], ['eg-google', 'EG - LVNs']]);

test('suggestion: reported number maps to parent by country + shared suffix', () => {
  // supplier form 2781160001034053 shares suffix 034053 with master 27840034053
  const { suggestedVlnMatches, vlnConflicts, unknownReceivers } = buildVlnSuggestions(
    [{ receiver: '2781160001034053', totalMessages: 2679, days: 28 }], CATALOG, NUMBYID);
  assert.equal(vlnConflicts.length, 0);
  assert.equal(unknownReceivers.length, 0);
  assert.equal(suggestedVlnMatches.length, 1);
  const s = suggestedVlnMatches[0];
  assert.equal(s.candidate.parent_number_id, 'za-google');
  assert.equal(s.candidate.parent_number, 'ZA - LVNs');
  assert.equal(s.candidate.client, 'Google');
  assert.equal(s.countryPrefix, '27');
  assert.equal(s.matchedSuffix, 6);
});

test('suggestion: suffix matching >1 client is a conflict, not auto-picked', () => {
  // 2799990085632 shares suffix 085632 with za-acme but the SAME last-6 (085632)
  // exists only for Acme here; craft a true collision instead:
  const catalog = [
    { country: 'ZA', raw_value: '27840034053', client: 'Google', parent_number_id: 'za-google', buy: 0.007, sell: 0.0077 },
    { country: 'ZA', raw_value: '27999034053', client: 'Acme',   parent_number_id: 'za-acme',   buy: 0.008, sell: 0.009 },
  ];
  const { suggestedVlnMatches, vlnConflicts } = buildVlnSuggestions(
    [{ receiver: '2781160001034053', totalMessages: 10, days: 1 }], catalog, NUMBYID);
  assert.equal(suggestedVlnMatches.length, 0);
  assert.equal(vlnConflicts.length, 1);
  assert.equal(vlnConflicts[0].candidates.length, 2);
});

test('suggestion: no catalog candidate stays unknown', () => {
  const { suggestedVlnMatches, unknownReceivers } = buildVlnSuggestions(
    [{ receiver: '56228796547', totalMessages: 218, days: 18 }], CATALOG, NUMBYID); // Chile, not in catalog
  assert.equal(suggestedVlnMatches.length, 0);
  assert.equal(unknownReceivers.length, 1);
  assert.equal(unknownReceivers[0].receiver, '56228796547');
});

test('suggestion: short shared suffix (<6) does not match', () => {
  const { suggestedVlnMatches, unknownReceivers } = buildVlnSuggestions(
    [{ receiver: '2700000000053', totalMessages: 5, days: 1 }], CATALOG, NUMBYID); // shares only '053'
  assert.equal(suggestedVlnMatches.length, 0);
  assert.equal(unknownReceivers.length, 1);
});

test('analyzeVln: reuses an existing single unclaimed parent and claims its client', () => {
  const vlnRows = [
    { raw: '27840034053', suffix: '034053', iso: 'ZA', client: 'Google', buy: 0.007, sell: 0.0077 },
  ];
  const nums = [{ id: 'za-lvns', number: 'ZA - LVNs', client: null }];
  const out = analyzeVln(vlnRows, nums, []);
  assert.equal(out.parents.length, 1);
  assert.equal(out.parents[0].existingId, 'za-lvns');
  assert.equal(out.parents[0].claimClient, true);
  assert.equal(out.catalogNew.length, 1);
  assert.equal(out.catalogNew[0].parentKey, out.parents[0].key);
});

test('analyzeVln: a second client in same country plans a new parent', () => {
  const vlnRows = [
    { raw: '27840034053', suffix: '034053', iso: 'ZA', client: 'Google', buy: 0.007, sell: 0.0077 },
    { raw: '27840085632', suffix: '085632', iso: 'ZA', client: 'Acme', buy: 0.008, sell: 0.009 },
  ];
  const nums = [{ id: 'za-lvns', number: 'ZA - LVNs', client: 'Google' }];
  const out = analyzeVln(vlnRows, nums, []);
  const acme = out.parents.find((p) => p.client === 'Acme');
  const google = out.parents.find((p) => p.client === 'Google');
  assert.equal(google.existingId, 'za-lvns');           // exact client match reused
  assert.equal(acme.existingId, null);                  // new parent planned
  assert.equal(acme.name, 'ZA - LVNs (Acme)');
});

test('analyzeVln: a VLN with no known country is skipped', () => {
  const out = analyzeVln([{ raw: '999999', suffix: '999999', iso: null, client: 'X', buy: 0.01, sell: 0.02 }], [], []);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.catalogNew.length, 0);
});

test('analyzeVln: an unchanged catalog row is not re-listed', () => {
  const vlnRows = [{ raw: '27840034053', suffix: '034053', iso: 'ZA', client: 'Google', buy: 0.007, sell: 0.0077 }];
  const nums = [{ id: 'za-lvns', number: 'ZA - LVNs', client: 'Google' }];
  const existing = [{ raw_value: '27840034053', client: 'Google', buy: 0.007, sell: 0.0077 }];
  const out = analyzeVln(vlnRows, nums, existing);
  assert.equal(out.catalogNew.length, 0);
  assert.equal(out.catalogUnchanged, 1);
});
