import { chromium } from 'playwright';
import { relative, resolve } from 'node:path';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

await mkdir('.local/browser', { recursive: true });
const runDirectory = await mkdtemp(resolve('.local/browser/run-'));
const profile = resolve(runDirectory, 'profile');
const extension = resolve(runDirectory, 'extension');
await cp(resolve('dist'), extension, { recursive: true });
const fixture =
  '<!doctype html><html><head><title>Synthetic capture fixture</title><style>body{font:20px sans-serif;padding:30px}button{padding:20px;color:blue}button:hover{background:yellow}#tip{display:none}button:hover+#tip{display:inline}</style></head><body><h1>Synthetic capture fixture</h1><button id="issue">Clipped button</button><span id="tip">Synthetic hover state</span><p id="quote">Selected source statement</p><div id="capture-evidence" style="position:fixed;left:30px;top:300px;width:80px;height:80px;background:rgb(19,183,211)"></div><script>setInterval(()=>document.body.style.background=Date.now()%2000<1000?"#eee":"#fff",500)</script></body></html>';
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(fixture);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const fixtureUrl = `http://127.0.0.1:${address.port}/`;
let context;
const problems = [];
const recordSeconds = Number(process.env.BROWSER_RECORD_SECONDS ?? '8');
const keepArtifacts = process.env.BROWSER_KEEP_ARTIFACTS === '1';
const exportRequested = process.env.BROWSER_EXPORT === '1';
let recordingPassed = false;
assert.ok(
  !exportRequested || process.env.BROWSER_CAPTURE === '1',
  'BROWSER_EXPORT=1 requires BROWSER_CAPTURE=1.',
);
assert.ok(
  Number.isFinite(recordSeconds) && recordSeconds >= 6 && recordSeconds <= 1800,
  'BROWSER_RECORD_SECONDS must be between 6 and 1800.',
);
// DevTools reports the offscreen JavaScript heap only; this is not total process/media memory.
async function offscreenHeap(cdp, extensionId) {
  let sessionId;
  try {
    const { targetInfos } = await cdp.send('Target.getTargets', {
      filter: [{}],
    });
    const target = targetInfos.find(
      (target) =>
        target.url === `chrome-extension://${extensionId}/offscreen.html`,
    );
    if (!target) return undefined;
    ({ sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: false,
    }));
    return await new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        cdp.off('Target.receivedMessageFromTarget', receive);
        resolve(value);
      };
      const receive = (event) => {
        if (event.sessionId !== sessionId) return;
        const reply = JSON.parse(event.message);
        if (reply.id === 1)
          finish(
            typeof reply.result?.usedSize === 'number'
              ? reply.result.usedSize
              : undefined,
          );
      };
      const timer = setTimeout(() => finish(undefined), 3000);
      cdp.on('Target.receivedMessageFromTarget', receive);
      void cdp
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id: 1, method: 'Runtime.getHeapUsage' }),
        })
        .catch(() => finish(undefined));
    });
  } catch {
    return undefined;
  } finally {
    if (sessionId)
      await cdp
        .send('Target.detachFromTarget', { sessionId })
        .catch(() => undefined);
  }
}
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--enable-unsafe-extension-debugging',
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
  // Existing installs gain timing defaults. Saving timing must preserve the
  // stored key and must not save an unrelated draft from the password field.
  await app.evaluate(() =>
    chrome.storage.local.set({
      settings: { key: 'synthetic-stored-key', diagnostics: false },
    }),
  );
  await app.reload();
  await app.waitForFunction(
    () => document.querySelector('#key').value === 'synthetic-stored-key',
  );
  assert.equal(await app.locator('#shift-tap-interval').inputValue(), '180');
  await app.locator('.marker-settings summary').click();
  await app.locator('#key').fill('synthetic-unsaved-draft');
  await app.locator('#shift-tap-interval').fill('99');
  await app.locator('#save-markers').click();
  await app
    .getByRole('status')
    .filter({ hasText: 'whole number from 100 to 350 ms' })
    .waitFor();
  await app.locator('#shift-tap-interval').fill('260');
  await app.locator('#save-markers').click();
  await app
    .getByRole('status')
    .filter({ hasText: 'Marker timing saved' })
    .waitFor();
  assert.deepEqual(
    await app.evaluate(
      async () => (await chrome.storage.local.get('settings')).settings,
    ),
    {
      key: 'synthetic-stored-key',
      diagnostics: false,
      shiftTapIntervalMs: 260,
    },
  );
  await app.reload();
  await app.waitForFunction(
    () => document.querySelector('#shift-tap-interval').value === '260',
  );
  assert.equal(await app.locator('#key').inputValue(), 'synthetic-stored-key');
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
  // Permission prompts can stay unanswered. Cancellation must release the setup
  // controls immediately and must not advance to a paid provider readiness call.
  await app.locator('#key').fill('synthetic-readiness-key');
  await app.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia;
    Object.assign(globalThis, { readinessMediaRequested: false });
    navigator.mediaDevices.getUserMedia = () => {
      globalThis.readinessMediaRequested = true;
      return new Promise(() => {});
    };
    Object.assign(globalThis, {
      restoreReadinessMedia: () => {
        navigator.mediaDevices.getUserMedia = original;
      },
    });
  });
  await app.locator('#readiness').click();
  await app.waitForFunction(() => globalThis.readinessMediaRequested === true);
  assert.equal(await app.locator('#cancel').isEnabled(), true);
  await app.locator('#cancel').click();
  await app.waitForFunction(
    () => !document.querySelector('#readiness').disabled,
  );
  assert.equal(await app.locator('#start').isDisabled(), true);
  assert.equal(
    await app.evaluate(
      async () => (await chrome.storage.session.get('readiness')).readiness,
    ),
    undefined,
  );
  await app.evaluate(() => globalThis.restoreReadinessMedia());
  if (process.env.BROWSER_CAPTURE !== '1') {
    await app.screenshot({ path: '.local/browser/app.png', fullPage: true });
    assert.deepEqual(problems, []);
    console.log(
      'Real Chromium: microphone access, toolbar action, selected-tab context, and cancellation of pending readiness verified.',
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
    const heapSamples = [];
    const initialHeap = await offscreenHeap(browserCdp, id);
    if (initialHeap !== undefined) heapSamples.push(initialHeap);
    console.log(
      'Real tab capture and synthetic microphone recording started through the toolbar action.',
    );
    await page.waitForTimeout(2500);
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
      document.querySelector('#capture-evidence').style.background =
        'rgb(207,58,113)';
    });
    await page.waitForTimeout(2500);
    await page.goto(`${fixtureUrl}next`);
    await page.waitForTimeout(2500);
    while (Date.now() - captureStartedAt < recordSeconds * 1000) {
      const remaining = recordSeconds * 1000 - (Date.now() - captureStartedAt);
      await page.waitForTimeout(Math.min(60_000, remaining));
      if (recordSeconds >= 60) {
        const elapsed = Math.round((Date.now() - captureStartedAt) / 1000);
        const state = await app.evaluate(async () => {
          const { activeSession, captureStatus } =
            await chrome.storage.session.get([
              'activeSession',
              'captureStatus',
            ]);
          return {
            active: !!activeSession,
            recording: captureStatus?.recording ?? 'unknown',
          };
        });
        if (elapsed < recordSeconds - 5)
          assert.ok(
            state.active && state.recording === 'recording',
            'Capture must remain active before the time limit.',
          );
        const heap = await offscreenHeap(browserCdp, id);
        if (heap !== undefined) heapSamples.push(heap);
        console.log(
          `Capture progress: ${elapsed}s; active=${state.active}; recording=${state.recording}; offscreen JavaScript heap=${heap === undefined ? 'unavailable' : `${(heap / 1048576).toFixed(1)} MiB`}.`,
        );
      }
    }
    if (recordSeconds === 1800) {
      await app.waitForFunction(
        async () =>
          !(await chrome.storage.session.get('activeSession')).activeSession,
        undefined,
        { timeout: 20_000 },
      );
      console.log(
        'The thirty-minute recording limit finalized capture automatically.',
      );
    } else {
      const stop = await send({ target: 'background', type: 'stop' });
      assert.equal(stop.ok, true, stop.error);
    }
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
      // Verify captured tab pixels follow the fixture's controlled color change and navigation.
      const imageChecks = [];
      for (const frame of session.frames.filter(
        (frame) => frame.time < 11000,
      )) {
        let images = await navigator.storage.getDirectory();
        for (const component of [session.id, 'screenshots'])
          images = await images.getDirectoryHandle(component);
        const file = await (
          await images.getFileHandle(frame.path.split('/').at(-1))
        ).getFile();
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const drawing = canvas.getContext('2d');
        drawing.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pixels = drawing.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        let cyan = 0,
          pink = 0;
        for (let pixel = 0; pixel < pixels.length; pixel += 4) {
          if (
            Math.abs(pixels[pixel] - 19) < 20 &&
            Math.abs(pixels[pixel + 1] - 183) < 20 &&
            Math.abs(pixels[pixel + 2] - 211) < 20
          )
            cyan++;
          if (
            Math.abs(pixels[pixel] - 207) < 20 &&
            Math.abs(pixels[pixel + 1] - 58) < 20 &&
            Math.abs(pixels[pixel + 2] - 113) < 20
          )
            pink++;
        }
        imageChecks.push({ time: frame.time, cyan, pink });
      }
      database.close();
      return { session, events, playback, audioChecks, imageChecks };
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
      assert.ok(
        result.session.audio.length >= Math.ceil(recordSeconds / 59),
        'Independent audio segments must cover the recording.',
      );
      const ordered = [...result.session.audio].sort(
        (a, b) => a.start - b.start,
      );
      assert.ok(
        ordered[0].start <= 1000,
        'Audio must begin near the start of the recording.',
      );
      assert.ok(
        ordered.at(-1).end >= result.session.duration - 1000,
        'Audio must cover the end of the recording.',
      );
      for (let index = 1; index < ordered.length; index++) {
        assert.ok(
          ordered[index].start > ordered[index - 1].start,
          'Audio windows must have distinct increasing start times.',
        );
        assert.ok(
          ordered[index].start < ordered[index - 1].end,
          'Audio segments must overlap at every boundary.',
        );
      }
    }
    if (recordSeconds === 1800) {
      assert.ok(
        result.session.duration >= 1_799_000 &&
          result.session.duration < 1_820_000,
        'The measured timeline must reach the automatic thirty-minute limit.',
      );
      assert.ok(
        result.session.frames.length >= 850,
        'Evidence frames must continue throughout the soak.',
      );
      assert.ok(
        result.session.frames.at(-1).time > 1_790_000,
        'Evidence frames must reach the end of the recording.',
      );
      const ordered = [...result.session.frames].sort(
        (a, b) => a.time - b.time,
      );
      for (let index = 1; index < ordered.length; index++)
        assert.ok(
          ordered[index].time - ordered[index - 1].time < 10_000,
          'The soak must not silently lose long periods of frame evidence.',
        );
    }
    if (heapSamples.length)
      console.log(
        `Offscreen JavaScript heap observed: initial=${(heapSamples[0] / 1048576).toFixed(1)} MiB, peak=${(Math.max(...heapSamples) / 1048576).toFixed(1)} MiB, final=${(heapSamples.at(-1) / 1048576).toFixed(1)} MiB. Native media/GPU/process memory is not measured.`,
      );
    assert.ok(
      result.playback.width > 0 &&
        result.playback.height > 0 &&
        result.playback.size > 0,
    );
    const pinkFrame = result.imageChecks.find((frame) => frame.pink >= 100);
    assert.ok(
      pinkFrame,
      'Captured frames must contain the fixture color after its controlled change.',
    );
    assert.ok(
      result.imageChecks.some(
        (frame) => frame.cyan >= 100 && frame.time < pinkFrame.time,
      ),
      'Capture must include the original fixture color.',
    );
    assert.ok(
      result.imageChecks.some(
        (frame) => frame.cyan >= 100 && frame.time > pinkFrame.time,
      ),
      'Capture must follow navigation back to the original fixture color.',
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
    recordingPassed = true;
    console.log(
      `Real Chromium ${context.browser().version()} (${recordSeconds} second recording): playable tab/microphone WebM, independently finalized audio segment, timestamped frames with verified tab pixels across changes/navigation, frozen point context, explicit selection, same-origin navigation, stop, and local persistence verified.`,
    );
    console.log(
      recordSeconds === 1800
        ? 'Provider readiness was synthetic. Paid provider compatibility and analyzed ZIP export are separate checks.'
        : 'Provider readiness was synthetic in this browser harness; paid provider compatibility and a full 30-minute session remain separate acceptance checks.',
    );
  }
} finally {
  try {
    try {
      await context?.close();
    } finally {
      context = undefined;
      await new Promise((resolve) => server.close(resolve));
    }
    if (exportRequested && recordingPassed) {
      const exported = await promisify(execFile)(
        process.execPath,
        [resolve('scripts/soak-export-test.mjs'), runDirectory],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      process.stdout.write(exported.stdout);
      process.stderr.write(exported.stderr);
    }
  } finally {
    if (keepArtifacts)
      console.log(
        `Synthetic browser artifacts retained at ${relative(process.cwd(), runDirectory)}.`,
      );
    else
      await rm(runDirectory, { recursive: true, force: true, maxRetries: 3 });
  }
}
