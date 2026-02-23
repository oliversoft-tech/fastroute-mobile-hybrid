import { Route, RouteDetail, Waypoint, WaypointStatus } from './types';
import { getAuthAccessToken, httpClient } from './httpClient';
import {
  enrichWaypointsWithAddressData,
  listRouteWaypointsFromSupabase,
  updateRouteWaypointStatusInSupabase
} from './supabaseDataApi';
import { API_BASE_URL } from '../config/api';

interface ApiObject {
  [key: string]: unknown;
}

function buildApiUrl(path: string) {
  const base = API_BASE_URL.endsWith('/') ? API_BASE_URL : `${API_BASE_URL}/`;
  const normalizedPath = path.replace(/^\/+/, '');
  return `${base}${normalizedPath}`;
}

function parseApiResponseBody(raw: string) {
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickApiErrorMessage(payload: Record<string, unknown> | null, fallback: string) {
  if (!payload) {
    return fallback;
  }

  const directCandidates = ['message', 'msg', 'error', 'hint'];
  for (const key of directCandidates) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  const nestedError = payload.error;
  if (nestedError && typeof nestedError === 'object') {
    const nested = nestedError as Record<string, unknown>;
    for (const key of ['message', 'msg', 'error']) {
      const value = nested[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  return fallback;
}

function pickString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      if (/^\d+$/.test(trimmed)) {
        continue;
      }
      return trimmed;
    }
  }

  return undefined;
}

function tryParseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }

  if (
    !(trimmed.startsWith('{') && trimmed.endsWith('}')) &&
    !(trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function mapRouteStatus(value: unknown): Route['status'] {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();

  if (normalized.includes('EM_ROTA') || normalized.includes('EM ANDAMENTO') || normalized.includes('ANDAMENTO')) {
    return 'EM_ROTA';
  }

  if (normalized.includes('FINAL') || normalized.includes('ENTREGUE') || normalized.includes('CONCLUID')) {
    return 'FINALIZADA';
  }

  return 'PENDENTE';
}

function mapWaypointStatus(value: unknown): WaypointStatus {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();

  if (normalized.includes('FALHA TEMPO ADVERSO')) {
    return 'FALHA TEMPO ADVERSO';
  }

  if (normalized.includes('FALHA MORADOR AUSENTE')) {
    return 'FALHA MORADOR AUSENTE';
  }

  if (normalized.includes('EM_ROTA') || normalized.includes('EM ANDAMENTO') || normalized.includes('ANDAMENTO')) {
    return 'EM_ROTA';
  }

  if (normalized.includes('ENTREGUE') || normalized.includes('CONCLUID')) {
    return 'CONCLUIDO';
  }

  return 'PENDENTE';
}

function toInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasRouteShape(data: ApiObject) {
  return Boolean(
    data.id ??
      data.route_id ??
      data.routeId ??
      data.cluster_id ??
      data.clusterId ??
      data.waypoints ??
      data.paradas ??
      data.stops
  );
}

function extractCollection(data: unknown) {
  const resolved = tryParseJson(data);

  if (Array.isArray(resolved)) {
    const flattened: ApiObject[] = [];

    for (const entry of resolved) {
      const parsedEntry = tryParseJson(entry);
      if (!parsedEntry || typeof parsedEntry !== 'object') {
        continue;
      }

      const objectEntry = parsedEntry as ApiObject;
      const nestedRoutes = tryParseJson(objectEntry.routes);
      if (Array.isArray(nestedRoutes)) {
        for (const nestedRoute of nestedRoutes) {
          const parsedRoute = tryParseJson(nestedRoute);
          if (parsedRoute && typeof parsedRoute === 'object') {
            flattened.push(parsedRoute as ApiObject);
          }
        }
        continue;
      }

      flattened.push(objectEntry);
    }

    return flattened;
  }

  if (!resolved || typeof resolved !== 'object') {
    return [] as ApiObject[];
  }

  const payload = resolved as ApiObject;
  const nestedCandidates = [
    payload.data,
    payload.routes,
    payload.route,
    payload.items,
    payload.result,
    payload.output,
    payload.body
  ];

  for (const candidate of nestedCandidates) {
    const nested = tryParseJson(candidate);

    if (Array.isArray(nested)) {
      return nested
        .map((entry) => tryParseJson(entry))
        .filter((entry): entry is ApiObject => Boolean(entry && typeof entry === 'object'));
    }

    if (nested && typeof nested === 'object' && hasRouteShape(nested as ApiObject)) {
      return [nested as ApiObject];
    }
  }

  if (hasRouteShape(payload)) {
    return [payload];
  }

  return [];
}

function normalizeWaypoint(raw: ApiObject, routeIdFallback: number, index: number): Waypoint {
  const resolved = tryParseJson(raw) as ApiObject;
  const address = (resolved.address as ApiObject | undefined) ?? {};
  const addressId = toInteger(
    resolved.address_id ?? resolved.addressId ?? address.id ?? resolved.id,
    index + 1
  );
  const waypointId = toInteger(
    resolved.id ?? resolved.waypoint_id ?? resolved.waypointId ?? resolved.stop_id ?? addressId,
    addressId
  );
  const explicitTitle = pickString(
    resolved.detailed_address,
    resolved.detailedAddress,
    resolved.full_address,
    resolved.fullAddress,
    resolved.formatted_address,
    resolved.formattedAddress,
    resolved.title,
    resolved.name,
    resolved.address_text,
    resolved.addressLine,
    resolved.address_line,
    address.detailed_address,
    address.detailedAddress,
    address.full_address,
    address.fullAddress,
    address.formatted_address,
    address.formattedAddress,
    address.title,
    address.name,
    address.address_text
  );
  const street = pickString(
    resolved.street,
    resolved.logradouro,
    resolved.rua,
    resolved.address,
    address.street,
    address.logradouro,
    address.rua,
    address.address
  );
  const number = pickString(resolved.number, resolved.numero, address.number, address.numero);
  const district = pickString(
    resolved.district,
    resolved.neighborhood,
    resolved.bairro,
    address.district,
    address.neighborhood,
    address.bairro
  );
  const city = pickString(resolved.city, resolved.cidade, address.city, address.cidade);
  const state = pickString(resolved.state, resolved.uf, address.state, address.uf);
  const zip = pickString(resolved.zipcode, resolved.zip_code, resolved.cep, address.zipcode, address.cep);
  const complement = pickString(resolved.complement, resolved.complemento, address.complement, address.complemento);
  const streetLine = [street, number].filter(Boolean).join(', ').trim();
  const regionParts = [district, city, state].filter(Boolean).join(' - ').trim();
  const detailedTitle = explicitTitle || streetLine || regionParts || 'Endereço não informado';
  const detailedSubtitle = [zip, regionParts, complement].filter(Boolean).join(' • ');

  return {
    id: waypointId,
    route_id: toInteger(resolved.route_id ?? resolved.routeId, routeIdFallback),
    address_id: addressId,
    user_id: toNumber(resolved.user_id ?? resolved.userId ?? address.user_id ?? address.userId),
    seq_order: toInteger(resolved.seq_order ?? resolved.seqOrder ?? resolved.order, index + 1),
    status: mapWaypointStatus(resolved.status ?? resolved.delivery_status),
    title: detailedTitle,
    subtitle: pickString(resolved.subtitle, resolved.description, address.subtitle) ?? detailedSubtitle,
    latitude: toNumber(
      resolved.latitude ?? resolved.lat ?? resolved.geo_lat ?? resolved.latlng_lat ?? address.latitude
    ),
    longitude: toNumber(
      resolved.longitude ??
      resolved.long ??
      resolved.lng ??
      resolved.lon ??
      resolved.geo_lng ??
      address.long ??
      address.longitude
    )
  };
}

function normalizeRoute(raw: ApiObject, index: number): RouteDetail {
  const resolved = tryParseJson(raw) as ApiObject;
  const routeId = toInteger(resolved.id ?? resolved.route_id ?? resolved.routeId, index + 1);
  const possibleWaypoints =
    (tryParseJson(resolved.waypoints) as unknown) ??
    (tryParseJson(resolved.paradas) as unknown) ??
    (tryParseJson(resolved.stops) as unknown) ??
    [];

  const waypoints = Array.isArray(possibleWaypoints)
    ? (possibleWaypoints as ApiObject[]).map((entry, waypointIndex) =>
        normalizeWaypoint(entry, routeId, waypointIndex)
      )
    : [];

  return {
    id: routeId,
    cluster_id: toInteger(resolved.cluster_id ?? resolved.clusterId, 0),
    status: mapRouteStatus(resolved.status),
    created_at: String(resolved.created_at ?? resolved.createdAt ?? new Date().toISOString()),
    waypoints
  };
}

async function fetchRoutes(routeId?: number) {
  const endpoints = ['route', 'routes'];
  const paramsOptions = routeId
    ? [{ route_id: routeId }, { 'route-id': routeId }, { routeId }, { id: routeId }, undefined]
    : [undefined];

  let firstError: unknown = null;
  let bestList: RouteDetail[] = [];
  let hadSuccessfulResponse = false;

  for (const endpoint of endpoints) {
    for (const params of paramsOptions) {
      try {
        const { data } = await httpClient.get<unknown>(endpoint, { params });
        hadSuccessfulResponse = true;
        const normalized = extractCollection(data).map(normalizeRoute);

        if (routeId) {
          const exactMatch = normalized.filter((entry) => entry.id === routeId);
          if (exactMatch.length > 0) {
            return exactMatch;
          }

          if (normalized.length > bestList.length) {
            bestList = normalized;
          }
          continue;
        }

        if (!routeId && normalized.length > bestList.length) {
          bestList = normalized;
        }
      } catch (error) {
        if (!firstError) {
          firstError = error;
        }
      }
    }
  }

  if (routeId) {
    if (firstError && !hadSuccessfulResponse) {
      throw firstError;
    }
    return bestList.filter((entry) => entry.id === routeId);
  }

  if (bestList.length > 0) {
    return bestList;
  }

  if (firstError && !hadSuccessfulResponse) {
    throw firstError;
  }

  return [];
}

export async function listRoutes() {
  return fetchRoutes();
}

export async function getRouteDetails(routeId: number) {
  const [route] = await fetchRoutes(routeId);
  try {
    const waypointsFromSupabase = await listRouteWaypointsFromSupabase(routeId);
    if (route) {
      return {
        ...route,
        waypoints: waypointsFromSupabase
      };
    }

    return {
      id: routeId,
      cluster_id: 0,
      status: 'PENDENTE' as const,
      created_at: new Date().toISOString(),
      waypoints: waypointsFromSupabase
    };
  } catch {
    // Mantem fallback via webhook quando consulta relacional no Supabase falhar.
  }

  if (!route) {
    return {
      id: routeId,
      cluster_id: 0,
      status: 'PENDENTE' as const,
      created_at: new Date().toISOString(),
      waypoints: []
    };
  }

  let enrichedWaypoints = route.waypoints ?? [];
  try {
    enrichedWaypoints = await enrichWaypointsWithAddressData(route.waypoints ?? []);
  } catch {
    // Se consulta relacional de endereço falhar, mantém os waypoints vindos do webhook.
  }

  return {
    ...route,
    waypoints: enrichedWaypoints
  };
}

export async function listRouteWaypoints(routeId: number) {
  try {
    const fromSupabase = await listRouteWaypointsFromSupabase(routeId);
    if (fromSupabase.length > 0) {
      return fromSupabase;
    }
  } catch {
    // fallback para payload do webhook
  }

  const route = await getRouteDetails(routeId);
  try {
    return await enrichWaypointsWithAddressData(route.waypoints ?? []);
  } catch {
    return route.waypoints ?? [];
  }
}

export async function startRoute(routeId: number) {
  await httpClient.patch('route/start', null, {
    params: { route_id: routeId }
  });
}

export async function finishRoute(routeId: number) {
  await httpClient.patch('route/finish', null, {
    params: { route_id: routeId }
  });
}

export type WaypointFinishStatus =
  | WaypointStatus
  | 'ENTREGUE'
  | 'FALHA TEMPO ADVERSO'
  | 'FALHA MORADOR AUSENTE';

function mapWaypointFinishStatus(status: WaypointFinishStatus) {
  if (status === 'CONCLUIDO' || status === 'ENTREGUE') {
    return 'ENTREGUE';
  }

  if (status === 'EM_ROTA') {
    return 'EM_ROTA';
  }

  if (status === 'PENDENTE') {
    return 'PENDENTE';
  }

  if (status === 'FALHA TEMPO ADVERSO' || status === 'FALHA MORADOR AUSENTE') {
    return status;
  }

  return 'PENDENTE';
}

function mapWaypointStatusToSupabase(status: ReturnType<typeof mapWaypointFinishStatus>) {
  if (status === 'ENTREGUE') {
    return 'ENTREGUE' as const;
  }

  if (status === 'FALHA TEMPO ADVERSO' || status === 'FALHA MORADOR AUSENTE') {
    return status;
  }

  if (status === 'PENDENTE') {
    return 'PENDENTE' as const;
  }

  return null;
}

export async function updateWaypointStatus(
  routeId: number,
  waypointId: number,
  status: WaypointFinishStatus,
  options?: {
    obs_falha?: string;
    file_name?: string;
    user_id?: string | number;
    address_id?: number;
    image_uri?: string;
  }
) {
  const mappedStatus = mapWaypointFinishStatus(status);
  const formData = new FormData();
  const normalizedFileName = options?.file_name?.trim() || `entrega_${waypointId}.jpg`;

  formData.append('waypoint_id', String(waypointId));
  formData.append('status', String(mappedStatus));
  formData.append('file_name', options?.image_uri ? normalizedFileName : options?.file_name ?? '');
  formData.append('obs_falha', options?.obs_falha ?? '');
  formData.append('user_id', String(options?.user_id ?? ''));
  formData.append('route_id', String(routeId));

  if (options?.image_uri) {
    formData.append('image_base64', {
      uri: options.image_uri,
      name: normalizedFileName,
      type: 'image/jpeg'
    } as any);
  }

  const obsFalha = options?.obs_falha ?? '';

  const authToken = getAuthAccessToken();
  const headers: Record<string, string> = {
    Accept: 'application/json'
  };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const response = await fetch(buildApiUrl('waypoint/finish'), {
    method: 'PATCH',
    headers,
    body: formData
  });
  const rawBody = await response.text();
  const parsedBody = parseApiResponseBody(rawBody);

  if (!response.ok) {
    throw new Error(pickApiErrorMessage(parsedBody, `Erro HTTP ${response.status}`));
  }

  const supabaseStatus = mapWaypointStatusToSupabase(mappedStatus);
  if (!supabaseStatus) {
    return;
  }

  await updateRouteWaypointStatusInSupabase({
    waypointId,
    addressId: options?.address_id,
    status: supabaseStatus,
    obsFalha: obsFalha.trim()
  });
}

export async function updateWaypointOrder(params: {
  routeId: number;
  reorderedWaypoints: Array<{
    seqorder: number;
    waypoint_id: number;
  }>;
}) {
  const routeId = Math.trunc(Number(params.routeId));
  const reorderedWaypoints = params.reorderedWaypoints
    .map((item) => ({
      seqorder: Math.trunc(Number(item.seqorder)),
      waypoint_id: Math.trunc(Number(item.waypoint_id))
    }))
    .filter(
      (item) =>
        Number.isFinite(item.seqorder) &&
        item.seqorder > 0 &&
        Number.isFinite(item.waypoint_id) &&
        item.waypoint_id > 0
    );

  await httpClient.patch('waypoint/reorder', {
    route_id: routeId,
    reordered_waypoints: reorderedWaypoints
  });
}
