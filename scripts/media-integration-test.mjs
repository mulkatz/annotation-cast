import { chromium } from 'playwright';
import { build } from 'esbuild';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// The harness uses synthetic canvas video, a fake microphone, and stubbed HTTP contracts.
// It exercises production storage, adapters, pipeline, and export; it does not establish tab capture or live provider compatibility.
const work = resolve('.local/media-integration');
const extension = resolve(work, 'extension');
await mkdir(work, { recursive: true });
await cp('dist', extension, { recursive: true });
await writeFile(
  resolve(extension, 'media-test.html'),
  '<!doctype html><html><head><title>Synthetic media integration</title></head><body><h1>Synthetic canvas media integration</h1><script src="media-test.js"></script></body></html>',
);
const harness = String.raw`
import { BlobReader, BlobWriter, TextWriter, ZipReader } from '@zip.js/zip.js';
import { MODELS, SessionSchema } from './src/core/schema';
import { addEvent, closeMedia, getMedia, getSession, saveSession, writeMedia } from './src/core/store';
import { processSession } from './src/core/pipeline';
import { exportZip } from './src/core/export';
import { appendFailure, failureDetail, OperationError } from './src/core/failures';

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function decode(blob: Blob, audio: boolean) {
  const element = document.createElement(audio ? 'audio' : 'video');
  const url = URL.createObjectURL(blob);
  element.muted = true;
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic recorded media decode timed out.')), 10_000);
    element.onloadeddata = () => { clearTimeout(timer); resolve(); };
    element.onerror = () => { clearTimeout(timer); reject(new Error('Synthetic recorded media could not be decoded.')); };
  });
  element.src = url;
  try { await ready; require(element.readyState >= 2, 'Recorded media must have decodable data.'); }
  finally { URL.revokeObjectURL(url); }
}
async function run() {
  const key = 'synthetic-provider-key';
  const hidden = 'synthetic-sensitive-value';
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 360; document.body.append(canvas);
  const context = canvas.getContext('2d'); require(context, 'Canvas is unavailable.');
  let tick = 0;
  const draw = () => { context.fillStyle = tick++ % 2 ? '#f2f4f7' : '#ffffff'; context.fillRect(0,0,640,360); context.fillStyle = '#175cd3'; context.fillRect(100,100,220,70); context.fillStyle = '#ffffff'; context.font = '24px sans-serif'; context.fillText('Clipped button',115,145); };
  draw(); const framesTimer = setInterval(draw, 100);
  const microphone = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const video = canvas.captureStream(10);
  const combined = new MediaStream([...video.getVideoTracks(), ...microphone.getAudioTracks()]);
  const id = 'synthetic-browser-session'; const recordingPath = id + '/recording.webm';
  const videoRecorder = new MediaRecorder(combined, { mimeType: 'video/webm;codecs=vp8,opus' });
  const audioRecorder = new MediaRecorder(microphone, { mimeType: 'audio/webm;codecs=opus' });
  let writes = Promise.resolve(); let chunkCount = 0; const audioChunks: Blob[] = [];
  videoRecorder.ondataavailable = (event) => { if (event.data.size) { chunkCount++; writes = writes.then(() => writeMedia(recordingPath, event.data, true)); } };
  audioRecorder.ondataavailable = (event) => { if (event.data.size) audioChunks.push(event.data); };
  const stoppedVideo = new Promise<void>((resolve) => { videoRecorder.onstop = () => resolve(); });
  const stoppedAudio = new Promise<void>((resolve) => { audioRecorder.onstop = () => resolve(); });
  const started = performance.now(); const created = Date.now();
  videoRecorder.start(500); audioRecorder.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Canvas frame encoding failed.')), 'image/jpeg'));
  const frameTime = performance.now() - started;
  await writeMedia(id + '/screenshots/frame-1.jpg', image);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  videoRecorder.stop(); audioRecorder.stop();
  await Promise.all([stoppedVideo, stoppedAudio]); await writes; await closeMedia(recordingPath);
  const duration = performance.now() - started;
  clearInterval(framesTimer); combined.getTracks().forEach((track) => track.stop());
  const audioPath = id + '/audio/audio-1.webm';
  await writeMedia(audioPath, new Blob(audioChunks, { type: 'audio/webm' }));
  const session = SessionSchema.parse({ schemaVersion:1, id, createdAt:created, tabId:1, url:'https://example.test/?state=synthetic-query-value#synthetic-fragment', notes:{project:'Synthetic project',objective:'Inspect clipping',environment:'Synthetic browser test',reference:'synthetic-build'}, status:'stopped', startedAt:created, duration, diagnostics:false, models:MODELS, audio:[{id:'audio-1',path:audioPath,start:0,end:duration}], transcript:[], frames:[{id:'frame-1',time:frameTime,path:'screenshots/frame-1.jpg',eventIds:['marker-1']}], findings:[], completedSegments:[],completedBatches:[],error:'',recordingPath,sanitization:{} });
  await saveSession(session);
  await addEvent({id:'marker-1',sessionId:id,time:frameTime,type:'point',url:session.url,data:{x:150,y:120,selection:'password=' + hidden}});
  const recording = await getMedia(recordingPath); const audio = await getMedia(audioPath);
  await decode(recording, false); await decode(audio, true);
  const calls = { transcription:0, analysis:0 }; const transfers: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const payload = JSON.parse(String(options?.body));
    if (url === 'https://openrouter.ai/api/v1/audio/transcriptions') {
      calls.transcription++; require(payload.response_format === 'verbose_json' && payload.input_audio.format === 'webm', 'Transcription must submit the official verbose WebM contract.');
      require(typeof payload.input_audio.data === 'string' && payload.input_audio.data.length > 0, 'Transcription must include actual recorded audio.');
      return Response.json({ text:'The blue button clips.', segments:[{start:0.4,end:1.4,text:'The blue button clips. password=' + hidden + ' ' + key}] });
    }
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      calls.analysis++; const body = JSON.stringify(payload); transfers.push(body);
      require(!body.includes(key) && !body.includes(hidden) && !body.includes('synthetic-query-value') && !body.includes('synthetic-fragment'), 'Detected text must be sanitized before analysis transfer.');
      const evidence = JSON.parse(payload.messages[1].content[0].text);
      require(payload.messages[1].content.some((part: {type:string}) => part.type === 'image_url'), 'Analysis must include the actual recorded frame.');
      const issue = { id:'issue-1',title:'Button clips',description:'Narrated clipping. ' + key,start:400,end:1400,page:evidence.events[0].url,evidenceIds:['marker-1'],quoteIds:[evidence.transcript[0].id],hypotheses:[],expectedBehavior:null,reproduction:[],association:'supported' };
      return Response.json({choices:[{message:{content:JSON.stringify({findings:[issue]})}}]});
    }
    throw new Error('All unrecognized network requests are blocked in the media harness.');
  };
  const progress: string[] = [];
  const completed = await processSession(id,key,new AbortController().signal,(message) => progress.push(message));
  require(completed.status === 'complete' && completed.findings.length === 1, 'Actual pipeline must finish one evidence-backed finding.');
  await processSession(id,key,new AbortController().signal,() => undefined);
  require(calls.transcription === 1 && calls.analysis === 1, 'Completed checkpoints must prevent duplicate provider requests.');
  const retryExport = await getSession(id);
  appendFailure(retryExport,failureDetail(new OperationError('storage-full','Synthetic export preparation failure.'),'export'));
  await saveSession(retryExport);
  const zip = await exportZip(await getSession(id),key,(message) => progress.push(message));
  require((await getSession(id)).error === '' && (await getSession(id)).failures?.length === 1, 'Successful export clears current export failure and retains history.');
  const reader = new ZipReader(new BlobReader(zip), { useWebWorkers:false });
  const entries = await reader.getEntries(); const names = entries.map((entry) => entry.filename);
  for (const name of ['README.md','recording.webm','report.md','issues.json','transcript.json','events.json','session.json','screenshots/frame-1.jpg']) require(names.includes(name), 'ZIP missing required file: ' + name);
  const textFiles: Record<string,string> = {};
  for (const entry of entries) {
    require(!entry.filename.startsWith('/') && !entry.filename.includes('..'), 'ZIP paths must stay relative.');
    if ('getData' in entry && entry.getData && /\.(json|md)$/.test(entry.filename)) {
      const text = await entry.getData(new TextWriter());
      require(!text.includes(key) && !text.includes(hidden) && !text.includes('synthetic-query-value') && !text.includes('synthetic-fragment'), 'ZIP text must be sanitized.');
      textFiles[entry.filename] = text;
    }
  }
  require(textFiles['report.md'].includes('![frame-1 at ') && textFiles['report.md'].includes('Temporal candidate'), 'Marker-only findings must have labeled contextual images in the consolidated report.');
  require(JSON.parse(textFiles['issues.json']).frameAssociations[0].frames[0].provenance === 'marker-context', 'Machine-readable associations must preserve candidate provenance.');
  const exportedRecording = entries.find((entry) => entry.filename === 'recording.webm');
  require(exportedRecording && 'getData' in exportedRecording && exportedRecording.getData, 'Exported recording must be readable.');
  const exportedVideo = await exportedRecording.getData(new BlobWriter('video/webm'));
  require(exportedVideo.size === recording.size, 'ZIP recording must preserve actual media bytes.');
  await decode(exportedVideo, false);
  const issues = JSON.parse(textFiles['issues.json']).issues;
  const transcript = JSON.parse(textFiles['transcript.json']).segments;
  const metadata = JSON.parse(textFiles['session.json']);
  require(issues[0].quoteIds.every((quoteId: string) => transcript.some((quote: {id:string}) => quote.id === quoteId)), 'Exported quote references must resolve.');
  require(issues[0].evidenceIds.every((evidenceId: string) => evidenceId === 'marker-1' || metadata.frames.some((frame: {id:string,path:string}) => frame.id === evidenceId && names.includes(frame.path))), 'Exported evidence references must resolve.');
  require(metadata.recordingPath === 'recording.webm' && metadata.processing.reviewed === false, 'ZIP metadata must use relative media references and unreviewed status.');
  await reader.close();
  return { browserMedia:'synthetic canvas and fake microphone', duration:Math.round(duration), chunkCount, recordingBytes:recording.size, audioBytes:audio.size, zipBytes:zip.size, calls, files:names, progressSteps:progress.length, transfers:transfers.length };
}
Object.assign(globalThis, {
  runMediaIntegration:run,
  prepareUiRetry:async () => {
    const session = await getSession('synthetic-browser-session');
    await saveSession({ ...session,status:'stopped',transcript:[],findings:[],completedSegments:[],completedBatches:[],failures:[],error:'' });
    await chrome.storage.local.set({settings:{key:'synthetic-provider-key',diagnostics:false}});
  },
  inspectUiRetry:() => getSession('synthetic-browser-session'),
});
`;
await build({
  stdin: {
    contents: harness,
    resolveDir: process.cwd(),
    sourcefile: 'media-integration-harness.ts',
    loader: 'ts',
  },
  outfile: resolve(extension, 'media-test.js'),
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  legalComments: 'none',
});
const profile = await mkdtemp(resolve(work, 'profile-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${resolve('public/readiness.wav')}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  let escapedProviderRequests = 0;
  await context.route('https://openrouter.ai/**', (route) => {
    escapedProviderRequests++;
    return route.abort();
  });
  await context.grantPermissions(['microphone']);
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const mediaPage = await context.newPage();
  await mediaPage.goto(`chrome-extension://${id}/media-test.html`);
  const result = await mediaPage.evaluate(() =>
    Promise.race([
      globalThis.runMediaIntegration(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Media integration exceeded 45 seconds.')),
          45_000,
        ),
      ),
    ]),
  );
  assert.equal(result.calls.transcription, 1);
  assert.equal(result.calls.analysis, 1);
  let page = await context.newPage();
  await page.goto(`chrome-extension://${id}/app.html`);
  await page
    .locator('#results h3')
    .filter({ hasText: 'Button clips' })
    .waitFor();
  await page.locator('#results img').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => document.querySelector('#results img')?.naturalWidth > 0,
  );
  assert.equal(await page.locator('#export').isEnabled(), true);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text) => {
        globalThis.diagnosticSummary = text;
      },
    });
  });
  await page.locator('#session-details summary').click();
  await page.locator('#copy-diagnostics').click();
  await page.waitForFunction(
    () => typeof globalThis.diagnosticSummary === 'string',
  );
  const diagnosticSummary = await page.evaluate(
    () => globalThis.diagnosticSummary,
  );
  assert.ok(
    !diagnosticSummary.includes('https://') &&
      !diagnosticSummary.includes('Narrated clipping') &&
      !diagnosticSummary.includes('Synthetic export preparation failure'),
  );
  assert.equal(JSON.parse(diagnosticSummary).failures[0].code, 'storage-full');

  await page.screenshot({ path: resolve(work, 'results.png'), fullPage: true });
  await page.setViewportSize({ width: 600, height: 900 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: resolve(work, 'results-compact.png'),
    fullPage: true,
  });
  await mediaPage.evaluate(() => globalThis.prepareUiRetry());
  const uiCalls = { transcription: 0, analysis: 0 };
  // The fetch stub runs in the production controls realm, including after reopening.
  // Every other provider request is blocked by the context route above.
  const openRetryControls = async () => {
    const controls = await context.newPage();
    await controls.exposeFunction('recordSyntheticProviderCall', (kind) => {
      assert.ok(kind === 'transcription' || kind === 'analysis');
      uiCalls[kind]++;
    });
    await controls.addInitScript(() => {
      const original = globalThis.fetch;
      globalThis.syntheticAnalysisRecovery = false;
      globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === 'https://openrouter.ai/api/v1/audio/transcriptions') {
          await globalThis.recordSyntheticProviderCall('transcription');
          return Response.json({
            text: 'The blue button clips.',
            segments: [
              { start: 0.4, end: 1.4, text: 'The blue button clips.' },
            ],
          });
        }
        if (url === 'https://openrouter.ai/api/v1/chat/completions') {
          await globalThis.recordSyntheticProviderCall('analysis');
          if (!globalThis.syntheticAnalysisRecovery)
            return Response.json(
              { error: { message: 'synthetic private provider body' } },
              { status: 402 },
            );
          const payload = JSON.parse(String(init?.body));
          const evidence = JSON.parse(payload.messages[1].content[0].text);
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    findings: [
                      {
                        id: 'issue-1',
                        title: 'Button clips',
                        description: 'Narrated clipping.',
                        start: 400,
                        end: 1400,
                        page: evidence.events[0].url,
                        evidenceIds: ['marker-1'],
                        quoteIds: [evidence.transcript[0].id],
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
          });
        }
        return original(input, init);
      };
    });
    await controls.goto(`chrome-extension://${id}/app.html`);
    await controls
      .locator('#sessions')
      .selectOption('synthetic-browser-session');
    return controls;
  };
  await page.close();
  page = await openRetryControls();
  assert.equal(await page.locator('#analyze').textContent(), 'Start analysis');
  await page.locator('#analyze').click();
  const assertVisibleFailure = async (count) => {
    await page
      .locator('#session-error')
      .filter({ hasText: 'Add provider credit before retrying.' })
      .waitFor();
    await page.waitForFunction(
      (expected) =>
        document.querySelectorAll('#failure-history li').length === expected &&
        !document.querySelector('#analyze').disabled,
      count,
    );
    assert.equal(await page.locator('#session-error').isVisible(), true);
    assert.match(
      await page.locator('#session-summary').textContent(),
      /1\/1 audio segments transcribed.*0\/1 evidence batches analyzed.*1 frames retained/,
    );
    assert.equal(
      await page
        .locator('#session-details')
        .evaluate((details) => details.open),
      true,
    );
    const stored = await mediaPage.evaluate(() => globalThis.inspectUiRetry());
    assert.equal(stored.status, 'failed');
    assert.deepEqual(stored.completedSegments, ['audio-1']);
    assert.deepEqual(stored.completedBatches, []);
    assert.equal(stored.transcript.length, 1);
    assert.equal(stored.failures.length, count);
    assert.ok(
      stored.failures.every(
        (failure) =>
          failure.phase === 'analysis' &&
          failure.code === 'provider-credit' &&
          failure.httpStatus === 402 &&
          failure.stepId === 'batch-0',
      ),
    );
    assert.ok(
      !(await page.locator('body').textContent()).includes(
        'synthetic private provider body',
      ),
    );
  };
  await assertVisibleFailure(1);
  assert.deepEqual(uiCalls, { transcription: 1, analysis: 1 });
  await page.close();
  page = await openRetryControls();
  await assertVisibleFailure(1);
  assert.equal(
    await page.locator('#analyze').textContent(),
    'Retry incomplete steps',
  );
  await page.locator('#analyze').click();
  await assertVisibleFailure(2);
  assert.deepEqual(uiCalls, { transcription: 1, analysis: 2 });
  await page.evaluate(() => {
    globalThis.syntheticAnalysisRecovery = true;
  });
  await page.locator('#analyze').click();
  await page
    .locator('#results h3')
    .filter({ hasText: 'Button clips' })
    .waitFor();
  await page.waitForFunction(() => !document.querySelector('#export').disabled);
  const recovered = await mediaPage.evaluate(() => globalThis.inspectUiRetry());
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.error, '');
  assert.deepEqual(recovered.completedSegments, ['audio-1']);
  assert.deepEqual(recovered.completedBatches, ['batch-0']);
  assert.equal(recovered.failures.length, 2);
  assert.equal(await page.locator('#session-error').isVisible(), false);
  assert.deepEqual(uiCalls, { transcription: 1, analysis: 3 });
  assert.equal(escapedProviderRequests, 0);
  result.uiFailureRecovery = {
    visibleFailures: 2,
    retainedFailureHistory: recovered.failures.length,
    calls: uiCalls,
  };
  console.log(JSON.stringify(result, null, 2));
  console.log(
    'Verified real synthetic browser media, production OPFS storage worker, stubbed-provider processing, checkpoint reuse, sanitation, and streamed ZIP integrity. Tab capture and live provider compatibility are not established by this harness.',
  );
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
