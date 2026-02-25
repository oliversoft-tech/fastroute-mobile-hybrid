import { Route, RouteDetail, Waypoint, WaypointStatus } from './types';
import { authorizedFetch, httpClient, refreshAccessTokenIfPossible } from './httpClient';
import {
  getRouteMetadataFromSupabase,
  enrichWaypointsWithAddressData,
  listRouteWaypointCountsFromSupabase,
  listRoutesMetadataFromSupabase,
  listRouteWaypointsFromSupabase,
  updateRouteWaypointStatusInSupabase
} from './supabaseDataApi';
import { API_BASE_URL } from '../config/api';
import {
  getCachedRouteDetail,
  getCachedRouteWaypoints,
  getCachedRoutesList,
  invalidateRouteQueryCache,
  setCachedRouteDetail,
  setCachedRouteWaypoints,
  setCachedRoutesList,
  withInFlightRequest
} from '../state/routesQueryCache';

interface ApiObject {
  [key: string]: unknown;
}

interface QueryCacheOptions {
  forceRefresh?: boolean;
  ttlMs?: number;
}

function normalizeStatusValue(value: unknown) {
  return String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function buildApiUrl(path: string) {
  const base = API_BASE_URL.endsWith('/') ? API_BASE_URL : `${API_BASE_URL}/`;
  const normalizedPath = path.replace(/^\/+/, '');
  return `${base}${normalizedPath}`;
}

function parseApiResponseBody(raw: string): unknown {
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function pickApiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload) {
    return fallback;
  }

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const message: string = pickApiErrorMessage(entry, '');
      if (message) {
        return message;
      }
    }
    return fallback;
  }

  if (typeof payload !== 'object') {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  const directCandidates = ['message', 'msg', 'error', 'hint'];
  for (const key of directCandidates) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  const nestedError = record.error;
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

function assertWebhookSuccess(payload: unknown, fallbackMessage: string) {
  const item =
    Array.isArray(payload) && payload.length > 0 ? payload[0] : payload;
  if (!item || typeof item !== 'object') {
    return;
  }

  const record = item as Record<string, unknown>;
  const okValue = record.ok;
  const statusCodeRaw = record.statusCode ?? record.status_code;
  const statusCode = Number(statusCodeRaw);
  const hasHttpLikeError = Number.isFinite(statusCode) && statusCode >= 400;
  const hasErrorField = record.error !== undefined && record.error !== null;

  if (okValue === false || hasHttpLikeError || hasErrorField) {
    throw new Error(pickApiErrorMessage(record, fallbackMessage));
  }
}

function isAuthMessage(value: unknown) {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('token') ||
    normalized.includes('jwt') ||
    normalized.includes('expir') ||
    normalized.includes('unauthor') ||
    normalized.includes('não autorizado') ||
    normalized.includes('nao autorizado') ||
    normalized.includes('forbidden')
  );
}

function isAuthPayloadFailure(payload: unknown): boolean {
  if (payload === null || payload === undefined) {
    return false;
  }

  if (Array.isArray(payload)) {
    return payload.some((entry) => isAuthPayloadFailure(entry));
  }

  if (typeof payload !== 'object') {
    return isAuthMessage(payload);
  }

  const record = payload as Record<string, unknown>;
  const statusCode = Number(record.statusCode ?? record.status_code ?? record.code);
  if (Number.isFinite(statusCode) && (statusCode === 401 || statusCode === 403)) {
    return true;
  }

  if (
    isAuthMessage(record.msg) ||
    isAuthMessage(record.message) ||
    isAuthMessage(record.error) ||
    isAuthMessage(record.hint)
  ) {
    return true;
  }

  return (
    isAuthPayloadFailure(record.error) ||
    isAuthPayloadFailure(record.data) ||
    isAuthPayloadFailure(record.body)
  );
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
  const normalized = normalizeStatusValue(value);

  if (normalized.includes('CRIADA')) {
    return 'CRIADA';
  }

  if (normalized.includes('EM_ROTA') || normalized.includes('EM ANDAMENTO') || normalized.includes('EM_ANDAMENTO') || normalized.includes('ANDAMENTO')) {
    return 'EM_ANDAMENTO';
  }

  if (normalized.includes('FINAL') || normalized.includes('ENTREGUE') || normalized.includes('CONCLUID')) {
    return 'FINALIZADA';
  }

  return 'PENDENTE';
}

