import { Linking, Platform } from 'react-native';
import { Waypoint } from '../api/types';
import { getWaypointMeta } from './waypointMeta';

export function buildGoogleMapsDirectionsUrl(waypoints: Waypoint[]) {
  const sorted = [...waypoints].sort((a, b) => a.seq_order - b.seq_order);
  const coordinates = sorted.map((waypoint) => {
    const meta = getWaypointMeta(waypoint);
    return `${meta.latitude},${meta.longitude}`;
  });

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

export async function openGoogleMapsRoute(waypoints: Waypoint[]) {
  const mapUrl = buildGoogleMapsDirectionsUrl(waypoints);
  if (!mapUrl) {
    return;
  }

  if (Platform.OS === 'web') {
    const browser = globalThis as { location?: { assign?: (url: string) => void } };
    if (browser.location?.assign) {
      browser.location.assign(mapUrl);
      return;
    }
  }

  await Linking.openURL(mapUrl);
}
