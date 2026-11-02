import test from 'node:test';
import assert from 'node:assert/strict';
import { speakable, numberToWords, yearToWords, ordinalToWords } from '../src/speech.js';

test('numbers are read as words', () => {
  assert.equal(numberToWords(0), 'zero');
  assert.equal(numberToWords(21), 'twenty-one');
  assert.equal(numberToWords(105), 'one hundred and five');
  assert.equal(numberToWords(1234), 'one thousand two hundred and thirty-four');
  assert.equal(numberToWords(2005), 'two thousand and five');
  assert.equal(ordinalToWords(1), 'first');
  assert.equal(ordinalToWords(22), 'twenty-second');
  assert.equal(ordinalToWords(30), 'thirtieth');
});

test('years are said the way people say them', () => {
  assert.equal(yearToWords(1999), 'nineteen ninety-nine');
  assert.equal(yearToWords(1905), 'nineteen oh five');
  assert.equal(yearToWords(1900), 'nineteen hundred');
  assert.equal(yearToWords(2000), 'two thousand');
  assert.equal(yearToWords(2008), 'two thousand and eight');
  assert.equal(yearToWords(2012), 'twenty twelve');
  assert.equal(speakable('A film from 1984.'), 'A film from nineteen eighty-four.');
});

test('episode codes, ordinals, decades and times', () => {
  assert.equal(speakable('S04E10'), 'season four, episode ten.');
  assert.equal(speakable('Season 2, episode 3.'), 'Season two, episode three.');
  assert.equal(speakable('The 1st of May'), 'The first of May.');
  assert.equal(speakable('Hits of the 1990s'), 'Hits of the nineteen nineties.');
  assert.equal(speakable('the 80s'), 'the eighties.');
  assert.equal(speakable('Tonight at 9pm'), 'Tonight at nine P M.');
  assert.equal(speakable('At 9:30 pm'), 'At nine thirty P M.');
});

test('titles, abbreviations and symbols', () => {
  assert.equal(speakable('Mr. Bean'), 'Mister Bean.');
  assert.equal(speakable('Dr. Who'), 'Doctor Who.');
  assert.equal(speakable('Tom & Jerry'), 'Tom and Jerry.');
  assert.equal(speakable('Batman vs. Superman'), 'Batman versus Superman.');
  assert.equal(speakable('It costs £5'), 'It costs five pounds.');
  assert.equal(speakable('100% pure'), 'one hundred percent pure.');
});

test('punctuation becomes pauses, not symbols', () => {
  assert.equal(speakable('Star Trek: Voyager'), 'Star Trek, Voyager.');
  assert.equal(speakable('Fargo - the series'), 'Fargo, the series.');
  assert.equal(speakable('Alien (1979)'), 'Alien, nineteen seventy-nine.');
  assert.equal(speakable('Well... maybe'), 'Well. maybe.');
  assert.equal(speakable('"Quoted" title'), 'Quoted title.');
});

test('roman numerals after a name, and shouted words', () => {
  assert.equal(speakable('Rocky II'), 'Rocky two.');
  assert.equal(speakable('Part III'), 'Part three.');
  assert.equal(speakable('I am here'), 'I am here.');
  assert.equal(speakable('SHAMELESS returns'), 'Shameless returns.');
  assert.equal(speakable('The BBC and ITV'), 'The BBC and ITV.');
});

test('empty and odd input never throws and ends in punctuation', () => {
  assert.equal(speakable(''), '');
  assert.equal(speakable(null), '');
  assert.equal(speakable('   ...  '), '');
  assert.match(speakable('Hello'), /[.!?]$/);
});
