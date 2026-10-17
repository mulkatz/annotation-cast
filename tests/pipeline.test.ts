import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureSession } from './fixtures';
import {
  processSession,
  mergeFindings,
  selectFrames,
} from '../src/core/pipeline';
import { getSession, saveSession, getMedia } from '../src/core/store';
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
