import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/core/schema';
import {
  keyFingerprint,
  readinessValid,
  sessionTime,
} from '../src/capture/timeline';

describe('capture timeline and readiness', () => {
  it('maps independent media and event epochs to session milliseconds without negative time', () => {
    expect(sessionTime(100_000, 159_005)).toBe(59_005);
    expect(sessionTime(100_000, 160_020)).toBe(60_020);
    expect(sessionTime(100_000, 99_900)).toBe(0);
  });
  it('rejects stale, future, mismatched-tab and changed-key readiness', () => {
    const ready = { checkedAt: 1000, tabId: 2, keyFingerprint: 'digest' };
    expect(readinessValid(ready, 2, 'digest', 1001)).toBe(true);
    expect(readinessValid(ready, 2, 'digest', 601_000)).toBe(false);
    expect(readinessValid(ready, 2, 'digest', 999)).toBe(false);
    expect(readinessValid(ready, 3, 'digest', 1001)).toBe(false);
    expect(readinessValid(ready, 2, 'changed', 1001)).toBe(false);
    expect(readinessValid({}, 2, 'digest', 1001)).toBe(false);
  });
  it('binds readiness to a digest without persisting the configured key in session state', async () => {
    expect(await keyFingerprint('synthetic-placeholder')).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(await keyFingerprint('synthetic-placeholder')).not.toBe(
      await keyFingerprint('other-placeholder'),
    );
  });
});

// These tests exercise orchestration with synthetic tracks, not browser media compatibility.
const mediaStore = vi.hoisted(() => ({
  getSession: vi.fn(),
  saveSession: vi.fn(),
  writeMedia: vi.fn(),
  closeMedia: vi.fn(),
  addEvent: vi.fn(),
}));
vi.mock('../src/core/store', () => mediaStore);

class SyntheticTrack extends EventTarget {
  stopped = false;
  muted = false;
  constructor(readonly kind: string) {
    super();
  }
  stop() {
    this.stopped = true;
  }
}
class SyntheticStream {
  constructor(readonly tracks: SyntheticTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
}
class SyntheticRecorder extends EventTarget {
  static instances: SyntheticRecorder[] = [];
  constructor() {
    super();
    SyntheticRecorder.instances.push(this);
  }
  static isTypeSupported() {
    return true;
  }
  state = 'inactive';
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.dispatchEvent(
      Object.assign(new Event('dataavailable'), {
        data: new Blob(['synthetic-media']),
      }),
    );
    this.dispatchEvent(new Event('stop'));
  }
}
type RuntimeListener = (
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  reply: (value: unknown) => void,
) => boolean;

