import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
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

  return (
    <View style={styles.container}>
      <View style={[styles.map, styles.webFallback]}>
        <Text style={styles.webFallbackTitle}>Preview de mapa indisponivel no Web</Text>
        <Text style={styles.webFallbackSub}>Abra no Android/iOS para visualizar o mapa nativo.</Text>
      </View>

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
    overflow: 'hidden'
  },
  webFallback: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16
  },
  webFallbackTitle: {
    color: colors.textPrimary,
    fontWeight: '700'
  },
  webFallbackSub: {
    color: colors.textSecondary,
    marginTop: 6,
    textAlign: 'center'
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
