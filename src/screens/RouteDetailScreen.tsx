import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import {
  finishRoute,
  getRouteDetails,
  listRouteWaypoints,
  startRoute
} from '../api/routesApi';
import { getApiError } from '../api/httpClient';
import { RouteDetail, Waypoint } from '../api/types';
import { StatusBadge } from '../components/StatusBadge';
import { getWaypointMeta } from '../utils/waypointMeta';
import { PrimaryButton } from '../components/PrimaryButton';

type Props = NativeStackScreenProps<RootStackParamList, 'RouteDetail'>;

export function RouteDetailScreen({ route, navigation }: Props) {
  const { routeId } = route.params;
  const [routeDetail, setRouteDetail] = useState<RouteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadRouteDetails = useCallback(async () => {
    try {
      const data = await getRouteDetails(routeId);
      if (data.waypoints && data.waypoints.length > 0) {
        setRouteDetail(data);
        return;
      }

      const waypoints = await listRouteWaypoints(routeId);
      setRouteDetail({
        ...data,
        waypoints
      });
    } catch (error) {
      Alert.alert('Erro ao carregar rota', getApiError(error));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [routeId]);

  useFocusEffect(
    useCallback(() => {
      loadRouteDetails();
    }, [loadRouteDetails])
  );

  const waypoints = routeDetail?.waypoints ?? [];

  const canFinalize = useMemo(
    () => waypoints.length === 0 || waypoints.every((waypoint) => waypoint.status === 'CONCLUIDO'),
    [waypoints]
  );

  const onStartRoute = async () => {
    try {
      setSaving(true);
      await startRoute(routeId);
      await loadRouteDetails();
      Alert.alert('Rota iniciada', `Rota #${routeId} iniciada com sucesso.`);
    } catch (error) {
      Alert.alert('Erro ao iniciar rota', getApiError(error));
    } finally {
      setSaving(false);
    }
  };

  const onFinalize = async () => {
    try {
      setSaving(true);
      await finishRoute(routeId);
      Alert.alert('Finalização enviada', `Solicitação de finalização da rota #${routeId} enviada.`);
      navigation.goBack();
    } catch (error) {
      Alert.alert('Erro ao finalizar rota', getApiError(error));
    } finally {
      setSaving(false);
    }
  };

  const onWaypointPress = (waypoint: Waypoint) => {
    navigation.navigate('Delivery', {
      routeId,
      waypoint
    });
  };

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => {
        setRefreshing(true);
        loadRouteDetails();
      }} />}
    >
      {loading ? (
        <View style={styles.loaderContainer}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <>
          <View style={styles.summaryCard}>
            <View style={styles.summaryHeader}>
              <Text style={styles.summaryTitle}>Rota #{routeId}</Text>
              <StatusBadge status={routeDetail?.status ?? 'PENDENTE'} type="route" />
            </View>

            <View style={styles.metaGrid}>
              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Entregas</Text>
                <Text style={styles.metaValue}>{waypoints.length}</Text>
              </View>
              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Cluster</Text>
                <Text style={styles.metaValue}>{routeDetail?.cluster_id ?? '-'}</Text>
              </View>
            </View>

            <View style={styles.actionsRow}>
              <PrimaryButton
                label="Ver no mapa"
                variant="neutral"
                onPress={() => navigation.navigate('Map', { routeId, waypoints })}
                style={styles.flexButton}
              />
              <PrimaryButton
                label="Iniciar"
                onPress={onStartRoute}
                loading={saving}
                style={styles.flexButton}
              />
            </View>
          </View>

          <Text style={styles.sectionTitle}>Paradas</Text>

          {waypoints.map((waypoint) => {
            const meta = getWaypointMeta(waypoint);

            return (
              <TouchableOpacity
                key={waypoint.id}
                style={styles.waypointCard}
                onPress={() => onWaypointPress(waypoint)}
              >
                <View style={styles.waypointTop}>
                  <View style={styles.idBubble}>
                    <Text style={styles.idBubbleText}>#{waypoint.seq_order}</Text>
                  </View>
                  <View style={styles.waypointTextColumn}>
                    <Text style={styles.waypointTitle}>{meta.title}</Text>
                    <Text style={styles.waypointSub}>{meta.subtitle}</Text>
                  </View>
                  <StatusBadge status={waypoint.status} type="waypoint" />
                </View>
              </TouchableOpacity>
            );
          })}

          <PrimaryButton
            label="Finalizar rota"
            variant={canFinalize ? 'success' : 'danger'}
            onPress={onFinalize}
            loading={saving}
            style={styles.finalButton}
          />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 28
  },
  loaderContainer: {
    paddingVertical: 40,
    alignItems: 'center'
  },
  summaryCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderColor: colors.border,
    borderWidth: 1,
    padding: 14,
    gap: 12
  },
  summaryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  summaryTitle: {
    color: colors.textPrimary,
    fontWeight: '800',
    fontSize: 18
  },
  metaGrid: {
    flexDirection: 'row',
    gap: 10
  },
  metaItem: {
    flex: 1,
    borderRadius: 10,
    borderColor: colors.border,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12
  },
  metaLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600'
  },
  metaValue: {
    marginTop: 2,
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700'
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10
  },
  flexButton: {
    flex: 1
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 16
  },
  waypointCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderColor: colors.border,
    borderWidth: 1,
    padding: 10
  },
  waypointTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  idBubble: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#EFF4FF',
    alignItems: 'center',
    justifyContent: 'center'
  },
  idBubbleText: {
    color: colors.primary,
    fontWeight: '800'
  },
  waypointTextColumn: {
    flex: 1
  },
  waypointTitle: {
    color: colors.textPrimary,
    fontWeight: '700'
  },
  waypointSub: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2
  },
  finalButton: {
    marginTop: 8
  }
});
