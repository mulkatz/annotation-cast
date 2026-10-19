import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openAsBlob } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { openAcceptanceControls } from '../tests/fixtures/acceptance-controls.mjs';
import { stored, until } from '../tests/fixtures/lifecycle-controls.mjs';

// Run after npm run build. Requires ffmpeg and ffprobe on PATH.
// Never loads .env, a real profile, or credentials. Only synthetic assets are retained.
await mkdir('.local/demo', { recursive: true });
const work = await mkdtemp(resolve('.local/demo/run-'));
const extension = resolve(work, 'extension');
await cp('dist', extension, { recursive: true });
const html = await readFile('tests/fixtures/demo.html');
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(html);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const calls = { transcription: 0, analysis: 0, blocked: 0 };
const starts = new WeakMap();
const clips = [];
let context;
let stage = 'launch';
const command = (name, args) => {
  const result = spawnSync(name, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  return result.stdout;
};
const clip = (page, label) => {
  const start = (Date.now() - starts.get(page)) / 1000;
  return () =>
    clips.push({
      page,
      label,
      start,
      end: (Date.now() - starts.get(page)) / 1000,
    });
};
const pause = (page, ms) => page.waitForTimeout(ms);
async function doubleTap(page, key) {
  await page.keyboard.press(key);
  await pause(page, 50);
  await page.keyboard.press(key);
}
async function fitVideoViewport(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    // Chromium computes the outer bounds for this content size on each platform.
    await cdp.send('Browser.setContentsSize', {
      windowId,
      width: 1280,
      height: 800,
    });
  } finally {
    await cdp.detach();
  }
}

