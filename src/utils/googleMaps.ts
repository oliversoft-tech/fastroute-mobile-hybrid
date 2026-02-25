import { Linking, Platform } from 'react-native';
import { Waypoint } from '../api/types';
import { getWaypointMeta } from './waypointMeta';

function buildCoordinatePairs(waypoints: Waypoint[]) {
  const sorted = [...waypoints].sort((a, b) => a.seq_order - b.seq_order);
  return sorted.map((waypoint) => {
    const meta = getWaypointMeta(waypoint);
    return `${meta.latitude},${meta.longitude}`;
  });
}

export function buildGoogleMapsDirectionsUrl(waypoints: Waypoint[]) {
  const coordinates = buildCoordinatePairs(waypoints);

  if (coordinates.length === 0) {
    return null;
  }

  if (coordinates.length === 1) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coordinates[0])}`;
  }

  const origin = coordinates[0];
  const destination = coordinates[coordinates.length - 1];
  const waypointList = coordinates.slice(1, -1);
  const params = [
    'api=1',
    `origin=${encodeURIComponent(origin)}`,
    `destination=${encodeURIComponent(destination)}`,
    'travelmode=driving'
  ];

  if (waypointList.length > 0) {
    params.push(`waypoints=${encodeURIComponent(waypointList.join('|'))}`);
  }

  return `https://www.google.com/maps/dir/?${params.join('&')}`;
}

function buildGoogleMapsAppUrl(waypoints: Waypoint[]) {
  const coordinates = buildCoordinatePairs(waypoints);
  if (coordinates.length === 0) {
    return;
  }

  if (coordinates.length === 1) {
    return `comgooglemaps://?q=${encodeURIComponent(coordinates[0])}&directionsmode=driving`;
  }

  const origin = coordinates[0];
  const destination = coordinates[coordinates.length - 1];
  const waypointList = coordinates.slice(1, -1);
  const params = [
    `saddr=${encodeURIComponent(origin)}`,
    `daddr=${encodeURIComponent(destination)}`,
    'directionsmode=driving'
  ];

  if (waypointList.length > 0) {
    params.push(`waypoints=${encodeURIComponent(waypointList.join('|'))}`);
  }

  return `comgooglemaps://?${params.join('&')}`;
}

export async function openGoogleMapsRoute(waypoints: Waypoint[]) {
  const webUrl = buildGoogleMapsDirectionsUrl(waypoints);
  if (!webUrl) {
    return false;
  }

  if (Platform.OS === 'web') {
    const browser = globalThis as { location?: { assign?: (url: string) => void } };
    if (browser.location?.assign) {
      browser.location.assign(webUrl);
      return true;
    }
    return false;
  }

  const appUrl = buildGoogleMapsAppUrl(waypoints);
  const candidates = [appUrl, webUrl].filter((url): url is string => Boolean(url));

  for (const candidate of candidates) {
    try {
      const canOpen = await Linking.canOpenURL(candidate);
      if (!canOpen) {
        continue;
      }
      await Linking.openURL(candidate);
      return true;
    } catch {
      // Tenta próximo fallback de URL.
    }
  }

  throw new Error('Não foi possível abrir o Google Maps neste dispositivo.');
}
