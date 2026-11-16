/* global user, deckLoaded, busy, failedOperation, deck, document */
async (page, options = {}) => {
  const context = await page.context().browser().newContext();
  page = await context.newPage();
  const url = options.url || 'http://127.0.0.1:4194/';
  const origin = new URL(url).origin;
  const passed = [];
  const errors = [];
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const password = 'synthetic browser word password';
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const ready = deckId => page.waitForFunction(id => user && deckLoaded && !busy && !failedOperation && (!id || deck.id === id), deckId);
  const request = async (path, data) => {
    const response = await context.request.post(new URL(path, url).href, {headers: {Origin: origin}, data});
    const body = await response.json();
    check(response.ok(), `${path} failed: ${JSON.stringify(body)}`);
    return body;
  };
  const readDeck = async id => {
    const response = await context.request.get(new URL(`/api/authoring/decks/${id}`, url).href);
    check(response.ok(), `Could not read authored set ${id}`);
    return (await response.json()).deck;
  };
  const createSet = async title => (await request('/api/authoring/decks', {requestId: `fixture-${unique}-${title}`,
    title, termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr'})).deck;
  const register = async email => {
    await page.locator('#account-form').waitFor();
    await page.locator('[data-account-mode]').click();
    await page.locator('#account-email').fill(email);
    await page.locator('#account-password').fill(password);
    await page.locator('#account-form button[type=submit]').click();
    await ready();
  };
  const selectSet = async id => {
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await page.locator(`[name=learning-set][value="${id}"]`).check();
    await ready(id);
    await page.getByRole('button', {name: 'Vocabulary', exact: true}).click();
    await ready(id);
  };
  const openForm = async () => {
    if (!await page.locator('#add-word-form').count()) await page.locator('[data-add-word]').click();
    await page.locator('#add-word-form').waitFor();
  };
  const fillWord = async (term, meaning) => {
    await page.locator('#add-word-form [name=term]').fill(term);
    await page.locator('#add-word-form [name=meaning]').fill(meaning);
  };
  const saveWord = async (term, meaning) => {
    await openForm();
    await fillWord(term, meaning);
    await page.locator('#add-word-form button[type=submit]').click();
    await page.getByText(term, {exact: true}).waitFor();
  };
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    await register(`browser-word-${unique}@example.test`);
    const native = await createSet(`Word set ${unique}`);
    const otherNative = await createSet(`Other word set ${unique}`);
    await page.reload();

    await page.getByRole('button', {name: 'Vocabulary', exact: true}).click();
    await ready('everyday-el');
    check(await page.locator('[data-add-word]').count() === 0, 'Default vocabulary exposed the authored-word form');
    const preview = await context.newPage();
    await preview.goto(new URL('/preview.html', url).href);
    check(await preview.locator('[data-add-word]').count() === 0, 'Preview mode exposed the authored-word form');
    await preview.close();
    await selectSet(native.id);
    check(await page.locator('[data-add-word]').count() === 1, 'Native set did not expose the add-word entry');
    passed.push('Text word authoring is available only for a signed-in authored set');

    const beforeCancel = await readDeck(native.id);
    await openForm();
    await fillWord(`Canceled ${unique}`, 'unused meaning');
    await page.locator('[data-authoring-cancel]').click();
    await page.waitForFunction(() => !document.querySelector('#add-word-form'));
    check((await readDeck(native.id)).words.length === beforeCancel.words.length, 'Cancel saved the word draft');
    let invalidPosts = 0;
    await page.route(`**/api/authoring/decks/${native.id}/words`, async route => {
      if (route.request().method() === 'POST') invalidPosts += 1;
      await route.continue();
    });
    await openForm();
    await fillWord('', '');
    await page.locator('#add-word-form button[type=submit]').click();
    check(await page.locator('#add-word-form').count() === 1 && invalidPosts === 0,
      'Invalid word form was submitted');
    check((await readDeck(native.id)).words.length === beforeCancel.words.length, 'Invalid submission saved a word');
    await page.unrouteAll({behavior: 'wait'});
    await page.locator('[data-authoring-cancel]').click();
    passed.push('Cancel and invalid word fields do not write vocabulary');

    const terms = [
      [`νερό-${unique}`, 'water'], [`ψωμί-${unique}`, 'bread'],
      [`γάτα-${unique}`, 'cat'], [`βιβλίο-${unique}`, 'book']
    ];
    for (const [term, meaning] of terms) await saveWord(term, meaning);
    const fourWords = await readDeck(native.id);
    check(fourWords.words.length === 4, 'Four explicit text saves did not produce exactly four words');
    await page.getByRole('button', {name: 'Study', exact: true}).click();
    await ready(native.id);
    check(await page.locator('[data-start=lesson]').count() === 1, 'Four authored words did not enable a lesson');
    await page.locator('[data-start=lesson]').click();
    await page.locator('[data-answer]').first().waitFor();
    passed.push('Four one-at-a-time text saves appear in vocabulary and enable a lesson');

    const duplicateTerm = `διπλό-${unique}`;
    await page.getByRole('button', {name: 'Leave practice', exact: true}).click();
    await page.getByRole('button', {name: 'Vocabulary', exact: true}).click();
    await ready(native.id);
    await openForm();
    await fillWord(duplicateTerm, 'double');
    let duplicateRequests = 0;
    let releaseDuplicate;
    let committedDuplicate;
    const duplicateGate = new Promise(resolve => { releaseDuplicate = resolve; });
    const duplicateSaved = new Promise(resolve => { committedDuplicate = resolve; });
    await page.route(`**/api/authoring/decks/${native.id}/words`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      duplicateRequests += 1;
      const response = await route.fetch();
      check(response.status() === 200, 'Double-submit word did not commit');
      committedDuplicate();
      await duplicateGate;
      await route.fulfill({response});
    }, {times: 1});
    await page.locator('#add-word-form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await duplicateSaved;
    await page.waitForTimeout(100);
    check(duplicateRequests === 1, 'Double submit sent more than one word batch');
    releaseDuplicate();
    await page.getByText(duplicateTerm, {exact: true}).waitFor();
    check((await readDeck(native.id)).words.filter(word => word.term === duplicateTerm).length === 1,
      'Double submit duplicated the word');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('Repeated submit while a word save is pending sends only one batch');

    const lostTerm = `αβέβαιο-${unique}`;
    await openForm();
    await fillWord(lostTerm, 'uncertain');
    const lostBodies = [];
    await page.route(`**/api/authoring/decks/${native.id}/words`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      lostBodies.push(route.request().postDataJSON());
      if (lostBodies.length === 1) {
        const response = await route.fetch();
        check(response.status() === 200, 'Lost-response word did not commit');
        await route.abort();
        return;
      }
      await route.continue();
    }, {times: 2});
    await page.locator('#add-word-form button[type=submit]').click();
    await page.locator('[data-authoring-retry]').waitFor();
    check((await readDeck(native.id)).words.filter(word => word.term === lostTerm).length === 1,
      'Committed word was missing after the response was lost');
    check(lostBodies.length === 1, 'Uncertain word save automatically retried');
    await page.locator('[data-authoring-retry]').click();
    await page.getByText(lostTerm, {exact: true}).waitFor();
    check(lostBodies.length === 2 && JSON.stringify(lostBodies[0]) === JSON.stringify(lostBodies[1]),
      'Explicit word retry did not replay the exact request');
    check((await readDeck(native.id)).words.filter(word => word.term === lostTerm).length === 1,
      'Explicit retry duplicated the committed word');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('A committed word with a lost response is saved once through an exact explicit replay');

    const refreshTerm = `επανάκτηση-${unique}`;
    await openForm();
    await fillWord(refreshTerm, 'recovery');
    let refreshPosts = 0;
    let refreshInjected = false;
    await page.route('**/api/**', async route => {
      const request = route.request();
      if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/authoring/decks/${native.id}/words`) {
        refreshPosts += 1;
        const response = await route.fetch();
        check(response.status() === 200, 'Recovery word save did not commit');
        return route.fulfill({response});
      }
      const isDeckRead = request.method() === 'GET' && new URL(request.url()).pathname === `/api/decks/${native.id}`;
      if (!refreshInjected && isDeckRead) {
        refreshInjected = true;
        return route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: {message: 'Synthetic deck refresh failure'}})});
      }
      await route.continue();
    });
    await page.locator('#add-word-form button[type=submit]').click();
    await page.locator('[data-authoring-retry]').waitFor();
    check(refreshPosts === 1 && (await readDeck(native.id)).words.filter(word => word.term === refreshTerm).length === 1,
      'Successful save was duplicated or missing after deck refresh failed');
    await page.locator('[data-authoring-retry]').click();
    await page.getByText(refreshTerm, {exact: true}).waitFor();
    check(refreshPosts === 1 && (await readDeck(native.id)).words.filter(word => word.term === refreshTerm).length === 1,
      'Refresh recovery repeated the successful word POST');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('A committed word recovers from a failed deck refresh without repeating the POST');

    const staleTerm = `свіжий-${unique}`;
    const staleMeaning = 'fresh';
    await openForm();
    await fillWord(staleTerm, staleMeaning);
    const revisionBeforeExternalWrite = (await readDeck(native.id)).revision;
    const external = await request(`/api/authoring/decks/${native.id}/words`, {
      requestId: `external-${unique}`, revision: revisionBeforeExternalWrite,
      words: [{term: `external-${unique}`, meaning: 'external'}]
    });
    const staleBodies = [];
    await page.route(`**/api/authoring/decks/${native.id}/words`, async route => {
      if (route.request().method() === 'POST') staleBodies.push(route.request().postDataJSON());
      await route.continue();
    });
    await page.locator('#add-word-form button[type=submit]').click();
    await page.waitForFunction(revision => deck.revision === revision, external.revision);
    check(await page.locator('#add-word-form [name=term]').inputValue() === staleTerm
      && await page.locator('#add-word-form [name=meaning]').inputValue() === staleMeaning,
    'Stale revision discarded the text draft');
    check(staleBodies.length === 1 && staleBodies[0].revision === revisionBeforeExternalWrite,
      'Stale fixture did not submit against its original revision');
    await page.locator('#add-word-form button[type=submit]').click();
    await page.getByText(staleTerm, {exact: true}).waitFor();
    check(staleBodies.length === 2 && staleBodies[1].revision === external.revision
      && staleBodies[1].requestId !== staleBodies[0].requestId,
    'Explicit stale-draft save did not use the refreshed revision and a new request ID');
    const reconciled = await readDeck(native.id);
    check(reconciled.words.some(word => word.term === staleTerm)
      && reconciled.words.some(word => word.term === `external-${unique}`), 'Stale reconciliation lost either word');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('A stale revision keeps the draft and requires a fresh explicit save at the latest revision');

    const targetTerm = `відкладений-target-${unique}`;
    await openForm();
    await fillWord(targetTerm, 'target isolation');
    let releaseTarget;
    let committedTarget;
    const targetGate = new Promise(resolve => { releaseTarget = resolve; });
    const targetSaved = new Promise(resolve => { committedTarget = resolve; });
    await page.route(`**/api/authoring/decks/${native.id}/words`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      check(response.status() === 200, 'Delayed target word did not commit');
      committedTarget();
      await targetGate;
      await route.fulfill({response});
    }, {times: 1});
    await page.locator('#add-word-form button[type=submit]').click();
    await targetSaved;
    await page.locator('[data-authoring-cancel]').click();
    await page.locator('[data-authoring-discard]').click();
    await selectSet(otherNative.id);
    releaseTarget();
    await ready(otherNative.id);
    check(await page.getByText(targetTerm, {exact: true}).count() === 0, 'Delayed save leaked into the newly selected set');
    check((await readDeck(otherNative.id)).words.every(word => word.term !== targetTerm), 'Target switch changed the other set');
    check((await readDeck(native.id)).words.some(word => word.term === targetTerm), 'Delayed server commit was incorrectly reported as rolled back');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('Canceling an unresolved word save isolates its delayed result from the newly selected set');

    const accountTerm = `відкладений-account-${unique}`;
    await openForm();
    await fillWord(accountTerm, 'account isolation');
    let releaseAccount;
    let committedAccount;
    const accountGate = new Promise(resolve => { releaseAccount = resolve; });
    const accountSaved = new Promise(resolve => { committedAccount = resolve; });
    await page.route(`**/api/authoring/decks/${otherNative.id}/words`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      check(response.status() === 200, 'Delayed account word did not commit');
      committedAccount();
      await accountGate;
      await route.fulfill({response});
    }, {times: 1});
    await page.locator('#add-word-form button[type=submit]').click();
    await accountSaved;
    await page.locator('[data-authoring-cancel]').click();
    await page.locator('[data-authoring-discard]').click();
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
    const newEmail = `browser-word-new-${unique}@example.test`;
    await register(newEmail);
    releaseAccount();
    await ready();
    check(await page.evaluate(() => user.email) === newEmail, 'Delayed word response changed the signed-in account');
    check(await page.getByText(accountTerm, {exact: true}).count() === 0, 'Delayed word response leaked into another account');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('Canceling an unresolved word save prevents its delayed response crossing accounts');

    check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
    return {passed, pageErrors: errors};
  } finally { await context.close(); }
};
