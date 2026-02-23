import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { WebView } from 'react-native-webview';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { getWaypointMeta } from '../utils/waypointMeta';
import { listRouteWaypoints, updateWaypointOrder } from '../api/routesApi';
import { getApiError } from '../api/httpClient';
import { PrimaryButton } from '../components/PrimaryButton';
import { Waypoint } from '../api/types';
import {
  applyWaypointOrder,
  cacheRouteWaypointOrder,
  getCachedRouteWaypointOrder
} from '../state/waypointOrderCache';

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
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    function emit(payload) {
      const message = { source: 'fastroute-map', ...payload };
      if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
        return;
      }
      if (window.parent && typeof window.parent.postMessage === 'function') {
        window.parent.postMessage(message, '*');
      }
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
        const source = points[fromIndex];
        points[fromIndex] = points[targetIndex];
        points[targetIndex] = source;
        return { changed: true, targetKey };
      }

      return { changed: false, targetKey: null };
    }

    function renderMap() {
      markersLayer.clearLayers();

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
        });

        marker.on('dblclick', () => {
          const currentIndex = points.findIndex((currentPoint) => currentPoint.pointKey === point.pointKey);
          const currentPoint = currentIndex >= 0 ? points[currentIndex] : point;
          const currentOrder = currentIndex >= 0 ? currentIndex + 1 : order;
          const currentIsStart = currentOrder === 1;
          const currentIsEnd = currentOrder === points.length && points.length > 1;
          const currentPointType = currentIsStart ? 'Início' : (currentIsEnd ? 'Fim' : 'Parada');
          const currentReordered = movedPointKeys.has(currentPoint.pointKey);
          emit({
            type: 'waypoint_dblclick',
            waypointId: currentPoint.waypointId,
            pointKey: currentPoint.pointKey,
            order: currentOrder,
            title: currentPoint.title,
            subtitle: currentPoint.subtitle || '',
            pointType: currentPointType,
            wasReordered: currentReordered
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

export function MapScreen({ route, navigation }: Props) {
  const { waypoints } = route.params;
  const [mapWaypoints, setMapWaypoints] = useState<Waypoint[]>(() => {
    const cachedOrder = getCachedRouteWaypointOrder(route.params.routeId);
    return applyWaypointOrder(waypoints, cachedOrder);
  });
  const [mapRenderKey, setMapRenderKey] = useState(0);
  const [orderedPointKeys, setOrderedPointKeys] = useState<string[]>([]);
  const [movedWaypointIds, setMovedWaypointIds] = useState<number[]>([]);
  const [confirmDisabled, setConfirmDisabled] = useState(true);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [badge, setBadge] = useState<WaypointBadge | null>(null);

  useEffect(() => {
    const cachedOrder = getCachedRouteWaypointOrder(route.params.routeId);
    setMapWaypoints(applyWaypointOrder(waypoints, cachedOrder));
    setMapRenderKey((prev) => prev + 1);
  }, [route.params.routeId, waypoints]);

  const initialPoints = useMemo(
    () =>
      mapWaypoints.map((waypoint) => {
        const meta = getWaypointMeta(waypoint);
        return {
          pointKey: `pin-${waypoint.id}`,
          waypoint,
          waypointId: waypoint.id,
          title: meta.title,
          subtitle: meta.subtitle,
          latitude: meta.latitude,
          longitude: meta.longitude
        };
      }),
    [mapWaypoints]
  );

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

  useEffect(() => {
    setOrderedPointKeys(initialPoints.map((point) => point.pointKey));
    setMovedWaypointIds([]);
    setConfirmDisabled(true);
  }, [initialPoints]);

  const handleMapPayload = useCallback((payload: Record<string, unknown> | null) => {
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
        setConfirmDisabled(changedIds.length === 0);
      }
    }

    if (payload.type === 'waypoint_dblclick') {
      const waypointId = Number(payload.waypointId);
      if (!Number.isFinite(waypointId)) {
        return;
      }

      const currentPoint = orderedPoints.find((point) => point.waypointId === waypointId);
      const currentOrder = orderedPoints.findIndex((point) => point.waypointId === waypointId) + 1;
      const isStart = currentOrder === 1;
      const isEnd = currentOrder === orderedPoints.length && orderedPoints.length > 1;
      const pointType = isStart ? 'Início' : (isEnd ? 'Fim' : 'Parada');
      const wasReordered = movedWaypointIds.includes(waypointId);
      const title = currentPoint?.title?.trim() || String(payload.title ?? '').trim() || 'Waypoint';
      const subtitle =
        currentPoint?.subtitle?.trim() || String(payload.subtitle ?? '').trim() || undefined;

      setBadge({
        waypointId,
        order: currentOrder > 0 ? currentOrder : Number(payload.order ?? 0),
        pointType,
        wasReordered,
        title,
        subtitle
      });
    }
  }, [movedWaypointIds, orderedPoints]);

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
      handleMapPayload(payload);
    };

    browser.addEventListener?.('message', onMessage);

    return () => {
      browser.removeEventListener?.('message', onMessage);
    };
  }, [handleMapPayload]);

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

  const onConfirmOrder = async () => {
    setConfirmDisabled(true);
    try {
      setConfirmLoading(true);
      const changedIds = [...new Set(
        movedWaypointIds
          .map((value) => Math.trunc(Number(value)))
          .filter((value) => Number.isFinite(value))
      )];
      const changedSet = new Set(changedIds);
      const reorderedWaypoints = orderedPoints
        .map((point, index) => ({
          seqorder: index + 1,
          waypoint_id: point.waypointId
        }))
        .filter((entry) => changedSet.has(entry.waypoint_id));

      if (reorderedWaypoints.length > 0) {
        await updateWaypointOrder({
          routeId: route.params.routeId,
          reorderedWaypoints
        });
      }

      cacheRouteWaypointOrder(
        route.params.routeId,
        orderedPoints.map((point) => point.waypointId)
      );
      navigation.replace('RouteDetail', { routeId: route.params.routeId, refreshAt: Date.now() });
    } catch (error) {
      Alert.alert('Erro ao confirmar ordem', getApiError(error));
    } finally {
      setConfirmLoading(false);
    }
  };

  const onRestoreOriginalOrder = async () => {
    try {
      setRestoreLoading(true);
      const waypointsFromDb = await listRouteWaypoints(route.params.routeId);
      const sortedWaypoints = [...waypointsFromDb].sort((a, b) => a.seq_order - b.seq_order);
      setMapWaypoints(sortedWaypoints);
      setMapRenderKey((prev) => prev + 1);
      setMovedWaypointIds([]);
      setConfirmDisabled(true);
      setBadge(null);
      cacheRouteWaypointOrder(
        route.params.routeId,
        sortedWaypoints.map((waypoint) => waypoint.id)
      );
    } catch (error) {
      Alert.alert('Erro ao restaurar ordem', getApiError(error));
    } finally {
      setRestoreLoading(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.mapFull}>
        {Platform.OS === 'web' ? (
          <WebIFrame
            key={`web-map-${route.params.routeId}-${mapRenderKey}`}
            srcDoc={webMapHtml}
            style={styles.webFrame}
            title="Mapa da rota"
          />
        ) : (
          <WebView
            key={`native-map-${route.params.routeId}-${mapRenderKey}`}
            originWhitelist={['*']}
            source={{ html: webMapHtml }}
            style={styles.webFrame}
            javaScriptEnabled
            domStorageEnabled
            onMessage={(event) => {
              const raw = event.nativeEvent.data;
              if (typeof raw !== 'string' || raw.trim().length === 0) {
                return;
              }

              try {
                const payload = JSON.parse(raw) as Record<string, unknown>;
                handleMapPayload(payload);
              } catch {
                // ignora mensagens inválidas
              }
            }}
          />
        )}
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
        <View style={styles.bottomActions}>
          <PrimaryButton
            label="Restaurar"
            variant="neutral"
            onPress={onRestoreOriginalOrder}
            loading={restoreLoading}
            disabled={confirmLoading}
            style={styles.bottomActionButton}
          />
          <PrimaryButton
            label="Confirmar ordem"
            onPress={onConfirmOrder}
            loading={confirmLoading}
            disabled={confirmDisabled || restoreLoading}
            style={styles.bottomActionButton}
          />
        </View>
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
  routeHeader: {
    position: 'absolute',
    top: 14,
    right: 14,
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
  },
  bottomActions: {
    flexDirection: 'row',
    gap: 8
  },
  bottomActionButton: {
    flex: 1
  }
});
