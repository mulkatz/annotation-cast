import { FailureSchema, type Failure, type Session } from './schema';
import { sanitize } from './sanitize';

/** Only controlled messages and classifications belong in this error; never provider bodies. */
export class OperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = true,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}
export function failureDetail(
  error: unknown,
  phase: Failure['phase'],
  stepId?: string,
  secrets: string[] = [],
): Failure {
  let code = 'operation-failed';
  let message =
    'The operation failed. Open the session details before retrying.';
  let retryable = true;
  if (error instanceof OperationError) {
    code = error.code;
    message = error.message;
    retryable = error.retryable;
  } else if (error instanceof Error) {
    const native: Record<string, [string, string]> = {
      NotAllowedError: [
        'permission-denied',
        'Microphone or tab access was denied. Allow access in Chrome and try again.',
      ],
      NotFoundError: [
        'device-unavailable',
        'The microphone or selected tab stream is unavailable. Select a working input and reopen the toolbar on the tested tab.',
      ],
      NotReadableError: [
        'device-busy',
        'Chrome could not read the selected media device. Close other capture applications and try again.',
      ],
      QuotaExceededError: [
        'storage-full',
        'Local storage is full. Free space or delete an older session before retrying.',
      ],
      AbortError: [
        'canceled',
        'The operation was canceled. Completed processing steps remain saved.',
      ],
      ZodError: [
        'invalid-record',
        'Stored data does not match the supported session format. Retained evidence has not been discarded.',
      ],
    };
    const known = native[error.name];
    if (known) [code, message] = known;
    else message = error.message || message;
  }
  return FailureSchema.parse({
    phase,
    code,
    message: sanitize(message, secrets).value.slice(0, 1800),
    retryable,
    occurredAt: Date.now(),
    ...(stepId
      ? { stepId: sanitize(stepId, secrets).value.slice(0, 120) }
      : {}),
    ...(error instanceof OperationError && error.httpStatus !== undefined
      ? { httpStatus: error.httpStatus }
      : {}),
  });
}
export function appendFailure(session: Session, failure: Failure): void {
  session.failures = [
    ...(session.failures ?? []),
    FailureSchema.parse(failure),
  ].slice(-20);
  session.error = failure.message;
}
export function failureAction(failure: Failure): string {
  if (!failure.retryable)
    return 'This step cannot be repaired by repeating it. Keep the retained session and record a new one.';
  if (failure.code === 'provider-auth' || failure.code === 'provider-credit')
    return 'Check your API key or provider credit, then retry the incomplete step.';
  if (failure.code === 'provider-rate-limit')
    return 'Wait for the provider limit to clear, then retry. Completed steps will be reused.';
  if (failure.phase === 'export')
    return 'Retry Download ZIP. Your recording and completed analysis remain saved.';
  if (
    failure.phase === 'setup' ||
    failure.phase === 'capture' ||
    failure.phase === 'finalization'
  )
    return 'Check microphone access and free storage. Analyze retained evidence if available, or start a new recording.';
  return 'Retry incomplete steps. Completed transcription and analysis checkpoints will be reused.';
}
