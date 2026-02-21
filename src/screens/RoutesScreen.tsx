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
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { listRoutes } from '../api/routesApi';
import { getApiError } from '../api/httpClient';
import { Route } from '../api/types';
import { StatusBadge } from '../components/StatusBadge';
import { formatDate } from '../utils/date';
import { PrimaryButton } from '../components/PrimaryButton';
import { useAuth } from '../context/AuthContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Routes'>;

export function RoutesScreen({ navigation }: Props) {
  const { userEmail, logout } = useAuth();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadRoutes = useCallback(async () => {
    try {
      const data = await listRoutes();
      setRoutes(data);
    } catch (error) {
      Alert.alert('Erro ao carregar rotas', getApiError(error));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadRoutes();
    }, [loadRoutes])
  );

  const onRefresh = () => {
    setRefreshing(true);
    loadRoutes();
  };

  const routeStats = useMemo(() => {
    const pending = routes.filter((route) => route.status === 'PENDENTE').length;
    const active = routes.filter((route) => route.status === 'EM_ROTA').length;
    return { total: routes.length, pending, active };
  }, [routes]);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.headerCard}>
        <View>
          <Text style={styles.headerTitle}>Minhas Rotas</Text>
          <Text style={styles.headerSubtitle}>Import {routeStats.total} • {routeStats.pending} pendentes</Text>
        </View>
        <TouchableOpacity onPress={() => void logout()}>
          <Text style={styles.logout}>Sair</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.driver}>Motorista: {userEmail}</Text>

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

      <View style={styles.createCard}>
        <Text style={styles.createTitle}>Operações avançadas</Text>
        <View style={styles.inlineButtons}>
          <PrimaryButton
            label="Clusterização"
            variant="neutral"
            onPress={() => navigation.navigate('Clusterize')}
            style={styles.flexButton}
          />
          <PrimaryButton
            label="Criar Manual"
            variant="primary"
            onPress={() => navigation.navigate('CreateRouteManual')}
            style={styles.flexButton}
          />
        </View>
      </View>

      {loading ? (
        <View style={styles.loaderContainer}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : routes.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>Nenhuma rota disponível.</Text>
        </View>
      ) : (
        routes.map((route) => (
          <TouchableOpacity
            key={route.id}
            style={styles.routeCard}
            onPress={() => navigation.navigate('RouteDetail', { routeId: route.id })}
          >
            <View style={styles.routeTitleRow}>
              <View style={styles.idBubble}>
                <Text style={styles.idBubbleText}>#{route.id}</Text>
              </View>
              <View style={styles.routeTitleColumn}>
                <Text style={styles.routeTitle}>Rota #{route.id}</Text>
                <Text style={styles.routeMeta}>Cluster {route.cluster_id} • {formatDate(route.created_at)}</Text>
              </View>
              <StatusBadge status={route.status} type="route" />
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
  driver: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600'
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
  inlineButtons: {
    flexDirection: 'row',
    gap: 10
  },
  flexButton: {
    flex: 1
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
  idBubble: {
    width: 34,
    height: 34,
    borderRadius: 9,
    backgroundColor: colors.badgeBg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  idBubbleText: {
    color: colors.primary,
    fontWeight: '800'
  },
  routeTitleColumn: {
    flex: 1
  },
  routeTitle: {
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 16
  },
  routeMeta: {
    marginTop: 2,
    color: colors.textSecondary,
    fontSize: 12
  }
});
