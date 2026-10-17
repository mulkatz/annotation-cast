import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { openAcceptanceControls } from '../tests/fixtures/acceptance-controls.mjs';
import {
  stored,
  until,
  startSynthetic,
  point,
} from '../tests/fixtures/lifecycle-controls.mjs';

// No .env loading or live credentials: readiness is synthetic only in this isolated profile.
await mkdir('.local/lifecycle', { recursive: true });
const work = await mkdtemp(resolve('.local/lifecycle/run-'));
const extension = resolve(work, 'extension');
const profile = resolve(work, 'profile');
await cp('dist', extension, { recursive: true });
await writeFile(
  resolve(extension, 'lifecycle-inspect.html'),
  '<!doctype html><title>Synthetic lifecycle inspection</title><script src="lifecycle-inspect.js"></script>',
);
await build({
  entryPoints: ['tests/fixtures/user-acceptance-harness.ts'],
  outfile: resolve(extension, 'lifecycle-inspect.js'),
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  legalComments: 'none',
});
const html = await readFile('tests/fixtures/user-acceptance.html');
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const firstUrl = `http://127.0.0.1:${address.port}/`;
const secondUrl = `http://localhost:${address.port}/next`;
const result = {
  controlPageIndependent: false,
  originGap: false,
  restoredMarker: false,
  tabClosure: 'not-run',
  crashRecovery: 'not-run',
  providerRequests: 0,
};
let context;
let currentStage = 'launch';
let browserId;
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    timeout: 20_000,
    args: [
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
      '--enable-unsafe-extension-debugging',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  context.setDefaultTimeout(15_000);
  await context.route('https://openrouter.ai/**', async (route) => {
    result.providerRequests++;
    await route.abort();
  });
  await context.grantPermissions(['microphone']);
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  browserId = new URL(worker.url()).host;
  return worker;
}

