async (page, options = {}) => {
  if (!options.packagePath) throw new Error('Provide a synthetic child-deck packagePath');
  const context = await page.context().browser().newContext({viewport: {width: 390, height: 844}});
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (value, message) => { if (!value) throw new Error(message); };
  const ready = () => page.waitForFunction(() => user && deckLoaded && !busy && !importBusy);
  const upload = async () => {
    await page.locator('#import-file').setInputFiles(options.packagePath);
    await page.waitForFunction(() => importStage?.status === 'ready' && importPreview && !importBusy);
  };
  const openOptions = async () => {
    const disclosure = page.locator('.import-options');
    if (!await disclosure.evaluate(element => element.open)) await disclosure.locator('summary').click();
  };
  const email = `polish-recovery-${Date.now()}@example.com`;
  const password = 'a private recovery test password';
  try {
    await page.goto(options.url || 'http://127.0.0.1:4173/');
    await page.locator('[data-account-mode]').click();
    await page.locator('#account-email').fill(email);
    await page.locator('#account-password').fill(password);
    await page.locator('#account-form button[type=submit]').click();
    await ready();
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await upload();
    await openOptions();
    await page.locator('[name=sourceDeckId]').selectOption('2');
    await page.locator('[name=title]').fill('Child vocabulary');
    await page.locator('#import-mapping button[type=submit]').click();
    await page.waitForFunction(() => importPreview?.source.sourceDeckId === '2' && !importBusy);
    await page.locator('[data-import-commit]').click();
    await page.waitForFunction(() => !importStage && deck?.imported && !importBusy && deckLoaded);
    const childId = await page.evaluate(() => deck.id);
    await upload();
    await openOptions();
    check(await page.locator('[name=sourceDeckId]').inputValue() === '2', 'Existing child source disappeared from options');
    check(await page.locator('[name=noteTypeId]').inputValue() === '100', 'Existing child note type disappeared from options');
    await page.locator('[name=replaceLocalChanges]').check();
    await page.locator('#import-mapping button[type=submit]').click();
    await page.waitForFunction(() => importPreview?.replaceLocalChanges && !importBusy);
    check(await page.evaluate(id => importPreview.destinationDeckId === id && importPreview.source.sourceDeckId === '2' && importPreview.source.noteTypeId === '100', childId), 'Editing import options changed the child source');
    const pendingId = await page.evaluate(() => importStage.uploadId);
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
    if (await page.getByRole('heading', {name: 'Create account', exact: true}).count()) await page.locator('[data-account-mode]').click();
    await page.locator('#account-email').fill(email);
    await page.locator('#account-password').fill(password);
    await page.locator('#account-form button[type=submit]').click();
    await ready();
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await page.waitForFunction(id => importStage?.uploadId === id && importStage.status === 'ready', pendingId);
    check(await page.locator('.import-report').count() === 1, 'Login did not restore the unfinished preview');
    await page.locator('[data-import-cancel]').click();
    await page.waitForFunction(() => !importStage && !importRequestId && !importBusy);
    check(errors.length === 0, errors.join('; '));
    return {passed: ['child-deck updates retain source and model when Advanced options change', 'login restores and can cancel an existing unfinished import'], pageErrors: errors};
  } finally { await context.close(); }
}
