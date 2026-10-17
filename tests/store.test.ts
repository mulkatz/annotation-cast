import { describe, it, expect, vi } from 'vitest';
import {
  addEvent,
  getEvents,
  saveSession,
  getSession,
  writeMedia,
  deleteSession,
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

describe('session deletion and file cleanup', () => {
  it('retains a visible retryable session if media deletion fails, then removes all metadata on retry', async () => {
    const session = fixtureSession();
    await saveSession(session);
    await addEvent({
      id: 'delete-event',
      sessionId: session.id,
      time: 100,
      type: 'point',
      url: session.url,
      data: {},
    });
    const removeEntry = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException('Synthetic file lock', 'NoModificationAllowedError'),
      )
      .mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      locks: navigator.locks,
      storage: { getDirectory: async () => ({ removeEntry }) },
    });
    await expect(deleteSession(session.id)).rejects.toMatchObject({
      name: 'NoModificationAllowedError',
    });
    expect((await getSession(session.id)).id).toBe(session.id);
    expect(await getEvents(session.id)).toHaveLength(1);
    await deleteSession(session.id);
    await expect(getSession(session.id)).rejects.toThrow();
    expect(await getEvents(session.id)).toHaveLength(0);
  });
  it.each(['write', 'close'] as const)(
    'aborts a failed %s on a standalone media file',
    async (failure) => {
      const stream = {
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
      };
      stream[failure].mockRejectedValue(new Error('Synthetic disk failure'));
      vi.stubGlobal('navigator', {
        storage: {
          getDirectory: async () => ({
            getDirectoryHandle: async () => ({
              getFileHandle: async () => ({
                createWritable: async () => stream,
              }),
            }),
          }),
        },
      });
      await expect(
        writeMedia('synthetic/frame.jpg', new Blob(['synthetic'])),
      ).rejects.toThrow('Synthetic disk failure');
      expect(stream.abort).toHaveBeenCalledOnce();
    },
  );
});
