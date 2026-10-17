import { addEvent, listSessions, saveSession } from '../core/store';
import { withSessionLock } from '../core/lock';

/** Share concurrent checks, retain success, and let a later operation retry a failed check. */
export function createRecoveryGate(): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending) {
      const attempt = recoverInterruptedCapture();
      pending = attempt;
      void attempt.catch(() => {
        if (pending === attempt) pending = undefined;
      });
    }
    return pending;
  };
}

/** A worker restart is not a recording interruption while its offscreen capture survives. */
export async function recoverInterruptedCapture(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length) return;
  let recovered = false;
  for (const checkpoint of await listSessions()) {
    if (checkpoint.status !== 'recording') continue;
    await withSessionLock(checkpoint.id, async () => {
      const session = (await listSessions()).find(
        (item) => item.id === checkpoint.id,
      );
      if (!session || session.status !== 'recording') return;
      session.status = 'interrupted';
      session.error =
        'Browser recording was interrupted; existing media and evidence were recovered on a best-effort basis.';
      session.duration = Math.max(
        session.duration,
        session.frames.at(-1)?.time ?? 0,
        session.audio.at(-1)?.end ?? 0,
      );
      await addEvent({
        id: `recovery-${session.id}`,
        sessionId: session.id,
        type: 'gap',
        time: session.duration,
        url: session.url,
        data: { reason: session.error },
      });
      // A stable gap is persisted first: failed checkpoint writes can retry safely.
      await saveSession(session);
      recovered = true;
    });
  }
  const runtime = await chrome.storage.session.get('activeSession');
  if (recovered || runtime.activeSession)
    await chrome.storage.session.remove(['activeSession', 'readiness']);
}
