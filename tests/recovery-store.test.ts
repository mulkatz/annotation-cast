import { expect, it, vi } from 'vitest';
import { recoverInterruptedCapture } from '../src/capture/recovery';
import {
  saveSession,
  listSessions,
  deleteSession,
  getEvents,
} from '../src/core/store';
import { fixtureSession } from './fixtures';

it('does not resurrect a deleted session when recovery has an older checkpoint snapshot', async () => {
  const session = fixtureSession();
  session.status = 'recording';
  await saveSession(session);
  let release: (() => void) | undefined;
  let intercepted = false;
  const held = new Set<string>();
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({ removeEntry: async () => undefined }),
    },
    locks: {
      request: async (
        name: string,
        _options: unknown,
        action: (lock: object | null) => Promise<unknown>,
      ) => {
        if (!intercepted) {
          intercepted = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        if (held.has(name)) return action(null);
        held.add(name);
        try {
          return await action({});
        } finally {
          held.delete(name);
        }
      },
    },
  });
  vi.stubGlobal('chrome', {
    runtime: {
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      getContexts: async () => [],
    },
    storage: {
      session: { get: async () => ({}), remove: async () => undefined },
    },
  });
  const recovery = recoverInterruptedCapture();
  await vi.waitFor(() => expect(release).toBeDefined());
  await deleteSession(session.id);
  if (!release) throw new Error('Recovery did not reach its session lock.');
  release();
  await recovery;
  expect((await listSessions()).some((item) => item.id === session.id)).toBe(
    false,
  );
  expect(await getEvents(session.id)).toEqual([]);
});
