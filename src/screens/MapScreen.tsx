import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native';
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
const WebDiv = 'div' as unknown as React.ComponentType<Record<string, unknown>>;

function buildLeafletMapHtml(
  points: Array<{ title: string; subtitle: string; latitude: number; longitude: number }>
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
    .pin-wrap { width: 26px; height: 26px; border-radius: 13px; background: #2154b3; color: #fff; border: 2px solid #fff; display: flex; align-items: center; justify-content: center; font: 700 12px sans-serif; box-shadow: 0 1px 4px rgba(0,0,0,.35); }
  </style>
</head>
<body>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const points = ${payload};
    const map = L.map('map', { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    const bounds = [];
    points.forEach((point) => {
      const icon = L.divIcon({
        className: '',
        html: '<div class="pin-wrap">' + point.order + '</div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13]
      });
      const marker = L.marker([point.latitude, point.longitude], { icon }).addTo(map);
      const subtitle = point.subtitle ? ('<br/>' + point.subtitle) : '';
      marker.bindPopup('<b>' + point.title + '</b>' + subtitle);
      bounds.push([point.latitude, point.longitude]);
    });

    if (bounds.length === 0) {
      map.setView([40.211, -8.429], 13);
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 15);
    } else {
      map.fitBounds(bounds, { padding: [30, 30] });
    }
  </script>
</body>
</html>`;
}

export function MapScreen({ route }: Props) {
  const { waypoints } = route.params;
  const [orderedWaypoints, setOrderedWaypoints] = useState<Waypoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [mapLoadError, setMapLoadError] = useState(false);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  useEffect(() => {
    const initial = [...waypoints].sort((a, b) => a.seq_order - b.seq_order);
    setOrderedWaypoints(initial);
  }, [waypoints]);

  const points = useMemo(
    () =>
      orderedWaypoints.map((waypoint) => ({
        waypoint,
        meta: getWaypointMeta(waypoint)
      })),
    [orderedWaypoints]
  );

  const nativeMapUrl = useMemo(() => {
    const initial = points[0]?.meta ?? { latitude: 40.211, longitude: -8.429 };
    const markers = points
      .map(({ meta }) => `${meta.latitude},${meta.longitude},lightblue1`)
      .join('|');
    return `https://staticmap.openstreetmap.de/staticmap.php?center=${initial.latitude},${initial.longitude}&zoom=13&size=640x640&markers=${encodeURIComponent(markers)}`;
  }, [points]);

  const webMapHtml = useMemo(
    () =>
      buildLeafletMapHtml(
        points.map(({ meta }) => ({
          title: meta.title,
          subtitle: meta.subtitle,
          latitude: meta.latitude,
          longitude: meta.longitude
        }))
      ),
    [points]
  );

  const reorderAt = (fromIndex: number, toIndex: number) => {
    setOrderedWaypoints((current) => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= current.length ||
        toIndex >= current.length
      ) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next.map((waypoint, index) => ({
        ...waypoint,
        seq_order: index + 1
      }));
    });
  };

  const onNativeMove = (currentIndex: number, direction: -1 | 1) => {
    const targetIndex = currentIndex + direction;
    reorderAt(currentIndex, targetIndex);
  };

  const onWebDragStart = (index: number) => (event: unknown) => {
    setDraggingIndex(index);
    const dragEvent = event as { dataTransfer?: { setData: (type: string, value: string) => void } };
    dragEvent.dataTransfer?.setData('text/plain', String(index));
  };

  const onWebDragOver = (event: unknown) => {
    const dragEvent = event as { preventDefault?: () => void };
    dragEvent.preventDefault?.();
  };

  const onWebDrop = (targetIndex: number) => (event: unknown) => {
    const dragEvent = event as {
      preventDefault?: () => void;
      dataTransfer?: { getData: (type: string) => string };
    };
    dragEvent.preventDefault?.();
    const sourceFromState = draggingIndex;
    const sourceFromTransfer = Number(dragEvent.dataTransfer?.getData('text/plain'));
    const sourceIndex = Number.isInteger(sourceFromState ?? NaN)
      ? (sourceFromState as number)
      : sourceFromTransfer;
    reorderAt(sourceIndex, targetIndex);
    setDraggingIndex(null);
  };

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
            <PrimaryButton
              label="Abrir rota no Google Maps"
              onPress={() => {
                void openDirections();
              }}
              style={styles.fallbackButton}
            />
          </View>
        ) : null}
      </View>

      <View style={styles.overlayPanel}>
        <View style={styles.overlayHandle} />
        <Text style={styles.overlayTitle}>Paradas da rota</Text>
        <Text style={styles.overlayHint}>Arraste e solte para reordenar</Text>

        {Platform.OS === 'web' ? (
          <WebDiv style={webStyles.list}>
            {points.map(({ waypoint, meta }, index) => (
              <WebDiv
                key={waypoint.id}
                draggable={!loading}
                onDragStart={onWebDragStart(index)}
                onDragOver={onWebDragOver}
                onDrop={onWebDrop(index)}
                style={{
                  ...webStyles.row,
                  ...(draggingIndex === index ? webStyles.rowDragging : {})
                }}
              >
                <WebDiv style={webStyles.badge}>{index + 1}</WebDiv>
                <WebDiv style={webStyles.texts}>
                  <WebDiv style={webStyles.title}>{meta.title}</WebDiv>
                  {meta.subtitle ? <WebDiv style={webStyles.subtitle}>{meta.subtitle}</WebDiv> : null}
                </WebDiv>
              </WebDiv>
            ))}
          </WebDiv>
        ) : (
          <ScrollView style={styles.nativeList} contentContainerStyle={styles.nativeListContent}>
            {points.map(({ waypoint, meta }, index) => (
              <View key={waypoint.id} style={styles.stopRow}>
                <View style={styles.stopTextColumn}>
                  <Text style={styles.stopTitle}>#{index + 1} • {meta.title}</Text>
                  {meta.subtitle ? <Text style={styles.stopSub}>{meta.subtitle}</Text> : null}
                </View>
                <View style={styles.controls}>
                  <Pressable
                    style={[styles.controlButton, index === 0 && styles.controlButtonDisabled]}
                    disabled={index === 0 || loading}
                    onPress={() => onNativeMove(index, -1)}
                  >
                    <Text style={styles.controlText}>↑</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.controlButton,
                      index === points.length - 1 && styles.controlButtonDisabled
                    ]}
                    disabled={index === points.length - 1 || loading}
                    onPress={() => onNativeMove(index, 1)}
                  >
                    <Text style={styles.controlText}>↓</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </ScrollView>
        )}

        <PrimaryButton
          label="Confirmar ordem"
          onPress={onConfirmOrder}
          loading={loading}
          disabled={orderedWaypoints.length === 0}
          style={styles.confirmButton}
        />
      </View>
    </View>
  );
}

