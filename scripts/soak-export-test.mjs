import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { cp, lstat, mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';

// Only retained, synthetic browser-test profiles are supported. Never loads .env.
const work = resolve(process.argv[2] ?? '');
const root = resolve('.local/browser');
assert.ok(
  work.startsWith(root + sep),
  'Pass a retained .local/browser/run-* directory.',
);
await stat(resolve(work, 'profile'));
try {
  await lstat(resolve(work, 'profile/SingletonLock'));
  throw new Error(
    'Close the retained test browser before checking its export.',
  );
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const extension = resolve(work, 'extension');
await cp('dist', extension, { recursive: true });
await writeFile(
  resolve(extension, 'soak-inspect.html'),
  '<!doctype html><title>Synthetic soak export</title><script src="soak-inspect.js"></script>',
);
await build({
  entryPoints: ['tests/fixtures/soak-export.ts'],
  outfile: resolve(extension, 'soak-inspect.js'),
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  legalComments: 'none',
});
const artifacts = resolve(work, 'export-check');
await mkdir(artifacts, { recursive: true });
let context;
const calls = { transcription: 0, analysis: 0, blocked: 0 };
try {
  context = await chromium.launchPersistentContext(resolve(work, 'profile'), {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    args: [
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
    ],
  });
  context.setDefaultTimeout(20_000);
  await context.route('https://openrouter.ai/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON();
    if (
      request.method() === 'POST' &&
      url.pathname === '/api/v1/audio/transcriptions' &&
      body.model === 'openai/whisper-large-v3'
    ) {
      calls.transcription++;
      assert.equal(body.input_audio.format, 'webm');
      assert.ok(body.input_audio.data.length > 100);
      await route.fulfill({
        json: {
          text: 'Synthetic soak checkpoint.',
          segments: [
            { start: 0.1, end: 0.5, text: 'Synthetic soak checkpoint.' },
          ],
        },
      });
    } else if (
      request.method() === 'POST' &&
      url.pathname === '/api/v1/chat/completions' &&
      body.model === 'google/gemini-2.5-flash'
    ) {
      calls.analysis++;
      assert.ok(
        body.messages[1].content.some((part) => part.type === 'image_url'),
      );
      await route.fulfill({
        json: {
          choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
        },
      });
    } else {
      calls.blocked++;
      await route.abort();
    }
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const inspector = await context.newPage();
  await inspector.goto(`chrome-extension://${id}/soak-inspect.html`);
  const inventory = await inspector.evaluate(() => globalThis.soakInventory());
  assert.ok(inventory.session.duration >= 6000);
  assert.equal(
    inventory.session.completedSegments.length,
    0,
    'Use a fresh retained recording; this check must exercise every processing step.',
  );
  const originalReady = inspector.waitForEvent('download');
  await inspector.evaluate(() => globalThis.downloadOriginal());
  const original = await originalReady;
  const originalPath = resolve(artifacts, 'original.webm');
  await original.saveAs(originalPath);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(originalPath))
    digest.update(chunk);
  const originalHash = digest.digest('hex');
  const app = await context.newPage();
  await app.goto(`chrome-extension://${id}/app.html`);
  await app.waitForFunction(
    (sessionId) =>
      document.querySelector('#sessions').value === sessionId &&
      !document.querySelector('#analyze').disabled,
    inventory.session.id,
  );
  await app.locator('#analyze').click();
  await app.waitForFunction(
    () =>
      !document.querySelector('#export').disabled ||
      document.querySelector('#notice').classList.contains('error'),
    undefined,
    { timeout: 240_000 },
  );
  assert.equal(
    await app.locator('#export').isEnabled(),
    true,
    'Mocked processing must complete before export.',
  );
  assert.equal(calls.transcription, inventory.session.audio.length);
  assert.equal(calls.analysis, Math.ceil(inventory.session.duration / 120_000));
  assert.equal(calls.blocked, 0);
  const zipReady = app.waitForEvent('download', { timeout: 180_000 });
  await app.locator('#export').click();
  const download = await zipReady;
  const zipPath = resolve(artifacts, 'soak.zip');
  await download.saveAs(zipPath);
  const archive = new ZipReader(new BlobReader(await openAsBlob(zipPath)), {
    useWebWorkers: false,
  });
  const documents = {};
  let mediaHash;
  let imageCount = 0;
  try {
    const entries = await archive.getEntries();
    assert.equal(entries.length, 7 + inventory.session.frames.length);
    for (const entry of entries) {
      assert.ok(
        !entry.directory &&
          entry.getData &&
          !entry.filename.startsWith('/') &&
          !entry.filename.includes('..'),
      );
      if (/\.(json|md)$/.test(entry.filename)) {
        documents[entry.filename] = await entry.getData(new TextWriter(), {
          checkSignature: true,
        });
      } else {
        const hash = createHash('sha256');
        let bytes = 0;
        await entry.getData(
          new WritableStream({
            write(chunk) {
              bytes += chunk.length;
              hash.update(chunk);
            },
          }),
          { checkSignature: true },
        );
        assert.ok(bytes > 0);
        if (entry.filename === 'recording.webm') {
          mediaHash = hash.digest('hex');
          assert.equal(bytes, inventory.videoBytes);
        } else {
          assert.match(entry.filename, /^screenshots\/[a-zA-Z0-9_-]+\.jpg$/);
          assert.equal(
            hash.digest('hex'),
            inventory.imageHashes[entry.filename],
            'Export must preserve each original screenshot byte.',
          );
          imageCount++;
        }
      }
    }
    assert.equal(
      mediaHash,
      originalHash,
      'Streamed export must preserve every recorded video byte.',
    );
    assert.equal(imageCount, inventory.session.frames.length);
    const metadata = JSON.parse(documents['session.json']);
    assert.equal(metadata.duration, inventory.session.duration);
    assert.equal(metadata.processing.status, 'complete');
    assert.equal(metadata.processing.reviewed, false);
    assert.equal(
      JSON.parse(documents['transcript.json']).segments.length,
      inventory.session.audio.length,
    );
    assert.ok(
      metadata.frames.every((frame) =>
        entries.some((entry) => entry.filename === frame.path),
      ),
    );
    const summary = {
      durationMs: Math.round(metadata.duration),
      frames: imageCount,
      videoBytes: inventory.videoBytes,
      zipBytes: (await stat(zipPath)).size,
      videoHashMatches: true,
      imageHashesMatch: true,
      allEntryChecksumsVerified: true,
      providerCalls: calls,
      providerResponses:
        'mocked; no live compatibility or finding-quality claim',
      zip: relative(process.cwd(), zipPath),
    };
    await writeFile(
      resolve(artifacts, 'summary.json'),
      JSON.stringify(summary, null, 2),
    );
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await archive.close();
  }
} finally {
  await context?.close();
}
