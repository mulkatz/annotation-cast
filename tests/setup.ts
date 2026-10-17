import 'fake-indexeddb/auto';
import { beforeEach, vi } from 'vitest';
beforeEach(() => {
  vi.stubGlobal('navigator', {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        action: (lock: object) => Promise<unknown>,
      ) => action({}),
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.reject(
        new Error('Real network calls are blocked in automated tests.'),
      ),
    ),
  );
});
