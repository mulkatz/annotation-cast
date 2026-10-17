import { describe, expect, it, vi } from 'vitest';
import { analyze } from '../src/providers/openrouter';
import {
  CONTEXT_BUDGET,
  jsonBytes,
  selectAnalysisContext,
} from '../src/core/context';
import type { SessionEvent, Transcript } from '../src/core/schema';

function event(
  id: string,
  type: SessionEvent['type'],
  time: number,
  text = '',
): SessionEvent {
  return {
    id,
    sessionId: 'session-1',
    type,
    time,
    url: 'https://example.test/',
    data: { text },
  };
}
describe('bounded provider context', () => {
  it('bounds a 20,000-diagnostic trail while preserving markers and nearby diagnostics', () => {
    const diagnostics = Array.from({ length: 20_000 }, (_, index) =>
      event(
        `log-${index}`,
        'console',
        index * 5,
        'Synthetic diagnostic '.repeat(190),
      ),
    );
    const marker = event('marker-1', 'point', 90_000, 'Frozen marker context');
    const navigation = event('navigation-1', 'navigation', 88_000);
    const gap = event('gap-1', 'gap', 89_000);
    const trail = Array.from({ length: 200 }, (_, index) =>
      event(`pointer-${index}`, 'pointer', 90_000 + index),
    );
    const originals = [...diagnostics, marker, navigation, gap, ...trail];
    const result = selectAnalysisContext(
      originals,
      [
        {
          id: 'quote-1',
          start: 90_000,
          end: 91_000,
          text: 'The button clips.',
        },
      ],
      'synthetic-key',
    );
    expect(result.events.length).toBeLessThanOrEqual(CONTEXT_BUDGET.events);
    expect(jsonBytes(result.events)).toBeLessThanOrEqual(
      CONTEXT_BUDGET.eventBytes,
    );
    expect(result.limits.eventBytes).toBe(jsonBytes(result.events));
    expect(result.events.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'marker-1',
        'navigation-1',
        'gap-1',
        'log-18000',
      ]),
    );
    expect(result.events.some((entry) => entry.id === 'log-0')).toBe(false);
    expect(result.limits.omittedEvents).toBe(
      originals.length - result.events.length,
    );
    expect(originals).toHaveLength(20_203);
    expect(diagnostics[0]?.data.text).toBe('Synthetic diagnostic '.repeat(190));
  });
  it('measures actual UTF-8 bytes and omits whole oversized statements without slicing them', () => {
    const statement = '界'.repeat(15_000);
    const quotes: Transcript[] = [0, 1, 2].map((index) => ({
      id: `quote-${index}`,
      start: index * 1000,
      end: index * 1000 + 500,
      text: statement,
    }));
    const result = selectAnalysisContext([], quotes, 'synthetic-key');
    expect(result.transcript).toHaveLength(1);
    expect(result.transcript[0]?.text).toBe(statement);
    expect(result.limits.omittedStatements).toBe(2);
    expect(result.limits.transcriptBytes).toBe(jsonBytes(result.transcript));
    expect(jsonBytes(result.transcript)).toBeLessThanOrEqual(
      CONTEXT_BUDGET.transcriptBytes,
    );
    expect(quotes).toHaveLength(3);
  });
  it('accounts for sanitation expansion and remains deterministic without mutating evidence', () => {
    const text = Array.from(
      { length: 100 },
      (_, index) => `https://example.test/?q${index}=x`,
    ).join(' ');
    const events = Array.from({ length: 100 }, (_, index) =>
      event(`log-${index}`, 'console', index, text),
    );
    const first = selectAnalysisContext(events, [], 'synthetic-key');
    expect(first).toEqual(selectAnalysisContext(events, [], 'synthetic-key'));
    expect(jsonBytes(first.events)).toBeLessThanOrEqual(
      CONTEXT_BUDGET.eventBytes,
    );
    expect(first.events[0]?.data.text).toContain('%5BREDACTED%5D');
    expect(events[0]?.data.text).toContain('q0=x');
  });
});

it('prioritizes a late narration-linked marker when the event-count budget is exhausted', () => {
  const markers = Array.from({ length: 200 }, (_, index) =>
    event(`marker-${index}`, 'point', index * 1000),
  );
  const result = selectAnalysisContext(
    markers,
    [
      {
        id: 'quote-late',
        start: 199000,
        end: 199500,
        text: 'The last marked button clips.',
      },
    ],
    'synthetic-key',
  );
  expect(result.events).toHaveLength(CONTEXT_BUDGET.events);
  expect(result.events.some((entry) => entry.id === 'marker-199')).toBe(true);
  expect(result.limits.omittedEvents).toBe(40);
});

it('rejects oversized direct adapter context before any provider request', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  await expect(
    analyze('synthetic-key', {
      events: [event('too-large', 'console', 0, 'x'.repeat(50000))],
      transcript: [],
      frames: [],
      duration: 1000,
    }),
  ).rejects.toThrow('transfer budget');
  expect(fetcher).not.toHaveBeenCalled();
});
