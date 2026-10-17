import { expect, it, vi } from 'vitest';
it('releases the recording file when its final flush fails, so it can be reopened', async () => {
  const close = vi.fn();
  const flush = vi
    .fn()
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      throw new Error('Synthetic disk failure');
    });
  const createSyncAccessHandle = vi.fn(async () => ({
    write: (data: ArrayBuffer) => data.byteLength,
    getSize: () => 0,
    flush,
    close,
  }));
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => ({
          getFileHandle: async () => ({ createSyncAccessHandle }),
        }),
      }),
    },
  });
  const scope: {
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  } = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal('self', scope);
  await import('../src/core/media-worker');
  if (!scope.onmessage) throw new Error('Worker listener was not installed.');
  const request = async (id: number, closing: boolean) => {
    scope.onmessage?.(
      new MessageEvent('message', {
        data: {
          id,
          path: 'synthetic/recording.webm',
          close: closing,
          data: closing ? undefined : new ArrayBuffer(8),
        },
      }),
    );
    await vi.waitFor(() =>
      expect(
        scope.postMessage.mock.calls.some(([value]) => value.id === id),
      ).toBe(true),
    );
  };
  await request(1, false);
  await request(2, true);
  expect(scope.postMessage).toHaveBeenCalledWith({ id: 2, ok: false });
  expect(close).toHaveBeenCalledOnce();
  await request(3, false);
  expect(createSyncAccessHandle).toHaveBeenCalledTimes(2);
  expect(scope.postMessage).toHaveBeenCalledWith({ id: 3, ok: true });
  await request(4, true);
});
