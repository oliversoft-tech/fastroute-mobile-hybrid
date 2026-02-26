import { ImportResult } from './types';
import { authorizedFetch } from './httpClient';
import { API_BASE_URL } from '../config/api';
import { invalidateRouteQueryCache } from '../state/routesQueryCache';

interface LocalFile {
  uri: string;
  name: string;
  mimeType?: string;
  webFile?: Blob;
  epsMeters?: number;
}

function buildApiUrl(path: string) {
  const base = API_BASE_URL.endsWith('/') ? API_BASE_URL : `${API_BASE_URL}/`;
  return `${base}${path.replace(/^\/+/, '')}`;
}

function parseJsonSafe(raw: string) {
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function extractMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractMessage(item, '');
      if (nested) {
        return nested;
      }
    }
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  for (const key of ['msg', 'message', 'error', 'hint']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  const nestedError = record.error;
  if (nestedError && typeof nestedError === 'object') {
    return extractMessage(nestedError, fallback);
  }

  return fallback;
}

function uniquePositiveIntegers(values: number[]) {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0).map((value) => Math.trunc(value)))];
}

function collectRouteIds(payload: unknown, parentKey = ''): number[] {
  if (payload === null || payload === undefined) {
    return [];
  }

  if (Array.isArray(payload)) {
    return uniquePositiveIntegers(payload.flatMap((entry) => collectRouteIds(entry, parentKey)));
  }

  if (typeof payload !== 'object') {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const normalizedParent = parentKey.trim().toLowerCase();
  const collected: number[] = [];

  const directRouteId = Number(record.route_id ?? record.routeId);
  if (Number.isFinite(directRouteId) && directRouteId > 0) {
    collected.push(directRouteId);
  }

  const routeIdsArray = record.route_ids ?? record.routeIds;
  if (Array.isArray(routeIdsArray)) {
    for (const entry of routeIdsArray) {
      const parsed = Number(entry);
      if (Number.isFinite(parsed) && parsed > 0) {
        collected.push(parsed);
      }
    }
  }

  // O campo "id" só é aceito se o contexto do objeto for explicitamente de rota.
  if (normalizedParent.includes('route')) {
    const contextualId = Number(record.id);
    if (Number.isFinite(contextualId) && contextualId > 0) {
      collected.push(contextualId);
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === 'object') {
      collected.push(...collectRouteIds(value, key));
    }
  }

  return uniquePositiveIntegers(collected);
}

export async function importOrders(file: LocalFile) {
  const formData = new FormData();

  if (file.webFile) {
    formData.append('file', file.webFile, file.name);
  } else {
    formData.append('file', {
      uri: file.uri,
      name: file.name,
      type: file.mimeType ?? 'application/octet-stream'
    } as unknown as Blob);
  }

  const parsedEpsMeters = Number(file.epsMeters);
  if (Number.isFinite(parsedEpsMeters) && parsedEpsMeters > 0) {
    const epsValue = String(Math.trunc(parsedEpsMeters));
    formData.append('eps_meters', epsValue);
    formData.append('eps', epsValue);
  }

  const response = await authorizedFetch(buildApiUrl('route/import'), {
    method: 'POST',
    headers: {
      Accept: 'application/json'
    },
    body: formData
  });
  const rawBody = await response.text();
  const parsedBody = parseJsonSafe(rawBody);

  if (!response.ok) {
    throw new Error(extractMessage(parsedBody, `Erro HTTP ${response.status}`));
  }

  const data = parsedBody as ImportResult | string | null;

  if (typeof data === 'object' && data !== null) {
    const payload = data as ImportResult & {
      routeId?: unknown;
      route_ids?: unknown[];
      ok?: unknown;
      statusCode?: unknown;
      status_code?: unknown;
      error?: unknown;
      msg?: unknown;
      message?: unknown;
    };
    const statusCode = Number(payload.statusCode ?? payload.status_code);
    if (
      payload.ok === false ||
      payload.error !== undefined ||
      (Number.isFinite(statusCode) && statusCode >= 400)
    ) {
      throw new Error(extractMessage(payload, 'Falha ao importar o arquivo.'));
    }

    const parsedRouteIds = collectRouteIds(payload);
    const parsedRouteId = Number(payload.route_id ?? payload.routeId);

    const result = {
      orders_created: payload.orders_created ?? 0,
      addresses_created: payload.addresses_created ?? 0,
      routes_generated: payload.routes_generated ?? 0,
      route_ids: parsedRouteIds.length > 0 ? parsedRouteIds : undefined,
      route_id: Number.isFinite(parsedRouteId) ? parsedRouteId : undefined
    };
    invalidateRouteQueryCache();
    return result;
  }

  const fallbackResult = {
    orders_created: 0,
    addresses_created: 0,
    routes_generated: 0
  };
  invalidateRouteQueryCache();
  return fallbackResult;
}
