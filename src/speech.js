// Turns programme text into something a voice reads the way a person would: numbers, years, episode codes,
// abbreviations, and punctuation that should be a pause rather than a symbol. Pure functions, no I/O.
// Bump SPEECH_VERSION when the rules change so cached recordings are regenerated.
export const SPEECH_VERSION = 2;

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0 to 999,999,999 in words ("one hundred and five"). */
export function numberToWords(n) {
  n = Math.floor(Math.abs(n));
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' and ' + numberToWords(n % 100) : '');
  if (n < 1e6) return numberToWords(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? (n % 1000 < 100 ? ' and ' : ' ') + numberToWords(n % 1000) : '');
  if (n < 1e9) return numberToWords(Math.floor(n / 1e6)) + ' million' + (n % 1e6 ? ' ' + numberToWords(n % 1e6) : '');
  return String(n).split('').map((d) => ONES[Number(d)]).join(' ');
}

/** A year the way it is said: 1999 "nineteen ninety-nine", 1905 "nineteen oh five", 2008 "two thousand and eight", 2012 "twenty twelve". */
export function yearToWords(y) {
  if (y >= 2000 && y < 2010) return y === 2000 ? 'two thousand' : 'two thousand and ' + ONES[y - 2000];
  const hi = Math.floor(y / 100), lo = y % 100;
  if (lo === 0) return numberToWords(hi) + ' hundred';
  if (lo < 10) return numberToWords(hi) + ' oh ' + ONES[lo];
  return numberToWords(hi) + ' ' + numberToWords(lo);
}

const ORD_IRREGULAR = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
export function ordinalToWords(n) {
  const w = numberToWords(n);
  const m = /^(.*?)([a-z]+)$/.exec(w.replace(/-/g, '- '));
  if (!m) return w;
  let last = m[2];
  if (ORD_IRREGULAR[last]) last = ORD_IRREGULAR[last];
  else if (last.endsWith('y')) last = last.slice(0, -1) + 'ieth';
  else last += 'th';
  return (m[1] + last).replace(/- /g, '-');
}

const ROMAN = { II: 'two', III: 'three', IV: 'four', VI: 'six', VII: 'seven', VIII: 'eight', IX: 'nine' };
const TITLES = [[/\bMr\.?(?=\s)/g, 'Mister'], [/\bMrs\.?(?=\s)/g, 'Missus'], [/\bMs\.?(?=\s)/g, 'Miz'], [/\bDr\.?(?=\s)/g, 'Doctor'],
  [/\bProf\.(?=\s)/g, 'Professor'], [/\bCapt\.(?=\s)/g, 'Captain'], [/\bLt\.(?=\s)/g, 'Lieutenant'], [/\bSgt\.(?=\s)/g, 'Sergeant'],
  [/\bGen\.(?=\s)/g, 'General'], [/\bJr\.?(?=[\s,.]|$)/g, 'Junior'], [/\bSr\.?(?=[\s,.]|$)/g, 'Senior'], [/\bSt\.(?=\s+[A-Z])/g, 'Saint'],
  [/\bMt\.(?=\s+[A-Z])/g, 'Mount'], [/\bvs\.?(?=\s)/gi, 'versus'], [/\betc\.(?=\s|$)/gi, 'et cetera'], [/\bapprox\.(?=\s)/gi, 'approximately']];

