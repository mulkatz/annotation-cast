import {
  EventSchema,
  SessionSchema,
  type Session,
  type SessionEvent,
} from './schema';

/** Validate relational checkpoint/export invariants in addition to structural storage schemas. */
export function validateSession(
  input: Session,
  events?: SessionEvent[],
): Session {
  const session = SessionSchema.parse(input);
  const fail = () => {
    throw new Error(
      'Session evidence or processing checkpoints are inconsistent. Retained local data has not been exported.',
    );
  };
  if (
    !/^[a-zA-Z0-9_-]+$/.test(session.id) ||
    session.recordingPath !== `${session.id}/recording.webm`
  )
    fail();
  const unique = (values: string[]) => new Set(values).size === values.length;
  for (const list of [
    session.audio,
    session.transcript,
    session.frames,
    session.findings,
  ])
    if (!unique(list.map((value) => value.id))) fail();
  if (!unique(session.completedSegments) || !unique(session.completedBatches))
    fail();
  for (const segment of session.audio) {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(segment.id) ||
      segment.path !== `${session.id}/audio/${segment.id}.webm` ||
      segment.end <= segment.start ||
      segment.end > session.duration
    )
      fail();
  }
  const audioIds = new Set(session.audio.map((segment) => segment.id));
  if (session.completedSegments.some((id) => !audioIds.has(id))) fail();
  for (const quote of session.transcript)
    if (
      quote.end <= quote.start ||
      quote.end > session.duration ||
      !session.completedSegments.some((id) =>
        quote.id.startsWith(`${id}-quote-`),
      )
    )
      fail();
  for (const frame of session.frames) if (frame.time > session.duration) fail();
  const batches = Math.max(1, Math.ceil(session.duration / 120000));
  for (const id of session.completedBatches)
    if (!/^batch-\d+$/.test(id) || Number(id.slice(6)) >= batches) fail();
  if (
    session.status === 'complete' &&
    (!session.audio.length ||
      !session.frames.length ||
      session.completedSegments.length !== session.audio.length ||
      session.completedBatches.length !== batches)
  )
    fail();
  if (events) {
    const validEvents = events.map((event) => EventSchema.parse(event));
    if (
      !unique(validEvents.map((event) => event.id)) ||
      validEvents.some(
        (event) =>
          event.sessionId !== session.id ||
          event.time > session.duration + 1000,
      )
    )
      fail();
    const evidence = new Set([
      ...validEvents.map((event) => event.id),
      ...session.frames.map((frame) => frame.id),
    ]);
    const quotes = new Set(session.transcript.map((quote) => quote.id));
    if (
      !unique([
        ...validEvents.map((event) => event.id),
        ...session.frames.map((frame) => frame.id),
        ...session.transcript.map((quote) => quote.id),
      ])
    )
      fail();
    for (const finding of session.findings) {
      if (
        finding.end < finding.start ||
        finding.end > session.duration ||
        !finding.quoteIds.length ||
        finding.quoteIds.some((id) => !quotes.has(id)) ||
        finding.evidenceIds.some((id) => !evidence.has(id)) ||
        (finding.association === 'supported' && !finding.evidenceIds.length)
      )
        fail();
    }
    for (const frame of session.frames)
      if (
        frame.eventIds.some(
          (id) => !validEvents.some((event) => event.id === id),
        )
      )
        fail();
  }
  return session;
}
