import { clusterizeAddressPointsByMeters, groupByClusterId } from '@oliverbill/fastroute-domain';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { WebView } from 'react-native-webview';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { getWaypointMeta } from '../utils/waypointMeta';
import { getRouteDetails, listRouteWaypoints, updateWaypointOrder } from '../api/routesApi';
import { getApiError } from '../api/httpClient';
import { PrimaryButton } from '../components/PrimaryButton';
import { RouteStatus, Waypoint } from '../api/types';
import {
  applyWaypointOrder,
  cacheRouteWaypointOrder,
  getCachedRouteWaypointOrder
} from '../state/waypointOrderCache';

type Props = NativeStackScreenProps<RootStackParamList, 'Map'>;
const WebIFrame = 'iframe' as unknown as React.ComponentType<Record<string, unknown>>;

const ROUTE_COLORS = [
  '#2154B3',
  '#16A34A',
  '#E11D48',
  '#F59E0B',
  '#7C3AED',
  '#0EA5E9',
  '#14B8A6',
  '#DC2626',
  '#9333EA',
  '#2563EB'
];

type WaypointBadge = {
  waypointId: number;
  order: number;
  pointType?: string;
  wasReordered?: boolean;
  title: string;
  subtitle?: string;
};

type SingleMapPoint = {
  pointKey: string;
  waypointId: number;
  title: string;
  subtitle: string;
  latitude: number;
  longitude: number;
};

type ImportBasePoint = {
  pointKey: string;
  waypointId: number;
  routeId: number;
  seqOrder: number;
  title: string;
  subtitle: string;
  latitude: number;
  longitude: number;
};

type ImportDisplayPoint = ImportBasePoint & {
  routeLabel: string;
  color: string;
  orderInGroup: number;
};

type ImportLegendItem = {
  label: string;
  color: string;
  count: number;
};

function colorByIndex(index: number) {
  return ROUTE_COLORS[index % ROUTE_COLORS.length];
}

