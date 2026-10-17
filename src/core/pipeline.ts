import { withSessionLock } from './lock';
import { validateSession } from './integrity';
import { analyze, transcribe } from '../providers/openrouter';
import { sanitize } from './sanitize';
import { getEvents, getMedia, getSession, saveSession } from './store';
import type { Finding, Frame, Session, Transcript } from './schema';

export type Progress = (message: string) => void;
export async function imageData(path: string): Promise<string> {
  const file = await getMedia(path);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Image could not be read.'));
    reader.onerror = () => reject(new Error('Image could not be read.'));
    reader.readAsDataURL(file);
  });
}
export function selectFrames(
  frames: Frame[],
  markerTimes: number[],
  quotes: Transcript[],
  start: number,
  end: number,
): Frame[] {
  const selected = new Map<string, Frame>();
  const candidates = frames.filter(
    (frame) =>
      frame.time >= Math.max(0, start - 30000) && frame.time <= end + 4000,
  );
  const targets = [
    ...markerTimes.flatMap((time) => [time - 2000, time + 2500]),
    ...quotes.map((quote) => quote.start),
  ];
  if (!targets.length) targets.push(start, (start + end) / 2, end);
  for (const target of targets) {
    const nearest = candidates.reduce<Frame | undefined>(
      (best, frame) =>
        !best || Math.abs(frame.time - target) < Math.abs(best.time - target)
          ? frame
          : best,
      undefined,
    );
    if (nearest) selected.set(nearest.id, nearest);
  }
  // Bound each request; prioritize marker and narration targets before general context.
  return [...selected.values()].slice(0, 12).sort((a, b) => a.time - b.time);
}
export function mergeFindings(
  existing: Finding[],
  incoming: Finding[],
): Finding[] {
  const merged = structuredClone(existing);
  for (const finding of incoming) {
    const match = merged.find(
      (item) =>
        item.page === finding.page &&
        item.title.toLowerCase() === finding.title.toLowerCase() &&
        item.description === finding.description &&
        finding.start <= item.end + 30000 &&
        item.start <= finding.end + 30000,
    );
    const evidenceIds = [
      ...new Set([...(match?.evidenceIds ?? []), ...finding.evidenceIds]),
    ];
    const quoteIds = [
      ...new Set([...(match?.quoteIds ?? []), ...finding.quoteIds]),
    ];
    const hypotheses = [
      ...new Set([...(match?.hypotheses ?? []), ...finding.hypotheses]),
    ];
    if (
      match &&
      match.expectedBehavior === finding.expectedBehavior &&
      JSON.stringify(match.reproduction) ===
        JSON.stringify(finding.reproduction) &&
      evidenceIds.length <= 40 &&
      quoteIds.length <= 40 &&
      hypotheses.length <= 10
    ) {
      match.start = Math.min(match.start, finding.start);
      match.end = Math.max(match.end, finding.end);
      match.evidenceIds = evidenceIds;
      match.quoteIds = quoteIds;
      match.hypotheses = hypotheses;
      if (match.association !== finding.association)
        match.association = 'uncertain';
    } else merged.push({ ...finding, id: `issue-${merged.length + 1}` });
  }
  return merged;
}
export function transferOverview(
  session: Session,
  events: Awaited<ReturnType<typeof getEvents>>,
  key: string,
) {
  const clean = sanitize(
    {
      notes: session.notes,
      url: session.url,
      events,
      transcript: session.transcript,
    },
    [key],
  );
  return {
    counts: clean.counts,
    audioSegments: session.audio.length,
    availableFrames: session.frames.length,
  };
}
async function processUnlocked(
  id: string,
  key: string,
  signal: AbortSignal,
  progress: Progress,
): Promise<Session> {
  let session = await getSession(id);
  if (session.status === 'recording')
    throw new Error('Stop recording before analysis.');
  if (!session.audio.length || !session.frames.length)
    throw new Error(
      'Audio or video evidence is missing. This interrupted session cannot be analyzed.',
    );
  validateSession(session, await getEvents(id));
  if (!(await getMedia(session.recordingPath)).size)
    throw new Error(
      'The local recording is empty. This session cannot be exported.',
    );
  session.status = 'processing';
  session.error = '';
  await saveSession(session);
  try {
    for (const segment of session.audio) {
      signal.throwIfAborted();
      if (session.completedSegments.includes(segment.id)) continue;
      progress(
        `Transcribing audio ${session.completedSegments.length + 1} of ${session.audio.length}…`,
      );
      const quotes = await transcribe(
        key,
        await getMedia(segment.path),
        segment,
        signal,
      );
      const clean = sanitize(quotes, [key]);
      // Overlapping audio preserves boundary speech. Remove only duplicates with both matching
      // text and overlapping actual timestamps, keeping corrections at other times intact.
      for (const quote of clean.value) {
        if (
          !session.transcript.some(
            (prior) =>
              prior.text.trim() === quote.text.trim() &&
              quote.start <= prior.end &&
              quote.end >= prior.start,
          )
        )
          session.transcript.push(quote);
      }
      session.transcript.sort((a, b) => a.start - b.start);
      session.completedSegments.push(segment.id);
      await saveSession(session);
    }
    const events = await getEvents(id);
    const overview = transferOverview(session, events, key);
    session.sanitization = overview.counts;
    const batchLength = 120000;
    const count = Math.max(1, Math.ceil(session.duration / batchLength));
    for (let index = 0; index < count; index++) {
      signal.throwIfAborted();
      const batchId = `batch-${index}`;
      if (session.completedBatches.includes(batchId)) continue;
      progress(`Analyzing evidence ${index + 1} of ${count}…`);
      const start = index * batchLength;
      const end = Math.min(session.duration, start + batchLength);
      const transcript = session.transcript.filter(
        (quote) =>
          quote.end >= Math.max(0, start - 30000) && quote.start <= end,
      );
      const contextEvents = events.filter(
        (event) =>
          event.time >= Math.max(0, start - 30000) && event.time <= end + 4000,
      );
      const markers = contextEvents.filter(
        (event) => event.type === 'point' || event.type === 'rectangle',
      );
      const frames = selectFrames(
        session.frames,
        markers.map((event) => event.time),
        transcript,
        start,
        end,
      );
      const images = [];
      for (const frame of frames)
        images.push({
          ...frame,
          dataUrl: await imageData(`${id}/${frame.path}`),
        });
      const clean = sanitize({ transcript, events: contextEvents }, [key]);
      const findings = await analyze(
        key,
        {
          ...clean.value,
          notes: session.notes,
          frames: images,
          duration: session.duration,
        },
        signal,
      );
      session.findings = mergeFindings(
        session.findings,
        sanitize(findings, [key]).value,
      );
      session.completedBatches.push(batchId);
      await saveSession(session);
    }
    session.status = 'complete';
    session.error = '';
    validateSession(session, events);
    await saveSession(session);
    progress(
      'Analysis complete. Findings are automatically generated and unreviewed.',
    );
    return session;
  } catch (error) {
    session = await getSession(id);
    session.status = 'failed';
    session.error = signal.aborted
      ? 'Analysis canceled. Completed steps are saved; retry to continue.'
      : error instanceof Error
        ? sanitize(error.message, [key]).value
        : 'Analysis failed. Retry to continue.';
    await saveSession(session);
    throw new Error(session.error);
  }
}

export async function processSession(
  id: string,
  key: string,
  signal: AbortSignal,
  progress: Progress,
): Promise<Session> {
  return withSessionLock(id, () => processUnlocked(id, key, signal, progress));
}
