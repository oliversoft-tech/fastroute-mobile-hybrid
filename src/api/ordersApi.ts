import { ImportResult } from './types';
import { authorizedFetch } from './httpClient';
import { API_BASE_URL } from '../config/api';

interface LocalFile {
  uri: string;
  name: string;
  mimeType?: string;
  webFile?: Blob;
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
      id?: unknown;
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

    const parsedRouteIds = Array.isArray(payload.route_ids)
      ? payload.route_ids.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
      : [];
    const parsedRouteId = Number(payload.route_id ?? payload.routeId ?? payload.id);

    return {
      orders_created: payload.orders_created ?? 0,
      addresses_created: payload.addresses_created ?? 0,
      routes_generated: payload.routes_generated ?? 0,
      route_ids: parsedRouteIds.length > 0 ? parsedRouteIds : undefined,
      route_id: Number.isFinite(parsedRouteId) ? parsedRouteId : undefined
    };
  }

  return {
    orders_created: 0,
    addresses_created: 0,
    routes_generated: 0
  };
}
