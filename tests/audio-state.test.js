const assert = require('node:assert/strict');
const {test} = require('node:test');
const {AudioController} = require('../web/learning.js');

function playerFactory() {
  const players = [];
  return {players, createAudio(source) {
    const listeners = new Map();
    const player = {source, playCalls: 0, pauseCalls: 0, listeners,
      addEventListener(name, fn) { listeners.set(name, fn); },
      removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
      play() { this.playCalls++; return Promise.resolve(); },
      pause() { this.pauseCalls++; },
      emit(name) { listeners.get(name)?.({type: name}); }};
    players.push(player); return player;
  }};
}

test('play calls the native player synchronously and publishes loading, playing, waiting, and ended states', async () => {
  const fake = playerFactory(); const states = [];
  const controller = new AudioController({createAudio: fake.createAudio, onStateChange: state => states.push(state)});
  const pending = controller.play('one.mp3', {wordId: 'w1'});
  assert.equal(fake.players.length, 1); assert.equal(fake.players[0].playCalls, 1);
  assert.equal(states[0].state, 'loading'); assert.equal(states[0].wordId, 'w1');
  await pending;
  fake.players[0].emit('playing'); fake.players[0].emit('waiting'); fake.players[0].emit('ended');
  assert.deepEqual(states.map(state => state.state), ['loading', 'playing', 'loading', 'idle']);
});

test('prepare creates a silent reusable player and a later manual play reuses it', async () => {
  const fake = playerFactory(); const states = [];
  const controller = new AudioController({createAudio: fake.createAudio, onStateChange: state => states.push(state)});
  assert.equal(controller.prepare('one.mp3', {wordId: 'w1'}), true);
  assert.equal(fake.players.length, 1); assert.equal(fake.players[0].playCalls, 0);
  assert.equal(states.length, 0);
  await controller.play('one.mp3', {automatic: false, wordId: 'w1'});
  assert.equal(fake.players.length, 1); assert.equal(fake.players[0].playCalls, 1);
});

test('stale player events and rejected promises cannot replace the latest word state', async () => {
  const fake = playerFactory(); const states = [];
  const controller = new AudioController({createAudio: fake.createAudio, onStateChange: state => states.push(state)});
  const first = controller.play('first.mp3', {wordId: 'first'});
  const second = controller.play('second.mp3', {wordId: 'second'});
  fake.players[0].emit('error');
  assert.equal(states.at(-1).source, 'second.mp3');
  assert.equal(states.some(state => state.state === 'error' && state.source === 'first.mp3'), false);
  await Promise.all([first, second]);
});

test('playback failures publish retryable error and stop publishes idle', async () => {
  const fake = playerFactory(); const states = [];
  fake.createAudio = source => { const p = playerFactory().createAudio(source); p.play = () => Promise.reject(new Error('media failed')); fake.players.push(p); return p; };
  const controller = new AudioController({createAudio: fake.createAudio, onStateChange: state => states.push(state)});
  await controller.play('broken.mp3', {wordId: 'w'});
  assert.equal(states.at(-1).state, 'error'); assert.equal(states.at(-1).source, 'broken.mp3');
  controller.stop(); assert.equal(states.at(-1).state, 'idle');
});

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function pendingPlayerFactory() {
  const players = [];
  return {players, createAudio(source) {
    const listeners = new Map(); const playback = deferred();
    const player = {source, playback, playCalls: 0, pauseCalls: 0, listeners,
      addEventListener(name, fn) { listeners.set(name, fn); },
      removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
      play() { this.playCalls++; return playback.promise; },
      pause() { this.pauseCalls++; },
      removeAttribute() {}, load() {},
      emit(name) { listeners.get(name)?.({type: name}); }};
    players.push(player); return player;
  }};
}

test('a late rejection from an older pending play cannot replace the newer word or report an error', async () => {
  const fake = pendingPlayerFactory(); const states = []; const errors = [];
  const controller = new AudioController({createAudio: fake.createAudio, onStateChange: state => states.push(state), onError: error => errors.push(error)});
  const oldPlay = controller.play('old.mp3', {wordId: 'old'});
  const newPlay = controller.play('new.mp3', {wordId: 'new'});
  fake.players[1].playback.resolve(); await newPlay;
  fake.players[0].playback.reject(new Error('late old failure')); await oldPlay;
  assert.equal(states.at(-1).source, 'new.mp3');
  assert.equal(states.at(-1).state, 'playing');
  assert.deepEqual(errors, []);
});

test('stop during loading invalidates the pending play and keeps late settlement idle', async () => {
  const fake = pendingPlayerFactory(); const states = [];
  const controller = new AudioController({createAudio: fake.createAudio, onStateChange: state => states.push(state)});
  const pending = controller.play('slow.mp3', {wordId: 'slow'});
  controller.stop(); fake.players[0].playback.resolve();
  assert.equal(await pending, false);
  assert.equal(states.at(-1).state, 'idle');
});

test('prepare null releases a prepared player without autoplay and ignores its late events', () => {
  const fake = playerFactory(); const states = [];
  const controller = new AudioController({createAudio: fake.createAudio, onStateChange: state => states.push(state)});
  controller.prepare('prepared.mp3');
  const player = fake.players[0];
  assert.equal(player.playCalls, 0);
  assert.equal(controller.prepare(null), false);
  player.emit('playing'); player.emit('error');
  assert.equal(player.playCalls, 0);
  assert.equal(states.some(state => state.state === 'playing' || state.state === 'error'), false);
});

test('late media error after playback starts becomes a visible retryable error', async () => {
  const fake = playerFactory(); const states = [];
  const controller = new AudioController({createAudio: fake.createAudio, onStateChange: state => states.push(state)});
  await controller.play('flaky.mp3', {wordId: 'flaky'});
  fake.players[0].emit('error');
  assert.equal(states.at(-1).state, 'error');
  assert.equal(states.at(-1).source, 'flaky.mp3');
});

test('replaying the same word reuses its prepared player', async () => {
  const fake = playerFactory();
  const controller = new AudioController({createAudio: fake.createAudio});
  await controller.play('again.mp3', {wordId: 'word'});
  await controller.play('again.mp3', {wordId: 'word'});
  assert.equal(fake.players.length, 1);
  assert.equal(fake.players[0].playCalls, 2);
});