function buildLeafletSingleRouteHtml(points: SingleMapPoint[]) {
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
    .pin { width: 28px; height: 28px; border-radius: 14px; border: 2px solid #fff; color: #fff; display:flex; align-items:center; justify-content:center; font: 700 12px sans-serif; box-shadow: 0 1px 5px rgba(0,0,0,.4); }
  </style>
</head>
<body>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const points = ${payload};
    const orderedPointKeys = points.map((point) => point.pointKey);
    const movedPointKeys = new Set();
    const map = L.map('map', {
      zoomControl: true,
      attributionControl: true,
      doubleClickZoom: false
    });
    const markersLayer = L.layerGroup().addTo(map);
    let lastTapTimestamp = 0;
    let lastTapPointKey = '';

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
      const bg = wasReordered ? '#F59E0B' : (isStart ? '#A855F7' : (isEnd ? '#CC3D36' : '#2154B3'));
      return L.divIcon({
        className: '',
        html: '<div class="pin" style="background:' + bg + ';">' + order + '</div>',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });
    }

    function getOrder(pointKey) {
      return orderedPointKeys.findIndex((entry) => entry === pointKey) + 1;
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
        if (point.pointKey === draggedKey) {
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
        const targetKey = points[targetIndex]?.pointKey;
        if (!targetKey) {
          return { changed: false, targetKey: null };
        }

        const sourcePoint = points[fromIndex];
        const targetPoint = points[targetIndex];
        if (!sourcePoint || !targetPoint) {
          return { changed: false, targetKey: null };
        }

        const orderFromIndex = orderedPointKeys.findIndex((pointKey) => pointKey === draggedKey);
        const orderTargetIndex = orderedPointKeys.findIndex((pointKey) => pointKey === targetKey);
        if (orderFromIndex < 0 || orderTargetIndex < 0) {
          return { changed: false, targetKey: null };
        }

        const sourceOrderKey = orderedPointKeys[orderFromIndex];
        orderedPointKeys[orderFromIndex] = orderedPointKeys[orderTargetIndex];
        orderedPointKeys[orderTargetIndex] = sourceOrderKey;

        const sourceLat = sourcePoint.latitude;
        const sourceLng = sourcePoint.longitude;
        sourcePoint.latitude = targetPoint.latitude;
        sourcePoint.longitude = targetPoint.longitude;
        targetPoint.latitude = sourceLat;
        targetPoint.longitude = sourceLng;

        return { changed: true, targetKey };
      }

      return { changed: false, targetKey: null };
    }

    function findPointByLatLng(latLng) {
      let closestPoint = null;
      let minDistance = Infinity;

      points.forEach((point) => {
        const pointLatLng = L.latLng(point.latitude, point.longitude);
        const distance = pointLatLng.distanceTo(latLng);
        if (distance < minDistance) {
          minDistance = distance;
          closestPoint = point;
        }
      });

      return closestPoint;
    }

    function emitCurrentPointDetails(currentPoint) {
      const currentOrder = getOrder(currentPoint.pointKey);
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
    }

    function renderMap() {
      markersLayer.clearLayers();

      points.forEach((point) => {
        const order = getOrder(point.pointKey);
        const marker = L.marker([point.latitude, point.longitude], {
          icon: createIcon(point, order, points.length),
          draggable: true,
          autoPan: true
        }).addTo(markersLayer);

        marker.on('dragend', (event) => {
          const result = reorder(point.pointKey, event.target.getLatLng());
          if (result.changed) {
            movedPointKeys.add(point.pointKey);
            if (result.targetKey) {
              movedPointKeys.add(result.targetKey);
            }
          }
          renderMap();
        });

        marker.on('click', (event) => {
          const now = Date.now();
          if (lastTapPointKey === point.pointKey && now - lastTapTimestamp <= 350) {
            const markerLatLng = event.target.getLatLng();
            const currentPoint = findPointByLatLng(markerLatLng) || point;
            emitCurrentPointDetails(currentPoint);
            lastTapTimestamp = 0;
            lastTapPointKey = '';
            return;
          }

          lastTapTimestamp = now;
          lastTapPointKey = point.pointKey;
        });

        marker.on('dblclick', (event) => {
          const markerLatLng = event.target.getLatLng();
          const currentPoint = findPointByLatLng(markerLatLng) || point;
          emitCurrentPointDetails(currentPoint);
        });
      });

      const movedWaypointIds = [...new Set(
        points
          .filter((point) => movedPointKeys.has(point.pointKey))
          .map((point) => point.waypointId)
      )];
      emit({
        type: 'reorder',
        order: [...orderedPointKeys],
        movedWaypointIds
      });
    }

    applyViewport();
    renderMap();
  </script>
</body>
</html>`;
}

function buildLeafletImportRoutesHtml(points: ImportDisplayPoint[]) {
  const payload = JSON.stringify(
    points.map((point) => ({
      ...point
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
    .pin { width: 30px; height: 30px; border-radius: 15px; border: 2px solid #fff; color: #fff; display:flex; align-items:center; justify-content:center; font: 700 12px sans-serif; box-shadow: 0 1px 5px rgba(0,0,0,.4); }
  </style>
</head>
<body>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const points = ${payload};
    const map = L.map('map', {
      zoomControl: true,
      attributionControl: true,
      doubleClickZoom: false
    });
    const markersLayer = L.layerGroup().addTo(map);
    let lastTapTimestamp = 0;
    let lastTapPointKey = '';

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

    function createIcon(point) {
      return L.divIcon({
        className: '',
        html: '<div class="pin" style="background:' + point.color + ';">' + point.orderInGroup + '</div>',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
    }

    function emitCurrentPointDetails(point) {
      emit({
        type: 'waypoint_dblclick',
        waypointId: point.waypointId,
        pointKey: point.pointKey,
        order: point.orderInGroup,
        title: point.title,
        subtitle: point.subtitle || '',
        pointType: point.routeLabel,
        wasReordered: false
      });
    }

    function renderMap() {
      markersLayer.clearLayers();

      points.forEach((point) => {
        const marker = L.marker([point.latitude, point.longitude], {
          icon: createIcon(point),
          draggable: false
        }).addTo(markersLayer);

        marker.on('click', () => {
          const now = Date.now();
          if (lastTapPointKey === point.pointKey && now - lastTapTimestamp <= 350) {
            emitCurrentPointDetails(point);
            lastTapTimestamp = 0;
            lastTapPointKey = '';
            return;
          }

          lastTapTimestamp = now;
          lastTapPointKey = point.pointKey;
        });

        marker.on('dblclick', () => {
          emitCurrentPointDetails(point);
        });
      });
    }

    applyViewport();
    renderMap();
  </script>
</body>
</html>`;
}

