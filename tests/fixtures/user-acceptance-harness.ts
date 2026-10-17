import { MODELS, SessionSchema } from '../../src/core/schema';
import {
  addEvent,
  closeMedia,
  getEvents,
  getMedia,
  getSession,
  listSessions,
  saveSession,
  writeMedia,
} from '../../src/core/store';

async function decoded(blob: Blob, audio: boolean): Promise<void> {
  const element = document.createElement(audio ? 'audio' : 'video');
  const url = URL.createObjectURL(blob);
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Recorded media decoding timed out.')),
      10_000,
    );
    element.onloadeddata = () => {
      clearTimeout(timer);
      resolve();
    };
    element.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Recorded media could not be decoded.'));
    };
  });
  element.muted = true;
  element.src = url;
  try {
    await ready;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A deliberately separate partial path; never substitutes for tab capture readiness. */
async function seedSyntheticCanvasSession(pageUrl: string): Promise<string> {
  const id = `synthetic-canvas-${crypto.randomUUID()}`;
  const recordingPath = `${id}/recording.webm`;
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 450;
  document.body.append(canvas);
  const drawing = canvas.getContext('2d');
  if (!drawing) throw new Error('Synthetic canvas is unavailable.');
  const paint = () => {
    drawing.fillStyle = '#f5f6f8';
    drawing.fillRect(0, 0, 800, 450);
    drawing.fillStyle = '#202b3c';
    drawing.fillRect(0, 0, 800, 60);
    drawing.fillStyle = 'white';
    drawing.font = '22px sans-serif';
    drawing.fillText('Synthetic workspace', 30, 38);
    drawing.fillStyle = 'white';
    drawing.fillRect(70, 100, 660, 270);
    drawing.fillStyle = '#202b3c';
    drawing.fillText('Review changes', 100, 145);
    drawing.font = '18px sans-serif';
    drawing.fillText('Review the update before continuing.', 100, 195);
    drawing.fillStyle = '#a13d33';
    drawing.fillRect(100, 230, 115, 48);
    drawing.fillStyle = 'white';
    drawing.fillText('Cancel', 125, 260);
  };
  paint();
  const animation = setInterval(paint, 100);
  const microphone = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  const video = canvas.captureStream(10);
  const combined = new MediaStream([
    ...video.getTracks(),
    ...microphone.getTracks(),
  ]);
  const recording = new MediaRecorder(combined, {
    mimeType: 'video/webm;codecs=vp8,opus',
  });
  const speech = new MediaRecorder(microphone, {
    mimeType: 'audio/webm;codecs=opus',
  });
  const chunks: Blob[] = [];
  let writes = Promise.resolve();
  recording.ondataavailable = (event) => {
    if (event.data.size)
      writes = writes.then(() => writeMedia(recordingPath, event.data, true));
  };
  speech.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  const videoStopped = new Promise<void>((resolve) => {
    recording.onstop = () => resolve();
  });
  const speechStopped = new Promise<void>((resolve) => {
    speech.onstop = () => resolve();
  });
  const created = Date.now();
  const start = performance.now();
  try {
    recording.start(1000);
    speech.start();
    const frames = [];
    for (const [index, wait] of [1000, 4000].entries()) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      const time = performance.now() - start;
      const image = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error('Synthetic frame failed.')),
          'image/jpeg',
        ),
      );
      const path = `screenshots/frame-${index + 1}.jpg`;
      await writeMedia(`${id}/${path}`, image);
      frames.push({
        id: `frame-${index + 1}`,
        path,
        time,
        eventIds: ['synthetic-marker'],
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
    recording.stop();
    speech.stop();
    await Promise.all([videoStopped, speechStopped]);
    await writes;
    await closeMedia(recordingPath);
    const duration = performance.now() - start;
    const audioPath = `${id}/audio/audio-1.webm`;
    await writeMedia(audioPath, new Blob(chunks, { type: 'audio/webm' }));
    await saveSession(
      SessionSchema.parse({
        schemaVersion: 1,
        id,
        createdAt: created,
        tabId: 1,
        url: pageUrl,
        notes: {
          project: 'Synthetic canvas partial acceptance',
          objective:
            'Verify live provider and UI export independently of unavailable tab capture.',
          environment:
            'Synthetic canvas video and prerecorded synthetic microphone.',
          reference: 'synthetic-fixture',
        },
        status: 'stopped',
        startedAt: created,
        duration,
        diagnostics: false,
        models: MODELS,
        audio: [{ id: 'audio-1', path: audioPath, start: 0, end: duration }],
        transcript: [],
        frames,
        findings: [],
        completedSegments: [],
        completedBatches: [],
        error: '',
        recordingPath,
        sanitization: {},
      }),
    );
    await addEvent({
      id: 'synthetic-marker',
      sessionId: id,
      time: 1000,
      type: 'point',
      url: pageUrl,
      data: {
        x: 160,
        y: 250,
        selection:
          'The blue primary button is missing. password=synthetic-context-secret',
        source: 'synthetic-canvas-partial',
      },
    });
    return id;
  } finally {
    clearInterval(animation);
    if (recording.state !== 'inactive') recording.stop();
    if (speech.state !== 'inactive') speech.stop();
    combined.getTracks().forEach((track) => track.stop());
    canvas.remove();
  }
}
async function inspectAcceptanceSession(id: string) {
  const session = await getSession(id);
  const video = await getMedia(session.recordingPath);
  await decoded(video, false);
  for (const segment of session.audio)
    await decoded(await getMedia(segment.path), true);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await video.arrayBuffer(),
  );
  return {
    session,
    events: await getEvents(id),
    videoHash: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
    videoBytes: video.size,
  };
}
Object.assign(globalThis, {
  seedSyntheticCanvasSession,
  inspectAcceptanceSession,
  acceptanceSessions: listSessions,
});
