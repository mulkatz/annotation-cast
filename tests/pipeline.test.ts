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
import { OperationError } from '../src/core/failures';
vi.mock('../src/providers/openrouter', () => ({
  transcribe: vi.fn(),
  analyze: vi.fn(),
}));
vi.mock('../src/core/store', async (original) => {
  const actual = await original<typeof Store>();
  return {
    ...actual,
    getEvents: vi.fn(actual.getEvents),
    getMedia: vi.fn(
      async () =>
        new File(['synthetic'], 'synthetic.webm', { type: 'audio/webm' }),
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
  vi.mocked(getMedia)
    .mockReset()
    .mockImplementation(
      async () =>
        new File(['synthetic'], 'synthetic.webm', { type: 'audio/webm' }),
    );
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
      .mockRejectedValueOnce(
        new OperationError(
          'provider-unavailable',
          'OpenRouter is unavailable. Retry later.',
          true,
          503,
        ),
      )
      .mockResolvedValueOnce([{ ...issue, page: '' }]);
    const signal = new AbortController().signal;
    await expect(
      processSession(session.id, 'synthetic-key', signal, () => undefined),
    ).rejects.toThrow('OpenRouter is unavailable');
    expect((await getSession(session.id)).failures?.at(-1)).toMatchObject({
      phase: 'analysis',
      stepId: 'batch-0',
      code: 'provider-unavailable',
      retryable: true,
      httpStatus: 503,
    });
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
    expect((await getSession(session.id)).failures?.at(-1)).toMatchObject({
      phase: 'validation',
      stepId: 'recording',
      code: 'media-empty',
      retryable: false,
    });
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
  it('reserves image capacity for late markers even with dense earlier narration', () => {
    const frames: Frame[] = Array.from({ length: 61 }, (_, index) => ({
      id: `frame-${index}`,
      time: index * 2000,
      path: `screenshots/frame-${index}.jpg`,
      eventIds: [],
    }));
    const quotes = Array.from({ length: 20 }, (_, index) => ({
      id: `quote-${index}`,
      start: index * 2000,
      end: index * 2000 + 1000,
      text: 'Synthetic early narration',
    }));
    const selected = selectFrames(frames, [105000], quotes, 0, 120000);
    expect(selected.length).toBeLessThanOrEqual(12);
    expect(selected.some((frame) => frame.time >= 102000)).toBe(true);
    expect(selected.some((frame) => frame.time <= 2000)).toBe(true);
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
    ).rejects.toThrow('The analysis step failed');
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

describe('persisted processing diagnostics', () => {
  it('preflights every segment before spending credit, including repeated retries', async () => {
    const session = longerSession();
    await saveSession(session);
    vi.mocked(getMedia).mockImplementation(async (path) => {
      if (path.endsWith('audio-3.webm'))
        throw new DOMException(
          'Synthetic private path must not escape.',
          'NotFoundError',
        );
      return new File(['synthetic'], 'synthetic.webm', { type: 'audio/webm' });
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        processSession(
          session.id,
          'synthetic-key',
          new AbortController().signal,
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: 'media-unavailable', retryable: false });
    }
    const retained = await getSession(session.id);
    expect(retained.status).toBe('failed');
    expect(retained.failures).toHaveLength(2);
    expect(retained.failures?.at(-1)).toMatchObject({
      phase: 'validation',
      stepId: 'audio-3',
      code: 'media-unavailable',
      retryable: false,
    });
    expect(JSON.stringify(retained.failures)).not.toContain(
      'Synthetic private path',
    );
    expect(transcribe).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });
  it('finds a missing later image before making the first transcription request', async () => {
    const session = longerSession();
    await saveSession(session);
    vi.mocked(getMedia).mockImplementation(async (path) => {
      if (path.endsWith('frame-125000.jpg'))
        throw new DOMException(
          'Synthetic private image context.',
          'NotFoundError',
        );
      return new File(['synthetic'], 'synthetic.webm', { type: 'audio/webm' });
    });
    await expect(
      processSession(
        session.id,
        'synthetic-key',
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'media-unavailable' });
    expect((await getSession(session.id)).failures?.at(-1)).toMatchObject({
      phase: 'validation',
      stepId: 'frame-125000',
      retryable: false,
    });
    expect(transcribe).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });
  it('persists an invalid checkpoint as a validation failure without provider access', async () => {
    const session = longerSession();
    session.completedSegments = ['invented'];
    await saveSession(session);
    await expect(
      processSession(
        session.id,
        'synthetic-key',
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'invalid-session', retryable: false });
    expect((await getSession(session.id)).failures?.at(-1)).toMatchObject({
      phase: 'validation',
      stepId: 'session',
      code: 'invalid-session',
    });
    expect(transcribe).not.toHaveBeenCalled();
  });
  it('keeps the failed transcription step, HTTP reason, and failure history after successful retry', async () => {
    const session = longerSession();
    await saveSession(session);
    vi.mocked(transcribe)
      .mockRejectedValueOnce(
        new OperationError(
          'provider-credit',
          'OpenRouter request failed (HTTP 402). Add provider credit before retrying.',
          true,
          402,
        ),
      )
      .mockResolvedValue([]);
    vi.mocked(analyze).mockResolvedValue([]);
    const signal = new AbortController().signal;
    await expect(
      processSession(session.id, 'synthetic-key', signal, () => undefined),
    ).rejects.toMatchObject({ code: 'provider-credit', httpStatus: 402 });
    expect((await getSession(session.id)).failures?.at(-1)).toMatchObject({
      phase: 'transcription',
      stepId: 'audio-1',
      code: 'provider-credit',
      httpStatus: 402,
    });
    const completed = await processSession(
      session.id,
      'synthetic-key',
      signal,
      () => undefined,
    );
    expect(completed.status).toBe('complete');
    expect(completed.error).toBe('');
    expect(completed.failures).toHaveLength(1);
  });
  it('does not persist arbitrary exception content and preserves live recording ownership', async () => {
    const session = longerSession();
    await saveSession(session);
    vi.mocked(transcribe).mockRejectedValueOnce(
      new Error('Synthetic private provider body must not escape.'),
    );
    await expect(
      processSession(
        session.id,
        'synthetic-key',
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'processing-failed' });
    const failed = await getSession(session.id);
    expect(JSON.stringify(failed.failures)).not.toContain(
      'Synthetic private provider body',
    );
    const live = { ...session, status: 'recording' as const };
    await saveSession(live);
    await expect(
      processSession(
        live.id,
        'synthetic-key',
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'recording-active' });
    expect((await getSession(live.id)).status).toBe('recording');
    expect((await getSession(live.id)).failures).toBeUndefined();
  });
  it('records canceled preflight without starting provider processing', async () => {
    const session = longerSession();
    await saveSession(session);
    const controller = new AbortController();
    controller.abort('Synthetic private cancellation reason.');
    await expect(
      processSession(
        session.id,
        'synthetic-key',
        controller.signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'canceled' });
    const retained = await getSession(session.id);
    expect(retained.failures?.at(-1)).toMatchObject({
      phase: 'validation',
      stepId: 'session',
      code: 'canceled',
      retryable: true,
    });
    expect(JSON.stringify(retained.failures)).not.toContain(
      'Synthetic private cancellation reason',
    );
    expect(transcribe).not.toHaveBeenCalled();
  });
});

it.each(['events', 'media'] as const)(
  'allows retry after a transient %s read without resending completed transcription',
  async (source) => {
    const session = longerSession();
    session.completedSegments = ['audio-1'];
    session.transcript = [
      {
        id: 'audio-1-quote-1',
        start: 1000,
        end: 2000,
        text: 'Synthetic retained statement.',
      },
    ];
    await saveSession(session);
    if (source === 'events')
      vi.mocked(getEvents).mockRejectedValueOnce(
        new Error('Synthetic private IndexedDB failure.'),
      );
    else
      vi.mocked(getMedia).mockRejectedValueOnce(
        new DOMException(
          'Synthetic private OPFS interruption.',
          'InvalidStateError',
        ),
      );
    const signal = new AbortController().signal;
    await expect(
      processSession(session.id, 'synthetic-key', signal, () => undefined),
    ).rejects.toMatchObject({
      code: source === 'events' ? 'event-read-failed' : 'media-read-failed',
      retryable: true,
    });
    const retained = await getSession(session.id);
    expect(retained.failures?.at(-1)).toMatchObject({
      phase: 'validation',
      stepId: source === 'events' ? 'events' : 'recording',
      retryable: true,
    });
    expect(JSON.stringify(retained.failures)).not.toContain(
      'Synthetic private',
    );
    expect(transcribe).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    vi.mocked(transcribe).mockResolvedValue([]);
    vi.mocked(analyze).mockResolvedValue([]);
    const completed = await processSession(
      session.id,
      'synthetic-key',
      signal,
      () => undefined,
    );
    expect(completed.status).toBe('complete');
    expect(completed.completedSegments).toEqual([
      'audio-1',
      'audio-2',
      'audio-3',
    ]);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(vi.mocked(transcribe).mock.calls.map((call) => call[2].id)).toEqual([
      'audio-2',
      'audio-3',
    ]);
  },
);