function mapWaypointStatus(value: unknown): WaypointStatus {
  const normalized = normalizeStatusValue(value);

  if (normalized.includes('REORDEN')) {
    return 'REORDENADO';
  }

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
    waypoints_count: waypoints.length,
    waypoints
  };
}

function sortRoutesByCreatedAtAndId(routes: RouteDetail[]) {
  return [...routes].sort((a, b) => {
    const dateA = Date.parse(a.created_at);
    const dateB = Date.parse(b.created_at);
    if (Number.isFinite(dateA) && Number.isFinite(dateB) && dateA !== dateB) {
      return dateB - dateA;
    }
    return b.id - a.id;
  });
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

export async function listRoutes(options?: QueryCacheOptions) {
  const forceRefresh = Boolean(options?.forceRefresh);
  if (!forceRefresh) {
    const cached = getCachedRoutesList();
    if (cached) {
      return cached;
    }
  }

  const requestKey = forceRefresh ? 'routes:list:force' : 'routes:list';
  return withInFlightRequest(requestKey, async () => {
    if (!forceRefresh) {
      const cached = getCachedRoutesList();
      if (cached) {
        return cached;
      }
    }

    const webhookRoutes = await fetchRoutes();
    let resolvedRoutes: RouteDetail[];

    try {
      const metadataRows = await listRoutesMetadataFromSupabase();
      if (metadataRows.length === 0) {
        resolvedRoutes = sortRoutesByCreatedAtAndId(
          webhookRoutes.map((route) => ({
            ...route,
            waypoints_count: route.waypoints_count ?? route.waypoints?.length ?? 0
          }))
        );
      } else {
        const routeIds = metadataRows.map((row) => Number(row.id));
        const waypointCounts = await listRouteWaypointCountsFromSupabase(routeIds);
        const byId = new Map<number, RouteDetail>(
          webhookRoutes.map((route) => [
            route.id,
            {
              ...route,
              waypoints_count: route.waypoints_count ?? route.waypoints?.length ?? 0
            }
          ])
        );

        for (const metadata of metadataRows) {
          const routeId = Number(metadata.id);
          if (!Number.isFinite(routeId) || routeId <= 0) {
            continue;
          }

          const existing = byId.get(routeId);
          const mergedStatus = metadata.status
            ? mapRouteStatus(metadata.status)
            : (existing?.status ?? ('PENDENTE' as const));
          const mergedCreatedAt = metadata.created_at ?? existing?.created_at ?? new Date().toISOString();
          const mergedClusterId = Number.isFinite(Number(metadata.cluster_id))
            ? Number(metadata.cluster_id)
            : (existing?.cluster_id ?? 0);
          const mergedCount = waypointCounts.get(routeId) ?? existing?.waypoints_count ?? existing?.waypoints?.length ?? 0;

          byId.set(routeId, {
            id: routeId,
            cluster_id: mergedClusterId,
            status: mergedStatus,
            created_at: mergedCreatedAt,
            waypoints_count: mergedCount,
            waypoints: existing?.waypoints
          });
        }

        resolvedRoutes = sortRoutesByCreatedAtAndId([...byId.values()]);
      }
    } catch {
      resolvedRoutes = sortRoutesByCreatedAtAndId(
        webhookRoutes.map((route) => ({
          ...route,
          waypoints_count: route.waypoints_count ?? route.waypoints?.length ?? 0
        }))
      );
    }

    setCachedRoutesList(resolvedRoutes, options?.ttlMs);
    return resolvedRoutes;
  });
}

export async function getRouteDetails(routeId: number, options?: QueryCacheOptions) {
  const forceRefresh = Boolean(options?.forceRefresh);
  if (!forceRefresh) {
    const cached = getCachedRouteDetail(routeId);
    if (cached) {
      return cached;
    }
  }

  const requestKey = forceRefresh ? `routes:detail:${routeId}:force` : `routes:detail:${routeId}`;
  return withInFlightRequest(requestKey, async () => {
    if (!forceRefresh) {
      const cached = getCachedRouteDetail(routeId);
      if (cached) {
        return cached;
      }
    }

    const [route] = await fetchRoutes(routeId);
    let routeMetadata: Awaited<ReturnType<typeof getRouteMetadataFromSupabase>> | null = null;
    try {
      routeMetadata = await getRouteMetadataFromSupabase(routeId);
    } catch {
      // Mantém fallback via payload do webhook quando metadata da rota não estiver disponível.
    }

    let resolvedDetail: RouteDetail;
    try {
      const waypointsFromSupabase = await listRouteWaypointsFromSupabase(routeId);
      const statusFromMetadata = routeMetadata?.status ? mapRouteStatus(routeMetadata.status) : undefined;
      const createdAtFromMetadata = routeMetadata?.created_at ?? undefined;
      const clusterIdFromMetadata = routeMetadata?.cluster_id ?? undefined;
      if (route) {
        resolvedDetail = {
          ...route,
          status: statusFromMetadata ?? route.status,
          created_at: createdAtFromMetadata ?? route.created_at,
          cluster_id: Number.isFinite(Number(clusterIdFromMetadata)) ? Number(clusterIdFromMetadata) : route.cluster_id,
          waypoints_count: waypointsFromSupabase.length,
          waypoints: waypointsFromSupabase
        };
      } else {
        resolvedDetail = {
          id: routeId,
          cluster_id: Number.isFinite(Number(clusterIdFromMetadata)) ? Number(clusterIdFromMetadata) : 0,
          status: statusFromMetadata ?? ('PENDENTE' as const),
          created_at: createdAtFromMetadata ?? new Date().toISOString(),
          waypoints_count: waypointsFromSupabase.length,
          waypoints: waypointsFromSupabase
        };
      }
    } catch {
      // Mantem fallback via webhook quando consulta relacional no Supabase falhar.
      if (!route) {
        const statusFromMetadata = routeMetadata?.status ? mapRouteStatus(routeMetadata.status) : undefined;
        const createdAtFromMetadata = routeMetadata?.created_at ?? undefined;
        const clusterIdFromMetadata = routeMetadata?.cluster_id ?? undefined;
        resolvedDetail = {
          id: routeId,
          cluster_id: Number.isFinite(Number(clusterIdFromMetadata)) ? Number(clusterIdFromMetadata) : 0,
          status: statusFromMetadata ?? ('PENDENTE' as const),
          created_at: createdAtFromMetadata ?? new Date().toISOString(),
          waypoints_count: 0,
          waypoints: []
        };
      } else {
        let enrichedWaypoints = route.waypoints ?? [];
        try {
          enrichedWaypoints = await enrichWaypointsWithAddressData(route.waypoints ?? []);
        } catch {
          // Se consulta relacional de endereço falhar, mantém os waypoints vindos do webhook.
        }

        resolvedDetail = {
          ...route,
          status: routeMetadata?.status ? mapRouteStatus(routeMetadata.status) : route.status,
          created_at: routeMetadata?.created_at ?? route.created_at,
          cluster_id: Number.isFinite(Number(routeMetadata?.cluster_id)) ? Number(routeMetadata?.cluster_id) : route.cluster_id,
          waypoints_count: enrichedWaypoints.length,
          waypoints: enrichedWaypoints
        };
      }
    }

    setCachedRouteDetail(routeId, resolvedDetail, options?.ttlMs);
    return resolvedDetail;
  });
}

export async function listRouteWaypoints(routeId: number, options?: QueryCacheOptions) {
  const forceRefresh = Boolean(options?.forceRefresh);
  if (!forceRefresh) {
    const cached = getCachedRouteWaypoints(routeId);
    if (cached) {
      return cached;
    }
  }

  const requestKey = forceRefresh ? `routes:waypoints:${routeId}:force` : `routes:waypoints:${routeId}`;
  return withInFlightRequest(requestKey, async () => {
    if (!forceRefresh) {
      const cached = getCachedRouteWaypoints(routeId);
      if (cached) {
        return cached;
      }
    }

    try {
      const fromSupabase = await listRouteWaypointsFromSupabase(routeId);
      if (fromSupabase.length > 0) {
        setCachedRouteWaypoints(routeId, fromSupabase, options?.ttlMs);
        return fromSupabase;
      }
    } catch {
      // fallback para payload do webhook
    }

    const route = await getRouteDetails(routeId, options);
    const fallbackWaypoints = (route.waypoints ?? []).filter((waypoint) => {
      const normalizedRouteId = Number(waypoint.route_id);
      return !Number.isFinite(normalizedRouteId) || normalizedRouteId === routeId;
    });
    let resolved = fallbackWaypoints;
    try {
      resolved = await enrichWaypointsWithAddressData(fallbackWaypoints);
    } catch {
      // Mantém fallback simples quando enriquecimento falha.
    }

    setCachedRouteWaypoints(routeId, resolved, options?.ttlMs);
    return resolved;
  });
}

export async function startRoute(routeId: number) {
  await refreshAccessTokenIfPossible();
  const { data } = await httpClient.patch('route/start', {
    route_id: routeId
  });
  assertWebhookSuccess(data, 'Não foi possível iniciar a rota.');
  invalidateRouteQueryCache(routeId);
}

export async function finishRoute(routeId: number) {
  let { data } = await httpClient.patch('route/finish', {
    route_id: routeId
  });
  if (isAuthPayloadFailure(data)) {
    await refreshAccessTokenIfPossible();
    const retry = await httpClient.patch('route/finish', {
      route_id: routeId
    });
    data = retry.data;
  }
  assertWebhookSuccess(data, 'Não foi possível finalizar a rota.');
  invalidateRouteQueryCache(routeId);
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

  if (status === 'REORDENADO') {
    return 'PENDENTE';
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
  const normalizedFileName = options?.file_name?.trim() || `entrega_${waypointId}.jpg`;
  const buildFormData = () => {
    const formData = new FormData();
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

    return formData;
  };
  const callFinishWaypoint = async () => {
    const response = await authorizedFetch(buildApiUrl('waypoint/finish'), {
      method: 'PATCH',
      headers: {
        Accept: 'application/json'
      },
      body: buildFormData()
    });
    const rawBody = await response.text();
    const parsedBody = parseApiResponseBody(rawBody);
    return { response, parsedBody };
  };

  const obsFalha = options?.obs_falha ?? '';

  let { response, parsedBody } = await callFinishWaypoint();

  if (response.status === 401 || response.status === 403 || isAuthPayloadFailure(parsedBody)) {
    await refreshAccessTokenIfPossible();
    const retryResult = await callFinishWaypoint();
    response = retryResult.response;
    parsedBody = retryResult.parsedBody;
  }

  if (!response.ok) {
    throw new Error(pickApiErrorMessage(parsedBody, `Erro HTTP ${response.status}`));
  }
  assertWebhookSuccess(parsedBody, 'Não foi possível atualizar o status do waypoint.');
  invalidateRouteQueryCache(routeId);

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

  let { data } = await httpClient.patch('waypoint/reorder', {
    route_id: routeId,
    reordered_waypoints: reorderedWaypoints
  });

  if (isAuthPayloadFailure(data)) {
    await refreshAccessTokenIfPossible();
    const retry = await httpClient.patch('waypoint/reorder', {
      route_id: routeId,
      reordered_waypoints: reorderedWaypoints
    });
    data = retry.data;
  }

  assertWebhookSuccess(data, 'Não foi possível reordenar os waypoints.');
  invalidateRouteQueryCache(routeId);
}

type WaypointPhotoPayload =
  | {
      kind: 'base64';
      base64: string;
      fileName: string;
      mimeType: string;
    }
  | {
      kind: 'url';
      url: string;
      fileName: string;
      mimeType?: string;
    };

function normalizeMaybeBase64(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const dataUriMatch = /^data:([^;]+);base64,(.+)$/i.exec(trimmed);
  if (dataUriMatch) {
    return {
      mimeType: dataUriMatch[1] || 'image/jpeg',
      base64: dataUriMatch[2]
    };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed)) {
    return {
      mimeType: 'image/jpeg',
      base64: trimmed.replace(/\s+/g, '')
    };
  }
  return null;
}

function pickPhotoPayload(value: unknown, depth = 0): WaypointPhotoPayload | null {
  if (depth > 8 || value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const normalized = normalizeMaybeBase64(value);
    if (normalized) {
      return {
        kind: 'base64',
        base64: normalized.base64,
        fileName: `entrega_${Date.now()}.jpg`,
        mimeType: normalized.mimeType
      };
    }
    if (/^https?:\/\//i.test(value.trim())) {
      return {
        kind: 'url',
        url: value.trim(),
        fileName: `entrega_${Date.now()}.jpg`
      };
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = pickPhotoPayload(entry, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const possibleFileName = pickString(
    record.file_name,
    record.filename,
    record.name,
    record.fileName
  );
  const possibleMime = pickString(record.mime_type, record.mimeType, record.content_type, record.contentType);
  const possibleUrl = pickString(record.photo_url, record.photoUrl, record.image_url, record.imageUrl, record.url);
  const possibleBase64 = pickString(record.image_base64, record.photo_base64, record.base64, record.image);
  if (possibleBase64) {
    const normalized = normalizeMaybeBase64(possibleBase64);
    if (normalized) {
      return {
        kind: 'base64',
        base64: normalized.base64,
        fileName: possibleFileName ?? `entrega_${Date.now()}.jpg`,
        mimeType: possibleMime ?? normalized.mimeType
      };
    }
  }
  if (possibleUrl) {
    return {
      kind: 'url',
      url: possibleUrl,
      fileName: possibleFileName ?? `entrega_${Date.now()}.jpg`,
      mimeType: possibleMime ?? undefined
    };
  }

  const nestedKeys = ['data', 'body', 'result', 'output', 'photo', 'image', 'payload'];
  for (const key of nestedKeys) {
    if (!(key in record)) {
      continue;
    }
    const nested = pickPhotoPayload(record[key], depth + 1);
    if (nested) {
      if (possibleFileName && !nested.fileName) {
        nested.fileName = possibleFileName;
      }
      return nested;
    }
  }

  for (const entry of Object.values(record)) {
    const nested = pickPhotoPayload(entry, depth + 1);
    if (nested) {
      return nested;
    }
  }

  return null;
}

async function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Falha ao converter foto para base64.'));
    reader.onloadend = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Falha ao converter foto para base64.'));
        return;
      }
      const parts = reader.result.split(',');
      resolve(parts.length > 1 ? parts[1] : parts[0]);
    };
    reader.readAsDataURL(blob);
  });
}

