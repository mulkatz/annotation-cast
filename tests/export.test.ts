import { describe, it, expect, vi } from 'vitest';
import { BlobReader, BlobWriter, TextWriter, ZipReader } from '@zip.js/zip.js';
import { exportData, writeBundle, exportZip, report } from '../src/core/export';
import { sanitize } from '../src/core/sanitize';
import * as store from '../src/core/store';
import { fixtureSession } from './fixtures';
import type { SessionEvent } from '../src/core/schema';
function completeSession() {
  const session = fixtureSession();
  session.status = 'complete';
  session.audio = [
    {
      id: 'audio-1',
      path: `${session.id}/audio/audio-1.webm`,
      start: 0,
      end: 5000,
    },
  ];
  session.completedSegments = ['audio-1'];
  session.completedBatches = ['batch-0'];
  session.frames = [
    { id: 'frame-1', time: 50, path: 'screenshots/frame-1.jpg', eventIds: [] },
  ];
  session.transcript = [
    {
      id: 'audio-1-quote-1',
      start: 50,
      end: 100,
      text: 'password: synthetic-sensitive-value',
    },
  ];
  return session;
}
describe('evidence bundle integrity', () => {
  it('consolidates narrated findings, marker details, temporal images, notes and gaps without inventing model citations', async () => {
    const session = completeSession();
    session.notes.project = 'Synthetic checkout';
    session.findings = [
      {
        id: 'issue-1',
        title: 'Button clips',
        description: 'The narrated label clips.',
        start: 50,
        end: 100,
        page: session.url,
        evidenceIds: ['marker-1'],
        quoteIds: ['audio-1-quote-1'],
        hypotheses: ['An unverified layout cause.'],
        expectedBehavior: null,
        reproduction: [],
        association: 'supported',
      },
    ];
    const events: SessionEvent[] = [
      {
        id: 'marker-1',
        sessionId: session.id,
        type: 'rectangle',
        time: 60,
        url: session.url,
        data: {
          x: 12,
          y: 24,
          width: 80,
          height: 30,
          selection: 'password: synthetic-sensitive-value',
          label: '```\n# untrusted text',
        },
      },
      {
        id: 'other-marker',
        sessionId: session.id,
        type: 'point',
        time: 70,
        url: session.url,
        data: { x: 30, y: 40 },
      },
      {
        id: 'gap-1',
        sessionId: session.id,
        type: 'gap',
        time: 2000,
        url: session.url,
        data: { reason: 'Synthetic context interruption' },
      },
    ];
    const data = exportData(session, events, 'synthetic-key');
    const markdown = report(data.session, data.events);
    for (const value of [
      'Synthetic checkout',
      'Button clips',
      'Source statement audio-1-quote-1',
      'Event marker-1',
      '"width": 80',
      'Temporal candidate',
      '![frame-1 at 50 ms](screenshots/frame-1.jpg)',
      'Full transcript',
      'Other markers',
      'other-marker',
      'Coverage gaps',
      'Synthetic context interruption',
      'AI hypotheses (unverified)',
    ])
      expect(markdown).toContain(value);
    expect(markdown).not.toContain('synthetic-sensitive-value');
    expect(markdown).not.toContain('Model-cited image:');
    expect(data.session.findings[0]?.evidenceIds).toEqual(['marker-1']);
    const output = new BlobWriter('application/zip');
    await writeBundle(
      data,
      output.writable,
      async () => new Blob(['image']),
      new Blob(['video']),
      () => undefined,
    );
    const reader = new ZipReader(new BlobReader(await output.getData()), {
      useWebWorkers: false,
    });
    const entries = await reader.getEntries();
    for (const entry of entries) {
      if (!('getData' in entry) || !entry.getData) continue;
      if (entry.filename === 'report.md')
        expect(await entry.getData(new TextWriter())).toBe(markdown);
      if (entry.filename === 'issues.json')
        expect(JSON.parse(await entry.getData(new TextWriter()))).toMatchObject(
          {
            issues: [{ evidenceIds: ['marker-1'] }],
            frameAssociations: [
              {
                issueId: 'issue-1',
                frames: [
                  {
                    frameId: 'frame-1',
                    provenance: 'marker-context',
                    anchorId: 'marker-1',
                  },
                ],
              },
            ],
          },
        );
    }
    await reader.close();
  });
  it('labels model citations and explicitly identifies a missing safe visual association', () => {
    const session = completeSession();
    session.findings = [
      {
        id: 'issue-1',
        title: 'Synthetic',
        description: 'Narrated observation',
        start: 50,
        end: 100,
        page: session.url,
        evidenceIds: ['frame-1'],
        quoteIds: ['audio-1-quote-1'],
        hypotheses: [],
        expectedBehavior: null,
        reproduction: [],
        association: 'supported',
      },
    ];
    expect(report(session)).toContain('Model-cited image: frame-1');
    session.findings[0]!.evidenceIds = [];
    expect(report(session)).toContain(
      'No safely associated image is available',
    );
    expect(report(session)).not.toContain('![frame-1');
  });
  it('preserves unmarked delayed narration and corrections separately from image provenance', () => {
    const session = completeSession();
    session.transcript = [
      {
        id: 'audio-1-quote-original',
        start: 1000,
        end: 1500,
        text: 'The button was missing earlier.',
      },
      {
        id: 'audio-1-quote-correction',
        start: 2000,
        end: 2500,
        text: 'Correction: the button exists; its label clips.',
      },
      {
        id: 'audio-1-quote-unmarked',
        start: 3000,
        end: 3500,
        text: 'The panel spacing is uneven.',
      },
      {
        id: 'audio-1-quote-unclear',
        start: 4500,
        end: 4900,
        text: 'I cannot tell which page showed that state.',
      },
    ];
    session.frames.push({
      id: 'frame-2',
      time: 3000,
      path: 'screenshots/frame-2.jpg',
      eventIds: [],
    });
    session.findings = [
      {
        id: 'issue-1',
        title: 'Clipped label',
        description:
          'The later statement corrects the missing-button observation.',
        start: 1000,
        end: 2500,
        page: session.url,
        evidenceIds: ['frame-1'],
        quoteIds: ['audio-1-quote-original', 'audio-1-quote-correction'],
        hypotheses: [],
        expectedBehavior: null,
        reproduction: [],
        association: 'uncertain',
      },
      {
        id: 'issue-2',
        title: 'Uneven spacing',
        description: 'An observation without a marker.',
        start: 3000,
        end: 3500,
        page: session.url,
        evidenceIds: [],
        quoteIds: ['audio-1-quote-unmarked'],
        hypotheses: [],
        expectedBehavior: null,
        reproduction: [],
        association: 'uncertain',
      },
      {
        id: 'issue-3',
        title: 'Unresolved state',
        description: 'The page and visual association are unknown.',
        start: 4500,
        end: 4900,
        page: '',
        evidenceIds: [],
        quoteIds: ['audio-1-quote-unclear'],
        hypotheses: [],
        expectedBehavior: null,
        reproduction: [],
        association: 'incomplete',
      },
    ];
    const events: SessionEvent[] = [
      {
        id: 'context',
        sessionId: session.id,
        time: 0,
        type: 'context',
        url: session.url,
        data: { reason: 'page context initialized' },
      },
    ];
    const data = exportData(session, events, 'synthetic-key');
    const markdown = report(data.session, data.events);
    const delayed = markdown.split('## issue-1:')[1]?.split('## issue-2:')[0];
    const unmarked = markdown.split('## issue-2:')[1]?.split('## issue-3:')[0];
    const incomplete = markdown
      .split('## issue-3:')[1]
      ?.split('## Full transcript')[0];
    expect(delayed).toContain(
      'Source statement audio-1-quote-original (1000–1500 ms): The button was missing earlier.',
    );
    expect(delayed).toContain(
      'Source statement audio-1-quote-correction (2000–2500 ms): Correction: the button exists; its label clips.',
    );
    expect(delayed).toContain('Model-cited image: frame-1 · 50 ms');
    expect(delayed).not.toContain('Temporal candidate');
    expect(unmarked).toContain(
      'Source statement audio-1-quote-unmarked (3000–3500 ms)',
    );
    expect(unmarked).toContain(
      'Temporal candidate (automatically selected; not confirmed visual evidence): frame-2',
    );
    expect(unmarked).toContain(
      '![frame-2 at 3000 ms](screenshots/frame-2.jpg)',
    );
    expect(unmarked).not.toContain('Model-cited image');
    expect(incomplete).toContain('Association: incomplete');
    expect(incomplete).toContain('No safely associated image is available');
    expect(incomplete).toContain(
      'Source statement audio-1-quote-unclear (4500–4900 ms)',
    );
    expect(data.session.findings.map((finding) => finding.evidenceIds)).toEqual(
      [['frame-1'], [], []],
    );
    expect(data.session.transcript).toEqual(session.transcript);
    expect(
      data.events.every(
        (event) => event.type !== 'point' && event.type !== 'rectangle',
      ),
    ).toBe(true);
  });
  it('exposes analysis omissions even when recording has no explicit gap event', () => {
    const session = completeSession();
    const markdown = report(session, [
      {
        id: 'context-limit',
        sessionId: session.id,
        time: 0,
        type: 'status',
        url: '',
        data: {
          kind: 'analysis-context-limit',
          batchId: 'batch-0',
          omittedEvents: 80,
          omittedStatements: 2,
        },
      },
    ]);
    expect(markdown).toContain('Analysis coverage limitations');
    expect(markdown).toContain('"omittedEvents": 80');
    expect(markdown).toContain('"omittedStatements": 2');
    expect(markdown).toContain('omitted from AI requests');
  });
  it('streams every required file with safe relative references and sanitized text', async () => {
    const session = completeSession();
    const output = new BlobWriter('application/zip');
    await writeBundle(
      exportData(session, [], 'synthetic-key'),
      output.writable,
      async () => new Blob(['synthetic image']),
      new Blob(['synthetic video']),
      () => undefined,
    );
    const reader = new ZipReader(new BlobReader(await output.getData()), {
      useWebWorkers: false,
    });
    const entries = await reader.getEntries();
    expect(entries.map((entry) => entry.filename)).toEqual([
      'README.md',
      'recording.webm',
      'report.md',
      'issues.json',
      'transcript.json',
      'events.json',
      'session.json',
      'screenshots/frame-1.jpg',
    ]);
    for (const entry of entries) {
      expect(entry.filename).not.toContain('..');
      if (
        'getData' in entry &&
        entry.getData &&
        entry.filename.endsWith('.json')
      ) {
        const text = await entry.getData(new TextWriter());
        expect(text).not.toContain('synthetic-sensitive-value');
        expect(text).not.toContain('synthetic-key');
        JSON.parse(text);
      }
    }
    await reader.close();
  });
  it('keeps provider page references aligned with exported event URLs after multiple sanitation passes', () => {
    const session = completeSession();
    const url = 'https://example.test/?password=synthetic-value&mode=demo';
    session.findings = [
      {
        id: 'issue-1',
        title: 'Synthetic',
        description: 'Synthetic observation',
        start: 50,
        end: 100,
        page: sanitize(sanitize(url).value).value,
        evidenceIds: ['event-1'],
        quoteIds: ['audio-1-quote-1'],
        hypotheses: [],
        expectedBehavior: null,
        reproduction: [],
        association: 'supported',
      },
    ];
    const data = exportData(
      session,
      [
        {
          id: 'event-1',
          sessionId: session.id,
          time: 50,
          type: 'point',
          url,
          data: {},
        },
      ],
      '',
    );
    expect(data.session.findings[0]?.page).toBe(data.events[0]?.url);
    expect(data.events[0]?.url).not.toContain('synthetic-value');
  });
  it('rejects incomplete analyses, corrupt checkpoints, and invented references', () => {
    expect(() => exportData(fixtureSession(), [], '')).toThrow();
    const session = completeSession();
    session.completedSegments.push('unknown');
    expect(() => exportData(session, [], '')).toThrow('inconsistent');
    const invalid = completeSession();
    invalid.findings = [
      {
        id: 'issue-1',
        title: 'Synthetic',
        description: 'Synthetic',
        start: 0,
        end: 100,
        page: '',
        evidenceIds: ['missing-image'],
        quoteIds: ['audio-1-quote-1'],
        hypotheses: [],
        expectedBehavior: null,
        reproduction: [],
        association: 'supported',
      },
    ];
    expect(() => exportData(invalid, [], '')).toThrow('inconsistent');
    const wrongPath = completeSession();
    wrongPath.recordingPath = 'other/recording.webm';
    expect(() => exportData(wrongPath, [], '')).toThrow('inconsistent');
  });
});

