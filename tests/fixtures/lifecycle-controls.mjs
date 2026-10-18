import assert from 'node:assert/strict';

export async function stored(surface, id) {
  return surface.evaluate(async (sessionId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('annotation-cast', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error('Cannot inspect local session storage.'));
    });
    try {
      const read = (store, make) =>
        new Promise((resolve, reject) => {
          const request = make(db.transaction(store).objectStore(store));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () =>
            reject(new Error('Cannot inspect stored evidence.'));
        });
      const session = await read('sessions', (store) => store.get(sessionId));
      const events = await read('events', (store) =>
        store.index('sessionId').getAll(sessionId),
      );
      return { session, events };
    } finally {
      db.close();
    }
  }, id);
}
export async function until(check, description, milliseconds = 15_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    let timer;
    const value = await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${description}`)),
          Math.max(1, end - Date.now()),
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}
export async function startSynthetic(app) {
  await app.evaluate(async () => {
    const key = 'synthetic-lifecycle-key';
    const { selectedTabId } = await chrome.storage.session.get('selectedTabId');
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(key),
    );
    const keyFingerprint = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    await chrome.storage.local.set({
      settings: { key, diagnostics: false, shiftTapIntervalMs: 180 },
    });
    await chrome.storage.session.set({
      readiness: {
        checkedAt: Date.now(),
        tabId: selectedTabId,
        keyFingerprint,
      },
    });
  });
  const reply = await app.evaluate(() =>
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'start',
      notes: {
        project: 'Synthetic lifecycle acceptance',
        objective: 'Verify lifecycle without provider calls.',
        environment: 'Fake microphone and actual fixture tab.',
        reference: 'synthetic-lifecycle',
      },
      diagnostics: false,
    }),
  );
  assert.equal(reply.ok, true, reply.error);
  return app.evaluate(
    async () =>
      (await chrome.storage.session.get('activeSession')).activeSession.id,
  );
}
export async function point(page) {
  await page.locator('#cancel').hover();
  for (let index = 0; index < 2; index++) {
    await page.keyboard.down('Control');
    await page.waitForTimeout(20);
    await page.keyboard.up('Control');
    if (!index) await page.waitForTimeout(40);
  }
  await page.waitForTimeout(250);
}
