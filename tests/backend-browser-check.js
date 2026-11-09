async (page, options = {}) => {
  const context = await page.context().browser().newContext();
  page = await context.newPage();
  const root = options.url || 'http://127.0.0.1:4173/';
  const passed = [];
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const ready = () => page.waitForFunction(() => !busy && !failedOperation && user && deckLoaded);
  const state = () => page.evaluate(() => JSON.parse(JSON.stringify({attempt, questions, answers, position, selected})));
  const register = async email => {
    await page.locator('[data-account-mode]').click();
    await page.locator('#account-email').fill(email);
    await page.locator('#account-password').fill('a browser test password');
    await page.locator('#account-form button[type=submit]').click();
    await ready();
  };
  const login = async email => {
    await page.locator('#account-email').fill(email);
    await page.locator('#account-password').fill('a browser test password');
    await page.locator('#account-form button[type=submit]').click();
    await ready();
  };
  const answer = async correct => {
    const id = await page.evaluate(correct => {
      const question = questions[position];
      return correct ? question.word.id : question.options.find(option => option.id !== question.word.id).id;
    }, correct);
    await page.locator(`[data-answer="${id}"]`).click();
    await page.locator('#continue').waitFor();
    await ready();
  };
  const advance = async () => { await page.locator('#continue').click(); await ready(); };
  const settings = () => page.getByRole('button', {name: 'Settings', exact: true}).click();
  const study = () => page.getByRole('button', {name: 'Study', exact: true}).click();
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const firstEmail = `browser-${unique}@example.com`;
  try {
    await page.goto(root);
    await page.locator('#account-form').waitFor();
    await register(firstEmail);
    await page.locator('[data-start=all]').click();
    await ready();
    await answer(false);
    const feedback = await state();
    check(feedback.answers.length === 1 && feedback.selected !== null, 'First answer not accepted');
    await page.reload();
    await ready();
    await page.locator('[data-resume]').click();
    const restored = await state();
    check(JSON.stringify(restored) === JSON.stringify(feedback), 'Reload changed saved feedback/order');
    check(await page.locator('[aria-disabled=true]').count() === 4, 'Restored answers must stay locked');
    passed.push('registration; answered feedback and randomized question order survive reload');

    await advance();
    const beforeFailure = await state();
    await page.route('**/api/training/*/answer*', route => route.abort(), {times: 1});
    const nextId = await page.evaluate(() => questions[position].word.id);
    await page.locator(`[data-answer="${nextId}"]`).click();
    await page.locator('[data-retry]').waitFor();
    check(JSON.stringify(await state()) === JSON.stringify(beforeFailure), 'Failed save exposed accepted feedback');
    check(await page.locator('#continue').count() === 0, 'Unsaved answer allowed advance');
    await page.locator('[data-retry]').click();
    await page.locator('#continue').waitFor();
    await ready();
    check((await state()).answers.length === 2, 'Retry failed to save answer');
    passed.push('failed network save remains visible and retryable without premature feedback');

    await advance();
    let committedBody;
    await page.route('**/api/training/*/answer*', async route => {
      committedBody = route.request().postDataJSON();
      const response = await route.fetch();
      check(response.ok(), 'Lost-response fixture did not commit');
      await route.abort();
    }, {times: 1});
    const thirdId = await page.evaluate(() => questions[position].word.id);
    await page.locator(`[data-answer="${thirdId}"]`).click();
    await page.locator('[data-retry]').waitFor();
    check((await state()).answers.length === 2, 'Lost response changed unconfirmed UI state');
    let retriedBody;
    await page.route('**/api/training/*/answer*', async route => {
      retriedBody = route.request().postDataJSON();
      await route.continue();
    }, {times: 1});
    await page.locator('[data-retry]').click();
    await page.locator('#continue').waitFor();
    await ready();
    check(committedBody.requestId === retriedBody.requestId, 'Retry changed idempotency key');
    check((await state()).answers.length === 3, 'Lost-response retry scored twice');
    passed.push('lost committed response retries the same request and scores once');

    await advance();
    while ((await state()).position < (await state()).questions.length) {
      await answer(true);
      await advance();
    }
    check((await page.locator('.score-panel').innerText()).includes('9 / 10'), '9/10 results mismatch');
    await page.reload();
    await ready();
    await page.locator('[data-results]').click();
    await ready();
    check((await page.locator('.score-panel').innerText()).includes('9 / 10'), 'Completed result reload mismatch');
    await page.locator('[data-start=mistakes]').click();
    await ready();
    check((await state()).questions.length === 1, 'Retry includes correct words');
    check(await page.locator('[data-answer]').count() === 4, 'One-word retry lost full-deck options');
    await answer(true);
    await advance();
    check((await page.locator('.score-panel').innerText()).includes('1 / 1'), 'Perfect retry incorrect');
    passed.push('9/10 completion reload and missed-only retry with four choices');

    await page.locator('[data-screen=study]').click();
    await ready();
    await page.locator('[data-start=all]').click();
    await ready();
    const greekAttempt = (await state()).attempt.id;
    await page.locator('[data-screen=study]').click();
    await settings();
    await page.locator('[name=learning-set][value=demo-ar]').check();
    await ready();
    await study();
    await page.locator('[data-start=all]').click();
    await ready();
    check((await state()).attempt.deckId === 'demo-ar', 'Second deck not saved');
    await page.locator('[data-screen=study]').click();
    await settings();
    await page.locator('[name=learning-set][value=everyday-el]').check();
    await ready();
    await study();
    await page.locator('[data-resume]').click();
    check((await state()).attempt.id === greekAttempt, 'Deck switch erased Greek attempt');
    passed.push('deck switching preserves independently resumable attempts');

    const otherPage = await context.newPage();
    await otherPage.goto(root);
    await otherPage.waitForFunction(() => !busy && user && deckLoaded);
    await otherPage.locator('[data-resume]').click();
    await answer(true);
    const staleId = await otherPage.evaluate(() => questions[position].word.id);
    await otherPage.locator(`[data-answer="${staleId}"]`).click();
    await otherPage.locator('[data-reload]').waitFor();
    check(await otherPage.locator('#continue').count() === 0, 'Stale tab overwrote newer feedback');
    await otherPage.locator('[data-reload]').click();
    await otherPage.waitForFunction(() => !busy && !failedOperation && deckLoaded);
    await otherPage.locator('[data-resume]').click();
    check(await otherPage.evaluate(() => selected !== null && answers.length === 1), 'Conflict recovery did not load canonical feedback');
    await otherPage.close();
    passed.push('stale tab conflicts expose reload and restore the accepted first answer');

    await page.locator('[data-screen=study]').click();
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
    check(await page.evaluate(() => !user && !attempt && !questions.length && !answers.length && !lastSession), 'Logout retained another account state');
    await register(`other-${unique}@example.com`);
    check(await page.locator('[data-resume]').count() === 0, 'Second account inherited saved attempt');
    check(await page.locator('[data-results]').count() === 0, 'Second account inherited results');
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
    await login(firstEmail);
    await page.locator('[data-resume]').click();
    check((await state()).attempt.id === greekAttempt, 'Original learner lost saved practice');
    passed.push('logout clears state, second account stays isolated, original account restores practice');

    await page.route('**/api/training/*/advance*', route => route.fulfill({status: 401,
      contentType: 'application/json', body: JSON.stringify({error: {code: 'unauthorized', message: 'Session expired'}})}), {times: 1});
    await page.locator('#continue').click();
    await page.locator('#account-form').waitFor();
    check(await page.evaluate(() => !user && !attempt && !questions.length && !answers.length), 'Auth expiry retained private state');
    passed.push('expired authentication clears account-specific state');
    await login(firstEmail);
    const stalePage = await context.newPage();
    await stalePage.goto(root);
    await stalePage.waitForFunction(() => !busy && user && deckLoaded);
    const firstUserId = await stalePage.evaluate(() => user.id);
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
    await login(`other-${unique}@example.com`);
    check(await page.evaluate(() => user.id) !== firstUserId, 'Second tab did not change shared account');
    await stalePage.locator('[data-start=all]').click();
    await stalePage.locator('#account-form').waitFor();
    check(await stalePage.evaluate(() => !user && !attempt && !questions.length && !answers.length), 'Stale account tab kept private state');
    const otherProgress = await page.evaluate(async () => {
      const response = await fetch('/api/training?deckId=everyday-el');
      return {status: response.status, body: await response.json()};
    });
    check(otherProgress.status === 200 && otherProgress.body.attempt === null, 'Stale tab created practice for the newly logged-in learner');
    await stalePage.close();
    passed.push('shared-cookie account switch rejects stale-tab writes and preserves the new learner session');
    check(pageErrors.length === 0, `Browser errors: ${pageErrors.join('; ')}`);
    return {passed, pageErrors};
  } finally { await context.close(); }
}
