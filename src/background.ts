import { z } from 'zod';
import type { NotesSchema } from './core/schema';
import {
  MessageSchema,
  SettingsSchema,
  ShiftTapIntervalSchema,
  MODELS,
  type Session,
  type SessionEvent,
  type Message,
} from './core/schema';
import { getSession, saveSession, addEvent } from './core/store';
import { createRecoveryGate } from './capture/recovery';
import { providerVerificationValid } from './core/provider-readiness';
import { appendFailure, failureDetail, OperationError } from './core/failures';
import {
  keyFingerprint,
  readinessValid,
  sessionTime,
} from './capture/timeline';

const ActiveSchema = z.object({
  id: z.string(),
  tabId: z.number().int(),
  shiftTapIntervalMs: ShiftTapIntervalSchema,
});
type Active = z.infer<typeof ActiveSchema>;
const CaptureStatusSchema = z.object({ recording: z.string() });
const recovery = createRecoveryGate();
// Observe rejection immediately; operations still await it and report failures to the controls.
void recovery().catch(() => undefined);
async function captureStopped(): Promise<boolean> {
  const value = CaptureStatusSchema.safeParse(
    (await chrome.storage.session.get('captureStatus')).captureStatus,
  );
  return value.success && value.data.recording === 'stopped';
}

let starting = false;
let startCancellation:
  { canceled: boolean; requestId: string | undefined } | undefined;
let pendingCaptureStart: { id: string; ended: boolean } | undefined;
const requests = new Map<
  string,
  { url: string; method: string; start: number; status: number }
>();
let diagnosticCount = 0;
async function detachDiagnostics(tabId: number): Promise<void> {
  if (chrome.debugger)
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
}

