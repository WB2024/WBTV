import test from 'node:test';
import assert from 'node:assert/strict';
import { parseName, plausibleYear, looksLikeDownloadYear, fileSafe, buildLibraryIndex, readNfo, norm } from '../tools/mvlib.mjs';

const t = (base, folder) => { const r = parseName(base, folder); return [r.artist, r.title, r.year]; };

test('names are cleaned to Artist and Title', () => {
  assert.deepEqual(t('Morrissey - Boxers', 'Morrissey'), ['Morrissey', 'Boxers', null]);
  assert.deepEqual(t('Morrissey - All You Need is Me (Official Video)', 'Morrissey'), ['Morrissey', 'All You Need is Me', null]);
  assert.deepEqual(t('Morrissey - All You Need Is Me - YouTube.flv', 'Morrissey'), ['Morrissey', 'All You Need Is Me', null]);
  assert.deepEqual(t('Morrissey - The Youngest Was the Most Loved (Official Video) {HD}', 'Morrissey'), ['Morrissey', 'The Youngest Was the Most Loved', null]);
});

test('an uploader in front, shouting, and a featured artist are handled', () => {
  assert.equal(parseName('RHINO - Morrissey - The Last Of The Famous International Playboys (Official Music Video)', 'Morrissey').title, 'The Last Of The Famous International Playboys');
  assert.equal(parseName('MORRISSEY-THE BULL FIGHTER DIES', 'Morrissey').title, 'The Bull Fighter Dies');
  assert.equal(parseName('MORRISSEY feat. Pamela Anderson - Earth Is The Loneliest Planet (spoken word + song)', 'Morrissey').title, 'Earth Is The Loneliest Planet (spoken word + song) (feat. Pamela Anderson)');
});

test('a year or track number in the name is picked up and removed', () => {
  assert.deepEqual(t('Hole - 1996 - Gold Dust Woman', 'Hole'), ['Hole', 'Gold Dust Woman', 1996]);
  assert.deepEqual(t('23 Love Will Tear Us Apart', 'Joy Division'), ['Joy Division', 'Love Will Tear Us Apart', null]);
  assert.equal(parseName('Morrissey - 1 Step Ahead', 'Morrissey').title, '1 Step Ahead'); // a title that starts with a digit is not a track number
});

test('upload dates and download years are not release years', () => {
  assert.equal(plausibleYear('20090920'), null);
  assert.equal(plausibleYear(1896), null);
  assert.equal(plausibleYear(1996), 1996);
  assert.equal(looksLikeDownloadYear(2024, { addedYear: 2024 }), true);
  assert.equal(looksLikeDownloadYear(1996, { addedYear: 2024, mtimeYear: 2024 }), false);
});

test('file names are made safe and keys ignore noise', () => {
  assert.equal(fileSafe('AC/DC - Who Made Who?'), 'ACDC - Who Made Who');
  assert.equal(norm('Boxers (Official Video) [HD]'), norm('boxers'));
  assert.equal(norm('Morrissey feat. Pamela Anderson'), 'morrissey pamela anderson');
});

test('a video borrows the earliest real year and the genre of the matching song in your library', () => {
  const idx = buildLibraryIndex([
    { artist: 'Joy Division', title: 'Love Will Tear Us Apart', year: 1980, genres: ['Rock - Goth'] },
    { artist: 'Joy Division', title: 'Love Will Tear Us Apart', year: 2007, genres: ['Rock - Goth'] }, // a later reissue
    { artist: 'Hole', title: 'Doll Parts', year: 1994, genres: ['Rock - Grunge'] },
    { artist: 'Hole', title: 'Other', year: 1998, genres: ['Rock - Grunge'] },
  ]);
  assert.deepEqual(idx.song('Joy Division', 'Love Will Tear Us Apart (Official Video)'), { year: 1980, genres: ['Rock - Goth'], copies: 2 });
  assert.equal(idx.song('Joy Division', 'Nope'), null);
  assert.deepEqual(idx.artist('hole').genres, ['Rock - Grunge']);
  assert.equal(idx.artist('Unknown Band'), null);
});

test('the fields are read out of a Jellyfin-style .nfo', () => {
  const nfo = '<musicvideo><title>Morrissey - Boxers</title><year>20090920</year><artist>Morrissey</artist><genre>Rock</genre><dateadded>2024-04-02 08:18:34</dateadded><lockdata>false</lockdata></musicvideo>';
  assert.deepEqual(readNfo(nfo), { title: 'Morrissey - Boxers', artist: 'Morrissey', album: '', year: '20090920', genres: ['Rock'], plot: '', added: '2024-04-02 08:18:34', locked: false });
});

test('date-prefixed downloads, collaborations, trailing artist repeats and encoding tags', () => {
  const known = new Set([norm('The Notorious B.I.G.'), norm('Morrissey')]);
  assert.deepEqual(Object.values(parseName('20151118_The Notorious B.I.G. - One More Chance', 'Biggie Smalls', known)).slice(0, 2), ['The Notorious B.I.G.', 'One More Chance']);
  assert.equal(parseName('Morrissey and David Bowie – Cosmic Dancer (Live at the Inglewood Forum)', 'Morrissey').title, 'Cosmic Dancer (Live at the Inglewood Forum) (with David Bowie)');
  assert.equal(parseName('Morrissey - First Of The Gang To Die   -  Clip Official - Morrissey - 2004', 'Morrissey').title, 'First Of The Gang To Die');
  assert.equal(parseName('Morrissey - The More You Ignore Me, The Closer I Get (Official Music Video) [HD Upgrade]', 'Morrissey').title, 'The More You Ignore Me, The Closer I Get');
  assert.deepEqual(t('Hole - Celebrity Skin (promo ntsc lpcm Skyllz22) [1998]', 'Hole'), ['Hole', 'Celebrity Skin', 1998]);
  assert.equal(parseName('Morrissey- All you need is me. Official video', 'Morrissey').title, 'All you need is me');
  assert.equal(parseName('24 Joy Division - Transmission (1979 Live Performance)', 'Joy Division').title, 'Transmission (1979 Live Performance)');
});
