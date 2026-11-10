async (page, options = {}) => {
  const launch = new URL(page.url());
  const root = options.url || launch.searchParams.get('testUrl') || 'http://127.0.0.1:4173/';
  const packagePath = options.packagePath || launch.searchParams.get('testPackage');
  if (!packagePath) throw new Error('Provide a synthetic packagePath for empty-catalog import verification');
  const context = await page.context().browser().newContext({viewport: {width: 390, height: 844}});
  page = await context.newPage();
  const passed = []; const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const ready = () => page.waitForFunction(() => user && deckLoaded && !busy && !failedOperation);
  const nav = name => page.locator(`[aria-label="Main navigation"] [data-screen="${name}"]`).click();
  const password = 'synthetic browser test password';
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const firstEmail = `follow-up-a-${unique}@example.test`;
  const secondEmail = `follow-up-b-${unique}@example.test`;
  const signIn = async (email, register = false) => {
    if (register) await page.locator('[data-account-mode]').click();
    await page.locator('#account-email').fill(email);
    await page.locator('#account-password').fill(password);
    await page.locator('#account-form button[type=submit]').click();
    await ready();
  };
  const logout = async () => {
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
  };
  const select = async id => {
    await nav('settings');
    await page.locator(`[name=learning-set][value="${id}"]`).check();
    await ready();
  };
  try {
    await page.goto(root);
    await page.locator('#account-form').waitFor();
    await signIn(firstEmail, true);
    const original = await page.evaluate(() => ({id: deck.id, title: deck.title, word: terms()[0]}));
    check(original.id === 'everyday-el', 'Expected the bundled Greek set for the first account');

    for (const viewport of [{width: 320, height: 568}, {width: 390, height: 844}, {width: 768, height: 844}, {width: 1280, height: 900}]) {
      await page.setViewportSize(viewport);
      check(await page.locator('.hero img,.hero-art').count() === 0, 'Study still has decorative image artwork');
      check(await page.locator('.preview-grid img').count() > 0, 'Actual vocabulary illustrations disappeared');
      const geometry = await page.evaluate(() => {
        const hero = document.querySelector('.hero').getBoundingClientRect();
        const vocabulary = document.querySelector('.preview-grid').getBoundingClientRect();
        return {overflow: document.documentElement.scrollWidth > innerWidth, aligned: Math.abs(hero.x - vocabulary.x) < 1 && Math.abs(hero.width - vocabulary.width) < 1};
      });
      check(!geometry.overflow && geometry.aligned, `Study layout is misaligned or overflows at ${viewport.width}px`);
      await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `RTL Study overflows at ${viewport.width}px`);
      await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
      if (options.screenshotDirectory) await page.screenshot({path: `${options.screenshotDirectory}/study-${viewport.width}.png`, fullPage: true});
    }
    await page.setViewportSize({width: 390, height: 844});
    passed.push('Study has no decorative artwork; vocabulary illustrations and aligned four-size/RTL layout remain');

    await nav('vocabulary');
    await page.locator('.word-card').first().click();
    await page.locator('[data-edit-word]').click();
    await page.locator('#word-edit-form [name=term]').fill(`${original.word.term} local`);
    await page.locator('#word-edit-form [name=meaning]').fill('Private default translation');
    await page.locator('#word-edit-form button[type=submit]').click();
    await page.locator('.detail-heading').waitFor();
    await ready();
    check((await page.locator('.detail-heading').innerText()).includes('local'), 'Default Greek word edit was not shown');
    await nav('settings');
    check(await page.locator('[data-restore-media]').count() === 0, 'Default set exposes Anki media repair');
    await page.locator('[data-rename-set]').click();
    await page.locator('#deck-rename-form [name=title]').fill('My Greek words');
    await page.locator('#deck-rename-form button[type=submit]').click();
    await ready();
    await page.waitForFunction(() => deck.title === 'My Greek words');
    await select('demo-ar');
    const arabic = await page.evaluate(() => ({title: deck.title, word: terms()[0], count: terms().length}));
    await nav('vocabulary');
    await page.locator('.word-card').first().click();
    await page.locator('[data-edit-word]').click();
    await page.locator('#word-edit-form [name=meaning]').fill('Private Arabic translation');
    await page.locator('#word-edit-form button[type=submit]').click();
    await page.locator('.detail-heading').waitFor();
    await ready();
    await page.locator('[data-delete-word]').click();
    await page.locator('[data-confirm-delete-word]').click();
    await ready();
    await page.waitForFunction(count => terms().length === count - 1, arabic.count);
    await page.reload();
    await ready();
    check(await page.evaluate(count => deck.id === 'demo-ar' && terms().length === count - 1, arabic.count), 'Reload did not restore the selected Arabic set');
    await select('everyday-el');
    check(await page.evaluate(() => deck.id === 'everyday-el' && deck.title === 'My Greek words' && terms()[0].meaning === 'Private default translation'), 'Default edits/rename did not survive reload');
    await select('demo-ar');
    check(await page.evaluate(id => !terms().some(word => word.id === id), arabic.word.id), 'Default word deletion did not survive reload');
    passed.push('both default sets support editing, rename and word deletion, persisting across reload');

    await logout();
    await signIn(secondEmail, true);
    check(await page.evaluate(value => deck.title === value.title && terms()[0].term === value.word.term && terms()[0].meaning === value.word.meaning, original), 'First account edits leaked to second account Greek content');
    await select('demo-ar');
    check(await page.evaluate(value => deck.title === value.title && terms().length === value.count && terms()[0].meaning === value.word.meaning, arabic), 'First account deletion/edit leaked to second account Arabic content');
    for (let index = 0; index < 2; index++) {
      await page.locator('[data-delete-set]').click();
      check(!(await page.locator('.confirmation').innerText()).includes('Anki'), 'Default-set confirmation mentions an Anki export');
      await page.locator('[data-confirm-delete-set]').click();
      await ready();
    }
    check(await page.locator('[name=learning-set]').count() === 0, 'Last deleted default set remains selectable');
    check(await page.locator('#import-file').isVisible(), 'Empty Settings has no usable import');
    await page.reload();
    await ready();
    check(await page.locator('h2').filter({hasText: 'No learning sets yet'}).count() === 1, 'Empty Study is a loading/error page');
    check(await page.locator('[data-reload]').count() === 0, 'Empty catalog incorrectly offers a failed-load retry');
    await nav('vocabulary');
    check(await page.locator('h2').filter({hasText: 'No learning sets yet'}).count() === 1, 'Empty Vocabulary is broken');
    await page.locator('.hero [data-screen=settings]').click();
    check(await page.locator('#import-file').isVisible(), 'Empty-catalog CTA does not reach import');
    await page.locator('#import-file').setInputFiles(packagePath);
    await page.waitForFunction(() => importPreview || importError || importStage?.status === 'failed');
    check(await page.locator('[data-import-commit]').isVisible(), `Empty-catalog import did not reach preview: ${await page.evaluate(() => importError)}`);
    await page.locator('[data-import-commit]').click();
    await page.locator('[data-import-view]').waitFor();
    await ready();
    check(await page.evaluate(() => deck?.imported && decks.length === 1), 'Import did not create the first available learning set');
    check(await page.locator('[data-restore-media]').isVisible(), 'Imported set lost its Anki-specific management action');
    await page.reload();
    await ready();
    check(await page.evaluate(() => deck?.imported && terms().length === 4), 'New import did not survive empty-catalog reload');
    await nav('settings');
    await page.locator('[data-delete-set]').click();
    await page.locator('[data-confirm-delete-set]').click();
    await ready();
    check(await page.locator('#import-file').isVisible() && await page.evaluate(() => decks.length) === 0, 'Deleting the final imported set broke Settings');
    await logout();
    await signIn(firstEmail);
    check(await page.evaluate(() => deck.id === 'demo-ar'), 'Returning account did not restore its own selected set');
    await select('everyday-el');
    check(await page.evaluate(() => decks.length === 2 && deck.title === 'My Greek words'), 'Other account set deletions leaked to first account');
    passed.push('default changes are private; empty Study/Vocabulary/Settings can import and delete the final set across reload');

    await page.evaluate(() => {
      stopAudio();
      window.qaAudio = {players: [], played: 0, paused: 0};
      window.Audio = class {
        constructor(source) { this.src = source; this.currentTime = 0; this.ended = false; this.listeners = new Map(); qaAudio.players.push(this); }
        addEventListener(name, callback) { this.listeners.set(name, callback); }
        removeEventListener(name) { this.listeners.delete(name); }
        load() {}
        removeAttribute() { this.src = ''; }
        pause() { qaAudio.paused++; }
        play() { this.ended = false; qaAudio.played++; return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
        start() { this.listeners.get('playing')?.(); this.resolve(); }
        end() { this.ended = true; this.listeners.get('ended')?.(); }
      };
      deck.words[0].audio = '/synthetic-test-recording.wav';
      selectedWord = terms()[0]; screen = 'detail'; render();
    });
    const short = await page.evaluate(() => {
      const button = document.querySelector('[data-audio]');
      button.focus();
      const before = button.getBoundingClientRect();
      button.click();
      const pending = {label: button.querySelector('[data-audio-label]').textContent, spinner: button.dataset.audioLoading};
      const player = qaAudio.players.at(-1);
      player.start();
      const playing = {label: button.querySelector('[data-audio-label]').textContent, pressed: button.getAttribute('aria-pressed'), name: button.getAttribute('aria-label')};
      player.end();
      const after = button.getBoundingClientRect();
      return {pending, playing, width: before.width === after.width, focus: document.activeElement === button, state: button.dataset.audioState};
    });
    check(short.pending.label === 'Listen' && short.pending.spinner === 'false' && short.playing.label === 'Listen', 'Short clip cycles labels or flashes loading');
    check(short.playing.pressed === 'true' && short.playing.name.startsWith('Stop recording'), 'Actual playback lacks accessible stop state');
    check(short.width && short.focus && short.state === 'idle', 'Short playback shifts button, loses focus, or lingers after ending');
    await page.waitForTimeout(250);
    check(await page.locator('[data-audio]').getAttribute('data-audio-loading') === 'false', 'Ended short clip leaves a delayed spinner');
    check(!(await page.locator('body').innerText()).includes('Playing recording'), 'Playing recording text remains');
    passed.push('short audio keeps Listen and dimensions steady without spinner flash or false playing duration');

    const pending = await page.evaluate(() => {
      const button = document.querySelector('[data-audio]');
      button.click();
      return {spinner: button.dataset.audioLoading, busy: button.getAttribute('aria-busy')};
    });
    check(pending.spinner === 'false' && pending.busy === 'true', 'Loading indicator is immediate or accessible loading is missing');
    await page.waitForFunction(() => document.querySelector('[data-audio]')?.dataset.audioLoading === 'true');
    const status = await page.locator('#audio-status').evaluate(element => ({text: element.textContent, position: getComputedStyle(element).position, height: element.getBoundingClientRect().height}));
    check(status.text.includes('Loading') && status.position === 'absolute' && status.height <= 1, 'Delayed loading status changes visible layout');
    await page.emulateMedia({reducedMotion: 'reduce'});
    check(await page.locator('[data-audio-icon]').evaluate(element => getComputedStyle(element, '::after').animationName === 'none'), 'Loading ignores reduced motion');
    await page.emulateMedia({reducedMotion: 'no-preference'});
    await page.evaluate(() => qaAudio.players.at(-1).start());
    await page.waitForFunction(() => document.querySelector('[data-audio]')?.dataset.audioState === 'playing');
    check(await page.locator('[data-audio]').getAttribute('data-audio-loading') === 'false', 'Spinner persists during actual playback');
    await page.locator('[data-audio]').press('Enter');
    check(await page.locator('[data-audio]').getAttribute('data-audio-state') === 'idle', 'Keyboard stop failed');
    passed.push('slow loading is delayed and accessible without layout shift; playback cancels spinner and supports keyboard stop');

    await page.locator('[data-audio]').click();
    await page.evaluate(() => qaAudio.players.at(-1).reject(new Error('Synthetic audio failure')));
    await page.waitForFunction(() => document.querySelector('[data-audio]')?.dataset.audioState === 'error');
    await page.locator('#notice[data-active]').waitFor();
    check((await page.locator('#notice').innerText()).includes('try again'), 'Failed playback has no visible useful error');
    check((await page.locator('[data-audio]').getAttribute('aria-label')).startsWith('Retry recording'), 'Failed playback has no accessible retry action');
    await page.locator('[data-audio]').click();
    await page.evaluate(() => qaAudio.players.at(-1).start());
    await page.waitForFunction(() => document.querySelector('[data-audio]')?.dataset.audioState === 'playing');
    const replayCount = await page.evaluate(() => qaAudio.played);
    await page.evaluate(() => qaAudio.players.at(-1).end());
    await page.locator('[data-audio]').click();
    check(await page.evaluate(() => qaAudio.played) === replayCount + 1, 'Replay did not invoke playback');
    await nav('vocabulary');
    await page.evaluate(() => { const player = qaAudio.players.at(-1); player.start(); player.end(); });
    await page.waitForTimeout(250);
    check(await page.locator('[data-audio-loading=true]').count() === 0 && await page.evaluate(() => playback.state) === 'idle', 'Stale audio events/timer survived navigation');
    await page.locator('.word-card').first().click();
    await page.locator('[data-audio]').click();
    await logout();
    await page.evaluate(() => { const player = qaAudio.players.at(-1); player.start(); player.end(); });
    await page.waitForTimeout(250);
    check(await page.locator('#account-form').isVisible() && await page.evaluate(() => playback.state) === 'idle', 'Audio survived account logout');
    passed.push('audio errors remain visible/retryable; replay, navigation and account logout cancel stale feedback');

    check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
    return {passed, pageErrors: errors};
  } finally { await context.close(); }
}
