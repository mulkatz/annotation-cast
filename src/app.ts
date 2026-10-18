import { z } from 'zod';
import {
  SettingsSchema,
  ShiftTapIntervalSchema,
  send,
  type Session,
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
let ready = false;
let busy = false;
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
async function run(task: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  updateButtons();
  try {
    await task();
  } catch (error) {
    notice(errorMessage(error), true);
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
  button('start').disabled = busy || !ready || !!active;
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
    !!active;
  button('analyze').textContent =
    selected?.status === 'failed' || selected?.status === 'processing'
      ? 'Retry incomplete steps'
      : 'Start analysis';
  button('export').disabled = busy || selected?.status !== 'complete';
  button('delete').disabled =
    busy || !selected || selected.status === 'recording';
  button('cancel').disabled = !aborter;
  button('grant').disabled = busy || !targetTabId;
  sessionsSelect.disabled = busy || !!active;
  input('diagnostics').disabled = busy || !!active;
}
async function saveKey(): Promise<void> {
  await requireIdleSettings();
  key = keyInput.value.trim();
  if (!key) throw new Error('Enter an OpenRouter API key.');
  await chrome.storage.local.setAccessLevel({
    accessLevel: 'TRUSTED_CONTEXTS',
  });
  await chrome.storage.local.set({
    settings: SettingsSchema.parse({
      key,
      diagnostics: input('diagnostics').checked,
      shiftTapIntervalMs: markerInterval(),
    }),
  });
  ready = false;
  await chrome.storage.session.remove('readiness');
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
  const stored = await chrome.storage.local.get('settings');
  const settings = SettingsSchema.parse(
    stored.settings ?? { key: '', diagnostics: false },
  );
  await chrome.storage.local.set({
    settings: { ...settings, shiftTapIntervalMs: interval },
  });
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
  if (check)
    check.setAttribute('aria-label', `${check.textContent?.trim()}: passed`);
}
async function readiness(): Promise<void> {
  const controller = new AbortController();
  aborter = controller;
  updateButtons();
  try {
    await checkReadiness(controller.signal);
  } catch (error) {
    const check = [...document.querySelectorAll('#checks li')].find(
      (node) => !node.classList.contains('passed'),
    );
    if (check)
      check.setAttribute(
        'aria-label',
        `${check.textContent?.trim()}: ${controller.signal.aborted ? 'canceled' : 'failed'}`,
      );
    throw error;
  } finally {
    aborter = undefined;
  }
}
async function checkReadiness(signal: AbortSignal): Promise<void> {
  ready = false;
  if (
    input('diagnostics').checked &&
    !(await chrome.permissions.request({ permissions: ['debugger'] }))
  )
    throw new Error(
      'Diagnostics permission was declined. Disable diagnostics or grant permission, then rerun readiness.',
    );
  await saveKey();
  for (const node of document.querySelectorAll('#checks li')) {
    node.classList.remove('passed');
    node.setAttribute('aria-label', `${node.textContent?.trim()}: not checked`);
  }
  if (!targetTabId)
    throw new Error(
      'Open the tested tab and click the Annotation Cast toolbar button first.',
    );

  signal.throwIfAborted();
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
      'At least 1.5 GB of available extension storage is required for a session and ZIP preparation.',
    );
  await navigator.storage.persist();
  signal.throwIfAborted();
  await writeMedia('readiness/check.txt', new Blob(['synthetic readiness']));
  const handle = await mediaHandle('readiness/check.txt');
  if ((await (await handle.getFile()).text()) !== 'synthetic readiness')
    throw new Error('Local storage write verification failed.');
  await (
    await navigator.storage.getDirectory()
  ).removeEntry('readiness', { recursive: true });
  passed(2);
  notice(
    'Checking OpenRouter timestamped transcription and structured image analysis using bundled synthetic data…',
  );
  signal.throwIfAborted();
  await checkProvider(key, signal);
  passed(3);
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(key),
  );
  const keyFingerprint = [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  signal.throwIfAborted();
  await chrome.storage.session.set({
    readiness: { checkedAt: Date.now(), tabId: targetTabId, keyFingerprint },
  });
  ready = true;
  notice(
    'Ready to record. Readiness is valid for one recording within 10 minutes.',
  );
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
    } else
      element('capture-status', HTMLParagraphElement).textContent = selected
        ? `Recording stopped · ${selected.status}. ${selected.error}`
        : 'Your recording will continue when this page is closed.';
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
    updateButtons();
  } finally {
    refreshInProgress = false;
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
    notice('Key saved locally. Run readiness checks before recording.');
  });
button('save-markers').onclick = () =>
  void run(async () => {
    await saveMarkerSettings();
    notice('Marker timing saved for the next recording.');
  });
keyInput.oninput = () => {
  ready = false;
  updateButtons();
};
input('diagnostics').onchange = () => {
  ready = false;
  updateButtons();
};
button('readiness').onclick = () => void run(readiness);
button('start').onclick = () =>
  void run(async () => {
    const notes = {
      project: input('project').value,
      objective: element('objective', HTMLTextAreaElement).value,
      environment: input('environment').value,
      reference: input('reference').value,
    };
    await send({
      target: 'background',
      type: 'start',
      notes,
      diagnostics: input('diagnostics').checked,
    });
    ready = false;
    notice(
      'Recording. Return to your selected tab to narrate and mark observations.',
    );
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
    } finally {
      aborter = undefined;
    }
  });
button('cancel').onclick = () => aborter?.abort();
button('export').onclick = () =>
  void run(async () => {
    if (!selected) return;
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
sessionsSelect.onchange = () => {
  displayedSession = '';
  void refresh().catch((error: unknown) => notice(errorMessage(error), true));
};
async function initialize(): Promise<void> {
  await chrome.storage.local.setAccessLevel({
    accessLevel: 'TRUSTED_CONTEXTS',
  });
  const stored = await chrome.storage.local.get('settings');
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
  await refresh();
  setInterval(() => {
    if (!busy)
      void refresh().catch((error: unknown) =>
        notice(errorMessage(error), true),
      );
  }, 1500);
}
void initialize().catch((error: unknown) => notice(errorMessage(error), true));
