import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { deleteRoute, listRoutes } from '../api/routesApi';
import { getApiError } from '../api/httpClient';
import { RouteDetail } from '../api/types';
import { StatusBadge } from '../components/StatusBadge';
import { formatDate } from '../utils/date';
import { PrimaryButton } from '../components/PrimaryButton';
import { useAuth } from '../context/AuthContext';
import { subscribeSyncFinished } from '../offline/syncEngine';

type Props = NativeStackScreenProps<RootStackParamList, 'ImportRoutes'>;

export function ImportRoutesScreen({ navigation, route }: Props) {
  const { userEmail, logout } = useAuth();
  const [routes, setRoutes] = useState<RouteDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingRouteId, setDeletingRouteId] = useState<number | null>(null);

  const importedRouteIdSet = useMemo(() => {
    const normalizedIds = (route.params.routeIds ?? [])
      .map((value) => Math.trunc(Number(value)))
      .filter((value) => Number.isFinite(value) && value > 0);
    return new Set(normalizedIds);
  }, [route.params.routeIds]);

  const loadRoutes = useCallback(async (options?: { forceRefresh?: boolean }) => {
    try {
      const data = await listRoutes({ forceRefresh: options?.forceRefresh });
      const filteredRoutes = data.filter((entry) => importedRouteIdSet.has(entry.id));
      setRoutes(filteredRoutes);
    } catch (error) {
      Alert.alert('Erro ao carregar rotas', getApiError(error));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [importedRouteIdSet]);

  useFocusEffect(
    useCallback(() => {
      loadRoutes();
    }, [loadRoutes])
  );

  useEffect(() => {
    const unsubscribe = subscribeSyncFinished((result) => {
      if (result.ok) {
        void loadRoutes();
      }
    });
    return unsubscribe;
  }, [loadRoutes]);

  const onRefresh = () => {
    setRefreshing(true);
    loadRoutes({ forceRefresh: true });
  };

  const onDeleteRoute = (routeId: number) => {
    Alert.alert(
      'Excluir rota',
      `Deseja excluir a rota #${routeId}?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Excluir',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                setDeletingRouteId(routeId);
                await deleteRoute(routeId);
                await loadRoutes({ forceRefresh: true });
                Alert.alert('Rota excluída', `Rota #${routeId} removida com sucesso.`);
              } catch (error) {
                Alert.alert('Falha ao excluir rota', getApiError(error));
              } finally {
                setDeletingRouteId(null);
              }
            })();
          }
        }
      ]
    );
  };

  const routeStats = useMemo(() => {
    const pending = routes.filter((entry) => entry.status === 'PENDENTE' || entry.status === 'CRIADA').length;
    const active = routes.filter((entry) => entry.status === 'EM_ROTA' || entry.status === 'EM_ANDAMENTO').length;
    return { total: routes.length, pending, active };
  }, [routes]);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.headerCard}>
        <View>
          <Text style={styles.headerTitle}>Rotas da Importação</Text>
          <Text style={styles.headerSubtitle}>Import {routeStats.total} • {routeStats.pending} pendentes</Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={() => navigation.navigate('Settings')}>
            <Text style={styles.settings}>Config</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => void logout()}>
            <Text style={styles.logout}>Sair</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Text style={styles.driver}>Motorista: {userEmail}</Text>

      <View style={styles.badgesRow}>
        <View style={styles.badgePill}>
          <Text style={styles.badgePillText}>Motorista Demo</Text>
        </View>
        <View style={styles.badgePill}>
          <Text style={styles.badgePillText}>OliverSoft - Coimbra</Text>
        </View>
      </View>

      <View style={styles.statsCard}>
        <Text style={styles.statsTitle}>Hoje</Text>
        <Text style={styles.statsText}>
          {routeStats.total} rotas ({routeStats.active} em andamento)
        </Text>
      </View>

      <View style={styles.createCard}>
        <Text style={styles.createTitle}>Criar rota por importação</Text>
        <PrimaryButton label="Criar Rota" onPress={() => navigation.navigate('ImportRoute')} />
      </View>

      {loading ? (
        <View style={styles.loaderContainer}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : routes.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>Nenhuma rota desta importação.</Text>
        </View>
      ) : (
        routes.map((entry) => (
          <TouchableOpacity
            key={entry.id}
            style={styles.routeCard}
            onPress={() => navigation.navigate('RouteDetail', { routeId: entry.id })}
          >
            <View style={styles.routeTitleRow}>
              <View style={styles.routeTitleColumn}>
                <Text style={styles.routeTitle}>Rota #{entry.id}</Text>
                <Text style={styles.routeMeta}>
                  {entry.waypoints_count ?? entry.waypoints?.length ?? 0} waypoints • Criada em {formatDate(entry.created_at)}
                </Text>
              </View>
              <View style={styles.routeActions}>
                <StatusBadge status={entry.status} type="route" />
                <TouchableOpacity
                  style={[
                    styles.deleteRouteButton,
                    deletingRouteId === entry.id && styles.deleteRouteButtonDisabled
                  ]}
                  onPress={(event) => {
                    event.stopPropagation();
                    if (deletingRouteId !== null) {
                      return;
                    }
                    onDeleteRoute(entry.id);
                  }}
                  disabled={deletingRouteId !== null}
                  accessibilityRole="button"
                  accessibilityLabel={`Excluir rota ${entry.id}`}
                >
                  <Text style={styles.deleteRouteButtonText}>X</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 22
  },
  headerCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14
  },
  headerTitle: {
    color: colors.textPrimary,
    fontWeight: '800',
    fontSize: 18
  },
  headerSubtitle: {
    color: colors.textSecondary,
    marginTop: 3,
    fontSize: 12
  },
  logout: {
    color: colors.primary,
    fontWeight: '700'
  },
  headerActions: {
    alignItems: 'flex-end',
    gap: 10
  },
  settings: {
    color: colors.primary,
    fontWeight: '700'
  },
  driver: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600'
  },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  badgePill: {
    borderWidth: 1,
    borderColor: '#D0DAEE',
    backgroundColor: '#F1F6FF',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5
  },
  badgePillText: {
    color: colors.primaryDark,
    fontSize: 11,
    fontWeight: '700'
  },
  statsCard: {
    borderRadius: 14,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14
  },
  statsTitle: {
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 16
  },
  statsText: {
    color: colors.textSecondary,
    marginTop: 4
  },
  createCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 10
  },
  createTitle: {
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: 2
  },
  loaderContainer: {
    paddingVertical: 24,
    alignItems: 'center'
  },
  emptyCard: {
    borderRadius: 16,
    borderColor: colors.border,
    borderWidth: 1,
    padding: 18,
    backgroundColor: colors.card
  },
  emptyText: {
    color: colors.textSecondary,
    textAlign: 'center'
  },
  routeCard: {
    borderRadius: 16,
    borderColor: colors.border,
    borderWidth: 1,
    backgroundColor: colors.card,
    padding: 12
  },
  routeTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  routeTitleColumn: {
    flex: 1
  },
  routeActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  deleteRouteButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF'
  },
  deleteRouteButtonDisabled: {
    opacity: 0.5
  },
  deleteRouteButtonText: {
    color: '#C72B2B',
    fontWeight: '800',
    fontSize: 12
  },
  routeTitle: {
    color: colors.textPrimary,
    fontWeight: '800',
    fontSize: 31 / 2
  },
  routeMeta: {
    color: colors.textSecondary,
    fontWeight: '600',
    marginTop: 4
  }
});
