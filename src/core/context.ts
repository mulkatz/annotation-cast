import { z } from 'zod';
import { sanitize } from './sanitize';
import type { SessionEvent, Transcript } from './schema';

export const CONTEXT_BUDGET = {
  events: 160,
  eventBytes: 48 * 1024,
  transcript: 256,
  transcriptBytes: 64 * 1024,
} as const;
export const ContextLimitsSchema = z.object({
  availableEvents: z.number().int().nonnegative(),
  includedEvents: z.number().int().nonnegative(),
  omittedEvents: z.number().int().nonnegative(),
  eventBytes: z.number().int().nonnegative(),
  eventByteLimit: z.literal(CONTEXT_BUDGET.eventBytes),
  eventLimit: z.literal(CONTEXT_BUDGET.events),
  availableStatements: z.number().int().nonnegative(),
  includedStatements: z.number().int().nonnegative(),
  omittedStatements: z.number().int().nonnegative(),
  transcriptBytes: z.number().int().nonnegative(),
  transcriptByteLimit: z.literal(CONTEXT_BUDGET.transcriptBytes),
  statementLimit: z.literal(CONTEXT_BUDGET.transcript),
});
export type ContextLimits = z.infer<typeof ContextLimitsSchema>;
export const AnalysisWindowSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  narrationStart: z.number().nonnegative(),
  narrationEnd: z.number().nonnegative(),
});
export type AnalysisWindow = z.infer<typeof AnalysisWindowSchema>;

const encoder = new TextEncoder();
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}
function nearby(time: number, sorted: number[]): number {
  if (!sorted.length) return 0;
  let left = 0;
  let right = sorted.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if ((sorted[middle] ?? Infinity) < time) left = middle + 1;
    else right = middle;
  }
  return Math.min(
    Math.abs(time - (sorted[left] ?? Infinity)),
    Math.abs(time - (sorted[left - 1] ?? -Infinity)),
  );
}
function priority(event: SessionEvent): number {
  switch (event.type) {
    case 'point':
    case 'rectangle':
      return 0;
    case 'navigation':
    case 'context':
    case 'gap':
    case 'status':
      return 1;
    case 'console':
    case 'network':
      return 2;
    case 'click':
      return 3;
    case 'pointer':
    case 'scroll':
      return 4;
  }
}
function retain<T>(
  items: T[],
  maxCount: number,
  maxBytes: number,
  key: string,
): { values: T[]; bytes: number } {
  const values: T[] = [];
  let bytes = 2;
  for (const item of items) {
    if (values.length >= maxCount) break;
    // Measure sanitized objects so expanding URL replacements cannot exceed the transfer budget.
    // Clean one object at a time rather than cloning a complete noisy diagnostic trail.
    const clean = sanitize(item, [key]).value;
    const size = jsonBytes(clean) + (values.length ? 1 : 0);
    if (bytes + size <= maxBytes) {
      values.push(clean);
      bytes += size;
    }
  }
  return { values, bytes };
}

/** Select complete statements/events; retain all original evidence separately for export. */
export function selectAnalysisContext(
  events: SessionEvent[],
  transcript: Transcript[],
  key: string,
) {
  const quotes = retain(
    [...transcript].sort(
      (a, b) => a.start - b.start || a.id.localeCompare(b.id),
    ),
    CONTEXT_BUDGET.transcript,
    CONTEXT_BUDGET.transcriptBytes,
    key,
  );
  const anchors = [
    ...events
      .filter((event) => event.type === 'point' || event.type === 'rectangle')
      .map((event) => event.time),
    ...quotes.values.map((quote) => quote.start),
  ].sort((a, b) => a - b);
  const quoteTimes = quotes.values.map((quote) => quote.start);
  const ranked = events
    .map((event) => ({
      event,
      rank: priority(event),
      distance: nearby(
        event.time,
        (event.type === 'point' || event.type === 'rectangle') &&
          quoteTimes.length
          ? quoteTimes
          : anchors,
      ),
    }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.distance - b.distance ||
        a.event.time - b.event.time ||
        a.event.id.localeCompare(b.event.id),
    );
  const selected = retain(
    ranked.map((entry) => entry.event),
    CONTEXT_BUDGET.events,
    CONTEXT_BUDGET.eventBytes,
    key,
  );
  const keptEvents = selected.values.sort(
    (a, b) => a.time - b.time || a.id.localeCompare(b.id),
  );
  const limits: ContextLimits = {
    availableEvents: events.length,
    includedEvents: keptEvents.length,
    omittedEvents: events.length - keptEvents.length,
    eventBytes: selected.bytes,
    eventByteLimit: CONTEXT_BUDGET.eventBytes,
    eventLimit: CONTEXT_BUDGET.events,
    availableStatements: transcript.length,
    includedStatements: quotes.values.length,
    omittedStatements: transcript.length - quotes.values.length,
    transcriptBytes: quotes.bytes,
    transcriptByteLimit: CONTEXT_BUDGET.transcriptBytes,
    statementLimit: CONTEXT_BUDGET.transcript,
  };
  return { events: keptEvents, transcript: quotes.values, limits };
}