const webStyles = {
  list: {
    maxHeight: '40vh',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  },
  row: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: '10px',
    border: `1px solid ${colors.border}`,
    borderRadius: '10px',
    padding: '10px',
    background: '#fff',
    cursor: 'grab'
  },
  rowDragging: {
    opacity: 0.45
  },
  badge: {
    width: '24px',
    height: '24px',
    borderRadius: '999px',
    background: colors.primary,
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 800,
    fontSize: '11px',
    flexShrink: 0
  },
  texts: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0
  },
  title: {
    color: colors.textPrimary,
    fontWeight: 700,
    fontSize: '14px'
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: '12px',
    marginTop: '2px'
  }
} as const;

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
  fallbackButton: {
    marginTop: 12
  },
  overlayPanel: {
    marginTop: 'auto',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.96)',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 8,
    maxHeight: '58%'
  },
  overlayHandle: {
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#CBD5E9',
    alignSelf: 'center'
  },
  overlayTitle: {
    color: colors.textPrimary,
    fontWeight: '800',
    fontSize: 15
  },
  overlayHint: {
    color: colors.textSecondary,
    fontSize: 12,
    marginBottom: 2
  },
  nativeList: {
    maxHeight: 250
  },
  nativeListContent: {
    gap: 8,
    paddingBottom: 4
  },
  stopRow: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fff'
  },
  stopTextColumn: {
    flex: 1
  },
  stopTitle: {
    color: colors.textPrimary,
    fontWeight: '700'
  },
  stopSub: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2
  },
  controls: {
    gap: 6
  },
  controlButton: {
    width: 34,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff'
  },
  controlButtonDisabled: {
    opacity: 0.45
  },
  controlText: {
    color: colors.textPrimary,
    fontWeight: '800',
    fontSize: 14
  },
  confirmButton: {
    marginTop: 2
  }
});
