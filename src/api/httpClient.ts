type AxiosStatic = typeof import('axios')['default'];
const axiosRuntime = require('axios/dist/browser/axios.cjs');
const axios = (axiosRuntime.default ?? axiosRuntime) as AxiosStatic;
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
  const baseHeaders =
    headers && typeof headers === 'object' ? (headers as Record<string, unknown>) : {};

  return {
    ...baseHeaders,
    Authorization: `Bearer ${accessToken}`
  };
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

async function getRefreshedAccessToken() {
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken().finally(() => {
      refreshInFlight = null;
    });
  }

  return refreshInFlight;
}

async function invalidateSessionAndLogout() {
  setAuthSessionTokens(null, null);
  if (unauthorizedHandler) {
    await unauthorizedHandler();
  }
}

httpClient.interceptors.request.use((config) => {
  const requestUrl = `${config.url ?? ''}`;
  const authRequest = isAuthRequest(requestUrl);

  if (currentAccessKey && !authRequest) {
    config.headers = applyBearerHeader(config.headers, currentAccessKey) as any;
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
      const renewedAccessToken = await getRefreshedAccessToken();
      if (!renewedAccessToken) {
        throw new Error('Sessão expirada.');
      }

      originalConfig.headers = applyBearerHeader(originalConfig.headers, renewedAccessToken) as any;
      return httpClient(originalConfig);
    } catch (refreshError) {
      await invalidateSessionAndLogout();
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

export function getAuthAccessToken() {
  return currentAccessKey;
}

export async function refreshAccessTokenIfPossible() {
  if (!currentRefreshKey || !tokenRefreshHandler) {
    return currentAccessKey;
  }

  const renewedAccessToken = await getRefreshedAccessToken();
  if (!renewedAccessToken) {
    throw new Error('Sessão expirada.');
  }

  return renewedAccessToken;
}

export async function authorizedFetch(url: string, init?: RequestInit) {
  const normalizedInit = init ?? {};
  const headers = new Headers((normalizedInit.headers as HeadersInit | undefined) ?? {});
  if (currentAccessKey && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${currentAccessKey}`);
  }

  let response = await fetch(url, {
    ...normalizedInit,
    headers
  });

  if (response.status !== 401 || isAuthRequest(url)) {
    return response;
  }

  try {
    const renewedAccessToken = await getRefreshedAccessToken();
    if (!renewedAccessToken) {
      await invalidateSessionAndLogout();
      return response;
    }

    const retryHeaders = new Headers((normalizedInit.headers as HeadersInit | undefined) ?? {});
    retryHeaders.set('Authorization', `Bearer ${renewedAccessToken}`);
    response = await fetch(url, {
      ...normalizedInit,
      headers: retryHeaders
    });

    if (response.status === 401) {
      await invalidateSessionAndLogout();
    }

    return response;
  } catch {
    await invalidateSessionAndLogout();
    return response;
  }
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

function parseJsonString(text: string) {
  const trimmed = text.trim();
  if (
    !(trimmed.startsWith('{') && trimmed.endsWith('}')) &&
    !(trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function extractMessage(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const parsed = parseJsonString(trimmed);
    if (parsed) {
      const nested = extractMessage(parsed, depth + 1);
      if (nested) {
        return nested;
      }
    }

    const quotedJsonMatch = trimmed.match(/"(\{.*\}|\[.*\])"/);
    if (quotedJsonMatch?.[1]) {
      const unescaped = quotedJsonMatch[1].replace(/\\"/g, '"');
      const nested = extractMessage(parseJsonString(unescaped), depth + 1);
      if (nested) {
        return nested;
      }
    }

    return trimmed;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractMessage(item, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const priorityKeys = [
      'msg',
      'message',
      'error',
      'hint',
      'details',
      'reason',
      'body',
      'data'
    ];

    for (const key of priorityKeys) {
      if (!(key in record)) {
        continue;
      }
      const nested = extractMessage(record[key], depth + 1);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

export function getApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const responseData = error.response?.data;
    const responseMessage = extractMessage(responseData);
    if (responseMessage) {
      return responseMessage;
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
      const parsedMessage = extractMessage(error.message);
      if (parsedMessage) {
        return parsedMessage;
      }
      return error.message;
    }
  }

  if (error && typeof error === 'object') {
    const extracted = extractMessage(error);
    if (extracted) {
      return extracted;
    }
  }

  return 'Não foi possível concluir a operação. Tente novamente.';
}