export async function getWaypointPhoto(
  waypointId: number
): Promise<WaypointPhotoPayload | null> {
  const normalizedWaypointId = Math.trunc(Number(waypointId));
  if (!Number.isFinite(normalizedWaypointId) || normalizedWaypointId <= 0) {
    throw new Error('waypoint_id inválido para consulta da foto.');
  }

  const callGetPhoto = async () => {
    const response = await authorizedFetch(
      buildApiUrl(`waypoint/photo?waypoint_id=${normalizedWaypointId}`),
      {
        method: 'GET',
        headers: {
          Accept: 'application/json, image/*'
        }
      }
    );

    const contentType = response.headers.get('content-type') ?? '';
    const isImageResponse = /^image\//i.test(contentType.trim());
    if (isImageResponse) {
      const blob = await response.blob();
      return { response, contentType, parsedBody: null as unknown, blob };
    }

    const rawBody = await response.text();
    const parsedBody = parseApiResponseBody(rawBody);
    return { response, contentType, parsedBody, blob: null as Blob | null };
  };

  let { response, contentType, parsedBody, blob } = await callGetPhoto();

  if (response.status === 401 || response.status === 403 || isAuthPayloadFailure(parsedBody)) {
    await refreshAccessTokenIfPossible();
    const retryResult = await callGetPhoto();
    response = retryResult.response;
    contentType = retryResult.contentType;
    parsedBody = retryResult.parsedBody;
    blob = retryResult.blob;
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(pickApiErrorMessage(parsedBody, `Erro HTTP ${response.status}`));
  }

  if (blob && /^image\//i.test(contentType.trim())) {
    const base64 = await blobToBase64(blob);
    const safeMimeType = contentType.split(';')[0].trim() || 'image/jpeg';
    return {
      kind: 'base64',
      base64,
      fileName: `entrega_${normalizedWaypointId}.jpg`,
      mimeType: safeMimeType
    };
  }

  assertWebhookSuccess(parsedBody, 'Não foi possível carregar foto da entrega.');
  return pickPhotoPayload(parsedBody);
}

