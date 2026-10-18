import { describe, expect, it } from 'vitest';
import { resolveFrameAssociations } from '../src/core/frame-associations';
import type { Finding, Frame, SessionEvent } from '../src/core/schema';

const page = 'https://example.test/app';
const finding: Finding = {
  id: 'issue-1',
  title: 'A narrated defect',
  description: 'Synthetic observation.',
  start: 9000,
  end: 9000,
  page,
  evidenceIds: [],
  quoteIds: ['quote-1'],
  hypotheses: [],
  expectedBehavior: null,
  reproduction: [],
  association: 'uncertain',
};
function frame(time: number): Frame {
  return {
    id: `frame-${time}`,
    time,
    path: `screenshots/frame-${time}.jpg`,
    eventIds: [],
  };
}
function event(
  id: string,
  type: SessionEvent['type'],
  time: number,
  url = page,
  data: SessionEvent['data'] = {},
): SessionEvent {
  return { id, type, time, url, data, sessionId: 'session-1' };
}
const marker = event('marker-1', 'point', 9000);

describe('finding frame associations', () => {
  it('preserves every model-cited image and its provenance without applying the candidate cap', () => {
    const frames = Array.from({ length: 9 }, (_, index) => frame(index * 1000));
    const result = resolveFrameAssociations(
      {
        ...finding,
        evidenceIds: [...frames.map((item) => item.id), frames[0]!.id],
      },
      frames,
      [],
    );
    expect(result).toHaveLength(9);
    expect(result.every((item) => item.provenance === 'model-cited')).toBe(
      true,
    );
    expect(result.map((item) => item.frame.id)).toEqual(
      frames.map((item) => item.id),
    );
  });
  it('adds measured pre/post candidates for an event-only citation without changing the finding or frames', () => {
    const input = { ...finding, evidenceIds: [marker.id] };
    const frames = [frame(8000), frame(10000)];
    const original = structuredClone({ input, frames });
    expect(resolveFrameAssociations(input, frames, [marker])).toEqual(
      frames.map((item) => ({
        frame: item,
        provenance: 'marker-context',
        anchorId: marker.id,
        anchorTime: marker.time,
      })),
    );
    expect({ input, frames }).toEqual(original);
  });
  it('deduplicates direct citations and contextual candidates while keeping direct provenance first', () => {
    const before = frame(8000),
      after = frame(10000);
    expect(
      resolveFrameAssociations(
        { ...finding, evidenceIds: [marker.id, before.id] },
        [after, before],
        [marker],
      ),
    ).toEqual([
      { frame: before, provenance: 'model-cited' },
      {
        frame: after,
        provenance: 'marker-context',
        anchorId: marker.id,
        anchorTime: marker.time,
      },
    ]);
  });
  it('refuses distant frames and markers from a different page', () => {
    expect(
      resolveFrameAssociations(
        { ...finding, evidenceIds: [marker.id] },
        [frame(4999), frame(13001)],
        [marker],
      ),
    ).toEqual([]);
    expect(
      resolveFrameAssociations(
        { ...finding, evidenceIds: [marker.id] },
        [frame(8000)],
        [{ ...marker, url: 'https://other.test/' }],
      ),
    ).toEqual([]);
  });
  it.each([
    event('boundary', 'navigation', 8500),
    event('boundary', 'context', 8500, page, {
      reason: 'page context initialized',
    }),
    event('boundary', 'context', 8500, 'https://other.test/'),
    event('boundary', 'gap', 8500),
  ])('refuses contextual matches crossing $type boundaries', (boundary) => {
    const result = resolveFrameAssociations(
      { ...finding, evidenceIds: [marker.id] },
      [frame(8000), frame(10000)],
      [boundary, marker],
    );
    expect(result.map((item) => item.frame.time)).toEqual([10000]);
  });
  it('refuses all contextual pairs when a gap occurs exactly at the marker timestamp', () => {
    const gap = event('gap', 'gap', marker.time);
    expect(
      resolveFrameAssociations(
        { ...finding, evidenceIds: [marker.id] },
        [frame(8000), frame(10000)],
        [marker, gap],
      ),
    ).toEqual([]);
  });
  it('does not use a frame known to precede a different page even without an intervening navigation event', () => {
    const oldPage = event('old-page', 'context', 1000, 'https://other.test/');
    expect(
      resolveFrameAssociations(
        { ...finding, evidenceIds: [marker.id] },
        [frame(8000)],
        [oldPage, marker],
      ),
    ).toEqual([]);
  });
  it('labels unmarked range candidates separately and requires known matching page context', () => {
    const frames = [frame(8000), frame(10000)];
    const context = event('context', 'context', 1000);
    expect(resolveFrameAssociations(finding, frames, [context])).toEqual(
      frames.map((item) => ({
        frame: item,
        provenance: 'finding-context',
        anchorTime: finding.start,
      })),
    );
    expect(resolveFrameAssociations(finding, frames, [])).toEqual([]);
    expect(
      resolveFrameAssociations({ ...finding, page: '' }, frames, [context]),
    ).toEqual([]);
  });
  it('invalidates stale page confidence after a gap until fresh page evidence arrives', () => {
    const context = event('context', 'context', 0);
    const gap = event('gap', 'gap', 5000);
    const frames = [frame(10000)];
    expect(resolveFrameAssociations(finding, frames, [context, gap])).toEqual(
      [],
    );
    const freshContext = event('fresh-context', 'context', 8000);
    expect(
      resolveFrameAssociations(finding, frames, [context, gap, freshContext])[0]
        ?.provenance,
    ).toBe('finding-context');
  });
  it('allows frames after a marker restores page confidence without attaching earlier unknown post-gap frames', () => {
    const context = event('context', 'context', 0);
    const gap = event('gap', 'gap', 5000);
    const result = resolveFrameAssociations(
      { ...finding, evidenceIds: [marker.id] },
      [frame(8000), frame(10000)],
      [context, gap, marker],
    );
    expect(result.map((item) => item.frame.time)).toEqual([10000]);
    expect(result[0]?.provenance).toBe('marker-context');
  });
  it('does not present passive pointer evidence as an intentional marker', () => {
    const pointer = event('pointer-1', 'pointer', 8500);
    const result = resolveFrameAssociations(
      { ...finding, evidenceIds: [pointer.id] },
      [frame(10000)],
      [pointer],
    );
    expect(result[0]?.provenance).toBe('finding-context');
    expect(result[0]?.anchorId).toBeUndefined();
  });
  it('bounds candidate count independently of direct citations', () => {
    const markers = Array.from({ length: 8 }, (_, index) =>
      event(`marker-${index}`, 'rectangle', 10000 + index * 10000),
    );
    const frames = markers.flatMap((item) => [
      frame(item.time - 1000),
      frame(item.time + 1000),
    ]);
    const direct = frame(0);
    const result = resolveFrameAssociations(
      {
        ...finding,
        evidenceIds: [direct.id, ...markers.map((item) => item.id)],
      },
      [direct, ...frames],
      markers,
    );
    expect(result).toHaveLength(7);
    expect(result[0]).toEqual({ frame: direct, provenance: 'model-cited' });
    expect(
      result.slice(1).every((item) => item.provenance === 'marker-context'),
    ).toBe(true);
    expect(new Set(result.map((item) => item.frame.id)).size).toBe(
      result.length,
    );
  });
});
