import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoFromMsisdn, callingCodeOf, commonSuffixLen } from './calling_codes.js';

test('isoFromMsisdn: longest-prefix wins across code lengths', () => {
  assert.equal(isoFromMsisdn('2781160001034053'), 'ZA'); // 27
  assert.equal(isoFromMsisdn('201206346636'), 'EG');      // 20
  assert.equal(isoFromMsisdn('56228796547'), 'CL');       // 56
  assert.equal(isoFromMsisdn('923452076618'), 'PK');      // 92
  assert.equal(isoFromMsisdn('8615850650596'), 'CN');     // 86
  assert.equal(isoFromMsisdn('96599619449'), 'KW');       // 965 (3-digit)
  assert.equal(isoFromMsisdn('+27840034053'), 'ZA');      // strips '+'
  assert.equal(isoFromMsisdn('Facebook'), null);
  assert.equal(isoFromMsisdn(''), null);
});

test('callingCodeOf returns the matched leading code', () => {
  assert.equal(callingCodeOf('2781160001034053'), '27');
  assert.equal(callingCodeOf('96599619449'), '965');
  assert.equal(callingCodeOf('Facebook'), null);
});

test('commonSuffixLen: shared trailing subscriber digits', () => {
  // supplier vs master form share '034053' (6)
  assert.equal(commonSuffixLen('2781160001034053', '27840034053'), 6);
  assert.equal(commonSuffixLen('2781160001036000', '27840036000'), 6);
  assert.equal(commonSuffixLen('111222', '999222'), 3);
  assert.equal(commonSuffixLen('123', '456'), 0);
});
