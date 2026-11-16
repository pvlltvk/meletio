async (page, options = {}) => {
  const context = await page.context().browser().newContext();
  page = await context.newPage();
  const url = options.url || 'http://127.0.0.1:4194/';
  const passed = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let currentPassword = 'a synthetic authoring password';
  try {
    await page.goto(url);
    await page.locator('#account-form').waitFor();
    await page.locator('[data-account-mode]').click();
    await page.locator('#account-email').fill(`authoring-${unique}@example.com`);
    await page.locator('#account-password').fill(currentPassword);
    await page.locator('#account-form button[type=submit]').click();
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await page.locator('[data-tokens-open]').click();
    await page.locator('#token-name').fill('Wrong password');
    await page.locator('#token-current-password').fill('incorrect confirmation password');
    await page.locator('#token-form button[type=submit]').click();
    await page.getByText('Current password is incorrect.', {exact: true}).waitFor();
    check(await page.locator('#token-current-password').inputValue() === '', 'Rejected token creation retained the password');
    check(await page.locator('#created-token').count() === 0, 'Wrong password created a displayed token');
    check(await page.locator('[data-token-row]').count() === 0, 'Wrong password created token metadata');
    passed.push('Token creation requires the current password and clears it after a rejection');

    await page.locator('#token-current-password').fill(currentPassword);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    check(await page.locator('#token-current-password').inputValue() === '', 'Pagehide retained the token confirmation password');
    await page.evaluate(() => {
      const event = new Event('pageshow');
      Object.defineProperty(event, 'persisted', {value: true});
      window.dispatchEvent(event);
    });
    await page.locator('[data-tokens-open]').click();
    check(await page.locator('#token-current-password').inputValue() === '', 'BFCache restored the token confirmation password');
    passed.push('Token confirmation passwords clear on pagehide and cached restore');

    await page.locator('#token-name').fill('Book vocabulary');
    await page.locator('#token-current-password').fill(currentPassword);
    await page.locator('#token-form button[type=submit]').click();
    await page.locator('#created-token').waitFor();
    const secret = await page.locator('#created-token').inputValue();
    check(secret.length >= 32, 'Token creation did not display a usable secret');
    check(await page.locator('#token-current-password').inputValue() === '', 'Successful token creation retained the password');
    check(await page.evaluate(value => !JSON.stringify(localStorage).includes(value) && !JSON.stringify(sessionStorage).includes(value), currentPassword), 'Token confirmation password was written to browser storage');
    check(await page.evaluate(value => !JSON.stringify(localStorage).includes(value) && !JSON.stringify(sessionStorage).includes(value), secret), 'Token was written to browser storage');
    await page.getByRole('button', {name: 'Vocabulary', exact: true}).click();
    check(await page.locator('#created-token').count() === 0, 'Navigation retained the token secret');
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await page.locator('[data-tokens-open]').click();
    await page.getByText('Book vocabulary', {exact: true}).waitFor();
    check(await page.locator('#created-token').count() === 0, 'Token listing redisplayed the secret');
    passed.push('Settings creates a token once and navigation clears it without browser storage');

    await page.locator('#token-name').fill('Page lifecycle');
    await page.locator('#token-current-password').fill(currentPassword);
    await page.locator('#token-form button[type=submit]').click();
    await page.locator('#created-token').waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    check(await page.locator('#created-token').count() === 0, 'Pagehide retained the token secret');
    await page.evaluate(() => {
      const event = new Event('pageshow');
      Object.defineProperty(event, 'persisted', {value: true});
      window.dispatchEvent(event);
    });
    check(await page.locator('#created-token').count() === 0, 'BFCache restored the token secret');
    passed.push('Pagehide and BFCache restore clear displayed token secrets');

    await page.locator('[data-tokens-open]').click();
    await page.getByText('Book vocabulary', {exact: true}).waitFor();
    await page.locator('[data-token-row]').filter({hasText: 'Book vocabulary'}).getByRole('button', {name: 'Revoke', exact: true}).click();
    await page.getByText('Book vocabulary', {exact: true}).waitFor({state: 'detached'});
    passed.push('Settings lists token metadata and revokes an individual token');

    const nativeResponse = await context.request.post(new URL('/api/authoring/decks', url).href, {
      headers: {Origin: new URL(url).origin}, data: {requestId: `native-${unique}`, title: `Native ${unique}`,
        termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr'}
    });
    check(nativeResponse.status() === 201, 'Native set creation failed');
    const native = (await nativeResponse.json()).deck;
    await page.reload();
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await page.locator(`[name="learning-set"][value="${native.id}"]`).check();
    await page.getByRole('heading', {name: `Manage Native ${unique}`, exact: true}).waitFor();
    check(await page.locator('[data-restore-media]').count() === 0, 'Native set exposed Anki media repair');
    check(!(await page.locator('.deck-option.selected').innerText()).includes('Default'), 'Native set was labeled as a default');
    check(await page.locator('[data-rename-set]').count() === 1, 'Native set lost existing management controls');
    passed.push('Native sets appear in Settings with management controls and no Anki or default labels');

    await page.locator('[data-tokens-open]').click();
    await page.locator('#token-name').fill('Uncertain creation');
    let creations = 0;
    await page.route('**/api/account/tokens', async route => {
      creations++;
      const response = await route.fetch();
      check(response.status() === 201, 'Lost-response fixture did not commit');
      await route.abort();
    }, {times: 1});
    await page.locator('#token-current-password').fill(currentPassword);
    await page.locator('#token-form button[type=submit]').click();
    await page.getByText(/Token creation could not be confirmed/).waitFor();
    await page.waitForTimeout(100);
    check(creations === 1, 'Uncertain token creation automatically retried');
    check(await page.locator('#created-token').count() === 0, 'Uncertain token creation reported a secret');
    await page.locator('[data-tokens-close]').click();
    await page.locator('[data-tokens-open]').click();
    await page.getByText('Uncertain creation', {exact: true}).waitFor();
    await page.locator('[data-token-row]').filter({hasText: 'Uncertain creation'}).getByRole('button', {name: 'Revoke', exact: true}).click();
    await page.getByText('Uncertain creation', {exact: true}).waitFor({state: 'detached'});
    passed.push('Uncertain creation does not retry and its metadata can be recovered and revoked');

    let release;
    let committed;
    const held = new Promise(resolve => { release = resolve; });
    const saved = new Promise(resolve => { committed = resolve; });
    await page.route('**/api/account/tokens', async route => {
      const response = await route.fetch();
      check(response.status() === 201, 'Delayed-token fixture did not commit');
      committed();
      await held;
      await route.fulfill({response});
    }, {times: 1});
    await page.locator('#token-name').fill('Delayed old account');
    await page.locator('#token-current-password').fill(currentPassword);
    await page.locator('#token-form button[type=submit]').click();
    await saved;
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
    await page.locator('[data-account-mode]').click();
    await page.locator('#account-email').fill(`authoring-other-${unique}@example.com`);
    currentPassword = 'another synthetic authoring password';
    await page.locator('#account-password').fill(currentPassword);
    await page.locator('#account-form button[type=submit]').click();
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    const delivered = page.waitForResponse(response => response.url().endsWith('/api/account/tokens') && response.request().method() === 'POST');
    release();
    await delivered;
    await page.locator('[data-tokens-open]').click();
    await page.getByText('No active tokens.', {exact: true}).waitFor();
    check(await page.locator('#created-token').count() === 0, 'Delayed response exposed the previous account token');
    check(await page.locator('[data-token-row]').count() === 0, 'Token metadata crossed accounts');
    passed.push('Delayed token responses are ignored after logout and account changes');

    await page.locator('#token-name').fill('Script workflow');
    await page.locator('#token-current-password').fill(currentPassword);
    await page.locator('#token-form button[type=submit]').click();
    await page.locator('#created-token').waitFor();
    const workflowToken = await page.locator('#created-token').inputValue();
    const api = async (path, data) => {
      const response = await context.request.post(new URL(path, url).href, {
        headers: {Authorization: `Bearer ${workflowToken}`}, data
      });
      check(response.ok(), `Script request failed: ${path}`);
      return response.json();
    };
    const authored = (await api('/api/authoring/decks', {requestId: `script-${unique}`, title: `Script ${unique}`,
      termLang: 'el', meaningLang: 'en', termDir: 'ltr', meaningDir: 'ltr'})).deck;
    const image = await page.evaluate(async ({token, requestId}) => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPa8AAAAASUVORK5CYII='), value => value.charCodeAt(0));
      const response = await fetch('/api/authoring/media', {method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream',
        'X-Request-Id': requestId, 'X-Media-Filename': 'picture.png'
      }, body: bytes});
      if (!response.ok) throw new Error('Script picture upload failed');
      return response.json();
    }, {token: workflowToken, requestId: `picture-${unique}`});
    const batch = {requestId: `words-${unique}`, revision: authored.revision, words: [
      {term: 'νερό', meaning: 'water', imageMediaId: image.id},
      {term: 'ψωμί', meaning: 'bread', imageMediaId: image.id},
      {term: 'γάτα', meaning: 'cat', imageMediaId: image.id},
      {term: 'βιβλίο', meaning: 'book', imageMediaId: image.id}
    ]};
    const savedBatch = await api(`/api/authoring/decks/${authored.id}/words`, batch);
    const replayedBatch = await api(`/api/authoring/decks/${authored.id}/words`, batch);
    check(JSON.stringify(savedBatch) === JSON.stringify(replayedBatch), 'Script retry duplicated vocabulary');
    await page.reload();
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await page.locator(`[name="learning-set"][value="${authored.id}"]`).check();
    await page.getByRole('heading', {name: `Manage Script ${unique}`, exact: true}).waitFor();
    await page.getByRole('button', {name: 'Vocabulary', exact: true}).click();
    check(await page.locator('[data-word]').count() === 4, 'Authored vocabulary did not load in the app');
    await page.waitForFunction(() => [...document.querySelectorAll('.word-image img')].every(image => image.complete && image.naturalWidth > 0));
    await page.getByRole('button', {name: 'Study', exact: true}).click();
    await page.locator('[data-start="lesson"]').click();
    await page.locator('[data-answer]').first().waitFor();
    const correctId = await page.evaluate(() => questions[position].word.id);
    await page.locator(`[data-answer="${correctId}"]`).click();
    await page.locator('#continue').waitFor();
    await page.reload();
    await page.locator('[data-resume]').click();
    await page.locator('#continue').waitFor();
    check(await page.locator('.answer.correct').count() === 1, 'Authored lesson feedback did not survive reload');
    passed.push('Script tokens create picture vocabulary with safe retries and resumable lessons');
    return {passed};
  } finally { await context.close(); }
};
