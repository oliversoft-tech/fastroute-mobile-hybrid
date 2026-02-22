import axios, { AxiosHeaders } from 'axios';
import { API_BASE_URL as configuredBaseUrl } from '../config/api';

const API_BASE_URL = configuredBaseUrl.endsWith('/')
  ? configuredBaseUrl
  : `${configuredBaseUrl}/`;

export const httpClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: {
    Accept: 'application/json'
  }
});

let currentAccessKey: string | null = null;
let currentRefreshKey: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;
let unauthorizedHandler: (() => void | Promise<void>) | null = null;
let sessionRefreshHandler:
  | ((accessToken: string, refreshToken: string | null) => void | Promise<void>)
  | null = null;
let tokenRefreshHandler:
  | ((refreshToken: string) => Promise<{ accessToken: string; refreshToken: string | null } | null>)
  | null = null;

function normalizePath(url: string) {
  return url
    .split('?')[0]
    .trim()
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^\/+/, '');
}

function isAuthRequest(url: string) {
  const path = normalizePath(url);
  return path.endsWith('login');
}

function applyBearerHeader(headers: unknown, accessToken: string) {
  const nextHeaders = AxiosHeaders.from((headers ?? {}) as AxiosHeaders);
  nextHeaders.set('Authorization', `Bearer ${accessToken}`);
  return nextHeaders;
}

async function refreshAccessToken() {
  if (!currentRefreshKey || !tokenRefreshHandler) {
    return null;
  }

  const refreshedTokens = await tokenRefreshHandler(currentRefreshKey);
  if (!refreshedTokens?.accessToken) {
    return null;
  }

  setAuthSessionTokens(refreshedTokens.accessToken, refreshedTokens.refreshToken);

  if (sessionRefreshHandler) {
    await sessionRefreshHandler(refreshedTokens.accessToken, refreshedTokens.refreshToken);
  }

  return refreshedTokens.accessToken;
}

httpClient.interceptors.request.use((config) => {
  const requestUrl = `${config.url ?? ''}`;
  const authRequest = isAuthRequest(requestUrl);

  if (currentAccessKey && !authRequest) {
    config.headers = applyBearerHeader(config.headers, currentAccessKey);
  }

  return config;
});

httpClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (!axios.isAxiosError(error)) {
      return Promise.reject(error);
    }

    const originalConfig = error.config;
    if (!originalConfig) {
      return Promise.reject(error);
    }

    const requestUrl = `${originalConfig.url ?? ''}`;
    const status = error.response?.status;
    const hasRetried = Boolean((originalConfig as { _retry?: boolean })._retry);

    if (status !== 401 || hasRetried || isAuthRequest(requestUrl)) {
      return Promise.reject(error);
    }

    (originalConfig as { _retry?: boolean })._retry = true;

    try {
      if (!refreshInFlight) {
        refreshInFlight = refreshAccessToken().finally(() => {
          refreshInFlight = null;
        });
      }

      const renewedAccessToken = await refreshInFlight;
      if (!renewedAccessToken) {
        throw new Error('Sessão expirada.');
      }

      originalConfig.headers = applyBearerHeader(originalConfig.headers, renewedAccessToken);
      return httpClient(originalConfig);
    } catch (refreshError) {
      setAuthSessionTokens(null, null);
      if (unauthorizedHandler) {
        await unauthorizedHandler();
      }

      return Promise.reject(refreshError);
    }
  }
);

export function setAuthSessionTokens(accessToken: string | null, refreshToken: string | null) {
  currentAccessKey = accessToken;
  currentRefreshKey = refreshToken;

  if (accessToken) {
    httpClient.defaults.headers.common.Authorization = `Bearer ${accessToken}`;
    return;
  }

  delete httpClient.defaults.headers.common.Authorization;
}

export function setOnUnauthorized(handler: (() => void | Promise<void>) | null) {
  unauthorizedHandler = handler;
}

export function setOnSessionRefreshed(
  handler: ((accessToken: string, refreshToken: string | null) => void | Promise<void>) | null
) {
  sessionRefreshHandler = handler;
}

export function setTokenRefreshHandler(
  handler:
    | ((refreshToken: string) => Promise<{ accessToken: string; refreshToken: string | null } | null>)
    | null
) {
  tokenRefreshHandler = handler;
}

export function getApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const responseData = error.response?.data;
    const message = responseData?.message ?? responseData?.msg ?? responseData?.error;
    const hint = responseData?.hint;
    if (typeof message === 'string' && message.length > 0) {
      if (typeof hint === 'string' && hint.length > 0) {
        return `${message}\n${hint}`;
      }
      return message;
    }

    if (typeof responseData === 'string' && responseData.length > 0) {
      return responseData;
    }

    if (error.code === 'ERR_NETWORK') {
      return 'Falha de rede ao chamar a API. Se estiver no navegador, verifique CORS/preflight.';
    }

    if (error.response?.status) {
      return `Erro HTTP ${error.response.status}`;
    }

    if (error.message) {
      return error.message;
    }
  }

  return 'Não foi possível concluir a operação. Tente novamente.';
}
