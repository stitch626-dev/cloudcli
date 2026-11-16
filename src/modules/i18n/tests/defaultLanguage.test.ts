import { expect, test, vi } from 'vitest';

const preference = vi.hoisted(() => ({ language: null as string | null }));
vi.mock('@/shared/userSettings', () => ({
  readUserPreference: (_key: string, fallback: unknown) => preference.language ?? fallback,
  writeUserPreference: vi.fn(),
  subscribeToUserPreferences: vi.fn(),
}));

test.each([
  { saved: null, expected: 'zh-CN' },
  { saved: 'unsupported', expected: 'zh-CN' },
  { saved: 'en', expected: 'en' },
])('language $saved resolves to $expected', async ({ saved, expected }) => {
  preference.language = saved;
  vi.resetModules();
  const { default: i18n } = await import('@/modules/i18n/config');
  expect(i18n.language).toBe(expected);
});
