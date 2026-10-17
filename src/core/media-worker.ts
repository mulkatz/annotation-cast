/// <reference lib="webworker" />
import { z } from 'zod';
interface SyncHandle {
  write(buffer: ArrayBuffer, options: { at: number }): number;
  getSize(): number;
  flush(): void;
  close(): void;
}
const handles = new Map<string, SyncHandle>();
const RequestSchema = z.object({
  id: z.number(),
  path: z.string().regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/),
  data: z.instanceof(ArrayBuffer).optional(),
  close: z.boolean(),
});
let chain = Promise.resolve();
self.onmessage = (event: MessageEvent<unknown>) => {
  chain = chain
    .then(async () => {
      const input = RequestSchema.parse(event.data);
      try {
        let handle = handles.get(input.path);
        if (input.close) {
          handle?.flush();
          handle?.close();
          handles.delete(input.path);
        } else {
          if (!handle) {
            const [directoryName, fileName] = input.path.split('/');
            if (!directoryName || !fileName)
              throw new Error('Invalid recording path.');
            const root = await navigator.storage.getDirectory();
            const directory = await root.getDirectoryHandle(directoryName, {
              create: true,
            });
            const file = await directory.getFileHandle(fileName, {
              create: true,
            });
            // Chrome's OPFS sync access handle is available only in dedicated workers.
            const syncFile = file as FileSystemFileHandle & {
              createSyncAccessHandle(): Promise<SyncHandle>;
            };
            handle = await syncFile.createSyncAccessHandle();
            handles.set(input.path, handle);
          }
          if (!input.data) throw new Error('Missing recording chunk.');
          const written = handle.write(input.data, { at: handle.getSize() });
          if (written !== input.data.byteLength)
            throw new Error('Recording storage is full.');
          handle.flush();
        }
        self.postMessage({ id: input.id, ok: true });
      } catch {
        self.postMessage({ id: input.id, ok: false });
      }
    })
    .catch(() => {
      self.postMessage({ id: -1, ok: false });
    });
};
