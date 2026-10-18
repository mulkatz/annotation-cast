import type { Finding, Frame, SessionEvent } from './schema';

export interface FrameAssociation {
  frame: Frame;
  provenance: 'model-cited' | 'marker-context' | 'finding-context';
  anchorId?: string;
  anchorTime?: number;
}

const MAX_CONTEXT_FRAMES = 6;
const MAX_DISTANCE_MS = 4000;
const pageTypes = new Set<SessionEvent['type']>([
  'point',
  'rectangle',
  'pointer',
  'click',
  'scroll',
  'navigation',
  'context',
]);

/** Nearby frames are temporal candidates, not evidence the model viewed or corroborated. */
export function resolveFrameAssociations(
  finding: Finding,
  frames: Frame[],
  events: SessionEvent[],
): FrameAssociation[] {
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  const used = new Set<string>();
  const result: FrameAssociation[] = [];
  for (const id of finding.evidenceIds) {
    const frame = byId.get(id);
    if (frame && !used.has(id)) {
      used.add(id);
      result.push({ frame, provenance: 'model-cited' });
    }
  }
  // Preserve every direct citation; only inferred candidates have a size limit.
  const directCount = result.length;
  const cited = new Set(finding.evidenceIds);
  const markers = events.filter(
    (event) =>
      cited.has(event.id) &&
      (event.type === 'point' || event.type === 'rectangle'),
  );
  const timeline = events
    .filter((event) => pageTypes.has(event.type) || event.type === 'gap')
    .slice()
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const pages = timeline.filter(
    (event) => event.type === 'gap' || (pageTypes.has(event.type) && event.url),
  );
  const pageAt = (time: number) => {
    let low = 0;
    let high = pages.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((pages[middle]?.time ?? Infinity) <= time) low = middle + 1;
      else high = middle;
    }
    const latest = pages[low - 1];
    return {
      url: latest?.type === 'gap' ? undefined : latest?.url,
      unavailable: latest?.type === 'gap',
    };
  };
  const compatible = (frame: Frame, time: number, url: string): boolean => {
    const framePage = pageAt(frame.time);
    if (framePage.unavailable || (framePage.url && framePage.url !== url))
      return false;
    const start = Math.min(frame.time, time);
    const end = Math.max(frame.time, time);
    return !timeline.some(
      (event) =>
        event.time >= start &&
        event.time <= end &&
        (event.type === 'gap' ||
          event.type === 'navigation' ||
          (event.type === 'context' &&
            event.data.reason === 'page context initialized') ||
          (event.url !== '' && event.url !== url)),
    );
  };
  type Anchor = {
    time: number;
    url: string;
    provenance: 'marker-context' | 'finding-context';
    id?: string;
  };
  const anchors: Anchor[] = markers
    .filter(
      (event) => event.url && (!finding.page || event.url === finding.page),
    )
    .sort((a, b) => {
      const distance = (time: number) =>
        Math.max(finding.start - time, time - finding.end, 0);
      return distance(a.time) - distance(b.time) || a.time - b.time;
    })
    .map((event) => ({
      time: event.time,
      url: event.url,
      id: event.id,
      provenance: 'marker-context',
    }));
  // Unmarked observations need known page context. Do not replace existing direct images,
  // or fall back around a marker that was rejected because its page did not match.
  if (!markers.length && !directCount && finding.page) {
    for (const time of new Set([finding.start, finding.end])) {
      if (pageAt(time).url === finding.page)
        anchors.push({
          time,
          url: finding.page,
          provenance: 'finding-context',
        });
    }
  }
  const pairs = anchors.map((anchor) => {
    const nearby = frames
      .filter(
        (frame) =>
          Math.abs(frame.time - anchor.time) <= MAX_DISTANCE_MS &&
          compatible(frame, anchor.time, anchor.url),
      )
      .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    const before = nearby.filter((frame) => frame.time <= anchor.time).at(-1);
    const after = nearby.find((frame) => frame.time >= anchor.time);
    return {
      anchor,
      frames: [before, after]
        .filter((frame): frame is Frame => frame !== undefined)
        .sort(
          (a, b) =>
            Math.abs(a.time - anchor.time) - Math.abs(b.time - anchor.time) ||
            a.time - b.time,
        ),
    };
  });
  // Give each cited marker its nearest candidate before filling secondary states.
  for (let position = 0; position < 2; position++) {
    for (const { anchor, frames: pair } of pairs) {
      if (result.length - directCount >= MAX_CONTEXT_FRAMES) return result;
      const frame = pair[position];
      if (!frame || used.has(frame.id)) continue;
      used.add(frame.id);
      result.push({
        frame,
        provenance: anchor.provenance,
        anchorTime: anchor.time,
        ...(anchor.id ? { anchorId: anchor.id } : {}),
      });
    }
  }
  return result;
}