try {
  let worker = await launch();
  const testedPage = await context.newPage();
  await testedPage.goto(firstUrl);
  let app = await openAcceptanceControls(context, worker, testedPage);
  currentStage = 'start-synthetic-readiness';
  const sessionId = await startSynthetic(app);
  await testedPage.waitForTimeout(2300);
  const before = await stored(worker, sessionId);
  currentStage = 'control-page-close-reopen';
  await app.close();
  await testedPage.bringToFront();
  await until(
    async () =>
      (await stored(worker, sessionId)).session.frames.length >
      before.session.frames.length,
    'evidence frames advance with all control pages closed',
  );
  const during = await stored(worker, sessionId);
  assert.equal(during.session.status, 'recording');
  assert.ok(
    during.session.frames.length > before.session.frames.length,
    'Frames must continue while every control page is closed.',
  );
  app = await openAcceptanceControls(context, worker, testedPage);
  assert.equal(await app.locator('#stop').isEnabled(), true);
  result.controlPageIndependent = true;
  currentStage = 'origin-change-gap';
  await testedPage.goto(secondUrl);
  await app.waitForFunction(() =>
    document
      .querySelector('#capture-status')
      .textContent.includes('Page context: unavailable'),
  );
  const gap = await stored(worker, sessionId);
  assert.ok(
    gap.events.some(
      (event) =>
        event.type === 'gap' &&
        /context.*unavailable|origin change/i.test(event.data.reason ?? ''),
    ),
    'Origin loss must create explicit gap evidence.',
  );
  const frameCount = gap.session.frames.length;
  await until(
    async () =>
      (await stored(worker, sessionId)).session.frames.length > frameCount,
    'video frames continue across origin change',
  );
  assert.equal((await stored(worker, sessionId)).session.status, 'recording');
  result.originGap = true;
  currentStage = 'actual-toolbar-restores-context';
  const previous = app;
  app = await openAcceptanceControls(context, worker, testedPage);
  await previous.close();
  await app.waitForFunction(() =>
    document
      .querySelector('#capture-status')
      .textContent.includes('Page context: available'),
  );
  await testedPage.bringToFront();
  await point(testedPage);
  await until(
    async () =>
      (await stored(worker, sessionId)).events.some(
        (event) =>
          event.type === 'point' && event.url.startsWith('http://localhost:'),
      ),
    'point marker after renewed activeTab access',
  );
  result.restoredMarker = true;
  currentStage = 'target-tab-close-finalizes';
  await testedPage.close();
  await until(
    async () =>
      !(
        await worker.evaluate(() => chrome.storage.session.get('activeSession'))
      ).activeSession,
    'tab close clears active capture',
  );
  const finished = await stored(worker, sessionId);
  const inspector = await context.newPage();
  await inspector.goto(
    `chrome-extension://${browserId}/lifecycle-inspect.html`,
  );
  const playable = await inspector.evaluate(
    (id) => globalThis.inspectAcceptanceSession(id),
    sessionId,
  );
  assert.ok(
    playable.videoBytes > 0 &&
      playable.session.audio.length > 0 &&
      playable.session.frames.length > 0,
  );
  result.finalizedMediaDecodes = true;
  result.finalizedStatus = finished.session.status;
  assert.equal(
    finished.session.status,
    'stopped',
    'Closing the selected tab must finalize a clean recording.',
  );
  result.tabClosure = 'passed';
  result.finalizedDurationMs = Math.round(playable.session.duration);
  await inspector.close();
  if (process.env.LIFECYCLE_CRASH === '1') {
    currentStage = 'crash-capture-start';
    const crashPage = await context.newPage();
    await crashPage.goto(firstUrl);
    const old = app;
    app = await openAcceptanceControls(context, worker, crashPage);
    await old.close();
    const crashId = await startSynthetic(app);
    await crashPage.waitForTimeout(3200);
    assert.ok((await stored(worker, crashId)).session.frames.length > 0);
    currentStage = 'isolated-browser-crash';
    const cdp = await context.browser().newBrowserCDPSession();
    const browser = context.browser();
    const disconnected = new Promise((resolve, reject) => {
      const onDisconnected = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        browser.off('disconnected', onDisconnected);
        reject(
          new Error(
            'The isolated browser did not disconnect after its crash command.',
          ),
        );
      }, 15_000);
      browser.once('disconnected', onDisconnected);
    });
    const observed = disconnected.then(
      () => undefined,
      (error) => error,
    );
    void cdp.send('Browser.crash').catch(() => undefined);
    const disconnectError = await observed;
    if (disconnectError) throw disconnectError;
    context = undefined;
    currentStage = 'restart-recovery';
    worker = await launch();
    const recovered = await until(async () => {
      const state = await stored(worker, crashId);
      return state.session?.status === 'interrupted' ? state : undefined;
    }, 'startup recovers interrupted session');
    assert.ok(
      recovered.session.frames.length > 0 &&
        recovered.events.some(
          (event) =>
            event.type === 'gap' &&
            /interrupt|recover/i.test(event.data.reason ?? ''),
        ),
    );
    const raw = await context.newPage();
    await raw.goto(`chrome-extension://${browserId}/lifecycle-inspect.html`);
    const bytes = await raw.evaluate(async (path) => {
      let directory = await navigator.storage.getDirectory();
      const parts = path.split('/');
      const file = parts.pop();
      for (const part of parts)
        directory = await directory.getDirectoryHandle(part);
      return (await (await directory.getFileHandle(file)).getFile()).size;
    }, recovered.session.recordingPath);
    assert.ok(
      bytes > 0,
      'Flushed recording bytes must survive the isolated browser crash.',
    );
    result.crashRecovery = 'passed';
    result.recoveredBytes = bytes;
  }
  assert.equal(result.providerRequests, 0);
  console.log(JSON.stringify(result, null, 2));
  console.log(
    'Lifecycle checks used actual tab media with a fake microphone and synthetic readiness. No provider readiness or crash-media playability is claimed.',
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ...result,
        failedStage: currentStage,
        error:
          error instanceof Error
            ? error.message
            : 'Lifecycle acceptance failed.',
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  if (context?.browser()?.isConnected())
    await context.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  await rm(work, { recursive: true, force: true, maxRetries: 3 });
}
