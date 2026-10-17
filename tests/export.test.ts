import { describe, it, expect } from 'vitest';
import { BlobReader, BlobWriter, TextWriter, ZipReader } from '@zip.js/zip.js';
import { exportData, writeBundle } from '../src/core/export';
import { fixtureSession } from './fixtures';
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
