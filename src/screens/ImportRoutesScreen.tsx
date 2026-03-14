import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
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
  const [clearingImport, setClearingImport] = useState(false);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [routeIdPendingDelete, setRouteIdPendingDelete] = useState<number | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const importedRouteIds = useMemo(() => {
    return (route.params.routeIds ?? [])
      .map((value) => Math.trunc(Number(value)))
      .filter((value) => Number.isFinite(value) && value > 0);
  }, [route.params.routeIds]);
  const importedRouteIdSet = useMemo(() => new Set(importedRouteIds), [importedRouteIds]);

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
    setRouteIdPendingDelete(routeId);
    setCancelReason('');
    setDeleteModalVisible(true);
  };

  const onConfirmDeleteRoute = () => {
    const targetRouteId = routeIdPendingDelete;
    if (!targetRouteId) {
      return;
    }

    const trimmedReason = cancelReason.trim();
    if (!trimmedReason) {
      Alert.alert('Justificativa obrigatória', 'Informe a justificativa para cancelar a rota.');
      return;
    }

    setDeleteModalVisible(false);
    void (async () => {
      try {
        setDeletingRouteId(targetRouteId);
        await deleteRoute(targetRouteId, trimmedReason);
        await loadRoutes({ forceRefresh: true });
        Alert.alert('Rota excluída', `Rota #${targetRouteId} removida com sucesso.`);
      } catch (error) {
        Alert.alert('Falha ao excluir rota', getApiError(error));
      } finally {
        setDeletingRouteId(null);
        setRouteIdPendingDelete(null);
      }
    })();
  };

  const onClearImport = () => {
    if (importedRouteIds.length === 0) {
      Alert.alert('Importação vazia', 'Não há rotas importadas para remover.');
      return;
    }

    Alert.alert(
      'Limpar importação',
      `Deseja remover ${importedRouteIds.length} rota(s) importada(s)?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Limpar',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                setClearingImport(true);
                const failedRouteIds: number[] = [];

                for (const routeId of importedRouteIds) {
                  try {
                    await deleteRoute(routeId);
                  } catch {
                    failedRouteIds.push(routeId);
                  }
                }

                await loadRoutes({ forceRefresh: true });

                if (failedRouteIds.length === 0) {
                  navigation.navigate('Routes');
                  return;
                }

                Alert.alert(
                  'Limpeza parcial',
                  `Não foi possível remover ${failedRouteIds.length} rota(s).`
                );
              } catch (error) {
                Alert.alert('Falha ao limpar importação', getApiError(error));
              } finally {
                setClearingImport(false);
              }
            })();
          }
        }
      ]
    );
  };

  const routeStats = useMemo(() => {
    const active = routes.filter((entry) => entry.status === 'EM_ROTA' || entry.status === 'EM_ANDAMENTO').length;
    return { total: routes.length, active };
  }, [routes]);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.headerCard}>
        <View style={styles.headerTopActions}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => void logout()}
            accessibilityRole="button"
            accessibilityLabel="Sair"
          >
            <Ionicons name="log-out-outline" size={20} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => navigation.navigate('Settings')}
            accessibilityRole="button"
            accessibilityLabel="Configurações"
          >
            <Ionicons name="settings-outline" size={20} color={colors.primary} />
          </TouchableOpacity>
        </View>
        <View>
          <Text style={styles.headerTitle}>Rotas da Importação</Text>
        </View>
      </View>

      <Text style={styles.driver}>Motorista: {userEmail}</Text>

      <View style={styles.statsCard}>
        <Text style={styles.statsTitle}>Hoje</Text>
        <Text style={styles.statsText}>
          {routeStats.total} rotas ({routeStats.active} em andamento)
        </Text>
      </View>

      <View style={styles.createCard}>
        <PrimaryButton
          label="Limpar Importação"
          variant="danger"
          onPress={onClearImport}
          disabled={clearingImport || importedRouteIds.length === 0}
          loading={clearingImport}
          style={styles.createActionButton}
        />
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
                <View style={styles.routeTitleLine}>
                  <Text style={styles.routeTitle}>Rota #{entry.id}</Text>
                  <StatusBadge status={entry.status} type="route" />
                </View>
                <Text style={styles.routeMeta}>
                  {entry.waypoints_count ?? entry.waypoints?.length ?? 0} waypoints • Criada em {formatDate(entry.created_at)}
                </Text>
              </View>
              <View style={styles.routeActions}>
                <TouchableOpacity
                  style={[
                    styles.deleteRouteButton,
                    deletingRouteId === entry.id && styles.deleteRouteButtonDisabled
                  ]}
                  onPress={(event) => {
                    event.stopPropagation();
                    if (deletingRouteId !== null || clearingImport) {
                      return;
                    }
                    onDeleteRoute(entry.id);
                  }}
                  disabled={deletingRouteId !== null || clearingImport}
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

      <Modal
        transparent
        animationType="fade"
        visible={deleteModalVisible}
        onRequestClose={() => setDeleteModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Cancelar rota</Text>
            <Text style={styles.modalText}>
              Confirme o cancelamento da rota #{routeIdPendingDelete ?? '-'}.
            </Text>
            <TextInput
              value={cancelReason}
              onChangeText={setCancelReason}
              placeholder="Justificativa"
              placeholderTextColor={colors.textSecondary}
              multiline
              textAlignVertical="top"
              style={styles.justificationInput}
            />
            <View style={styles.modalActions}>
              <PrimaryButton
                label="Cancelar"
                variant="neutral"
                onPress={() => setDeleteModalVisible(false)}
                style={styles.modalAction}
              />
              <PrimaryButton
                label="Excluir"
                variant="danger"
                onPress={onConfirmDeleteRoute}
                loading={deletingRouteId === routeIdPendingDelete}
                style={styles.modalAction}
              />
            </View>
          </View>
        </View>
      </Modal>
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
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 8
  },
  headerTopActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F6F9FF'
  },
  headerTitle: {
    color: colors.textPrimary,
    fontWeight: '800',
    fontSize: 18
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
  createActionButton: {
    width: '100%'
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
  routeTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
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
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(16, 24, 40, 0.6)',
    justifyContent: 'center',
    padding: 16
  },
  modalCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14
  },
  modalTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 10
  },
  modalText: {
    color: colors.textSecondary,
    marginBottom: 12
  },
  justificationInput: {
    minHeight: 90,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.textPrimary,
    marginBottom: 12
  },
  modalActions: {
    flexDirection: 'row',
    gap: 8
  },
  modalAction: {
    flex: 1
  }
});
