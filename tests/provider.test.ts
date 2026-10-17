import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyze,
  checkProvider,
  transcribe,
} from '../src/providers/openrouter';
import type { AnalysisInput } from '../src/providers/openrouter';

const key = 'synthetic-test-credential';
const segment = {
  id: 'audio-1',
  path: 'audio/segment.webm',
  start: 10_000,
  end: 20_000,
};
const audio = new Blob(['synthetic audio'], { type: 'audio/webm' });
const finding = {
  id: 'issue-1',
  title: 'Menu clips',
  description: 'The narrated menu clips.',
  start: 1000,
  end: 2000,
  page: 'https://example.test/',
  evidenceIds: ['event-1', 'frame-1'],
  quoteIds: ['quote-1'],
  hypotheses: [],
  expectedBehavior: null,
  reproduction: [],
  association: 'supported',
};
const input: AnalysisInput = {
  duration: 5000,
  transcript: [
    { id: 'quote-1', start: 1000, end: 2000, text: 'The menu clips.' },
  ],
  events: [
    {
      id: 'event-1',
      sessionId: 'session-1',
      time: 1000,
      type: 'point',
      url: 'https://example.test/',
      data: {},
    },
  ],
  frames: [
    {
      id: 'frame-1',
      time: 1000,
      path: 'screenshots/frame-1.jpg',
      eventIds: ['event-1'],
      dataUrl: 'data:image/jpeg;base64,AAAA',
    },
  ],
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
const chat = (body: unknown) =>
  json({ choices: [{ message: { content: JSON.stringify(body) } }] });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OpenRouter adapters', () => {
  it('maps actual provider seconds to the segment timeline and requests verbose timestamps', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({
        text: 'Menu clips.',
        segments: [{ start: 0.25, end: 1.5, text: 'Menu clips.' }],
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(await transcribe(key, audio, segment)).toEqual([
      { id: 'audio-1-quote-1', start: 10250, end: 11500, text: 'Menu clips.' },
    ]);
    const options = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(options.body))).toMatchObject({
      model: 'openai/whisper-large-v3',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment', 'word'],
    });
  });
  it('rejects plain transcription and invalid timestamps instead of inventing timing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ text: 'Menu clips.' }))
        .mockResolvedValueOnce(
          json({
            text: 'Menu clips.',
            segments: [{ start: 5, end: 4, text: 'Menu clips.' }],
          }),
        ),
    );
    await expect(transcribe(key, audio, segment)).rejects.toThrow(
      'timestamped speech',
    );
    await expect(transcribe(key, audio, segment)).rejects.toThrow(
      'invalid timestamps',
    );
  });
  it('rejects speech starting at the exact audio end before creating a checkpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          text: 'Synthetic trailing speech.',
          segments: [
            { start: 10, end: 10.5, text: 'Synthetic trailing speech.' },
          ],
        }),
      ),
    );
    await expect(transcribe(key, audio, segment)).rejects.toThrow(
      'invalid timestamps',
    );
  });
  it('sanitizes analysis evidence and model text while retaining evidence IDs', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      chat({
        findings: [{ ...finding, description: `Narrated secret ${key}` }],
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const result = await analyze(key, {
      ...input,
      transcript: [{ ...input.transcript[0]!, text: `Menu clips. ${key}` }],
    });
    expect(result[0]?.description).not.toContain(key);
    const options = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(String(options.body)).not.toContain(key);
    expect(JSON.parse(String(options.body))).toMatchObject({
      provider: { require_parameters: true },
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
  });
  it.each([
    { ...finding, evidenceIds: ['invented'] },
    { ...finding, quoteIds: ['invented'] },
    { ...finding, quoteIds: [] },
    { ...finding, end: 9000 },
    { ...finding, page: 'https://invented.test/' },
    { ...finding, evidenceIds: [] },
  ])('rejects unsupported findings %j', async (invalid) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(chat({ findings: [invalid] })),
    );
    await expect(analyze(key, input)).rejects.toThrow('unsupported evidence');
  });
  it('does not retry authentication errors or expose provider response bodies', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(`private echo: ${key}`, { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(transcribe(key, audio, segment)).rejects.toThrow('HTTP 401');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds transient retries and honors cancellation during backoff', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const promise = transcribe(key, audio, segment);
    const assertion = expect(promise).rejects.toThrow('three attempts');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(3);
    const controller = new AbortController();
    const cancelled = transcribe(key, audio, segment, controller.signal);
    const cancelledAssertion = expect(cancelled).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.runAllTimersAsync();
    await cancelledAssertion;
  });
  it('verifies timestamped spoken sample and actual image answer for readiness', async () => {
    vi.stubGlobal('chrome', {
      runtime: { getURL: () => 'chrome-extension://synthetic/readiness.wav' },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(
        json({
          text: 'The blue button is missing.',
          segments: [{ start: 0, end: 2, text: 'The blue button is missing.' }],
        }),
      )
      .mockResolvedValueOnce(chat({ color: 'red' }));
    vi.stubGlobal('fetch', fetcher);
    await expect(checkProvider(key)).rejects.toThrow('readiness image');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

it('passes sanitized notes as user context without promoting them to system instructions', async () => {
  const fetcher = vi.fn().mockResolvedValue(chat({ findings: [] }));
  vi.stubGlobal('fetch', fetcher);
  await analyze(key, {
    ...input,
    notes: {
      project: 'Synthetic project',
      objective: `Test menu ${key}`,
      environment: 'Test browser',
      reference: 'synthetic-build',
    },
  });
  const options = fetcher.mock.calls[0]?.[1] as RequestInit;
  const body = JSON.parse(String(options.body));
  expect(body.messages[0].content).not.toContain('Synthetic project');
  expect(body.messages[1].content[0].text).toContain('Synthetic project');
  expect(body.messages[1].content[0].text).not.toContain(key);
});

it.each(['120', new Date(Date.now() + 120_000).toUTCString()])(
  'does not retry before long Retry-After: %s',
  async (retryAfter) => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('limited', {
        status: 429,
        headers: { 'Retry-After': retryAfter },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(transcribe(key, audio, segment)).rejects.toThrow(
      'Retry the failed step later',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it('does not treat diagnostic request URLs as observed pages', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      chat({
        findings: [{ ...finding, page: 'https://api.example.test/request' }],
      }),
    ),
  );
  await expect(
    analyze(key, {
      ...input,
      events: [
        ...input.events,
        {
          id: 'network-1',
          sessionId: 'session-1',
          time: 1200,
          type: 'network',
          url: 'https://api.example.test/request',
          data: {},
        },
      ],
    }),
  ).rejects.toThrow('unsupported evidence');
});
