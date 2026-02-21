import { ImportResult } from './types';
import { httpClient } from './httpClient';

interface LocalFile {
  uri: string;
  name: string;
  mimeType?: string;
  webFile?: Blob;
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

  const { data } = await httpClient.post<ImportResult | string | null>('route/import', formData);

  if (typeof data === 'object' && data !== null) {
    const payload = data as ImportResult & {
      routeId?: unknown;
      id?: unknown;
      route_ids?: unknown[];
    };
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
