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
  points: Array<{ id: number; title: string; subtitle: string; latitude: number; longitude: number }>
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
    const originalOrder = new Map(points.map((point, index) => [point.id, index + 1]));
    const movedIds = new Set();
    const map = L.map('map', { zoomControl: true, attributionControl: true });
    const markersLayer = L.layerGroup().addTo(map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    function emit(payload) {
      window.parent.postMessage({ source: 'fastroute-map', ...payload }, '*');
    }

    function createIcon(point, order, total) {
      const wasReordered = movedIds.has(point.id);
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

    function reorder(draggedId, droppedLatLng) {
      const fromIndex = points.findIndex((point) => point.id === draggedId);
      if (fromIndex < 0) {
        return false;
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
        const moved = points.splice(fromIndex, 1)[0];
        points.splice(targetIndex, 0, moved);
        return true;
      }

      return false;
    }

    function renderMap() {
      markersLayer.clearLayers();

      points.forEach((point, index) => {
        const order = index + 1;
        const wasReordered = movedIds.has(point.id);
        const isStart = order === 1;
        const isEnd = order === points.length && points.length > 1;
        const pointType = isStart ? 'Início' : (isEnd ? 'Fim' : 'Parada');
        const marker = L.marker([point.latitude, point.longitude], {
          icon: createIcon(point, order, points.length),
          draggable: true,
          autoPan: true
        }).addTo(markersLayer);

        marker.on('dragend', (event) => {
          const changed = reorder(point.id, event.target.getLatLng());
          if (changed) {
            const currentIndex = points.findIndex((entry) => entry.id === point.id);
            const currentOrder = currentIndex + 1;
            const original = originalOrder.get(point.id);
            if (original === currentOrder) {
              movedIds.delete(point.id);
            } else {
              movedIds.add(point.id);
            }
          }
          renderMap();
        });

        marker.on('dblclick', () => {
          emit({
            type: 'waypoint_dblclick',
            waypointId: point.id,
            order,
            title: point.title,
            subtitle: point.subtitle || '',
            pointType,
            wasReordered
          });
        });

        const subtitle = point.subtitle ? ('<br/>' + point.subtitle) : '';
        marker.bindTooltip('<b>' + pointType + ' #' + order + ' · ' + point.title + '</b>' + subtitle);
      });

      emit({ type: 'reorder', order: points.map((point) => point.id) });
    }

    applyViewport();
    renderMap();
  </script>
</body>
</html>`;
}

export function MapScreen({ route }: Props) {
  const { waypoints } = route.params;
  const [orderedWaypoints, setOrderedWaypoints] = useState<Waypoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [mapLoadError, setMapLoadError] = useState(false);
  const [badge, setBadge] = useState<WaypointBadge | null>(null);
  const initialWaypoints = useMemo(() => [...waypoints].sort((a, b) => a.seq_order - b.seq_order), [waypoints]);

  useEffect(() => {
    setOrderedWaypoints(initialWaypoints);
  }, [initialWaypoints]);

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
        const orderIds = payload.order.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry));
        setOrderedWaypoints((current) => {
          if (orderIds.length === 0) {
            return current;
          }

          const mapById = new Map(current.map((waypoint) => [waypoint.id, waypoint]));
          const reordered = orderIds
            .map((id) => mapById.get(id))
            .filter((item): item is Waypoint => Boolean(item))
            .map((waypoint, index) => ({
              ...waypoint,
              seq_order: index + 1
            }));

          if (reordered.length !== current.length) {
            const missing = current.filter((waypoint) => !orderIds.includes(waypoint.id));
            const merged = [...reordered, ...missing];
            return merged.map((waypoint, index) => ({
              ...waypoint,
              seq_order: index + 1
            }));
          }

          return reordered;
        });
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

  const initialPoints = useMemo(
    () =>
      initialWaypoints.map((waypoint) => {
        const meta = getWaypointMeta(waypoint);
        return {
          id: waypoint.id,
          title: meta.title,
          subtitle: meta.subtitle,
          latitude: meta.latitude,
          longitude: meta.longitude
        };
      }),
    [initialWaypoints]
  );

  const points = useMemo(
    () =>
      orderedWaypoints.map((waypoint) => {
        const meta = getWaypointMeta(waypoint);
        return {
          id: waypoint.id,
          title: meta.title,
          subtitle: meta.subtitle,
          latitude: meta.latitude,
          longitude: meta.longitude
        };
      }),
    [orderedWaypoints]
  );

  const webMapHtml = useMemo(() => buildLeafletMapHtml(initialPoints), [initialPoints]);

  const nativeMapUrl = useMemo(() => {
    const initial = points[0] ?? { latitude: 40.211, longitude: -8.429 };
    const markers = points.map((point) => `${point.latitude},${point.longitude},lightblue1`).join('|');
    return `https://staticmap.openstreetmap.de/staticmap.php?center=${initial.latitude},${initial.longitude}&zoom=13&size=640x640&markers=${encodeURIComponent(markers)}`;
  }, [points]);

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
      for (const waypoint of orderedWaypoints) {
        await updateWaypointOrder(waypoint.id);
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
  badgeCard: {
    position: 'absolute',
    top: 14,
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
