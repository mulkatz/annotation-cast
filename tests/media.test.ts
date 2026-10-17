import { afterEach, expect, it, vi } from 'vitest';
import { acquireMedia } from '../src/core/media';
afterEach(() => vi.useRealTimers());
function pendingMedia() {
  const stop = vi.fn();
  let grant: (() => void) | undefined;
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(
        () =>
          new Promise((resolve) => {
            grant = () => resolve({ getTracks: () => [{ stop }] });
          }),
      ),
    },
  });
  return {
    stop,
    grant: () => {
      if (!grant) throw new Error('Media was not requested.');
      grant();
    },
  };
}
it('cancels permission waits and stops a stream granted after cancellation', async () => {
  const media = pendingMedia();
  const controller = new AbortController();
  const result = acquireMedia({ audio: true }, controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  media.grant();
  await Promise.resolve();
  expect(media.stop).toHaveBeenCalledOnce();
});
it('bounds a missing device response and disposes a late stream', async () => {
  vi.useFakeTimers();
  const media = pendingMedia();
  const rejected = expect(acquireMedia({ audio: true })).rejects.toThrow(
    'timed out',
  );
  await vi.advanceTimersByTimeAsync(20000);
  await rejected;
  media.grant();
  await Promise.resolve();
  expect(media.stop).toHaveBeenCalledOnce();
});
it('does not open the microphone when already canceled', async () => {
  pendingMedia();
  const controller = new AbortController();
  controller.abort();
  await expect(
    acquireMedia({ audio: true }, controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
});
