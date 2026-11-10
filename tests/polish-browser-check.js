async (page, options = {}) => {
  const launch = new URL(page.url());
  const packagePath = options.packagePath || launch.searchParams.get('testPackage');
  const updatePackagePath = options.updatePackagePath || launch.searchParams.get('testUpdatePackage');
  if (!packagePath || !updatePackagePath) throw new Error('Provide synthetic packagePath and updatePackagePath');
  const context = await page.context().browser().newContext({viewport: {width: 390, height: 844}});
  page = await context.newPage();
  const root = options.url || launch.searchParams.get('testUrl') || 'http://127.0.0.1:4173/';
  const passed = []; const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const settings = () => page.locator('[data-screen="settings"]').click();
  const register = async email => {
    await page.locator('[data-account-mode]').click();
    await page.locator('#account-email').fill(email);
    await page.locator('#account-password').fill('synthetic browser test password');
    await page.locator('#account-form button[type=submit]').click();
    await page.waitForFunction(() => user && deckLoaded && !busy && !failedOperation);
  };
  try {
    await page.goto(root);
    await page.locator('#account-form').waitFor();
    await register(`polish-${Date.now()}@example.test`);
    await settings();

    await page.locator('#import-file').setInputFiles(packagePath);
    await page.waitForFunction(() => importPreview || importError || importStage?.status === 'failed', null, {timeout: 15000});
    check(await page.locator('.import-report[aria-label="Import preview"]').count() === 1,
      `File selection did not reach preview: ${JSON.stringify(await page.evaluate(() => ({importError, status: importStage?.status, uploadId: importStage?.uploadId})))}`);
    const firstStageId = await page.evaluate(() => importStage.uploadId);
    let cancelCount = 0; let releaseFirstCancel; let signalFirstCancel; let signalSecondCancel; let signalNewUpload;
    const firstCancelStarted = new Promise(resolve => { signalFirstCancel = resolve; });
    const secondCancelStarted = new Promise(resolve => { signalSecondCancel = resolve; });
    const newUploadStarted = new Promise(resolve => { signalNewUpload = resolve; });
    const firstCancelGate = new Promise(resolve => { releaseFirstCancel = resolve; });
    await page.route('**/api/imports/*/cancel', async route => {
      cancelCount++;
      if (cancelCount === 1) { signalFirstCancel(); await firstCancelGate; }
      else if (cancelCount === 2) signalSecondCancel();
      await route.continue();
    });
    await page.route('**/api/imports/uploads', async route => { signalNewUpload(); await route.continue(); });
    await page.locator('[data-import-cancel]').click();
    await firstCancelStarted;
    await page.locator('#import-file').setInputFiles(updatePackagePath);
    await secondCancelStarted;
    await newUploadStarted;
    await page.waitForFunction(oldId => importStage?.uploadId && importStage.uploadId !== oldId && importPreview, firstStageId, {timeout: 15000});
    const replacementState = await page.evaluate(() => ({uploadId: importStage?.uploadId, requestId: importRequestId}));
    releaseFirstCancel();
    await page.waitForTimeout(100);
    const afterLateCancel = await page.evaluate(() => ({uploadId: importStage?.uploadId, requestId: importRequestId}));
    check(afterLateCancel.uploadId === replacementState.uploadId && afterLateCancel.requestId === replacementState.requestId,
      `Late cancellation response changed the newer stage: ${JSON.stringify({replacementState, afterLateCancel})}`);
    await page.unroute('**/api/imports/*/cancel');
    passed.push('out-of-order cancellation response cannot clear a newer import stage');

    check(await page.locator('.import-samples article').count() <= 3, 'Import preview showed more than three sample cards');
    check(await page.locator('[data-import-commit]').isVisible(), 'Import preview omitted the explicit final save action');
    check(await page.locator('.import-options').evaluate(element => !element.open), 'Advanced import controls were open in the normal flow');
    check(await page.locator('[data-import-upload]').count() === 0, 'File selection left a redundant upload action');
    let importedDeckId;
    await page.route('**/api/imports/*/commit', async route => {
      const response = await route.fetch();
      const result = await response.json();
      importedDeckId = result.deckId;
      await route.fulfill({response, body: JSON.stringify(result)});
    });
    await page.route('**/api/decks', async route => {
      const response = await route.fetch();
      const result = await response.json();
      if (importedDeckId) result.decks = result.decks.filter(deck => deck.id !== importedDeckId);
      await route.fulfill({response, body: JSON.stringify(result)});
    });
    await page.locator('[data-import-commit]').click();
    await page.locator('[data-import-view]').waitFor();
    const selectedDeckId = await page.evaluate(() => deck.id);
    check(selectedDeckId === importedDeckId && await page.evaluate(() => deck.imported),
      'Import finished on a fallback deck instead of loading the selected deck by ID');
    await page.reload();
    await page.waitForFunction(() => user && deckLoaded && !busy && !failedOperation);
    check(await page.evaluate(id => deck.id === id && deck.imported, importedDeckId), 'Reload lost the imported set omitted from the first catalog page');
    await settings();
    await page.unroute('**/api/decks');
    passed.push('selected imported deck loads by ID when omitted from the first catalog page');
    await page.locator('[data-import-view]').click();
    let releaseMedia;
    const mediaGate = new Promise(resolve => { releaseMedia = resolve; });
    const recording = await page.evaluate(() => deck.words[0].audio);
    await page.route(`**${recording}`, async route => {
      await mediaGate;
      await route.continue();
    });
    await page.locator('.word-card').first().click();
    const audio = page.locator('[data-audio]').first();
    check(await audio.count() === 1, 'Synthetic imported word has no recording for the Listen state check');
    await audio.click();
    await page.waitForTimeout(100);
    check(await audio.getAttribute('data-audio-state') === 'loading', 'Delayed recording did not show Loading');
    check(await audio.getAttribute('aria-busy') === 'true', 'Loading state was not exposed accessibly');
    releaseMedia();
    await page.waitForFunction(() => ['playing', 'error'].includes(document.querySelector('[data-audio]')?.dataset.audioState), null, {timeout: 10000});
    check(['playing', 'error'].includes(await audio.getAttribute('data-audio-state')), 'Recording left Loading without feedback');
    passed.push('delayed Listen exposes Loading immediately and resolves to a visible playback state');

    await page.locator('[data-edit-word]').click();
    const term = page.locator('#word-edit-form [name=term]');
    const originalTerm = await term.inputValue();
    await term.fill(`${originalTerm} edited`);
    await page.locator('#word-edit-form [name=meaning]').fill('synthetic local translation');
    const mutationPayloads = [];
    await page.route('**/api/decks/*/words/*/edit', async route => {
      mutationPayloads.push(route.request().postDataJSON());
      if (mutationPayloads.length === 1) await route.abort();
      else await route.continue();
    });
    await page.locator('#word-edit-form button[type=submit]').click();
    await page.locator('[data-content-retry]').waitFor();
    await page.locator('[data-content-retry]').click();
    await page.locator('.detail-heading').waitFor();
    check(mutationPayloads.length === 2 && mutationPayloads[0].requestId === mutationPayloads[1].requestId, 'Save retry changed its request identity');
    check((await page.locator('.detail-heading').innerText()).includes('edited'), 'Saved word edit was not shown');
    passed.push('synthetic file selection opens a concise preview and saved word edits appear immediately');

    await page.locator('[data-delete-word]').click();
    check((await page.locator('.confirmation').innerText()).includes('Saved practice is kept'), 'Word deletion omitted saved-practice confirmation');
    await page.locator('[data-keep]').click();
    check(await page.locator('[data-confirm-delete-word]').count() === 0, 'Keep word did not cancel deletion');
    await page.locator('[data-delete-word]').click();
    await page.locator('[data-confirm-delete-word]').click();
    await page.locator('[aria-label="Main navigation"] [data-screen="vocabulary"]').click();
    check(await page.locator('.word-card').count() === 3, 'Deleted word remained in current vocabulary');

    await settings();
    await page.locator('[data-rename-set]').click();
    await page.locator('#deck-rename-form [name=title]').fill('Renamed synthetic set');
    await page.locator('#deck-rename-form button[type=submit]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.deck-option')].some(option => option.textContent.includes('Renamed synthetic set')));
    await page.locator('[data-delete-set]').click();
    check((await page.locator('.confirmation').innerText()).includes('practice history and Anki export are kept'), 'Set deletion omitted saved-history confirmation');
    await page.locator('[data-keep]').click();
    check(await page.locator('[data-confirm-delete-set]').count() === 0, 'Keep set did not cancel deletion');
    passed.push('word and set deletion require an explicit confirmation and can be cancelled');

    await page.setViewportSize({width: 320, height: 568});
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px layout overflows horizontally');
    const fontResult = await page.evaluate(() => {
      const body = getComputedStyle(document.body).fontFamily;
      const controls = [...document.querySelectorAll('button,input,select,textarea')].map(el => getComputedStyle(el).fontFamily);
      return {body, inherited: controls.every(font => font === body)};
    });
    check(fontResult.inherited, 'A form control does not inherit the shared UI font');
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px RTL layout overflows horizontally');
    await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
    await page.setViewportSize({width: 390, height: 844});
    await page.setViewportSize({width: 1280, height: 900});
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '1280px layout overflows horizontally');
    passed.push('shared control typography and narrow, wide, and RTL layouts remain usable');

    check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
    return {passed, pageErrors: errors};
  } finally { await context.close(); }
}
