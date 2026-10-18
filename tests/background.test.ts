import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { keyFingerprint } from '../src/capture/timeline';
import { providerVerification } from '../src/core/provider-readiness';
import type { Session } from '../src/core/schema';

const store = vi.hoisted(() => ({
  getSession: vi.fn(),
  saveSession: vi.fn(),
  addEvent: vi.fn(),
  listSessions: vi.fn(),
}));
vi.mock('../src/core/store', () => store);
type RuntimeListener = (
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  reply: (value: unknown) => void,
) => boolean;
const start = {
  target: 'background',
  type: 'start',
  requestId: '00000000-0000-4000-8000-000000000001',
  diagnostics: false,
  notes: { project: '', objective: '', environment: '', reference: '' },
};

describe('background recording ownership', () => {
  let listener: RuntimeListener | undefined;
  let state: Record<string, unknown>;
  let streamId: ReturnType<typeof vi.fn>;
  let runtimeSend: ReturnType<typeof vi.fn>;
  let localGet: ReturnType<typeof vi.fn>;
  let releaseStream: (() => void) | undefined;
  let saved: Map<string, Session>;
  const request = (message: unknown) =>
    new Promise<unknown>((resolve) => {
      if (!listener) throw new Error('Background listener was not registered.');
      listener(
        message,
        { id: 'synthetic', url: 'chrome-extension://synthetic/app.html' },
        resolve,
      );
    });
  beforeEach(async () => {
    vi.resetModules();
    saved = new Map();
    listener = undefined;
    releaseStream = undefined;
    const key = 'synthetic-key';
    state = {
      selectedTabId: 7,
      readiness: {
        checkedAt: Date.now(),
        tabId: 7,
        keyFingerprint: await keyFingerprint(key),
      },
    };
    store.saveSession.mockImplementation(async (session: Session) => {
      saved.set(session.id, structuredClone(session));
    });
    store.getSession.mockImplementation(async (id: string) =>
      structuredClone(saved.get(id)),
    );
    store.addEvent.mockResolvedValue(undefined);
    store.listSessions.mockResolvedValue([]);
    const hook = () => ({ addListener: vi.fn() });
    streamId = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseStream = () => resolve('synthetic-stream');
        }),
    );
    runtimeSend = vi.fn().mockResolvedValue({ ok: true });
    localGet = vi.fn().mockResolvedValue({
      settings: { key, diagnostics: false },
      providerVerification: providerVerification(await keyFingerprint(key)),
    });
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'synthetic',
        getURL: (path: string) => `chrome-extension://synthetic/${path}`,
        ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
        getContexts: vi.fn().mockResolvedValue([]),
        sendMessage: runtimeSend,
        onMessage: {
          addListener: (callback: RuntimeListener) => {
            listener = callback;
          },
        },
        onStartup: hook(),
      },
      storage: {
        local: {
          get: localGet,
        },
        session: {
          get: vi.fn(async (name: string) => ({ [name]: state[name] })),
          set: vi.fn(async (values: Record<string, unknown>) => {
            Object.assign(state, values);
          }),
          remove: vi.fn(async (names: string | string[]) => {
            for (const name of typeof names === 'string' ? [names] : names)
              delete state[name];
          }),
        },
      },
      permissions: {
        onAdded: hook(),
        contains: vi.fn().mockResolvedValue(false),
      },
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: 'https://example.test/',
          active: true,
        }),
        sendMessage: vi.fn().mockResolvedValue({ ok: true }),
        onUpdated: hook(),
        onRemoved: hook(),
      },
      scripting: { executeScript: vi.fn().mockResolvedValue([]) },
      offscreen: {
        Reason: { USER_MEDIA: 'USER_MEDIA' },
        createDocument: vi.fn().mockResolvedValue(undefined),
      },
      tabCapture: { getMediaStreamId: streamId },
      action: {
        onClicked: hook(),
        setBadgeText: vi.fn().mockResolvedValue(undefined),
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      },
      commands: { onCommand: hook() },
    });
    await import('../src/background');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  it('allows one of two concurrent start requests without the loser finalizing the winner', async () => {
    const first = request(start);
    const second = request(start);
    await vi.waitFor(() => expect(streamId).toHaveBeenCalledTimes(1));
    if (!releaseStream)
      throw new Error('The first start did not reach capture setup.');
    releaseStream();
    expect(await first).toEqual({ ok: true });
    expect(await second).toMatchObject({ ok: false });
    expect(saved.size).toBe(1);
    expect(runtimeSend).not.toHaveBeenCalledWith({
      target: 'offscreen',
      type: 'finish',
    });
    expect(state.activeSession).toBeDefined();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      target: 'content',
      type: 'initialize',
      sessionId: expect.any(String),
      startedAt: expect.any(Number),
      shiftTapIntervalMs: 180,
    });
  });
  it('retains warning badge when page injection fails and restores REC when access returns', async () => {
    vi.mocked(chrome.scripting.executeScript).mockRejectedValueOnce(
      new Error('Synthetic page access failure'),
    );
    const pending = request(start);
    await vi.waitFor(() => expect(streamId).toHaveBeenCalledTimes(1));
    if (!releaseStream) throw new Error('Capture did not start.');
    releaseStream();
    expect(await pending).toEqual({ ok: true });
    expect(state.contextStatus).toBe('unavailable');
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({
      text: '!',
      tabId: 7,
    });
    expect(
      await request({ target: 'background', type: 'grant-context' }),
    ).toEqual({ ok: true });
    expect(state.contextStatus).toBe('available');
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({
      text: 'REC',
      tabId: 7,
    });
  });
  it('blocks expired provider verification without opening a stream or repeating a paid probe', async () => {
    localGet.mockResolvedValue({
      settings: { key: 'synthetic-key', diagnostics: false },
      providerVerification: {
        ...providerVerification(await keyFingerprint('synthetic-key')),
        checkedAt: Date.now() - 86400000,
      },
    });
    expect(await request(start)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Verify the AI connection'),
    });
    expect(streamId).not.toHaveBeenCalled();
    expect(runtimeSend).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not announce recording when capture ends before its startup reply', async () => {
    runtimeSend.mockImplementation(
      async (message: { type: string; sessionId?: string }) => {
        if (message.type === 'record')
          await request({
            target: 'background',
            type: 'recording-ended',
            sessionId: message.sessionId,
          });
        return { ok: true };
      },
    );
    const pending = request(start);
    await vi.waitFor(() => expect(streamId).toHaveBeenCalledTimes(1));
    if (!releaseStream) throw new Error('Capture setup was not reached.');
    releaseStream();
    expect(await pending).toMatchObject({
      ok: false,
      error: expect.stringContaining('ended during setup'),
    });
    expect(state.activeSession).toBeUndefined();
    expect(state.captureStatus).toEqual({
      microphone: 'stopped',
      recording: 'stopped',
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      target: 'content',
      type: 'capture-notice',
      message: 'capture-stopped',
      severity: 'error',
    });
    expect(chrome.action.setBadgeText).not.toHaveBeenCalledWith({
      text: 'REC',
      tabId: 7,
    });
    expect([...saved.values()][0]?.status).toBe('interrupted');
  });
  it('cancels a pending start before a tab stream ID resolves without starting capture', async () => {
    const pending = request(start);
    await vi.waitFor(() => expect(streamId).toHaveBeenCalledTimes(1));
    expect(
      await request({
        target: 'background',
        type: 'cancel-start',
        requestId: start.requestId,
      }),
    ).toEqual({ ok: true });
    if (!releaseStream) throw new Error('Capture setup was not reached.');
    releaseStream();
    expect(await pending).toMatchObject({
      ok: false,
      error: expect.stringContaining('canceled'),
    });
    expect(state.activeSession).toBeUndefined();
    expect(runtimeSend).not.toHaveBeenCalled();
  });
  it('cancels offscreen acquisition and cannot later announce a surviving recording', async () => {
    let releaseRecord: (() => void) | undefined;
    runtimeSend.mockImplementation((message: { type: string }) =>
      message.type === 'record'
        ? new Promise((resolve) => {
            releaseRecord = () => resolve({ ok: true });
          })
        : Promise.resolve({ ok: true }),
    );
    const pending = request(start);
    await vi.waitFor(() => expect(streamId).toHaveBeenCalledTimes(1));
    if (!releaseStream) throw new Error('Capture setup was not reached.');
    releaseStream();
    await vi.waitFor(() => expect(releaseRecord).toBeDefined());
    expect(
      await request({
        target: 'background',
        type: 'cancel-start',
        requestId: start.requestId,
      }),
    ).toEqual({ ok: true });
    if (!releaseRecord) throw new Error('Offscreen start was not pending.');
    releaseRecord();
    expect(await pending).toMatchObject({
      ok: false,
      error: expect.stringContaining('canceled'),
    });
    expect(state.activeSession).toBeUndefined();
    expect(state.captureStatus).toEqual({
      microphone: 'stopped',
      recording: 'stopped',
    });
    expect(chrome.action.setBadgeText).not.toHaveBeenCalledWith({
      text: 'REC',
      tabId: 7,
    });
  });
  it('leaves an existing recording untouched when another page attempts to start', async () => {
    state.activeSession = { id: 'existing', tabId: 7 };
    state.captureStatus = { microphone: 'recording', recording: 'recording' };
    expect(await request(start)).toMatchObject({ ok: false });
    expect(state.activeSession).toEqual({ id: 'existing', tabId: 7 });
    expect(state.captureStatus).toEqual({
      microphone: 'recording',
      recording: 'recording',
    });
    expect(runtimeSend).not.toHaveBeenCalled();
    expect(streamId).not.toHaveBeenCalled();
  });
  it('sends the configured marker timing to the recorded page without credentials', async () => {
    localGet.mockResolvedValue({
      providerVerification: providerVerification(
        await keyFingerprint('synthetic-key'),
      ),
      settings: {
        key: 'synthetic-key',
        diagnostics: false,
        shiftTapIntervalMs: 260,
      },
    });
    const pending = request(start);
    await vi.waitFor(() => expect(streamId).toHaveBeenCalledTimes(1));
    if (!releaseStream) throw new Error('Capture setup was not reached.');
    releaseStream();
    expect(await pending).toEqual({ ok: true });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      target: 'content',
      type: 'initialize',
      sessionId: expect.any(String),
      startedAt: expect.any(Number),
      shiftTapIntervalMs: 260,
    });
    localGet.mockResolvedValue({
      providerVerification: providerVerification(
        await keyFingerprint('synthetic-key'),
      ),
      settings: {
        key: 'synthetic-key',
        diagnostics: false,
        shiftTapIntervalMs: 350,
      },
    });
    expect(
      await request({ target: 'background', type: 'grant-context' }),
    ).toEqual({ ok: true });
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(7, {
      target: 'content',
      type: 'initialize',
      sessionId: expect.any(String),
      startedAt: expect.any(Number),
      shiftTapIntervalMs: 260,
    });
  });
});
