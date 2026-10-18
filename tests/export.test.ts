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
