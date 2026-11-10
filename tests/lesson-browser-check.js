async (page, options = {}) => {
  const context = await page.context().browser().newContext({viewport: {width: 390, height: 844}});
  page = await context.newPage();
  const root = options.url || 'http://127.0.0.1:4194/';
  const passed = []; const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const ready = () => page.waitForFunction(() => user && deckLoaded && !busy && !failedOperation);
  const password = 'synthetic lesson test password';
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const register = async suffix => {
    await page.locator('[data-account-mode]').click();
    await page.locator('#account-email').fill(`lesson-${suffix}-${unique}@example.test`);
    await page.locator('#account-password').fill(password);
    await page.locator('#account-form button[type=submit]').click();
    await ready();
  };
  const summary = () => page.evaluate(async () => (await (await fetch(`/api/training?deckId=${encodeURIComponent(deck.id)}&format=compact`)).json()).review);
  const state = () => page.evaluate(() => JSON.parse(JSON.stringify({attempt, questions, answers, position, selected})));
  const answer = async correct => {
    const id = await page.evaluate(correct => {
      const question = questions[position];
      return correct ? question.word.id : question.options.find(option => option.id !== question.word.id).id;
    }, correct);
    await page.locator(`[data-answer="${id}"]`).click();
    await page.locator('#continue').waitFor(); await ready();
  };
  const advance = async () => { await page.locator('#continue').click(); await ready(); };
  try {
    await page.goto(root);
    await page.locator('#account-form').waitFor();
    await register('first');
    check(await page.locator('[data-start=lesson]').count() === 1, 'Study has no default short lesson action');
    check((await summary()).new === 10, 'Fresh learner does not have ten new Greek words');
    check(await page.locator('[data-start=all]').count() === 1, 'Optional full practice disappeared');
    for (const viewport of [{width: 320, height: 568}, {width: 390, height: 844}, {width: 768, height: 844}, {width: 1280, height: 900}]) {
      await page.setViewportSize(viewport);
      for (const direction of ['ltr', 'rtl']) {
        await page.evaluate(direction => { document.documentElement.dir = direction; }, direction);
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Lesson Study overflows at ${viewport.width}/${direction}`);
      }
    }
    await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
    await page.setViewportSize({width: 390, height: 844});
    passed.push('Study offers automatic lessons and full practice with four-size/RTL layout');

    await page.locator('[data-start=lesson]').click(); await ready();
    check((await state()).attempt.mode === 'lesson' && (await state()).questions.length === 10, 'Lesson mode/count mismatch');
    await answer(false);
    const first = await state(); const initialReview = await summary();
    check(initialReview.new === 9 && initialReview.due === 0, 'First saved answer did not schedule exactly one word');
    await page.locator('[data-screen=study]').click(); await ready();
    check(await page.evaluate(() => document.activeElement.tagName === 'H1'), 'Leaving a lesson lost Study heading focus');
    await page.locator('[data-screen=settings]').click();
    await page.locator('[data-screen=study]').click(); await ready();
    check(await page.evaluate(() => document.activeElement.tagName === 'H1'), 'Study navigation lost heading focus');
    await page.reload(); await ready();
    check((await page.locator('[data-resume]').innerText()).includes('lesson'), 'Saved lesson resume is not identified');
    await page.locator('[data-resume]').click();
    check(JSON.stringify(await state()) === JSON.stringify(first), 'Lesson feedback/questions changed after reload');
    passed.push('first-answer review state and exact lesson feedback survive reload and resume');

    await advance();
    const beforeFailure = await state();
    await page.route('**/api/training/*/answer*', route => route.abort(), {times: 1});
    const id = await page.evaluate(() => questions[position].word.id);
    await page.locator(`[data-answer="${id}"]`).click();
    await page.locator('[data-retry]').waitFor();
    check(JSON.stringify(await state()) === JSON.stringify(beforeFailure) && (await summary()).new === 9, 'Failed lesson save changed answer/schedule');
    await page.locator('[data-retry]').click(); await page.locator('#continue').waitFor(); await ready();
    check((await summary()).new === 8, 'Retried lesson answer did not schedule one word');
    await advance();
    await page.route('**/api/training/*/answer*', async route => { const response = await route.fetch(); check(response.ok(), 'Lost-response lesson fixture failed'); await route.abort(); }, {times: 1});
    const lostId = await page.evaluate(() => questions[position].word.id);
    await page.locator(`[data-answer="${lostId}"]`).click(); await page.locator('[data-retry]').waitFor();
    const lost = await summary();
    await page.locator('[data-retry]').click(); await page.locator('#continue').waitFor(); await ready();
    const replay = await summary();
    check(lost.new === 7 && replay.new === 7 && lost.nextDue === replay.nextDue, 'Receipt replay changed lesson review dates');
    passed.push('failed saves preserve schedules; lost committed responses replay without duplicate review');

    await advance();
    while ((await state()).attempt.status !== 'completed') { await answer(true); await advance(); }
    check((await page.locator('h1').innerText()).includes('Lesson complete'), 'Completed lesson is not identified');
    const completed = await summary();
    check(completed.new === 0 && completed.due === 0 && completed.nextDue > completed.asOf, 'Completed lesson summary is wrong');
    await page.locator('[data-start=mistakes]').click(); await ready();
    check((await state()).attempt.mode !== 'lesson' && (await state()).questions.length === 1, 'Missed-word retry must remain ordinary practice');
    check(await page.locator('[data-answer]').count() === 4, 'One-word retry lost full-set choices');
    await answer(true); await advance();
    check((await summary()).nextDue === completed.nextDue, 'Immediate missed-word retry promoted review dates');
    await page.locator('[data-screen=study]').click(); await ready();
    check(await page.locator('[data-start=lesson]').count() === 0, 'Lesson offered when no words are due/new');
    check((await page.locator('.hero').innerText()).includes('up to date'), 'No-due Study lacks honest review status');
    check(await page.locator('[data-start=all]').count() === 1, 'No-due Study lost optional practice');
    passed.push('lesson completion and missed-word retry preserve future dates and show no-due status');

    for (const selector of ['[data-start=all]', '[data-logout]', 'h1']) {
      let refreshes = 0;
      await page.route('**/api/training?*', async route => {
        refreshes++;
        const response = await route.fetch(); const body = await response.json();
        if (refreshes === 1) body.review.nextDue = body.review.asOf + 100;
        await route.fulfill({response, json: body});
      });
      await page.reload(); await ready();
      if (selector === 'h1') await page.locator(selector).evaluate(element => { element.tabIndex = -1; });
      await page.locator(selector).focus();
      await page.waitForTimeout(1400); await ready();
      check(refreshes >= 2, 'Study did not refresh its server summary at the next due time');
      check(await page.locator(selector).evaluate(element => document.activeElement === element), `Automatic Study refresh lost focus from ${selector}`);
      await page.unroute('**/api/training?*');
    }
    passed.push('visible Study refreshes the authoritative summary when its next due time arrives');

    await page.locator('[data-logout]').click(); await page.locator('#account-form').waitFor();
    await register('second');
    check((await summary()).new === 10, 'First learner scheduling leaked to another account');
    await page.locator('[data-start=lesson]').click(); await ready();
    const other = await context.newPage(); await other.goto(root); await other.waitForFunction(() => user && deckLoaded && !busy);
    await other.locator('[data-resume]').click();
    const otherId = await other.evaluate(() => questions[position].word.id);
    await other.locator(`[data-answer="${otherId}"]`).click(); await other.locator('#continue').waitFor();
    const staleId = await page.evaluate(() => questions[position].word.id);
    await page.locator(`[data-answer="${staleId}"]`).click(); await page.locator('[data-reload]').waitFor();
    check((await state()).answers.length === 0, 'Stale lesson tab accepted conflicting feedback');
    await page.locator('[data-reload]').click(); await ready();
    check((await summary()).new === 9, 'Stale lesson write changed the schedule twice');
    await other.close();
    passed.push('learner schedules are independent and stale tabs reload the single accepted answer');
    check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
    return {passed, pageErrors: errors};
  } finally { await context.close(); }
}
