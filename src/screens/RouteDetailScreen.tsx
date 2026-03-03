import { useCallback, useEffect, useRef, useState } from 'react';
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
  getRouteDetails,
  listRouteWaypoints,
  startRoute
} from '../api/routesApi';
import { getApiError } from '../api/httpClient';
import { RouteDetail, Waypoint } from '../api/types';
import { StatusBadge } from '../components/StatusBadge';
import { getWaypointMeta } from '../utils/waypointMeta';
import { PrimaryButton } from '../components/PrimaryButton';
import { formatDate } from '../utils/date';
import { openGoogleMapsRoute } from '../utils/googleMaps';
import { applyWaypointOrder, getCachedRouteWaypointOrder } from '../state/waypointOrderCache';

type Props = NativeStackScreenProps<RootStackParamList, 'RouteDetail'>;
const startedRouteIdsLock = new Set<number>();

function normalizeRouteStatus(value: string | undefined | null) {
  return String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function isRouteInProgress(normalizedStatus: string) {
  return (
    normalizedStatus.includes('EM_ROTA') ||
    normalizedStatus.includes('EM ANDAMENTO') ||
    normalizedStatus.includes('EM_ANDAMENTO') ||
    normalizedStatus.includes('ANDAMENTO')
  );
}

export function RouteDetailScreen({ route, navigation }: Props) {
  const { routeId, refreshAt } = route.params;
  const [routeDetail, setRouteDetail] = useState<RouteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [startLocked, setStartLocked] = useState(() => startedRouteIdsLock.has(routeId));
  const startRouteInFlightRef = useRef(false);
  const loadRequestRef = useRef(0);

  const loadRouteDetails = useCallback(async (options?: { forceRefresh?: boolean }) => {
    const requestId = ++loadRequestRef.current;
    if (!options?.forceRefresh) {
      setLoading(true);
    }

    try {
      const cachedOrder = getCachedRouteWaypointOrder(routeId);
      const [detailResult, waypointsResult] = await Promise.allSettled([
        getRouteDetails(routeId, { forceRefresh: options?.forceRefresh }),
        listRouteWaypoints(routeId, { forceRefresh: options?.forceRefresh })
      ]);

      if (requestId !== loadRequestRef.current) {
        return;
      }

      if (detailResult.status !== 'fulfilled') {
        throw detailResult.reason;
      }

      const detailData = detailResult.value;
      const baseWaypoints =
        waypointsResult.status === 'fulfilled' && waypointsResult.value.length > 0
          ? waypointsResult.value
          : (detailData.waypoints ?? []);
      const orderedWaypoints = applyWaypointOrder(baseWaypoints, cachedOrder);
      setRouteDetail({
        ...detailData,
        waypoints_count: orderedWaypoints.length,
        waypoints: orderedWaypoints
      });
    } catch (error) {
      if (requestId !== loadRequestRef.current) {
        return;
      }
      setRouteDetail(null);
      Alert.alert('Erro ao carregar rota', getApiError(error));
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [routeId, refreshAt]);

  useFocusEffect(
    useCallback(() => {
      loadRouteDetails();
    }, [loadRouteDetails])
  );

  useEffect(() => {
    setRouteDetail(null);
    setLoading(true);
    setRefreshing(false);
    setStartLocked(startedRouteIdsLock.has(routeId));
  }, [routeId]);

  const waypoints = routeDetail?.waypoints ?? [];
  const normalizedRouteStatus = normalizeRouteStatus(routeDetail?.status);
  const isRouteConcludedOrCanceled = normalizedRouteStatus.includes('FINALIZ') || normalizedRouteStatus.includes('CONCLUID') || normalizedRouteStatus.includes('CANCEL');
  const isRouteCreated = normalizedRouteStatus.includes('CRIADA') || normalizedRouteStatus.includes('CRIADO');
  const canOpenWaypointDetail = !isRouteConcludedOrCanceled && !isRouteCreated;
  const isStartDisabled =
    saving ||
    startLocked ||
    isRouteInProgress(normalizedRouteStatus) ||
    isRouteConcludedOrCanceled;

  const onStartRoute = async () => {
    if (startRouteInFlightRef.current || isStartDisabled) {
      return;
    }

    startRouteInFlightRef.current = true;
    try {
      setSaving(true);
      await startRoute(routeId);
      startedRouteIdsLock.add(routeId);
      setStartLocked(true);
      setRouteDetail((previous) => {
        if (!previous) {
          return previous;
        }
        return {
          ...previous,
          status: 'EM_ANDAMENTO'
        };
      });
      await loadRouteDetails();
      const latestWaypoints = await listRouteWaypoints(routeId, { forceRefresh: true });

      if (latestWaypoints.length === 0) {
        Alert.alert('Rota iniciada', `Rota #${routeId} iniciada.`);
        return;
      }

      await openGoogleMapsRoute(latestWaypoints);
    } catch (error) {
      Alert.alert('Erro ao iniciar rota', getApiError(error));
    } finally {
      startRouteInFlightRef.current = false;
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
        loadRouteDetails({ forceRefresh: true });
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
                <Text style={styles.metaLabel}>Criada em</Text>
                <Text style={styles.metaValue}>{formatDate(routeDetail?.created_at ?? '')}</Text>
              </View>
            </View>

            <View style={styles.actionsRow}>
              <PrimaryButton
                label="Ver no mapa"
                variant="neutral"
                onPress={() => navigation.navigate('Map', { routeId, waypoints, routeStatus: routeDetail?.status })}
                style={styles.flexButton}
              />
              <PrimaryButton
                label="Iniciar"
                onPress={onStartRoute}
                loading={saving}
                disabled={isStartDisabled}
                style={styles.flexButton}
              />
            </View>
          </View>

          <Text style={styles.sectionTitle}>Paradas</Text>

          {waypoints.map((waypoint) => {
            const meta = getWaypointMeta(waypoint);
            const waypointDisabled = !canOpenWaypointDetail;

            return (
              <TouchableOpacity
                key={waypoint.id}
                style={[styles.waypointCard, waypointDisabled && styles.waypointCardDisabled]}
                onPress={() => onWaypointPress(waypoint)}
                disabled={waypointDisabled}
              >
                <View style={styles.waypointTop}>
                  <View style={styles.waypointTextColumn}>
                    <View style={styles.waypointTitleRow}>
                      <View style={[styles.seqBadge, waypointDisabled && styles.seqBadgeDisabled]}>
                        <Text style={[styles.seqBadgeText, waypointDisabled && styles.seqBadgeTextDisabled]}>
                          #{waypoint.seq_order}
                        </Text>
                      </View>
                      <Text style={[styles.waypointTitle, waypointDisabled && styles.waypointTitleDisabled]}>
                        {meta.title}
                      </Text>
                    </View>
                    {meta.subtitle ? (
                      <Text style={[styles.waypointSub, waypointDisabled && styles.waypointSubDisabled]}>
                        {meta.subtitle}
                      </Text>
                    ) : null}
                  </View>
                  <StatusBadge status={waypoint.status} type="waypoint" />
                </View>
              </TouchableOpacity>
            );
          })}

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
  waypointCardDisabled: {
    backgroundColor: '#D3D7DF',
    borderColor: '#B7BEC9'
  },
  waypointTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  waypointTextColumn: {
    flex: 1
  },
  waypointTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  seqBadge: {
    borderRadius: 999,
    backgroundColor: '#EDE9FE',
    borderWidth: 1,
    borderColor: '#C4B5FD',
    paddingHorizontal: 8,
    paddingVertical: 3
  },
  seqBadgeText: {
    color: '#6D28D9',
    fontSize: 11,
    fontWeight: '800'
  },
  seqBadgeDisabled: {
    backgroundColor: '#CFD5E1',
    borderColor: '#A9B3C4'
  },
  seqBadgeTextDisabled: {
    color: '#5B6577'
  },
  waypointTitle: {
    color: colors.textPrimary,
    fontWeight: '700',
    flex: 1
  },
  waypointTitleDisabled: {
    color: '#434A59'
  },
  waypointSub: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2
  },
  waypointSubDisabled: {
    color: '#5E6778'
  }
});
