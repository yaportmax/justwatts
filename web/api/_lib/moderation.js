// Automatic moderation without a paid API: a small built-in word list with leetspeak folding,
// link detection, and normalization for duplicate checks.
'use strict';

// Small list in the spirit of LDNOUBW (profanity, slurs, sexual terms). Matched on folded words and on
// runs of spaced letters ("f.u.c.k"); INSIDE words also match inside longer words ("fuckyou").
const WORDS = [
  'anal', 'anus', 'arsehole', 'asshole', 'bastard', 'bitch', 'blowjob', 'bollocks', 'boner', 'bullshit',
  'chink', 'clit', 'cock', 'cocksucker', 'coon', 'cum', 'cunt', 'dick', 'dildo', 'dyke', 'fag', 'faggot',
  'fuck', 'fucker', 'fucking', 'gook', 'handjob', 'jizz', 'kike', 'motherfucker', 'nazi', 'nigga', 'nigger',
  'paki', 'penis', 'piss', 'porn', 'pussy', 'rape', 'rapist', 'retard', 'shit', 'slut', 'spic', 'tits',
  'tranny', 'twat', 'vagina', 'wank', 'wanker', 'whore', 'wetback', 'kys', 'killyourself',
];
const LEET = { 0: 'o', 1: 'i', 2: 'z', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't', '€': 'e', '¡': 'i' };

// lowercase, strip accents, map leet characters, collapse 3+ repeats to one ("fuuuck" -> "fuck")
function fold(text) {
  let s = String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  s = s.replace(/[0-9@$!|+€¡]/g, c => LEET[c] || c);
  return s.replace(/([a-z])\1{2,}/g, '$1');
}
const INSIDE = ['fuck', 'nigger', 'nigga', 'faggot', 'cocksucker', 'asshole', 'bitch', 'whore', 'wanker', 'blowjob', 'handjob'];
const SET = new Set(WORDS);
// plural / -s, -ed, -ing forms of a listed word count as the word
const stem = w => [w, w.replace(/(es|s|ed|ing|er|ers)$/, ''), w.replace(/(\w)\1$/, '$1')];

function hasBadWord(text) {
  const words = fold(text).split(/[^a-z]+/).filter(Boolean);
  // spaced-out letters: "f u c k", "s.h.i.t" (runs of single letters joined)
  const runs = words.reduce((acc, w) => { if (w.length === 1) acc[acc.length - 1] += w; else acc.push(''); return acc; }, ['']);
  return [...words, ...runs.filter(w => w.length >= 3)].some(w => stem(w).some(x => SET.has(x)) || INSIDE.some(x => w.includes(x)));
}

// http(s)://, www., or a bare domain with a common TLD; also folded so "examp1e.c0m" still counts
const LINK = /(https?:?\/\/|www\.|\b[a-z0-9-]{1,}\s*(\.|\(dot\)|\[dot\]|\sdot\s)\s*(com|net|org|io|co|me|ru|xyz|info|biz|ly|gg|app|dev|tv|us|uk|de|link|site|online|shop|top|club)\b)/i;
const hasLink = text => LINK.test(String(text || '')) || LINK.test(fold(text));

// whitespace-collapsed lowercase, for duplicate detection
const normalize = text => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
// printable text: no control characters (newlines allowed in comments)
const clean = (text, newlines = false) => String(text ?? '').replace(newlines ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, '').trim();

module.exports = { WORDS, fold, hasBadWord, hasLink, normalize, clean };
