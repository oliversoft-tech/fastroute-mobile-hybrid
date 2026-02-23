import { Waypoint } from '../api/types';

const routeWaypointOrderCache = new Map<number, number[]>();

function normalizeIds(ids: number[]) {
  const normalized: number[] = [];
  const seen = new Set<number>();

  for (const rawId of ids) {
    const id = Math.trunc(Number(rawId));
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push(id);
  }

  return normalized;
}

export function cacheRouteWaypointOrder(routeId: number, waypointIds: number[]) {
  const normalizedRouteId = Math.trunc(Number(routeId));
  const normalizedIds = normalizeIds(waypointIds);

  if (!Number.isFinite(normalizedRouteId) || normalizedRouteId <= 0 || normalizedIds.length === 0) {
    return;
  }

  routeWaypointOrderCache.set(normalizedRouteId, normalizedIds);
}

export function getCachedRouteWaypointOrder(routeId: number) {
  const normalizedRouteId = Math.trunc(Number(routeId));
  if (!Number.isFinite(normalizedRouteId) || normalizedRouteId <= 0) {
    return null;
  }

  return routeWaypointOrderCache.get(normalizedRouteId) ?? null;
}

export function applyWaypointOrder(waypoints: Waypoint[], orderedWaypointIds: number[] | null) {
  if (!Array.isArray(waypoints) || waypoints.length === 0) {
    return [];
  }

  const base = [...waypoints].sort((a, b) => a.seq_order - b.seq_order);
  if (!orderedWaypointIds || orderedWaypointIds.length === 0) {
    return base;
  }

  const order = normalizeIds(orderedWaypointIds);
  if (order.length === 0) {
    return base;
  }

  const byId = new Map(base.map((waypoint) => [waypoint.id, waypoint]));
  const used = new Set<number>();
  const reordered: Waypoint[] = [];

  for (const waypointId of order) {
    const waypoint = byId.get(waypointId);
    if (!waypoint) {
      continue;
    }
    reordered.push(waypoint);
    used.add(waypointId);
  }

  for (const waypoint of base) {
    if (!used.has(waypoint.id)) {
      reordered.push(waypoint);
    }
  }

  return reordered.map((waypoint, index) => ({
    ...waypoint,
    seq_order: index + 1
  }));
}