try {
  context = await chromium.launchPersistentContext(resolve(work, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    recordVideo: {
      dir: resolve(work, 'raw'),
      size: { width: 1280, height: 800 },
    },
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
  context.on('page', (page) => starts.set(page, Date.now()));
  context.setDefaultTimeout(20_000);
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin || url.protocol === 'chrome-extension:') {
      await route.continue();
      return;
    }
    if (url.origin === 'https://openrouter.ai' && request.method() === 'POST') {
      const body = request.postDataJSON();
      if (
        url.pathname === '/api/v1/audio/transcriptions' &&
        body.model === 'openai/whisper-large-v3'
      ) {
        calls.transcription++;
        assert.ok(body.input_audio.data.length > 100);
        await route.fulfill({
          json: {
            text: 'The blue button is missing.',
            segments: [
              { start: 0.2, end: 1.5, text: 'The blue button is missing.' },
            ],
          },
        });
        return;
      }
      if (
        url.pathname === '/api/v1/chat/completions' &&
        body.model === 'google/gemini-2.5-flash'
      ) {
        calls.analysis++;
        const data = JSON.parse(body.messages[1].content[0].text);
        const marker = data.events.find((event) => event.type === 'rectangle');
        const frame = [...data.frames].sort(
          (left, right) =>
            Math.abs(left.time - (marker?.time ?? 0)) -
            Math.abs(right.time - (marker?.time ?? 0)),
        )[0];
        assert.ok(marker && frame && data.transcript[0]);
        await route.fulfill({
          json: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    findings: [
                      {
                        id: 'issue-1',
                        title: 'The blue button is missing',
                        description:
                          'The narrated blue button is absent from the project settings action area.',
                        start: marker.time,
                        end: marker.time,
                        page: marker.url,
                        evidenceIds: [marker.id, frame.id],
                        quoteIds: [data.transcript[0].id],
                        hypotheses: [],
                        expectedBehavior: null,
                        reproduction: [],
                        association: 'supported',
                      },
                    ],
                  }),
                },
              },
            ],
          },
        });
        return;
      }
    }
    calls.blocked++;
    await route.abort();
  });
  await context.grantPermissions(['microphone']);
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const page = await context.newPage();
  await page.goto(origin);
  const app = await openAcceptanceControls(context, worker, page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await app.setViewportSize({ width: 1280, height: 800 });
  await fitVideoViewport(app);
  stage = 'synthetic-provider-receipt';
  await app.evaluate(() =>
    navigator.locks.request(
      'annotation-cast-provider-settings',
      {},
      async () => {
        const key = 'synthetic-demo-placeholder';
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(key),
        );
        const keyFingerprint = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        await chrome.storage.local.set({
          settings: { key, diagnostics: false, shiftTapIntervalMs: 180 },
          providerVerification: {
            checkedAt: Date.now(),
            keyFingerprint,
            transcription: 'openai/whisper-large-v3',
            analysis: 'google/gemini-2.5-flash',
            version: 2,
          },
        });
      },
    ),
  );
  await app.reload();
  await app.locator('#project').fill('Website refresh');
  await app
    .locator('#objective')
    .fill('Review the project settings action area.');
  await app.locator('#environment').fill('Synthetic local demo');
  await app.waitForFunction(() => !document.querySelector('#start').disabled);
  let endClip = clip(app, '1 / Record your test session');
  await pause(app, 2800);
  stage = 'production-start';
  await app.locator('#start').click();
  await app.waitForFunction(
    () =>
      !document.querySelector('#stop').disabled &&
      document.querySelector('#cancel').disabled,
  );
  const active = await worker.evaluate(
    async () =>
      (await chrome.storage.session.get('activeSession')).activeSession,
  );
  assert.ok(active);
  await pause(app, 1500);
  endClip();
  stage = 'trusted-markers';
  await page.bringToFront();
  await fitVideoViewport(page);
  endClip = clip(page, '2 / Narrate and mark the exact area');
  await pause(page, 1500);
  await page.mouse.move(620, 665, { steps: 20 });
  await doubleTap(page, 'Control');
  await pause(page, 1500);
  await doubleTap(page, 'Shift');
  await page.mouse.move(485, 615);
  await page.mouse.down();
  await page.mouse.move(690, 705, { steps: 35 });
  await pause(page, 1200);
  await page.mouse.up();
  await pause(page, 2300);
  const recording = await stored(worker, active.id);
  assert.ok(recording.events.some((event) => event.type === 'point'));
  assert.ok(recording.events.some((event) => event.type === 'rectangle'));
  assert.ok(recording.session.frames.length > 0);
  endClip();
  await app.bringToFront();
  await fitVideoViewport(app);
  stage = 'production-stop';
  await app.locator('#stop').click();
  await until(
    async () => (await stored(worker, active.id)).session.status === 'stopped',
    'recording saved',
  );
  await app.locator('#analyze').scrollIntoViewIfNeeded();
  await app.waitForFunction(() => !document.querySelector('#analyze').disabled);
  endClip = clip(app, '3 / Analyze the captured evidence');
  await pause(app, 2000);
  stage = 'mocked-analysis';
  await app.locator('#analyze').click();
  await app
    .getByRole('heading', {
      name: 'issue-1 · The blue button is missing',
      exact: true,
    })
    .waitFor();
  await pause(app, 1000);
  endClip();
  await app.locator('#results').scrollIntoViewIfNeeded();
  await pause(app, 500);
  endClip = clip(app, '4 / Review source statements and screenshots');
  await pause(app, 4500);
  const poster = resolve(work, 'poster.png');
  await app.screenshot({ path: poster });
  endClip();
  // Enlarge the actual results card for readable source text in the small GIF.
  const resultBox = await app.locator('#results').boundingBox();
  assert.ok(resultBox);
  const cropX = Math.max(0, Math.floor(resultBox.x) - 24);
  const cropY = Math.max(0, Math.floor(resultBox.y) - 50);
  const cropWidth = Math.min(1280 - cropX, Math.ceil(resultBox.width) + 48);
  const resultsFilter = `crop=${cropWidth}:${800 - cropY}:${cropX}:${cropY},scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=0xf3f6f1,setsar=1`;
  clips.at(-1).crop = resultsFilter;
  await app.locator('#export').scrollIntoViewIfNeeded();
  endClip = clip(app, '5 / Download the evidence ZIP');
  await pause(app, 1500);
  const downloading = app.waitForEvent('download');
  await app.locator('#export').click();
  const download = await downloading;
  const zipPath = resolve(work, 'synthetic-evidence.zip');
  await download.saveAs(zipPath);
  await pause(app, 1500);
  endClip();
  stage = 'export-integrity';
  const archive = new ZipReader(new BlobReader(await openAsBlob(zipPath)), {
    useWebWorkers: false,
  });
  const docs = {};
  const entries = await archive.getEntries();
  for (const entry of entries) {
    assert.ok(
      entry.getData && !entry.directory && !entry.filename.includes('..'),
    );
    if (/\.(json|md)$/.test(entry.filename))
      docs[entry.filename] = await entry.getData(new TextWriter(), {
        checkSignature: true,
      });
    else
      await entry.getData(
        new WritableStream({
          write(chunk) {
            assert.ok(chunk.length);
          },
        }),
        { checkSignature: true },
      );
  }
  await archive.close();
  const metadata = JSON.parse(docs['session.json']);
  const events = JSON.parse(docs['events.json']);
  const transcript = JSON.parse(docs['transcript.json']);
  const issues = JSON.parse(docs['issues.json']);
  assert.ok(
    metadata.frames.every((frame) =>
      entries.some((entry) => entry.filename === frame.path),
    ),
  );
  const reportImages = [
    ...docs['report.md'].matchAll(/!\[[^\]]*\]\((screenshots\/[^)]+)\)/g),
  ];
  assert.ok(reportImages.length > 0);
  assert.ok(
    reportImages.every((match) =>
      entries.some((entry) => entry.filename === match[1]),
    ),
  );
  assert.equal(metadata.processing.status, 'complete');
  const finding = issues.issues[0];
  assert.ok(
    finding.quoteIds.every((id) =>
      transcript.segments.some((quote) => quote.id === id),
    ),
  );
  assert.ok(
    finding.evidenceIds.every(
      (id) =>
        events.events.some((event) => event.id === id) ||
        metadata.frames.some((frame) => frame.id === id),
    ),
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.filename === 'recording.webm' && entry.uncompressedSize > 0,
    ),
  );
  assert.ok(
    calls.transcription > 0 && calls.analysis === 1 && calls.blocked === 0,
  );
  for (const item of clips) item.video = await item.page.video().path();
  // Editorial labels are separate transparent images, never injected into product UI.
  const labels = await context.newPage();
  async function renderLabel(title, path) {
    await labels.setContent(
      `<style>body{margin:0;background:transparent;font-family:Arial,sans-serif}.label{position:absolute;left:16px;color:white;background:#101827ef;padding:10px 12px;border-radius:8px}.title{top:16px;font-size:24px}.caption{bottom:16px;font-size:19px}</style>${title ? `<div class="label title">${title}</div>` : ''}<div class="label caption">Synthetic demo · AI responses mocked</div>`,
    );
    await labels.screenshot({ path, omitBackground: true });
  }
  for (const [index, item] of clips.entries()) {
    item.overlay = resolve(work, `label-${index}.png`);
    await renderLabel(item.label, item.overlay);
  }
  const posterLabel = resolve(work, 'poster-label.png');
  await renderLabel('', posterLabel);
  await context.close();
  context = undefined;
  stage = 'render-assets';
  const filters = clips.map(
    (item, index) =>
      `[${index}:v]trim=start=${item.start.toFixed(3)}:end=${item.end.toFixed(3)},setpts=PTS-STARTPTS,fps=24${item.crop ? `,${item.crop}` : ''}[v${index}];[v${index}][${clips.length + index}:v]overlay=0:0[c${index}]`,
  );
  filters.push(
    `${clips.map((_, index) => `[c${index}]`).join('')}concat=n=${clips.length}:v=1:a=0[out]`,
  );
  await mkdir('docs/assets', { recursive: true });
  command('ffmpeg', [
    '-y',
    ...clips.flatMap((item) => ['-i', item.video]),
    ...clips.flatMap((item) => ['-i', item.overlay]),
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-c:v',
    'libx264',
    '-crf',
    '24',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    'docs/assets/demo.mp4',
  ]);
  command('ffmpeg', [
    '-y',
    '-i',
    'docs/assets/demo.mp4',
    '-vf',
    'fps=10,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4',
    '-loop',
    '0',
    'docs/assets/demo.gif',
  ]);
  command('ffmpeg', [
    '-y',
    '-i',
    poster,
    '-i',
    posterLabel,
    '-filter_complex',
    `[0:v]${resultsFilter}[result];[result][1:v]overlay=0:0`,
    '-frames:v',
    '1',
    'docs/assets/demo-poster.png',
  ]);
  const probe = JSON.parse(
    command('ffprobe', [
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      'docs/assets/demo.mp4',
    ]),
  );
  assert.equal(probe.streams[0].codec_name, 'h264');
  assert.equal(probe.streams[0].pix_fmt, 'yuv420p');
  const summary = {
    work,
    providerResponses: 'mocked',
    calls,
    stages: clips.map(({ label, start, end }) => ({
      label,
      seconds: +(end - start).toFixed(2),
    })),
    duration: probe.format.duration,
    gifBytes: (await stat('docs/assets/demo.gif')).size,
    zipEntries: entries.length,
    exportChecksumsAndReferencesValid: true,
  };
  await writeFile(
    resolve(work, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(`Synthetic demo failed at ${stage}. Artifacts: ${work}`);
  for (const [index, page] of (context?.pages() ?? []).entries()) {
    await page
      .screenshot({ path: resolve(work, `failure-${index}.png`) })
      .catch(() => undefined);
    console.error(
      await page
        .locator('#notice')
        .textContent({ timeout: 500 })
        .catch(() => 'No app notice on this surface.'),
    );
  }
  throw error;
} finally {
  await context?.close();
  await rm(resolve(work, 'profile'), {
    recursive: true,
    force: true,
    maxRetries: 3,
  });
  await new Promise((done) => server.close(done));
}
