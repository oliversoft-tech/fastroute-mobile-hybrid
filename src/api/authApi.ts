import { httpClient } from './httpClient';
import { buildFastRouteApiUrl } from '../config/api';

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
  user_id?: string | number;
  userId?: string | number;
  user?: {
    id?: string | number;
    user_id?: string | number;
    userId?: string | number;
  };
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string | null;
  userId: string | null;
}

function pickErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  for (const key of ['msg', 'message', 'error', 'hint']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return fallback;
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

  const userIdRaw = data.user_id ?? data.userId ?? data.user?.user_id ?? data.user?.userId ?? data.user?.id;
  const userId =
    userIdRaw === undefined || userIdRaw === null || String(userIdRaw).trim().length === 0
      ? null
      : String(userIdRaw);

  return { accessToken, refreshToken, userId };
}

export async function loginRequest(email: string, password: string) {
  const endpoint = buildFastRouteApiUrl('/login');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password }),
      signal: controller.signal
    });

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as LoginResponse) : ({} as LoginResponse);

    if (!response.ok) {
      throw new Error(
        pickErrorMessage(payload, `Falha no login (HTTP ${response.status}).`)
      );
    }

    return extractTokens(payload);
  } catch (error) {
    const { data } = await httpClient.post<LoginResponse>(endpoint, { email, password });
    return extractTokens(data);
  } finally {
    clearTimeout(timeoutId);
  }
}
