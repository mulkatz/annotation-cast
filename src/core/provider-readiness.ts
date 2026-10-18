import { z } from 'zod';
import {
  MODELS,
  SettingsSchema,
  ShiftTapIntervalSchema,
  type Settings,
} from './schema';
import { keyFingerprint } from '../capture/timeline';

export const PROVIDER_CHECK_VERSION = 2;
export const PROVIDER_CHECK_MAX_AGE = 24 * 60 * 60 * 1000;
export const ProviderVerificationSchema = z.object({
  checkedAt: z.number().nonnegative(),
  keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  transcription: z.string(),
  analysis: z.string(),
  version: z.number().int(),
});
export function providerVerificationValid(
  input: unknown,
  fingerprint: string,
  now = Date.now(),
): boolean {
  const parsed = ProviderVerificationSchema.safeParse(input);
  return (
    parsed.success &&
    parsed.data.keyFingerprint === fingerprint &&
    parsed.data.version === PROVIDER_CHECK_VERSION &&
    parsed.data.transcription === MODELS.transcription &&
    parsed.data.analysis === MODELS.analysis &&
    parsed.data.checkedAt <= now &&
    now - parsed.data.checkedAt < PROVIDER_CHECK_MAX_AGE
  );
}
export function providerVerification(fingerprint: string) {
  return ProviderVerificationSchema.parse({
    checkedAt: Date.now(),
    keyFingerprint: fingerprint,
    ...MODELS,
    version: PROVIDER_CHECK_VERSION,
  });
}
async function withProviderLock<T>(task: () => Promise<T>): Promise<T> {
  return await navigator.locks.request(
    'annotation-cast-provider-settings',
    {},
    task,
  );
}
export async function saveMarkerTiming(interval: number): Promise<void> {
  const validated = ShiftTapIntervalSchema.parse(interval);
  await withProviderLock(async () => {
    const stored = await chrome.storage.local.get('settings');
    const settings = SettingsSchema.parse(
      stored.settings ?? { key: '', diagnostics: false },
    );
    await chrome.storage.local.set({
      settings: { ...settings, shiftTapIntervalMs: validated },
    });
  });
}
export async function saveProviderSettings(settings: Settings): Promise<void> {
  await withProviderLock(async () => {
    const stored = await chrome.storage.local.get('settings');
    const previous = SettingsSchema.safeParse(stored.settings);
    await chrome.storage.local.set({ settings });
    if (!previous.success || previous.data.key !== settings.key)
      await chrome.storage.local.remove('providerVerification');
  });
}
export async function invalidateProviderVerification(
  fingerprint: string,
): Promise<void> {
  await withProviderLock(async () => {
    const { providerVerification: receipt } = await chrome.storage.local.get(
      'providerVerification',
    );
    const parsed = ProviderVerificationSchema.safeParse(receipt);
    if (
      parsed.success &&
      parsed.data.keyFingerprint === fingerprint &&
      parsed.data.version === PROVIDER_CHECK_VERSION &&
      parsed.data.transcription === MODELS.transcription &&
      parsed.data.analysis === MODELS.analysis
    )
      await chrome.storage.local.remove('providerVerification');
  });
}
export async function storeProviderVerification(
  fingerprint: string,
): Promise<boolean> {
  return withProviderLock(async () => {
    const stored = SettingsSchema.safeParse(
      (await chrome.storage.local.get('settings')).settings,
    );
    if (
      !stored.success ||
      (await keyFingerprint(stored.data.key)) !== fingerprint
    )
      return false;
    await chrome.storage.local.set({
      providerVerification: providerVerification(fingerprint),
    });
    return true;
  });
}
