// E.164 country calling code → ISO-3166 alpha-2, used to bucket a VLN MSISDN
// by its leading digits (a VLN's country is determined by its dial prefix).
// Shared by the Sync Prices VLN ingestion (parent country) and the MO Messages
// importer (suggesting a parent for an unknown receiver). Extend as new
// countries appear — mirrors the explicit-map approach of MCC_TO_ISO2.
//
// Codes are variable length (1–3 digits); resolution is longest-prefix-wins.
export const CALLING_CODE_TO_ISO = new Map(Object.entries({
  // 3-digit
  '212': 'MA', '213': 'DZ', '216': 'TN', '218': 'LY', '220': 'GM', '221': 'SN',
  '233': 'GH', '234': 'NG', '243': 'CD', '250': 'RW', '254': 'KE', '255': 'TZ',
  '356': 'MT',
  '260': 'ZM', '263': 'ZW', '265': 'MW', '266': 'LS', '267': 'BW', '268': 'SZ',
  '291': 'ER', '353': 'IE', '380': 'UA', '420': 'CZ', '421': 'SK', '598': 'UY',
  '855': 'KH', '880': 'BD', '960': 'MV', '961': 'LB', '962': 'JO', '963': 'SY',
  '964': 'IQ', '965': 'KW', '966': 'SA', '967': 'YE', '968': 'OM', '970': 'PS',
  '971': 'AE', '972': 'IL', '973': 'BH', '974': 'QA', '975': 'BT', '976': 'MN',
  '977': 'NP', '992': 'TJ', '993': 'TM', '994': 'AZ', '995': 'GE', '998': 'UZ',
  // 2-digit
  '20': 'EG', '27': 'ZA', '30': 'GR', '31': 'NL', '34': 'ES', '36': 'HU',
  '39': 'IT', '40': 'RO', '41': 'CH', '44': 'GB', '49': 'DE', '51': 'PE',
  '52': 'MX', '54': 'AR', '55': 'BR', '56': 'CL', '57': 'CO', '58': 'VE',
  '60': 'MY', '62': 'ID', '63': 'PH', '64': 'NZ', '65': 'SG', '66': 'TH',
  '81': 'JP', '82': 'KR', '84': 'VN', '86': 'CN', '90': 'TR', '91': 'IN',
  '92': 'PK', '93': 'AF', '94': 'LK', '95': 'MM', '98': 'IR',
  // 1-digit
  '1': 'US', '7': 'RU',
}));

// ISO-2 for an MSISDN's leading calling code (longest match: try 3, then 2,
// then 1 digit). Returns null if no known code matches. Strips a leading '+'.
export function isoFromMsisdn(msisdn) {
  const d = String(msisdn ?? '').replace(/[^\d]/g, '');
  if (!d) return null;
  for (const len of [3, 2, 1]) {
    const iso = CALLING_CODE_TO_ISO.get(d.slice(0, len));
    if (iso) return iso;
  }
  return null;
}

// The calling code itself (the matched leading digits), or null.
export function callingCodeOf(msisdn) {
  const d = String(msisdn ?? '').replace(/[^\d]/g, '');
  for (const len of [3, 2, 1]) {
    if (CALLING_CODE_TO_ISO.has(d.slice(0, len))) return d.slice(0, len);
  }
  return null;
}

// Longest common trailing digit-run between two numbers (their digit strings).
// This is the "full suffix after the (differing) prefix" the supplier and the
// master share — e.g. 2781160001034053 vs 27840034053 → '034053' (6).
export function commonSuffixLen(a, b) {
  const x = String(a ?? '').replace(/[^\d]/g, '');
  const y = String(b ?? '').replace(/[^\d]/g, '');
  let i = 0;
  while (i < x.length && i < y.length && x[x.length - 1 - i] === y[y.length - 1 - i]) i++;
  return i;
}
