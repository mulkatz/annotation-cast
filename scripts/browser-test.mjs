import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

await mkdir('.local/browser', { recursive: true });
const profile = await mkdtemp(resolve('.local/browser/profile-'));
const fixture =
  '<!doctype html><html><head><title>Synthetic capture fixture</title><style>body{font:20px sans-serif;padding:30px}button{padding:20px;color:blue}button:hover{background:yellow}#tip{display:none}button:hover+#tip{display:inline}</style></head><body><h1>Synthetic capture fixture</h1><button id="issue">Clipped button</button><span id="tip">Synthetic hover state</span><p id="quote">Selected source statement</p><script>setInterval(()=>document.body.style.background=Date.now()%2000<1000?"#eee":"#fff",500)</script></body></html>';
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(fixture);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const fixtureUrl = `http://127.0.0.1:${address.port}/`;
const extension = resolve('dist');
let context;
const problems = [];
const recordSeconds = Number(process.env.BROWSER_RECORD_SECONDS ?? '8');
assert.ok(
  Number.isFinite(recordSeconds) && recordSeconds >= 6 && recordSeconds <= 1800,
  'BROWSER_RECORD_SECONDS must be between 6 and 1800.',
);
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--enable-unsafe-extension-debugging',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  await context.route('https://openrouter.ai/**', async (route) => {
    problems.push('Unexpected provider request blocked by browser test.');
    await route.abort();
  });
  context.on('weberror', (error) => problems.push(error.error().message));
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  let app = await context.newPage();
  await app.goto(`chrome-extension://${id}/app.html`);
  await app.getByRole('heading', { name: 'Prepare your session' }).waitFor();
  assert.equal(await app.locator('#start').isDisabled(), true);
  const send = (message) =>
    app.evaluate(
      (value) =>
        Promise.race([
          chrome.runtime.sendMessage(value),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(new Error('Extension operation exceeded 15 seconds.')),
              15_000,
            ),
          ),
        ]),
      message,
    );
  const start = {
    target: 'background',
    type: 'start',
    notes: {
      project: 'Synthetic project',
      objective: 'Synthetic capture acceptance',
      environment: 'Automated Chromium',
      reference: '',
    },
    diagnostics: false,
  };
  assert.equal((await send(start)).ok, false);
  console.log(
    'Real Chromium: setup renders and recording is blocked before readiness.',
  );
  await context.grantPermissions(['microphone']);
  assert.equal(
    await app.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const state = stream.getAudioTracks()[0]?.readyState;
      stream.getTracks().forEach((track) => track.stop());
      return state;
    }),
    'live',
  );
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  const browserCdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserCdp.send('Target.getTargets', {
    filter: [{}],
  });
  const tab = targetInfos.find(
    (target) => target.type === 'tab' && target.url === fixtureUrl,
  );
  assert.ok(tab, 'The synthetic fixture must have a browser tab target.');
  const opened = context.waitForEvent('page');
  await browserCdp.send('Extensions.triggerAction', {
    id,
    targetId: tab.targetId,
  });
  const previous = app;
  app = await opened;
  await app.getByRole('heading', { name: 'Prepare your session' }).waitFor();
  await previous.close();
  const contextCheck = await send({ target: 'background', type: 'check-tab' });
  assert.equal(contextCheck.ok, true, contextCheck.error);
  if (process.env.BROWSER_CAPTURE !== '1') {
    await app.screenshot({ path: '.local/browser/app.png', fullPage: true });
    assert.deepEqual(problems, []);
    console.log(
      'Real Chromium: microphone access, toolbar action, and selected-tab context permission verified.',
    );
    console.log(
      'Capture is a separate explicit check: BROWSER_CAPTURE=1 BROWSER_RECORD_SECONDS=65 npm run test:browser. Provider calls remain blocked.',
    );
  } else {
    // Only this isolated test profile receives synthetic readiness. No production bypass exists.
    // This validates capture independently of paid provider compatibility and is not a live readiness check.
    await app.evaluate(async () => {
      const key = 'synthetic-browser-test-key';
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(key),
      );
      const keyFingerprint = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join('');
      const { selectedTabId } =
        await chrome.storage.session.get('selectedTabId');
      if (typeof selectedTabId !== 'number')
        throw new Error('Toolbar action did not select a tab.');
      await chrome.storage.local.set({ settings: { key, diagnostics: false } });
      await chrome.storage.session.set({
        readiness: {
          checkedAt: Date.now(),
          tabId: selectedTabId,
          keyFingerprint,
        },
      });
    });
    const reply = await send(start);
    assert.equal(reply.ok, true, reply.error);
    const captureStartedAt = Date.now();
    console.log(
      'Real tab capture and synthetic microphone recording started through the toolbar action.',
    );
    await page.locator('#issue').hover();
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#quote'));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await app.evaluate(async () => {
      const { selectedTabId } =
        await chrome.storage.session.get('selectedTabId');
      await chrome.tabs.sendMessage(selectedTabId, {
        target: 'content',
        type: 'marker',
        mode: 'point',
      });
    });
    await page.evaluate(() => {
      document.querySelector('#issue').textContent = 'Changed after marker';
      document.querySelector('#issue').style.color = 'red';
    });
    await page.waitForTimeout(2500);
    await page.goto(`${fixtureUrl}next`);
    await page.waitForTimeout(2500);
    const remaining = recordSeconds * 1000 - (Date.now() - captureStartedAt);
    if (remaining > 0) await page.waitForTimeout(remaining);
    const stop = await send({ target: 'background', type: 'stop' });
    assert.equal(stop.ok, true, stop.error);
    const result = await app.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('annotation-cast', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const all = (store) =>
        new Promise((resolve, reject) => {
          const request = database
            .transaction(store)
            .objectStore(store)
            .getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const sessions = await all('sessions');
      const events = await all('events');
      const session = sessions[0];
      let directory = await navigator.storage.getDirectory();
      const parts = session.recordingPath.split('/');
      const name = parts.pop();
      for (const part of parts)
        directory = await directory.getDirectoryHandle(part);
      const recording = await (await directory.getFileHandle(name)).getFile();
      const audioChecks = [];
      for (const segment of session.audio) {
        let audioDirectory = await navigator.storage.getDirectory();
        const components = segment.path.split('/');
        const audioName = components.pop();
        for (const component of components)
          audioDirectory = await audioDirectory.getDirectoryHandle(component);
        const file = await (
          await audioDirectory.getFileHandle(audioName)
        ).getFile();
        const element = document.createElement('audio');
        const objectUrl = URL.createObjectURL(
          new Blob([file], { type: 'audio/webm' }),
        );
        element.src = objectUrl;
        await new Promise((resolve, reject) => {
          element.onloadeddata = resolve;
          element.onerror = () =>
            reject(
              new Error('Audio segment could not be independently decoded.'),
            );
          setTimeout(
            () => reject(new Error('Audio segment decode timed out.')),
            10_000,
          );
        });
        audioChecks.push({ size: file.size, readyState: element.readyState });
        URL.revokeObjectURL(objectUrl);
      }
      const url = URL.createObjectURL(recording);
      const video = document.createElement('video');
      video.muted = true;
      video.src = url;
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () =>
          reject(new Error('Recorded video could not be decoded.'));
        setTimeout(
          () => reject(new Error('Recorded video decode timed out.')),
          10_000,
        );
      });
      const playback = {
        width: video.videoWidth,
        height: video.videoHeight,
        size: recording.size,
      };
      URL.revokeObjectURL(url);
      database.close();
      return { session, events, playback, audioChecks };
    });
    assert.equal(result.session.status, 'stopped');
    assert.ok(result.session.duration >= 4000);
    assert.ok(result.session.audio.length > 0);
    assert.ok(
      result.session.audio.every((segment) => segment.end > segment.start),
    );
    assert.ok(result.session.frames.length >= 2);
    assert.ok(
      result.audioChecks.every(
        (check) => check.size > 0 && check.readyState >= 2,
      ),
    );
    if (recordSeconds >= 65) {
      assert.ok(result.session.audio.length >= 2);
      const ordered = [...result.session.audio].sort(
        (a, b) => a.start - b.start,
      );
      assert.ok(
        ordered[1].start < ordered[0].end,
        'Audio segments must overlap at the boundary.',
      );
    }
    assert.ok(
      result.playback.width > 0 &&
        result.playback.height > 0 &&
        result.playback.size > 0,
    );
    const marker = result.events.find((event) => event.type === 'point');
    assert.ok(marker);
    assert.equal(marker.data.selection, 'Selected source statement');
    assert.ok(
      marker.data.candidates.some(
        (candidate) =>
          candidate.label === 'Clipped button' &&
          candidate.styles.color === 'rgb(0, 0, 255)',
      ),
    );
    assert.ok(
      result.events.some(
        (event) => event.type === 'navigation' && event.url.endsWith('/next'),
      ),
    );
    await app.screenshot({ path: '.local/browser/app.png', fullPage: true });
    assert.deepEqual(problems, []);
    console.log(
      `Real Chromium ${context.browser().version()} (${recordSeconds} second recording): playable tab/microphone WebM, independently finalized audio segment, timestamped frames, frozen point context, explicit selection, same-origin navigation, stop, and local persistence verified.`,
    );
    console.log(
      'Provider readiness was synthetic in this browser harness; paid provider compatibility and a full 30-minute session remain separate acceptance checks.',
    );
  }
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