async function active(): Promise<Active | undefined> {
  const value = ActiveSchema.safeParse(
    (await chrome.storage.session.get('activeSession')).activeSession,
  );
  return value.success ? value.data : undefined;
}
async function selectedTab(): Promise<number> {
  const value = (await chrome.storage.session.get('selectedTabId'))
    .selectedTabId;
  if (typeof value !== 'number')
    throw new Error(
      'Click the Annotation Cast toolbar action on the tab to record.',
    );
  return value;
}
async function event(
  type: SessionEvent['type'],
  url: string,
  data: SessionEvent['data'],
): Promise<void> {
  await recovery();
  if (await captureStopped()) return;
  const recording = await active();
  if (!recording) return;
  const session = await getSession(recording.id);
  if (!session) return;
  await addEvent({
    id: crypto.randomUUID(),
    sessionId: session.id,
    time: sessionTime(session.startedAt),
    type,
    url: url.slice(0, 4000),
    data,
  });
}
async function initialize(tabId: number): Promise<void> {
  await recovery();
  const recording = await active();
  if (!recording || tabId !== recording.tabId) return;
  const session = await getSession(recording.id);
  if (!session) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await chrome.tabs.sendMessage(tabId, {
      target: 'content',
      type: 'initialize',
      sessionId: session.id,
      startedAt: session.startedAt,
      shiftTapIntervalMs: recording.shiftTapIntervalMs,
    });
    await chrome.storage.session.set({ contextStatus: 'available' });
    await refreshRecordingBadge(tabId);
  } catch {
    await chrome.storage.session.set({ contextStatus: 'unavailable' });
    await event('gap', '', {
      reason:
        'Page context is unavailable. An origin change may require renewed site permission; video and microphone capture continue.',
    });
    await captureNotice(tabId, 'context-unavailable', 'warning');
  }
}
async function refreshRecordingBadge(tabId: number): Promise<void> {
  const context = (await chrome.storage.session.get('contextStatus'))
    .contextStatus;
  const capture = (await chrome.storage.session.get('captureStatus'))
    .captureStatus;
  const state = z
    .object({ microphone: z.string(), recording: z.string() })
    .safeParse(capture);
  const warning =
    context !== 'available' ||
    !state.success ||
    state.data.microphone === 'muted' ||
    state.data.recording === 'muted';
  await chrome.action
    .setBadgeText({ text: warning ? '!' : 'REC', tabId })
    .catch(() => undefined);
  await chrome.action
    .setBadgeBackgroundColor({ color: warning ? '#946923' : '#b42318', tabId })
    .catch(() => undefined);
}
async function captureNotice(
  tabId: number,
  message:
    | 'capture-stopped'
    | 'microphone-muted'
    | 'video-muted'
    | 'context-unavailable',
  severity: 'warning' | 'error',
): Promise<void> {
  await chrome.action
    .setBadgeText({ text: severity === 'error' ? 'ERR' : '!', tabId })
    .catch(() => undefined);
  await chrome.action
    .setBadgeBackgroundColor({
      color: severity === 'error' ? '#a8402c' : '#946923',
      tabId,
    })
    .catch(() => undefined);
  await chrome.tabs
    .sendMessage(tabId, {
      target: 'content',
      type: 'capture-notice',
      message,
      severity,
    })
    .catch(() => undefined);
}
async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (!contexts.length)
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification:
        'Record the selected tab and microphone across page navigation.',
    });
}
async function sendOffscreen(message: Message): Promise<void> {
  const result: unknown = await chrome.runtime.sendMessage(message);
  const reply = z
    .object({ ok: z.boolean(), error: z.string().optional() })
    .parse(result);
  if (!reply.ok) throw new Error(reply.error ?? 'Recording operation failed.');
}
async function start(
  notes: z.infer<typeof NotesSchema>,
  diagnostics: boolean,
  requestId?: string,
): Promise<void> {
  if (starting) throw new Error('A recording is already active.');
  starting = true;
  const cancellation = { canceled: false, requestId };
  startCancellation = cancellation;
  const assertNotCanceled = () => {
    if (cancellation.canceled)
      throw new OperationError(
        'canceled',
        'Recording setup was canceled. No recording remains active.',
      );
  };
  let ownsStart = false;
  let session: Session | undefined;
  let debuggerAttached = false;
  try {
    if (await active()) throw new Error('A recording is already active.');
    ownsStart = true;
    assertNotCanceled();
    const tabId = await selectedTab();
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/^https?:/.test(tab.url))
      throw new Error('Select an ordinary HTTP or HTTPS tab.');
    const configuration = await chrome.storage.local.get([
      'settings',
      'providerVerification',
    ]);
    const settings = SettingsSchema.parse(configuration.settings);
    const fingerprint = await keyFingerprint(settings.key);
    if (
      !providerVerificationValid(
        configuration.providerVerification,
        fingerprint,
      )
    )
      throw new Error(
        'Verify the AI connection once before recording. A successful check is reused for 24 hours.',
      );
    const readiness = (await chrome.storage.session.get('readiness')).readiness;
    if (!settings.key || !readinessValid(readiness, tabId, fingerprint))
      throw new Error(
        'Recording setup needs a fresh local check. Select Start recording to check microphone, tab access, and storage.',
      );
    if (
      diagnostics &&
      !(await chrome.permissions.contains({ permissions: ['debugger'] }))
    )
      throw new Error(
        'Diagnostics permission is unavailable. Enable it explicitly or disable diagnostics.',
      );
    await chrome.storage.session.remove('readiness');
    await ensureOffscreen();
    assertNotCanceled();
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });
    assertNotCanceled();
    const id = crypto.randomUUID();
    const lifecycle = { id, ended: false };
    pendingCaptureStart = lifecycle;
    const assertStarting = () => {
      assertNotCanceled();
      if (lifecycle.ended)
        throw new Error(
          'Recording ended during setup. Inspect the retained session before starting again.',
        );
    };
    session = {
      schemaVersion: 1,
      id,
      createdAt: Date.now(),
      tabId,
      url: tab.url,
      notes,
      status: 'recording',
      startedAt: Date.now(),
      duration: 0,
      diagnostics,
      models: MODELS,
      audio: [],
      transcript: [],
      frames: [],
      findings: [],
      completedSegments: [],
      completedBatches: [],
      error: '',
      recordingPath: `${id}/recording.webm`,
      sanitization: {},
    };
    await saveSession(session);
    await chrome.storage.session.set({
      activeSession: {
        id,
        tabId,
        shiftTapIntervalMs: settings.shiftTapIntervalMs,
      },
      diagnosticsStatus: diagnostics ? 'connecting' : 'disabled',
      captureStatus: { microphone: 'preparing', recording: 'preparing' },
    });
    assertNotCanceled();
    if (diagnostics) {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        debuggerAttached = true;
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
        await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
          maxPostDataSize: 0,
          maxTotalBufferSize: 0,
          maxResourceBufferSize: 0,
        });
        await chrome.storage.session.set({ diagnosticsStatus: 'attached' });
        diagnosticCount = 0;
      } catch {
        throw new Error(
          'Diagnostics could not attach. Close DevTools or disable diagnostics, then run readiness again.',
        );
      }
    }
    assertNotCanceled();
    await sendOffscreen({
      target: 'offscreen',
      type: 'record',
      sessionId: id,
      streamId,
    });
    assertStarting();
    await chrome.storage.session.set({
      captureStatus: { microphone: 'recording', recording: 'recording' },
    });
    assertStarting();
    await initialize(tabId);
    assertStarting();
    await refreshRecordingBadge(tabId);
    assertStarting();
  } catch (error) {
    if (!ownsStart) throw error;
    if (session)
      await sendOffscreen({ target: 'offscreen', type: 'finish' }).catch(
        () => undefined,
      );
    if (debuggerAttached && session) await detachDiagnostics(session.tabId);
    if (session) {
      try {
        const latest = await getSession(session.id);
        latest.status = 'interrupted';
        if (!latest.failures?.length)
          appendFailure(latest, failureDetail(error, 'setup'));
        await saveSession(latest);
      } catch {
        /* Keep runtime cleanup possible when local durable storage is unavailable. */
      }
    }
    await chrome.storage.session.remove('activeSession');
    await chrome.storage.session.set({
      diagnosticsStatus: 'disabled',
      captureStatus: { microphone: 'stopped', recording: 'stopped' },
    });
    if (session)
      await chrome.action
        .setBadgeText({ text: 'ERR', tabId: session.tabId })
        .catch(() => undefined);
    throw error;
  } finally {
    pendingCaptureStart = undefined;
    if (startCancellation === cancellation) startCancellation = undefined;
    starting = false;
  }
}
async function cleanup(sessionId: string): Promise<void> {
  if (pendingCaptureStart?.id === sessionId) pendingCaptureStart.ended = true;
  const recording = await active();
  if (!recording || recording.id !== sessionId) return;
  let interrupted = false;
  try {
    const session = await getSession(sessionId);
    interrupted =
      session.status === 'recording' ||
      session.status === 'interrupted' ||
      !!session.error;
  } catch {
    interrupted = true;
  }
  if (interrupted)
    await captureNotice(recording.tabId, 'capture-stopped', 'error');
  await chrome.tabs
    .sendMessage(recording.tabId, { target: 'content', type: 'cleanup' })
    .catch(() => undefined);
  await chrome.action
    .setBadgeText({ text: interrupted ? 'ERR' : '', tabId: recording.tabId })
    .catch(() => undefined);
  await chrome.storage.session.remove('activeSession');
  await detachDiagnostics(recording.tabId);
  try {
    const session = await getSession(sessionId);
    if (session.status === 'recording') {
      session.status = 'interrupted';
      session.error =
        'Recording ended before finalization completed. Existing evidence was recovered on a best-effort basis.';
      session.duration = Math.max(
        session.duration,
        ...session.audio.map((segment) => segment.end),
        ...session.frames.map((frame) => frame.time),
      );
      await saveSession(session);
    }
  } catch {
    /* Runtime capture state still clears if durable recovery is unavailable. */
  }
  await chrome.storage.session.set({
    diagnosticsStatus: 'disabled',
    captureStatus: { microphone: 'stopped', recording: 'stopped' },
  });
  requests.clear();
}
async function stop(): Promise<void> {
  const recording = await active();
  if (!recording) return;
  try {
    await sendOffscreen({ target: 'offscreen', type: 'finish' });
  } finally {
    await cleanup(recording.id);
  }
}
chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    await recovery();
    const recording = await active();
    if (recording) {
      if (tab.id === recording.tabId) await initialize(recording.tabId);
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`app.html?session=${recording.id}`),
      });
      return;
    }
    if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) return;
    await chrome.storage.session.set({ selectedTabId: tab.id });
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`app.html?tab=${tab.id}`),
    });
  })();
});
chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    await recovery();
    const recording = await active();
    if (!recording) return;
    const tab = await chrome.tabs.get(recording.tabId);
    if (!tab.active) return;
    try {
      await chrome.tabs.sendMessage(recording.tabId, {
        target: 'content',
        type: 'marker',
        mode: command === 'point-marker' ? 'point' : 'rectangle',
      });
    } catch {
      await event('gap', tab.url ?? '', {
        reason:
          'Marker context is unavailable on this page. Renew site access.',
      });
    }
  })();
});
chrome.runtime.onMessage.addListener((raw: unknown, sender, reply) => {
  const parsed = MessageSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.target !== 'background' ||
    sender.id !== chrome.runtime.id
  )
    return false;
  const message = parsed.data;
  const fromExtension =
    sender.url?.startsWith(chrome.runtime.getURL('')) === true;
  if (
    message.type !== 'event' &&
    message.type !== 'open-controls' &&
    !fromExtension
  ) {
    reply({ ok: false, error: 'This operation requires the extension page.' });
    return false;
  }
  void (async () => {
    await recovery();
    switch (message.type) {
      case 'cancel-start':
        if (
          startCancellation &&
          startCancellation.requestId === message.requestId
        ) {
          startCancellation.canceled = true;
          await stop();
        }
        break;
      case 'open-controls': {
        const recording = await active();
        if (
          !fromExtension &&
          sender.tab?.id !== recording?.tabId &&
          sender.tab?.id !== (await selectedTab())
        )
          throw new Error('Controls can only be opened from the selected tab.');
        await chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
        break;
      }
      case 'start':
        await start(message.notes, message.diagnostics, message.requestId);
        break;
      case 'stop':
        await stop();
        break;
      case 'event': {
        if (await captureStopped()) break;
        const recording = await active();
        if (
          !recording ||
          sender.tab?.id !== recording.tabId ||
          message.event.sessionId !== recording.id
        )
          throw new Error('Event does not belong to the recorded tab.');
        const session = await getSession(recording.id);
        if (
          !session ||
          message.event.time > sessionTime(session.startedAt) + 5000
        )
          throw new Error('Event timestamp is outside the session timeline.');
        await addEvent(message.event);
        break;
      }
      case 'recording-ended':
        await cleanup(message.sessionId);
        break;
      case 'capture-status': {
        const recording = await active();
        if (
          sender.url !== chrome.runtime.getURL('offscreen.html') ||
          !recording ||
          recording.id !== message.sessionId
        )
          throw new Error(
            'Capture status does not belong to the active recording.',
          );
        await chrome.storage.session.set({
          captureStatus: {
            microphone: message.microphone,
            recording: message.recording,
          },
        });
        if (message.microphone === 'muted')
          await captureNotice(recording.tabId, 'microphone-muted', 'warning');
        else if (message.recording === 'muted')
          await captureNotice(recording.tabId, 'video-muted', 'warning');
        else if (
          message.microphone === 'recording' &&
          message.recording === 'recording'
        ) {
          await chrome.tabs
            .sendMessage(recording.tabId, {
              target: 'content',
              type: 'clear-media-notice',
            })
            .catch(() => undefined);
          if (
            (await chrome.storage.session.get('contextStatus'))
              .contextStatus === 'available'
          ) {
            await chrome.action
              .setBadgeText({ text: 'REC', tabId: recording.tabId })
              .catch(() => undefined);
            await chrome.action
              .setBadgeBackgroundColor({
                color: '#b42318',
                tabId: recording.tabId,
              })
              .catch(() => undefined);
          }
        }
        break;
      }
      case 'check-diagnostics': {
        if (await active()) throw new Error('A recording is already active.');
        if (!(await chrome.permissions.contains({ permissions: ['debugger'] })))
          throw new Error(
            'Enable optional debugger permission or disable diagnostics.',
          );
        const tabId = await selectedTab();
        await chrome.debugger.attach({ tabId }, '1.3');
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
          await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
            maxPostDataSize: 0,
            maxTotalBufferSize: 0,
            maxResourceBufferSize: 0,
          });
        } finally {
          await chrome.debugger.detach({ tabId });
        }
        break;
      }
      case 'grant-context':
        await initialize((await active())?.tabId ?? (await selectedTab()));
        break;
      case 'check-tab': {
        const tab = await chrome.tabs.get(await selectedTab());
        if (!tab.url || !/^https?:/.test(tab.url))
          throw new Error('The selected tab is unavailable or restricted.');
        await chrome.scripting.executeScript({
          target: { tabId: tab.id! },
          func: () => document.readyState,
        });
        break;
      }
    }
  })().then(
    () => reply({ ok: true }),
    (error: unknown) =>
      reply({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Extension operation failed.',
      }),
  );
  return true;
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url)
    void (async () => {
      if ((await active())?.tabId === tabId)
        await event('navigation', change.url!, {
          title: (tab.title ?? '').slice(0, 300),
        });
    })();
  if (change.status === 'loading')
    void (async () => {
      if ((await active())?.tabId === tabId)
        await chrome.storage.session.set({ contextStatus: 'pending' });
    })();
  if (change.status === 'complete') void initialize(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    if ((await active())?.tabId === tabId) await stop();
  })();
});
function debuggerDetached(
  source: chrome.debugger.Debuggee,
  reason: string,
): void {
  void (async () => {
    if ((await active())?.tabId !== source.tabId) return;
    await chrome.storage.session.set({ diagnosticsStatus: 'disconnected' });
    await event('gap', '', {
      reason: `Optional diagnostics detached: ${reason}. Video and microphone capture continue.`,
    });
    requests.clear();
  })();
}
const RequestSchema = z.object({
  requestId: z.string(),
  timestamp: z.number(),
  request: z.object({ url: z.string(), method: z.string() }),
});
const ResponseSchema = z.object({
  requestId: z.string(),
  response: z.object({ status: z.number() }),
});
const FinishedSchema = z.object({
  requestId: z.string(),
  timestamp: z.number(),
  errorText: z.string().optional(),
});
const StackSchema = z.object({
  callFrames: z
    .array(
      z.object({
        functionName: z.string(),
        url: z.string(),
        lineNumber: z.number(),
        columnNumber: z.number(),
      }),
    )
    .max(100),
});
const ConsoleSchema = z.object({
  stackTrace: StackSchema.optional(),
  type: z.string(),
  args: z
    .array(
      z.object({
        type: z.string(),
        value: z
          .union([z.string(), z.number(), z.boolean(), z.null()])
          .optional(),
        description: z.string().optional(),
      }),
    )
    .max(100),
});
const ExceptionSchema = z.object({
  exceptionDetails: z.object({
    text: z.string(),
    exception: z.object({ description: z.string().optional() }).optional(),
    stackTrace: z
      .object({
        callFrames: z
          .array(
            z.object({
              functionName: z.string(),
              url: z.string(),
              lineNumber: z.number(),
              columnNumber: z.number(),
            }),
          )
          .max(100),
      })
      .optional(),
  }),
});
function debuggerEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params: unknown,
): void {
  void (async () => {
    if ((await active())?.tabId !== source.tabId || diagnosticCount > 20_000)
      return;
    if (diagnosticCount === 20_000) {
      diagnosticCount++;
      requests.clear();
      await chrome.storage.session.set({ diagnosticsStatus: 'truncated' });
      await event('gap', '', {
        reason:
          'The diagnostic metadata limit was reached; further diagnostics are omitted. Video, microphone, markers, and interactions continue.',
      });
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      const value = RequestSchema.safeParse(params);
      if (value.success) {
        if (requests.size >= 1000)
          requests.delete(requests.keys().next().value ?? '');
        requests.set(value.data.requestId, {
          url: value.data.request.url.slice(0, 4000),
          method: value.data.request.method.slice(0, 30),
          start: value.data.timestamp,
          status: 0,
        });
      }
    } else if (method === 'Network.responseReceived') {
      const value = ResponseSchema.safeParse(params);
      if (value.success) {
        const request = requests.get(value.data.requestId);
        if (request) request.status = value.data.response.status;
      }
    } else if (
      method === 'Network.loadingFinished' ||
      method === 'Network.loadingFailed'
    ) {
      const value = FinishedSchema.safeParse(params);
      if (!value.success) return;
      const request = requests.get(value.data.requestId);
      if (!request) return;
      requests.delete(value.data.requestId);
      diagnosticCount++;
      await event('network', request.url, {
        method: request.method,
        status: request.status,
        duration: Math.max(0, (value.data.timestamp - request.start) * 1000),
        error: (value.data.errorText ?? '').slice(0, 1000),
      });
    } else if (method === 'Runtime.consoleAPICalled') {
      const value = ConsoleSchema.safeParse(params);
      if (!value.success) return;
      diagnosticCount++;
      const text = value.data.args
        .slice(0, 10)
        .map((argument) =>
          argument.value !== undefined
            ? String(argument.value)
            : `[${argument.type}]`,
        )
        .join(' ')
        .slice(0, 4000);
      await event('console', '', {
        level: value.data.type,
        text,
        stack:
          value.data.stackTrace?.callFrames.slice(0, 10).map((frame) => ({
            functionName: frame.functionName.slice(0, 200),
            url: frame.url.slice(0, 4000),
            lineNumber: frame.lineNumber,
            columnNumber: frame.columnNumber,
          })) ?? [],
      });
    } else if (method === 'Runtime.exceptionThrown') {
      const value = ExceptionSchema.safeParse(params);
      if (!value.success) return;
      diagnosticCount++;
      await event('console', '', {
        level: 'error',
        text: (
          value.data.exceptionDetails.exception?.description ??
          value.data.exceptionDetails.text
        ).slice(0, 4000),
        stack:
          value.data.exceptionDetails.stackTrace?.callFrames.slice(0, 10) ?? [],
      });
    }
  })();
}
let diagnosticsListenersInstalled = false;
function registerDiagnosticsListeners(): void {
  if (diagnosticsListenersInstalled || !chrome.debugger) return;
  chrome.debugger.onDetach.addListener(debuggerDetached);
  chrome.debugger.onEvent.addListener(debuggerEvent);
  diagnosticsListenersInstalled = true;
}
registerDiagnosticsListeners();
chrome.permissions.onAdded.addListener(registerDiagnosticsListeners);
// Registering the event wakes the worker on browser startup. All reconciliation
// runs once through the same boot promise, including extension reloads.
chrome.runtime.onStartup.addListener(() => {
  void recovery().catch(() => undefined);
});
