async (page, options = {}) => {
  const browser = page.context().browser();
  const context = await browser.newContext();
  page = await context.newPage();
  const openUrl = options.url || 'http://127.0.0.1:4194/';
  const closedUrl = options.closedUrl || 'http://127.0.0.1:4195/';
  const passed = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `account-${unique}@example.com`;
  const oldPassword = 'a browser account password';
  const newPassword = 'a changed browser password';
  const finalPassword = 'the confirmed browser password';
  const ready = () => page.locator('#account-form').waitFor();
  const login = async (target, address, password) => {
    await target.locator('#account-email').fill(address);
    await target.locator('#account-password').fill(password);
    await target.locator('#account-form button[type=submit]').click();
  };
  const settings = () => page.getByRole('button', {name: 'Settings', exact: true}).click();
  const openPasswordForm = async () => {
    await settings();
    await page.locator('[data-change-password]').click();
    await page.locator('#password-form').waitFor();
  };
  try {
    await page.goto(closedUrl);
    await ready();
    check(await page.locator('[data-account-mode]').count() === 0, 'Closed registration exposed a registration control');
    check(await page.locator('#account-form').count() === 1, 'Closed registration prevented login form');
    passed.push('closed registration hides account creation and keeps login available');

    await page.goto(openUrl);
    await ready();
    await page.locator('[data-account-mode]').click();
    await login(page, email, oldPassword);
    await page.getByRole('button', {name: 'Settings', exact: true}).waitFor();
    await openPasswordForm();
    check(await page.locator('#password-form').count() === 1, 'Settings did not expose password form');

    await page.locator('#current-password').fill(oldPassword);
    await page.locator('#new-password').fill(newPassword);
    await page.locator('#confirm-password').fill(newPassword);
    await page.evaluate(() => {
      const event = new Event('pagehide');
      Object.defineProperty(event, 'persisted', {value: true});
      window.dispatchEvent(event);
    });
    for (const selector of ['#current-password', '#new-password', '#confirm-password']) {
      check(await page.locator(selector).inputValue() === '', `Pagehide retained a password in ${selector}`);
    }
    await page.evaluate(() => {
      const event = new Event('pageshow');
      Object.defineProperty(event, 'persisted', {value: true});
      window.dispatchEvent(event);
    });
    check(await page.locator('#password-form').count() === 0, 'Returning from BFCache restored the password form');
    check(await page.locator('[data-change-password]').count() === 1, 'Returning from BFCache did not leave password change available');
    passed.push('pagehide clears password fields and pageshow restores a closed form');
    await page.locator('[data-change-password]').click();
    await page.locator('#password-form').waitFor();

    await page.locator('#current-password').fill(oldPassword);
    await page.locator('#new-password').fill(newPassword);
    await page.locator('#confirm-password').fill('different confirmation password');
    await page.locator('#password-form button[type=submit]').click();
    await page.getByRole('alert').waitFor();
    check((await page.locator('#password-feedback').innerText()).includes('do not match'), 'Password confirmation mismatch was not explained');
    check(await page.locator('#current-password').inputValue() === '', 'Mismatch left secret inputs populated');

    await page.locator('#current-password').fill('incorrect current password');
    await page.locator('#new-password').fill(newPassword);
    await page.locator('#confirm-password').fill(newPassword);
    await page.locator('#password-form button[type=submit]').click();
    await page.getByRole('alert').waitFor();
    check((await page.locator('#password-feedback').innerText()).length > 0, 'Wrong password feedback was empty');
    check(await page.locator('#current-password').inputValue() === '', 'Secret remained after password submission');
    check(await page.locator('#password-form').count() === 1, 'Wrong current password unexpectedly closed the form');
    passed.push('wrong current password reports an error and clears secret inputs');

    let passwordRequests = 0;
    await page.route('**/api/account/password', async route => {
      passwordRequests++;
      const response = await route.fetch();
      check(response.ok(), 'Password change did not commit before simulated lost response');
      await route.abort();
    }, {times: 1});
    await page.locator('#current-password').fill(oldPassword);
    await page.locator('#new-password').fill(newPassword);
    await page.locator('#confirm-password').fill(newPassword);
    await page.locator('#password-form button[type=submit]').click();
    await page.locator('#password-feedback').waitFor();
    await page.waitForFunction(() => document.querySelector('#password-feedback')?.textContent.includes('could not be confirmed'));
    await page.waitForTimeout(250);
    check(passwordRequests === 1, 'Lost password response triggered an automatic retry');
    check(await page.locator('#new-password').inputValue() === '', 'New password remained after uncertain response');
    check(await page.evaluate(() => JSON.stringify(localStorage)).then(value => !value.includes(newPassword)), 'Password was saved in local storage');
    check(!page.url().includes(newPassword), 'Password appeared in the URL');
    check(await page.locator('#password-form').count() === 1, 'Unconfirmed response reported success');
    passed.push('lost response gives uncertain feedback without retry or persistent password draft');

    check(await page.evaluate(async () => (await fetch('/api/auth/me')).status) === 200, 'Password change discarded the current session cookie');
    await page.locator('#current-password').fill(newPassword);
    await page.locator('#new-password').fill(finalPassword);
    await page.locator('#confirm-password').fill(finalPassword);
    await page.locator('#password-form button[type=submit]').click();
    await page.locator('[data-change-password]').waitFor();
    check((await page.locator('#password-feedback').innerText()).includes('Password changed'), 'Confirmed change did not show success feedback');
    passed.push('confirmed password change retains the current session and shows success');

    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    try {
      await secondPage.route('**/api/auth/config', route => route.abort());
      await secondPage.goto(openUrl);
      await secondPage.locator('#account-form').waitFor();
      check(await secondPage.locator('[data-account-mode]').count() === 0, 'Config failure exposed account creation');
      await login(secondPage, email, oldPassword);
      await secondPage.getByRole('alert').waitFor();
      check(await secondPage.locator('#account-form').count() === 1, 'Old password remained valid after replacement');
      await login(secondPage, email, finalPassword);
      await secondPage.getByRole('button', {name: 'Settings', exact: true}).waitFor();
      passed.push('registration config failure hides account creation while existing login works');
    } finally { await secondContext.close(); }

    const navigationPassword = 'password after navigation';
    let releaseNavigationResponse;
    let resolveNavigationCommit;
    const navigationCommitted = new Promise(resolve => { resolveNavigationCommit = resolve; });
    const navigationResponseGate = new Promise(resolve => { releaseNavigationResponse = resolve; });
    let resolveNavigationDelivered;
    const navigationDelivered = new Promise(resolve => { resolveNavigationDelivered = resolve; });
    await page.route('**/api/account/password', async route => {
      const response = await route.fetch();
      check(response.ok(), 'Navigation password change did not commit');
      resolveNavigationCommit();
      await navigationResponseGate;
      await route.fulfill({response});
      resolveNavigationDelivered();
    }, {times: 1});
    await openPasswordForm();
    await page.locator('#current-password').fill(finalPassword);
    await page.locator('#new-password').fill(navigationPassword);
    await page.locator('#confirm-password').fill(navigationPassword);
    await page.locator('#password-form button[type=submit]').click();
    await navigationCommitted;
    await page.locator('[data-screen=study]').click();
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await page.locator('[data-change-password]').waitFor();
    releaseNavigationResponse();
    await navigationDelivered;
    await page.waitForTimeout(100);
    check(await page.locator('[data-change-password]').count() === 1, 'Stale success response reopened the password form after navigation');
    check(!(await page.locator('#password-feedback').innerText()).includes('Password changed'), 'Navigation left stale password success feedback');
    passed.push('navigating during a delayed password response discards its stale UI update');

    const alternateEmail = `alternate-${unique}@example.com`;
    const alternatePassword = 'alternate account browser password';
    let releaseLogoutResponse;
    let resolveLogoutCommit;
    const logoutCommit = new Promise(resolve => { resolveLogoutCommit = resolve; });
    const logoutResponseGate = new Promise(resolve => { releaseLogoutResponse = resolve; });
    let resolveLogoutDelivered;
    const logoutDelivered = new Promise(resolve => { resolveLogoutDelivered = resolve; });
    await page.route('**/api/account/password', async route => {
      const response = await route.fetch();
      check(response.ok(), 'Password response for logout race did not commit');
      resolveLogoutCommit();
      await logoutResponseGate;
      await route.fulfill({response});
      resolveLogoutDelivered();
    }, {times: 1});
    await openPasswordForm();
    await page.locator('#current-password').fill(navigationPassword);
    await page.locator('#new-password').fill('password completed before logout');
    await page.locator('#confirm-password').fill('password completed before logout');
    await page.locator('#password-form button[type=submit]').click();
    await logoutCommit;
    await page.locator('[data-logout]').click();
    await page.locator('#account-form').waitFor();
    await page.locator('[data-account-mode]').click();
    await login(page, alternateEmail, alternatePassword);
    await page.getByRole('button', {name: 'Settings', exact: true}).waitFor();
    releaseLogoutResponse();
    await logoutDelivered;
    await page.waitForTimeout(100);
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    check((await page.getByRole('region', {name: 'Account', exact: true}).innerText()).includes(alternateEmail), 'Stale response displaced the newly signed-in account');
    check(!(await page.locator('#password-feedback').innerText()).includes('Password changed'), 'Stale response showed success for the new account');
    passed.push('logout and account switch during a delayed password response preserve the new account UI');
  } finally {
    await context.close();
  }
  return passed;
};
