async (page, options = {}) => {
  const context = await page.context().browser().newContext({viewport: {width: 390, height: 844}});
  page = await context.newPage();
  const root = options.url || 'http://127.0.0.1:4194/';
  const passed = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const ready = (deckId) => page.waitForFunction(id => user && deckLoaded && !busy && !failedOperation && (!id || deck.id === id), deckId);
  const password = 'synthetic selection test password';
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const register = async suffix => {
    await page.locator('[data-account-mode]').click();
    const email = `selection-${suffix}-${unique}@example.test`;
    await page.locator('#account-email').fill(email);
    await page.locator('#account-password').fill(password);
    await page.locator('#account-form button[type=submit]').click();
    await ready();
    return email;
  };
  const login = async email => {
    await page.locator('#account-email').fill(email);
    await page.locator('#account-password').fill(password);
    await page.locator('#account-form button[type=submit]').click();
    await ready();
  };
  const selectSet = async id => {
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await page.locator(`[name=learning-set][value="${id}"]`).check();
    await ready(id);
    await page.getByRole('button', {name: 'Study', exact: true}).click();
    await ready(id);
  };
  const current = () => page.evaluate(() => JSON.parse(JSON.stringify({user: user.id, deckId: deck.id, attempt, questions, answers, position, selected})));
  const answer = async correct => {
    const id = await page.evaluate(isCorrect => {
      const question = questions[position];
      return isCorrect ? question.word.id : question.options.find(option => option.id !== question.word.id).id;
    }, correct);
    await page.locator(`[data-answer="${id}"]`).click();
    await page.locator('#continue').waitFor();
    await ready();
  };

  try {
    await page.goto(root);
    await page.locator('#account-form').waitFor();
    const firstEmail = await register('first');
    const firstId = await page.evaluate(() => user.id);
    await selectSet('demo-ar');
    await page.locator('[data-start=lesson]').click();
    await ready('demo-ar');
    await answer(false);
    const arabicFeedback = await current();
    await page.reload();
    await ready();
    check(await page.evaluate(() => deck.id) === 'demo-ar', 'Reload reverted the selected Arabic set');
    check(await page.locator('[data-resume]').count() === 1, 'Reload did not restore the saved Arabic lesson');
    await page.locator('[data-resume]').click();
    check(JSON.stringify(await current()) === JSON.stringify(arabicFeedback), 'Reload changed selected set or exact saved lesson feedback');
    passed.push('selected Arabic set and its answered lesson restore together after reload');

    await page.locator('[data-screen=study]').click();
    await ready('demo-ar');
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
    const secondEmail = await register('second');
    const secondId = await page.evaluate(() => user.id);
    check(secondId !== firstId, 'Synthetic accounts were not independent');
    await selectSet('everyday-el');
    await page.reload();
    await ready();
    check(await page.evaluate(() => deck.id) === 'everyday-el', 'Second account inherited the first account selection');
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
    await login(firstEmail);
    check(await page.evaluate(() => user.id) === firstId && await page.evaluate(() => deck.id) === 'demo-ar', 'First account selection did not survive logout/login');
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
    await login(secondEmail);
    check(await page.evaluate(() => user.id) === secondId && await page.evaluate(() => deck.id) === 'everyday-el', 'Second account selection changed after switching accounts');
    passed.push('last selected set is isolated per signed-in account across logout and login');

    await page.evaluate(id => localStorage.setItem(`meletio.learningSet.${id}`, 'deleted-private-set'), secondId);
    await page.reload();
    await ready();
    check(await page.evaluate(() => deck.id) === 'everyday-el', 'Deleted selection did not fall back to an available set');
    check(await page.evaluate(() => !failedOperation), 'Deleted selection left the app in a failed state');
    passed.push('unavailable saved set falls back safely to the default set');

    const blockedContext = await page.context().browser().newContext({viewport: {width: 390, height: 844}});
    try {
      await blockedContext.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', {configurable: false, get() { throw new DOMException('Storage denied', 'SecurityError'); }});
      });
      const blockedPage = await blockedContext.newPage();
      const blockedErrors = [];
      blockedPage.on('pageerror', error => blockedErrors.push(error.message));
      await blockedPage.goto(root);
      await blockedPage.locator('#account-form').waitFor();
      await blockedPage.locator('[data-account-mode]').click();
      await blockedPage.locator('#account-email').fill(`selection-blocked-${unique}@example.test`);
      await blockedPage.locator('#account-password').fill(password);
      await blockedPage.locator('#account-form button[type=submit]').click();
      await blockedPage.waitForFunction(() => user && deckLoaded && !busy && !failedOperation);
      await blockedPage.getByRole('button', {name: 'Settings', exact: true}).click();
      await blockedPage.locator('[name=learning-set][value="demo-ar"]').check();
      await blockedPage.waitForFunction(() => user && deckLoaded && !busy && !failedOperation && deck.id === 'demo-ar');
      check(await blockedPage.locator('[name=learning-set][value="demo-ar"]').isChecked(), 'Changing sets failed while local storage was blocked');
      check(blockedErrors.length === 0, `Storage denial caused browser errors: ${blockedErrors.join('; ')}`);
      passed.push('blocked local storage does not prevent sign-in or changing the selected set');
      await blockedPage.close();
    } finally { await blockedContext.close(); }

    check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
    return {passed, pageErrors: errors};
  } finally { await context.close(); }
}
