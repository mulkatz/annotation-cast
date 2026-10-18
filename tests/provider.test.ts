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
  it('uses a compact structural provider schema without weakening the local contract', async () => {
    const fetcher = vi.fn().mockResolvedValue(chat({ findings: [finding] }));
    vi.stubGlobal('fetch', fetcher);
    await analyze(key, input);
    const options = fetcher.mock.calls[0]?.[1] as RequestInit;
    const schema = JSON.parse(String(options.body)).response_format.json_schema
      .schema;
    expect(schema).toMatchObject({
      type: 'object',
      required: ['findings'],
      additionalProperties: false,
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              association: { enum: ['supported', 'uncertain', 'incomplete'] },
            },
          },
        },
      },
    });
    expect(JSON.stringify(schema)).not.toMatch(
      /"(?:maxLength|minLength|pattern|maxItems|minItems|minimum|maximum)"/,
    );
  });
  it.each([
    { ...finding, title: 'x'.repeat(301) },
    { ...finding, start: -1 },
    { ...finding, id: 'invalid-id' },
    { ...finding, reproduction: Array.from({ length: 16 }, () => 'step') },
  ])(
    'still rejects local bound violations after compact generation %j',
    async (invalid) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(chat({ findings: [invalid] })),
      );
      await expect(analyze(key, input)).rejects.toThrow(
        'required structured output',
      );
    },
  );
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
      .mockResolvedValueOnce(chat({ color: 'red', findings: [] }));
    vi.stubGlobal('fetch', fetcher);
    await expect(checkProvider(key)).rejects.toThrow('readiness image');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('checks the full findings structure in the paid readiness image request', async () => {
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
      .mockResolvedValueOnce(chat({ color: 'blue', findings: [] }));
    vi.stubGlobal('fetch', fetcher);
    await expect(checkProvider(key)).resolves.toBeUndefined();
    const options = fetcher.mock.calls[2]?.[1] as RequestInit;
    expect(
      JSON.parse(String(options.body)).response_format.json_schema.schema,
    ).toMatchObject({
      properties: { findings: { type: 'array', items: { type: 'object' } } },
    });
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

describe('safe provider failure classifications', () => {
  it.each([
    [401, 'provider-auth'],
    [402, 'provider-credit'],
    [403, 'provider-access'],
    [400, 'provider-compatibility'],
    [404, 'provider-compatibility'],
    [422, 'provider-compatibility'],
  ])(
    'classifies HTTP %s without retrying or exposing response content',
    async (status, code) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          new Response(`Synthetic private response ${key}`, { status }),
        );
      vi.stubGlobal('fetch', fetcher);
      const error = await transcribe(key, audio, segment).catch(
        (error) => error,
      );
      expect(error).toMatchObject({
        code,
        httpStatus: status,
        retryable: true,
      });
      expect(error.message).not.toContain(key);
      expect(error.message).not.toContain('Synthetic private response');
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps a long server-availability wait distinct from a rate limit', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('Synthetic unavailable', {
        status: 503,
        headers: { 'Retry-After': '60' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(transcribe(key, audio, segment)).rejects.toMatchObject({
      code: 'provider-unavailable',
      httpStatus: 503,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed outer JSON without repeating a successful paid request', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(`Synthetic invalid JSON ${key}`, {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(transcribe(key, audio, segment)).rejects.toMatchObject({
      code: 'provider-invalid-json',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      json({ unexpected: 'Synthetic private body' }),
      'provider-response-schema',
    ],
    [
      json({ choices: [{ message: { content: 'Synthetic invalid JSON' } }] }),
      'provider-output-json',
    ],
    [
      chat({ findings: [{ ...finding, title: 'x'.repeat(301) }] }),
      'provider-output-schema',
    ],
    [
      chat({ findings: [{ ...finding, quoteIds: ['unknown'] }] }),
      'provider-quote-reference',
    ],
    [
      chat({ findings: [{ ...finding, evidenceIds: ['unknown'] }] }),
      'provider-evidence-reference',
    ],
    [
      chat({ findings: [{ ...finding, page: 'https://unknown.test/' }] }),
      'provider-page-reference',
    ],
    [chat({ findings: [{ ...finding, end: 9000 }] }), 'provider-timestamps'],
    [chat({ findings: [finding, finding] }), 'provider-duplicate-id'],
  ])('classifies invalid output as %s', async (response, code) => {
    const fetcher = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetcher);
    await expect(analyze(key, input)).rejects.toMatchObject({
      code,
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('distinguishes a bounded request timeout from network failure', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(
      (_url, options: RequestInit) =>
        new Promise((_, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Synthetic timeout.', 'AbortError')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const assertion = expect(
      transcribe(key, audio, segment),
    ).rejects.toMatchObject({ code: 'provider-timeout' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockRejectedValue(
      new TypeError('Synthetic private connection message.'),
    );
    const network = expect(
      transcribe(key, audio, segment),
    ).rejects.toMatchObject({ code: 'provider-network' });
    await vi.runAllTimersAsync();
    await network;
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
});