/** What to say for a piece of programme text. */
export function speakable(input) {
  let s = String(input ?? '');

  s = s.replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[‐‑‒]/g, '-');
  s = s.replace(/<[^>]*>/g, ' ');

  // episode codes and counts
  s = s.replace(/\bS(\d{1,2})\s?E(\d{1,3})\b/gi, (_, a, b) => `season ${numberToWords(+a)}, episode ${numberToWords(+b)}`);
  s = s.replace(/\b(season)\s+(\d+)/gi, (_, w, a) => `${w} ${numberToWords(+a)}`);
  s = s.replace(/\b(episode)\s+(\d+)/gi, (_, w, a) => `${w} ${numberToWords(+a)}`);
  s = s.replace(/\b(\d+)x(\d{2})\b/g, (_, a, b) => `season ${numberToWords(+a)}, episode ${numberToWords(+b)}`);

  // titles and abbreviations
  for (const [re, to] of TITLES) s = s.replace(re, to);
  s = s.replace(/\bNo\.\s*(\d+)/g, (_, a) => `number ${numberToWords(+a)}`);
  s = s.replace(/\bU\.S\.A?\./g, 'U S A').replace(/\bU\.K\./g, 'U K').replace(/\b([A-Z])\.(?=[A-Z]\.)/g, '$1');
  s = s.replace(/\bTV\b/g, 'T V').replace(/\bDVD\b/g, 'D V D');

  // money, percentages, symbols
  s = s.replace(/£\s?(\d[\d,]*)(\.\d{2})?/g, (_, a, p) => `${numberToWords(+a.replace(/,/g, ''))} pound${+a.replace(/,/g, '') === 1 ? '' : 's'}${p ? ' ' + numberToWords(+p.slice(1)) + ' pence' : ''}`);
  s = s.replace(/\$\s?(\d[\d,]*)/g, (_, a) => `${numberToWords(+a.replace(/,/g, ''))} dollar${+a.replace(/,/g, '') === 1 ? '' : 's'}`);
  s = s.replace(/(\d)\s?%/g, '$1 percent').replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/@/g, ' at ');

  // clock times: 9pm, 9:30 pm
  s = s.replace(/\b(\d{1,2})(?::(\d{2}))?\s?([ap])\.?m\.?(?![a-z])/gi, (_, h, m, ap) =>
    `${numberToWords(+h)}${m && m !== '00' ? ' ' + (+m < 10 ? 'oh ' : '') + numberToWords(+m) : ''} ${ap.toUpperCase()} M`);

  // decades, years, ordinals, plain numbers
  s = s.replace(/\b(1[0-9]|20)(\d)0'?s\b/g, (_, a, b) => {
    const tens = TENS[+b]; const hi = numberToWords(+a);
    return `${hi} ${tens.slice(0, -1)}ies`;
  });
  s = s.replace(/\b([2-9])0'?s\b/g, (_, a) => `${TENS[+a].slice(0, -1)}ies`);
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, a) => ordinalToWords(+a));
  s = s.replace(/\b(1[1-9]\d\d|20\d\d)\b/g, (_, y) => yearToWords(+y));
  s = s.replace(/\b(\d{1,3}(?:,\d{3})+|\d+)\b/g, (_, a) => (a.length > 9 ? a.split('').map((d) => ONES[+d]).join(' ') : numberToWords(+a.replace(/,/g, ''))));

  // "Rocky II" -> "Rocky two" (only after a capitalised word, so a sentence-starting "I" or "V" is left alone)
  s = s.replace(/(\b[A-Z][a-z']+)\s+(II|III|IV|VI|VII|VIII|IX)\b/g, (_, w, r) => `${w} ${ROMAN[r]}`);
  s = s.replace(/\b(part|chapter|volume|book|series|act)\s+(II|III|IV|V|VI|VII|VIII|IX|X)\b/gi, (_, w, r) => `${w} ${ROMAN[r.toUpperCase()] || (r.toUpperCase() === 'V' ? 'five' : 'ten')}`);

  // shouted words ("SHAMELESS") are read as words, short ones ("BBC", "NCIS") are kept as letters
  s = s.replace(/\b([A-Z]{5,})\b/g, (m) => (/[AEIOUY]/.test(m) ? m.charAt(0) + m.slice(1).toLowerCase() : m));

  // punctuation that should be a pause, not a symbol
  s = s.replace(/\s*[(\[{]\s*/g, ', ').replace(/\s*[)\]}]\s*/g, ', ')
    .replace(/\s*[–—]\s*/g, ', ').replace(/\s+-\s+/g, ', ')
    .replace(/\s*:\s+/g, ', ').replace(/\s*;\s*/g, ', ')
    .replace(/\s*(?:\.{3}|…)\s*/g, '. ')
    .replace(/["`*_#^~|\\]/g, ' ')
    .replace(/\s*\/\s*/g, ' ')
    .replace(/(?:,\s*){2,}/g, ', ').replace(/,\s*([.!?])/g, '$1').replace(/([.!?])\s*,/g, '$1');

  s = s.replace(/\s+/g, ' ').replace(/^[,.\s]+/, '').replace(/[,;:\s]+$/, '').trim();
  if (s && !/[.!?]$/.test(s)) s += '.';
  return s;
}
