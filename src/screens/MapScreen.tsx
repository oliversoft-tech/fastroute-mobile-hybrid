import { useEffect, useMemo, useState } from 'react';
import { Alert, Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { getWaypointMeta } from '../utils/waypointMeta';
import { startRoute, updateWaypointOrder } from '../api/routesApi';
import { Waypoint } from '../api/types';
import { getApiError } from '../api/httpClient';
import { PrimaryButton } from '../components/PrimaryButton';
import { GOOGLE_MAPS_API_KEY } from '../config/maps';

type Props = NativeStackScreenProps<RootStackParamList, 'Map'>;

export function MapScreen({ route }: Props) {
  const { waypoints } = route.params;
  const [orderedWaypoints, setOrderedWaypoints] = useState<Waypoint[]>([]);
  const [loading, setLoading] = useState(false);

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

  const mapUrl = useMemo(() => {
    const initial = points[0]?.meta ?? { latitude: 40.211, longitude: -8.429 };
    const markers = points
      .map(({ meta }) => `${meta.latitude},${meta.longitude},lightblue1`)
      .join('|');
    return `https://staticmap.openstreetmap.de/staticmap.php?center=${initial.latitude},${initial.longitude}&zoom=13&size=640x640&markers=${encodeURIComponent(markers)}`;
  }, [points]);

  const reorderWaypoint = (currentIndex: number, direction: -1 | 1) => {
    setOrderedWaypoints((current) => {
      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(currentIndex, 1);
      next.splice(nextIndex, 0, moved);

      return next.map((waypoint, index) => ({
        ...waypoint,
        seq_order: index + 1
      }));
    });
  };

  const openGoogleMapsDirections = async () => {
    if (points.length === 0) {
      return;
    }

    const coordinates = points.map(({ meta }) => `${meta.latitude},${meta.longitude}`);
    let mapsUrl = '';

    if (coordinates.length === 1) {
      mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coordinates[0])}`;
      if (GOOGLE_MAPS_API_KEY) {
        mapsUrl = `${mapsUrl}&key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}`;
      }
    } else {
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

      if (GOOGLE_MAPS_API_KEY) {
        params.push(`key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}`);
      }

      mapsUrl = `https://www.google.com/maps/dir/?${params.join('&')}`;
    }

    const canOpen = await Linking.canOpenURL(mapsUrl);
    if (!canOpen) {
      throw new Error('Não foi possível abrir o Google Maps neste dispositivo.');
    }

    await Linking.openURL(mapsUrl);
  };

  const startRouteAndNavigate = async () => {
    try {
      setLoading(true);
      await startRoute(route.params.routeId);
      await openGoogleMapsDirections();
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
    <ScrollView contentContainerStyle={styles.container}>
      <Image source={{ uri: mapUrl }} style={styles.map} resizeMode="cover" />

      <View style={styles.legend}>
        <Text style={styles.legendTitle}>Paradas da rota</Text>
        {points.map(({ waypoint, meta }, index) => (
          <View key={waypoint.id} style={styles.stopRow}>
            <View style={styles.stopTextColumn}>
              <Text style={styles.stopTitle}>#{index + 1} • {meta.title}</Text>
              <Text style={styles.stopSub}>{meta.subtitle}</Text>
            </View>
            <View style={styles.controls}>
              <Pressable
                style={[styles.controlButton, index === 0 && styles.controlButtonDisabled]}
                disabled={index === 0 || loading}
                onPress={() => reorderWaypoint(index, -1)}
              >
                <Text style={styles.controlText}>↑</Text>
              </Pressable>
              <Pressable
                style={[styles.controlButton, index === points.length - 1 && styles.controlButtonDisabled]}
                disabled={index === points.length - 1 || loading}
                onPress={() => reorderWaypoint(index, 1)}
              >
                <Text style={styles.controlText}>↓</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </View>

      <PrimaryButton
        label="Confirmar ordem"
        onPress={onConfirmOrder}
        loading={loading}
        disabled={orderedWaypoints.length === 0}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.background,
    padding: 12,
    gap: 10,
    paddingBottom: 20
  },
  map: {
    height: 330,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#dde8ff'
  },
  legend: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: 12,
    gap: 8
  },
  legendTitle: {
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: 6
  },
  stopRow: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
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
  }
});
