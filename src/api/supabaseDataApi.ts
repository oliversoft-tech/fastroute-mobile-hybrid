import { createClient } from '@supabase/supabase-js';
import { Waypoint, WaypointStatus } from './types';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/api';

type RouteWaypointRow = {
  id: number;
  route_id: number;
  address_id: number;
  seq_order: number;
  status: string | null;
};

type AddressRow = {
  id: number;
  detailed_address: string | null;
  zipcode: string | null;
  city: string | null;
  lat: string | number | null;
  longitude: string | number | null;
};

let supabaseClient: ReturnType<typeof createClient> | null = null;

function getSupabaseClient() {
  if (supabaseClient) {
    return supabaseClient;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      'Configuração do Supabase ausente. Defina EXPO_PUBLIC_SUPABASE_URL e EXPO_PUBLIC_SUPABASE_ANON_KEY.'
    );
  }

  supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  return supabaseClient;
}

function toNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

export async function listRouteWaypointsFromSupabase(routeId: number): Promise<Waypoint[]> {
  const supabase = getSupabaseClient();

  const { data: waypointRows, error: routeWaypointError } = await supabase
    .from('route_waypoints')
    .select('id, route_id, address_id, seq_order, status')
    .eq('route_id', routeId)
    .order('seq_order', { ascending: true });

  if (routeWaypointError) {
    throw routeWaypointError;
  }

  const normalizedWaypoints = ((waypointRows ?? []) as RouteWaypointRow[]).filter(
    (row) => Number.isFinite(Number(row.id)) && Number.isFinite(Number(row.address_id))
  );

  if (normalizedWaypoints.length === 0) {
    return [];
  }

  const addressIds = [...new Set(normalizedWaypoints.map((row) => row.address_id))];
  const { data: addressRows, error: addressError } = await supabase
    .from('addresses')
    .select('id, detailed_address, zipcode, city, lat, longitude')
    .in('id', addressIds);

  if (addressError) {
    throw addressError;
  }

  const addressMap = new Map<number, AddressRow>();
  for (const address of (addressRows ?? []) as AddressRow[]) {
    addressMap.set(address.id, address);
  }

  return normalizedWaypoints.map((row) => {
    const address = addressMap.get(row.address_id);
    const title = address?.detailed_address?.trim() || 'Endereço não informado';
    const subtitle = [address?.zipcode?.trim(), address?.city?.trim()].filter(Boolean).join(' - ');

    return {
      id: Number(row.id),
      route_id: Number(row.route_id),
      address_id: Number(row.address_id),
      seq_order: Number(row.seq_order),
      status: mapWaypointStatus(row.status),
      title,
      subtitle: subtitle || undefined,
      latitude: toNumber(address?.lat),
      longitude: toNumber(address?.longitude)
    };
  });
}
