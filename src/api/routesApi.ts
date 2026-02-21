import { Route, RouteDetail, WaypointStatus } from './types';
import { httpClient } from './httpClient';

export async function listRoutes() {
  const { data } = await httpClient.get<Route[]>('routes');
  return data;
}

export async function createRoute(clusterId: number) {
  const { data } = await httpClient.post<Route>('routes', {
    cluster_id: clusterId
  });
  return data;
}

export async function getRouteDetails(routeId: number) {
  const { data } = await httpClient.get<RouteDetail>(`routes/${routeId}`);
  return data;
}

export async function updateWaypointStatus(
  routeId: number,
  waypointId: number,
  status: WaypointStatus
) {
  await httpClient.patch(`routes/${routeId}/waypoints`, {
    waypoint_id: waypointId,
    status
  });
}
