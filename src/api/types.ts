export type RouteStatus = 'PENDENTE' | 'CRIADA' | 'EM_ROTA' | 'EM_ANDAMENTO' | 'FINALIZADA';
export type WaypointStatus =
  | 'PENDENTE'
  | 'EM_ROTA'
  | 'CONCLUIDO'
  | 'FALHA TEMPO ADVERSO'
  | 'FALHA MORADOR AUSENTE';

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
  user_id?: number;
  seq_order: number;
  status: WaypointStatus;
  title?: string;
  subtitle?: string;
  latitude?: number;
  longitude?: number;
}

export interface RouteDetail extends Route {
  waypoints?: Waypoint[];
}

export interface ImportResult {
  orders_created: number;
  addresses_created: number;
  routes_generated: number;
  route_ids?: number[];
  route_id?: number;
}

export interface ClusterResult {
  address_id: number;
  cluster_id: number;
}