export async function deleteRoute(routeId: number) {
  const normalizedRouteId = Math.trunc(Number(routeId));
  if (!Number.isFinite(normalizedRouteId) || normalizedRouteId <= 0) {
    throw new Error('route_id inválido para exclusão.');
  }

  const callDelete = async () => {
    const response = await authorizedFetch(buildApiUrl(`route/${normalizedRouteId}`), {
      method: 'DELETE',
      headers: {
        Accept: 'application/json'
      }
    });
    const rawBody = await response.text();
    const parsedBody = parseApiResponseBody(rawBody);
    return { response, parsedBody };
  };

  let { response, parsedBody } = await callDelete();

  if (response.status === 401 || response.status === 403 || isAuthPayloadFailure(parsedBody)) {
    await refreshAccessTokenIfPossible();
    const retry = await callDelete();
    response = retry.response;
    parsedBody = retry.parsedBody;
  }

  if (response.status === 404) {
    invalidateRouteQueryCache(normalizedRouteId);
    return;
  }

  if (!response.ok) {
    throw new Error(pickApiErrorMessage(parsedBody, `Erro HTTP ${response.status}`));
  }

  assertWebhookSuccess(parsedBody, 'Não foi possível excluir a rota.');
  invalidateRouteQueryCache(normalizedRouteId);
}
