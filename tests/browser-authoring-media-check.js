/* global user, deckLoaded, busy, failedOperation, deck, document, window */
async (page, options = {}) => {
  const context = await page.context().browser().newContext({viewport: {width: 390, height: 844}});
  page = await context.newPage();
  const url = options.url || 'http://127.0.0.1:4194/';
  const origin = new URL(url).origin;
  const passed = [];
  const errors = [];
  const releases = [];
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const password = 'synthetic browser media password';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPa8AAAAASUVORK5CYII=', 'base64');
  const wav = Buffer.alloc(44 + 160);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const ready = deckId => page.waitForFunction(id => user && deckLoaded && !busy && !failedOperation && (!id || deck.id === id), deckId);
  const api = async (path, data) => {
    const response = await context.request.post(new URL(path, url).href, {headers: {Origin: origin}, data});
    const body = await response.json().catch(() => ({}));
    check(response.ok(), `${path} failed: ${JSON.stringify(body)}`);
    return body;
  };
  const createSet = async title => (await api('/api/authoring/decks', {requestId: `media-fixture-${unique}-${title}`,
    title, termLang: 'ar', meaningLang: 'el', termDir: 'rtl', meaningDir: 'ltr'})).deck;
  const readDeck = async id => {
    const response = await context.request.get(new URL(`/api/authoring/decks/${id}`, url).href);
    check(response.ok(), `Could not read synthetic set ${id}`);
    return (await response.json()).deck;
  };
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
  const cancelForm = async () => {
    await page.locator('[data-authoring-cancel]').click();
    if (await page.locator('[data-authoring-discard]').count()) await page.locator('[data-authoring-discard]').click();
    else await page.locator('#add-word-form').waitFor({state: 'detached'});
  };
  const fillWord = async (term, meaning) => {
    await page.locator('#add-word-form [name=term]').fill(term);
    await page.locator('#add-word-form [name=meaning]').fill(meaning);
  };
  const selectFiles = async ({image, audio}) => {
    if (image) await page.locator('#word-image-file').setInputFiles(image);
    if (audio) await page.locator('#word-audio-file').setInputFiles(audio);
  };
  const mediaId = path => path && /\/api\/media\/([^/?]+)/.exec(path)?.[1];
  const mediaBytes = async id => {
    const response = await context.request.get(new URL(`/api/authoring/media/${id}`, url).href);
    check(response.ok(), `Could not read uploaded media ${id}`);
    return response.body();
  };
  const file = (name, mimeType, bytes) => ({name, mimeType, buffer: bytes});
  const expectNoWord = async (deckId, term) => check(!(await readDeck(deckId)).words.some(word => word.term === term), `${term} was saved despite a media failure`);
  const waitAlert = async () => page.locator('#add-word-form [role=alert]').waitFor();
  const afterHeldRequest = () => new Promise(resolve => releases.push(resolve));
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    await register(`browser-media-${unique}@example.test`);
    const native = await createSet(`RTL media ${unique}`);
    const target = await createSet(`Other media ${unique}`);
    await page.reload();
    await selectSet(native.id);
    await openForm();
    check(await page.locator('#add-word-form [name=term]').getAttribute('lang') === 'ar'
      && await page.locator('#add-word-form [name=term]').getAttribute('dir') === 'rtl', 'Word input lost the set language or RTL direction');
    check(await page.locator('#add-word-form [name=meaning]').getAttribute('lang') === 'el'
      && await page.locator('#add-word-form [name=meaning]').getAttribute('dir') === 'ltr', 'Translation input lost its language or direction');
    const bounds = await page.locator('#add-word-form').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return {left: rect.left, right: rect.right, width: rect.width};
    });
    check(bounds.left >= 0 && bounds.right <= 390 && bounds.width <= 390, 'Word editor overflows the 390px viewport');
    check(await page.evaluate(() => document.activeElement.matches('#add-word-form [name=term]')), 'Opening the media editor did not focus the word field');

    const removedTerm = `removed-media-${unique}`;
    let removedUploads = 0;
    let removedBatch;
    await page.route('**/api/authoring/**', async route => {
      if (route.request().method() === 'POST') {
        if (new URL(route.request().url()).pathname === '/api/authoring/media') removedUploads += 1;
        if (new URL(route.request().url()).pathname.endsWith('/words')) removedBatch = route.request().postDataJSON();
      }
      await route.continue();
    });
    await fillWord(removedTerm, 'removed attachment');
    await selectFiles({image: file('remove.png', 'image/png', png), audio: file('keep.wav', 'audio/wav', wav)});
    await page.getByText('remove.png', {exact: true}).waitFor();
    await page.getByText('keep.wav', {exact: true}).waitFor();
    await page.locator('[data-authoring-remove="image"]').click();
    check(await page.getByText('remove.png', {exact: true}).count() === 0, 'Removed image filename remained selected');
    check(await page.getByText('keep.wav', {exact: true}).count() === 1, 'Removing the image also removed the recording');
    await page.locator('#add-word-form button[type=submit]').click();
    await page.getByText(removedTerm, {exact: true}).waitFor();
    const removedWord = (await readDeck(native.id)).words.find(word => word.term === removedTerm);
    check(removedUploads === 1 && removedBatch?.words?.[0]?.audioMediaId, 'Removed image was uploaded or retained in the word batch');
    check(!removedBatch.words[0].imageMediaId, 'Removed image was attached to the word');
    check(removedWord?.image === null && mediaId(removedWord?.audio), 'Saved word did not contain only the retained audio');
    check(JSON.stringify(Array.from(await mediaBytes(mediaId(removedWord.audio)))) === JSON.stringify(Array.from(wav)), 'Saved recording bytes changed');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('Removing a selected picture prevents its upload while the recording is saved byte-for-byte');

    const oversizedTerm = `oversized-${unique}`;
    await openForm();
    await fillWord(oversizedTerm, 'too large');
    let oversizedUploads = 0;
    await page.route('**/api/authoring/media', async route => {
      if (route.request().method() === 'POST') oversizedUploads += 1;
      await route.continue();
    });
    const oversized = Buffer.concat([png, Buffer.alloc(512 * 1024 + 1 - png.length)]);
    await selectFiles({image: file('large.png', 'image/png', oversized)});
    await waitAlert();
    await page.locator('#add-word-form').evaluate(form => form.requestSubmit());
    await page.waitForTimeout(100);
    check(oversizedUploads === 0, 'Oversized picture was sent to the server');
    await expectNoWord(native.id, oversizedTerm);
    await page.unrouteAll({behavior: 'wait'});
    await cancelForm();

    const invalidTerm = `invalid-signature-${unique}`;
    await openForm();
    await fillWord(invalidTerm, 'bad file');
    let invalidUploads = 0;
    await page.route('**/api/authoring/media', async route => {
      if (route.request().method() === 'POST') invalidUploads += 1;
      await route.continue();
    });
    await selectFiles({image: file('broken.png', 'image/png', Buffer.from('not a png'))});
    await page.locator('#add-word-form button[type=submit]').click();
    await waitAlert();
    check(invalidUploads === 1, 'Invalid signature did not reach the existing server validator');
    await expectNoWord(native.id, invalidTerm);
    await page.unrouteAll({behavior: 'wait'});
    await cancelForm();
    passed.push('Oversized files are rejected before upload and invalid signatures never save an incomplete word');

    const quotaTerm = `quota-${unique}`;
    await openForm();
    await fillWord(quotaTerm, 'quota denied');
    let quotaWordPosts = 0;
    await page.route('**/api/authoring/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'POST' && path === '/api/authoring/media') {
        return route.fulfill({status: 422, contentType: 'application/json', body: JSON.stringify({error: {code: 'storage_limit', message: 'Account media quota reached.'}})});
      }
      if (route.request().method() === 'POST' && path.endsWith('/words')) quotaWordPosts += 1;
      await route.continue();
    });
    await selectFiles({image: file('quota.png', 'image/png', png)});
    await page.locator('#add-word-form button[type=submit]').click();
    await waitAlert();
    check(await page.locator('#add-word-form [role=alert]').innerText().then(text => /quota/i.test(text)), 'Storage quota response was hidden');
    check(quotaWordPosts === 0, 'Word was posted after media quota rejection');
    await expectNoWord(native.id, quotaTerm);
    await page.unrouteAll({behavior: 'wait'});
    await cancelForm();
    passed.push('A storage quota rejection is shown and prevents a text-only partial word');

    const partialTerm = `partial-${unique}`;
    await openForm();
    await fillWord(partialTerm, 'retry media');
    await selectFiles({image: file('partial.png', 'image/png', png), audio: file('partial.wav', 'audio/wav', wav)});
    let imageAttempts = 0;
    let audioAttempts = 0;
    let imageId;
    await page.route('**/api/authoring/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'POST' && path === '/api/authoring/media') {
        const filename = route.request().headers()['x-media-filename'];
        if (filename === 'partial.png') {
          imageAttempts += 1;
          const response = await route.fetch();
          imageId = (await response.json()).id;
          return route.fulfill({response});
        }
        if (filename === 'partial.wav') {
          audioAttempts += 1;
          if (audioAttempts === 1) return route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: {message: 'Synthetic recording upload failure.'}})});
        }
      }
      await route.continue();
    });
    await page.locator('#add-word-form button[type=submit]').click();
    await page.locator('[data-authoring-retry]').waitFor();
    await page.getByText('partial.png', {exact: true}).waitFor();
    await page.getByText('partial.wav', {exact: true}).waitFor();
    check(imageAttempts === 1 && audioAttempts === 1, 'Partial upload did not stop after the recording failed');
    await page.locator('[data-authoring-retry]').click();
    await page.getByText(partialTerm, {exact: true}).waitFor();
    check(imageAttempts === 1 && audioAttempts === 2, 'Retry re-uploaded the successful image or skipped the failed audio');
    const partialWord = (await readDeck(native.id)).words.find(word => word.term === partialTerm);
    check(partialWord && mediaId(partialWord.image) === imageId && mediaId(partialWord.audio), 'Retried word did not attach both uploaded files');
    check(JSON.stringify(Array.from(await mediaBytes(mediaId(partialWord.image)))) === JSON.stringify(Array.from(png)), 'Saved picture bytes changed');
    check(JSON.stringify(Array.from(await mediaBytes(mediaId(partialWord.audio)))) === JSON.stringify(Array.from(wav)), 'Saved recording bytes changed');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('A failed recording upload retains filenames and retry reuses the successful picture upload');

    const lostUploadTerm = `lost-upload-${unique}`;
    await openForm();
    await fillWord(lostUploadTerm, 'upload replay');
    await selectFiles({image: file('replay.png', 'image/png', png)});
    const uploadRequests = [];
    const uploadIds = [];
    await page.route('**/api/authoring/media', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      uploadRequests.push({id: route.request().headers()['x-request-id'], filename: route.request().headers()['x-media-filename'], bytes: route.request().postDataBuffer().toString('base64')});
      const response = await route.fetch();
      uploadIds.push((await response.json()).id);
      if (uploadRequests.length === 1) return route.abort();
      await route.fulfill({response});
    }, {times: 2});
    await page.locator('#add-word-form button[type=submit]').click();
    await page.locator('[data-authoring-retry]').waitFor();
    check(uploadRequests.length === 1, 'Uncertain upload automatically retried');
    await page.locator('[data-authoring-retry]').click();
    await page.getByText(lostUploadTerm, {exact: true}).waitFor();
    check(uploadRequests.length === 2 && uploadRequests[0].id === uploadRequests[1].id
      && uploadRequests[0].filename === uploadRequests[1].filename && uploadRequests[0].bytes === uploadRequests[1].bytes,
    'Lost upload response did not replay the exact request ID, filename and bytes');
    check(uploadIds[0] === uploadIds[1], 'Upload replay created a different media ID');
    const lostUploadWord = (await readDeck(native.id)).words.find(word => word.term === lostUploadTerm);
    check(lostUploadWord && mediaId(lostUploadWord.image) === uploadIds[1], 'Replayed upload was not attached to the word');
    check(JSON.stringify(Array.from(await mediaBytes(uploadIds[1]))) === JSON.stringify(Array.from(png)), 'Replayed upload bytes changed');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('A committed upload with a lost response replays the same request ID and exact bytes');

    const lostBatchTerm = `lost-batch-${unique}`;
    await openForm();
    await fillWord(lostBatchTerm, 'batch replay');
    const batchBodies = [];
    await page.route(`**/api/authoring/decks/${native.id}/words`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      batchBodies.push(route.request().postDataJSON());
      const response = await route.fetch();
      check(response.status() === 200, 'Lost-response batch did not commit');
      if (batchBodies.length === 1) return route.abort();
      await route.fulfill({response});
    }, {times: 2});
    await page.locator('#add-word-form button[type=submit]').click();
    await page.locator('[data-authoring-retry]').waitFor();
    check((await readDeck(native.id)).words.filter(word => word.term === lostBatchTerm).length === 1,
      'Committed batch was missing after its response was lost');
    await page.locator('[data-authoring-retry]').click();
    await page.getByText(lostBatchTerm, {exact: true}).waitFor();
    check(batchBodies.length === 2 && JSON.stringify(batchBodies[0]) === JSON.stringify(batchBodies[1]),
      'Lost batch response did not replay the exact word payload and request ID');
    check((await readDeck(native.id)).words.filter(word => word.term === lostBatchTerm).length === 1,
      'Batch retry duplicated the committed word');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('A committed word batch with a lost response is replayed exactly once');

    const cancelTerm = `cancel-upload-${unique}`;
    await openForm();
    await fillWord(cancelTerm, 'canceled upload');
    await selectFiles({image: file('held.png', 'image/png', png), audio: file('never.wav', 'audio/wav', wav)});
    let releaseUpload;
    let signalUploadCommitted;
    const uploadHeld = afterHeldRequest();
    const uploadCommitted = new Promise(resolve => { signalUploadCommitted = resolve; });
    let heldImageRequests = 0;
    let skippedAudioRequests = 0;
    let canceledBatchRequests = 0;
    await page.route('**/api/authoring/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'POST' && path === '/api/authoring/media') {
        if (route.request().headers()['x-media-filename'] === 'held.png') {
          heldImageRequests += 1;
          const response = await route.fetch();
          signalUploadCommitted();
          await uploadHeld;
          await route.fulfill({response});
          return;
        }
        if (route.request().headers()['x-media-filename'] === 'never.wav') skippedAudioRequests += 1;
      }
      if (route.request().method() === 'POST' && path.endsWith('/words')) canceledBatchRequests += 1;
      await route.continue();
    });
    releaseUpload = releases.at(-1);
    await page.locator('#add-word-form button[type=submit]').click();
    await uploadCommitted;
    await page.locator('[data-authoring-cancel]').click();
    await page.locator('[data-authoring-discard]').click();
    await selectSet(target.id);
    releaseUpload();
    await page.waitForTimeout(100);
    check(await page.evaluate(id => deck.id === id, target.id), 'Delayed upload response changed the selected set');
    check(heldImageRequests === 1 && skippedAudioRequests === 0 && canceledBatchRequests === 0,
      'Canceled upload chain continued with the recording or word batch');
    check((await readDeck(target.id)).words.every(word => word.term !== cancelTerm), 'Canceled upload changed the other set');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('Canceling during a held upload prevents later uploads and the word batch after switching sets');

    const accountTerm = `cancel-account-${unique}`;
    await openForm();
    await fillWord(accountTerm, 'account isolation');
    await selectFiles({image: file('account.png', 'image/png', png), audio: file('account.wav', 'audio/wav', wav)});
    const accountHeld = afterHeldRequest();
    let releaseAccount;
    let signalAccountCommitted;
    const accountCommitted = new Promise(resolve => { signalAccountCommitted = resolve; });
    let accountImagePosts = 0;
    let accountAudioPosts = 0;
    let accountBatchPosts = 0;
    await page.route('**/api/authoring/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'POST' && path === '/api/authoring/media') {
        if (route.request().headers()['x-media-filename'] === 'account.png') {
          accountImagePosts += 1;
          const response = await route.fetch();
          signalAccountCommitted();
          await accountHeld;
          await route.fulfill({response});
          return;
        }
        if (route.request().headers()['x-media-filename'] === 'account.wav') accountAudioPosts += 1;
      }
      if (route.request().method() === 'POST' && path.endsWith('/words')) accountBatchPosts += 1;
      await route.continue();
    });
    releaseAccount = releases.at(-1);
    await page.locator('#add-word-form button[type=submit]').click();
    await accountCommitted;
    await cancelForm();
    await page.locator('[data-logout]').click();
    await register(`browser-media-new-${unique}@example.test`);
    releaseAccount();
    await page.waitForTimeout(100);
    check(await page.evaluate(() => user.email) === `browser-media-new-${unique}@example.test`, 'Delayed media response changed the signed-in account');
    check(accountImagePosts === 1 && accountAudioPosts === 0 && accountBatchPosts === 0,
      'Canceled media chain continued after the account changed');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('Canceling during a held upload prevents later requests after logout and account switch');

    const pagehideTerm = `pagehide-${unique}`;
    const pagehideSet = await createSet(`Pagehide ${unique}`);
    await page.reload();
    await selectSet(pagehideSet.id);
    await openForm();
    await fillWord(pagehideTerm, 'page lifecycle');
    await selectFiles({image: file('pagehide.png', 'image/png', png), audio: file('pagehide.wav', 'audio/wav', wav)});
    let releasePagehide;
    let pagehideCommitted;
    const pagehideHeld = afterHeldRequest();
    const pagehideSaved = new Promise(resolve => { pagehideCommitted = resolve; });
    let pagehideImagePosts = 0;
    let pagehideAudioPosts = 0;
    let pagehideBatchPosts = 0;
    await page.route('**/api/authoring/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'POST' && path === '/api/authoring/media') {
        if (route.request().headers()['x-media-filename'] === 'pagehide.png') {
          pagehideImagePosts += 1;
          const response = await route.fetch();
          pagehideCommitted();
          await pagehideHeld;
          await route.fulfill({response});
          return;
        }
        if (route.request().headers()['x-media-filename'] === 'pagehide.wav') pagehideAudioPosts += 1;
      }
      if (route.request().method() === 'POST' && path.endsWith('/words')) pagehideBatchPosts += 1;
      await route.continue();
    });
    releasePagehide = releases.at(-1);
    await page.locator('#add-word-form button[type=submit]').click();
    await pagehideSaved;
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      const event = new Event('pageshow');
      Object.defineProperty(event, 'persisted', {value: true});
      window.dispatchEvent(event);
    });
    check(await page.locator('#add-word-form').count() === 0, 'BFCache restore kept the pending word editor');
    await openForm();
    check(await page.locator('#add-word-form [name=term]').inputValue() === ''
      && await page.locator('#add-word-form [name=meaning]').inputValue() === '', 'BFCache restore retained the text draft');
    check(await page.locator('#word-image-file').evaluate(input => input.files.length) === 0
      && await page.locator('#word-audio-file').evaluate(input => input.files.length) === 0, 'BFCache restore retained selected files');
    releasePagehide();
    await page.waitForTimeout(100);
    check(pagehideImagePosts === 1 && pagehideAudioPosts === 0 && pagehideBatchPosts === 0,
      'Page lifecycle allowed the canceled upload chain to continue');
    await page.unrouteAll({behavior: 'wait'});
    passed.push('BFCache restore clears text and file drafts and stops a pending upload chain');

    check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
    return {passed, pageErrors: errors};
  } finally {
    releases.forEach(release => release());
    await context.close();
  }
};
