import { getMedia, listSessions } from '../../src/core/store';

async function soakInventory(includeImageHashes = true) {
  const sessions = await listSessions();
  const session = sessions.find(
    (item) =>
      item.notes.project === 'Synthetic project' && item.status === 'stopped',
  );
  if (!session)
    throw new Error('No finalized synthetic capture session was found.');
  const recording = await getMedia(session.recordingPath);
  const imageHashes: Record<string, string> = {};
  if (includeImageHashes)
    for (const frame of session.frames) {
      const image = await getMedia(`${session.id}/${frame.path}`);
      const digest = await crypto.subtle.digest(
        'SHA-256',
        await image.arrayBuffer(),
      );
      imageHashes[frame.path] = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    }
  return { session, videoBytes: recording.size, imageHashes };
}
async function downloadOriginal() {
  const { session } = await soakInventory(false);
  const file = await getMedia(session.recordingPath);
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'synthetic-soak-original.webm';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
Object.assign(globalThis, { soakInventory, downloadOriginal });
