import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { StackActions } from '@react-navigation/native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { StatusBadge } from '../components/StatusBadge';
import { getWaypointMeta } from '../utils/waypointMeta';
import { PrimaryButton } from '../components/PrimaryButton';
import {
  finishRoute,
  listRouteWaypoints,
  updateWaypointStatus,
  WaypointFinishStatus
} from '../api/routesApi';
import { getApiError } from '../api/httpClient';
import { useAuth } from '../context/AuthContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Delivery'>;
type FailureStatus = 'FALHA TEMPO ADVERSO' | 'FALHA MORADOR AUSENTE';
const isOpenWaypointStatus = (status: string) => status === 'PENDENTE' || status === 'EM_ROTA';

function isPendingRouteFinishError(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('pendente') ||
    normalized.includes('em andamento') ||
    normalized.includes('nao pode finalizar') ||
    normalized.includes('não pode finalizar') ||
    normalized.includes('não foi possível finalizar a rota')
  );
}

export function DeliveryScreen({ route, navigation }: Props) {
  const { routeId, waypoint } = route.params;
  const { userId } = useAuth();
  const [currentStatus, setCurrentStatus] = useState(waypoint.status);
  const [loading, setLoading] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [hasUploadedPhoto, setHasUploadedPhoto] = useState(false);
  const [uploadedPhotoUri, setUploadedPhotoUri] = useState<string | null>(null);
  const [uploadedPhotoName, setUploadedPhotoName] = useState<string | null>(null);
  const [showCameraModal, setShowCameraModal] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [showCameraLoadingHint, setShowCameraLoadingHint] = useState(false);
  const [capturedPhotoUri, setCapturedPhotoUri] = useState<string | null>(null);
  const [capturedPhotoName, setCapturedPhotoName] = useState<string | null>(null);
  const [showFailureModal, setShowFailureModal] = useState(false);
  const [showDeliveredConfirmModal, setShowDeliveredConfirmModal] = useState(false);
  const [failureStatus, setFailureStatus] = useState<FailureStatus>('FALHA TEMPO ADVERSO');
  const [failureObs, setFailureObs] = useState('');
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [feedbackSuccess, setFeedbackSuccess] = useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const meta = getWaypointMeta(waypoint);
  const isPendingWaypoint = currentStatus === 'PENDENTE';
  const payloadUserId = (() => {
    const authContextUserId = userId?.trim() ?? '';
    if (/^\d+$/.test(authContextUserId)) {
      return authContextUserId;
    }

    const waypointUserId = Number(waypoint.user_id);
    if (Number.isFinite(waypointUserId) && waypointUserId > 0) {
      return String(Math.trunc(waypointUserId));
    }

    return '';
  })();

  useEffect(() => {
    if (!showCameraModal || capturedPhotoUri) {
      setShowCameraLoadingHint(false);
      return;
    }

    const timeout = setTimeout(() => {
      if (!cameraReady && !cameraError) {
        setShowCameraLoadingHint(true);
      }
    }, 1600);

    return () => clearTimeout(timeout);
  }, [showCameraModal, capturedPhotoUri, cameraReady, cameraError]);

  useEffect(() => {
    if (!showCameraModal || capturedPhotoUri || cameraReady || cameraError) {
      return;
    }

    const fallbackReadyTimeout = setTimeout(() => {
      setCameraReady(true);
    }, 3200);

    return () => clearTimeout(fallbackReadyTimeout);
  }, [showCameraModal, capturedPhotoUri, cameraReady, cameraError]);

  const returnToRouteDetail = () => {
    navigation.dispatch(
      StackActions.popTo('RouteDetail', {
        routeId,
        refreshAt: Date.now()
      })
    );
  };

  const finishWaypoint = async (
    status: WaypointFinishStatus,
    options?: {
      obs_falha?: string;
      file_name?: string;
      user_id?: string | number;
      address_id?: number;
      image_uri?: string;
    }
  ) => {
    try {
      if (!options?.user_id) {
        throw new Error('user_id do motorista não encontrado na tabela users.');
      }

      setLoading(true);
      setFeedbackError(null);
      setFeedbackSuccess(null);
      await updateWaypointStatus(routeId, waypoint.id, status, options);
      const updatedStatus =
        status === 'CONCLUIDO' || status === 'ENTREGUE'
          ? 'CONCLUIDO'
          : status;
      setCurrentStatus(updatedStatus);
      setFeedbackSuccess('Status atualizado com sucesso.');

      // Ao concluir todos os waypoints, finaliza a rota automaticamente.
      let autoFinishWarning: string | null = null;
      let refreshedWaypoints: Awaited<ReturnType<typeof listRouteWaypoints>> | null = null;
      let shouldTryAutoFinish = true;

      try {
        refreshedWaypoints = await listRouteWaypoints(routeId);
        if (refreshedWaypoints.length > 0) {
          const hasOpenWaypoints = refreshedWaypoints.some((item) => isOpenWaypointStatus(item.status));
          shouldTryAutoFinish = !hasOpenWaypoints;
        }

        if (shouldTryAutoFinish) {
          await finishRoute(routeId);
          setFeedbackSuccess('Todos os waypoints finalizados. Rota finalizada automaticamente.');
        }
      } catch (error) {
        const message = getApiError(error);
        const cameWithoutWaypointSnapshot = Array.isArray(refreshedWaypoints) && refreshedWaypoints.length === 0;
        if (!(cameWithoutWaypointSnapshot && isPendingRouteFinishError(message))) {
          autoFinishWarning = message;
        }
      }

      returnToRouteDetail();
      if (autoFinishWarning) {
        Alert.alert(
          'Rota não finalizada automaticamente',
          `O waypoint foi atualizado, mas houve erro ao finalizar a rota: ${autoFinishWarning}`
        );
      }
    } catch (error) {
      const message = getApiError(error);
      setFeedbackError(message);
      Alert.alert('Falha ao atualizar', message);
    } finally {
      setLoading(false);
    }
  };

  const onTakePhoto = async () => {
    if (!isPendingWaypoint) {
      Alert.alert('Ação indisponível', 'Somente waypoints com status PENDENTE permitem tirar foto.');
      return;
    }

    if (Platform.OS === 'web') {
      setFeedbackError(
        'No preview web não há câmera nativa. Abra no app Android/iOS (Expo Go) para tirar a foto.'
      );
      Alert.alert(
        'Câmera no mobile',
        'No preview web não há câmera nativa. Abra no app Android/iOS (Expo Go) para tirar a foto.'
      );
      return;
    }

    try {
      const permission = cameraPermission?.granted
        ? cameraPermission
        : await requestCameraPermission();
      if (!permission.granted) {
        Alert.alert('Permissão necessária', 'Permita o uso da câmera para tirar a foto da entrega.');
        return;
      }

      setFeedbackError(null);
      setFeedbackSuccess(null);
      setCapturedPhotoUri(null);
      setCapturedPhotoName(null);
      setCameraReady(false);
      setCameraError(null);
      setShowCameraLoadingHint(false);
      setShowCameraModal(true);
    } catch (error) {
      const message = getApiError(error);
      setFeedbackError(message);
      Alert.alert('Falha ao abrir câmera', message);
    }
  };

  const onCapturePhoto = async () => {
    if (cameraError) {
      Alert.alert('Câmera indisponível', cameraError);
      return;
    }

    if (!cameraRef.current) {
      Alert.alert('Câmera indisponível', 'Não foi possível acessar a câmera neste momento.');
      return;
    }

    try {
      setCameraBusy(true);
      const rawPhoto = await cameraRef.current.takePictureAsync({
        quality: 0.6,
        base64: false
      });

      if (!rawPhoto?.uri) {
        Alert.alert('Falha ao capturar', 'Não foi possível capturar a foto.');
        return;
      }

      const normalizedPhoto = await manipulateAsync(
        rawPhoto.uri,
        [],
        {
          compress: 1,
          format: SaveFormat.JPEG,
          base64: false
        }
      );

      const fileName = `photo_${Date.now()}.jpg`;
      setCapturedPhotoUri(normalizedPhoto.uri);
      setCapturedPhotoName(fileName);
    } catch (error) {
      Alert.alert('Falha ao capturar', getApiError(error));
    } finally {
      setCameraBusy(false);
    }
  };

  const onConfirmPhoto = async () => {
    if (!capturedPhotoUri || !capturedPhotoName) {
      return;
    }

    setCameraBusy(true);
    setHasUploadedPhoto(true);
    setUploadedPhotoUri(capturedPhotoUri);
    setUploadedPhotoName(capturedPhotoName);
    setShowCameraModal(false);
    setCapturedPhotoUri(null);
    setCapturedPhotoName(null);
    setCameraError(null);
    setShowCameraLoadingHint(false);
    setFeedbackSuccess('Foto salva localmente. Será enviada ao confirmar o status.');
    Alert.alert('Foto confirmada', 'Foto salva com sucesso.');
    setCameraBusy(false);
  };

  const onConfirmDelivered = () => {
    if (!isPendingWaypoint) {
      Alert.alert(
        'Ação indisponível',
        'Somente waypoints com status PENDENTE permitem marcar como entregue.'
      );
      return;
    }

    if (!hasUploadedPhoto) {
      setShowDeliveredConfirmModal(true);
      return;
    }

    finishWaypoint('ENTREGUE', {
      obs_falha: '',
      file_name: uploadedPhotoName ?? '',
      user_id: payloadUserId,
      address_id: waypoint.address_id,
      image_uri: uploadedPhotoUri ?? undefined
    });
  };

  const onConfirmFailure = async () => {
    if (!isPendingWaypoint) {
      Alert.alert('Ação indisponível', 'Somente waypoints com status PENDENTE permitem marcar falha.');
      return;
    }

    const obsFalha = failureObs;
    setShowFailureModal(false);
    setFailureObs('');
    await finishWaypoint(failureStatus, {
      obs_falha: obsFalha,
      file_name: uploadedPhotoName ?? '',
      user_id: payloadUserId,
      address_id: waypoint.address_id,
      image_uri: uploadedPhotoUri ?? undefined
    });
  };

  const openInRouteMap = () => {
    navigation.navigate('Map', {
      routeId,
      waypoints: [waypoint]
    });
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <View style={styles.topRow}>
          <Text style={styles.title}>Entrega #{waypoint.seq_order}</Text>
          <StatusBadge status={currentStatus} type="waypoint" />
        </View>

        <Text style={styles.address}>{meta.title}</Text>
        {meta.subtitle ? <Text style={styles.addressSub}>{meta.subtitle}</Text> : null}

        <PrimaryButton
          label="Ver no Mapa"
          variant="primary"
          onPress={openInRouteMap}
          style={styles.button}
        />

        <PrimaryButton
          label="Tirar foto"
          variant="primary"
          onPress={onTakePhoto}
          loading={cameraBusy}
          disabled={loading || !isPendingWaypoint}
          style={styles.button}
        />
        <Text style={styles.photoStatus}>
          {hasUploadedPhoto
            ? `Foto salva: ${uploadedPhotoName ?? 'comprovante.jpg'}`
            : 'Nenhuma foto salva.'}
        </Text>
        {feedbackSuccess ? <Text style={styles.feedbackSuccess}>{feedbackSuccess}</Text> : null}
        {feedbackError ? <Text style={styles.feedbackError}>{feedbackError}</Text> : null}

        <PrimaryButton
          label="Marcar como ENTREGUE"
          variant="success"
          onPress={onConfirmDelivered}
          loading={loading}
          disabled={cameraBusy || !isPendingWaypoint}
          style={styles.button}
        />

        <PrimaryButton
          label="Marcar FALHA"
          variant="danger"
          onPress={() => {
            if (!isPendingWaypoint) {
              Alert.alert(
                'Ação indisponível',
                'Somente waypoints com status PENDENTE permitem marcar falha.'
              );
              return;
            }
            setShowFailureModal(true);
          }}
          loading={loading}
          disabled={cameraBusy || !isPendingWaypoint}
          style={styles.button}
        />
      </View>

      <Modal
        visible={showCameraModal}
        animationType="slide"
        onRequestClose={() => {
          if (cameraBusy) {
            return;
          }
          setShowCameraModal(false);
          setCapturedPhotoUri(null);
          setCapturedPhotoName(null);
          setCameraError(null);
          setShowCameraLoadingHint(false);
        }}
      >
        <View style={styles.cameraContainer}>
          {capturedPhotoUri ? (
            <Image
              source={{ uri: capturedPhotoUri }}
              style={styles.cameraView}
              resizeMode="cover"
            />
          ) : (
            <CameraView
              ref={cameraRef}
              style={styles.cameraView}
              pointerEvents="none"
              facing="back"
              onCameraReady={() => setCameraReady(true)}
              onMountError={(event) => {
                const message =
                  event?.message?.trim() ||
                  'Não foi possível iniciar a câmera neste dispositivo.';
                setCameraError(message);
                setCameraReady(false);
              }}
            />
          )}

          {!capturedPhotoUri && cameraError ? (
            <View style={styles.cameraOverlay} pointerEvents="box-none">
              <Text style={styles.cameraOverlayError}>{cameraError}</Text>
              <Text style={styles.cameraOverlayHint}>
                Se estiver em emulador iOS, a câmera pode não estar disponível.
              </Text>
            </View>
          ) : null}

          {!capturedPhotoUri && !cameraError && !cameraReady ? (
            <View style={styles.cameraOverlay} pointerEvents="box-none">
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.cameraOverlayText}>Iniciando câmera...</Text>
              {showCameraLoadingHint ? (
                <Text style={styles.cameraOverlayHint}>
                  A prévia pode demorar no iOS. Se continuar sem imagem, feche e abra novamente.
                </Text>
              ) : null}
            </View>
          ) : null}

          <View style={styles.cameraActions}>
            {capturedPhotoUri ? (
              <>
                <PrimaryButton
                  label="Tirar outra"
                  variant="neutral"
                  onPress={() => {
                    setCapturedPhotoUri(null);
                    setCapturedPhotoName(null);
                  }}
                  disabled={cameraBusy}
                  style={styles.cameraActionButton}
                />
                <PrimaryButton
                  label="Confirmar foto"
                  variant="primary"
                  onPress={onConfirmPhoto}
                  loading={cameraBusy}
                  style={styles.cameraActionButton}
                />
              </>
            ) : (
              <>
                <PrimaryButton
                  label="Cancelar"
                  variant="neutral"
                  onPress={() => {
                    setShowCameraModal(false);
                    setCapturedPhotoUri(null);
                    setCapturedPhotoName(null);
                    setCameraError(null);
                    setShowCameraLoadingHint(false);
                  }}
                  disabled={cameraBusy}
                  style={styles.cameraActionButton}
                />
                <PrimaryButton
                  label="Capturar foto"
                  variant="primary"
                  onPress={onCapturePhoto}
                  loading={cameraBusy}
                  disabled={cameraBusy || Boolean(cameraError)}
                  style={styles.cameraActionButton}
                />
              </>
            )}
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={showDeliveredConfirmModal}
        onRequestClose={() => setShowDeliveredConfirmModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Confirmação</Text>
            <Text style={styles.modalText}>
              Não há foto para comprovar a entrega. Deseja prosseguir mesmo assim?
            </Text>
            <View style={styles.modalActions}>
              <PrimaryButton
                label="Cancelar"
                variant="neutral"
                onPress={() => setShowDeliveredConfirmModal(false)}
                style={styles.modalAction}
              />
              <PrimaryButton
                label="Prosseguir"
                variant="success"
                onPress={() => {
                  setShowDeliveredConfirmModal(false);
                  finishWaypoint('ENTREGUE', {
                    obs_falha: '',
                    file_name: uploadedPhotoName ?? '',
                    user_id: payloadUserId,
                    address_id: waypoint.address_id,
                    image_uri: uploadedPhotoUri ?? undefined
                  });
                }}
                loading={loading}
                style={styles.modalAction}
              />
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={showFailureModal}
        onRequestClose={() => setShowFailureModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Registrar Falha</Text>
            <TextInput
              value={failureObs}
              onChangeText={setFailureObs}
              placeholder="Observações da falha (obs_falha)"
              placeholderTextColor={colors.textSecondary}
              multiline
              textAlignVertical="top"
              style={styles.obsInput}
            />

            <View style={styles.failureButtons}>
              <PrimaryButton
                label="TEMPO ADVERSO"
                variant={failureStatus === 'FALHA TEMPO ADVERSO' ? 'danger' : 'neutral'}
                onPress={() => setFailureStatus('FALHA TEMPO ADVERSO')}
                style={styles.failureButton}
              />
              <PrimaryButton
                label="MORADOR AUSENTE"
                variant={failureStatus === 'FALHA MORADOR AUSENTE' ? 'danger' : 'neutral'}
                onPress={() => setFailureStatus('FALHA MORADOR AUSENTE')}
                style={styles.failureButton}
              />
            </View>

            <View style={styles.modalActions}>
              <PrimaryButton
                label="Cancelar"
                variant="neutral"
                onPress={() => setShowFailureModal(false)}
                style={styles.modalAction}
              />
              <PrimaryButton
                label="Confirmar"
                variant="danger"
                onPress={onConfirmFailure}
                loading={loading}
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
    gap: 12
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  title: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '800'
  },
  address: {
    marginTop: 16,
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 17
  },
  addressSub: {
    color: colors.textSecondary,
    marginTop: 4,
    marginBottom: 16
  },
  button: {
    marginBottom: 8
  },
  photoStatus: {
    marginTop: -2,
    marginBottom: 6,
    color: colors.textSecondary,
    fontSize: 12
  },
  feedbackSuccess: {
    marginBottom: 8,
    color: colors.success,
    fontSize: 12,
    fontWeight: '600'
  },
  feedbackError: {
    marginBottom: 8,
    color: colors.danger,
    fontSize: 12,
    fontWeight: '600'
  },
  cameraContainer: {
    flex: 1,
    backgroundColor: '#000'
  },
  cameraView: {
    ...StyleSheet.absoluteFillObject
  },
  cameraActions: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 24,
    flexDirection: 'row',
    gap: 8,
    zIndex: 20,
    elevation: 20
  },
  cameraOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24
  },
  cameraOverlayText: {
    color: '#fff',
    marginTop: 12,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center'
  },
  cameraOverlayHint: {
    color: '#E4E7EC',
    marginTop: 8,
    fontSize: 13,
    textAlign: 'center'
  },
  cameraOverlayError: {
    color: '#FECACA',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center'
  },
  cameraActionButton: {
    flex: 1
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
  obsInput: {
    minHeight: 92,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.textPrimary,
    marginBottom: 12
  },
  failureButtons: {
    gap: 8,
    marginBottom: 12
  },
  failureButton: {
    marginBottom: 0
  },
  modalActions: {
    flexDirection: 'row',
    gap: 8
  },
  modalAction: {
    flex: 1
  }
});
