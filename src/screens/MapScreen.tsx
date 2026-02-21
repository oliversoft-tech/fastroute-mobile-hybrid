import { useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { getWaypointMeta } from '../utils/waypointMeta';

type Props = NativeStackScreenProps<RootStackParamList, 'Map'>;

export function MapScreen({ route }: Props) {
  const { waypoints } = route.params;

  const points = useMemo(
    () =>
      waypoints.map((waypoint) => ({
        waypoint,
        meta: getWaypointMeta(waypoint.address_id, waypoint.id)
      })),
    [waypoints]
  );

  const mapUrl = useMemo(() => {
    const initial = points[0]?.meta ?? { latitude: 40.211, longitude: -8.429 };
    const markers = points
      .map(({ meta }) => `${meta.latitude},${meta.longitude},lightblue1`)
      .join('|');
    return `https://staticmap.openstreetmap.de/staticmap.php?center=${initial.latitude},${initial.longitude}&zoom=13&size=640x640&markers=${encodeURIComponent(markers)}`;
  }, [points]);

  return (
    <View style={styles.container}>
      <Image source={{ uri: mapUrl }} style={styles.map} resizeMode="cover" />

      <View style={styles.legend}>
        <Text style={styles.legendTitle}>Paradas da rota</Text>
        {points.map(({ waypoint, meta }) => (
          <Text key={waypoint.id} style={styles.legendItem}>
            #{waypoint.seq_order} • {meta.title}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: 12,
    gap: 10
  },
  map: {
    flex: 1,
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
    maxHeight: 180
  },
  legendTitle: {
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: 6
  },
  legendItem: {
    color: colors.textSecondary,
    marginTop: 2
  }
});
