import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyFingerprint } from '../src/capture/timeline';
import {
  providerVerification,
  providerVerificationValid,
  PROVIDER_CHECK_MAX_AGE,
} from '../src/core/provider-readiness';

afterEach(() => vi.unstubAllGlobals());

describe('reusable provider compatibility receipt', () => {
  it('reuses the verified key/model contract across tabs and sessions for strictly less than 24 hours', async () => {
    const fingerprint = await keyFingerprint('synthetic-credential');
    const receipt = providerVerification(fingerprint);
    expect(
      providerVerificationValid(receipt, fingerprint, receipt.checkedAt),
    ).toBe(true);
    expect(
      providerVerificationValid(
        receipt,
        fingerprint,
        receipt.checkedAt + PROVIDER_CHECK_MAX_AGE - 1,
      ),
    ).toBe(true);
    expect(
      providerVerificationValid(
        receipt,
        fingerprint,
        receipt.checkedAt + PROVIDER_CHECK_MAX_AGE,
      ),
    ).toBe(false);
    expect(
      providerVerificationValid(receipt, fingerprint, receipt.checkedAt - 1),
    ).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('synthetic-credential');
  });
  it('rejects changed credentials, models, contracts and malformed persisted records', async () => {
    const fingerprint = await keyFingerprint('synthetic-credential');
    const receipt = providerVerification(fingerprint);
    for (const input of [
      undefined,
      {},
      { ...receipt, transcription: 'changed' },
      { ...receipt, analysis: 'changed' },
      { ...receipt, version: 0 },
      { ...receipt, checkedAt: 'yesterday' },
      { ...receipt, keyFingerprint: 'invalid' },
    ])
      expect(providerVerificationValid(input, fingerprint)).toBe(false);
    expect(
      providerVerificationValid(
        receipt,
        await keyFingerprint('another-synthetic-credential'),
      ),
    ).toBe(false);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

it('does not revoke or replace a newer key verification after an older in-flight request fails', async () => {
  const {
    invalidateProviderVerification,
    saveProviderSettings,
    storeProviderVerification,
    saveMarkerTiming,
  } = await import('../src/core/provider-readiness');
  const oldFingerprint = await keyFingerprint('synthetic-old-key');
  const newFingerprint = await keyFingerprint('synthetic-new-key');
  const state: Record<string, unknown> = {
    settings: { key: 'synthetic-new-key', diagnostics: false },
    providerVerification: providerVerification(newFingerprint),
  };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (name: string) => ({ [name]: state[name] }),
        set: async (values: Record<string, unknown>) =>
          Object.assign(state, values),
        remove: async (name: string) => {
          delete state[name];
        },
      },
    },
  });
  await invalidateProviderVerification(oldFingerprint);
  expect(
    providerVerificationValid(state.providerVerification, newFingerprint),
  ).toBe(true);
  expect(await storeProviderVerification(oldFingerprint)).toBe(false);
  await saveProviderSettings({
    key: 'synthetic-new-key',
    diagnostics: true,
    shiftTapIntervalMs: 220,
  });
  expect(
    providerVerificationValid(state.providerVerification, newFingerprint),
  ).toBe(true);
  await saveMarkerTiming(260);
  expect(state.settings).toMatchObject({
    key: 'synthetic-new-key',
    shiftTapIntervalMs: 260,
  });
  await invalidateProviderVerification(newFingerprint);
  expect(state.providerVerification).toBeUndefined();
  expect(await storeProviderVerification(newFingerprint)).toBe(true);
  await saveProviderSettings({
    key: 'synthetic-other-key',
    diagnostics: false,
    shiftTapIntervalMs: 180,
  });
  expect(state.providerVerification).toBeUndefined();
});
