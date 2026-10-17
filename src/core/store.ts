import { withSessionLock } from './lock';
import { z } from 'zod';
import {
  EventSchema,
  SessionSchema,
  type Session,
  type SessionEvent,
} from './schema';

let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('annotation-cast', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('sessions', { keyPath: 'id' });
      const events = request.result.createObjectStore('events', {
        keyPath: 'id',
      });
      events.createIndex('sessionId', 'sessionId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error('Local session storage could not be opened.'));
  });
  return database;
}
async function read<T>(
  store: string,
  make: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = make(database.transaction(store).objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error('Local session data could not be read.'));
  });
}
async function write(
  store: string,
  make: (store: IDBObjectStore) => void,
): Promise<void> {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(store, 'readwrite');
    make(tx.objectStore(store));
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(
        new Error(
          'Local session data could not be saved. Recording may be interrupted.',
        ),
      );
  });
}
export async function getSession(id: string): Promise<Session> {
  return SessionSchema.parse(await read('sessions', (store) => store.get(id)));
}
export async function saveSession(session: Session): Promise<void> {
  const valid = SessionSchema.parse(session);
  await write('sessions', (store) => {
    store.put(valid);
  });
}
export async function listSessions(): Promise<Session[]> {
  const values: unknown[] = await read('sessions', (store) => store.getAll());
  return values
    .map((value) => SessionSchema.parse(value))
    .sort((a, b) => b.createdAt - a.createdAt);
}
export async function addEvent(event: SessionEvent): Promise<void> {
  const valid = EventSchema.parse(event);
  await write('events', (store) => {
    store.put(valid);
  });
}
export async function getEvents(sessionId: string): Promise<SessionEvent[]> {
  const values: unknown[] = await read('events', (store) =>
    store.index('sessionId').getAll(sessionId),
  );
  return values
    .map((value) => EventSchema.parse(value))
    .sort((a, b) => a.time - b.time);
}
function safePath(path: string): string[] {
  const parts = path.split('/');
  if (
    parts.some(
      (part) =>
        !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..',
    )
  )
    throw new Error('Invalid local file path.');
  return parts;
}
export async function mediaHandle(
  path: string,
  create = false,
): Promise<FileSystemFileHandle> {
  const parts = safePath(path);
  const name = parts.pop();
  if (!name) throw new Error('A file name is required.');
  let directory = await navigator.storage.getDirectory();
  for (const part of parts)
    directory = await directory.getDirectoryHandle(part, { create });
  return directory.getFileHandle(name, { create });
}
const WorkerReplySchema = z.object({ id: z.number(), ok: z.boolean() });
let mediaWorker: Worker | undefined;
let requestId = 0;
const pending = new Map<
  number,
  {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function failMediaWorker(message: string): void {
  mediaWorker?.terminate();
  mediaWorker = undefined;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(message));
  }
  pending.clear();
}
async function workerRequest(
  path: string,
  data: ArrayBuffer | undefined,
  close: boolean,
): Promise<void> {
  if (!mediaWorker) {
    mediaWorker = new Worker(chrome.runtime.getURL('media-worker.js'));
    mediaWorker.onmessage = (event: MessageEvent<unknown>) => {
      const result = WorkerReplySchema.safeParse(event.data);
      if (!result.success) return;
      const request = pending.get(result.data.id);
      pending.delete(result.data.id);
      if (request) clearTimeout(request.timer);
      if (result.data.ok) request?.resolve();
      else
        request?.reject(
          new Error('Recording storage failed. Check available disk space.'),
        );
    };
    mediaWorker.onerror = () =>
      failMediaWorker('Recording storage worker failed.');
  }
  const id = ++requestId;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        failMediaWorker(
          'Recording storage timed out. Local evidence was retained best effort.',
        ),
      20000,
    );
    pending.set(id, { resolve, reject, timer });
    mediaWorker?.postMessage({ id, path, data, close }, data ? [data] : []);
  });
}
export async function writeMedia(
  path: string,
  blob: Blob,
  append = false,
): Promise<void> {
  safePath(path);
  if (append) await workerRequest(path, await blob.arrayBuffer(), false);
  else {
    const stream = await (await mediaHandle(path, true)).createWritable();
    try {
      await stream.write(blob);
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => undefined);
      throw error;
    }
  }
}
export async function closeMedia(path: string): Promise<void> {
  await workerRequest(path, undefined, true);
}
export async function getMedia(path: string): Promise<File> {
  const file = await (await mediaHandle(path)).getFile();
  const type = path.endsWith('.webm')
    ? path.includes('audio')
      ? 'audio/webm'
      : 'video/webm'
    : path.endsWith('.jpg')
      ? 'image/jpeg'
      : path.endsWith('.zip')
        ? 'application/zip'
        : file.type;
  return new File([file], file.name, { type });
}
async function deleteUnlocked(id: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid session ID.');
  // Retain the visible session until its sensitive media is gone, allowing a failed
  // filesystem deletion to be retried instead of orphaning the original recording.
  try {
    await (
      await navigator.storage.getDirectory()
    ).removeEntry(id, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError'))
      throw error;
  }
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['sessions', 'events'], 'readwrite');
    tx.objectStore('sessions').delete(id);
    const events = tx.objectStore('events');
    const cursor = events
      .index('sessionId')
      .openKeyCursor(IDBKeyRange.only(id));
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      events.delete(cursor.result.primaryKey);
      cursor.result.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(
        new Error(
          'Local session metadata could not be deleted. Retry deletion.',
        ),
      );
  });
}

export async function deleteSession(id: string): Promise<void> {
  await withSessionLock(id, () => deleteUnlocked(id));
}
