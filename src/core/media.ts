/** Bound permission/device waits and release streams granted after cancellation. */
export async function acquireMedia(
  constraints: MediaStreamConstraints,
  signal?: AbortSignal,
): Promise<MediaStream> {
  signal?.throwIfAborted();
  const request = navigator.mediaDevices.getUserMedia(constraints);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () =>
      fail(
        signal?.reason ??
          new DOMException('Media access canceled.', 'AbortError'),
      );
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            'Media access timed out. Check microphone permission and tab availability.',
          ),
        ),
      20000,
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    void request.then((stream) => {
      if (settled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      settled = true;
      cleanup();
      resolve(stream);
    }, fail);
  });
}
