/** Session timestamps are milliseconds measured from the actual recorder start epoch. */
export function sessionTime(startedAt: number, epoch = Date.now()): number {
  return Math.max(0, epoch - startedAt);
}
export function segmentEnd(start: number, end: number): number {
  return Math.max(start, end);
}
export function readinessValid(
  readiness: unknown,
  tabId: number,
  fingerprint: string,
  now = Date.now(),
): boolean {
  if (typeof readiness !== 'object' || readiness === null) return false;
  const value = readiness as Record<string, unknown>;
  return (
    value.tabId === tabId &&
    value.keyFingerprint === fingerprint &&
    typeof value.checkedAt === 'number' &&
    value.checkedAt <= now &&
    now - value.checkedAt < 600_000
  );
}
export async function keyFingerprint(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
