const assert = require('node:assert/strict');
const {test} = require('node:test');
const {AudioController, buildQuestions, normalizeSearch} = require('../web/learning.js');

const word = (id, term, termLang = 'en', meaning = `meaning ${id}`) => ({
  id: String(id),
  term,
  termLang,
  meaning,
});

const random = () => 0.4;

test('search folds Greek accents and final sigma but preserves other-language distinctions', () => {
  assert.equal(normalizeSearch('ΚΑΦΈΣ', 'el'), 'καφεσ');
  assert.equal(normalizeSearch('καφεσ', 'el'), 'καφεσ');
  assert.equal(normalizeSearch('I', 'tr'), 'ı');
  assert.equal(normalizeSearch('İ', 'tr'), 'i');
  assert.notEqual(normalizeSearch('العَرَبِيَّة', 'ar'), normalizeSearch('العربية', 'ar'));
});

test('search recovers through the undetermined locale when the requested locale fails', context => {
  const lowerCase = String.prototype.toLocaleLowerCase;
  const locales = [];
  context.mock.method(String.prototype, 'toLocaleLowerCase', function (locale) {
    locales.push(locale);
    if (locale === 'el') throw new RangeError('Locale unavailable');
    return lowerCase.call(this, locale);
  });
  assert.equal(normalizeSearch('ΚΑΦΈΣ', 'el'), 'καφεσ');
  assert.deepEqual(locales, ['el', 'und']);
});

test('search recovers with ordinary lowercase when both locale attempts fail', context => {
  context.mock.method(String.prototype, 'toLocaleLowerCase', () => { throw new RangeError('Locale unavailable'); });
  assert.equal(normalizeSearch('HELLO', 'en'), 'hello');
  assert.equal(normalizeSearch('ΚΑΦΈΣ', 'el'), 'καφεσ');
  assert.equal(normalizeSearch('E\u0301', 'en'), 'é');
});

test('each unique term gets a question with itself among four distinct options', () => {
  const words = [word(1, 'λάδι', 'el'), word(2, 'ψωμί', 'el'), word(3, 'καφές', 'el'), word(4, 'γάτα', 'el'), word(5, 'βιβλίο', 'el')];
  const questions = buildQuestions(words, random);

  assert.equal(questions.length, words.length);
  for (const question of questions) {
    assert.ok(question.options.some(option => option.id === question.word.id));
    assert.equal(question.options.length, 4);
    assert.equal(new Set(question.options.map(option => normalizeSearch(option.term, option.termLang))).size, 4);
    assert.equal(new Set(question.options.map(option => normalizeSearch(option.meaning, option.meaningLang || 'en'))).size, 4);
  }
});

test('a deck with exactly four distinct terms and meanings produces four unambiguous options', () => {
  const words = [word(1, 'uno', 'es', 'one'), word(2, 'dos', 'es', 'two'), word(3, 'tres', 'es', 'three'), word(4, 'cuatro', 'es', 'four')];
  const questions = buildQuestions(words, random);

  assert.equal(questions.length, 4);
  assert.ok(questions.every(question => question.options.length === 4));
  assert.ok(questions.every(question => new Set(question.options.map(option => normalizeSearch(option.meaning, option.meaningLang || 'en'))).size === 4));
});

test('synonyms are excluded as distractors for the same meaning in either language', () => {
  const words = [
    word(1, 'car', 'en', 'car'),
    word(2, 'automobile', 'en', 'CAR'),
    word(3, 'bicycle', 'en', 'bicycle'),
    word(4, 'train', 'en', 'train'),
    word(5, 'boat', 'en', 'boat'),
  ];
  const questions = buildQuestions(words, random);

  for (const question of questions.filter(question => ['1', '2'].includes(question.word.id))) {
    assert.equal(question.options.length, 4);
    assert.ok(question.options.every(option => !['1', '2'].includes(option.id) || option.id === question.word.id));
    assert.equal(new Set(question.options.map(option => normalizeSearch(option.meaning, option.meaningLang || 'en'))).size, 4);
  }
});

test('question construction is deterministic with an injected random source and does not mutate the deck', () => {
  const words = [word(1, 'one'), word(2, 'two'), word(3, 'three'), word(4, 'four'), word(5, 'five')];
  const original = structuredClone(words);

  assert.deepEqual(buildQuestions(words, random), buildQuestions(words, random));
  assert.deepEqual(words, original);
});

