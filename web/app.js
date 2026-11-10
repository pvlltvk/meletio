const {AudioController, buildQuestions, normalizeSearch} = Learning;
const serverBacked = document.body.dataset.server === 'true';
const data = serverBacked ? {uiLanguage: 'en', decks: []} : DATA;
const app = document.querySelector('#app');
const announcer = document.querySelector('#announcer');
const notice = document.querySelector('#notice');
const iconPaths = {
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4z"/><path d="M13 7a3 3 0 0 1 3-3h5v14h-4a4 4 0 0 0-4 3"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  settings: '<circle cx="12" cy="12" r="4"/><path d="m10 3 4 0 1 3 3 1 3 3-2 3-1 4-4 1-3 3-3-2-4-1-1-4-2-3 2-3 4-1z"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  sound: '<path d="m11 5-6 4H2v6h3l6 4zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  check: '<path d="m5 12 4 4L19 6"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name]}</svg>`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const decks = data.decks;
const displayNames = new Intl.DisplayNames([data.uiLanguage || 'en'], {type: 'language'});
let deck = decks[0];
let screen = 'study';
let questions = [];
let answers = [];
let position = 0;
let selected = null;
let lastSession = null;
let review = null;
let reviewTimer;
let reviewLoadedAt = 0;
let searchQuery = '';
let autoPronounce = false;
let storageAvailable = true;
let autoPlaybackNoticeShown = false;
let user = null;
let attempt = null;
let accountLoaded = !serverBacked;
let deckLoaded = !serverBacked;
let busy = false;
let generation = 0;
let failedOperation = null;
let loadError = '';
let authError = '';
let registering = false;
let registrationOpen = false;
let passwordFormOpen = false;
let passwordPending = false;
let passwordFeedback = '';
let passwordFailed = false;
let passwordRevision = 0;
let accountEmail = '';
let catalogLoaded = false;
let catalogCursor = null;
let attemptDeck = null;
let attemptSnapshotId = null;
let importStage = null;
let importDraft = null;
let importPreview = null;
let importFile = null;
let importRequestId = null;
let importCommit = null;
let importBusy = false;
let importError = '';
let importMessage = '';
let importRevision = 0;
let uploadController = null;
let editDraft = null;
let renameDraft = null;
let contentError = '';
let contentPending = null;
let deleteConfirmation = null;
let repairDestination = null;
let importedDeckId = null;
let importChoiceRevision = 0;
let importRecoveryNeeded = false;
let playback = {state: 'idle', source: null};
let audioLoadingTimer;
let audioLoadingVisible = false;

const operationId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

async function request(path, body, options = {}) {
  let response;
  const controller = options.controller || new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {...(body === undefined ? {} : {'Content-Type': options.binary ? 'application/octet-stream' : 'application/json'}), ...(user ? {'X-Meletio-User': user.id} : {}), ...options.headers},
      body: body === undefined ? undefined : options.binary ? body : JSON.stringify(body)
    });
  } catch {
    throw new Error('Could not reach Meletio. Check your connection and try again.');
  } finally {
    clearTimeout(timeout);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error?.message || 'The request could not be completed.');
    error.status = response.status;
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

function clearPractice() {
  clearTimeout(reviewTimer);
  review = null;
  attempt = null;
  attemptDeck = null;
  attemptSnapshotId = null;
  questions = [];
  answers = [];
  position = 0;
  selected = null;
  lastSession = null;
  selectedWord = undefined;
  searchQuery = '';
  returnWordId = undefined;
  returnScrollY = 0;
}

function clearAccount() {
  generation++;
  clearPasswordForm();
  stopAudio();
  clearSearchAnnouncement();
  user = null;
  uploadController?.abort();
  uploadController = null;
  importRevision++;
  importChoiceRevision++;
  importRecoveryNeeded = false;
  importStage = null;
  importDraft = null;
  importPreview = null;
  importFile = null;
  importRequestId = null;
  importCommit = null;
  importBusy = false;
  importError = '';
  importMessage = '';
  editDraft = null;
  renameDraft = null;
  contentPending = null;
  contentError = '';
  deleteConfirmation = null;
  repairDestination = null;
  importedDeckId = null;
  catalogLoaded = false;
  catalogCursor = null;
  decks.length = 0;
  clearPractice();
  deck = decks[0];
  screen = 'study';
  deckLoaded = false;
  accountLoaded = true;
  failedOperation = null;
  busy = false;
  loadError = '';
  authError = '';
  accountEmail = '';
  registering = false;
  autoPlaybackNoticeShown = false;
  announcer.replaceChildren();
}

