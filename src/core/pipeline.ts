import { withSessionLock } from './lock';
import { validateSession } from './integrity';
import { analyze, transcribe } from '../providers/openrouter';
import { sanitize } from './sanitize';
import { OperationError, appendFailure, failureDetail } from './failures';
import { selectAnalysisContext } from './context';
import {
  addEvent,
  getEvents,
  getMedia,
  getSession,
  saveSession,
} from './store';
import type { Failure, Finding, Frame, Session, Transcript } from './schema';

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
  const addTargets = (times: number[], limit = 12): void => {
    const targets = [...new Set(times)].sort((a, b) => a - b);
    const capacity = Math.min(limit, 12 - selected.size);
    if (!capacity || !targets.length) return;
    const sampled =
      targets.length <= capacity
        ? targets
        : Array.from(
            { length: capacity },
            (_, index) =>
              targets[
                capacity === 1
                  ? Math.floor(targets.length / 2)
                  : Math.round((index * (targets.length - 1)) / (capacity - 1))
              ],
          ).filter((time) => time !== undefined);
    for (const target of sampled) {
      const nearest = candidates.reduce<Frame | undefined>(
        (best, frame) =>
          !best || Math.abs(frame.time - target) < Math.abs(best.time - target)
            ? frame
            : best,
        undefined,
      );
      if (nearest) selected.set(nearest.id, nearest);
    }
  };
  // Reserve half the budget for markers so dense narration cannot crowd them out.
  addTargets(
    quotes.map((quote) => quote.start),
    markerTimes.length ? 6 : 12,
  );
  addTargets(markerTimes.map((time) => time - 2000));
  addTargets(markerTimes.map((time) => time + 2500));
  addTargets(quotes.map((quote) => quote.start));
  if (!quotes.length && !markerTimes.length)
    addTargets([start, (start + end) / 2, end]);
  return [...selected.values()].sort((a, b) => a.time - b.time);
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
  const counts: Record<string, number> = {};
  // The overview needs counts only; avoid cloning an entire long diagnostic trail.
  for (const item of [
    session.notes,
    session.url,
    ...session.transcript,
    ...events,
  ]) {
    const clean = sanitize(item, [key]);
    for (const [kind, amount] of Object.entries(clean.counts))
      counts[kind] = (counts[kind] ?? 0) + amount;
  }
  return {
    counts,
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
  // A live offscreen recorder owns its checkpoint; analysis must never rewrite it as failed.
  if (session.status === 'recording')
    throw new OperationError(
      'recording-active',
      'Stop recording before analysis.',
    );
  let phase: Failure['phase'] = 'validation';
  let stepId = 'session';
  const loadEvidence = async (path: string): Promise<Blob> => {
    let media: Blob;
    try {
      media = await getMedia(path);
    } catch (error) {
      const missing = error instanceof Error && error.name === 'NotFoundError';
      throw new OperationError(
        missing ? 'media-unavailable' : 'media-read-failed',
        missing
          ? 'A required local media file is missing. Retained evidence has not been discarded; record a new session.'
          : 'A local media file could not be read. Retained evidence remains saved; check storage access and retry.',
        !missing,
      );
    }
    if (!media.size)
      throw new OperationError(
        'media-empty',
        'A required local recording is empty. This session cannot be processed or exported.',
        false,
      );
    return media;
  };
  try {
    signal.throwIfAborted();
    if (!session.audio.length || !session.frames.length)
      throw new OperationError(
        'media-missing',
        'Audio or video evidence is missing. This interrupted session cannot be analyzed.',
        false,
      );
    stepId = 'events';
    const events = await getEvents(id).catch((error: unknown) => {
      const invalid = error instanceof Error && error.name === 'ZodError';
      throw new OperationError(
        invalid ? 'invalid-session' : 'event-read-failed',
        invalid
          ? 'Stored event data does not match the supported format. Retained evidence has not been discarded.'
          : 'Local session events could not be read. Retained evidence remains saved; check storage access and retry.',
        !invalid,
      );
    });
    stepId = 'session';
    try {
      validateSession(session, events);
    } catch {
      throw new OperationError(
        'invalid-session',
        'Session evidence or checkpoints are inconsistent. Retained evidence has not been discarded.',
        false,
      );
    }
    stepId = 'recording';
    await loadEvidence(session.recordingPath);
    // Check every required file before any paid request: a later missing segment or image
    // must not spend provider credit, including when the user retries the same session.
    for (const segment of session.audio) {
      signal.throwIfAborted();
      stepId = segment.id;
      await loadEvidence(segment.path);
    }
    for (const frame of session.frames) {
      signal.throwIfAborted();
      stepId = frame.id;
      await loadEvidence(`${id}/${frame.path}`);
    }
    stepId = 'checkpoint';
    session.status = 'processing';
    session.error = '';
    await saveSession(session);
    for (const segment of session.audio) {
      phase = 'transcription';
      stepId = segment.id;
      signal.throwIfAborted();
      if (session.completedSegments.includes(segment.id)) continue;
      progress(
        `Transcribing audio ${session.completedSegments.length + 1} of ${session.audio.length}…`,
      );
      const quotes = await transcribe(
        key,
        await loadEvidence(segment.path),
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
    phase = 'analysis';
    stepId = 'context';
    const analysisEvents = await getEvents(id);
    const overview = transferOverview(session, analysisEvents, key);
    session.sanitization = overview.counts;
    const batchLength = 120000;
    const count = Math.max(1, Math.ceil(session.duration / batchLength));
    for (let index = 0; index < count; index++) {
      const batchId = `batch-${index}`;
      stepId = batchId;
      signal.throwIfAborted();
      if (session.completedBatches.includes(batchId)) continue;
      progress(`Analyzing evidence ${index + 1} of ${count}…`);
      const start = index * batchLength;
      const end = Math.min(session.duration, start + batchLength);
      const analysisWindow = {
        start,
        end,
        narrationStart: Math.max(0, start - 30000),
        narrationEnd: Math.min(session.duration, end + 30000),
      };
      // All transcription is already available: adjacent future speech can retract or correct
      // an observation before its batch is committed. More distant corrections remain uncertain.
      const transcript = session.transcript.filter(
        (quote) =>
          quote.end >= analysisWindow.narrationStart &&
          quote.start <= analysisWindow.narrationEnd,
      );
      const contextEvents = analysisEvents.filter(
        (event) =>
          event.time >= Math.max(0, start - 30000) && event.time <= end + 4000,
      );
      const context = selectAnalysisContext(
        contextEvents.filter(
          (event) => event.data.kind !== 'analysis-context-limit',
        ),
        transcript,
        key,
      );
      if (context.limits.omittedEvents || context.limits.omittedStatements) {
        await addEvent({
          id: `${id}-context-${batchId}`,
          sessionId: id,
          time: start,
          type: 'status',
          url: '',
          data: { kind: 'analysis-context-limit', batchId, ...context.limits },
        });
        progress(
          `Analysis context limited: ${context.limits.omittedEvents} events and ${context.limits.omittedStatements} complete statements omitted from this request. Full evidence remains in the ZIP.`,
        );
      }
      const markers = context.events.filter(
        (event) => event.type === 'point' || event.type === 'rectangle',
      );
      const frames = selectFrames(
        session.frames,
        markers.map((event) => event.time),
        context.transcript,
        start,
        end,
      );
      const images = [];
      for (const frame of frames)
        images.push({
          ...frame,
          dataUrl: await imageData(`${id}/${frame.path}`),
        });
      const includedEventIds = new Set(context.events.map((event) => event.id));
      const ownedQuotes = new Set(
        context.transcript
          .filter(
            (quote) =>
              quote.start >= start &&
              (quote.start < end ||
                (end === session.duration && quote.start === end)),
          )
          .map((quote) => quote.id),
      );
      const findings = await analyze(
        key,
        {
          transcript: context.transcript,
          events: context.events,
          contextLimits: context.limits,
          analysisWindow,
          ownedQuoteIds: [...ownedQuotes],
          notes: session.notes,
          frames: images.map((frame) => ({
            ...frame,
            eventIds: frame.eventIds.filter((eventId) =>
              includedEventIds.has(eventId),
            ),
          })),
          duration: session.duration,
        },
        signal,
      );
      const ownedFindings = findings
        .filter((finding) =>
          finding.quoteIds.some((quoteId) => ownedQuotes.has(quoteId)),
        )
        .map((finding): Finding => ({
          ...finding,
          association:
            context.limits.omittedStatements > 0 &&
            finding.association === 'supported'
              ? 'uncertain'
              : finding.association,
        }));
      session.findings = mergeFindings(
        session.findings,
        sanitize(ownedFindings, [key]).value,
      );
      session.completedBatches.push(batchId);
      await saveSession(session);
    }
    phase = 'validation';
    stepId = 'analysis-output';
    session.status = 'complete';
    session.error = '';
    try {
      validateSession(session, analysisEvents);
    } catch {
      throw new OperationError(
        'invalid-session',
        'Generated analysis checkpoints or evidence references are inconsistent. Retained evidence has not been discarded.',
        false,
      );
    }
    await saveSession(session);
    progress(
      'Analysis complete. Findings are automatically generated and unreviewed.',
    );
    return session;
  } catch (error) {
    const controlled = signal.aborted
      ? new OperationError(
          'canceled',
          'Analysis canceled. Completed steps are saved; retry to continue.',
        )
      : error instanceof OperationError
        ? error
        : new OperationError(
            'processing-failed',
            `The ${phase} step failed. Completed processing steps remain saved; inspect the session details before retrying.`,
          );
    const failure = failureDetail(controlled, phase, stepId, [key]);
    try {
      session = await getSession(id);
      session.status = 'failed';
      appendFailure(session, failure);
      await saveSession(session);
    } catch {
      // Storage failure may prevent persisting diagnostics; retain the original safe reason.
    }
    throw new OperationError(
      failure.code,
      failure.message,
      failure.retryable,
      failure.httpStatus,
    );
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
