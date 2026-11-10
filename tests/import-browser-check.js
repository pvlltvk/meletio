async (page, options = {}) => {
  if (!options.packagePath || !options.updatePackagePath) throw new Error('Provide synthetic packagePath and updatePackagePath');
  const context = await page.context().browser().newContext();
  await context.addInitScript(() => { Object.defineProperty(crypto, 'randomUUID', {configurable: true, value: undefined}); });
  page = await context.newPage();
  const root = options.url || 'http://127.0.0.1:4173/';
  const passed = [];
  const errors = [];
  const external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(new URL(root).origin + '/')) external.push(request.url()); });
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const ready = () => page.waitForFunction(() => user && deckLoaded && !busy && !importBusy && !failedOperation);
  const settings = () => page.getByRole('button', {name: 'Settings', exact: true}).click();
  const study = () => page.getByRole('button', {name: 'Study', exact: true}).click();
  const register = async email => {
    await page.locator('[data-account-mode]').click();
    await page.locator('#account-email').fill(email);
    await page.locator('#account-password').fill('a private browser import password');
    await page.locator('#account-form button[type=submit]').click();
    await ready();
  };
  const chooseFile = async path => {
    await page.locator('#import-file').setInputFiles(path);
  };
  const waitStage = async () => {
    await page.waitForFunction(() => importStage?.status === 'ready' && !importBusy);
    const options = page.locator('.import-options');
    if (await options.count() && !await options.evaluate(element => element.open)) await options.locator('summary').click();
    await page.locator('#import-mapping').waitFor();
  };
  const preview = async () => {
    const submit = page.locator('#import-mapping button[type=submit]');
    if (await submit.count()) await submit.click();
    await page.locator('.import-report').waitFor();
    await ready();
  };
  const commit = async () => {
    if (await page.locator('#import-accept-skipped').count()) await page.locator('#import-accept-skipped').check();
    await page.locator('[data-import-commit]').click();
    await page.waitForFunction(() => !importBusy && !importStage && deckLoaded && deck.imported);
  };
  const answer = async right => {
    const id = await page.evaluate(right => {
      const question = questions[position];
      return right ? question.word.id : question.options.find(option => option.id !== question.word.id).id;
    }, right);
    await page.locator(`[data-answer="${id}"]`).click();
    await page.locator('#continue').waitFor();
    await ready();
  };
  const advance = async () => { await page.locator('#continue').click(); await ready(); };
  const email = `import-browser-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  try {
    await page.goto(root);
    await page.locator('#account-form').waitFor();
    await register(email);
    await settings();
    const initialDecks = await page.evaluate(() => decks.map(deck => deck.id));
    await chooseFile(options.packagePath);
    await waitStage();
    await page.locator('[data-import-cancel]').click();
    await page.waitForFunction(() => !importBusy && !importStage);
    check(JSON.stringify(await page.evaluate(() => decks.map(deck => deck.id))) === JSON.stringify(initialDecks), 'Cancel changed visible catalog');
    passed.push('cancelled upload leaves the visible catalog unchanged');

    await page.route('**/api/imports/uploads', async route => {
      const response = await route.fetch();
      check(response.ok(), 'Lost-upload-response fixture failed before inspection');
      await route.abort();
    }, {times: 1});
    await chooseFile(options.packagePath);
    await page.waitForFunction(() => !importBusy && importRequestId && importError);
    check(await page.evaluate(() => importStage === null), 'Lost upload response unexpectedly delivered an ID');
    await page.locator('[data-import-recover]').click();
    await waitStage();
    passed.push('upload response loss recovers the staged package by its client request ID');

    await page.locator('[name=sourceDeckId]').selectOption('1');
    await page.locator('[name=noteTypeId]').selectOption('100');
    await page.locator('[name=title]').fill('Private browser vocabulary');
    await page.locator('[name=term]').selectOption('Term');
    await page.locator('[name=meaning]').selectOption('Meaning');
    await page.locator('[name=image]').selectOption('Meaning');
    await page.locator('[name=audio]').selectOption('Audio');
    await preview();
    check(await page.evaluate(() => importPreview.report.added) === 4, 'Preview did not count four source notes');
    check((await page.locator('.import-samples').innerText()).includes('meaning & 1'), 'HTML entities were not decoded');
    check(await page.evaluate(() => !window.importHtmlExecuted), 'Imported script executed');
    check(JSON.stringify(await page.evaluate(() => decks.map(deck => deck.id))) === JSON.stringify(initialDecks), 'Preview changed visible catalog');
    await page.locator('.import-samples img').first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.import-samples img')].every(image => image.complete && image.naturalWidth > 0));
    await page.locator('.import-samples audio').first().evaluate(async audio => { await audio.play(); });
    await page.waitForFunction(() => document.querySelector('.import-samples audio').currentTime > 0);
    await page.locator('.import-samples audio').first().evaluate(audio => audio.pause());
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({width, height: 844});
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Import layout overflows ${width}`);
    }
    passed.push('mapping preview is private, decodes safe text, renders images and plays bundled test audio at three sizes');

    let originalCommit;
    await page.route('**/api/imports/*/commit', async route => {
      originalCommit = route.request().postDataJSON();
      const response = await route.fetch();
      check(response.ok(), 'Lost-commit-response fixture failed before commit');
      await route.abort();
    }, {times: 1});
    if (await page.locator('#import-accept-skipped').count()) await page.locator('#import-accept-skipped').check();
    await page.locator('[data-import-commit]').click();
    await page.waitForFunction(() => !importBusy && importError);
    let retriedCommit;
    await page.route('**/api/imports/*/commit', async route => {
      retriedCommit = route.request().postDataJSON();
      await route.continue();
    }, {times: 1});
    await commit();
    check(originalCommit.requestId === retriedCommit.requestId, 'Lost commit retry changed its request key');
    const importedId = await page.evaluate(() => deck.id);
    const oldImage = await page.evaluate(() => deck.words[0].image);
    check(await page.evaluate(id => decks.filter(deck => deck.id === id).length, importedId) === 1, 'Commit retry duplicated a deck');
    passed.push('explicit commit and lost-response replay create one private learning set');

    await study();
    await page.locator('[data-start=all]').click();
    await ready();
    await answer(false);
    const originalAttempt = await page.evaluate(() => ({id: attempt.id, first: questions[0].word.id, selected, terms: questions.map(question => question.word.term)}));
    await page.locator('[data-screen=study]').click();
    await settings();
    await chooseFile(options.updatePackagePath);
    await waitStage();
    await page.locator('[name=destinationDeckId]').selectOption(importedId);
    await ready();
    await preview();
    check(await page.evaluate(() => importPreview.report.updated) >= 1, 'Updated source note was not reported');
    await page.route('**/api/imports/*/commit', async route => {
      const response = await route.fetch();
      check(response.ok(), 'Lost-update-response fixture failed before commit');
      await route.abort();
    }, {times: 1});
    if (await page.locator('#import-accept-skipped').count()) await page.locator('#import-accept-skipped').check();
    await page.locator('[data-import-commit]').click();
    await page.waitForFunction(() => !importBusy && importError);
    await page.locator('[data-import-recover]').click();
    await page.waitForFunction(id => !busy && !importBusy && deckLoaded && deck.id === id && deck.words.some(word => word.term === 'replacement term'), importedId);
    check(await page.locator('.import-report').count() === 0, 'Committed recovery still offers a stale confirmation');
    await page.reload();
    await ready();
    check(await page.evaluate(id => deck.id === id, importedId), 'Reload did not restore the selected imported vocabulary');
    await settings();
    await page.locator('[data-import-view]').click();
    await page.waitForFunction(id => !busy && !importBusy && deckLoaded && deck.id === id && deck.words.some(word => word.term === 'replacement term'), importedId);
    check(await page.locator('.import-report').count() === 0, 'Reload recovery resurrected an old preview');
    passed.push('lost update commit recovers through current-import lookup and the saved-import action after reload');
    check(await page.evaluate(() => deck.words.some(word => word.term === 'replacement term')), 'Reimport did not update current vocabulary');
    await study();
    await page.locator('[data-resume]').click();
    check(await page.evaluate(() => attempt.id) === originalAttempt.id, 'Reimport replaced the active attempt');
    check(JSON.stringify(await page.evaluate(() => questions.map(question => question.word.term))) === JSON.stringify(originalAttempt.terms), 'Reimport rewrote an old practice snapshot');
    await page.reload();
    await ready();
    await settings();
    await page.locator(`[name=learning-set][value="${importedId}"]`).check();
    await ready();
    await study();
    await page.locator('[data-resume]').click();
    check(await page.evaluate(() => selected) === originalAttempt.selected, 'Feedback did not survive reload after reimport');
    while (await page.evaluate(() => position < questions.length)) {
      if (await page.evaluate(() => selected === null)) await answer(true);
      await advance();
    }
    check((await page.locator('.score-panel').innerText()).includes('3 / 4'), 'Imported first-answer score changed');
    await page.locator('[data-start=mistakes]').click();
    await ready();
    check(await page.evaluate(() => questions.length === 1 && questions[0].options.length === 4), 'Imported missed-only retry lost distractors');
    check(await page.evaluate(() => !questions.some(question => question.word.term === 'replacement term')), 'Retry used updated vocabulary instead of the original snapshot');
    passed.push('reimport updates current vocabulary while reload, feedback, completion and retry preserve the old snapshot');

    await page.locator('[data-screen=study]').click();
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
    await register(`other-${email}`);
    await settings();
    check(await page.locator(`[name=learning-set][value="${importedId}"]`).count() === 0, 'Other account sees private deck');
    check(!await page.evaluate(() => decks.some(deck => deck.title === 'Private browser vocabulary')), 'Other account sees private title');
    const mediaStatus = await page.evaluate(async path => (await fetch(path)).status, oldImage);
    check(mediaStatus === 404, 'Other account can read old private media');
    passed.push('account changes clear imported catalog entries and reject direct private media access');
    check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
    check(external.length === 0, 'Imported content triggered external network requests');
    return {passed, pageErrors: errors, externalRequests: external.length};
  } catch (error) {
    const state = await page.evaluate(() => ({screen, deckId: deck?.id, importedDeckId, terms: deck?.words?.map(word => word.term), importError, loadError, busy, importBusy, stage: importStage?.status}));
    error.message = `After ${passed.length} passed groups: ${error.message}; ${JSON.stringify(state)}`;
    throw error;
  } finally { await context.close(); }
}
