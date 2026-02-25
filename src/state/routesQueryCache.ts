import { RouteDetail, Waypoint } from '../api/types';

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type InFlightLoader<T> = () => Promise<T>;

const DEFAULT_ROUTES_TTL_MS = 20_000;
const DEFAULT_ROUTE_DETAIL_TTL_MS = 20_000;
const DEFAULT_ROUTE_WAYPOINTS_TTL_MS = 20_000;

let routesListCache: CacheEntry<RouteDetail[]> | null = null;
const routeDetailsCache = new Map<number, CacheEntry<RouteDetail>>();
const routeWaypointsCache = new Map<number, CacheEntry<Waypoint[]>>();
const inFlightRequests = new Map<string, Promise<unknown>>();

function cloneWaypoint(waypoint: Waypoint): Waypoint {
  return { ...waypoint };
}

function cloneWaypoints(waypoints: Waypoint[]): Waypoint[] {
  return waypoints.map(cloneWaypoint);
}

function cloneRouteDetail(route: RouteDetail): RouteDetail {
  return {
    ...route,
    waypoints: route.waypoints ? cloneWaypoints(route.waypoints) : route.waypoints
  };
}

function cloneRouteDetails(routes: RouteDetail[]): RouteDetail[] {
  return routes.map(cloneRouteDetail);
}

function isValidEntry<T>(entry: CacheEntry<T> | null | undefined) {
  return Boolean(entry && entry.expiresAt > Date.now());
}

function normalizeRouteId(routeId: number) {
  const parsed = Math.trunc(Number(routeId));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function setRoutesListCacheUnsafe(routes: RouteDetail[], ttlMs: number) {
  routesListCache = {
    value: cloneRouteDetails(routes),
    expiresAt: Date.now() + ttlMs
  };
}

export function withInFlightRequest<T>(key: string, loader: InFlightLoader<T>): Promise<T> {
  const existing = inFlightRequests.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = loader().finally(() => {
    inFlightRequests.delete(key);
  });
  inFlightRequests.set(key, promise);
  return promise;
}

export function getCachedRoutesList() {
  if (!isValidEntry(routesListCache)) {
    routesListCache = null;
    return null;
  }

  const current = routesListCache;
  if (!current) {
    return null;
  }
  return cloneRouteDetails(current.value);
}

export function setCachedRoutesList(routes: RouteDetail[], ttlMs = DEFAULT_ROUTES_TTL_MS) {
  setRoutesListCacheUnsafe(routes, ttlMs);
}

export function getCachedRouteDetail(routeId: number) {
  const normalizedRouteId = normalizeRouteId(routeId);
  if (!normalizedRouteId) {
    return null;
  }

  const entry = routeDetailsCache.get(normalizedRouteId);
  if (!isValidEntry(entry)) {
    routeDetailsCache.delete(normalizedRouteId);
    return null;
  }

  const current = entry;
  if (!current) {
    return null;
  }
  return cloneRouteDetail(current.value);
}

export function setCachedRouteDetail(
  routeId: number,
  routeDetail: RouteDetail,
  ttlMs = DEFAULT_ROUTE_DETAIL_TTL_MS
) {
  const normalizedRouteId = normalizeRouteId(routeId);
  if (!normalizedRouteId) {
    return;
  }

  const cloned = cloneRouteDetail(routeDetail);
  routeDetailsCache.set(normalizedRouteId, {
    value: cloned,
    expiresAt: Date.now() + ttlMs
  });

  if (cloned.waypoints && cloned.waypoints.length > 0) {
    setCachedRouteWaypoints(normalizedRouteId, cloned.waypoints, ttlMs);
  }
}

export function getCachedRouteWaypoints(routeId: number) {
  const normalizedRouteId = normalizeRouteId(routeId);
  if (!normalizedRouteId) {
    return null;
  }

  const entry = routeWaypointsCache.get(normalizedRouteId);
  if (!isValidEntry(entry)) {
    routeWaypointsCache.delete(normalizedRouteId);
    return null;
  }

  const current = entry;
  if (!current) {
    return null;
  }
  return cloneWaypoints(current.value);
}

export function setCachedRouteWaypoints(
  routeId: number,
  waypoints: Waypoint[],
  ttlMs = DEFAULT_ROUTE_WAYPOINTS_TTL_MS
) {
  const normalizedRouteId = normalizeRouteId(routeId);
  if (!normalizedRouteId) {
    return;
  }

  const clonedWaypoints = cloneWaypoints(waypoints);
  routeWaypointsCache.set(normalizedRouteId, {
    value: clonedWaypoints,
    expiresAt: Date.now() + ttlMs
  });

  const detailEntry = routeDetailsCache.get(normalizedRouteId);
  if (detailEntry && isValidEntry(detailEntry)) {
    routeDetailsCache.set(normalizedRouteId, {
      value: {
        ...detailEntry.value,
        waypoints: cloneWaypoints(clonedWaypoints),
        waypoints_count: clonedWaypoints.length
      },
      expiresAt: Math.max(detailEntry.expiresAt, Date.now() + ttlMs)
    });
  }
}

function invalidateRoutesListCache() {
  routesListCache = null;
}

export function invalidateRouteQueryCache(routeId?: number) {
  invalidateRoutesListCache();
  if (typeof routeId === 'number') {
    const normalizedRouteId = normalizeRouteId(routeId);
    if (!normalizedRouteId) {
      return;
    }
    routeDetailsCache.delete(normalizedRouteId);
    routeWaypointsCache.delete(normalizedRouteId);
    return;
  }

  routeDetailsCache.clear();
  routeWaypointsCache.clear();
}
