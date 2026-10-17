import { describe, it, expect } from 'vitest';
import {
  addEvent,
  getEvents,
  saveSession,
  getSession,
} from '../src/core/store';
import { fixtureSession } from './fixtures';
describe('local storage boundary', () => {
  it('persists independent checkpoints and sorts timeline events', async () => {
    const session = fixtureSession();
    await saveSession(session);
    for (const time of [2000, 1000])
      await addEvent({
        id: crypto.randomUUID(),
        sessionId: session.id,
        time,
        type: 'point',
        url: session.url,
        data: {},
      });
    expect((await getEvents(session.id)).map((event) => event.time)).toEqual([
      1000, 2000,
    ]);
    expect((await getSession(session.id)).status).toBe('stopped');
  });
  it('rejects corrupt persisted records at the write boundary', async () => {
    await expect(
      saveSession({ ...fixtureSession(), duration: -1 }),
    ).rejects.toThrow();
  });
});
