import {
  MessageSchema,
  type Session,
  type AudioSegment,
  type Failure,
} from './core/schema';
import {
  getSession,
  saveSession,
  writeMedia,
  closeMedia,
  addEvent,
} from './core/store';
import { sessionTime } from './capture/timeline';
import { acquireMedia } from './core/media';
import { OperationError, appendFailure, failureDetail } from './core/failures';

interface Capture {
  session: Session;
  tab: MediaStream;
  microphone: MediaStream;
  recorder: MediaRecorder;
  audioRecorders: Set<MediaRecorder>;
  pendingAudio: Set<Promise<void>>;
  writes: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  frames: ReturnType<typeof setInterval>;
  segmentTimer: ReturnType<typeof setInterval>;
  video: HTMLVideoElement;
  frameBusy: boolean;
  frameWork: Promise<void>;
  pendingChunks: number;
  recordedBytes: number;
  stopping: boolean;
  error: string;
}
let capture: Capture | undefined;
let finishing: Promise<void> | undefined;
let pendingStart:
  { canceled: boolean; controller: AbortController } | undefined;
const MIME = 'video/webm;codecs=vp8,opus';
const AUDIO_MIME = 'audio/webm;codecs=opus';
function safeCaptureFailure(
  error: unknown,
  phase: Failure['phase'],
  stepId: string,
  message: string,
): Failure {
  const knownNative =
    error instanceof Error &&
    [
      'NotAllowedError',
      'NotFoundError',
      'NotReadableError',
      'QuotaExceededError',
      'AbortError',
      'ZodError',
    ].includes(error.name);
  return failureDetail(
    error instanceof OperationError || knownNative
      ? error
      : new OperationError(`${phase}-${stepId}`, message),
    phase,
    stepId,
  );
}
async function recordGap(
  current: Capture,
  reason: string,
  code = 'capture-gap',
): Promise<void> {
  current.error = reason;
  const previous = current.session.failures?.at(-1);
  if (previous?.code !== code || previous.message !== reason)
    appendFailure(
      current.session,
      failureDetail(new OperationError(code, reason), 'capture'),
    );

  await addEvent({
    id: crypto.randomUUID(),
    sessionId: current.session.id,
    time: sessionTime(current.session.startedAt),
    type: 'gap',
    url: current.session.url,
    data: { reason },
  }).catch(() => undefined);
}
function interrupt(
  current: Capture,
  reason: string,
  code = 'capture-interrupted',
): void {
  current.error = reason;
  // Stopping is independent of persistence: quota failures must not leave capture running.
  const stopped = finish();
  void (async () => {
    try {
      await recordGap(current, reason, code);
    } finally {
      await stopped;
    }
  })().catch(() => undefined);
}
function startAudio(current: Capture): void {
  if (current.stopping) return;
  const recorder = new MediaRecorder(current.microphone, {
    mimeType: AUDIO_MIME,
    audioBitsPerSecond: 64_000,
  });
  const start = sessionTime(current.session.startedAt);
  const segment: AudioSegment = {
    id: crypto.randomUUID(),
    start,
    end: start,
    path: '',
  };
  segment.path = `${current.session.id}/audio/${segment.id}.webm`;
  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  current.audioRecorders.add(recorder);
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  current.pendingAudio.add(done);
  const stopTimer = setTimeout(() => {
    if (recorder.state !== 'inactive') recorder.stop();
  }, 60_000);
  recorder.addEventListener('stop', () => {
    clearTimeout(stopTimer);
    current.audioRecorders.delete(recorder);
    segment.end = sessionTime(current.session.startedAt);
    void (async () => {
      try {
        if (chunks.length) {
          await writeMedia(
            segment.path,
            new Blob(chunks, { type: AUDIO_MIME }),
          );
          current.session.audio.push(segment);
          await saveSession(current.session);
        }
      } catch {
        interrupt(
          current,
          'An audio segment could not be stored.',
          'audio-segment-storage',
        );
      } finally {
        current.pendingAudio.delete(done);
        resolveDone();
      }
    })();
  });
  recorder.addEventListener('error', () => {
    interrupt(
      current,
      'Microphone segment recording failed.',
      'audio-recorder-failed',
    );
  });
  try {
    recorder.start();
  } catch {
    clearTimeout(stopTimer);
    current.audioRecorders.delete(recorder);
    current.pendingAudio.delete(done);
    resolveDone();
    throw new OperationError(
      'audio-start-failed',
      'Microphone segment recording could not start.',
    );
  }
}
async function saveFrame(current: Capture, required = false): Promise<void> {
  if (current.frameBusy || current.stopping || current.video.readyState < 2) {
    if (required) throw new Error('Initial video evidence is unavailable.');
    return;
  }
  current.frameBusy = true;
  const time = sessionTime(current.session.startedAt);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(960, current.video.videoWidth);
    if (!canvas.width || !current.video.videoHeight)
      throw new Error('Video evidence has no usable dimensions.');
    canvas.height = Math.round(
      (current.video.videoHeight * canvas.width) / current.video.videoWidth,
    );
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Frame canvas is unavailable.');
    context.drawImage(current.video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error('Frame encoding failed.')),
        'image/jpeg',
        0.75,
      ),
    );
    const frame = {
      id: `frame-${Math.round(time)}`,
      time,
      path: `screenshots/frame-${Math.round(time)}.jpg`,
      eventIds: [],
    };
    await writeMedia(`${current.session.id}/${frame.path}`, blob);
    current.session.frames.push(frame);
    await saveSession(current.session);
  } catch {
    await recordGap(
      current,
      'An evidence frame could not be stored.',
      'frame-storage-failed',
    );
    if (required)
      throw new Error('Initial video evidence could not be stored.');
  } finally {
    current.frameBusy = false;
  }
}
async function begin(sessionId: string, streamId: string): Promise<void> {
  if (capture || finishing || pendingStart)
    throw new Error('A recording is already active.');
  const starting = { canceled: false, controller: new AbortController() };
  pendingStart = starting;
  let tab: MediaStream | undefined;
  let microphone: MediaStream | undefined;
  let setupSession: Session | undefined;
  let stepId = 'session';
  const setupMessage: Record<string, string> = {
    session: 'The local recording session could not be opened.',
    format:
      'This browser does not support the required WebM recording formats.',
    'tab-capture':
      'The selected tab could not be captured. Reopen the toolbar on the tested tab and try again.',
    'microphone-capture':
      'The microphone could not be captured. Check microphone permission and the selected input.',
    'video-recorder':
      'The video recorder could not be created or started. Check browser recording support.',
    'video-playback':
      'The selected tab did not produce video frames. Keep it open and try again.',
    'audio-recorder': 'Microphone segment recording could not start.',
    'initial-frame':
      'Initial video evidence could not be stored. Check available local storage.',
    checkpoint:
      'The recording checkpoint could not be saved. Check available local storage.',
  };
  try {
    const session = await getSession(sessionId);
    setupSession = session;
    if (!session) throw new Error('Recording session was not found.');
    if (starting.canceled) throw new Error('Recording setup was canceled.');
    stepId = 'format';
    if (
      !MediaRecorder.isTypeSupported(MIME) ||
      !MediaRecorder.isTypeSupported(AUDIO_MIME)
    )
      throw new Error(
        'This browser does not support the required WebM recording formats.',
      );
    const videoConstraints: MediaTrackConstraints & {
      mandatory: {
        chromeMediaSource: string;
        chromeMediaSourceId: string;
        maxWidth: number;
        maxHeight: number;
        maxFrameRate: number;
      };
    } = {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 15,
      },
    };
    stepId = 'tab-capture';
    tab = await acquireMedia(
      { audio: false, video: videoConstraints },
      starting.controller.signal,
    );
    if (starting.canceled) throw new Error('Recording setup was canceled.');
    stepId = 'microphone-capture';
    microphone = await acquireMedia(
      {
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      },
      starting.controller.signal,
    );
    if (starting.canceled) throw new Error('Recording setup was canceled.');
    const stream = new MediaStream([
      ...tab.getVideoTracks(),
      ...microphone.getAudioTracks(),
    ]);
    stepId = 'video-recorder';
    const recorder = new MediaRecorder(stream, {
      mimeType: MIME,
      videoBitsPerSecond: 1_200_000,
      audioBitsPerSecond: 64_000,
    });
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = tab;
    stepId = 'video-playback';
    let playbackTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        video.play(),
        new Promise<never>((_resolve, reject) => {
          playbackTimer = setTimeout(
            () =>
              reject(
                new Error('The selected tab did not produce video frames.'),
              ),
            10_000,
          );
        }),
      ]);
    } finally {
      if (playbackTimer) clearTimeout(playbackTimer);
    }
    if (starting.canceled) throw new Error('Recording setup was canceled.');
    session.startedAt = Date.now();
    const current: Capture = {
      session,
      tab,
      microphone,
      recorder,
      video,
      audioRecorders: new Set(),
      pendingAudio: new Set(),
      writes: Promise.resolve(),
      timer: setTimeout(() => {
        void finish().catch(() => undefined);
      }, 30 * 60_000),
      frames: setInterval(() => {
        if (!current.frameBusy) current.frameWork = saveFrame(current);
      }, 2000),
      segmentTimer: setInterval(() => {
        try {
          startAudio(current);
        } catch {
          interrupt(
            current,
            'Microphone segment recording could not start.',
            'audio-start-failed',
          );
        }
      }, 59_000),
      frameBusy: false,
      frameWork: Promise.resolve(),
      pendingChunks: 0,
      recordedBytes: 0,
      stopping: false,
      error: '',
    };
    capture = current;
    recorder.addEventListener('dataavailable', (event) => {
      if (!event.data.size) return;
      if (++current.pendingChunks > 10 && !current.stopping) {
        interrupt(current, 'Recording storage could not keep up with capture.');
      }
      current.writes = current.writes
        .then(async () => {
          await writeMedia(session.recordingPath, event.data, true);
          current.recordedBytes += event.data.size;
        })
        .catch(() => {
          interrupt(
            current,
            'Recording storage failed. Check available local storage.',
          );
        })
        .finally(() => {
          current.pendingChunks--;
        });
    });
    recorder.addEventListener('error', () => {
      interrupt(current, 'The video recorder failed.', 'video-recorder-failed');
    });
    const updateTrackStatus = () => {
      void chrome.runtime
        .sendMessage({
          target: 'background',
          type: 'capture-status',
          sessionId: session.id,
          microphone: current.microphone
            .getAudioTracks()
            .some((track) => track.muted)
            ? 'muted'
            : 'recording',
          recording: current.tab.getVideoTracks().some((track) => track.muted)
            ? 'muted'
            : 'recording',
        })
        .catch(() => undefined);
    };
    for (const track of [...tab.getTracks(), ...microphone.getTracks()]) {
      track.addEventListener('mute', () => {
        if (!current.stopping) {
          updateTrackStatus();
          void recordGap(
            current,
            `${track.kind === 'audio' ? 'Microphone' : 'Tab video'} capture was muted.`,
          );
        }
      });
      track.addEventListener('unmute', () => {
        if (!current.stopping) {
          updateTrackStatus();
          void addEvent({
            id: crypto.randomUUID(),
            sessionId: session.id,
            time: sessionTime(session.startedAt),
            type: 'status',
            url: session.url,
            data: {
              reason: `${track.kind === 'audio' ? 'Microphone' : 'Tab video'} capture resumed.`,
            },
          }).catch(() => undefined);
        }
      });
      track.addEventListener('ended', () => {
        if (current.stopping) return;
        if (track.kind === 'video') {
          const stoppedAt = sessionTime(current.session.startedAt);
          // Closing the recorded tab or ending browser sharing is a normal stop.
          // Finalization failures still retain their interrupted status.
          void finish().catch(() => undefined);
          void addEvent({
            id: crypto.randomUUID(),
            sessionId: session.id,
            time: stoppedAt,
            type: 'status',
            url: session.url,
            data: {
              reason:
                'Tab video capture ended; recording finalization started.',
            },
          }).catch(() => undefined);
        } else interrupt(current, 'The microphone capture track ended.');
      });
    }
    stepId = 'video-recorder';
    recorder.start(1000);
    stepId = 'audio-recorder';
    startAudio(current);
    stepId = 'checkpoint';
    await saveSession(session);
    if (current.stopping) throw new Error('Recording setup was canceled.');
    stepId = 'initial-frame';
    current.frameWork = saveFrame(current, true);
    await current.frameWork;
    if (current.stopping) throw new Error('Recording setup was canceled.');
  } catch (error) {
    const failure = safeCaptureFailure(
      starting.canceled ? new DOMException('Canceled.', 'AbortError') : error,
      'setup',
      stepId,
      setupMessage[stepId] ?? 'Recording setup could not complete.',
    );
    if (setupSession) appendFailure(setupSession, failure);
    if (capture) {
      capture.error = failure.message;
      // Finalization may fail too; keep its history without replacing the original setup reply.
      await finish().catch(() => undefined);
    } else {
      tab?.getTracks().forEach((track) => track.stop());
      microphone?.getTracks().forEach((track) => track.stop());
      if (setupSession) {
        setupSession.status = 'interrupted';
        await saveSession(setupSession).catch(() => undefined);
      }
    }
    throw new OperationError(failure.code, failure.message, failure.retryable);
  } finally {
    if (pendingStart === starting) pendingStart = undefined;
  }
}
function finish(): Promise<void> {
  if (finishing) return finishing;
  const current = capture;
  if (!current) {
    if (pendingStart) {
      pendingStart.canceled = true;
      pendingStart.controller.abort(
        new DOMException('Recording setup was canceled.', 'AbortError'),
      );
    }
    return Promise.resolve();
  }
  current.stopping = true;
  void chrome.runtime
    .sendMessage({
      target: 'background',
      type: 'capture-status',
      sessionId: current.session.id,
      microphone: 'stopped',
      recording: 'stopped',
    })
    .catch(() => undefined);
  clearTimeout(current.timer);
  clearInterval(current.frames);
  clearInterval(current.segmentTimer);
  finishing = (async () => {
    let mediaStopTime = sessionTime(current.session.startedAt);
    let mediaClosed = false;
    let finalStepId = 'recorder-stop';
    const updateDuration = () => {
      current.session.duration = Math.max(
        mediaStopTime,
        ...current.session.audio.map((segment) => segment.end),
        ...current.session.frames.map((frame) => frame.time),
      );
    };
    try {
      const stopped = new Promise<void>((resolve) => {
        if (current.recorder.state === 'inactive') resolve();
        else {
          current.recorder.addEventListener('stop', () => resolve(), {
            once: true,
          });
          current.recorder.stop();
        }
      });
      for (const recorder of current.audioRecorders)
        if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      mediaStopTime = sessionTime(current.session.startedAt);
      finalStepId = 'audio-finalization';
      await Promise.all(current.pendingAudio);
      finalStepId = 'evidence-finalization';
      const finalized = await Promise.allSettled([
        current.frameWork,
        current.writes,
      ]);
      finalStepId = 'video-close';
      await closeMedia(current.session.recordingPath);
      mediaClosed = true;
      if (finalized.some((result) => result.status === 'rejected'))
        throw new Error('Capture evidence could not be finalized.');
      finalStepId = 'video-data';
      if (!current.recordedBytes && !current.error)
        throw new OperationError(
          'recording-empty',
          'No video data was saved before recording stopped. Start a new recording and allow it to capture video before stopping.',
          false,
        );
      updateDuration();
      current.session.status = current.error ? 'interrupted' : 'stopped';
      current.session.error = current.error;
      finalStepId = 'checkpoint';
      await saveSession(current.session);
    } catch (error) {
      updateDuration();
      current.session.status = 'interrupted';
      const failure = safeCaptureFailure(
        error,
        'finalization',
        finalStepId,
        'Recording finalization failed. Existing local evidence was retained; some media may be incomplete.',
      );
      appendFailure(current.session, failure);
      await saveSession(current.session).catch(() => undefined);
      throw new OperationError(
        failure.code,
        failure.message,
        failure.retryable,
      );
    } finally {
      current.tab.getTracks().forEach((track) => track.stop());
      current.microphone.getTracks().forEach((track) => track.stop());
      current.video.pause();
      current.video.srcObject = null;
      if (!mediaClosed)
        await closeMedia(current.session.recordingPath).catch(() => undefined);
      capture = undefined;
      await chrome.runtime
        .sendMessage({
          target: 'background',
          type: 'recording-ended',
          sessionId: current.session.id,
        })
        .catch(() => undefined);
      finishing = undefined;
    }
  })();
  return finishing;
}
chrome.runtime.onMessage.addListener((raw: unknown, sender, reply) => {
  const parsed = MessageSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.target !== 'offscreen' ||
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL(''))
  )
    return false;
  const message = parsed.data;
  const operation =
    message.type === 'record'
      ? begin(message.sessionId, message.streamId)
      : finish();
  void operation.then(
    () => reply({ ok: true }),
    (error: unknown) =>
      reply({
        ok: false,
        error: safeCaptureFailure(
          error,
          message.type === 'record' ? 'setup' : 'finalization',
          'capture-operation',
          'Capture could not start or finalize. Check microphone permission, tab availability, and local storage.',
        ).message,
      }),
  );
  return true;
});