function buildDisplayFromSourceRoutes(basePoints: ImportBasePoint[]) {
  const routeIds = [...new Set(basePoints.map((point) => point.routeId))].sort((a, b) => a - b);
  const colorByRoute = new Map<number, string>();
  routeIds.forEach((routeId, index) => {
    colorByRoute.set(routeId, colorByIndex(index));
  });

  const groupCounter = new Map<number, number>();
  const points: ImportDisplayPoint[] = basePoints.map((point) => {
    const currentOrder = (groupCounter.get(point.routeId) ?? 0) + 1;
    groupCounter.set(point.routeId, currentOrder);

    return {
      ...point,
      routeLabel: `Rota #${point.routeId}`,
      color: colorByRoute.get(point.routeId) ?? colorByIndex(0),
      orderInGroup: currentOrder
    };
  });

  const legend: ImportLegendItem[] = routeIds.map((routeId) => ({
    label: `Rota #${routeId}`,
    color: colorByRoute.get(routeId) ?? colorByIndex(0),
    count: points.filter((point) => point.routeId === routeId).length
  }));

  return { points, legend };
}

function buildDisplayFromRecalculatedEps(basePoints: ImportBasePoint[], epsMeters: number) {
  if (basePoints.length === 0) {
    return { points: [] as ImportDisplayPoint[], legend: [] as ImportLegendItem[] };
  }

  const clusteringResult =
    basePoints.length === 1
      ? {
          ok: true as const,
          value: [
            {
              address_id: basePoints[0].waypointId,
              lat: basePoints[0].latitude,
              longitude: basePoints[0].longitude,
              cluster_id: 1
            }
          ]
        }
      : clusterizeAddressPointsByMeters(
          basePoints.map((point) => ({
            address_id: point.waypointId,
            lat: point.latitude,
            longitude: point.longitude
          })),
          {
            epsMeters,
            minPts: 2
          }
        );

  if (!clusteringResult.ok) {
    throw new Error(clusteringResult.error);
  }

  const grouped = groupByClusterId(clusteringResult.value);
  const orderedGroups = Object.entries(grouped)
    .map(([clusterId, entries]) => ({
      clusterId: Math.trunc(Number(clusterId)),
      entries
    }))
    .filter((entry) => Array.isArray(entry.entries) && entry.entries.length > 0)
    .sort((a, b) => a.clusterId - b.clusterId);

  const groupIndexByWaypointId = new Map<number, number>();
  orderedGroups.forEach((group, groupIndex) => {
    group.entries.forEach((entry) => {
      groupIndexByWaypointId.set(entry.address_id, groupIndex);
    });
  });

  const orderCounterByGroup = new Map<number, number>();
  const countByGroup = new Map<number, number>();
  const points: ImportDisplayPoint[] = basePoints.map((point) => {
    const groupIndex = groupIndexByWaypointId.get(point.waypointId) ?? 0;
    const orderInGroup = (orderCounterByGroup.get(groupIndex) ?? 0) + 1;
    orderCounterByGroup.set(groupIndex, orderInGroup);
    countByGroup.set(groupIndex, (countByGroup.get(groupIndex) ?? 0) + 1);

    return {
      ...point,
      routeLabel: `Rota ${groupIndex + 1}`,
      color: colorByIndex(groupIndex),
      orderInGroup
    };
  });

  const legend = orderedGroups.map((_, groupIndex) => ({
    label: `Rota ${groupIndex + 1}`,
    color: colorByIndex(groupIndex),
    count: countByGroup.get(groupIndex) ?? 0
  }));

  return { points, legend };
}

