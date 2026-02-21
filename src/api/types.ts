export type RouteStatus = 'PENDENTE' | 'EM_ROTA' | 'FINALIZADA';
export type WaypointStatus = 'PENDENTE' | 'EM_ROTA' | 'CONCLUIDO';

export interface Route {
  id: number;
  cluster_id: number;
  status: RouteStatus;
  created_at: string;
}

export interface Waypoint {
  id: number;
  route_id: number;
  address_id: number;
  seq_order: number;
  status: WaypointStatus;
}

export interface RouteDetail extends Route {
  waypoints?: Waypoint[];
}

export interface ImportResult {
  orders_created: number;
  addresses_created: number;
  routes_generated: number;
}
