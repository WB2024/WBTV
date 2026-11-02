// Automatic dayparting and era-matched adverts: the schedule leans towards what suits the time of day, using only
// the metadata already in your library (genres and age ratings). Everything is a soft weight, so a channel never
// runs out of things to play; it just plays the right things more often.

/** Normalise an age rating ("TV-MA", "Rated R", "UK:15", "PG-13"...) to a lower-case token. */
function ratingToken(r) {
  return String(r || '').toLowerCase().replace(/^(rated|certification)\s*/, '').replace(/^(us|uk|gb|de|au)[:/ ]\s*/, '').trim().split(/\s+/)[0] || '';
}
const KID = new Set(['g', 'u', 'uc', 'pg', 'tv-y', 'tv-y7', 'tv-g', 'tv-pg', '0', '6']);
const TEEN = new Set(['tv-14', 'pg-13', '12', '12a', '13', 'm', '15']);
const ADULT = new Set(['tv-ma', 'r', 'nc-17', 'nc17', 'x', 'r18', '18', 'ma', 'ma15+']);

/** What a programme is, for scheduling purposes. */
export function classify(genres, rating) {
  const g = (genres || []).map((x) => String(x).toLowerCase());
  const has = (re) => g.some((x) => re.test(x));
  const r = ratingToken(rating);
  const adult = ADULT.has(r), teen = TEEN.has(r);
  const animation = has(/animation|cartoon|anime/);
  const kids = !adult && (KID.has(r) || animation || has(/family|child|kids/));
  return {
    adult, teen: teen && !adult, kids, animation,
    horror: has(/horror|slasher/),
    factual: has(/documentary|news|talk|reality|game show|lifestyle|history|nature/),
    comedy: has(/comedy|sitcom/),
    drama: has(/drama|crime|thriller|mystery|sci-?fi|science fiction|fantasy|action|adventure/),
  };
}

/** How much a programme suits `ts` (unix seconds, local time). 1 = neutral. */
export function daypartWeight(c, ts) {
  const d = new Date(ts * 1000);
  const h = d.getHours() + d.getMinutes() / 60;
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  const night = h >= 22 || h < 5, late = h >= 21 || h < 5, day = h >= 6 && h < 21;
  let w = 1;
  if (c.kids) {
    if (h >= 6 && h < 9) w *= weekend ? 4 : 2.2;
    else if (h >= 9 && h < 15) w *= weekend ? 3 : 1.4;
    else if (h >= 15 && h < 18.5) w *= 3;
    else if (h >= 18.5 && h < 20) w *= 0.8;
    else w *= 0.06;
    if (c.animation && weekend && h >= 7 && h < 12) w *= 2; // Saturday morning cartoons
  }
  if (c.adult) w *= late ? 3 : day ? 0.08 : 1;
  else if (c.teen) w *= h >= 19.5 || h < 5 ? 1.5 : h >= 6 && h < 15.5 ? 0.4 : 1;
  if (c.horror) w *= night ? 4 : h >= 6 && h < 20 ? 0.1 : 0.5;
  if (c.factual) w *= h >= 7 && h < 19 ? 1.8 : night ? 0.6 : 1;
  if (!c.kids) {
    if (c.comedy && h >= 17 && h < 22.5) w *= 1.6;
    if (c.drama && h >= 20 && h < 23.5) w *= 1.6;
  }
  return Math.min(30, Math.max(0.02, w));
}

/** Weighted random choice. */
export function pickWeighted(arr, weightOf) {
  const ws = arr.map(weightOf);
  let r = Math.random() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < arr.length; i++) { r -= ws[i]; if (r <= 0) return arr[i]; }
  return arr[arr.length - 1];
}

// ---- eras for adverts ---------------------------------------------------------------------------

/** Best guess at the year an advert is from, using its title and folder name ("1994", "1990s", "80s"). Null if unknown. */
export function guessAdYear(text) {
  const s = String(text || '');
  let m = /(?:^|[^0-9])((?:19|20)[0-9]0)'?s(?![a-z])/i.exec(s);
  if (m) return Number(m[1]) + 5;
  m = /(?:^|[^0-9])((?:19[2-9]|20[0-3])[0-9])(?![0-9])/.exec(s);
  if (m) return Number(m[1]);
  m = /(?:^|[^0-9a-z])([2-9]0)'?s(?![a-z])/i.exec(s);
  if (m) return 1900 + Number(m[1]) + 5;
  return null;
}

/** Preference for an advert from `adYear` on a programme from `year`. Adverts with no year stay neutral. */
export function eraWeight(adYear, year) {
  if (!adYear || !year) return 1;
  const d = Math.abs(adYear - year);
  return d <= 4 ? 8 : d <= 9 ? 2.5 : d <= 15 ? 0.6 : 0.15;
}

/** The year a programme is from: its own year, else its air date, else its show's. */
export function programmeYear(it) {
  if (it.year) return Number(it.year);
  const a = /^(\d{4})/.exec(String(it.aired || ''));
  if (a) return Number(a[1]);
  return it.show_year ? Number(it.show_year) : null;
}
