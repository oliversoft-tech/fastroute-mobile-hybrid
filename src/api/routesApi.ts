import { Route, RouteDetail, Waypoint, WaypointStatus } from './types';
import { httpClient } from './httpClient';

interface ApiObject {
  [key: string]: unknown;
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

function extractCollection(data: unknown) {
  if (Array.isArray(data)) {
    return data as ApiObject[];
  }

  if (!data || typeof data !== 'object') {
    return [] as ApiObject[];
  }

  const payload = data as ApiObject;
  const nested =
    (payload.data as unknown) ??
    (payload.routes as unknown) ??
    (payload.route as unknown) ??
    (payload.items as unknown);

  if (Array.isArray(nested)) {
    return nested as ApiObject[];
  }

  if (nested && typeof nested === 'object') {
    return [nested as ApiObject];
  }

  return [payload];
}

function normalizeWaypoint(raw: ApiObject, routeIdFallback: number, index: number): Waypoint {
  return {
    id: toInteger(raw.id ?? raw.waypoint_id ?? raw.waypointId, index + 1),
    route_id: toInteger(raw.route_id ?? raw.routeId, routeIdFallback),
    address_id: toInteger(raw.address_id ?? raw.addressId ?? raw.id, index + 1),
    seq_order: toInteger(raw.seq_order ?? raw.seqOrder ?? raw.order, index + 1),
    status: mapWaypointStatus(raw.status)
  };
}

function normalizeRoute(raw: ApiObject, index: number): RouteDetail {
  const routeId = toInteger(raw.id ?? raw.route_id ?? raw.routeId, index + 1);
  const possibleWaypoints =
    (raw.waypoints as unknown) ?? (raw.paradas as unknown) ?? (raw.stops as unknown) ?? [];

  const waypoints = Array.isArray(possibleWaypoints)
    ? (possibleWaypoints as ApiObject[]).map((entry, waypointIndex) =>
        normalizeWaypoint(entry, routeId, waypointIndex)
      )
    : [];

  return {
    id: routeId,
    cluster_id: toInteger(raw.cluster_id ?? raw.clusterId, 0),
    status: mapRouteStatus(raw.status),
    created_at: String(raw.created_at ?? raw.createdAt ?? new Date().toISOString()),
    waypoints
  };
}

async function fetchRoutes(routeId?: number) {
  const { data } = await httpClient.get<unknown>('route', {
    params: routeId ? { route_id: routeId } : undefined
  });

  return extractCollection(data).map(normalizeRoute);
}

export async function listRoutes() {
  return fetchRoutes();
}

export async function getRouteDetails(routeId: number) {
  const [route] = await fetchRoutes(routeId);

  if (!route) {
    return {
      id: routeId,
      cluster_id: 0,
      status: 'PENDENTE' as const,
      created_at: new Date().toISOString(),
      waypoints: []
    };
  }

  return route;
}

export async function listRouteWaypoints(routeId: number) {
  const route = await getRouteDetails(routeId);
  return route.waypoints ?? [];
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

function mapWaypointFinishStatus(status: WaypointStatus) {
  if (status === 'CONCLUIDO') {
    return 'ENTREGUE';
  }

  if (status === 'EM_ROTA') {
    return 'EM_ROTA';
  }

  return 'PENDENTE';
}

export async function updateWaypointStatus(
  routeId: number,
  waypointId: number,
  status: WaypointStatus
) {
  void routeId;
  await httpClient.patch('waypoint/finish', {
    waypoint_id: String(waypointId),
    status: mapWaypointFinishStatus(status)
  });
}