describe('offscreen lifecycle with synthetic media', () => {
  let listener: RuntimeListener | undefined;
  let videoTrack: SyntheticTrack;
  let microphoneTrack: SyntheticTrack;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let saved: Session;
  let frameCallback: ((value: Blob | null) => void) | undefined;
  let frameEnabled = true;
  let frameDeferred = false;
  let playVideo: () => Promise<void>;
  const url = 'chrome-extension://synthetic/';
  const request = (message: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      if (!listener) throw new Error('Offscreen listener was not installed.');
      listener(
        message,
        { id: 'synthetic', url: `${url}background.js` },
        resolve,
      );
    });
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.resetModules();
    SyntheticRecorder.instances = [];
    listener = undefined;
    frameCallback = undefined;
    frameEnabled = true;
    frameDeferred = false;
    playVideo = async () => undefined;
    videoTrack = new SyntheticTrack('video');
    microphoneTrack = new SyntheticTrack('audio');
    saved = {
      schemaVersion: 1,
      id: 'session',
      createdAt: 100_000,
      startedAt: 100_000,
      tabId: 1,
      url: 'https://example.test/',
      notes: { project: '', objective: '', environment: '', reference: '' },
      status: 'recording',
      duration: 0,
      diagnostics: false,
      models: { transcription: 'synthetic', analysis: 'synthetic' },
      audio: [],
      transcript: [],
      frames: [],
      findings: [],
      completedSegments: [],
      completedBatches: [],
      error: '',
      recordingPath: 'session/recording.webm',
      sanitization: {},
    };
    mediaStore.getSession.mockImplementation(async () =>
      structuredClone(saved),
    );
    mediaStore.saveSession.mockImplementation(async (session: Session) => {
      saved = structuredClone(session);
    });
    mediaStore.writeMedia.mockResolvedValue(undefined);
    mediaStore.closeMedia.mockResolvedValue(undefined);
    mediaStore.addEvent.mockResolvedValue(undefined);
    getUserMedia = vi.fn(
      async (constraints: MediaStreamConstraints) =>
        new SyntheticStream([constraints.video ? videoTrack : microphoneTrack]),
    );
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('MediaRecorder', SyntheticRecorder);
    vi.stubGlobal('MediaStream', SyntheticStream);
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        if (tag === 'video')
          return {
            muted: false,
            srcObject: null,
            get readyState() {
              return frameEnabled ? 2 : 0;
            },
            videoWidth: 640,
            videoHeight: 480,
            play: () => playVideo(),
            pause: () => undefined,
          };
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: () => undefined }),
          toBlob: (callback: (value: Blob | null) => void) => {
            frameCallback = callback;
            if (!frameDeferred) callback(new Blob(['synthetic-jpeg']));
          },
        };
      },
    });
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'synthetic',
        getURL: (path: string) => url + path,
        onMessage: {
          addListener: (callback: RuntimeListener) => {
            listener = callback;
          },
        },
        sendMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    });
    await import('../src/offscreen');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  it('persists independent overlapping audio segments and closes video before reporting stopped', async () => {
    expect(
      await request({
        target: 'offscreen',
        type: 'record',
        sessionId: 'session',
        streamId: 'stream',
      }),
    ).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await request({ target: 'offscreen', type: 'finish' })).toEqual({
      ok: true,
    });
    expect(saved.audio.map((segment) => [segment.start, segment.end])).toEqual([
      [0, 60_000],
      [59_000, 61_000],
    ]);
    expect(saved.duration).toBe(61_000);
    expect(saved.status).toBe('stopped');
    expect(mediaStore.closeMedia).toHaveBeenCalledWith(
      'session/recording.webm',
    );
    expect(mediaStore.writeMedia).toHaveBeenCalledWith(
      'session/recording.webm',
      expect.any(Blob),
      true,
    );
    expect(videoTrack.stopped && microphoneTrack.stopped).toBe(true);
  });
  it('releases already-acquired tab video when microphone capture is denied', async () => {
    getUserMedia.mockImplementation(
      async (constraints: MediaStreamConstraints) => {
        if (constraints.audio) throw new Error('Synthetic permission denial.');
        return new SyntheticStream([videoTrack]);
      },
    );
    expect(
      await request({
        target: 'offscreen',
        type: 'record',
        sessionId: 'session',
        streamId: 'stream',
      }),
    ).toMatchObject({ ok: false });
    expect(videoTrack.stopped).toBe(true);
    expect(mediaStore.writeMedia).not.toHaveBeenCalled();
  });
  it('waits for an in-flight frame even when the frame sampling interval fires again', async () => {
    frameEnabled = true;
    await request({
      target: 'offscreen',
      type: 'record',
      sessionId: 'session',
      streamId: 'stream',
    });
    frameDeferred = true;
    await vi.advanceTimersByTimeAsync(5000);
    let completed = false;
    const stopped = request({ target: 'offscreen', type: 'finish' }).then(
      (reply) => {
        completed = true;
        return reply;
      },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toBe(false);
    if (!frameCallback) throw new Error('Frame encoding did not begin.');
    frameCallback(new Blob(['synthetic-jpeg']));
    expect(await stopped).toEqual({ ok: true });
    expect(saved.frames).toHaveLength(2);
    expect(saved.status).toBe('stopped');
  });
  it('keeps disk flush latency outside the measured media duration', async () => {
    let release: (() => void) | undefined;
    const pendingWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    await request({
      target: 'offscreen',
      type: 'record',
      sessionId: 'session',
      streamId: 'stream',
    });
    mediaStore.writeMedia.mockImplementation(async () => pendingWrite);
    await vi.advanceTimersByTimeAsync(1000);
    const stopped = request({ target: 'offscreen', type: 'finish' });
    await vi.advanceTimersByTimeAsync(5000);
    if (!release) throw new Error('Synthetic write was not initialized.');
    release();
    expect(await stopped).toEqual({ ok: true });
    expect(saved.duration).toBe(1000);
    expect(saved.audio[0]?.end).toBe(1000);
  });
  it('releases media and retains interrupted state when final video close fails', async () => {
    await request({
      target: 'offscreen',
      type: 'record',
      sessionId: 'session',
      streamId: 'stream',
    });
    await vi.advanceTimersByTimeAsync(1000);
    mediaStore.closeMedia.mockRejectedValueOnce(
      new Error('Synthetic storage close failure.'),
    );
    expect(
      await request({ target: 'offscreen', type: 'finish' }),
    ).toMatchObject({ ok: false });
    expect(saved.status).toBe('interrupted');
    expect(saved.error).toContain('finalization failed');
    expect(saved.audio).toHaveLength(1);
    expect(videoTrack.stopped && microphoneTrack.stopped).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'background',
      type: 'recording-ended',
      sessionId: 'session',
    });
  });
  it('closes the recording handle even if both media and gap persistence fail', async () => {
    await request({
      target: 'offscreen',
      type: 'record',
      sessionId: 'session',
      streamId: 'stream',
    });
    await vi.advanceTimersByTimeAsync(1000);
    mediaStore.writeMedia.mockImplementation(
      async (_path: string, _blob: Blob, append: boolean) => {
        if (append) throw new Error('Synthetic disk failure');
      },
    );
    mediaStore.addEvent.mockRejectedValue(new Error('Synthetic quota failure'));
    expect(
      await request({ target: 'offscreen', type: 'finish' }),
    ).toMatchObject({ ok: true });
    expect(saved.status).toBe('interrupted');
    expect(mediaStore.closeMedia).toHaveBeenCalledWith(
      'session/recording.webm',
    );
    expect(videoTrack.stopped && microphoneTrack.stopped).toBe(true);
  });
  it('recovers an interrupted checkpoint when the first final metadata write fails', async () => {
    await request({
      target: 'offscreen',
      type: 'record',
      sessionId: 'session',
      streamId: 'stream',
    });
    await vi.advanceTimersByTimeAsync(1000);
    const save = mediaStore.saveSession.getMockImplementation();
    mediaStore.saveSession.mockImplementation(async (session: Session) => {
      if (session.status === 'stopped')
        throw new Error('Synthetic metadata write failure.');
      await save?.(session);
    });
    expect(
      await request({ target: 'offscreen', type: 'finish' }),
    ).toMatchObject({ ok: false });
    expect(saved.status).toBe('interrupted');
    expect(videoTrack.stopped && microphoneTrack.stopped).toBe(true);
  });
  it('times out pending media permission and disposes a stream that arrives late', async () => {
    let allow: ((stream: SyntheticStream) => void) | undefined;
    getUserMedia.mockImplementation(
      () =>
        new Promise<SyntheticStream>((resolve) => {
          allow = resolve;
        }),
    );
    const started = request({
      target: 'offscreen',
      type: 'record',
      sessionId: 'session',
      streamId: 'stream',
    });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await started).toMatchObject({ ok: false });
    if (!allow) throw new Error('Synthetic permission request did not start.');
    allow(new SyntheticStream([videoTrack]));
    await vi.advanceTimersByTimeAsync(1);
    expect(videoTrack.stopped).toBe(true);
  });
  it('honors stop while tab permission is still pending without starting a late recorder', async () => {
    let allow: ((stream: SyntheticStream) => void) | undefined;
    getUserMedia.mockImplementation(
      () =>
        new Promise<SyntheticStream>((resolve) => {
          allow = resolve;
        }),
    );
    const started = request({
      target: 'offscreen',
      type: 'record',
      sessionId: 'session',
      streamId: 'stream',
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(await request({ target: 'offscreen', type: 'finish' })).toEqual({
      ok: true,
    });
    if (!allow) throw new Error('Synthetic permission request did not start.');
    allow(new SyntheticStream([videoTrack]));
    expect(await started).toMatchObject({ ok: false });
    expect(videoTrack.stopped).toBe(true);
    expect(mediaStore.writeMedia).not.toHaveBeenCalled();
  });
  it('honors stop while the first video frame is still pending', async () => {
    let play: (() => void) | undefined;
    playVideo = () =>
      new Promise<void>((resolve) => {
        play = resolve;
      });
    const started = request({
      target: 'offscreen',
      type: 'record',
      sessionId: 'session',
      streamId: 'stream',
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(await request({ target: 'offscreen', type: 'finish' })).toEqual({
      ok: true,
    });
    if (!play) throw new Error('Synthetic video playback did not start.');
    play();
    expect(await started).toMatchObject({ ok: false });
    expect(videoTrack.stopped && microphoneTrack.stopped).toBe(true);
    expect(mediaStore.writeMedia).not.toHaveBeenCalled();
  });
  it('automatically releases media after a recorder error even when gap persistence fails', async () => {
    await request({
      target: 'offscreen',
      type: 'record',
      sessionId: 'session',
      streamId: 'stream',
    });
    await vi.advanceTimersByTimeAsync(1000);
    mediaStore.addEvent.mockRejectedValue(
      new Error('Synthetic event quota failure.'),
    );
    SyntheticRecorder.instances[0]?.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(1);
    expect(videoTrack.stopped && microphoneTrack.stopped).toBe(true);
    expect(saved.status).toBe('interrupted');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'background',
      type: 'recording-ended',
      sessionId: 'session',
    });
  });
  it('automatically stops after a video write failure even if diagnostic storage also fails', async () => {
    await request({
      target: 'offscreen',
      type: 'record',
      sessionId: 'session',
      streamId: 'stream',
    });
    await vi.advanceTimersByTimeAsync(1000);
    mediaStore.writeMedia.mockImplementation(
      async (_path: string, _blob: Blob, append: boolean) => {
        if (append) throw new Error('Synthetic recording quota failure.');
      },
    );
    mediaStore.addEvent.mockRejectedValue(
      new Error('Synthetic event quota failure.'),
    );
    SyntheticRecorder.instances[0]?.dispatchEvent(
      Object.assign(new Event('dataavailable'), {
        data: new Blob(['synthetic-chunk']),
      }),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(videoTrack.stopped && microphoneTrack.stopped).toBe(true);
    expect(saved.status).toBe('interrupted');
  });
  it('rejects startup and cleans up media if the initial evidence frame cannot be stored', async () => {
    mediaStore.writeMedia.mockImplementation(async (path: string) => {
      if (path.endsWith('.jpg'))
        throw new Error('Synthetic frame storage failure.');
    });
    expect(
      await request({
        target: 'offscreen',
        type: 'record',
        sessionId: 'session',
        streamId: 'stream',
      }),
    ).toMatchObject({ ok: false });
    expect(saved.status).toBe('interrupted');
    expect(saved.frames).toHaveLength(0);
    expect(videoTrack.stopped && microphoneTrack.stopped).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'background',
      type: 'recording-ended',
      sessionId: 'session',
    });
  });
  it('drains the final video write before closing after startup frame failure', async () => {
    let releaseVideo: (() => void) | undefined;
    mediaStore.writeMedia.mockImplementation(
      async (path: string, _blob: Blob, append: boolean) => {
        if (path.endsWith('.jpg')) throw new Error('Synthetic frame failure.');
        if (append)
          await new Promise<void>((resolve) => {
            releaseVideo = resolve;
          });
      },
    );
    const started = request({
      target: 'offscreen',
      type: 'record',
      sessionId: 'session',
      streamId: 'stream',
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(mediaStore.closeMedia).not.toHaveBeenCalled();
    if (!releaseVideo)
      throw new Error('Final synthetic video write was not started.');
    releaseVideo();
    expect(await started).toMatchObject({ ok: false });
    expect(mediaStore.closeMedia).toHaveBeenCalledWith(
      'session/recording.webm',
    );
    expect(videoTrack.stopped && microphoneTrack.stopped).toBe(true);
  });
});