it('includes screenshot bytes in ZIP space checks before opening an output file', async () => {
  const session = completeSession();
  vi.spyOn(store, 'getSession').mockResolvedValue(session);
  vi.spyOn(store, 'getEvents').mockResolvedValue([]);
  const image = new File([], 'frame.jpg', { type: 'image/jpeg' });
  // Only file metadata is read during preflight; no40MB fixture allocation is needed.
  Object.defineProperty(image, 'size', { value: 40 * 1024 * 1024 });
  vi.spyOn(store, 'getMedia').mockImplementation(async (path) =>
    path.endsWith('recording.webm')
      ? new File(['synthetic video'], 'recording.webm')
      : image,
  );
  const create = vi.spyOn(store, 'mediaHandle');
  vi.stubGlobal('navigator', {
    locks: navigator.locks,
    storage: { estimate: async () => ({ quota: 33 * 1024 * 1024, usage: 0 }) },
  });
  await expect(exportZip(session, '', () => undefined)).rejects.toThrow(
    'Not enough local space',
  );
  expect(create).not.toHaveBeenCalled();
});
it('leaves live capture metadata untouched when export is requested directly', async () => {
  const session = fixtureSession();
  session.status = 'recording';
  vi.spyOn(store, 'getSession').mockResolvedValue(session);
  const saved = vi.spyOn(store, 'saveSession');
  await expect(exportZip(session, '', () => undefined)).rejects.toThrow(
    'Stop recording before exporting',
  );
  expect(saved).not.toHaveBeenCalled();
  expect(session.failures).toBeUndefined();
  expect(session.status).toBe('recording');
});
it('does not mutate or inspect a session when another page owns its export or deletion lock', async () => {
  const session = completeSession();
  const read = vi.spyOn(store, 'getSession');
  const saved = vi.spyOn(store, 'saveSession');
  vi.stubGlobal('navigator', {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: null) => Promise<unknown>,
      ) => callback(null),
    },
  });
  await expect(exportZip(session, '', () => undefined)).rejects.toThrow(
    'another extension page',
  );
  expect(read).not.toHaveBeenCalled();
  expect(saved).not.toHaveBeenCalled();
});