test('duplicate normalized terms are not presented as questions or distractors', () => {
  const words = [word(1, 'ΚΑΦΈΣ', 'el'), word(2, 'καφεσ', 'el'), word(3, 'ψωμί', 'el'), word(4, 'γάτα', 'el'), word(5, 'βιβλίο', 'el')];
  const questions = buildQuestions(words, random);

  assert.equal(questions.length, 4);
  assert.ok(questions.every(question => question.word.id !== '2'));
  assert.ok(questions.every(question => question.options.every(option => option.id !== '2')));
});

test('question construction rejects duplicate IDs, empty terms, and decks with fewer than four unique terms', () => {
  assert.throws(() => buildQuestions([word(1, 'one'), word(1, 'two'), word(3, 'three'), word(4, 'four')], random), /ID/i);
  assert.throws(() => buildQuestions([word(1, 'one'), word(2, 'two'), word(3, ' '), word(4, 'four')], random), /term/i);
  assert.throws(() => buildQuestions([word(1, 'one'), word(2, 'two'), word(3, 'three')], random), /four/i);
  assert.throws(() => buildQuestions([word(1, 'same'), word(2, 'SAME'), word(3, 'same'), word(4, 'other')], random), /four/i);
});

test('question construction rejects decks that cannot offer four distinct meanings', () => {
  const synonymousDeck = [word(1, 'car', 'en', 'vehicle'), word(2, 'auto', 'en', 'vehicle'), word(3, 'bike', 'en', 'bicycle'), word(4, 'train', 'en', 'train')];
  assert.throws(() => buildQuestions(synonymousDeck, random), /four.*meaning|meaning.*four/i);

  const translatedDeck = [word(1, 'uno', 'es', 'one'), word(2, 'un', 'fr', 'one'), word(3, 'dos', 'es', 'two'), word(4, 'tres', 'es', 'three')];
  translatedDeck[0].meaningLang = 'en';
  translatedDeck[1].meaningLang = 'en';
  assert.throws(() => buildQuestions(translatedDeck, random), /four.*meaning|meaning.*four/i);

  const sameMeaningDeck = [word(1, 'uno', 'es', 'one'), word(2, 'un', 'fr', 'one'), word(3, 'eins', 'de', 'one'), word(4, 'один', 'ru', 'one')];
  assert.throws(() => buildQuestions(sameMeaningDeck, random), /four.*meaning|meaning.*four/i);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
}

function fakeAudio() {
  const requests = [];
  return {
    requests,
    createAudio(src) {
      const playback = deferred();
      const audio = {src, play: () => playback.promise, pause: () => playback.reject(Object.assign(new Error('interrupted'), {name: 'AbortError'}))};
      requests.push({audio, playback});
      return audio;
    },
  };
}

test('missing recordings are skipped without creating an audio player or reporting an error', async () => {
  const fake = fakeAudio();
  const errors = [];
  const controller = new AudioController({createAudio: fake.createAudio, onError: error => errors.push(error)});

  assert.equal(await controller.play(undefined, {automatic: true}), false);
  assert.equal(await controller.play('', {automatic: false}), false);
  assert.equal(fake.requests.length, 0);
  assert.deepEqual(errors, []);
});

test('latest playback wins and cancelled playback errors are ignored', async () => {
  const fake = fakeAudio();
  const errors = [];
  const controller = new AudioController({createAudio: fake.createAudio, onError: error => errors.push(error)});

  const first = controller.play('first.mp3');
  const second = controller.play('second.mp3');
  fake.requests[1].playback.resolve();

  assert.equal(await second, true);
  assert.equal(await first, false);
  assert.deepEqual(errors, []);
});

test('stop invalidates pending playback and does not report intentional cancellation', async () => {
  const fake = fakeAudio();
  const errors = [];
  const controller = new AudioController({createAudio: fake.createAudio, onError: error => errors.push(error)});

  const pending = controller.play('voice.mp3');
  controller.stop();

  assert.equal(await pending, false);
  assert.deepEqual(errors, []);
});

test('automatic playback errors are reported at most once while manual errors remain visible', async () => {
  const fake = fakeAudio();
  const errors = [];
  const controller = new AudioController({createAudio: fake.createAudio, onError: error => errors.push(error)});

  const firstAutomatic = controller.play('auto-1.mp3', {automatic: true});
  fake.requests[0].playback.reject(new Error('blocked'));
  assert.equal(await firstAutomatic, false);

  const secondAutomatic = controller.play('auto-2.mp3', {automatic: true});
  fake.requests[1].playback.reject(new Error('blocked again'));
  assert.equal(await secondAutomatic, false);
  assert.equal(errors.length, 1);

  const manual = controller.play('manual.mp3');
  fake.requests[2].playback.reject(new Error('manual blocked'));
  assert.equal(await manual, false);
  assert.equal(errors.length, 2);
});
