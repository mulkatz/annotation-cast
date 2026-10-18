import { z } from 'zod';
import {
  SettingsSchema,
  ShiftTapIntervalSchema,
  send,
  type Session,
  FailureSchema,
  type Failure,
} from './core/schema';
import {
  deleteSession,
  getEvents,
  getSession,
  listSessions,
  mediaHandle,
  getMedia,
  writeMedia,
} from './core/store';
import { acquireMedia } from './core/media';
import { processSession, transferOverview } from './core/pipeline';
import { exportZip } from './core/export';
import { sanitize } from './core/sanitize';
import { checkProvider } from './providers/openrouter';
import { resolveFrameAssociations } from './core/frame-associations';
import { keyFingerprint } from './capture/timeline';
import {
  saveProviderSettings,
  invalidateProviderVerification,
  storeProviderVerification,
  saveMarkerTiming,
  providerVerificationValid,
  ProviderVerificationSchema,
} from './core/provider-readiness';
import { failureDetail, failureAction, OperationError } from './core/failures';

function element<T extends HTMLElement>(
  id: string,
  constructor: { new (...args: never[]): T },
): T {
  const value = document.getElementById(id);
  if (!(value instanceof constructor))
    throw new Error(`Missing interface element: ${id}`);
  return value;
}
const button = (id: string) => element(id, HTMLButtonElement);
const input = (id: string) => element(id, HTMLInputElement);
const keyInput = input('key');
const sessionsSelect = element('sessions', HTMLSelectElement);
let selected: Session | undefined;
let active: Session | undefined;
let targetTabId: number | undefined;
let providerReady = false;
let operationPhase: Failure['phase'] = 'setup';
let checkingRecording = false;
let startingRequestId: string | undefined;
let detailsSignature = '';
let busy = true;
let aborter: AbortController | undefined;
let key = '';
let displayedSession = '';
let refreshInProgress = false;
let sessionOptions = '';
let stopping = false;
const previewUrls = new Map<string, string>();
function notice(message: string, error = false): void {
  const node = element('notice', HTMLDivElement);
  node.textContent = message;
  node.classList.toggle('error', error);
}
function progress(message: string): void {
  element('progress', HTMLParagraphElement).textContent = message;
}
function errorMessage(error: unknown): string {
  return error instanceof Error
    ? sanitize(error.message, [key, keyInput.value]).value
    : 'The operation could not be completed.';
}
async function run(
  task: () => Promise<void>,
  phase: Failure['phase'] = 'setup',
): Promise<void> {
  if (busy) return;
  busy = true;
  const operationStarted = Date.now();
  operationPhase = phase;
  element('operation-error', HTMLDivElement).hidden = true;
  element('capture-error', HTMLDivElement).hidden = true;
  updateButtons();
  try {
    await task();
    await chrome.storage.local.remove('lastOperationFailure');
  } catch (error) {
    let failure = failureDetail(error, operationPhase, undefined, [
      key,
      keyInput.value,
    ]);
    if (selected && operationPhase === 'analysis') {
      const latest = await getSession(selected.id).catch(() => undefined);
      const retained = latest?.failures?.at(-1);
      if (
        retained &&
        retained.occurredAt >= operationStarted &&
        (!(error instanceof OperationError) || retained.code === error.code)
      )
        failure = retained;
    }
    await chrome.storage.local
      .set({ lastOperationFailure: failure })
      .catch(() => undefined);
    showOperationFailure(failure);
    notice(`${failureHeadline(failure)}. See the details below.`, true);
    const feedback = element(
      ['setup', 'capture', 'finalization'].includes(failure.phase)
        ? 'capture-error'
        : 'operation-error',
      HTMLDivElement,
    );
    feedback.scrollIntoView({ block: 'center' });
  } finally {
    busy = false;
    try {
      await refresh();
    } catch (error) {
      notice(errorMessage(error), true);
    } finally {
      updateButtons();
    }
  }
}
function updateButtons(): void {
  const unsavedKey = keyInput.value.trim() !== key;
  button('start').disabled =
    busy || !providerReady || unsavedKey || !targetTabId || !!active;
  button('start').textContent = checkingRecording
    ? 'Checking recording setup…'
    : 'Start recording';
  button('readiness').disabled = busy || !!active;
  button('save-key').disabled = busy || !!active;
  button('save-markers').disabled = busy || !!active;
  input('shift-tap-interval').disabled = busy || !!active;
  keyInput.disabled = busy || !!active;
  button('stop').disabled = !active || stopping;
  button('analyze').disabled =
    busy ||
    !selected ||
    selected.status === 'recording' ||
    selected.status === 'complete' ||
    !!active ||
    !key ||
    unsavedKey ||
    !selected.audio.length ||
    !selected.frames.length ||
    selected.failures?.at(-1)?.retryable === false;
  button('analyze').textContent =
    selected?.status === 'failed' || selected?.status === 'processing'
      ? 'Retry incomplete steps'
      : 'Start analysis';
  button('export').disabled = busy || selected?.status !== 'complete';
  button('copy-diagnostics').disabled = busy || !selected;
  button('delete').disabled =
    busy || !selected || selected.status === 'recording';
  button('cancel').disabled = !aborter;
  const cancel = button('cancel');
  const cancelSlot = element(
    checkingRecording
      ? 'capture-cancel-slot'
      : busy && operationPhase === 'setup' && aborter
        ? 'provider-cancel-slot'
        : 'analysis-actions',
    HTMLDivElement,
  );
  if (cancel.parentElement !== cancelSlot) cancelSlot.append(cancel);
  cancel.textContent = checkingRecording
    ? 'Cancel recording setup'
    : busy && operationPhase === 'setup' && aborter
      ? 'Cancel connection check'
      : 'Cancel';
  button('grant').disabled = busy || !targetTabId;
  if (!providerReady && !active)
    button('start').title = 'Verify the AI connection in New recording first.';
  else button('start').title = '';
  sessionsSelect.disabled = busy || !!active;
  input('diagnostics').disabled = busy || !!active;
}
async function saveKey(): Promise<void> {
  await requireIdleSettings();
  const candidate = keyInput.value.trim();
  if (!candidate) throw new Error('Enter an OpenRouter API key.');
  const settings = SettingsSchema.parse({
    key: candidate,
    diagnostics: input('diagnostics').checked,
    shiftTapIntervalMs: markerInterval(),
  });
  await chrome.storage.local.setAccessLevel({
    accessLevel: 'TRUSTED_CONTEXTS',
  });
  await saveProviderSettings(settings);
  if (candidate !== key) {
    await chrome.storage.session.remove('readiness');
    providerReady = false;
  }
  key = candidate;
  keyInput.value = candidate;
  await refreshProviderStatus();
}
async function refreshProviderStatus(): Promise<void> {
  const { providerVerification: receipt } = await chrome.storage.local.get(
    'providerVerification',
  );
  providerReady =
    !!key && providerVerificationValid(receipt, await keyFingerprint(key));
  const parsed = ProviderVerificationSchema.safeParse(receipt);
  element('provider-status', HTMLParagraphElement).textContent =
    providerReady && parsed.success
      ? `Connection verified ${new Date(parsed.data.checkedAt).toLocaleString()}. Reused for 24 hours; no API check for each recording.`
      : 'Verify the AI connection. A successful check is reused for 24 hours; sample requests may incur a small API charge.';
  document
    .querySelector('.connection-status')
    ?.classList.toggle('verified', providerReady);
  button('readiness').textContent = providerReady
    ? 'Recheck connection · API charges'
    : 'Verify connection · API charges';
  element('key-state', HTMLParagraphElement).textContent =
    keyInput.value.trim() !== key
      ? 'Unsaved key change. Save it before recording or retrying analysis.'
      : key
        ? 'Key saved on this device.'
        : 'Your key stays in this extension.';
}
function showOperationFailure(failure: Failure): void {
  const node = element(
    ['setup', 'capture', 'finalization'].includes(failure.phase)
      ? 'capture-error'
      : 'operation-error',
    HTMLDivElement,
  );
  node.hidden = false;
  node.textContent = `${failureHeadline(failure)}. ${failure.message} ${failureAction(failure)}`;
}
function failureHeadline(failure: Failure): string {
  return {
    setup: 'Recording setup did not complete',
    capture: 'Recording was interrupted',
    finalization: 'Recording could not be finalized',
    transcription: 'Transcription paused',
    analysis: 'Analysis paused',
    validation: 'Session could not be prepared',
    export: 'ZIP export did not complete',
  }[failure.phase];
}
function markerInterval(): number {
  const value = ShiftTapIntervalSchema.safeParse(
    input('shift-tap-interval').valueAsNumber,
  );
  if (!value.success)
    throw new Error(
      'Set the maximum tap interval to a whole number from 100 to 350 ms.',
    );
  return value.data;
}
async function saveMarkerSettings(): Promise<void> {
  await requireIdleSettings();
  const interval = markerInterval();
  await saveMarkerTiming(interval);
}
async function requireIdleSettings(): Promise<void> {
  if ((await chrome.storage.session.get('activeSession')).activeSession)
    throw new Error('Stop recording before changing setup or marker timing.');
}
async function checkMicrophone(signal: AbortSignal): Promise<void> {
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  try {
    stream = await acquireMedia(
      {
        audio: true,
        video: false,
      },
      signal,
    );
    context = new AudioContext();
    await context.resume();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let peak = 0;
    element('mic-status', HTMLSpanElement).textContent = 'Speak now…';
    notice('Speak into your microphone while its level is checked.');
    const until = performance.now() + 3500;
    while (performance.now() < until) {
      signal.throwIfAborted();
      analyser.getFloatTimeDomainData(data);
      const level = Math.sqrt(
        data.reduce((sum, sample) => sum + sample * sample, 0) / data.length,
      );
      peak = Math.max(peak, level);
      element('mic-level', HTMLMeterElement).value = Math.min(1, level * 8);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    if (peak < 0.003)
      throw new Error(
        'Microphone signal was too quiet. Check your input device, speak, and run readiness again.',
      );
    element('mic-status', HTMLSpanElement).textContent = 'Signal detected';
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    await context?.close();
  }
}
function passed(index: number): void {
  const check = document.querySelectorAll('#checks li')[index];
  check?.classList.add('passed');
  if (check instanceof HTMLElement) check.dataset.state = 'Passed';
  if (check)
    check.setAttribute('aria-label', `${check.textContent?.trim()}: passed`);
}
async function readiness(): Promise<void> {
  operationPhase = 'setup';
  const controller = new AbortController();
  aborter = controller;
  updateButtons();
  try {
    await saveKey();
    const testedFingerprint = await keyFingerprint(key);
    await invalidateProviderVerification(testedFingerprint);
    providerReady = false;
    await refreshProviderStatus();
    notice(
      'Verifying timestamped transcription and image analysis using bundled samples…',
    );
    await checkProvider(key, controller.signal);
    controller.signal.throwIfAborted();
    if (!(await storeProviderVerification(testedFingerprint)))
      throw new OperationError(
        'settings-changed',
        'The API key changed in another control page. Reopen AI connection before verifying again.',
      );
    await refreshProviderStatus();
    element('connection-settings', HTMLDetailsElement).open = false;
    notice(
      'AI connection verified. Start recording will check your microphone, tab, and storage automatically.',
    );
  } finally {
    aborter = undefined;
    await refreshProviderStatus();
  }
}
async function checkRecordingSetup(signal: AbortSignal): Promise<void> {
  await chrome.storage.session.remove('readiness');
  if (!providerReady)
    throw new Error('Verify the AI connection before recording.');
  if (keyInput.value.trim() !== key)
    throw new Error('Save the changed key before recording.');
  for (const node of document.querySelectorAll('#checks li')) {
    node.classList.remove('passed');
    node.classList.remove('failed');
    if (node instanceof HTMLElement) node.dataset.state = 'Waiting';
    node.setAttribute('aria-label', `${node.textContent?.trim()}: not checked`);
  }
  if (!targetTabId)
    throw new Error(
      'Select the web app with the Annotation Cast toolbar button first.',
    );
  if (
    input('diagnostics').checked &&
    !(await chrome.permissions.request({ permissions: ['debugger'] }))
  )
    throw new Error(
      'Diagnostics permission was declined. Disable diagnostics or allow access.',
    );
  signal.throwIfAborted();
  notice('Checking microphone, selected tab, and local storage…');
  element('recording-checks', HTMLDetailsElement).open = true;
  try {
    await checkMicrophone(signal);
    passed(0);
    signal.throwIfAborted();
    await send({ target: 'background', type: 'check-tab' });
    if (input('diagnostics').checked)
      await send({ target: 'background', type: 'check-diagnostics' });
    passed(1);
    const estimate = await navigator.storage.estimate();
    if ((estimate.quota ?? 0) - (estimate.usage ?? 0) < 1.5 * 1024 ** 3)
      throw new Error(
        'At least 1.5 GB of free extension storage is required. Free space before recording.',
      );
    await navigator.storage.persist();
    signal.throwIfAborted();
    const probeDirectory = `readiness-${crypto.randomUUID()}`;
    const probePath = `${probeDirectory}/check.txt`;
    try {
      await writeMedia(probePath, new Blob(['synthetic readiness']));
      const handle = await mediaHandle(probePath);
      if ((await (await handle.getFile()).text()) !== 'synthetic readiness')
        throw new Error('Local storage write verification failed.');
    } finally {
      await (
        await navigator.storage.getDirectory()
      )
        .removeEntry(probeDirectory, { recursive: true })
        .catch(() => undefined);
    }
    passed(2);
    signal.throwIfAborted();
    await chrome.storage.session.set({
      readiness: {
        checkedAt: Date.now(),
        tabId: targetTabId,
        keyFingerprint: await keyFingerprint(key),
      },
    });
  } catch (error) {
    const check = [...document.querySelectorAll('#checks li')].find(
      (node) => !node.classList.contains('passed'),
    );
    if (check) {
      check.classList.add('failed');
      if (check instanceof HTMLElement)
        check.dataset.state = signal.aborted ? 'Canceled' : 'Failed';
      check.setAttribute(
        'aria-label',
        `${check.textContent?.trim()}: ${signal.aborted ? 'canceled' : 'failed'}`,
      );
    }
    throw error;
  }
}
async function refresh(): Promise<void> {
  if (refreshInProgress) return;
  refreshInProgress = true;
  try {
    const previousActive = active?.id;
    const sessions = await listSessions();
    const runtimeState = await chrome.storage.session.get('activeSession');
    const runtimeActive = z
      .object({ id: z.string(), tabId: z.number() })
      .safeParse(runtimeState.activeSession);
    active = runtimeActive.success
      ? sessions.find((session) => session.id === runtimeActive.data.id)
      : undefined;
    // Storage can stay readable after a quota failure prevents final status writes.
    // A stale durable recording must remain deletable once the runtime has released it.
    for (const session of sessions)
      if (session.status === 'recording' && session.id !== active?.id) {
        session.status = 'interrupted';
        session.error =
          'Capture is no longer active. Retained evidence may be incomplete; retry analysis if usable or delete this session.';
      }
    const prior =
      active && active.id !== previousActive
        ? active.id
        : sessionsSelect.value || selected?.id;
    const options = sessions.map((session) => ({
      id: session.id,
      label: `${new Date(session.createdAt).toLocaleString()} · ${session.notes.project || 'Untitled'} · ${session.status}`,
    }));
    const signature = JSON.stringify(options);
    if (signature !== sessionOptions) {
      sessionsSelect.replaceChildren();
      if (!options.length)
        sessionsSelect.add(new Option('No sessions yet', ''));
      for (const option of options)
        sessionsSelect.add(new Option(option.label, option.id));
      sessionOptions = signature;
    }
    if (prior && sessions.some((session) => session.id === prior))
      sessionsSelect.value = prior;
    selected = sessions.find((session) => session.id === sessionsSelect.value);
    if (active) targetTabId = active.tabId;
    if (targetTabId) {
      const tab = await chrome.tabs.get(targetTabId).catch(() => undefined);
      element('target', HTMLParagraphElement).textContent = tab
        ? `Selected tab: ${sanitize(tab.url ?? tab.title ?? 'Web app', [key]).value}`
        : 'Selected tab is closed. Select another using the toolbar.';
    }
    const recordingState = element('record-state', HTMLSpanElement);
    recordingState.textContent = active ? 'RECORDING' : 'IDLE';
    recordingState.classList.toggle('live', !!active);
    const duration = active
      ? Math.max(0, Date.now() - active.startedAt)
      : (selected?.duration ?? 0);
    element('timer', HTMLDivElement).textContent = `${Math.floor(
      duration / 60000,
    )
      .toString()
      .padStart(2, '0')}:${Math.floor((duration / 1000) % 60)
      .toString()
      .padStart(2, '0')}`;
    if (active) {
      const state = await chrome.storage.session.get([
        'captureStatus',
        'diagnosticsStatus',
        'contextStatus',
      ]);
      const capture = z
        .object({ microphone: z.string(), recording: z.string() })
        .safeParse(state.captureStatus);
      const diagnostics =
        typeof state.diagnosticsStatus === 'string'
          ? state.diagnosticsStatus
          : 'unknown';
      const context =
        typeof state.contextStatus === 'string'
          ? state.contextStatus
          : 'unknown';
      element('capture-status', HTMLParagraphElement).textContent =
        `Video: ${capture.success ? capture.data.recording : 'unknown'} · Microphone: ${capture.success ? capture.data.microphone : 'unknown'} · Diagnostics: ${diagnostics} · Page context: ${context}`;
    } else {
      const usable =
        selected && selected.audio.length > 0 && selected.frames.length > 0;
      const partial =
        selected?.failures?.some((failure) =>
          ['setup', 'capture', 'finalization'].includes(failure.phase),
        ) || selected?.status === 'interrupted';
      element('capture-status', HTMLParagraphElement).textContent = selected
        ? usable
          ? `${partial ? 'Partial recording retained' : 'Recording saved locally'}. ${selected.status === 'failed' || selected.status === 'processing' ? 'Processing is incomplete; see Analyze & export.' : 'Ready for review in Analyze & export.'}`
          : 'No usable recording was saved. See the session details below.'
        : 'Recording continues when this control page is closed.';
      recordingState.textContent = usable
        ? partial
          ? 'PARTIAL'
          : 'SAVED'
        : 'IDLE';
    }
    if (!selected) {
      clearResults();
      element('transfer', HTMLDivElement).textContent =
        'Stop a recording to review its transfer overview.';
    } else if (!active && !busy) {
      const overview = transferOverview(
        selected,
        await getEvents(selected.id),
        key,
      );
      const matches = Object.values(overview.counts).reduce(
        (sum, count) => sum + count,
        0,
      );
      element('transfer', HTMLDivElement).textContent =
        `Provider: OpenRouter → Whisper Large v3 + Gemini 2.5 Flash\nPlanned transfers: ${overview.audioSegments} independent audio segments; up to 12 selected images per 2-minute analysis batch; sanitized transcript and limited page/diagnostic context.\nDetected text matches removed: ${matches}. ${Object.entries(
          overview.counts,
        )
          .map(([kind, count]) => `${kind}: ${count}`)
          .join(
            ' · ',
          )}\nThe returned transcript is checked again before analysis. Sanitized session notes are sent as analysis context and included in the export. Image/audio content is not automatically checked for secrets.`;
      if (
        selected.id !== displayedSession ||
        (selected.status === 'complete' &&
          !element('results', HTMLDivElement).childElementCount)
      )
        await renderResults(selected);
    }
    renderSessionDetails();
    updateButtons();
  } finally {
    refreshInProgress = false;
  }
}
function renderSessionDetails(): void {
  const signature = JSON.stringify(selected);
  if (signature === detailsSignature) return;
  detailsSignature = signature ?? '';
  const panel = element('session-error', HTMLDivElement);
  const summary = element('session-summary', HTMLParagraphElement);
  const history = element('failure-history', HTMLOListElement);
  history.replaceChildren();
  panel.hidden = true;
  if (!selected) {
    summary.textContent = 'Choose a session to inspect its processing status.';
    return;
  }
  const failures = sanitize(selected.failures ?? [], [key]).value;
  const last = failures.at(-1);
  const state = `${selected.completedSegments.length}/${selected.audio.length} audio segments transcribed · ${selected.completedBatches.length}/${Math.max(1, Math.ceil(selected.duration / 120000))} evidence batches analyzed · ${selected.frames.length} frames retained.`;
  summary.textContent = `Session ${selected.id} · ${selected.status}. ${state}`;
  const missingMedia =
    selected.status !== 'recording' &&
    (!selected.audio.length || !selected.frames.length);
  if (
    selected.error ||
    selected.status === 'failed' ||
    selected.status === 'interrupted' ||
    missingMedia
  ) {
    panel.hidden = false;
    panel.textContent = missingMedia
      ? 'No usable audio or video evidence was saved. Analysis cannot recover missing media. Keep the retained session for diagnosis and start a new recording.'
      : `${last ? `${failureHeadline(last)}. ` : ''}${sanitize(selected.error || 'The session did not complete. Inspect its details below.', [key]).value} ${last ? failureAction(last) : 'Retained evidence remains local. Inspect the saved media and processing status below.'}`;
    element('session-details', HTMLDetailsElement).open = true;
  }
  for (const failure of failures.slice().reverse()) {
    const item = document.createElement('li');
    item.textContent = `${new Date(failure.occurredAt).toLocaleString()} · ${failure.phase}${failure.stepId ? ` / ${failure.stepId}` : ''} · ${failure.code}${failure.httpStatus ? ` / HTTP ${failure.httpStatus}` : ''}: ${failure.message} ${failureAction(failure)}`;
    history.append(item);
  }
  if (!failures.length && selected.error) {
    const item = document.createElement('li');
    item.textContent =
      'This older session has no detailed failure history. Its retained error is shown above.';
    history.append(item);
  }
}
function clearResults(): void {
  displayedSession = '';
  element('results', HTMLDivElement).replaceChildren();
  for (const url of previewUrls.values()) URL.revokeObjectURL(url);
  previewUrls.clear();
}
async function renderResults(session: Session): Promise<void> {
  clearResults();
  displayedSession = session.id;
  const results = element('results', HTMLDivElement);
  if (session.status !== 'complete') return;
  const events = sanitize(await getEvents(session.id), [key]).value;
  if (!session.findings.length) {
    const p = document.createElement('p');
    p.textContent =
      'No findings generated. This does not establish that the app has no issues.';
    results.append(p);
  }
  for (const issue of sanitize(session.findings, [key]).value) {
    const article = document.createElement('article');
    const title = document.createElement('h3');
    title.textContent = `${issue.id} · ${issue.title}`;
    const description = document.createElement('p');
    description.textContent = issue.description;
    const meta = document.createElement('p');
    meta.className = 'muted';
    meta.textContent = `${Math.round(issue.start / 1000)}–${Math.round(issue.end / 1000)} s · ${issue.association} · Automatically generated, unreviewed`;
    article.append(title, description, meta);
    for (const quoteId of issue.quoteIds) {
      const quote = session.transcript.find((item) => item.id === quoteId);
      if (quote) {
        const p = document.createElement('p');
        p.textContent = `Source statement: “${quote.text}”`;
        article.append(p);
      }
    }
    for (const hypothesis of issue.hypotheses) {
      const p = document.createElement('p');
      p.textContent = `AI hypothesis (unverified): ${hypothesis}`;
      article.append(p);
    }
    if (issue.page) {
      const p = document.createElement('p');
      p.textContent = `Page: ${issue.page}`;
      article.append(p);
    }
    if (issue.expectedBehavior) {
      const p = document.createElement('p');
      p.textContent = `Expected behavior: ${issue.expectedBehavior}`;
      article.append(p);
    }
    if (issue.reproduction.length) {
      const list = document.createElement('ol');
      for (const step of issue.reproduction) {
        const item = document.createElement('li');
        item.textContent = step;
        list.append(item);
      }
      article.append(list);
    }
    const imageEvidence = resolveFrameAssociations(
      issue,
      session.frames,
      events,
    );
    for (const { frame, provenance } of imageEvidence.slice(0, 6)) {
      let url = previewUrls.get(frame.id);
      if (!url) {
        url = URL.createObjectURL(
          await getMedia(`${session.id}/${frame.path}`),
        );
        previewUrls.set(frame.id, url);
      }
      const image = document.createElement('img');
      image.alt = `${frame.id} at ${frame.time} ms`;
      image.loading = 'lazy';
      image.src = url;
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.append(image);
      const figure = document.createElement('figure');
      const caption = document.createElement('figcaption');
      caption.className = 'muted';
      caption.textContent = `${frame.id} · ${(frame.time / 1000).toFixed(2)} s · ${provenance === 'model-cited' ? 'Model-cited image' : 'Automatically selected temporal candidate; visual support unconfirmed'}`;
      figure.append(link, caption);
      article.append(figure);
    }
    const evidence = document.createElement('p');
    evidence.className = 'muted';
    evidence.textContent = `Cited evidence: ${issue.evidenceIds.join(', ') || 'No visual or event association'}. The ZIP report gathers statements, marker details, and relevant images. Temporal candidates are separate from model citations.`;
    article.append(evidence);
    results.append(article);
  }
}
button('save-key').onclick = () =>
  void run(async () => {
    await saveKey();
    notice(
      providerReady
        ? 'Key saved. The verified connection is still valid.'
        : 'Key saved. Verify the AI connection once before recording.',
    );
  });
button('save-markers').onclick = () =>
  void run(async () => {
    await saveMarkerSettings();
    notice('Marker timing saved for the next recording.');
  });
keyInput.oninput = () => {
  element('key-state', HTMLParagraphElement).textContent =
    keyInput.value.trim() !== key
      ? 'Unsaved key change. Save it before recording or retrying analysis.'
      : 'Key saved on this device.';
  updateButtons();
};
input('diagnostics').onchange = updateButtons;
button('readiness').onclick = () => void run(readiness);
button('start').onclick = () =>
  void run(async () => {
    operationPhase = 'setup';
    checkingRecording = true;
    startingRequestId = crypto.randomUUID();
    aborter = new AbortController();
    updateButtons();
    try {
      await checkRecordingSetup(aborter.signal);
      aborter.signal.throwIfAborted();
      await send({
        target: 'background',
        type: 'start',
        requestId: startingRequestId,
        notes: {
          project: input('project').value,
          objective: element('objective', HTMLTextAreaElement).value,
          environment: input('environment').value,
          reference: input('reference').value,
        },
        diagnostics: input('diagnostics').checked,
      });
      element('recording-checks', HTMLDetailsElement).open = false;
      notice(
        'Recording. Return to your selected tab to narrate and mark observations.',
      );
    } finally {
      checkingRecording = false;
      startingRequestId = undefined;
      aborter = undefined;
    }
  });
button('stop').onclick = () => {
  if (stopping) return;
  stopping = true;
  updateButtons();
  void (async () => {
    try {
      await send({ target: 'background', type: 'stop' });
      notice(
        'Recording saved locally. Review the transfer overview before starting analysis.',
      );
    } catch (error) {
      notice(errorMessage(error), true);
    } finally {
      stopping = false;
      try {
        await refresh();
      } catch (error) {
        notice(errorMessage(error), true);
      }
      updateButtons();
    }
  })();
};
button('grant').onclick = () =>
  void run(async () => {
    if (!targetTabId) throw new Error('No target tab selected.');
    const tab = await chrome.tabs.get(targetTabId);
    if (!tab.url)
      throw new Error(
        'Return to the recorded tab and click Annotation Cast in the toolbar to restore page access.',
      );
    const url = new URL(tab.url);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error(
        'Only ordinary HTTP and HTTPS pages support page context.',
      );
    if (!(await chrome.permissions.request({ origins: [`${url.origin}/*`] })))
      throw new Error(
        'Page access was declined. Video continues with a context gap.',
      );
    await send({ target: 'background', type: 'grant-context' });
    notice('Page access restored for this origin.');
  });
button('analyze').onclick = () =>
  void run(async () => {
    if (!selected) return;
    operationPhase = 'analysis';
    notice('Analyzing the saved session. Completed steps will be reused.');
    aborter = new AbortController();
    updateButtons();
    try {
      selected = await processSession(
        selected.id,
        key,
        aborter.signal,
        progress,
      );
      displayedSession = '';
      notice(
        'Analysis complete. Review the findings and download the evidence ZIP.',
      );
    } catch (error) {
      if (
        ['provider-auth', 'provider-access', 'provider-compatibility'].includes(
          error instanceof OperationError ? error.code : '',
        )
      ) {
        await invalidateProviderVerification(await keyFingerprint(key));
        await refreshProviderStatus();
      }
      throw error;
    } finally {
      aborter = undefined;
    }
  });
button('cancel').onclick = () => {
  aborter?.abort();
  if (checkingRecording && startingRequestId)
    void send({
      target: 'background',
      type: 'cancel-start',
      requestId: startingRequestId,
    }).catch((error: unknown) => notice(errorMessage(error), true));
};
button('export').onclick = () =>
  void run(async () => {
    if (!selected) return;
    operationPhase = 'export';
    const file = await exportZip(await getSession(selected.id), key, progress);
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = `annotation-cast-${selected.id}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    progress('ZIP prepared. Check your browser downloads.');
  });
button('delete').onclick = () =>
  void run(async () => {
    if (
      !selected ||
      !confirm(
        'Delete this local session, recording, screenshots, and analysis permanently?',
      )
    )
      return;
    await deleteSession(selected.id);
    selected = undefined;
    displayedSession = '';
    clearResults();
    progress('Local session deleted.');
    notice('Local session deleted.');
  });
button('refresh').onclick = () =>
  void refresh().catch((error: unknown) => notice(errorMessage(error), true));
button('copy-diagnostics').onclick = () =>
  void run(async () => {
    if (!selected) return;
    const summary = {
      formatVersion: 1,
      extensionVersion: chrome.runtime.getManifest().version,
      sessionStatus: selected.status,
      durationMs: selected.duration,
      counts: {
        audioSegments: selected.audio.length,
        transcribedSegments: selected.completedSegments.length,
        frames: selected.frames.length,
        completedAnalysisBatches: selected.completedBatches.length,
      },
      legacyErrorPresent: !!selected.error && !selected.failures?.length,
      failures: (selected.failures ?? []).map(
        ({ phase, code, retryable, occurredAt, stepId, httpStatus }) => ({
          phase,
          code,
          retryable,
          occurredAt,
          stepId,
          httpStatus,
        }),
      ),
    };
    await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
    notice(
      'Diagnostic summary copied. It contains error codes and processing counts, not session content.',
    );
  });
sessionsSelect.onchange = () => {
  displayedSession = '';
  void refresh().catch((error: unknown) => notice(errorMessage(error), true));
};
async function initialize(): Promise<void> {
  await chrome.storage.local.setAccessLevel({
    accessLevel: 'TRUSTED_CONTEXTS',
  });
  const stored = await chrome.storage.local.get([
    'settings',
    'lastOperationFailure',
  ]);
  const settings = SettingsSchema.safeParse(stored.settings);
  if (settings.success) {
    key = settings.data.key;
    keyInput.value = key;
    input('diagnostics').checked = settings.data.diagnostics;
    input('shift-tap-interval').value = String(
      settings.data.shiftTapIntervalMs,
    );
  }
  const state = await chrome.storage.session.get('selectedTabId');
  const value = z.number().int().positive().safeParse(state.selectedTabId);
  if (value.success) targetTabId = value.data;
  if (targetTabId) {
    const tab = await chrome.tabs.get(targetTabId).catch(() => undefined);
    element('target', HTMLParagraphElement).textContent = tab
      ? `Selected tab: ${sanitize(tab.url ?? tab.title ?? 'Web app', [key]).value}`
      : 'Target tab is closed. Select another tab using the toolbar button.';
  }
  await refreshProviderStatus();
  element('connection-settings', HTMLDetailsElement).open = !providerReady;
  const previousFailure = FailureSchema.safeParse(stored.lastOperationFailure);
  if (previousFailure.success) showOperationFailure(previousFailure.data);
  busy = false;
  await refresh();
  if (previousFailure.success)
    notice(
      `${failureHeadline(previousFailure.data)}. See the details below.`,
      true,
    );
  else if (active)
    notice(
      'Recording is active. Return to the selected tab to narrate and mark.',
    );
  else if (selected?.status === 'complete')
    notice(
      'Analysis complete. Review the saved findings or download the evidence ZIP.',
    );
  else if (selected?.error)
    notice(
      'This session needs attention. See its failure details in Analyze & export.',
      true,
    );
  else if (providerReady && targetTabId)
    notice(
      'Ready to record. Microphone, tab, and storage are checked when you start.',
    );
  else if (key) notice('Verify the AI connection before starting a recording.');
  setInterval(() => {
    if (!busy)
      void refreshProviderStatus()
        .then(() => refresh())
        .catch((error: unknown) => notice(errorMessage(error), true));
  }, 1500);
}
updateButtons();
void initialize().catch((error: unknown) => {
  busy = false;
  notice(errorMessage(error), true);
  updateButtons();
});
