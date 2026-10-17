import { describe, expect, it } from 'vitest';
import { MessageSchema, SettingsSchema } from '../src/core/schema';

describe('marker timing settings', () => {
  it('migrates existing settings without losing credentials or diagnostics', () => {
    expect(
      SettingsSchema.parse({ key: 'synthetic-key', diagnostics: true }),
    ).toEqual({
      key: 'synthetic-key',
      diagnostics: true,
      shiftTapIntervalMs: 180,
    });
  });
  it.each([100, 180, 350])(
    'accepts a %i ms interval at both boundaries',
    (shiftTapIntervalMs) => {
      expect(
        SettingsSchema.parse({
          key: '',
          diagnostics: false,
          shiftTapIntervalMs,
        }).shiftTapIntervalMs,
      ).toBe(shiftTapIntervalMs);
      expect(
        MessageSchema.parse({
          target: 'content',
          type: 'initialize',
          sessionId: 'synthetic',
          startedAt: 0,
          shiftTapIntervalMs,
        }),
      ).toMatchObject({ shiftTapIntervalMs });
    },
  );
  it.each([99, 351, 180.5, Number.NaN, '180', null])(
    'rejects invalid timing %s at storage and message boundaries',
    (shiftTapIntervalMs) => {
      expect(
        SettingsSchema.safeParse({
          key: '',
          diagnostics: false,
          shiftTapIntervalMs,
        }).success,
      ).toBe(false);
      expect(
        MessageSchema.safeParse({
          target: 'content',
          type: 'initialize',
          sessionId: 'synthetic',
          startedAt: 0,
          shiftTapIntervalMs,
        }).success,
      ).toBe(false);
    },
  );
});