export function MapScreen({ route, navigation }: Props) {
  const { waypoints } = route.params;
  const importRouteIds = useMemo(
    () =>
      [...new Set((route.params.routeIds ?? [])
        .map((value) => Math.trunc(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0))],
    [route.params.routeIds]
  );
  const importPreviewMode = importRouteIds.length > 1;

  const initialEps = useMemo(() => {
    const parsed = Math.trunc(Number(route.params.importEpsMeters));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
  }, [route.params.importEpsMeters]);

  const [mapWaypoints, setMapWaypoints] = useState<Waypoint[]>(() => {
    const cachedOrder = getCachedRouteWaypointOrder(route.params.routeId);
    return applyWaypointOrder(waypoints, cachedOrder);
  });
  const [mapRenderKey, setMapRenderKey] = useState(0);
  const [orderedPointKeys, setOrderedPointKeys] = useState<string[]>([]);
  const [movedWaypointIds, setMovedWaypointIds] = useState<number[]>([]);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [badge, setBadge] = useState<WaypointBadge | null>(null);
  const [routeStatus, setRouteStatus] = useState<RouteStatus | null>(route.params.routeStatus ?? null);

  const [importLoading, setImportLoading] = useState(importPreviewMode);
  const [importBasePoints, setImportBasePoints] = useState<ImportBasePoint[]>([]);
  const [importDisplayPoints, setImportDisplayPoints] = useState<ImportDisplayPoint[]>([]);
  const [importLegend, setImportLegend] = useState<ImportLegendItem[]>([]);
  const [importEpsInput, setImportEpsInput] = useState(String(initialEps));
  const [activeImportEps, setActiveImportEps] = useState(initialEps);

  useEffect(() => {
    if (importPreviewMode) {
      return;
    }
    const cachedOrder = getCachedRouteWaypointOrder(route.params.routeId);
    setMapWaypoints(applyWaypointOrder(waypoints, cachedOrder));
    setMapRenderKey((prev) => prev + 1);
  }, [importPreviewMode, route.params.routeId, waypoints]);

  useEffect(() => {
    if (importPreviewMode) {
      return;
    }

    let isMounted = true;

    const loadRouteStatus = async () => {
      try {
        const detail = await getRouteDetails(route.params.routeId);
        if (!isMounted) {
          return;
        }
        setRouteStatus(detail.status);
      } catch {
        if (!isMounted) {
          return;
        }
      }
    };

    loadRouteStatus();

    return () => {
      isMounted = false;
    };
  }, [importPreviewMode, route.params.routeId]);

  useEffect(() => {
    if (!importPreviewMode) {
      return;
    }

    let isMounted = true;
    setImportLoading(true);

    const loadImportPoints = async () => {
      try {
        const pointsByRoute = await Promise.all(
          importRouteIds.map(async (routeId) => {
            const routeWaypoints = await listRouteWaypoints(routeId, { forceRefresh: true });
            return {
              routeId,
              waypoints: routeWaypoints.sort((a, b) => a.seq_order - b.seq_order || a.id - b.id)
            };
          })
        );

        const basePoints: ImportBasePoint[] = pointsByRoute.flatMap((entry) =>
          entry.waypoints.map((waypoint, index) => {
            const meta = getWaypointMeta(waypoint);
            const fallbackDetailedAddress =
              typeof (waypoint as Waypoint & { detailed_address?: string }).detailed_address === 'string'
                ? (waypoint as Waypoint & { detailed_address?: string }).detailed_address?.trim()
                : '';
            return {
              pointKey: `r${entry.routeId}-wp${waypoint.id}`,
              waypointId: waypoint.id,
              routeId: entry.routeId,
              seqOrder: waypoint.seq_order || index + 1,
              title:
                waypoint.title?.trim() ||
                fallbackDetailedAddress ||
                meta.title ||
                `Waypoint #${waypoint.id}`,
              subtitle: meta.subtitle,
              latitude: meta.latitude,
              longitude: meta.longitude
            };
          })
        );

        if (!isMounted) {
          return;
        }

        setImportBasePoints(basePoints);
        setImportEpsInput(String(initialEps));
        setActiveImportEps(initialEps);

        const grouped = buildDisplayFromSourceRoutes(basePoints);
        setImportDisplayPoints(grouped.points);
        setImportLegend(grouped.legend);
        setMapRenderKey((prev) => prev + 1);
      } catch (error) {
        if (!isMounted) {
          return;
        }
        Alert.alert('Erro ao carregar rotas da importação', getApiError(error));
      } finally {
        if (isMounted) {
          setImportLoading(false);
        }
      }
    };

    loadImportPoints();

    return () => {
      isMounted = false;
    };
  }, [importPreviewMode, importRouteIds, initialEps]);

  const applyImportRecalculation = useCallback(
    (epsMeters: number) => {
      if (!importPreviewMode || importBasePoints.length === 0) {
        return;
      }

      try {
        const grouped = buildDisplayFromRecalculatedEps(importBasePoints, epsMeters);
        setImportDisplayPoints(grouped.points);
        setImportLegend(grouped.legend);
        setActiveImportEps(epsMeters);
        setMapRenderKey((prev) => prev + 1);
      } catch (error) {
        Alert.alert('Erro ao recalcular EPS', getApiError(error));
      }
    },
    [importBasePoints, importPreviewMode]
  );

  const onImportEpsChange = useCallback(
    (value: string) => {
      setImportEpsInput(value);
      const parsed = Math.trunc(Number(value));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return;
      }
      applyImportRecalculation(parsed);
    },
    [applyImportRecalculation]
  );

  const singleRoutePoints = useMemo<SingleMapPoint[]>(
    () =>
      mapWaypoints.map((waypoint) => {
        const meta = getWaypointMeta(waypoint);
        const fallbackDetailedAddress =
          typeof (waypoint as Waypoint & { detailed_address?: string }).detailed_address === 'string'
            ? (waypoint as Waypoint & { detailed_address?: string }).detailed_address?.trim()
            : '';
        const title =
          waypoint.title?.trim() ||
          fallbackDetailedAddress ||
          meta.title ||
          `Waypoint #${waypoint.id}`;
        return {
          pointKey: `pin-${waypoint.id}`,
          waypointId: waypoint.id,
          title,
          subtitle: meta.subtitle,
          latitude: meta.latitude,
          longitude: meta.longitude
        };
      }),
    [mapWaypoints]
  );

  const pointsByKey = useMemo(
    () => new Map(singleRoutePoints.map((point) => [point.pointKey, point])),
    [singleRoutePoints]
  );

  const orderedPoints = useMemo(() => {
    if (orderedPointKeys.length === 0) {
      return singleRoutePoints;
    }

    const usedKeys = new Set<string>();
    const reordered = orderedPointKeys
      .map((pointKey) => pointsByKey.get(pointKey))
      .filter((point): point is SingleMapPoint => Boolean(point))
      .map((point) => {
        usedKeys.add(point.pointKey);
        return point;
      });

    for (const point of singleRoutePoints) {
      if (!usedKeys.has(point.pointKey)) {
        reordered.push(point);
      }
    }

    return reordered;
  }, [orderedPointKeys, pointsByKey, singleRoutePoints]);

  useEffect(() => {
    if (importPreviewMode) {
      return;
    }
    setOrderedPointKeys(singleRoutePoints.map((point) => point.pointKey));
    setMovedWaypointIds([]);
  }, [importPreviewMode, singleRoutePoints]);

  const handleMapPayload = useCallback(
    (payload: Record<string, unknown> | null) => {
      if (!payload || payload.source !== 'fastroute-map') {
        return;
      }

      if (!importPreviewMode && payload.type === 'reorder' && Array.isArray(payload.order)) {
        const orderKeys = payload.order.map((entry) => String(entry));
        setOrderedPointKeys(orderKeys);
        if (Array.isArray(payload.movedWaypointIds)) {
          const changedIds = [
            ...new Set(
              payload.movedWaypointIds
                .map((entry) => Number(entry))
                .filter((entry) => Number.isFinite(entry))
            )
          ];
          setMovedWaypointIds(changedIds);
        }
      }

      if (payload.type === 'waypoint_dblclick') {
        const waypointId = Number(payload.waypointId);
        if (!Number.isFinite(waypointId)) {
          return;
        }

        const payloadOrder = Number(payload.order);
        const currentOrder = Number.isFinite(payloadOrder) ? payloadOrder : 0;
        const pointType = String(payload.pointType ?? '').trim() || 'Parada';
        const wasReordered =
          !importPreviewMode && (Boolean(payload.wasReordered) || movedWaypointIds.includes(waypointId));
        const title = String(payload.title ?? '').trim() || 'Waypoint';
        const rawSubtitle = String(payload.subtitle ?? '').trim();
        const subtitle = rawSubtitle.length > 0 ? rawSubtitle : undefined;

        setBadge({
          waypointId,
          order: currentOrder,
          pointType,
          wasReordered,
          title,
          subtitle
        });
      }
    },
    [importPreviewMode, movedWaypointIds]
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

  const webMapHtml = useMemo(
    () =>
      importPreviewMode
        ? buildLeafletImportRoutesHtml(importDisplayPoints)
        : buildLeafletSingleRouteHtml(singleRoutePoints),
    [importPreviewMode, importDisplayPoints, singleRoutePoints]
  );

  const forceEnableReorderActions = !importPreviewMode && route.params.forceEnableReorderActions === true;
  const canReorderRoute = forceEnableReorderActions || routeStatus === 'CRIADA';
  const reorderLockedByRouteStatus = !canReorderRoute;

  const onConfirmOrder = async () => {
    if (importPreviewMode) {
      return;
    }

    if (reorderLockedByRouteStatus) {
      Alert.alert('Ação indisponível', 'A ordem só pode ser alterada quando a rota estiver no status CRIADA.');
      return;
    }

    try {
      setConfirmLoading(true);
      const changedIds = [
        ...new Set(
          movedWaypointIds
            .map((value) => Math.trunc(Number(value)))
            .filter((value) => Number.isFinite(value))
        )
      ];
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
    if (importPreviewMode) {
      return;
    }

    if (reorderLockedByRouteStatus) {
      Alert.alert('Ação indisponível', 'A ordem só pode ser alterada quando a rota estiver no status CRIADA.');
      return;
    }

    try {
      setRestoreLoading(true);
      const waypointsFromDb = await listRouteWaypoints(route.params.routeId, { forceRefresh: true });
      const sortedWaypoints = [...waypointsFromDb].sort((a, b) => a.seq_order - b.seq_order);
      setMapWaypoints(sortedWaypoints);
      setMapRenderKey((prev) => prev + 1);
      setMovedWaypointIds([]);
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

  const mapKeySuffix = importPreviewMode
    ? `${importRouteIds.join('-')}-${activeImportEps}-${mapRenderKey}`
    : `${route.params.routeId}-${mapRenderKey}`;

  return (
    <View style={styles.screen}>
      <View style={styles.mapFull}>
        {Platform.OS === 'web' ? (
          <WebIFrame
            key={`web-map-${mapKeySuffix}`}
            srcDoc={webMapHtml}
            style={styles.webFrame}
            title="Mapa da rota"
          />
        ) : (
          <WebView
            key={`native-map-${mapKeySuffix}`}
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

        {importPreviewMode && importLoading ? (
          <View style={styles.importLoadingOverlay}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.importLoadingText}>Carregando rotas da importação...</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.routeHeader}>
        <Text style={styles.routeHeaderTitle}>
          {importPreviewMode ? `Importação (${importRouteIds.length} rotas)` : `Rota #${route.params.routeId}`}
        </Text>
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
          {!importPreviewMode && badge.wasReordered ? <Text style={styles.badgeChanged}>Waypoint reordenado</Text> : null}
        </View>
      ) : null}

      <View style={styles.bottomBar}>
        {importPreviewMode ? (
          <>
            <Text style={styles.bottomHint}>
              Rotas da importação por cor. Altere o EPS para recalcular os agrupamentos no mapa em tempo real.
            </Text>

            <View style={styles.epsRow}>
              <Text style={styles.epsLabel}>EPS (m)</Text>
              <TextInput
                value={importEpsInput}
                onChangeText={onImportEpsChange}
                keyboardType="number-pad"
                placeholder="Ex: 50"
                placeholderTextColor={colors.textSecondary}
                style={styles.epsInput}
              />
              <Text style={styles.epsApplied}>Atual: {activeImportEps}m</Text>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.legendRow}>
              {importLegend.map((item) => (
                <View key={item.label} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: item.color }]} />
                  <Text style={styles.legendText}>{item.label} ({item.count})</Text>
                </View>
              ))}
            </ScrollView>
          </>
        ) : (
          <>
            <Text style={styles.bottomHint}>
              Número do pin = ordem da rota. Lilás = Início, vermelho = Fim, laranja = reordenado.
            </Text>
            <View style={styles.bottomActions}>
              <PrimaryButton
                label="Restaurar"
                variant="neutral"
                onPress={onRestoreOriginalOrder}
                loading={restoreLoading}
                disabled={confirmLoading || reorderLockedByRouteStatus}
                style={styles.bottomActionButton}
              />
              <PrimaryButton
                label="Confirmar ordem"
                onPress={onConfirmOrder}
                loading={confirmLoading}
                disabled={restoreLoading || reorderLockedByRouteStatus}
                style={styles.bottomActionButton}
              />
            </View>
          </>
        )}
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
  importLoadingOverlay: {
    position: 'absolute',
    top: '45%',
    left: 16,
    right: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.96)',
    paddingVertical: 14,
    alignItems: 'center',
    gap: 8
  },
  importLoadingText: {
    color: colors.textPrimary,
    fontWeight: '700'
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
  },
  epsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10
  },
  epsLabel: {
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 12
  },
  epsInput: {
    minWidth: 78,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.textPrimary,
    fontWeight: '700',
    backgroundColor: colors.card
  },
  epsApplied: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700'
  },
  legendRow: {
    gap: 8,
    paddingRight: 8
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.card,
    gap: 6
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5
  },
  legendText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '700'
  }
});
