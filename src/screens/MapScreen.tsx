import { useEffect, useMemo, useState } from 'react';
import { Alert, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { getWaypointMeta } from '../utils/waypointMeta';
import { startRoute, updateWaypointOrder } from '../api/routesApi';
import { Waypoint } from '../api/types';
import { getApiError } from '../api/httpClient';
import { PrimaryButton } from '../components/PrimaryButton';
import { openGoogleMapsRoute } from '../utils/googleMaps';

type Props = NativeStackScreenProps<RootStackParamList, 'Map'>;
const WebIFrame = 'iframe' as unknown as React.ComponentType<Record<string, unknown>>;

type WaypointBadge = {
  waypointId: number;
  order: number;
  pointType?: string;
  wasReordered?: boolean;
  title: string;
  subtitle?: string;
};

function buildLeafletMapHtml(
  points: Array<{
    pointKey: string;
    waypointId: number;
    title: string;
    subtitle: string;
    latitude: number;
    longitude: number;
  }>
) {
  const payload = JSON.stringify(
    points.map((point, index) => ({
      ...point,
      order: index + 1
    }))
  );

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    html, body, #map { margin: 0; padding: 0; width: 100%; height: 100%; }
    .pin { width: 28px; height: 28px; border-radius: 14px; background: #2154b3; border: 2px solid #fff; color: #fff; display:flex; align-items:center; justify-content:center; font: 700 12px sans-serif; box-shadow: 0 1px 5px rgba(0,0,0,.4); }
  </style>
</head>
<body>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const points = ${payload};
    const movedPointKeys = new Set();
    const map = L.map('map', { zoomControl: true, attributionControl: true });
    const markersLayer = L.layerGroup().addTo(map);
    let routeBaseLayer = null;
    let routeMainLayer = null;
    let routeRequestCounter = 0;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    function emit(payload) {
      window.parent.postMessage({ source: 'fastroute-map', ...payload }, '*');
    }

    function clearRouteLayer() {
      if (routeBaseLayer) {
        map.removeLayer(routeBaseLayer);
        routeBaseLayer = null;
      }
      if (routeMainLayer) {
        map.removeLayer(routeMainLayer);
        routeMainLayer = null;
      }
    }

    function buildStraightRoute() {
      return points.map((point) => [point.latitude, point.longitude]);
    }

    async function fetchRoadRoute() {
      if (points.length < 2) {
        return buildStraightRoute();
      }

      const coords = points.map((point) => point.longitude + ',' + point.latitude).join(';');
      const url =
        'https://router.project-osrm.org/route/v1/driving/' +
        coords +
        '?overview=full&geometries=geojson&alternatives=false&steps=false';

      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error('route_fetch_failed');
        }

        const payload = await response.json();
        const rawCoordinates = payload?.routes?.[0]?.geometry?.coordinates;
        if (!Array.isArray(rawCoordinates) || rawCoordinates.length < 2) {
          throw new Error('route_geometry_missing');
        }

        return rawCoordinates.map((coord) => [coord[1], coord[0]]);
      } catch {
        return buildStraightRoute();
      }
    }

    async function drawRouteLine() {
      const requestId = ++routeRequestCounter;
      const latLngs = await fetchRoadRoute();

      if (requestId !== routeRequestCounter) {
        return;
      }

      clearRouteLayer();

      if (!Array.isArray(latLngs) || latLngs.length < 2) {
        return;
      }

      routeBaseLayer = L.polyline(latLngs, {
        color: '#E9D5FF',
        weight: 12,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(map);

      routeMainLayer = L.polyline(latLngs, {
        color: '#7E22CE',
        weight: 7,
        opacity: 0.98,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(map);

      routeBaseLayer.bringToBack();
      routeMainLayer.bringToBack();
    }

    function createIcon(point, order, total) {
      const wasReordered = movedPointKeys.has(point.pointKey);
      const isStart = order === 1;
      const isEnd = order === total && total > 1;
      const bg = wasReordered ? '#F59E0B' : (isStart ? '#A855F7' : (isEnd ? '#CC3D36' : '#2154b3'));
      return L.divIcon({
        className: '',
        html: '<div class="pin" style="background:' + bg + ';">' + order + '</div>',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });
    }

    function applyViewport() {
      const bounds = points.map((point) => [point.latitude, point.longitude]);
      if (bounds.length === 0) {
        map.setView([40.211, -8.429], 13);
        return;
      }
      if (bounds.length === 1) {
        map.setView(bounds[0], 15);
        return;
      }
      map.fitBounds(bounds, { padding: [40, 40] });
    }

    function reorder(draggedKey, droppedLatLng) {
      const fromIndex = points.findIndex((point) => point.pointKey === draggedKey);
      if (fromIndex < 0) {
        return { changed: false, targetKey: null };
      }

      const droppedPoint = map.latLngToContainerPoint(droppedLatLng);
      let targetIndex = fromIndex;
      let minDistance = Infinity;

      points.forEach((point, index) => {
        if (index === fromIndex) {
          return;
        }
        const markerPoint = map.latLngToContainerPoint([point.latitude, point.longitude]);
        const distance = droppedPoint.distanceTo(markerPoint);
        if (distance < minDistance) {
          minDistance = distance;
          targetIndex = index;
        }
      });

      if (targetIndex !== fromIndex && minDistance <= 90) {
        const targetKey = points[targetIndex].pointKey;
        const moved = points.splice(fromIndex, 1)[0];
        points.splice(targetIndex, 0, moved);
        return { changed: true, targetKey };
      }

      return { changed: false, targetKey: null };
    }

    function renderMap() {
      markersLayer.clearLayers();
      drawRouteLine();

      points.forEach((point, index) => {
        const order = index + 1;
        const wasReordered = movedPointKeys.has(point.pointKey);
        const isStart = order === 1;
        const isEnd = order === points.length && points.length > 1;
        const pointType = isStart ? 'Início' : (isEnd ? 'Fim' : 'Parada');
        const marker = L.marker([point.latitude, point.longitude], {
          icon: createIcon(point, order, points.length),
          draggable: true,
          autoPan: true
        }).addTo(markersLayer);

        marker.on('dragend', (event) => {
          const result = reorder(point.pointKey, event.target.getLatLng());
          const changed = result.changed;
          if (changed) {
            movedPointKeys.add(point.pointKey);
            if (result.targetKey) {
              movedPointKeys.add(result.targetKey);
            }
          }
          renderMap();
          if (changed) {
            applyViewport();
          }
        });

        marker.on('dblclick', () => {
          emit({
            type: 'waypoint_dblclick',
            waypointId: point.waypointId,
            pointKey: point.pointKey,
            order,
            title: point.title,
            subtitle: point.subtitle || '',
            pointType,
            wasReordered
          });
        });

      });

      const movedWaypointIds = [...new Set(
        points
          .filter((point) => movedPointKeys.has(point.pointKey))
          .map((point) => point.waypointId)
      )];
      emit({
        type: 'reorder',
        order: points.map((point) => point.pointKey),
        movedWaypointIds
      });
    }

    applyViewport();
    renderMap();
  </script>
</body>
</html>`;
}

export function MapScreen({ route }: Props) {
  const { waypoints } = route.params;
  const [orderedPointKeys, setOrderedPointKeys] = useState<string[]>([]);
  const [movedWaypointIds, setMovedWaypointIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [mapLoadError, setMapLoadError] = useState(false);
  const [badge, setBadge] = useState<WaypointBadge | null>(null);
  const initialWaypoints = useMemo(() => [...waypoints].sort((a, b) => a.seq_order - b.seq_order), [waypoints]);

  const initialPoints = useMemo(
    () =>
      initialWaypoints.map((waypoint, index) => {
        const meta = getWaypointMeta(waypoint);
        return {
          pointKey: `pin-${index + 1}-${waypoint.id}`,
          waypoint,
          waypointId: waypoint.id,
          title: meta.title,
          subtitle: meta.subtitle,
          latitude: meta.latitude,
          longitude: meta.longitude
        };
      }),
    [initialWaypoints]
  );

  useEffect(() => {
    setOrderedPointKeys(initialPoints.map((point) => point.pointKey));
    setMovedWaypointIds([]);
  }, [initialPoints]);

  const pointsByKey = useMemo(
    () => new Map(initialPoints.map((point) => [point.pointKey, point])),
    [initialPoints]
  );

  const orderedPoints = useMemo(() => {
    if (orderedPointKeys.length === 0) {
      return initialPoints;
    }

    const usedKeys = new Set<string>();
    const reordered = orderedPointKeys
      .map((pointKey) => pointsByKey.get(pointKey))
      .filter((point): point is (typeof initialPoints)[number] => Boolean(point))
      .map((point) => {
        usedKeys.add(point.pointKey);
        return point;
      });

    for (const point of initialPoints) {
      if (!usedKeys.has(point.pointKey)) {
        reordered.push(point);
      }
    }

    return reordered;
  }, [initialPoints, orderedPointKeys, pointsByKey]);

  const orderedWaypoints = useMemo(
    () =>
      orderedPoints.map((point, index) => ({
        ...point.waypoint,
        seq_order: index + 1
      })),
    [orderedPoints]
  );

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }

    const browser = globalThis as {
      addEventListener?: (event: string, handler: (event: unknown) => void) => void;
      removeEventListener?: (event: string, handler: (event: unknown) => void) => void;
    };

    const onMessage = (event: unknown) => {
      const messageEvent = event as { data?: unknown };
      const raw = messageEvent.data;
      const payload =
        typeof raw === 'string'
          ? (() => {
              try {
                return JSON.parse(raw) as Record<string, unknown>;
              } catch {
                return null;
              }
            })()
          : (raw as Record<string, unknown> | null);

      if (!payload || payload.source !== 'fastroute-map') {
        return;
      }

      if (payload.type === 'reorder' && Array.isArray(payload.order)) {
        const orderKeys = payload.order.map((entry) => String(entry));
        setOrderedPointKeys(orderKeys);
        if (Array.isArray(payload.movedWaypointIds)) {
          const changedIds = [...new Set(
            payload.movedWaypointIds
              .map((entry) => Number(entry))
              .filter((entry) => Number.isFinite(entry))
          )];
          setMovedWaypointIds(changedIds);
        }
      }

      if (payload.type === 'waypoint_dblclick') {
        const waypointId = Number(payload.waypointId);
        const order = Number(payload.order);
        const pointType = String(payload.pointType ?? '').trim();
        const wasReordered = Boolean(payload.wasReordered);
        const title = String(payload.title ?? '').trim();
        const subtitle = String(payload.subtitle ?? '').trim();

        if (Number.isFinite(waypointId)) {
          setBadge({
            waypointId,
            order: Number.isFinite(order) ? order : 0,
            pointType: pointType || undefined,
            wasReordered,
            title: title || 'Waypoint',
            subtitle: subtitle || undefined
          });
        }
      }
    };

    browser.addEventListener?.('message', onMessage);

    return () => {
      browser.removeEventListener?.('message', onMessage);
    };
  }, []);

  useEffect(() => {
    if (!badge) {
      return;
    }

    const timeout = setTimeout(() => {
      setBadge(null);
    }, 5000);

    return () => clearTimeout(timeout);
  }, [badge]);

  const webMapHtml = useMemo(() => buildLeafletMapHtml(initialPoints), [initialPoints]);

  const nativeMapUrl = useMemo(() => {
    const initial = orderedPoints[0] ?? { latitude: 40.211, longitude: -8.429 };
    const markers = orderedPoints
      .map((point) => `${point.latitude},${point.longitude},lightblue1`)
      .join('|');
    return `https://staticmap.openstreetmap.de/staticmap.php?center=${initial.latitude},${initial.longitude}&zoom=13&size=640x640&markers=${encodeURIComponent(markers)}`;
  }, [orderedPoints]);

  const openDirections = async () => {
    if (orderedWaypoints.length === 0) {
      return;
    }

    await openGoogleMapsRoute(orderedWaypoints);
  };

  const startRouteAndNavigate = async () => {
    try {
      setLoading(true);
      await startRoute(route.params.routeId);
      await openDirections();
    } catch (error) {
      Alert.alert('Erro ao iniciar rota', getApiError(error));
    } finally {
      setLoading(false);
    }
  };

  const onConfirmOrder = async () => {
    try {
      setLoading(true);
      const changedIds = [...new Set(
        movedWaypointIds
          .map((value) => Math.trunc(Number(value)))
          .filter((value) => Number.isFinite(value))
      )];
      if (changedIds.length > 0) {
        await updateWaypointOrder(changedIds);
      }

      Alert.alert('Ordem confirmada', 'Deseja iniciar a rota?', [
        {
          text: 'Não',
          style: 'cancel'
        },
        {
          text: 'Sim',
          onPress: () => {
            void startRouteAndNavigate();
          }
        }
      ]);
    } catch (error) {
      Alert.alert('Erro ao confirmar ordem', getApiError(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.mapFull}>
        {Platform.OS === 'web' ? (
          <WebIFrame srcDoc={webMapHtml} style={styles.webFrame} title="Mapa da rota" />
        ) : (
          <Image
            source={{ uri: nativeMapUrl }}
            style={styles.nativeMapImage}
            resizeMode="cover"
            onError={() => setMapLoadError(true)}
          />
        )}

        {Platform.OS !== 'web' && mapLoadError ? (
          <View style={styles.mapFallbackOverlay}>
            <Text style={styles.mapFallbackText}>Mapa indisponível neste dispositivo.</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.routeHeader}>
        <Text style={styles.routeHeaderTitle}>Rota #{route.params.routeId}</Text>
      </View>

      {badge ? (
        <View style={styles.badgeCard}>
          <View style={styles.badgeHeader}>
            <Text style={styles.badgeTitle}>{badge.pointType ?? 'Parada'} #{badge.order}</Text>
            <Pressable onPress={() => setBadge(null)}>
              <Text style={styles.badgeClose}>Fechar</Text>
            </Pressable>
          </View>
          <Text style={styles.badgeMain}>{badge.title}</Text>
          {badge.subtitle ? <Text style={styles.badgeSub}>{badge.subtitle}</Text> : null}
          {badge.wasReordered ? <Text style={styles.badgeChanged}>Waypoint reordenado</Text> : null}
        </View>
      ) : null}

      <View style={styles.bottomBar}>
        <Text style={styles.bottomHint}>
          Número do pin = ordem da rota. Lilás = Início, vermelho = Fim, laranja = reordenado.
        </Text>
        <PrimaryButton
          label="Confirmar ordem"
          onPress={onConfirmOrder}
          loading={loading}
          disabled={orderedWaypoints.length === 0}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background
  },
  mapFull: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#dde8ff'
  },
  webFrame: {
    width: '100%',
    height: '100%',
    borderWidth: 0
  },
  nativeMapImage: {
    width: '100%',
    height: '100%'
  },
  mapFallbackOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 24, 50, 0.45)',
    padding: 16
  },
  mapFallbackText: {
    color: '#fff',
    fontWeight: '700'
  },
  routeHeader: {
    position: 'absolute',
    top: 14,
    left: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.96)',
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  routeHeaderTitle: {
    color: colors.textPrimary,
    fontWeight: '800',
    fontSize: 14
  },
  badgeCard: {
    position: 'absolute',
    top: 62,
    left: 14,
    right: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.98)',
    padding: 12,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 }
  },
  badgeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  badgeTitle: {
    color: colors.textSecondary,
    fontWeight: '700',
    fontSize: 12
  },
  badgeClose: {
    color: colors.primary,
    fontWeight: '700',
    fontSize: 12
  },
  badgeMain: {
    color: colors.textPrimary,
    fontWeight: '800',
    fontSize: 16,
    marginTop: 6
  },
  badgeSub: {
    color: colors.textSecondary,
    marginTop: 4
  },
  badgeChanged: {
    color: '#B66900',
    fontWeight: '700',
    marginTop: 6,
    fontSize: 12
  },
  bottomBar: {
    marginTop: 'auto',
    padding: 12,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderTopWidth: 1,
    borderTopColor: colors.border
  },
  bottomHint: {
    color: colors.textSecondary,
    fontSize: 12,
    marginBottom: 8
  }
});
