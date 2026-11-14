async (page, options = {}) => {
  const context = await page.context().browser().newContext();
  page = await context.newPage();
  const url = options.url || 'http://127.0.0.1:4194/';
  const passed = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await page.goto(url);
    await page.locator('#account-form').waitFor();
    await page.locator('[data-account-mode]').click();
    await page.locator('#account-email').fill(`authoring-${unique}@example.com`);
    await page.locator('#account-password').fill('a synthetic authoring password');
    await page.locator('#account-form button[type=submit]').click();
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await page.locator('[data-tokens-open]').click();
    await page.locator('#token-name').fill('Book vocabulary');
    await page.locator('#token-form button[type=submit]').click();
    await page.locator('#created-token').waitFor();
    const secret = await page.locator('#created-token').inputValue();
    check(secret.length >= 32, 'Token creation did not display a usable secret');
    check(await page.evaluate(value => !JSON.stringify(localStorage).includes(value) && !JSON.stringify(sessionStorage).includes(value), secret), 'Token was written to browser storage');
    await page.getByRole('button', {name: 'Vocabulary', exact: true}).click();
    check(await page.locator('#created-token').count() === 0, 'Navigation retained the token secret');
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await page.locator('[data-tokens-open]').click();
    await page.getByText('Book vocabulary', {exact: true}).waitFor();
    check(await page.locator('#created-token').count() === 0, 'Token listing redisplayed the secret');
    passed.push('Settings creates a token once and navigation clears it without browser storage');

    await page.locator('#token-name').fill('Page lifecycle');
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
    return {passed};
  } finally { await context.close(); }
};
