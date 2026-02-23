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

type WaypointPersistStatus = 'PENDENTE' | 'ENTREGUE' | 'FALHA TEMPO ADVERSO' | 'FALHA MORADOR AUSENTE';
type RouteMetadataRow = {
  id: number;
  status: string | null;
  created_at: string | null;
  cluster_id: number | null;
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

function toIntegerString(value: unknown): string | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return String(Math.trunc(parsed));
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

function buildAddressTitle(address?: AddressRow) {
  return address?.detailed_address?.trim() || 'Endereço não informado';
}

function buildAddressSubtitle(address?: AddressRow) {
  return [address?.zipcode?.trim(), address?.city?.trim()].filter(Boolean).join(' - ') || undefined;
}

async function loadAddressesByIds(addressIds: number[]) {
  if (addressIds.length === 0) {
    return new Map<number, AddressRow>();
  }

  const supabase = getSupabaseClient();
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

  return addressMap;
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
  const addressMap = await loadAddressesByIds(addressIds);

  return normalizedWaypoints.map((row) => {
    const address = addressMap.get(row.address_id);

    return {
      id: Number(row.id),
      route_id: Number(row.route_id),
      address_id: Number(row.address_id),
      seq_order: Number(row.seq_order),
      status: mapWaypointStatus(row.status),
      title: buildAddressTitle(address),
      subtitle: buildAddressSubtitle(address),
      latitude: toNumber(address?.lat),
      longitude: toNumber(address?.longitude)
    };
  });
}

export async function getRouteMetadataFromSupabase(routeId: number): Promise<{
  status: string | null;
  created_at: string | null;
  cluster_id: number | null;
} | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('routes')
    .select('id, status, created_at, cluster_id')
    .eq('id', routeId)
    .limit(1);

  if (error) {
    throw error;
  }

  const row = (data?.[0] ?? null) as RouteMetadataRow | null;
  if (!row) {
    return null;
  }

  return {
    status: row.status ?? null,
    created_at: row.created_at ?? null,
    cluster_id: row.cluster_id ?? null
  };
}

export async function resolveDriverUserIdFromAuthId(authUserId?: string | null) {
  const normalizedAuthId = authUserId?.trim() ?? '';
  if (!normalizedAuthId) {
    return null;
  }

  if (/^\d+$/.test(normalizedAuthId)) {
    return normalizedAuthId;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('auth_user_id', normalizedAuthId)
    .order('id', { ascending: true })
    .limit(1);

  if (error) {
    throw error;
  }

  return toIntegerString((data?.[0] as { id?: unknown } | undefined)?.id);
}

export async function enrichWaypointsWithAddressData(waypoints: Waypoint[]): Promise<Waypoint[]> {
  const normalizedWaypoints = waypoints.filter(
    (waypoint) => Number.isFinite(Number(waypoint.id)) && Number.isFinite(Number(waypoint.address_id))
  );

  if (normalizedWaypoints.length === 0) {
    return waypoints;
  }

  const addressIds = [...new Set(normalizedWaypoints.map((waypoint) => Number(waypoint.address_id)))];
  const addressMap = await loadAddressesByIds(addressIds);

  return waypoints.map((waypoint) => {
    const address = addressMap.get(Number(waypoint.address_id));
    if (!address) {
      return waypoint;
    }

    const hasValidTitle =
      typeof waypoint.title === 'string' &&
      waypoint.title.trim().length > 0 &&
      waypoint.title.trim().toLowerCase() !== 'endereço não informado';

    return {
      ...waypoint,
      title: hasValidTitle ? waypoint.title : buildAddressTitle(address),
      subtitle: waypoint.subtitle?.trim()?.length ? waypoint.subtitle : buildAddressSubtitle(address),
      latitude: typeof waypoint.latitude === 'number' ? waypoint.latitude : toNumber(address.lat),
      longitude: typeof waypoint.longitude === 'number' ? waypoint.longitude : toNumber(address.longitude)
    };
  });
}

export async function updateRouteWaypointStatusInSupabase(params: {
  waypointId: number;
  addressId?: number;
  status: WaypointPersistStatus;
  obsFalha?: string;
}) {
  const supabase = getSupabaseClient();
  const payload: Record<string, unknown> = {
    status: params.status
  };

  const obsFalha = params.obsFalha?.trim();
  if (obsFalha) {
    payload.obs_falha = obsFalha;
  }

  const { data: updatedById, error: updateByIdError } = await supabase
    .from('route_waypoints')
    .update(payload as never)
    .eq('id', params.waypointId)
    .select('id')
    .limit(1);

  if (updateByIdError) {
    throw updateByIdError;
  }

  if ((updatedById ?? []).length > 0) {
    return;
  }

  if (!Number.isFinite(Number(params.addressId))) {
    return;
  }

  const { error: updateByAddressError } = await supabase
    .from('route_waypoints')
    .update(payload as never)
    .eq('address_id', Number(params.addressId))
    .select('id')
    .limit(1);

  if (updateByAddressError) {
    throw updateByAddressError;
  }
}
