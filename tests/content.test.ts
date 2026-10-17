import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

type RuntimeListener = (
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  reply: (value: unknown) => void,
) => boolean;
describe('point marker availability', () => {
  let listener: RuntimeListener | undefined;
  let send: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    vi.resetModules();
    send = vi.fn().mockResolvedValue({ ok: true });
    const addListener = vi.fn();
    vi.stubGlobal('annotationCastInstalled', undefined);
    vi.stubGlobal('window', { addEventListener: addListener });
    vi.stubGlobal('addEventListener', addListener);
    for (const [name, value] of Object.entries({
      innerWidth: 800,
      innerHeight: 600,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      visualViewport: null,
      location: { href: 'https://example.test/' },
    }))
      vi.stubGlobal(name, value);
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'synthetic',
        sendMessage: send,
        onMessage: {
          addListener: (callback: RuntimeListener) => {
            listener = callback;
          },
        },
      },
    });
    await import('../src/content');
  });
  afterEach(() => vi.unstubAllGlobals());
  it('records an explicit gap instead of guessing the viewport center before pointer movement', () => {
    const message = (value: unknown) =>
      listener?.(value, { id: 'synthetic' }, () => undefined);
    message({
      target: 'content',
      type: 'initialize',
      sessionId: 'session',
      startedAt: Date.now(),
    });
    send.mockClear();
    message({ target: 'content', type: 'marker', mode: 'point' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'gap',
          data: { reason: expect.stringContaining('move the pointer') },
        }),
      }),
    );
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ type: 'point' }),
      }),
    );
  });
});
