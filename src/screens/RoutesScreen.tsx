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
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.updateButton} onPress={loadRoutes}>
            <Text style={styles.updateButtonText}>Atualizar</Text>
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
                <Text style={styles.routeMeta}>Criada em {formatDate(route.created_at)}</Text>
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
  headerActions: {
    alignItems: 'flex-end',
    gap: 8
  },
  updateButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#fff'
  },
  updateButtonText: {
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 12
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
