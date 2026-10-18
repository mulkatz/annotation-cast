import { chromium } from 'playwright';
import { build } from 'esbuild';
import { BlobReader, BlobWriter, TextWriter, ZipReader } from '@zip.js/zip.js';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import assert from 'node:assert/strict';
import { openAcceptanceControls } from '../tests/fixtures/acceptance-controls.mjs';

// This guard precedes env loading, browser launch, and all network access.
if (process.env.LIVE_API !== '1') {
  console.error(
    'Live acceptance is disabled. Explicitly set LIVE_API=1 to authorize paid provider requests.',
  );
  process.exit(2);
}
let key = '';
function scrub(value) {
  let message = String(value);
  if (key) message = message.split(key).join('[REDACTED]');
  return message.replace(
    /\bsk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{12,}\b/g,
    '[REDACTED]',
  );
}
const summary = {
  version: 1,
  startedAt: new Date().toISOString(),
  syntheticInput: true,
  fullJourney: 'not-run',
  partialCanvas: 'not-run',
  stages: [],
  providerRequests: 0,
  reportedCostUsd: 0,
  requestBudget: 12,
  cleanupComplete: false,
};
let context;
let server;
let runDirectory;
let profile;
let deadline;
const responseChecks = new Set();
async function stage(name, action) {
  if (summary.deadlineExceeded)
    throw new Error('Live acceptance exceeded its eight-minute deadline.');
  const result = { name, status: 'running' };
  summary.stages.push(result);
  try {
    const value = await action();
    result.status = 'passed';
    return value;
  } catch (error) {
    result.status = 'failed';
    result.reason = scrub(error instanceof Error ? error.message : error);
    throw error;
  }
}
async function settle(page, success, timeout = 180_000) {
  await page.waitForFunction(success, undefined, { timeout });
  const error = await page
    .locator('#notice')
    .evaluate((node) =>
      node.classList.contains('error') ? node.textContent : '',
    );
  if (error) throw new Error(scrub(error));
}
async function tap(page, key) {
  for (let index = 0; index < 2; index++) {
    await page.keyboard.down(key);
    await page.waitForTimeout(20);
    await page.keyboard.up(key);
    if (index + 1 < 2) await page.waitForTimeout(40);
  }
  await page.waitForTimeout(220);
}
async function inspectZip(path, expectedVideoHash) {
  const reader = new ZipReader(
    new BlobReader(new Blob([await readFile(path)])),
    { useWebWorkers: false },
  );
  try {
    const entries = await reader.getEntries();
    const names = entries.map((entry) => entry.filename);
    for (const name of [
      'README.md',
      'recording.webm',
      'report.md',
      'issues.json',
      'transcript.json',
      'events.json',
      'session.json',
    ])
      assert.ok(names.includes(name), `ZIP missing ${name}`);
    const documents = {};
    for (const entry of entries) {
      assert.ok(
        !entry.filename.startsWith('/') && !entry.filename.includes('..'),
        'ZIP references must remain relative.',
      );
      if (entry.directory || !entry.getData) continue;
      if (/\.(json|md)$/.test(entry.filename)) {
        const text = await entry.getData(new TextWriter(), {
          checkSignature: true,
        });
        assert.ok(
          !text.includes(key) && !text.includes('synthetic-context-secret'),
          'Detected credential text remained in the ZIP.',
        );
        documents[entry.filename] = text;
      }
      if (entry.filename === 'recording.webm') {
        const video = await entry.getData(new BlobWriter('video/webm'), {
          checkSignature: true,
        });
        assert.equal(
          createHash('sha256')
            .update(new Uint8Array(await video.arrayBuffer()))
            .digest('hex'),
          expectedVideoHash,
          'Export must preserve the actual recording bytes.',
        );
      }
    }
    const transcript = JSON.parse(documents['transcript.json']).segments;
    const findings = JSON.parse(documents['issues.json']).issues;
    const events = JSON.parse(documents['events.json']).events;
    const metadata = JSON.parse(documents['session.json']);
    assert.ok(
      transcript.length > 0 &&
        transcript.every(
          (quote) =>
            quote.end > quote.start &&
            quote.start >= 0 &&
            quote.end <= metadata.duration,
        ),
      'Live transcription must contain actual session timestamps.',
    );
    const evidence = new Set([
      ...events.map((event) => event.id),
      ...metadata.frames.map((frame) => frame.id),
    ]);
    const quotes = new Set(transcript.map((quote) => quote.id));
    const referenceQuotes = new Set(
      transcript
        .filter(
          (quote) =>
            /\bblue(?:\s+\w+){0,3}\s+button\b/i.test(quote.text) &&
            /\b(?:missing|absent|not\s+(?:present|visible|shown|available))\b/i.test(
              quote.text,
            ),
        )
        .map((quote) => quote.id),
    );
    const referenceFindings = findings.filter((finding) =>
      finding.quoteIds.some((id) => referenceQuotes.has(id)),
    );
    for (const finding of findings) {
      assert.ok(
        finding.quoteIds.length > 0 &&
          finding.quoteIds.every((id) => quotes.has(id)),
        'Finding source quote IDs must resolve.',
      );
      assert.ok(
        finding.evidenceIds.every((id) => evidence.has(id)),
        'Finding evidence IDs must resolve.',
      );
      assert.ok(
        finding.end >= finding.start && finding.end <= metadata.duration,
        'Finding ranges must be on the session timeline.',
      );
    }
    assert.ok(
      metadata.frames.every((frame) => names.includes(frame.path)),
      'Every referenced screenshot must exist.',
    );
    assert.equal(metadata.processing.reviewed, false);
    assert.equal(metadata.recordingPath, 'recording.webm');
    // This absence-only fixture states neither an expected action nor workflow impact.
    // These checks target that known regression, not general semantic correctness.
    assert.ok(
      referenceFindings.every((finding) => finding.expectedBehavior === null),
      'The absence-only reference must not invent an expected workflow action.',
    );
    assert.ok(
      referenceFindings.every((finding) => finding.reproduction.length === 0),
      'The absence-only reference must not invent reproduction actions.',
    );
    assert.ok(
      referenceFindings.every(
        (finding) =>
          !/\b(?:prevent\w*|block\w*|unable|cannot|can't)\b/i.test(
            `${finding.title} ${finding.description}`,
          ),
      ),
      'The absence-only reference must not invent workflow impact.',
    );
    return {
      files: names.length,
      transcriptStatements: transcript.length,
      findings: findings.length,
      referenceObservationLinked: findings.some((finding) =>
        finding.quoteIds.some((id) => referenceQuotes.has(id)),
      ),
      durationMs: Math.round(metadata.duration),
    };
  } finally {
    await reader.close();
  }
}
async function main() {
  try {
    process.loadEnvFile('.env');
  } catch (error) {
    if (error?.code !== 'ENOENT')
      throw new Error('The project .env file could not be loaded.');
  }
  key = process.env.OPENROUTER_API_KEY?.trim() ?? '';
  if (!key)
    throw new Error(
      'Configure OPENROUTER_API_KEY in the environment or ignored .env file.',
    );
  await mkdir('.local/user-acceptance', { recursive: true });
  runDirectory = await mkdtemp(resolve('.local/user-acceptance/run-'));
  profile = resolve(runDirectory, 'profile');
  const extension = resolve(runDirectory, 'extension');
  await cp('dist', extension, { recursive: true });
  await writeFile(
    resolve(extension, 'acceptance-media.html'),
    '<!doctype html><title>Synthetic partial media acceptance</title><script src="acceptance-media.js"></script>',
  );
  await build({
    entryPoints: ['tests/fixtures/user-acceptance-harness.ts'],
    outfile: resolve(extension, 'acceptance-media.js'),
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    legalComments: 'none',
  });
  const fixture = await readFile('tests/fixtures/user-acceptance.html');
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const fixtureUrl = `http://127.0.0.1:${address.port}/`;
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    args: [
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
      '--enable-unsafe-extension-debugging',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${resolve('public/readiness.wav')}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  context.setDefaultTimeout(15_000);
  summary.browser = context.browser().version();
  const endpointNames = new Set([
    '/api/v1/audio/transcriptions',
    '/api/v1/chat/completions',
  ]);
  await context.route('https://openrouter.ai/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ?? '';
    if (
      summary.deadlineExceeded ||
      request.method() !== 'POST' ||
      !endpointNames.has(url.pathname) ||
      summary.providerRequests >= summary.requestBudget ||
      body.includes(key) ||
      body.includes('synthetic-context-secret')
    ) {
      summary.networkGuardFailure = true;
      await route.abort();
      return;
    }
    summary.providerRequests++;
    await route.continue();
  });
  context.on('response', (response) => {
    if (!response.url().startsWith('https://openrouter.ai/api/v1/')) return;
    const check = (async () => {
      try {
        const data = await response.json();
        const cost = data?.usage?.cost;
        if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)
          summary.reportedCostUsd += cost;
      } catch {
        /* Request outcomes are checked through the actual application UI. */
      }
    })();
    responseChecks.add(check);
    void check.finally(() => responseChecks.delete(check));
  });
  await context.grantPermissions(['microphone']);
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const id = new URL(worker.url()).host;
  const testedPage = await context.newPage();
  await testedPage.goto(fixtureUrl);
  const app = await stage('actual-toolbar-controls', () =>
    openAcceptanceControls(context, worker, testedPage),
  );
  await stage('actual-ui-live-readiness', async () => {
    await app.locator('#key').fill(key);
    await app.locator('#save-key').click();
    await app.locator('#project').fill('Synthetic user acceptance');
    await app
      .locator('#objective')
      .fill(
        'Verify the narrated missing blue primary button and evidence export.',
      );
    await app.locator('#readiness').click();
    await settle(
      app,
      () =>
        !document.querySelector('#start').disabled ||
        document.querySelector('#notice').classList.contains('error'),
    );
    assert.match(
      await app.locator('#provider-status').innerText(),
      /Connection verified/,
    );
    assert.equal(await app.locator('#start').isEnabled(), true);
  });
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${id}/acceptance-media.html`);
  async function analyzeAndExport(sessionId, name) {
    await app.reload();
    await app.waitForFunction(
      (id) => document.querySelector('#sessions').value === id,
      sessionId,
    );
    await app.locator('#analyze').click();
    await settle(
      app,
      () =>
        !document.querySelector('#export').disabled ||
        document.querySelector('#notice').classList.contains('error'),
    );
    const media = await helper.evaluate(
      (id) => globalThis.inspectAcceptanceSession(id),
      sessionId,
    );
    const downloadReady = app.waitForEvent('download', { timeout: 120_000 });
    await app.locator('#export').click();
    const download = await downloadReady;
    const zipPath = resolve(runDirectory, `${name}.zip`);
    await download.saveAs(zipPath);
    const bundle = await inspectZip(zipPath, media.videoHash);
    assert.ok(
      bundle.referenceObservationLinked,
      'No finding referenced the known source observation; the reference association check failed.',
    );
    return {
      ...bundle,
      mediaDecodes: true,
      zip: relative(process.cwd(), zipPath),
    };
  }
  let recordedId;
  try {
    await stage('actual-tab-microphone-markers-navigation', async () => {
      await app.locator('#start').click();
      await settle(
        app,
        () =>
          !document.querySelector('#stop').disabled ||
          document.querySelector('#notice').classList.contains('error'),
        45_000,
      );
      assert.equal(await app.locator('#stop').isEnabled(), true);
      await testedPage.bringToFront();
      await testedPage.locator('#cancel').hover();
      await testedPage.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#quote'));
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await tap(testedPage, 'Control');
      await tap(testedPage, 'Shift');
      await testedPage.mouse.move(80, 110);
      await testedPage.mouse.down();
      await testedPage.mouse.move(440, 320);
      await testedPage.mouse.up();
      await testedPage.waitForTimeout(2500);
      await testedPage.locator('#navigate').click();
      await testedPage.waitForTimeout(3500);
      await app.locator('#stop').click();
      await app.waitForFunction(
        () => !document.querySelector('#analyze').disabled,
        undefined,
        { timeout: 30_000 },
      );
      recordedId = await app.locator('#sessions').inputValue();
      const observed = await helper.evaluate(
        (id) => globalThis.inspectAcceptanceSession(id),
        recordedId,
      );
      assert.ok(
        observed.events.filter((event) => event.type === 'point').length ===
          1 &&
          observed.events.filter((event) => event.type === 'rectangle')
            .length === 1,
        'Real modifier gestures did not produce both marker types.',
      );
      assert.ok(
        observed.events.some((event) => event.type === 'navigation'),
        'Same-tab navigation was not retained.',
      );
    });
    summary.fullJourneyResult = await stage(
      'actual-ui-live-analysis-download',
      () => analyzeAndExport(recordedId, 'actual-tab-session'),
    );
    summary.fullJourney = 'passed';
  } catch {
    summary.fullJourney = 'failed';
    // Preserve the failed actual journey. Independently test live processing with clearly synthetic canvas media.
    const stopped = await app
      .locator('#stop')
      .isEnabled()
      .catch(() => false);
    if (stopped) {
      await app.locator('#stop').click();
      await app.waitForTimeout(500);
    }
  }
  if (summary.fullJourney !== 'passed') {
    try {
      const partialId = await stage('separate-synthetic-canvas-media', () =>
        helper.evaluate(
          (url) => globalThis.seedSyntheticCanvasSession(url),
          fixtureUrl,
        ),
      );
      summary.partialResult = await stage(
        'partial-live-analysis-download',
        () => analyzeAndExport(partialId, 'synthetic-canvas-partial'),
      );
      summary.partialCanvas = 'passed';
    } catch {
      summary.partialCanvas = 'failed';
    }
  }
  await Promise.all(responseChecks);
  assert.ok(
    !summary.networkGuardFailure,
    'Provider request/sanitation budget guard rejected a request.',
  );
}
try {
  deadline = setTimeout(() => {
    summary.deadlineExceeded = true;
    // Closing the browser cancels in-flight UI/provider work. Await main settlement
    // before profile cleanup so no detached continuation can restart paid requests.
    void context?.close().catch(() => undefined);
  }, 8 * 60_000);
  await main();
  if (summary.deadlineExceeded)
    throw new Error('Live acceptance exceeded its eight-minute deadline.');
} catch (error) {
  summary.error = scrub(error instanceof Error ? error.message : error);
  if (summary.fullJourney === 'not-run') summary.fullJourney = 'failed';
} finally {
  clearTimeout(deadline);
  await context?.close().catch(() => undefined);
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    if (profile)
      await rm(profile, { recursive: true, force: true, maxRetries: 3 });
    summary.cleanupComplete = true;
  } catch {
    summary.cleanupError =
      'The isolated ignored browser profile could not be removed; delete its profile directory before sharing artifacts.';
  }
  summary.reportedCostUsd = Number(summary.reportedCostUsd.toFixed(6));
  const safe = scrub(JSON.stringify(summary, null, 2));
  if (runDirectory)
    await writeFile(resolve(runDirectory, 'summary.json'), safe);
  console.log(safe);
  if (
    summary.fullJourney !== 'passed' ||
    !summary.cleanupComplete ||
    summary.error ||
    summary.networkGuardFailure ||
    summary.deadlineExceeded
  )
    process.exitCode = 1;
}