async function useAttempt(value, current = generation) {
  let nextQuestions = questions;
  let nextAnswers;
  let nextDeck = attemptDeck;
  if (!value.snapshotId) {
    nextDeck = value.deck;
    nextQuestions = value.questions;
    nextAnswers = value.answers;
  } else if (attemptSnapshotId !== value.snapshotId || !attempt || attempt.id !== value.id) {
    const {snapshot} = await request(`/api/training/${value.id}/snapshot`);
    if (current !== generation) return;
    nextDeck = {...snapshot.deck, words: snapshot.words};
    const dictionary = new Map(snapshot.words.map(word => [word.id, word]));
    nextQuestions = snapshot.questions.map(question => ({word: dictionary.get(question.wordId), options: question.optionIds.map(id => dictionary.get(id))}));
    nextAnswers = [];
    let cursor;
    while (nextAnswers.length < value.answerCount) {
      const result = await request(`/api/training/${value.id}/answers${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (current !== generation) return;
      nextAnswers.push(...result.answers.slice(0, value.answerCount - nextAnswers.length).map(answer => ({word: dictionary.get(answer.wordId), optionId: answer.optionId, correct: answer.correct})));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    if (nextAnswers.length !== value.answerCount) throw new Error('Practice changed while loading. Reload to continue.');
  } else {
    if (value.revision < attempt.revision) {
      const error = new Error('Practice changed. Reload to continue.');
      error.status = 409;
      throw error;
    }
    nextAnswers = answers.slice(0, value.answerCount);
    if (value.lastAnswer && value.lastAnswer.position === nextAnswers.length) {
      const word = nextQuestions[value.lastAnswer.position].word;
      nextAnswers.push({word, optionId: value.lastAnswer.optionId, correct: value.lastAnswer.correct});
    }
    if (nextAnswers.length !== value.answerCount) {
      const error = new Error('Practice changed. Reload to continue.');
      error.status = 409;
      throw error;
    }
  }
  if (current !== generation) return;
  const withLanguages = word => ({...word, termLang: word.termLang || nextDeck.termLang, meaningLang: word.meaningLang || nextDeck.meaningLang});
  attempt = value;
  attemptDeck = nextDeck;
  attemptSnapshotId = value.snapshotId || null;
  if (nextQuestions !== questions) questions = nextQuestions.map(question => ({word: withLanguages(question.word), options: question.options.map(withLanguages)}));
  answers = nextAnswers.map(answer => ({...answer, word: withLanguages(answer.word)}));
  position = value.position;
  selected = value.selected;
}

async function refreshCatalog(current = generation) {
  const result = await request('/api/decks');
  if (current !== generation) return;
  decks.splice(0, decks.length, ...result.decks);
  catalogCursor = result.nextCursor;
  catalogLoaded = true;
}

function exerciseDeck() {
  return serverBacked && (screen === 'practice' || screen === 'results') && attemptDeck ? attemptDeck : deck;
}

function accountView() {
  if (!accountLoaded || (user && !deckLoaded)) {
    app.innerHTML = `<main class="account-shell"><h1>${loadError ? 'Could not load your practice.' : 'Loading your learning space…'}</h1>${loadError ? `<p role="alert">${escapeHtml(loadError)}</p><button class="primary" data-reload="true">Try again</button>` : '<p role="status">One moment.</p>'}</main>`;
    return;
  }
  app.innerHTML = `<main class="account-shell"><div class="brand"><span class="brandmark" aria-hidden="true">M</span>Meletio</div><h1>${registering ? 'Create account' : 'Log in'}</h1><p>${registering ? 'Create your account to keep your practice saved.' : 'Log in to continue your practice.'}</p><form id="account-form"><label for="account-email">Email</label><input id="account-email" name="email" type="email" autocomplete="username" maxlength="254" required value="${escapeHtml(accountEmail)}"><label for="account-password">Password</label><input id="account-password" name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" minlength="12" maxlength="256" required aria-describedby="password-help"><p id="password-help">Use at least 12 characters.</p><p id="account-error" class="account-error" role="alert">${escapeHtml(authError)}</p><button class="primary wide" type="submit">${registering ? 'Create account' : 'Log in'}</button></form>${registrationOpen ? '<button class="text-button" data-account-mode="true">New here? Create an account</button>' : ''}</main>`;
  updateRegistrationControl();
}

function updateRegistrationControl() {
  const form = app.querySelector('#account-form');
  if (!form) return;
  let button = app.querySelector('[data-account-mode]');
  if (!registrationOpen) { button?.remove(); return; }
  if (!button) {
    button = document.createElement('button');
    button.className = 'text-button';
    button.dataset.accountMode = 'true';
    form.after(button);
  }
  button.textContent = registering ? 'Already have an account? Log in' : 'New here? Create an account';
}

async function loadRegistrationConfig() {
  try { registrationOpen = (await request('/api/auth/config')).registrationOpen === true; }
  catch { registrationOpen = false; }
  updateRegistrationControl();
}

function clearPasswordForm() {
  passwordRevision++;
  app.querySelector('#password-form')?.reset();
  passwordFormOpen = false;
  passwordPending = false;
  passwordFeedback = '';
  passwordFailed = false;
}

function accountSettings() {
  const feedback = `<p id="password-feedback" class="${passwordFailed ? 'account-error' : 'password-status'}" role="${passwordFailed ? 'alert' : 'status'}">${escapeHtml(passwordFeedback)}</p>`;
  const form = passwordFormOpen ? `<form id="password-form" class="content-form"><label for="current-password">Current password</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" minlength="12" maxlength="256" required><label for="new-password">New password</label><input id="new-password" name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="256" required aria-describedby="new-password-help"><p id="new-password-help">Use at least 12 characters.</p><label for="confirm-password">Confirm new password</label><input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="256" required>${feedback}<div class="content-actions"><button class="primary" type="submit">${passwordPending ? 'Saving…' : 'Save password'}</button><button class="secondary" type="button" data-password-cancel="true">Cancel</button></div></form>` : `${feedback}<button class="secondary" data-change-password="true">Change password</button>`;
  return `<section class="settings-card" aria-labelledby="account-settings-title"><h2 id="account-settings-title">Account</h2><p>${escapeHtml(user.email)}</p>${form}</section>`;
}

async function savePassword(form) {
  if (passwordPending || !user) return;
  const currentPassword = form.elements.currentPassword.value;
  const newPassword = form.elements.newPassword.value;
  const confirmation = form.elements.confirmPassword.value;
  const current = generation;
  const revision = ++passwordRevision;
  form.reset();
  passwordFeedback = '';
  passwordFailed = false;
  if (newPassword !== confirmation) {
    passwordFeedback = 'The new passwords do not match.';
    passwordFailed = true;
    render();
    app.querySelector('#new-password')?.focus();
    return;
  }
  passwordPending = true;
  render();
  try {
    const result = await request('/api/account/password', {currentPassword, newPassword});
    if (current !== generation || revision !== passwordRevision) return;
    if (result.changed !== true) throw new Error('Unconfirmed password change.');
    passwordFormOpen = false;
    passwordFeedback = 'Password changed. Other sessions signed out.';
  } catch (error) {
    if (current !== generation || revision !== passwordRevision) return;
    if (error.status === 401) { clearAccount(); authError = 'Your session ended. Log in to continue.'; }
    else {
      passwordFailed = true;
      passwordFeedback = !error.status || error.status >= 500
        ? 'The password change could not be confirmed. Try signing in with your new password.'
        : error.status === 409 ? 'Your account changed in another tab. Reload and try again.' : error.message;
    }
  } finally {
    if (current === generation && revision === passwordRevision) {
      passwordPending = false;
      render();
      if (passwordFormOpen) app.querySelector('#current-password')?.focus();
      else app.querySelector('[data-change-password]')?.focus();
    } else if (!user) render();
  }
}

function updateControls() {
  if (!serverBacked) return;
  app.querySelector('[data-save-status]')?.remove();
  if (user && deckLoaded && (busy || failedOperation)) {
    const panel = document.createElement('section');
    panel.className = 'save-status';
    panel.dataset.saveStatus = 'true';
    panel.setAttribute('role', failedOperation ? 'alert' : 'status');
    panel.innerHTML = failedOperation
      ? `<p>${escapeHtml(failedOperation.error)}</p>${failedOperation.conflict ? '<button class="secondary" data-reload="true">Reload saved practice</button>' : '<button class="secondary" data-retry="true">Try again</button>'}`
      : '<p>Saving…</p>';
    app.prepend(panel);
  }
  app.querySelectorAll('button, input, select').forEach(control => {
    control.disabled = Boolean(busy || failedOperation || importBusy) && !(importBusy && control.id === 'import-file') && !control.hasAttribute('data-retry') && !control.hasAttribute('data-reload') && !(importBusy && (control.hasAttribute('data-import-cancel') || control.hasAttribute('data-import-recover')));
  });
  if (passwordPending) app.querySelectorAll('#password-form button,#password-form input').forEach(control => { control.disabled = true; });
}

function savedLearningSet() {
  if (!user) return null;
  try {
    const id = localStorage.getItem(`meletio.learningSet.${user.id}`);
    return /^[a-zA-Z0-9-]{1,128}$/.test(id || '') ? id : null;
  } catch { return null; }
}

function rememberLearningSet(id) {
  if (!user) return;
  try {
    const key = `meletio.learningSet.${user.id}`;
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {}
}

async function loadPractice(nextScreen = 'study') {
  clearPasswordForm();
  stopAudio();
  clearSearchAnnouncement();
  const current = ++generation;
  busy = true;
  deckLoaded = false;
  loadError = '';
  failedOperation = null;
  screen = nextScreen;
  const selectedDeckId = deck?.id;
  render();
  try {
    if (!catalogLoaded) await refreshCatalog(current);
    if (current !== generation) return;
    let deckId = selectedDeckId || savedLearningSet() || decks[0]?.id;
    if (!deckId) { clearPractice(); deck = undefined; rememberLearningSet(null); deckLoaded = true; return; }
    let content;
    try { content = await request(`/api/decks/${encodeURIComponent(deckId)}`); }
    catch (error) {
      if (error.status !== 404 || current !== generation) throw error;
      await refreshCatalog(current);
      if (current !== generation) return;
      deckId = decks[0]?.id;
      if (!deckId) { clearPractice(); deck = undefined; rememberLearningSet(null); deckLoaded = true; return; }
      content = await request(`/api/decks/${encodeURIComponent(deckId)}`);
    }
    if (current !== generation) return;
    const result = await request(`/api/training?deckId=${encodeURIComponent(deckId)}&format=compact`);
    if (current !== generation) return;
    clearPractice();
    deck = content.deck;
    if (!decks.some(item => item.id === deck.id)) decks.push({...deck, words: undefined, wordCount: deck.words.length});
    if (result.attempt) await useAttempt(result.attempt, current);
    if (current !== generation) return;
    lastSession = result.latestResult;
    review = result.review;
    reviewLoadedAt = performance.now();
    rememberLearningSet(deck.id);
    deckLoaded = true;
  } catch (error) {
    if (current !== generation) return;
    if (error.status === 401) {
      clearAccount();
      authError = 'Your session ended. Log in to continue your saved practice.';
    } else loadError = error.message;
  } finally {
    if (current === generation) {
      busy = false;
      render();
    } else if (!user) render();
  }
}

async function initializeAccount() {
  clearPasswordForm();
  const current = ++generation;
  accountLoaded = false;
  loadError = '';
  busy = true;
  render();
  try {
    const result = await request('/api/auth/me');
    if (current !== generation) return;
    if (user?.id !== result.user.id) deck = undefined;
    user = result.user;
    accountLoaded = true;
    await loadPractice();
    await restoreActiveImport();
  } catch (error) {
    if (current !== generation) return;
    if (error.status === 401) {
      user = null;
      accountLoaded = true;
    } else loadError = error.message;
  } finally {
    if (current === generation) {
      busy = false;
      render();
    }
  }
}

async function refreshStudy(focus = false) {
  const focused = document.activeElement;
  const heading = app.contains(focused) && focused.tagName === 'H1';
  const attribute = app.contains(focused) ? ['data-start', 'data-resume', 'data-screen', 'data-results', 'data-word', 'data-logout'].find(name => focused.hasAttribute(name)) : null;
  const value = attribute ? focused.getAttribute(attribute) : null;
  const current = generation + 1;
  await loadPractice();
  if (generation !== current || screen !== 'study' || !user || loadError) return;
  if (focus || heading) focusHeading();
  else if (attribute) {
    const target = app.querySelector(`[${attribute}="${CSS.escape(value)}"]`);
    if (target) focusElement(target);
    else focusHeading();
  }
}

async function restoreActiveImport() {
  const current = generation;
  const revision = importRevision;
  try {
    const result = await request('/api/imports/current');
    if (current !== generation || revision !== importRevision || !user) return;
    const stage = result.uploadId ? result : result.stage;
    if (stage && !['cancelled', 'expired', 'committed'].includes(stage.status)) setImportStage(stage);
    if (stage?.status === 'committed' && stage.result) {
      importedDeckId = stage.result.deleted ? null : stage.result.deckId;
      importMessage = stage.result.deleted ? 'Your last imported set was deleted.' : 'Your last import was saved.';
    }
    importRecoveryNeeded = false;
  } catch (error) {
    if (current !== generation || revision !== importRevision) return;
    if (error.status === 401) { clearAccount(); authError = 'Your session ended. Log in to continue.'; }
    else importRecoveryNeeded = true;
  }
  if (current === generation) render();
}

async function runOperation(operation) {
  if (busy) return;
  const current = generation;
  busy = true;
  failedOperation = null;
  updateControls();
  try {
    const result = await request(operation.path, operation.body);
    if (current !== generation) return;
    await operation.accept(result);
  } catch (error) {
    if (current !== generation) return;
    if (error.status === 401) {
      clearAccount();
      authError = 'Your session ended. Log in to continue your saved practice.';
    } else {
      failedOperation = {...operation, error: error.status === 409 ? 'This practice changed in another tab. Reload your saved practice to continue.' : error.message, conflict: error.status >= 400 && error.status < 500 && error.status !== 429};
    }
  } finally {
    if (current === generation) {
      busy = false;
      render();
      if (!failedOperation && screen === 'practice') focusElement(document.querySelector(selected === null ? '[data-answer]' : '#continue'));
      else if (!failedOperation) focusHeading();
    } else if (!user) render();
  }
}

function saveTraining(path, body, accept) {
  return runOperation({path: path + '?format=compact', body: {...body, requestId: operationId()}, accept});
}

function afterAnswer() {
  const word = questions[position].word;
  const option = questions[position].options.find(item => String(item.id) === selected) || word;
  announceAnswer(selected === String(word.id), option, word);
  if (autoPronounce && word.audio) audio.play(word.audio, {automatic: true, wordId: word.id}).then(played => { if (played) clearNotice(); });
}


try {
  autoPronounce = localStorage.getItem('meletio.autoPronounce') === 'true';
} catch {
  storageAvailable = false;
}

const audio = new AudioController({
  createAudio: source => new Audio(source),
  onStateChange: state => {
    clearTimeout(audioLoadingTimer);
    playback = state;
    audioLoadingVisible = false;
    if (state.state === 'loading') audioLoadingTimer = setTimeout(() => {
      if (playback !== state) return;
      audioLoadingVisible = true;
      updateAudioControls();
    }, 200);
    updateAudioControls();
  },
  onError: (_error, {automatic}) => {
    if (automatic) {
      if (autoPlaybackNoticeShown) return;
      autoPlaybackNoticeShown = true;
      showNotice('Automatic audio could not play. Use Listen to try again.');
    } else {
      showNotice('Audio could not play. Please try again.');
    }
  }
});

function stopAudio() {
  audio.stop();
  audio.prepare?.(null);
  clearNotice();
}

function updateAudioControls() {
  app.querySelectorAll('[data-audio]').forEach(button => {
    const active = playback.wordId ? String(playback.wordId) === button.dataset.audio : playback.source === button.dataset.source;
    const state = active ? playback.state : 'idle';
    const playing = state === 'loading' || state === 'playing';
    const action = playing ? 'Stop recording for' : state === 'error' ? 'Retry recording for' : 'Listen to';
    button.setAttribute('aria-label', `${action} ${button.dataset.audioTerm}`);
    button.setAttribute('aria-busy', String(state === 'loading'));
    button.setAttribute('aria-pressed', String(playing));
    button.dataset.audioState = state;
    button.dataset.audioLoading = String(state === 'loading' && audioLoadingVisible);
  });
  const status = app.querySelector('#audio-status');
  if (status) status.textContent = playback.state === 'loading' && audioLoadingVisible ? 'Loading recording…' : playback.state === 'error' ? 'Recording could not play. Use Listen to try again.' : '';
}

function listenButton(word) {
  return word.audio ? `<button class="audio-button" data-audio="${escapeHtml(word.id)}" data-audio-term="${escapeHtml(word.term)}" data-source="${escapeHtml(word.audio)}" aria-label="Listen to ${escapeHtml(word.term)}" aria-busy="false" aria-pressed="false"><span data-audio-icon aria-hidden="true">${icon('sound')}</span><span data-audio-label>Listen</span></button>` : '<span class="muted no-audio">No recording</span>';
}

function prepareVisibleAudio() {
  const word = screen === 'detail' ? selectedWord : screen === 'practice' ? questions[position]?.word : null;
  if (word?.audio) audio.prepare?.(word.audio);
  updateAudioControls();
}

function showNotice(message) {
  clearNotice();
  const revision = noticeRevision;
  requestAnimationFrame(() => {
    if (revision !== noticeRevision) return;
    notice.textContent = message;
    notice.dataset.active = 'true';
  });
}

function clearNotice() {
  noticeRevision++;
  notice.textContent = '';
  delete notice.dataset.active;
}

function announceMarkup(markup) {
  announcer.replaceChildren();
  announcer.innerHTML = markup;
}

function announce(message) {
  announceMarkup(`<span lang="${escapeHtml(data.uiLanguage || 'en')}">${escapeHtml(message)}</span>`);
}

function announceAnswer(correct, selectedWord, targetWord) {
  const uiLang = escapeHtml(data.uiLanguage || 'en');
  const selectedTerm = `<bdi lang="${escapeHtml(selectedWord.termLang)}" dir="${safeDirection(exerciseDeck().termDir)}">${escapeHtml(selectedWord.term)}</bdi>`;
  const targetTerm = `<bdi lang="${escapeHtml(targetWord.termLang)}" dir="${safeDirection(exerciseDeck().termDir)}">${escapeHtml(targetWord.term)}</bdi>`;
  const meaning = `<bdi lang="${escapeHtml(targetWord.meaningLang)}" dir="${safeDirection(exerciseDeck().meaningDir)}">${escapeHtml(targetWord.meaning)}</bdi>`;
  const message = correct
    ? `<span lang="${uiLang}">Correct. </span>${targetTerm}<span lang="${uiLang}"> means </span>${meaning}.`
    : `<span lang="${uiLang}">Not quite. Your answer was </span>${selectedTerm}<span lang="${uiLang}">. The correct answer is </span>${targetTerm}<span lang="${uiLang}">, meaning </span>${meaning}.`;
  announceMarkup(message);
}

function focusElement(element) {
  if (!element) return;
  element.focus({preventScroll: true});
  element.scrollIntoView({block: 'nearest'});
}

function focusHeading() {
  const heading = app.querySelector('h1');
  if (heading) {
    heading.tabIndex = -1;
    focusElement(heading);
  }
}

function terms() {
  return (deck?.words || []).map(word => ({...word, termLang: word.termLang || deck.termLang, meaningLang: word.meaningLang || deck.meaningLang}));
}

function langName(language) {
  try { return displayNames.of(language) || language; }
  catch { return language; }
}

function safeDirection(direction) {
  return direction === 'rtl' ? 'rtl' : 'ltr';
}

function termMarkup(word, extra = '') {
  return `<bdi lang="${escapeHtml(word.termLang)}" dir="${safeDirection(exerciseDeck()?.termDir)}" ${extra}>${escapeHtml(word.term)}</bdi>`;
}

function meaningMarkup(word) {
  return `<bdi lang="${escapeHtml(word.meaningLang)}" dir="${safeDirection(exerciseDeck()?.meaningDir)}">${escapeHtml(word.meaning)}</bdi>`;
}

function chrome(content, active = 'study') {
  return `<div class="shell"><header class="topbar"><div class="brand"><span class="brandmark" aria-hidden="true">M</span>Meletio</div>${serverBacked ? `<button class="text-button account-logout" data-logout="true">Log out</button>` : '<span class="avatar" role="img" aria-label="Preview profile">Y</span>'}</header><div class="layout"><nav class="nav" aria-label="Main navigation">${[['study','book','Study'],['vocabulary','grid','Vocabulary'],['settings','settings','Settings']].map(([id, symbol, label]) => `<button data-screen="${id}" class="${active === id ? 'active' : ''}" ${active === id ? 'aria-current="page"' : ''}>${icon(symbol)}${label}</button>`).join('')}</nav><main>${content}</main></div></div>`;
}

function wordCard(word) {
  return `<button class="word-card" data-word="${escapeHtml(word.id)}"><div class="word-image">${word.image ? `<img src="${escapeHtml(word.image)}" alt="" loading="lazy">` : '<span class="missing-picture">No picture</span>'}</div><div class="word-copy"><strong>${termMarkup(word)}</strong><small>${meaningMarkup(word)}</small></div></button>`;
}

function canPractice() {
  try { return buildQuestions(terms()).length > 0; }
  catch { return false; }
}

function study() {
  if (!deck) { emptyLearningSets('study'); return; }
  const active = questions.length > 0 && position < questions.length;
  let startAction = active
    ? `<button class="primary" data-resume="true">Resume practice ${icon('arrow')}</button><button class="text-button restart" data-start="all">Start a fresh session</button>`
    : canPractice()
      ? `<button class="primary" data-start="all">Start practice ${icon('arrow')}</button>`
      : '<p class="muted">Add four distinct words with different meanings to start a quiz.</p>';
  let description = `${terms().length} words · Multiple choice`;
  if (serverBacked && review) {
    const available = review.due + review.new > 0;
    description = `${review.due} due for review · ${review.new} new words · Up to ${review.lessonSize} per lesson`;
    const next = review.nextDue === null ? '' : ` Next review: ${new Date(review.nextDue).toLocaleString()}.`;
    startAction = active
      ? `<button class="primary" data-resume="true">Resume ${attempt?.mode === 'lesson' ? 'lesson' : 'practice'} ${icon('arrow')}</button>${available ? '<button class="text-button restart" data-start="lesson">Start a fresh lesson</button>' : ''}`
      : available ? `<button class="primary" data-start="lesson">Start lesson ${icon('arrow')}</button>`
        : `<p class="muted">${canPractice() ? `Your review is up to date.${escapeHtml(next)}` : 'Add four distinct words with different meanings to start a quiz.'}</p>`;
    if (canPractice()) startAction += '<button class="text-button" data-start="all">Practice all words</button>';
  }
  app.innerHTML = chrome(`<section class="intro"><h1>Study</h1></section><section class="hero"><div class="hero-copy"><p class="eyebrow">${escapeHtml(deck.title)}</p><h2>Practice your vocabulary</h2><p>${description}</p>${startAction}</div></section>${lastSession ? `<p class="footnote">Last ${lastSession.mode === 'lesson' ? 'lesson' : 'practice'}: ${lastSession.correct} of ${lastSession.total} correct.${serverBacked ? ' <button class="text-button" data-results="true">View results</button>' : ''}</p>` : ''}<section><div class="section-title"><h2>Vocabulary</h2><button class="text-button" data-screen="vocabulary">View vocabulary →</button></div><div class="preview-grid">${terms().slice(0,3).map(wordCard).join('')}</div></section>`, 'study');
}

function emptyLearningSets(active) {
  app.innerHTML = chrome(`<section class="intro"><h1>${active === 'vocabulary' ? 'Vocabulary' : 'Study'}</h1></section><section class="hero"><div class="hero-copy"><h2>No learning sets yet</h2><p>Import an Anki file to add your vocabulary.</p><button class="primary" data-screen="settings">Import vocabulary ${icon('arrow')}</button></div></section>`, active);
}

function filterWords(query) {
  const termQuery = normalizeSearch(query, deck.termLang);
  const meaningQuery = normalizeSearch(query, deck.meaningLang);
  return terms().filter(word => normalizeSearch(word.term, word.termLang).includes(termQuery)
    || normalizeSearch(word.meaning, word.meaningLang).includes(meaningQuery));
}

let searchTimer;
function clearSearchAnnouncement() {
  clearTimeout(searchTimer);
  searchTimer = undefined;
}

function updateWordList({announceCount = false} = {}) {
  const matches = filterWords(searchQuery);
  document.querySelector('#word-grid').innerHTML = matches.length ? matches.map(wordCard).join('') : terms().length ? '<p class="empty">No words found. Try another search.</p>' : '<p class="empty">This set has no words. Import an Anki export to add vocabulary.</p>';
  clearTimeout(searchTimer);
  if (announceCount) {
    searchTimer = setTimeout(() => announce(matches.length ? `${matches.length} words found.` : 'No words found.'), 350);
  }
}

function vocabulary() {
  if (!deck) { emptyLearningSets('vocabulary'); return; }
  app.innerHTML = chrome(`<section class="intro"><h1>Vocabulary</h1><p>${terms().length} words in ${escapeHtml(deck.title)}.</p></section><label class="eyebrow" for="search">Search ${escapeHtml(langName(deck.termLang))} or ${escapeHtml(langName(deck.meaningLang))}</label><input id="search" class="search" type="search" placeholder="Find a word…" autocomplete="off" value="${escapeHtml(searchQuery)}"><div id="word-grid" class="vocabulary-grid"></div>`, 'vocabulary');
  updateWordList();
}

function contentFeedback() {
  return contentError ? `<p class="account-error" role="alert">${escapeHtml(contentError)}</p>${contentPending ? '<button class="text-button" data-content-retry="true">Retry save</button>' : ''}` : '';
}

function detail(word) {
  if (!word) { screen = 'vocabulary'; vocabulary(); return; }
  screen = 'detail';
  const editable = serverBacked && deck.editable;
  const editor = editDraft ? `<form id="word-edit-form" class="content-form"><label>Word<input name="term" required maxlength="4096" lang="${escapeHtml(word.termLang)}" dir="${safeDirection(deck.termDir)}" value="${escapeHtml(editDraft.term)}"></label><label>Translation<input name="meaning" required maxlength="4096" lang="${escapeHtml(word.meaningLang)}" dir="${safeDirection(deck.meaningDir)}" value="${escapeHtml(editDraft.meaning)}"></label>${contentFeedback()}<div class="content-actions"><button class="primary" type="submit">Save changes</button><button class="secondary" type="button" data-edit-cancel="true">Cancel</button></div></form>` : `<div class="detail-heading"><h1>${termMarkup(word)}</h1>${listenButton(word)}</div><p class="detail-meaning">${meaningMarkup(word)}</p>${contentFeedback()}${editable ? '<div class="content-actions"><button class="secondary" data-edit-word="true">Edit word</button><button class="text-button danger" data-delete-word="true">Delete word</button></div>' : ''}`;
  const confirmation = deleteConfirmation === 'word' ? `<section class="confirmation" role="alert"><p>Delete “${escapeHtml(word.term)}” from this set? Saved practice is kept.</p><div class="content-actions"><button class="primary danger-fill" data-confirm-delete-word="true">Delete word</button><button class="secondary" data-keep="true">Keep word</button></div></section>` : '';
  app.innerHTML = chrome(`<button class="text-button" data-screen="vocabulary">← Vocabulary</button>${word.image ? `<img class="detail-image" src="${escapeHtml(word.image)}" alt="">` : ''}${editor}<p id="audio-status" class="audio-status visually-hidden" role="status" aria-live="polite"></p>${confirmation}`, 'vocabulary');
}

async function mutateContent(action, values = {}) {
  if (busy || !deck?.editable) return;
  const current = generation;
  const wordId = selectedWord?.id;
  const path = `/api/decks/${encodeURIComponent(deck.id)}/${action.startsWith('word-') ? `words/${encodeURIComponent(wordId)}/${action.slice(5)}` : action}`;
  const payload = {...values, revision: deck.revision};
  const signature = JSON.stringify({path, values});
  const operation = contentPending?.signature === signature ? contentPending : {path, body: {...payload, requestId: operationId()}, signature};
  contentPending = operation;
  contentError = '';
  busy = true;
  updateControls();
  try {
    await request(operation.path, operation.body);
    if (current !== generation) return;
    contentError = '';
    if (action === 'delete') {
      await refreshCatalog(current);
      if (current !== generation) return;
      contentPending = null;
      deleteConfirmation = null;
      deck = decks[0];
      editDraft = null;
      renameDraft = null;
      busy = false;
      await loadPractice('settings');
      return;
    }
    const result = await request(`/api/decks/${encodeURIComponent(deck.id)}`);
    if (current !== generation) return;
    deck = result.deck;
    contentPending = null;
    deleteConfirmation = null;
    const summary = decks.find(item => item.id === deck.id);
    if (summary) Object.assign(summary, {title: deck.title, revision: deck.revision, wordCount: deck.words.length});
    if (action === 'word-delete') { selectedWord = undefined; editDraft = null; screen = 'vocabulary'; }
    else if (action === 'word-edit') { selectedWord = terms().find(word => word.id === wordId); editDraft = null; }
    else renameDraft = null;
    announce(action === 'rename' ? 'Set renamed.' : action === 'word-delete' ? 'Word deleted.' : 'Word saved.');
  } catch (error) {
    if (current !== generation) return;
    if (error.status === 401) { clearAccount(); authError = 'Your session ended. Log in to continue.'; }
    else {
      contentError = error.status === 409 ? 'This set changed in another tab. Your draft is kept. Review it and save again.' : error.message;
      if (error.status) contentPending = null;
      if (error.status === 409) {
        try {
          const result = await request(`/api/decks/${encodeURIComponent(deck.id)}`);
          if (current === generation) deck = result.deck;
        } catch {}
      }
    }
  } finally {
    if (current === generation) { busy = false; render(); if (contentError) app.querySelector('.content-form input')?.focus(); else focusHeading(); }
  }
}

function startPractice({resume = false, onlyMissed = false, lesson = false} = {}) {
  stopAudio();
  if (!deck) return;
  if (serverBacked) {
    if (busy || failedOperation) return;
    if (resume) {
      screen = 'practice';
      render();
      focusHeading();
    } else {
      const path = onlyMissed ? `/api/training/${attempt.id}/retry` : '/api/training';
      saveTraining(path, onlyMissed ? {} : {deckId: deck.id, ...(lesson ? {mode: 'lesson'} : {})}, async result => {
        await useAttempt(result.attempt);
        screen = 'practice';
      });
    }
    return;
  }
  if (!resume) {
    let all;
    try { all = buildQuestions(terms()); }
    catch { screen = 'study'; announce('This deck needs at least four distinct terms with different meanings.'); render(); return; }
    if (!all.length) { screen = 'study'; render(); return; }
    if (onlyMissed) {
      const missed = new Set(answers.filter(answer => !answer.correct).map(answer => answer.word.id));
      questions = all.filter(question => missed.has(question.word.id));
    } else {
      questions = all;
    }
    answers = [];
    position = 0;
    selected = null;
  }
  screen = 'practice';
  render();
  focusHeading();
}

function practice() {
  const deck = exerciseDeck();
  const question = questions[position];
  if (!question) { screen = 'results'; results(); return; }
  const {word, options} = question;
  const answered = selected !== null;
  const correct = selected === word.id;
  const speak = listenButton(word);
  app.innerHTML = `<main class="quiz-shell"><div class="quiz-top"><button class="icon-button" data-screen="study" aria-label="Leave practice">${icon('close')}</button><div class="quiz-progress"><p>${escapeHtml(deck.title)} <span class="question-count">${position + 1} / ${questions.length}</span></p><div class="track" role="progressbar" aria-label="Questions answered" aria-valuemin="0" aria-valuemax="${questions.length}" aria-valuenow="${answers.length}"><span style="width:${answers.length / questions.length * 100}%"></span></div></div></div><div class="quiz-kicker"><p class="eyebrow">CHOOSE THE ${escapeHtml(langName(deck.termLang).toUpperCase())} WORD</p><span class="muted" style="font-size:12px">Multiple choice</span></div><section class="quiz-card">${word.image ? `<div class="quiz-image-wrap"><img class="quiz-image" src="${escapeHtml(word.image)}" alt="" aria-hidden="true"></div>` : ''}<div class="prompt"><p>How do you say this in ${escapeHtml(langName(deck.termLang))}?</p><h1 id="question">${meaningMarkup(word)}</h1></div></section><div class="answers" role="group" aria-labelledby="question">${options.map((option,index) => {
    const isCorrect = answered && option.id === word.id;
    const isSelected = answered && option.id === selected;
    const result = isCorrect ? 'Correct answer' : isSelected ? 'Your answer' : '';
    return `<button class="answer ${isCorrect ? 'correct' : ''} ${isSelected && !correct ? 'incorrect' : ''}" data-answer="${escapeHtml(option.id)}" aria-disabled="${answered}"><span class="letter" aria-hidden="true">${String.fromCharCode(65 + index)}</span><span class="answer-term">${termMarkup(option)}</span>${result ? `<span class="answer-result">${result}</span>` : ''}${answered && (isCorrect || isSelected) ? `<span class="mark" aria-hidden="true">${isCorrect ? '✓' : '×'}</span>` : ''}</button>`;
  }).join('')}</div>${answered ? `<section class="feedback ${correct ? '' : 'wrong'}"><div><strong>${correct ? 'That’s right.' : 'A word to revisit.'}</strong><small>${termMarkup(word)} · ${meaningMarkup(word)}</small></div>${speak}</section>${word.audio ? '<p id="audio-status" class="audio-status visually-hidden" role="status" aria-live="polite"></p>' : ''}<button class="primary wide continue" id="continue">${position === questions.length-1 ? 'See results' : 'Continue'} ${icon('arrow')}</button>` : ''}</main>`;
}

function results() {
  const correct = answers.filter(answer => answer.correct).length;
  const missed = answers.filter(answer => !answer.correct);
  const lesson = serverBacked && attempt.mode === 'lesson';
  lastSession = serverBacked ? {id: attempt.id, deckId: attempt.deckId, correct, total: answers.length, completedAt: attempt.completedAt, ...(lesson ? {mode: 'lesson'} : {})} : {correct, total: answers.length};
  const rows = missed.map(({word}) => {
    const listen = listenButton(word);
    return `<div class="result-row">${word.image ? `<img src="${escapeHtml(word.image)}" alt="">` : ''}<div><strong>${termMarkup(word)}</strong><small>${meaningMarkup(word)}</small></div>${listen}</div>`;
  }).join('');
  app.innerHTML = `<main class="quiz-shell result"><div class="result-icon">${icon('check')}</div><h1>${lesson ? 'Lesson' : 'Practice'} complete</h1><p>${missed.length ? 'Review the words you missed.' : 'All words correct.'}</p>${lesson ? '<p class="footnote">Your answers are saved. Extra practice keeps review dates.</p>' : ''}<section class="score-panel" aria-label="Session results"><div><strong>${correct}<span style="display:inline;font-size:19px"> / ${answers.length}</span></strong><span>Correct answers</span></div><div><strong>${missed.length}</strong><span>Words to revisit</span></div></section><div class="result-actions">${missed.length ? '<button class="primary wide" data-start="mistakes">Practice missed words</button>' : lesson ? '<button class="primary wide" data-screen="study">Back to Study</button>' : '<button class="primary wide" data-start="all">Practice again</button>'}${lesson && !missed.length ? '' : '<button class="secondary wide" data-screen="study">Back to Study</button>'}</div>${missed.length ? `<section class="result-list"><div class="section-title"><h2>Another look</h2></div>${rows}<p id="audio-status" class="audio-status visually-hidden" role="status" aria-live="polite"></p></section>` : ''}</main>`;
}

function defaultMapping(fields) {
  const find = (pattern, fallback) => fields.find(field => pattern.test(field)) || fallback;
  return {term: find(/^(term|front|word|greek)$/i, fields[0] || ''), meaning: find(/^(meaning|back|translation|english)$/i, fields[1] || fields[0] || ''),
    image: find(/^(image|picture|illustration)$/i, find(/^(meaning|back|translation|english)$/i, fields[1] || null)), audio: find(/^(audio|sound)$/i, find(/^pronunciation$/i, null))};
}

function importSourceDecks(stage = importStage) {
  const ids = stage?.sourceChoices ? new Set(stage.sourceChoices.map(choice => choice.sourceDeckId)) : null;
  return (stage?.decks || []).filter(item => !item.filtered && (!ids || ids.has(item.id)));
}

function importNoteTypes(sourceDeckId = importDraft?.sourceDeckId, stage = importStage) {
  const identities = stage?.sourceIdentities || stage?.sourceChoices;
  const matching = identities?.filter(choice => !sourceDeckId || choice.sourceDeckId === sourceDeckId);
  const ids = matching?.length ? new Set(matching.map(choice => choice.noteTypeId)) : null;
  return (stage?.noteTypes || []).filter(item => item.type === 0 && (!ids || ids.has(item.id)));
}

function importSuggestion() {
  return importStage?.sourceChoices?.find(choice => choice.sourceDeckId === importDraft?.sourceDeckId && choice.noteTypeId === importDraft?.noteTypeId)?.suggestion || (importStage?.suggestion?.noteTypeId === importDraft?.noteTypeId ? importStage.suggestion : null);
}

function setImportStage(stage) {
  importRecoveryNeeded = false;
  const changed = !importStage || importStage.uploadId !== stage?.uploadId;
  importStage = stage;
  importRequestId = stage?.requestId || importRequestId;
  if (!stage) {
    importDraft = null;
    importPreview = null;
    return;
  }
  if (stage.status !== 'ready') { importDraft = null; importPreview = null; return; }
  if (changed || !importDraft) {
    const model = importNoteTypes(null, stage)[0];
    importDraft = {sourceDeckId: importSourceDecks(stage)[0]?.id || '', noteTypeId: model?.id || '', includeChildren: true,
      mapping: defaultMapping(model?.fields || []), title: importSourceDecks(stage)[0]?.name || 'Imported vocabulary',
      ...stage.suggestion,
      termLang: deck?.termLang || 'el', meaningLang: deck?.meaningLang || 'en', termDir: deck?.termDir || 'ltr', meaningDir: deck?.meaningDir || 'ltr',
      destinationDeckId: stage.matchingDestinations?.length === 1 ? stage.matchingDestinations[0].id : stage.matchingDestinations?.length > 1 ? '__choose__' : null, repairMedia: false, replaceLocalChanges: false};
    if (!importDraft.destinationDeckId && importSourceDecks(stage).length > 1) importDraft.sourceDeckId = '';
    if (!importDraft.destinationDeckId && importNoteTypes(importDraft.sourceDeckId, stage).length > 1) importDraft.noteTypeId = '';
    if (repairDestination) importDraft.destinationDeckId = repairDestination;
  }
  importPreview = stage.preview || null;
  if (importPreview) importDraft = {...importDraft, ...importPreview.source, title: importPreview.title, destinationDeckId: importPreview.destinationDeckId, repairMedia: importPreview.repairMedia || false, replaceLocalChanges: importPreview.replaceLocalChanges || false};
}

function readImportDraft() {
  const form = document.querySelector('#import-mapping');
  if (!form || !importDraft) return;
  const values = new FormData(form);
  importDraft = {sourceDeckId: values.get('sourceDeckId'), noteTypeId: values.get('noteTypeId'), includeChildren: values.has('includeChildren'),
    title: values.get('title'), termLang: values.get('termLang'), meaningLang: values.get('meaningLang'), termDir: values.get('termDir'), meaningDir: values.get('meaningDir'),
    destinationDeckId: values.get('destinationDeckId') || null,
    repairMedia: values.has('repairMedia'), replaceLocalChanges: values.has('replaceLocalChanges'),
    mapping: {term: values.get('term'), meaning: values.get('meaning'), image: values.get('image') || null, audio: values.get('audio') || null}};
}

async function importAction(operation) {
  if (busy || importBusy) return;
  const current = generation;
  const revision = ++importRevision;
  importBusy = true;
  importError = '';
  importMessage = '';
  render();
  try {
    await operation(current);
  } catch (error) {
    if (current !== generation || revision !== importRevision) return;
    if (error.status === 401) {
      clearAccount();
      authError = 'Your session ended. Log in to continue.';
    } else {
      importError = error.message;
      if (error.code === 'active_import') {
        importRequestId = null;
        importRecoveryNeeded = true;
      } else if (error.status === 410) {
        importStage = importStage ? {...importStage, status: 'expired'} : null;
        importPreview = null;
        importRequestId = null;
      } else if (error.status === 409 && ['stale_preview', 'mapping_changed', 'existing_import'].includes(error.code)) {
        importPreview = null;
        importCommit = null;
      }
    }
  } finally {
    if (current === generation && revision === importRevision) {
      importBusy = false;
      uploadController = null;
      render();
    } else if (!user) render();
  }
}

function uploadImport() {
  if (!importFile) { importError = 'Choose an .apkg deck export first.'; render(); return; }
  if (!/\.apkg$/i.test(importFile.name)) { importError = 'Choose an .apkg deck export.'; render(); return; }
  if (importFile.size > 100 * 1024 * 1024) { importError = 'Choose a package no larger than 100 MiB.'; render(); return; }
  importRequestId ||= operationId();
  const requestId = importRequestId;
  const file = importFile;
  importAction(async current => {
    uploadController = new AbortController();
    const stage = await request('/api/imports/uploads', file, {binary: true, timeout: 150000, controller: uploadController,
      headers: {'X-Import-Request-Id': requestId, 'X-Import-Filename': encodeURIComponent(file.name)}});
    if (current !== generation || requestId !== importRequestId) return;
    setImportStage(stage);
    if (stage.status === 'ready' && importDraft?.destinationDeckId && !stage.preview) await loadDestinationSource(current);
    if (current === generation && stage.status === 'ready' && !stage.preview) await requestImportPreview(current);
  });
}

function recoverImport() {
  if (busy) return;
  const current = generation;
  const revision = importRevision;
  const globalRecovery = importRecoveryNeeded;
  importError = '';
  request(`/api/imports/current${importRequestId && !importRecoveryNeeded ? `?requestId=${encodeURIComponent(importRequestId)}` : ''}`).then(async result => {
    if (current !== generation || revision !== importRevision) return;
    const stage = result.uploadId ? result : result.stage;
    if (stage?.status === 'committed' && stage.result) {
      await finishImport(stage.result, current);
      return;
    }
    if (globalRecovery) { importFile = null; importRequestId = null; importCommit = null; }
    setImportStage(stage || null);
    importMessage = stage ? `Import status: ${stage.status}.` : 'No active import was found. Choose a package to begin.';
    if (stage?.status === 'ready' && importDraft?.destinationDeckId && !stage.preview) await loadDestinationSource(current);
    if (current === generation && stage?.status === 'ready' && !stage.preview) await requestImportPreview(current);
    if (current === generation && revision === importRevision) render();
  }).catch(error => {
    if (current !== generation || revision !== importRevision) return;
    if (error.status === 401) { clearAccount(); authError = 'Your session ended. Log in to continue.'; }
    else importError = error.message;
    render();
  });
}

async function cancelImport() {
  if (busy || !user) return;
  const current = generation;
  const stageId = importStage?.uploadId;
  const requestId = importRequestId;
  if (!stageId && !requestId) return;
  const revision = ++importRevision;
  uploadController?.abort();
  uploadController = null;
  importBusy = true;
  updateControls();
  try {
    await request(stageId ? `/api/imports/${stageId}/cancel` : '/api/imports/current/cancel', stageId ? {} : {requestId});
    if (current !== generation || revision !== importRevision) return;
    setImportStage(null);
    importRequestId = null;
    importFile = null;
    importCommit = null;
    importError = '';
    importMessage = 'Import cancelled. Your learning sets were not changed.';
  } catch (error) {
    if (current !== generation || revision !== importRevision) return;
    if (error.status === 401) { clearAccount(); authError = 'Your session ended. Log in to continue.'; }
    else importError = error.message;
  } finally {
    if (current === generation && revision === importRevision) { importBusy = false; render(); }
    else if (!user) render();
  }
}

async function loadDestinationSource(current) {
  if (!importDraft?.destinationDeckId || importDraft.destinationDeckId === '__choose__') return;
  const destination = importDraft.destinationDeckId;
  const result = await request(`/api/decks/${encodeURIComponent(destination)}`);
  if (current !== generation || importDraft?.destinationDeckId !== destination) return;
  if (result.source) importDraft = {...importDraft, ...result.source, title: result.deck.title, destinationDeckId: destination, repairMedia: repairDestination === destination, replaceLocalChanges: false};
  if (importDraft.repairMedia) {
    const suggested = importSuggestion()?.mapping || defaultMapping(importStage.noteTypes.find(model => model.id === importDraft.noteTypeId)?.fields || []);
    importDraft.mapping = {...importDraft.mapping, image: suggested.image, audio: suggested.audio};
  }
}

function prefillDestination() {
  importAction(async current => { await loadDestinationSource(current); if (current === generation) await requestImportPreview(current); });
}

async function requestImportPreview(current) {
  if (!importStage || !importDraft || !importDraft.sourceDeckId || !importDraft.noteTypeId || importDraft.destinationDeckId === '__choose__') return;
  const uploadId = importStage.uploadId;
  const draft = structuredClone(importDraft);
  const result = await request(`/api/imports/${uploadId}/preview`, draft);
  if (current !== generation || importStage?.uploadId !== uploadId) return;
  importPreview = result;
  importCommit = null;
}

function invalidateImportPreview() {
  importPreview = null;
  importCommit = null;
  app.querySelector('.import-report')?.remove();
  const form = app.querySelector('#import-mapping');
  if (form && !form.querySelector('button[type="submit"]')) form.insertAdjacentHTML('beforeend', '<button class="secondary" type="submit">Preview import</button>');
}

function previewImport() {
  readImportDraft();
  const form = document.querySelector('#import-mapping');
  if (!form?.reportValidity() || !importStage) return;
  importAction(requestImportPreview);
}

function commitImport() {
  if (!importPreview || !importStage) return;
  const consent = document.querySelector('#import-accept-skipped')?.checked || false;
  const requiresConsent = importPreview.report.skipped > 0 || importPreview.report.warnings.length > 0;
  if (requiresConsent && !consent) { importError = 'Confirm the skipped notes and media warnings before importing.'; render(); return; }
  importCommit ||= {previewId: importPreview.previewId, requestId: operationId(), acceptSkipped: consent};
  const body = importCommit;
  const uploadId = importStage.uploadId;
  importAction(async current => {
    const result = await request(`/api/imports/${uploadId}/commit`, body);
    if (current !== generation) return;
    await finishImport(result, current);
  });
}

async function finishImport(result, current) {
  importStage = null;
  importDraft = null;
  importPreview = null;
  importFile = null;
  importRequestId = null;
  importCommit = null;
  importMessage = result.deleted ? 'This imported set was deleted. Choose a file to create a new set.' : 'Learning set saved.';
  importedDeckId = result.deleted ? null : result.deckId;
  repairDestination = null;
  await refreshCatalog(current);
  if (current !== generation) return;
  deck = result.deleted ? decks[0] : {id: result.deckId};
  importBusy = false;
  await loadPractice('settings');
}

async function chooseImportFile(file) {
  if (!file) return;
  const current = generation;
  const choice = ++importChoiceRevision;
  if (importStage && ['expired', 'cancelled'].includes(importStage.status)) { setImportStage(null); importRequestId = null; }
  if (importStage || importRequestId) {
    await cancelImport();
    if (current !== generation || choice !== importChoiceRevision || importStage || importRequestId || !user) return;
  }
  importFile = file;
  importRequestId = null;
  importError = '';
  importMessage = '';
  importedDeckId = null;
  uploadImport();
}

function importSettings() {
  const ready = importStage?.status === 'ready';
  let mapping = '';
  if (ready && importDraft) {
    const draft = importDraft;
    const model = importStage.noteTypes.find(model => model.id === draft.noteTypeId);
    const option = (value, title, selected) => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(title)}</option>`;
    const field = (name, title, selected, optional = false) => `<label>${title}<select name="${name}" ${optional ? '' : 'required'}>${optional ? option('', 'None', selected || '') : ''}${(model?.fields || []).map(value => option(value, value, selected)).join('')}</select></label>`;
    const destinations = new Map([...decks.filter(item => item.imported), ...(importStage.matchingDestinations || [])].map(item => [item.id, item]));
    const chooseDestination = importStage.matchingDestinations?.length > 1;
    const chooseSource = !draft.destinationDeckId && importSourceDecks().length > 1;
    const destination = `<label>Save to<select name="destinationDeckId">${chooseDestination ? option('__choose__', 'Choose a learning set', draft.destinationDeckId) : ''}${option('', 'New private learning set', draft.destinationDeckId || '')}${[...destinations.values()].map(item => option(item.id, `Update ${item.title}`, draft.destinationDeckId)).join('')}</select></label>`;
    const source = `<label>Source deck<select name="sourceDeckId" required>${option('', 'Choose a deck', draft.sourceDeckId)}${(chooseSource ? importSourceDecks() : importStage.decks.filter(item => !item.filtered)).map(item => option(item.id, item.name, draft.sourceDeckId)).join('')}</select></label>`;
    const noteType = `<label>Note type<select name="noteTypeId" required>${option('', 'Choose a note type', draft.noteTypeId)}${importNoteTypes().map(item => option(item.id, item.name, draft.noteTypeId)).join('')}</select></label>`;
    mapping = `<form id="import-mapping" class="import-mapping">${chooseDestination ? destination : ''}${chooseSource ? source : ''}${importNoteTypes().length > 1 ? noteType : ''}<details class="import-options" ${app.querySelector('.import-options')?.open ? 'open' : ''}><summary>Advanced options</summary><div class="import-mapping">${!chooseDestination ? destination : ''}${!chooseSource ? source : ''}${importNoteTypes().length <= 1 ? noteType : ''}<label>Learning set title<input name="title" maxlength="120" required value="${escapeHtml(draft.title)}"></label><label class="import-check"><input type="checkbox" name="includeChildren" ${draft.includeChildren ? 'checked' : ''}> Include child decks</label>${field('term', 'Word', draft.mapping.term)}${field('meaning', 'Translation', draft.mapping.meaning)}${field('image', 'Picture', draft.mapping.image, true)}${field('audio', 'Recording', draft.mapping.audio, true)}${draft.destinationDeckId && draft.destinationDeckId !== '__choose__' ? `<label class="import-check"><input type="checkbox" name="repairMedia" ${draft.repairMedia ? 'checked' : ''}> Restore missing pictures and recordings only</label><label class="import-check"><input type="checkbox" name="replaceLocalChanges" ${draft.replaceLocalChanges ? 'checked' : ''}> Replace my edits and deleted words from Anki</label><p>Your edits and deleted words are kept unless you choose to replace them.</p>` : ''}<div class="import-language-pair"><label>Word language code<input name="termLang" maxlength="64" required value="${escapeHtml(draft.termLang)}"></label><label>Translation language code<input name="meaningLang" maxlength="64" required value="${escapeHtml(draft.meaningLang)}"></label><label>Word direction<select name="termDir">${option('ltr', 'Left to right', draft.termDir)}${option('rtl', 'Right to left', draft.termDir)}</select></label><label>Translation direction<select name="meaningDir">${option('ltr', 'Left to right', draft.meaningDir)}${option('rtl', 'Right to left', draft.meaningDir)}</select></label></div></div></details>${!importPreview ? '<button class="secondary" type="submit">Preview import</button>' : ''}</form>`;
  }
  const preview = importPreview;
  let report = '';
  if (ready && preview) {
    const counts = preview.report;
    const warnings = [...counts.warnings, ...counts.issues.map(issue => issue.message)];
    const consent = counts.skipped > 0 || counts.warnings.length > 0;
    const destination = decks.find(item => item.id === preview.destinationDeckId) || importStage.matchingDestinations?.find(item => item.id === preview.destinationDeckId);
    const changes = [['added','New'],['updated','Updated'],['retained','Kept from your set'],['skipped','Skipped'],['older','Older in Anki'],['conflicting','Conflicting'],['localEdits','Local edits kept'],['locallyDeleted','Deleted words kept out'],['restored','Restored from Anki']].filter(([key]) => counts[key] > 0);
    report = `<section class="import-report" aria-label="Import preview"><h3>${preview.destinationDeckId ? `Update ${escapeHtml(destination?.title || preview.title)}` : escapeHtml(preview.title)}</h3>${preview.repairMedia ? '<p>Restore missing media. Your words and practice are kept.</p>' : ''}${counts.media ? `<p class="import-media-summary"><strong>${counts.media.total} words · ${counts.media.images} pictures · ${counts.media.audio} recordings</strong></p>${counts.media.unselectedImages || counts.media.unselectedAudio ? '<p role="alert">Some media is in another field. Check Picture and Recording in Advanced options.</p>' : ''}` : ''}${changes.length ? `<dl class="import-counts">${changes.map(([key,title]) => `<div><dt>${title}</dt><dd>${counts[key]}</dd></div>`).join('')}</dl>` : '<p>No word changes.</p>'}${warnings.length ? `<details><summary>Warnings and skipped notes (${warnings.length} shown)</summary><ul>${warnings.map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul></details>` : ''}${!preview.practiceAvailable ? '<p>Practice needs four distinct words with different translations.</p>' : ''}<div class="import-samples">${preview.samples.slice(0,3).map(sample => `<article>${sample.image ? `<img src="${escapeHtml(sample.image)}" alt="">` : ''}<strong dir="${safeDirection(importDraft.termDir)}">${escapeHtml(sample.term)}</strong><p dir="${safeDirection(importDraft.meaningDir)}">${escapeHtml(sample.meaning)}</p>${sample.audio ? `<audio controls preload="none" src="${escapeHtml(sample.audio)}" aria-label="Recording for ${escapeHtml(sample.term)}"></audio>` : ''}</article>`).join('')}</div>${consent ? `<label class="import-check"><input id="import-accept-skipped" type="checkbox" ${importCommit?.acceptSkipped ? 'checked' : ''}> Continue with these skipped notes and media warnings</label>` : ''}<button class="primary wide" data-import-commit="true">${importCommit && importError ? 'Retry save' : preview.destinationDeckId ? 'Update' : 'Import'}</button></section>`;
  }
  const recoverable = Boolean(importRecoveryNeeded || importError && importRequestId || importStage && ['uploading', 'inspecting'].includes(importStage.status));
  return `<section class="settings-card import-card"><h2>${repairDestination ? 'Restore missing media' : 'Import from Anki'}</h2><p>${repairDestination ? 'Choose the Anki export containing this set’s pictures and recordings.' : 'Choose an Anki deck export (.apkg), then review and save.'}</p>${importError ? `<p class="account-error" role="alert">${escapeHtml(importError)}</p>` : ''}${importMessage ? `<p role="status">${escapeHtml(importMessage)}</p>` : ''}${importBusy || importStage && ['uploading', 'inspecting'].includes(importStage.status) ? '<p role="status">Preparing your import…</p>' : ''}${importedDeckId ? `<div class="content-actions"><button class="secondary" data-import-view="true">View vocabulary</button>${importedDeckId === deck?.id && canPractice() ? '<button class="primary" data-start="all">Start practice</button>' : ''}</div>` : ''}<label class="import-file-label" for="import-file">${importStage || importRequestId ? 'Choose another Anki file' : 'Choose Anki file'}<input id="import-file" type="file" accept=".apkg"></label><div class="import-actions">${recoverable ? `<button class="secondary" data-import-recover="true">Check import status</button>${importFile && !importStage ? '<button class="text-button" data-import-upload="true">Retry upload</button>' : ''}` : ''}${importStage || importRequestId ? '<button class="text-button" data-import-cancel="true">Cancel import</button>' : ''}</div>${mapping}${report}<details class="import-help"><summary>Import help</summary><p>Up to 100 MiB per export, 2,000 selected notes and 512 KiB per saved picture or recording. Supported large pictures resize automatically. Previews expire after 30 minutes. Anki review history is unchanged.</p>${importFile ? `<p>File: ${escapeHtml(importFile.name)}</p>` : ''}${preview ? `<p>${preview.report.media?.resizedImages || 0} pictures resized. ${preview.report.media?.withoutImage || 0} words without a picture; ${preview.report.media?.withoutAudio || 0} without a recording.</p>` : ''}</details></section>`;
}

function settings() {
  const management = serverBacked && deck?.editable ? `<section class="settings-card"><h2>Manage ${escapeHtml(deck.title)}</h2>${renameDraft !== null ? `<form id="deck-rename-form" class="content-form"><label>Set name<input name="title" maxlength="120" required value="${escapeHtml(renameDraft)}"></label>${contentFeedback()}<div class="content-actions"><button class="primary" type="submit">Save name</button><button class="secondary" type="button" data-rename-cancel="true">Cancel</button></div></form>` : `<div class="content-actions"><button class="secondary" data-rename-set="true">Rename set</button>${deck.imported ? '<button class="text-button" data-restore-media="true">Restore missing media</button>' : ''}<button class="text-button danger" data-delete-set="true">Delete set</button></div>${contentFeedback()}`}${deleteConfirmation === 'set' ? `<section class="confirmation" role="alert"><p>Delete “${escapeHtml(deck.title)}” from your learning sets? Your practice history${deck.imported ? ' and Anki export are' : ' is'} kept.</p><div class="content-actions"><button class="primary danger-fill" data-confirm-delete-set="true">Delete set</button><button class="secondary" data-keep="true">Keep set</button></div></section>` : ''}</section>` : '';
  app.innerHTML = chrome(`<section class="intro"><h1>Settings</h1></section><div class="settings-stack"><section class="settings-card"><h2 id="learning-set-label">Learning set</h2>${!decks.length ? '<p>No learning sets yet. Import an Anki file below.</p>' : ''}<div class="deck-options" role="radiogroup" aria-labelledby="learning-set-label">${decks.map(option => `<label class="deck-option ${option.id === deck?.id ? 'selected' : ''}"><input type="radio" name="learning-set" value="${escapeHtml(option.id)}" ${option.id === deck?.id ? 'checked' : ''}><span><strong>${escapeHtml(option.title)}</strong><small>${escapeHtml(langName(option.termLang))} → ${escapeHtml(langName(option.meaningLang))}${!option.imported ? ' · Default' : ''}</small></span></label>`).join('')}</div>${serverBacked && catalogCursor ? '<button class="text-button" data-catalog-more="true">Load more learning sets</button>' : ''}</section>${management}${serverBacked ? accountSettings() : ''}<section class="settings-card"><h2>Pronunciation</h2><label class="switch-row" for="auto-pronounce"><span><strong>Play after I answer</strong></span><input id="auto-pronounce" type="checkbox" role="switch" ${autoPronounce ? 'checked' : ''}></label>${storageAvailable ? '' : '<p class="storage-note">This choice lasts for this visit.</p>'}</section>${serverBacked ? importSettings() : ''}${serverBacked ? '' : '<p class="settings-footnote">Practice resets when this preview reloads.</p>'}</div>`, 'settings');
}

function render() {
  clearTimeout(reviewTimer);
  if (!user || screen !== 'settings') clearPasswordForm();
  if (serverBacked && (!accountLoaded || !user || !deckLoaded)) {
    accountView();
    updateControls();
    return;
  }
  if (!deck && !['study', 'vocabulary', 'settings'].includes(screen)) screen = 'study';
  if (screen === 'study') study();
  else if (screen === 'vocabulary') vocabulary();
  else if (screen === 'detail') detail(selectedWord);
  else if (screen === 'practice') practice();
  else if (screen === 'results') results();
  else if (screen === 'settings') settings();
  updateControls();
  prepareVisibleAudio();
  if (serverBacked && user && screen === 'study' && !busy && !failedOperation && !document.hidden && review && review.nextDue !== null && review.nextDue > review.asOf) {
    reviewTimer = setTimeout(() => { if (!busy && !failedOperation && screen === 'study') refreshStudy(); }, Math.min(Math.max(1000, review.nextDue - review.asOf - (performance.now() - reviewLoadedAt)), 2147483647));
  }
}

let selectedWord;
app.addEventListener('input', event => {
  if (event.target.closest('#word-edit-form') && editDraft) { editDraft = {term: app.querySelector('[name=term]').value, meaning: app.querySelector('[name=meaning]').value}; }
  if (event.target.closest('#deck-rename-form')) renameDraft = event.target.value;
  if (serverBacked && event.target.closest('#import-mapping')) { readImportDraft(); invalidateImportPreview(); }
  if (event.target.id === 'search') {
    searchQuery = event.target.value;
    updateWordList({announceCount: true});
  }
});

app.addEventListener('change', event => {
  if (serverBacked && event.target.id === 'import-file' && !busy && !failedOperation) { chooseImportFile(event.target.files[0]); return; }
  if (serverBacked && (busy || failedOperation || importBusy)) return;
  if (serverBacked && event.target.id === 'import-accept-skipped') { importCommit = null; return; }
  if (serverBacked && event.target.closest('#import-mapping')) {
    readImportDraft();
    invalidateImportPreview();
    if (event.target.name === 'sourceDeckId') {
      const models = importNoteTypes();
      importDraft.noteTypeId = models.length === 1 ? models[0].id : '';
      importDraft.mapping = importSuggestion()?.mapping || defaultMapping(models.length === 1 ? models[0].fields : []);
      if (!importDraft.destinationDeckId) importDraft.title = importSourceDecks().find(item => item.id === importDraft.sourceDeckId)?.name || importDraft.title;
      render();
      importAction(requestImportPreview);
    } else if (event.target.name === 'noteTypeId') {
      importDraft.mapping = importSuggestion()?.mapping || defaultMapping(importStage.noteTypes.find(model => model.id === importDraft.noteTypeId)?.fields || []);
      render();
      importAction(requestImportPreview);
    } else if (event.target.name === 'repairMedia' && importDraft.repairMedia) {
      const suggested = importSuggestion()?.mapping || defaultMapping(importStage.noteTypes.find(model => model.id === importDraft.noteTypeId)?.fields || []);
      importDraft.mapping = {...importDraft.mapping, image: suggested.image, audio: suggested.audio};
      render();
    } else if (event.target.name === 'destinationDeckId') prefillDestination();
    return;
  }
  if (event.target.name === 'learning-set') {
    stopAudio();
    editDraft = null; renameDraft = null; deleteConfirmation = null; contentError = ''; contentPending = null;
    if (serverBacked) {
      deck = {id: event.target.value};
      clearPractice();
      clearSearchAnnouncement();
      loadPractice('settings');
      return;
    }
    deck = decks.find(item => item.id === event.target.value) || decks[0];
    questions = [];
    answers = [];
    position = 0;
    selected = null;
    lastSession = null;
    searchQuery = '';
    clearSearchAnnouncement();
    screen = 'settings';
    render();
    document.querySelector('[name="learning-set"]:checked')?.focus();
    announce(`${deck.title} selected. Previous preview session was cleared.`);
  } else if (event.target.id === 'auto-pronounce') {
    autoPronounce = event.target.checked;
    try { localStorage.setItem('meletio.autoPronounce', String(autoPronounce)); }
    catch { storageAvailable = false; }
    if (!storageAvailable) {
      settings();
      document.querySelector('#auto-pronounce').focus();
    }
    announce(autoPronounce ? 'Automatic pronunciation on.' : 'Automatic pronunciation off.');
  }
});

app.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (serverBacked) {
    if (button.dataset.importCancel) { cancelImport(); return; }
    if (button.dataset.importRecover) { recoverImport(); return; }
    if (busy || importBusy) return;
    if (button.dataset.retry) {
      if (failedOperation) runOperation(failedOperation);
      return;
    }
    if (button.dataset.reload) {
      if (user && accountLoaded) loadPractice('study');
      else initializeAccount();
      return;
    }
    if (failedOperation) return;
    if (button.dataset.changePassword && user) { clearPasswordForm(); passwordFormOpen = true; render(); app.querySelector('#current-password')?.focus(); return; }
    if (button.dataset.passwordCancel) { clearPasswordForm(); render(); app.querySelector('[data-change-password]')?.focus(); return; }
    if (button.dataset.editWord) { stopAudio(); editDraft = {term: selectedWord.term, meaning: selectedWord.meaning}; contentError = ''; render(); app.querySelector('[name=term]')?.focus(); return; }
    if (button.dataset.editCancel) { editDraft = null; contentError = ''; contentPending = null; selectedWord = terms().find(word => word.id === selectedWord?.id); if (!selectedWord) screen = 'vocabulary'; render(); focusHeading(); return; }
    if (button.dataset.renameSet) { renameDraft = deck.title; contentError = ''; render(); app.querySelector('#deck-rename-form input')?.focus(); return; }
    if (button.dataset.renameCancel) { renameDraft = null; contentError = ''; contentPending = null; render(); return; }
    if (button.dataset.deleteWord || button.dataset.deleteSet) { deleteConfirmation = button.dataset.deleteWord ? 'word' : 'set'; render(); app.querySelector('.confirmation button')?.focus(); return; }
    if (button.dataset.keep) { deleteConfirmation = null; render(); return; }
    if (button.dataset.confirmDeleteWord) { stopAudio(); mutateContent('word-delete'); return; }
    if (button.dataset.confirmDeleteSet) { stopAudio(); mutateContent('delete'); return; }
    if (button.dataset.contentRetry) {
      if (editDraft) mutateContent('word-edit', editDraft);
      else if (renameDraft !== null) mutateContent('rename', {title: renameDraft});
      else mutateContent(deleteConfirmation === 'word' ? 'word-delete' : 'delete');
      return;
    }
    if (button.dataset.restoreMedia && deck?.imported) { repairDestination = deck.id; render(); app.querySelector('#import-file')?.click(); return; }
    if (button.dataset.importView) {
      if (importedDeckId && deck?.id !== importedDeckId) { deck = {id: importedDeckId}; loadPractice('vocabulary'); return; }
      screen = 'vocabulary'; render(); focusHeading(); return;
    }
    if (button.dataset.accountMode) {
      if (!registrationOpen && !registering) return;
      accountEmail = document.querySelector('#account-email')?.value || accountEmail;
      registering = !registering;
      authError = '';
      render();
      document.querySelector('#account-email')?.focus();
      return;
    }
    if (button.dataset.logout) {
      clearPasswordForm();
      stopAudio();
      runOperation({path: '/api/auth/logout', body: {}, accept: () => clearAccount()});
      return;
    }
    if (button.dataset.catalogMore) {
      runOperation({path: `/api/decks?cursor=${encodeURIComponent(catalogCursor)}`, body: undefined, accept: result => {
        for (const item of result.decks) if (!decks.some(existing => existing.id === item.id)) decks.push(item);
        catalogCursor = result.nextCursor;
      }});
      return;
    }
    if (button.dataset.importPreview) { previewImport(); return; }
    if (button.dataset.importCommit) { commitImport(); return; }
    if (button.dataset.importUpload) { uploadImport(); return; }
    if (button.dataset.results) {
      runOperation({path: `/api/training/${lastSession.id}?format=compact`, body: undefined, accept: async result => {
        await useAttempt(result.attempt);
        screen = 'results';
      }});
      return;
    }
    if (!user || !deckLoaded) return;
    if (button.dataset.screen === 'study') {
      stopAudio();
      refreshStudy(true);
      return;
    }
  }
  if (button.dataset.screen) {
    clearSearchAnnouncement();
    stopAudio();
    const previousScreen = screen;
    editDraft = null; renameDraft = null; deleteConfirmation = null; contentError = ''; contentPending = null;
    if (screen === 'vocabulary' && button.dataset.screen !== 'vocabulary') {
      searchQuery = document.querySelector('#search')?.value ?? searchQuery;
    }
    if (button.dataset.screen === 'vocabulary' && screen !== 'detail') returnWordId = undefined;
    screen = button.dataset.screen;
    render();
    if (screen === 'vocabulary') {
      if (previousScreen === 'detail') {
        window.scrollTo(0, returnScrollY);
        requestAnimationFrame(() => {
          const card = app.querySelector(`[data-word="${CSS.escape(returnWordId)}"]`);
          if (card) focusElement(card);
        });
      } else {
        focusHeading();
      }
    } else {
      focusHeading();
    }
  } else if (button.dataset.start) {
    startPractice({onlyMissed: button.dataset.start === 'mistakes', lesson: button.dataset.start === 'lesson'});
  } else if (button.dataset.resume) {
    startPractice({resume: true});
  } else if (button.dataset.word) {
    clearSearchAnnouncement();
    stopAudio();
    searchQuery = document.querySelector('#search')?.value ?? searchQuery;
    editDraft = null; deleteConfirmation = null; contentError = ''; contentPending = null;
    selectedWord = terms().find(word => String(word.id) === button.dataset.word);
    returnWordId = String(button.dataset.word);
    returnScrollY = window.scrollY;
    screen = 'detail';
    render();
    focusHeading();
  } else if (button.dataset.answer && selected === null) {
    if (serverBacked) {
      saveTraining(`/api/training/${attempt.id}/answer`, {position, optionId: button.dataset.answer, revision: attempt.revision}, async result => {
        await useAttempt(result.attempt);
        afterAnswer();
      });
      return;
    }
    const option = questions[position].options.find(word => String(word.id) === button.dataset.answer);
    if (!option) return;
    selected = String(option.id);
    const word = questions[position].word;
    answers.push({word, correct: selected === String(word.id)});
    const automaticPlayback = autoPronounce && word.audio
      ? audio.play(word.audio, {automatic: true, wordId: word.id}).then(played => {
        if (played) clearNotice();
        return played;
      })
      : Promise.resolve(false);
    practice();
    prepareVisibleAudio();
    const selectedOption = questions[position].options.find(option => String(option.id) === selected);
    announceAnswer(selected === String(word.id), selectedOption || word, word);
    const continueButton = document.querySelector('#continue');
    focusElement(continueButton);
    automaticPlayback.catch(() => {});
  } else if (button.id === 'continue') {
    stopAudio();
    if (serverBacked) {
      saveTraining(`/api/training/${attempt.id}/advance`, {position, revision: attempt.revision}, async result => {
        await useAttempt(result.attempt);
        screen = attempt.status === 'completed' ? 'results' : 'practice';
      });
      return;
    }
    if (position === questions.length - 1) { position = questions.length; screen = 'results'; }
    else { position++; selected = null; screen = 'practice'; }
    render();
    if (screen === 'results') focusHeading();
    else focusElement(document.querySelector('[data-answer]'));
  } else if (button.dataset.audio) {
    const word = (serverBacked && attemptDeck && (screen === 'practice' || screen === 'results') ? attemptDeck.words : terms()).find(item => String(item.id) === button.dataset.audio);
    if (button.dataset.audioState === 'playing' || button.dataset.audioState === 'loading') { audio.stop(); return; }
    if (word?.audio) audio.play(word.audio, {wordId: word.id}).then(played => {
      if (played) clearNotice();
    });
  }
});

app.addEventListener('submit', async event => {
  if (event.target.id === 'password-form') { event.preventDefault(); savePassword(event.target); return; }
  if (event.target.id === 'word-edit-form') { event.preventDefault(); mutateContent('word-edit', editDraft); return; }
  if (event.target.id === 'deck-rename-form') { event.preventDefault(); mutateContent('rename', {title: renameDraft}); return; }
  if (event.target.id === 'import-mapping') { event.preventDefault(); previewImport(); return; }
  if (event.target.id !== 'account-form') return;
  event.preventDefault();
  if (busy) return;
  const current = generation;
  accountEmail = event.target.elements.email.value;
  const password = event.target.elements.password.value;
  authError = '';
  busy = true;
  updateControls();
  try {
    const result = await request(`/api/auth/${registering ? 'register' : 'login'}`, {email: accountEmail, password});
    if (current !== generation) return;
    user = result.user;
    deck = undefined;
    clearPractice();
    accountLoaded = true;
    catalogLoaded = false;
    await loadPractice();
    await restoreActiveImport();
  } catch (error) {
    if (current !== generation) return;
    authError = error.message;
  } finally {
    if (current === generation) {
      busy = false;
      render();
      if (!user) document.querySelector('#account-password')?.focus();
    }
  }
});

let returnWordId;
let returnScrollY = 0;
let noticeRevision = 0;

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopAudio(); clearTimeout(reviewTimer); }
  else if (serverBacked && user && screen === 'study' && !busy && !failedOperation) refreshStudy();
});
window.addEventListener('pagehide', () => {
  clearTimeout(reviewTimer);
  stopAudio();
  clearPasswordForm();
  const loginPassword = app.querySelector('#account-password');
  if (loginPassword) loginPassword.value = '';
});
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    clearPasswordForm();
    if (serverBacked && user && screen === 'study' && !busy && !failedOperation) refreshStudy();
    else render();
  }
});

if (serverBacked) {
  document.querySelector('.prototype-label').textContent = 'Private vocabulary and practice';
  loadRegistrationConfig();
  initializeAccount();
} else render();
