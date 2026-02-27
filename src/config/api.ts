const runtimeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process;

export const API_BASE_URL =
  runtimeProcess?.env?.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:5678/webhook';

export const SUPABASE_URL =
  runtimeProcess?.env?.EXPO_PUBLIC_SUPABASE_URL ?? 'https://mbtwevtytgnlztaccygy.supabase.co';

export const SUPABASE_ANON_KEY =
  runtimeProcess?.env?.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  'sb_publishable_HcW8RYOkw5qXWHoWlESGhw_HI_Kcf-D';
