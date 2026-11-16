/* global user, deckLoaded, busy, failedOperation, deck, decks, document */
async (page, options = {}) => {
  const context = await page.context().browser().newContext();
  page = await context.newPage();
  const url = options.url || 'http://127.0.0.1:4194/';
  const passed = [];
  const errors = [];
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const password = 'synthetic browser authoring password';
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const ready = deckId => page.waitForFunction(id => user && deckLoaded && !busy && !failedOperation && (!id || deck.id === id), deckId);
  const catalog = async () => {
    const response = await context.request.get(new URL('/api/authoring/decks', url).href);
    check(response.ok(), `Could not read synthetic account catalog: ${response.status()}`);
    return (await response.json()).decks;
  };
  const createForm = async () => {
    await page.locator('[data-create-set]').click();
    await page.locator('#create-set-form').waitFor();
  };
  const fillCreate = async (title, config = {}) => {
    const form = page.locator('#create-set-form');
    await form.locator('[name=title]').fill(title);
    if (config.termLang) await form.locator('[name=termLang]').fill(config.termLang);
    if (config.meaningLang) await form.locator('[name=meaningLang]').fill(config.meaningLang);
    if (config.termDir) await form.locator('[name=termDir]').selectOption(config.termDir);
    if (config.meaningDir) await form.locator('[name=meaningDir]').selectOption(config.meaningDir);
  };
  const openCreateFromSettings = async () => {
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await createForm();
  };
  const chooseAccount = async (email) => {
    await page.locator('#account-form').waitFor();
    await page.locator('[data-account-mode]').click();
    await page.locator('#account-email').fill(email);
    await page.locator('#account-password').fill(password);
    await page.locator('#account-form button[type=submit]').click();
    await ready();
  };
  const authoredWithTitle = async title => (await catalog()).filter(item => item.title === title && item.authored);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    await chooseAccount(`browser-authoring-${unique}@example.test`);

    const regularTitle = `Καθημερινά ${unique}`;
    await openCreateFromSettings();
    await fillCreate(regularTitle, {termLang: 'ar', meaningLang: 'el', termDir: 'rtl', meaningDir: 'ltr'});
    const beforeRegular = await catalog();
    const regularPostBodies = [];
    await page.route('**/api/authoring/decks', async route => {
      if (route.request().method() === 'POST') regularPostBodies.push(route.request().postDataJSON());
      await route.continue();
    });
    await page.locator('#create-set-form button[type=submit]').click();
    await page.locator('#create-set-form').waitFor({state: 'detached'});
    await page.waitForFunction(title => decks.some(item => item.title === title && item.authored), regularTitle);
    const regular = (await authoredWithTitle(regularTitle))[0];
    check(regular && regular.termLang === 'ar' && regular.meaningLang === 'el' && regular.termDir === 'rtl' && regular.meaningDir === 'ltr',
      'Created set did not preserve its language and direction choices');
    check(await page.evaluate(() => deck.id) === regular.id, 'Created set was not selected');
    check(regularPostBodies.length === 1 && regularPostBodies[0].title === regularTitle && regularPostBodies[0].termDir === 'rtl',
      'Create form did not send its selected configuration once');
    check((await catalog()).length === beforeRegular.length + 1, 'Creating a set did not add exactly one catalog entry');
    await page.unrouteAll({behavior: 'wait'});
    await page.reload();
    await ready(regular.id);
    check(await page.evaluate(() => deck.id) === regular.id, 'Created set selection did not survive reload');
    passed.push('Settings creates a native set with its language and RTL configuration, selects it, and restores selection after reload');

    const beforeCancel = await catalog();
    await openCreateFromSettings();
    await fillCreate(`Canceled ${unique}`);
    await page.locator('[data-authoring-cancel]').click();
    await page.waitForFunction(() => !document.querySelector('#create-set-form'));
    check((await catalog()).length === beforeCancel.length, 'Cancel created a set');

    let invalidPosts = 0;
    await page.route('**/api/authoring/decks', async route => {
      if (route.request().method() === 'POST') invalidPosts += 1;
      await route.continue();
    });
    await createForm();
    await fillCreate('');
    await page.locator('#create-set-form button[type=submit]').click();
    check(await page.locator('#create-set-form').count() === 1, 'Invalid set form was submitted');
    check(invalidPosts === 0 && (await catalog()).length === beforeCancel.length, 'Invalid submission created a set');
    await page.unrouteAll({behavior: 'wait'});
    await page.locator('[data-authoring-cancel]').click();
    passed.push('Cancel and invalid required fields leave the native set catalog unchanged');

    const duplicateTitle = `Double submit ${unique}`;
    await openCreateFromSettings();
    await fillCreate(duplicateTitle);
    let duplicateCount = 0;
    let releaseDuplicate;
    let committedDuplicate;
    const duplicateGate = new Promise(resolve => { releaseDuplicate = resolve; });
    const duplicateSaved = new Promise(resolve => { committedDuplicate = resolve; });
    await page.route('**/api/authoring/decks', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      duplicateCount += 1;
      const response = await route.fetch();
      check(response.status() === 201, 'Double-submit create did not commit');
      committedDuplicate();
      await duplicateGate;
      await route.fulfill({response});
    }, {times: 1});
    await page.locator('#create-set-form button[type=submit]').click();
    await duplicateSaved;
    await page.locator('#create-set-form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await page.waitForTimeout(100);
    check(duplicateCount === 1, 'Double submit sent more than one create request');
    releaseDuplicate();
    await page.locator('#create-set-form').waitFor({state: 'detached'});
    check((await authoredWithTitle(duplicateTitle)).length === 1, 'Double submit created duplicate sets');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('Repeated submit while creation is pending sends a single create request');

    const lostTitle = `Lost response ${unique}`;
    await openCreateFromSettings();
    await fillCreate(lostTitle, {termLang: 'el', meaningLang: 'ar', termDir: 'ltr', meaningDir: 'rtl'});
    const lostBodies = [];
    await page.route('**/api/authoring/decks', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      lostBodies.push(route.request().postDataJSON());
      if (lostBodies.length === 1) {
        const response = await route.fetch();
        check(response.status() === 201, 'Lost-response create did not commit');
        await route.abort();
        return;
      }
      await route.continue();
    }, {times: 2});
    await page.locator('#create-set-form button[type=submit]').click();
    await page.locator('[data-authoring-retry]').waitFor();
    check((await authoredWithTitle(lostTitle)).length === 1, 'Committed create was missing after the response was lost');
    check(lostBodies.length === 1, 'Uncertain create automatically retried');
    await page.locator('[data-authoring-retry]').click();
    await page.locator('#create-set-form').waitFor({state: 'detached'});
    check(lostBodies.length === 2 && JSON.stringify(lostBodies[0]) === JSON.stringify(lostBodies[1]), 'Retry did not reuse the exact create request');
    check((await authoredWithTitle(lostTitle)).length === 1, 'Explicit retry duplicated the committed set');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('Lost create response offers an explicit exact replay without creating a duplicate set');

    for (const failure of ['catalog', 'deck']) {
      const title = `${failure} recovery ${unique}`;
      await openCreateFromSettings();
      await fillCreate(title);
      let posts = 0;
      let injected = false;
      await page.route('**/api/**', async route => {
        const request = route.request();
        if (request.method() === 'POST' && request.url().endsWith('/api/authoring/decks')) {
          posts += 1;
          const response = await route.fetch();
          check(response.status() === 201, `${failure} recovery create did not commit`);
          return route.fulfill({response});
        }
        const isCatalog = request.method() === 'GET' && new URL(request.url()).pathname === '/api/decks';
        const isDeck = request.method() === 'GET' && /^\/api\/decks\//.test(new URL(request.url()).pathname);
        if (!injected && (failure === 'catalog' ? isCatalog : isDeck)) {
          injected = true;
          return route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: {message: 'Synthetic refresh failure'}})});
        }
        await route.continue();
      });
      await page.locator('#create-set-form button[type=submit]').click();
      await page.locator('[data-authoring-retry]').waitFor();
      check(posts === 1 && (await authoredWithTitle(title)).length === 1, `${failure} failure changed the committed set count`);
      await page.locator('[data-authoring-retry]').click();
      await page.locator('#create-set-form').waitFor({state: 'detached'});
      check(posts === 1 && (await authoredWithTitle(title)).length === 1, `${failure} recovery repeated the successful POST`);
      check(await page.evaluate(value => deck.title === value, title), `${failure} retry did not select the saved set`);
      await page.unrouteAll({behavior: 'wait'});
      passed.push(`A successful create recovers from a failed ${failure} refresh without repeating the POST`);
    }

    const oldEmail = `browser-authoring-old-${unique}@example.test`;
    const oldAccount = await context.request.post(new URL('/api/auth/register', url).href, {
      headers: {Origin: new URL(url).origin}, data: {email: oldEmail, password}
    });
    check(oldAccount.status() === 201, 'Could not create delayed-response account fixture');
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
    await page.locator('#account-email').fill(oldEmail);
    await page.locator('#account-password').fill(password);
    await page.locator('#account-form button[type=submit]').click();
    await ready();
    const oldTitle = `Old account ${unique}`;
    await openCreateFromSettings();
    await fillCreate(oldTitle);
    let releaseOld;
    let committedOld;
    const oldGate = new Promise(resolve => { releaseOld = resolve; });
    const oldSaved = new Promise(resolve => { committedOld = resolve; });
    await page.route('**/api/authoring/decks', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      check(response.status() === 201, 'Delayed create fixture did not commit');
      committedOld();
      await oldGate;
      await route.fulfill({response});
    }, {times: 1});
    await page.locator('#create-set-form button[type=submit]').click();
    await oldSaved;
    await page.locator('[data-authoring-cancel]').click();
    await page.locator('[data-authoring-discard]').click();
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
    await chooseAccount(`browser-authoring-new-${unique}@example.test`);
    const newAccountId = await page.evaluate(() => user.id);
    releaseOld();
    await page.waitForTimeout(100);
    await ready();
    check(await page.evaluate(({id, title}) => user.id === id && !decks.some(item => item.title === title), {id: newAccountId, title: oldTitle}),
      'Delayed create response appeared in a different account');
    check((await catalog()).every(item => item.title !== oldTitle), 'Old account set leaked into the new account catalog');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('Delayed create response is ignored after logout and account switch');

    check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
    return {passed, pageErrors: errors};
  } finally { await context.close(); }
};
