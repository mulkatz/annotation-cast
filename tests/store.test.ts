import { describe, it, expect, vi } from 'vitest';
import {
  addEvent,
  getEvents,
  saveSession,
  getSession,
  writeMedia,
} from '../src/core/store';
import { fixtureSession } from './fixtures';
describe('local storage boundary', () => {
  it('persists independent checkpoints and sorts timeline events', async () => {
    const session = fixtureSession();
    await saveSession(session);
    for (const time of [2000, 1000])
      await addEvent({
        id: crypto.randomUUID(),
        sessionId: session.id,
        time,
        type: 'point',
        url: session.url,
        data: {},
      });
    expect((await getEvents(session.id)).map((event) => event.time)).toEqual([
      1000, 2000,
    ]);
    expect((await getSession(session.id)).status).toBe('stopped');
  });
  it('rejects corrupt persisted records at the write boundary', async () => {
    await expect(
      saveSession({ ...fixtureSession(), duration: -1 }),
    ).rejects.toThrow();
  });
});

describe('recording worker failures', () => {
  it('bounds stalled disk requests and releases the worker', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path } });
    vi.stubGlobal(
      'Worker',
      class {
        onmessage = null;
        onerror = null;
        postMessage() {}
        terminate = terminate;
      },
    );
    try {
      const writing = writeMedia(
        'synthetic/recording.webm',
        new Blob(['synthetic media']),
        true,
      );
      const rejected = expect(writing).rejects.toThrow('storage timed out');
      await vi.advanceTimersByTimeAsync(20001);
      await rejected;
      expect(terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
