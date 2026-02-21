import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/api';

interface SupabaseTokenResult {
  accessToken: string;
  refreshToken: string | null;
}

export async function refreshWithSupabase(refreshToken: string): Promise<SupabaseTokenResult> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Configuração do Supabase ausente. Defina EXPO_PUBLIC_SUPABASE_URL e EXPO_PUBLIC_SUPABASE_ANON_KEY.');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: refreshToken
  });

  if (error) {
    throw error;
  }

  const accessToken = data.session?.access_token;
  if (!accessToken) {
    throw new Error('Supabase não retornou access token no refresh.');
  }

  return {
    accessToken,
    refreshToken: data.session?.refresh_token ?? refreshToken
  };
}
