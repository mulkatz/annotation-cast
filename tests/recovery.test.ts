import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureSession } from './fixtures';
import type { Session } from '../src/core/schema';
import {
  createRecoveryGate,
  recoverInterruptedCapture,
} from '../src/capture/recovery';

const store = vi.hoisted(() => ({
  listSessions: vi.fn(),
  saveSession: vi.fn(),
  addEvent: vi.fn(),
}));
vi.mock('../src/core/store', () => store);
describe('background capture reconciliation', () => {
  let contexts: ReturnType<
    typeof vi.fn<() => Promise<chrome.runtime.ExtensionContext[]>>
  >;
  beforeEach(() => {
    vi.clearAllMocks();
    store.listSessions.mockResolvedValue([]);
    store.saveSession.mockResolvedValue(undefined);
    store.addEvent.mockResolvedValue(undefined);
    contexts = vi
      .fn<() => Promise<chrome.runtime.ExtensionContext[]>>()
      .mockResolvedValue([]);
    vi.stubGlobal('chrome', {
      runtime: {
        ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
        getContexts: contexts,
      },
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('recovers durable recording evidence when runtime state and offscreen capture were lost', async () => {
    const session = fixtureSession();
    session.status = 'recording';
    session.duration = 0;
    session.frames = [
      {
        id: 'frame-1',
        path: 'screenshots/frame-1.jpg',
        time: 12_000,
        eventIds: [],
      },
    ];
    store.listSessions.mockResolvedValue([session]);
    await recoverInterruptedCapture();
    expect(store.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'interrupted', duration: 12_000 }),
    );
    expect(store.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        time: 12_000,
        type: 'gap',
      }),
    );
    expect(chrome.storage.session.remove).toHaveBeenCalledWith([
      'activeSession',
      'readiness',
    ]);
    await recoverInterruptedCapture();
    expect(store.addEvent).toHaveBeenCalledTimes(1);
  });
  it('preserves an ongoing offscreen capture when only the service worker restarts', async () => {
    contexts.mockResolvedValue([
      {
        contextType: 'OFFSCREEN_DOCUMENT',
        contextId: 'synthetic',
        frameId: -1,
        incognito: false,
        tabId: -1,
        windowId: -1,
      },
    ]);
    await recoverInterruptedCapture();
    expect(store.listSessions).not.toHaveBeenCalled();
    expect(chrome.storage.session.remove).not.toHaveBeenCalled();
  });
  it('does not invalidate fresh readiness on an ordinary idle worker wakeup', async () => {
    await recoverInterruptedCapture();
    expect(chrome.storage.session.remove).not.toHaveBeenCalled();
  });
  it('does not assume capture is absent when context inspection fails', async () => {
    contexts.mockRejectedValue(new Error('Synthetic context failure.'));
    await expect(recoverInterruptedCapture()).rejects.toThrow(
      'Synthetic context failure',
    );
    expect(store.listSessions).not.toHaveBeenCalled();
    expect(chrome.storage.session.remove).not.toHaveBeenCalled();
  });
  it('shares concurrent checks and allows the next operation to retry after a transient inspection failure', async () => {
    contexts.mockRejectedValueOnce(new Error('Synthetic transient failure.'));
    const ready = createRecoveryGate();
    const first = ready();
    expect(ready()).toBe(first);
    await expect(first).rejects.toThrow('transient failure');
    await expect(ready()).resolves.toBeUndefined();
    await ready();
    expect(contexts).toHaveBeenCalledTimes(2);
  });
  it('persists a stable gap before metadata, so checkpoint failures neither lose nor duplicate recovery evidence', async () => {
    const session = { ...fixtureSession(), status: 'recording' as const };
    let durable: Session = structuredClone(session);
    store.listSessions.mockImplementation(async () => [
      structuredClone(durable),
    ]);
    store.saveSession
      .mockRejectedValueOnce(new Error('Synthetic metadata failure.'))
      .mockImplementationOnce(async (saved: Session) => {
        durable = structuredClone(saved);
      });
    const ready = createRecoveryGate();
    await expect(ready()).rejects.toThrow('metadata failure');
    expect(durable.status).toBe('recording');
    await ready();
    expect(durable.status).toBe('interrupted');
    expect(store.addEvent).toHaveBeenCalledTimes(2);
    expect(store.addEvent.mock.calls[0]?.[0].id).toBe(`recovery-${session.id}`);
    expect(store.addEvent.mock.calls[1]?.[0].id).toBe(`recovery-${session.id}`);
  });
  it('leaves the checkpoint retryable when writing recovery evidence fails', async () => {
    const session = { ...fixtureSession(), status: 'recording' as const };
    store.listSessions.mockImplementation(async () => [
      structuredClone(session),
    ]);
    store.addEvent.mockRejectedValueOnce(new Error('Synthetic gap failure.'));
    const ready = createRecoveryGate();
    await expect(ready()).rejects.toThrow('gap failure');
    expect(store.saveSession).not.toHaveBeenCalled();
    await ready();
    expect(store.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'interrupted' }),
    );
  });
});
