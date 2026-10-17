import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureSession } from './fixtures';
import {
  processSession,
  mergeFindings,
  selectFrames,
} from '../src/core/pipeline';
import {
  addEvent,
  getEvents,
  getSession,
  saveSession,
  getMedia,
} from '../src/core/store';
import type { Finding, Frame } from '../src/core/schema';
vi.mock('../src/providers/openrouter', () => ({
  transcribe: vi.fn(),
  analyze: vi.fn(),
}));
vi.mock('../src/core/store', async (original) => {
  const actual = await original<typeof Store>();
  return {
    ...actual,
    getMedia: vi.fn(
      async () => new Blob(['synthetic'], { type: 'audio/webm' }),
    ),
  };
});
import type * as Store from '../src/core/store';
import { transcribe, analyze } from '../src/providers/openrouter';
const issue: Finding = {
  id: 'issue-1',
  title: 'A clipped button',
  description: 'The narrator described a clipped button.',
  start: 10,
  end: 500,
  page: 'https://example.test/',
  evidenceIds: ['frame-1'],
  quoteIds: ['audio-1-quote-1'],
  hypotheses: [],
  expectedBehavior: null,
  reproduction: [],
  association: 'supported',
};
beforeEach(() => {
  vi.mocked(transcribe).mockReset();
  vi.mocked(analyze).mockReset();
  vi.stubGlobal(
    'FileReader',
    class {
      result = 'data:image/jpeg;base64,YQ==';
      onload?: () => void;
      readAsDataURL() {
        this.onload?.();
      }
    },
  );
});
describe('processing and evidence', () => {
  it('retains transcription on analysis failure and resumes only the failed step', async () => {
    const session = fixtureSession();
    session.audio = [
      {
        id: 'audio-1',
        path: `${session.id}/audio/audio-1.webm`,
        start: 0,
        end: 5000,
      },
    ];
    session.frames = [
      {
        id: 'frame-1',
        time: 500,
        path: 'screenshots/frame-1.jpg',
        eventIds: [],
      },
    ];
    await saveSession(session);
    vi.mocked(transcribe).mockResolvedValue([
      {
        id: 'audio-1-quote-1',
        start: 10,
        end: 500,
        text: 'The button is clipped.',
      },
    ]);
    vi.mocked(analyze)
      .mockRejectedValueOnce(new Error('Synthetic provider failure'))
      .mockResolvedValueOnce([{ ...issue, page: '' }]);
    const signal = new AbortController().signal;
    await expect(
      processSession(session.id, 'synthetic-key', signal, () => undefined),
    ).rejects.toThrow('Synthetic provider failure');
    expect((await getSession(session.id)).completedSegments).toEqual([
      'audio-1',
    ]);
    expect(
      (
        await processSession(
          session.id,
          'synthetic-key',
          signal,
          () => undefined,
        )
      ).status,
    ).toBe('complete');
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(2);
  });
  it('blocks paid processing when the retained recording is empty', async () => {
    const session = fixtureSession();
    session.audio = [
      {
        id: 'audio-1',
        path: `${session.id}/audio/audio-1.webm`,
        start: 0,
        end: 5000,
      },
    ];
    session.frames = [
      {
        id: 'frame-1',
        time: 500,
        path: 'screenshots/frame-1.jpg',
        eventIds: [],
      },
    ];
    await saveSession(session);
    vi.mocked(getMedia).mockResolvedValueOnce(
      new File([], 'recording.webm', { type: 'video/webm' }),
    );
    await expect(
      processSession(
        session.id,
        'synthetic-key',
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow('recording is empty');
    expect(transcribe).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });
  it('preserves same-title observations on different pages and separated times', () => {
    expect(
      mergeFindings([issue], [{ ...issue, page: 'https://other.test/' }]),
    ).toHaveLength(2);
    expect(
      mergeFindings([{ ...issue, start: 90000, end: 91000 }], [issue]),
    ).toHaveLength(2);
    expect(mergeFindings([issue], [issue])).toHaveLength(1);
  });
  it('retains new evidence when merging would exceed schema limits or lose supported steps', () => {
    const full = {
      ...issue,
      evidenceIds: Array.from({ length: 40 }, (_, index) => `frame-${index}`),
    };
    expect(
      mergeFindings([full], [{ ...issue, evidenceIds: ['extra-frame'] }]),
    ).toHaveLength(2);
    expect(
      mergeFindings(
        [issue],
        [{ ...issue, reproduction: ['Open the synthetic app'] }],
      ),
    ).toHaveLength(2);
  });
  it('chooses actual pre-marker frames and bounded evidence', () => {
    const frames: Frame[] = [0, 2000, 4000, 6000].map((time) => ({
      id: `frame-${time}`,
      time,
      path: `screenshots/frame-${time}.jpg`,
      eventIds: [],
    }));
    expect(
      selectFrames(frames, [3000], [], 0, 7000).map((frame) => frame.time),
    ).toEqual([0, 6000]);
  });
});

function longerSession() {
  const session = fixtureSession();
  session.duration = 130000;
  session.audio = [
    {
      id: 'audio-1',
      path: `${session.id}/audio/audio-1.webm`,
      start: 0,
      end: 60000,
    },
    {
      id: 'audio-2',
      path: `${session.id}/audio/audio-2.webm`,
      start: 59000,
      end: 119000,
    },
    {
      id: 'audio-3',
      path: `${session.id}/audio/audio-3.webm`,
      start: 118000,
      end: 130000,
    },
  ];
  session.frames = [110000, 125000].map((time) => ({
    id: `frame-${time}`,
    time,
    path: `screenshots/frame-${time}.jpg`,
    eventIds: [],
  }));
  return session;
}

describe('bounded analysis windows', () => {
  it('considers the correction after a batch boundary before generating an issue', async () => {
    const session = longerSession();
    await saveSession(session);
    vi.mocked(transcribe).mockImplementation(async (_key, _blob, segment) =>
      segment.id === 'audio-2'
        ? [
            {
              id: 'audio-2-quote-1',
              start: 110000,
              end: 112000,
              text: 'The button is broken.',
            },
          ]
        : segment.id === 'audio-3'
          ? [
              {
                id: 'audio-3-quote-1',
                start: 125000,
                end: 127000,
                text: 'Correction: the button is fine. Disregard that issue.',
              },
            ]
          : [],
    );
    vi.mocked(analyze).mockImplementation(async (_key, context) =>
      context.transcript.some((quote) => quote.text.includes('Correction:'))
        ? []
        : [
            {
              ...issue,
              page: '',
              start: 110000,
              end: 112000,
              evidenceIds: ['frame-110000'],
              quoteIds: ['audio-2-quote-1'],
            },
          ],
    );
    const result = await processSession(
      session.id,
      'synthetic-key',
      new AbortController().signal,
      () => undefined,
    );
    expect(result.findings).toEqual([]);
    expect(
      vi.mocked(analyze).mock.calls[0]?.[1].transcript.map((quote) => quote.id),
    ).toEqual(['audio-2-quote-1', 'audio-3-quote-1']);
    expect(vi.mocked(analyze).mock.calls[0]?.[1].analysisWindow).toEqual({
      start: 0,
      end: 120000,
      narrationStart: 0,
      narrationEnd: 130000,
    });
  });
  it('defers a future-only observation to its own batch without dropping an ordinary overlapping finding', async () => {
    const session = longerSession();
    await saveSession(session);
    vi.mocked(transcribe).mockImplementation(async (_key, _blob, segment) =>
      segment.id === 'audio-2'
        ? [
            {
              id: 'audio-2-quote-1',
              start: 110000,
              end: 112000,
              text: 'The first button clips.',
            },
          ]
        : segment.id === 'audio-3'
          ? [
              {
                id: 'audio-3-quote-1',
                start: 125000,
                end: 127000,
                text: 'The second button clips.',
              },
            ]
          : [],
    );
    const first = {
      ...issue,
      page: '',
      start: 110000,
      end: 112000,
      evidenceIds: ['frame-110000'],
      quoteIds: ['audio-2-quote-1'],
    };
    const future = {
      ...issue,
      id: 'issue-2',
      title: 'Another button',
      page: '',
      start: 125000,
      end: 127000,
      evidenceIds: ['frame-125000'],
      quoteIds: ['audio-3-quote-1'],
    };
    let requests = 0;
    vi.mocked(analyze).mockImplementation(async () => {
      if (++requests === 2)
        expect(
          (await getSession(session.id)).findings.map(
            (finding) => finding.title,
          ),
        ).toEqual([first.title]);
      return [first, future];
    });
    const result = await processSession(
      session.id,
      'synthetic-key',
      new AbortController().signal,
      () => undefined,
    );
    expect(result.findings.map((finding) => finding.title)).toEqual([
      first.title,
      future.title,
    ]);
    expect(result.findings.map((finding) => finding.id)).toEqual([
      'issue-1',
      'issue-2',
    ]);
  });
  it('retains a late narrated marker when earlier pre/post frame targets exceed the image budget', () => {
    const frames: Frame[] = Array.from({ length: 61 }, (_, index) => ({
      id: `frame-${index}`,
      time: index * 2000,
      path: `screenshots/frame-${index}.jpg`,
      eventIds: [],
    }));
    const selected = selectFrames(
      frames,
      [5000, 15000, 25000, 35000, 45000, 55000, 105000],
      [
        {
          id: 'quote-late',
          start: 105000,
          end: 106000,
          text: 'This late state clips.',
        },
      ],
      0,
      120000,
    );
    expect(selected.length).toBeLessThanOrEqual(12);
    expect(selected.some((frame) => frame.time >= 102000)).toBe(true);
    expect(selected.some((frame) => frame.time <= 5000)).toBe(true);
  });
  it('records deterministic omissions before a failed request and keeps all events for export on retry', async () => {
    const session = fixtureSession();
    session.audio = [
      {
        id: 'audio-1',
        path: `${session.id}/audio/audio-1.webm`,
        start: 0,
        end: 5000,
      },
    ];
    session.frames = [
      {
        id: 'frame-1',
        time: 500,
        path: 'screenshots/frame-1.jpg',
        eventIds: ['marker-1'],
      },
    ];
    await saveSession(session);
    await Promise.all(
      Array.from({ length: 180 }, (_, index) =>
        addEvent({
          id: `noise-${index}`,
          sessionId: session.id,
          time: index,
          type: 'console',
          url: '',
          data: { text: 'Synthetic log '.repeat(320) },
        }),
      ),
    );
    await addEvent({
      id: 'marker-1',
      sessionId: session.id,
      time: 500,
      type: 'point',
      url: 'https://example.test/',
      data: { selection: 'The button clips.' },
    });
    vi.mocked(transcribe).mockResolvedValue([
      {
        id: 'audio-1-quote-1',
        start: 500,
        end: 1000,
        text: 'The button clips.',
      },
    ]);
    vi.mocked(analyze)
      .mockRejectedValueOnce(new Error('Synthetic failure'))
      .mockResolvedValueOnce([]);
    await expect(
      processSession(
        session.id,
        'synthetic-key',
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow('Synthetic failure');
    await processSession(
      session.id,
      'synthetic-key',
      new AbortController().signal,
      () => undefined,
    );
    const sent = vi.mocked(analyze).mock.calls[0]?.[1];
    expect(sent?.events.some((event) => event.id === 'marker-1')).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(sent?.events)).byteLength,
    ).toBeLessThanOrEqual(48 * 1024);
    expect(sent?.contextLimits?.omittedEvents).toBeGreaterThan(0);
    const retained = await getEvents(session.id);
    expect(retained.filter((event) => event.type === 'console')).toHaveLength(
      180,
    );
    const limits = retained.filter(
      (event) => event.data.kind === 'analysis-context-limit',
    );
    expect(limits).toHaveLength(1);
    expect(limits[0]?.data.omittedEvents).toBe(
      sent?.contextLimits?.omittedEvents,
    );
    expect(vi.mocked(analyze).mock.calls[1]?.[1].contextLimits).toEqual(
      sent?.contextLimits,
    );
  });
});

it('preserves omitted transcript statements locally and marks their batch associations uncertain', async () => {
  const session = fixtureSession();
  session.audio = [
    {
      id: 'audio-1',
      path: `${session.id}/audio/audio-1.webm`,
      start: 0,
      end: 5000,
    },
  ];
  session.completedSegments = ['audio-1'];
  session.frames = [
    { id: 'frame-1', time: 500, path: 'screenshots/frame-1.jpg', eventIds: [] },
  ];
  session.transcript = Array.from({ length: 300 }, (_, index) => ({
    id: `audio-1-quote-${index + 1}`,
    start: index * 10,
    end: index * 10 + 5,
    text: 'Synthetic complete observation '.repeat(60),
  }));
  await saveSession(session);
  vi.mocked(analyze).mockResolvedValue([
    { ...issue, page: '', start: 0, end: 5 },
  ]);
  const result = await processSession(
    session.id,
    'synthetic-key',
    new AbortController().signal,
    () => undefined,
  );
  expect(result.transcript).toHaveLength(300);
  expect(result.findings[0]?.association).toBe('uncertain');
  expect(
    vi.mocked(analyze).mock.calls[0]?.[1].contextLimits?.omittedStatements,
  ).toBeGreaterThan(0);
});

it.each([
  {
    quoteStart: 119900,
    quoteEnd: 120500,
    visualStart: 120200,
    visualEnd: 120400,
    ownerBatch: 0,
  },
  {
    quoteStart: 125000,
    quoteEnd: 127000,
    visualStart: 110000,
    visualEnd: 111000,
    ownerBatch: 1,
  },
])(
  'owns delayed or straddling descriptions by source IDs rather than finding time: %j',
  async ({ quoteStart, quoteEnd, visualStart, visualEnd, ownerBatch }) => {
    const session = longerSession();
    await saveSession(session);
    vi.mocked(transcribe).mockImplementation(async (_key, _blob, segment) =>
      segment.id === 'audio-3'
        ? [
            {
              id: 'audio-3-quote-1',
              start: quoteStart,
              end: quoteEnd,
              text: 'The button clipped at the earlier demonstrated state.',
            },
          ]
        : [],
    );
    const observed = {
      ...issue,
      page: '',
      start: visualStart,
      end: visualEnd,
      evidenceIds: ['frame-110000'],
      quoteIds: ['audio-3-quote-1'],
    };
    vi.mocked(analyze).mockImplementation(async (_key, context) =>
      context.ownedQuoteIds?.includes('audio-3-quote-1') ? [observed] : [],
    );
    const result = await processSession(
      session.id,
      'synthetic-key',
      new AbortController().signal,
      () => undefined,
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.start).toBe(visualStart);
    expect(
      vi.mocked(analyze).mock.calls[ownerBatch]?.[1].ownedQuoteIds,
    ).toEqual(['audio-3-quote-1']);
    expect(
      vi.mocked(analyze).mock.calls[1 - ownerBatch]?.[1].ownedQuoteIds,
    ).toEqual([]);
  },
);
