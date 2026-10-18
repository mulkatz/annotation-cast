import { expect, it } from 'vitest';
import {
  appendFailure,
  failureDetail,
  OperationError,
} from '../src/core/failures';
import { SessionSchema } from '../src/core/schema';
import { fixtureSession } from './fixtures';

it('keeps old sessions readable and bounds actionable failure history without credential values', () => {
  const session = SessionSchema.parse(fixtureSession());
  expect(session.failures).toBeUndefined();
  for (let index = 0; index < 25; index++)
    appendFailure(
      session,
      failureDetail(
        new OperationError(
          'provider-auth',
          'Check synthetic-secret-value',
          true,
          401,
        ),
        'transcription',
        `audio-${index}`,
        ['synthetic-secret-value'],
      ),
    );
  expect(session.failures).toHaveLength(20);
  expect(session.failures?.at(-1)).toMatchObject({
    phase: 'transcription',
    stepId: 'audio-24',
    code: 'provider-auth',
    httpStatus: 401,
    retryable: true,
  });
  expect(JSON.stringify(session.failures)).not.toContain(
    'synthetic-secret-value',
  );
  expect(session.error).toContain('[REDACTED]');
});
it('classifies native permissions safely without device IDs or constraint messages', () => {
  const failure = failureDetail(
    new DOMException('private device details', 'NotAllowedError'),
    'setup',
  );
  expect(failure.code).toBe('permission-denied');
  expect(failure.message).not.toContain('private device details');
});
