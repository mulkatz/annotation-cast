/** Web Locks serialize session mutations across independently opened extension pages. */
export async function withSessionLock<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  return navigator.locks.request(
    `annotation-cast-session-${id}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new Error(
          'This session is being processed in another extension page. Wait for it to finish or cancel there.',
        );
      return operation();
    },
  );
}
