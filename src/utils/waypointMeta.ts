import { Waypoint } from '../api/types';

export interface WaypointMeta {
  title: string;
  subtitle: string;
  latitude: number;
  longitude: number;
}

const presets: Record<number, WaypointMeta> = {
  1: {
    title: 'Rua do Brasil 50',
    subtitle: '33300-223 - Coimbra',
    latitude: 40.213,
    longitude: -8.429
  },
  2: {
    title: 'Rua da Sé 62',
    subtitle: '33200-232 - Coimbra',
    latitude: 40.214,
    longitude: -8.431
  },
  3: {
    title: 'Rua da Sofia 9',
    subtitle: '3300-331 - Coimbra',
    latitude: 40.208,
    longitude: -8.424
  }
};

function pseudoCoordinate(seed: number, origin: number, factor: number) {
  const normalized = ((seed * 9301 + 49297) % 233280) / 233280;
  return origin + (normalized - 0.5) * factor;
}

export function getWaypointMeta(waypoint: Waypoint): WaypointMeta {
  const normalizedAddressId = Math.trunc(Number(waypoint.address_id));
  const hasAddressId = Number.isFinite(normalizedAddressId) && normalizedAddressId > 0;
  const normalizedTitle =
    waypoint.title?.trim() || (hasAddressId ? `Endereço ${normalizedAddressId}` : `Waypoint #${waypoint.id}`);
  const normalizedSubtitle =
    waypoint.subtitle?.trim() ??
    (typeof waypoint.latitude === 'number' && typeof waypoint.longitude === 'number'
      ? `${waypoint.latitude.toFixed(6)}, ${waypoint.longitude.toFixed(6)}`
      : '');

  if (typeof waypoint.latitude === 'number' && typeof waypoint.longitude === 'number') {
    return {
      title: normalizedTitle,
      subtitle: normalizedSubtitle,
      latitude: waypoint.latitude,
      longitude: waypoint.longitude
    };
  }

  const addressId = waypoint.address_id;
  const waypointId = waypoint.id;

  if (presets[addressId]) {
    return presets[addressId];
  }

  return {
    title: normalizedTitle,
    subtitle: normalizedSubtitle,
    latitude: pseudoCoordinate(addressId + waypointId, 40.211, 0.05),
    longitude: pseudoCoordinate(addressId + waypointId * 2, -8.429, 0.05)
  };
}
