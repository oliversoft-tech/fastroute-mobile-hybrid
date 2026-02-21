import { httpClient } from './httpClient';

interface LoginResponse {
  auth_token?: string;
  token?: string;
  access_token?: string;
  access_key?: string;
  refresh_token?: string;
  refreshToken?: string;
  session?: {
    access_token?: string;
    access_key?: string;
    refresh_token?: string;
    refreshToken?: string;
  };
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string | null;
}

function extractTokens(data: LoginResponse): AuthTokens {
  const accessToken =
    data.auth_token ??
    data.token ??
    data.access_token ??
    data.access_key ??
    data.session?.access_token ??
    data.session?.access_key;

  if (!accessToken) {
    throw new Error('Resposta de login inválida: token não encontrado.');
  }

  const refreshToken =
    data.refresh_token ?? data.refreshToken ?? data.session?.refresh_token ?? data.session?.refreshToken ?? null;

  return { accessToken, refreshToken };
}

export async function loginRequest(email: string, password: string) {
  const { data } = await httpClient.post<LoginResponse>('login', {
    email,
    password
  });

  return extractTokens(data);
}
