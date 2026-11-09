async (page, options = {}) => {
  if (!options.packagePath) throw new Error('Provide a synthetic packagePath');
  const context = await page.context().browser().newContext({viewport: {width: 390, height: 844}});
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const ready = () => page.waitForFunction(() => user && deckLoaded && !busy && !importBusy);
  const upload = async () => {
    await page.locator('#import-file').setInputFiles(options.packagePath);
    await page.waitForFunction(() => importStage?.status === 'ready' && importPreview && !importBusy);
  };
  const commit = async () => {
    if (await page.locator('#import-accept-skipped').count()) await page.locator('#import-accept-skipped').check();
    await page.locator('[data-import-commit]').click();
    await page.waitForFunction(() => deck?.imported && !importStage && !importBusy && deckLoaded);
  };
  try {
    await page.goto(options.url || 'http://127.0.0.1:4173/');
    await page.locator('[data-account-mode]').click();
    await page.locator('#account-email').fill(`media-browser-${Date.now()}@example.com`);
    await page.locator('#account-password').fill('a private browser media password');
    await page.locator('#account-form button[type=submit]').click();
    await ready();
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await upload();
    check(await page.locator('.import-options').evaluate(element => !element.open), 'Advanced fields should start collapsed');
    const suggested = await page.evaluate(() => ({draft: importDraft, media: importPreview.report.media}));
    check(suggested.draft.sourceDeckId === '2' && suggested.draft.mapping.audio === 'Audio', 'Wrong source or audio defaults');
    check(suggested.media.images === 4 && suggested.media.audio === 3 && suggested.media.resizedImages === 4, 'Wrong automatic preview coverage');
    await page.waitForFunction(() => [...document.querySelectorAll('.import-samples img')].every(image => image.complete && image.naturalWidth > 0));
    await page.locator('.import-samples audio').first().evaluate(async audio => { await audio.play(); });
    await page.waitForFunction(() => document.querySelector('.import-samples audio').currentTime > 0);
    await page.locator('.import-samples audio').first().evaluate(audio => audio.pause());
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({width, height: 844});
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Preview overflows ${width}px`);
    }
    await page.locator('.import-options>summary').click();
    await page.locator('[name=audio]').selectOption('Pronunciation');
    await page.locator('#import-mapping button[type=submit]').click();
    await page.waitForFunction(() => importPreview && !importBusy);
    check(await page.evaluate(() => importPreview.report.media.unselectedAudio === 3), 'Wrong field did not warn about recordings');
    await commit();
    const original = await page.evaluate(() => ({id: deck.id, words: deck.words.map(word => ({id: word.id, image: word.image}))}));
    await upload();
    await page.locator('.import-options>summary').click();
    await page.locator('[name=repairMedia]').check();
    check(await page.locator('[name=audio]').inputValue() === 'Audio', 'Repair did not suggest the actual Audio field');
    await page.locator('#import-mapping button[type=submit]').click();
    await page.waitForFunction(() => importPreview?.repairMedia && !importBusy);
    check(await page.evaluate(() => importPreview.report.media.audio === 3), 'Repair preview lost audio');
    await commit();
    check(await page.evaluate(original => deck.id === original.id && deck.words.every((word, index) => word.id === original.words[index].id && word.image === original.words[index].image) && deck.words.filter(word => word.audio).length === 3, original), 'Repair changed identities/media or missed recordings');
    check(errors.length === 0, errors.join('; '));
    return {passed: ['automatic preview with content-based defaults and optimized pictures', 'coverage warning for a field without recordings', 'explicit repair preserves word and picture identities and restores recordings'], pageErrors: errors};
  } finally { await context.close(); }
}
