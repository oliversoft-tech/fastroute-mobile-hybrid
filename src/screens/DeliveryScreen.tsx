import { useState } from 'react';
import {
  Alert,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { StatusBadge } from '../components/StatusBadge';
import { getWaypointMeta } from '../utils/waypointMeta';
import { PrimaryButton } from '../components/PrimaryButton';
import { updateWaypointStatus, WaypointFinishStatus } from '../api/routesApi';
import { getApiError } from '../api/httpClient';

type Props = NativeStackScreenProps<RootStackParamList, 'Delivery'>;
type FailureStatus = 'FALHA TEMPO ADVERSO' | 'FALHA MORADOR AUSENTE';

export function DeliveryScreen({ route, navigation }: Props) {
  const { routeId, waypoint } = route.params;
  const [currentStatus, setCurrentStatus] = useState(waypoint.status);
  const [loading, setLoading] = useState(false);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [showFailureModal, setShowFailureModal] = useState(false);
  const [failureStatus, setFailureStatus] = useState<FailureStatus>('FALHA TEMPO ADVERSO');
  const [failureObs, setFailureObs] = useState('');
  const meta = getWaypointMeta(waypoint);

  const returnToRouteDetail = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }

    navigation.navigate('RouteDetail', { routeId });
  };

  const finishWaypoint = async (
    status: WaypointFinishStatus,
    options?: {
      obs_falha?: string;
    }
  ) => {
    try {
      setLoading(true);
      await updateWaypointStatus(routeId, waypoint.id, status, options);
      if (status === 'CONCLUIDO') {
        setCurrentStatus('CONCLUIDO');
      }
      returnToRouteDetail();
    } catch (error) {
      Alert.alert('Falha ao atualizar', getApiError(error));
    } finally {
      setLoading(false);
    }
  };

  const onTakePhoto = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert('Permissão necessária', 'Permita o uso da câmera para tirar a foto da entrega.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: false,
        quality: 0.8
      });

      if (!result.canceled && result.assets.length > 0) {
        setPhotoUri(result.assets[0].uri);
      }
    } catch (error) {
      Alert.alert('Falha ao abrir câmera', getApiError(error));
    }
  };

  const onConfirmDelivered = () => {
    if (!photoUri) {
      Alert.alert(
        'Confirmação',
        'Não há foto para comprovar a entrega. Deseja prosseguir mesmo assim?',
        [
          {
            text: 'Cancelar',
            style: 'cancel'
          },
          {
            text: 'Prosseguir',
            onPress: () => {
              finishWaypoint('CONCLUIDO');
            }
          }
        ]
      );
      return;
    }

    finishWaypoint('CONCLUIDO');
  };

  const onConfirmFailure = async () => {
    const obsFalha = failureObs;
    setShowFailureModal(false);
    setFailureObs('');
    await finishWaypoint(failureStatus, {
      obs_falha: obsFalha
    });
  };

  const openInMaps = async () => {
    const url = `https://www.google.com/maps/search/?api=1&query=${meta.latitude},${meta.longitude}`;
    const supported = await Linking.canOpenURL(url);
    if (!supported) {
      Alert.alert('Maps indisponível', 'Não foi possível abrir o aplicativo de mapas.');
      return;
    }

    await Linking.openURL(url);
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
          label="Abrir no Maps"
          variant="primary"
          onPress={openInMaps}
          style={styles.button}
        />

        <PrimaryButton
          label="Tirar foto"
          variant="primary"
          onPress={onTakePhoto}
          style={styles.button}
        />
        <Text style={styles.photoStatus}>
          {photoUri ? 'Foto capturada para comprovação.' : 'Nenhuma foto capturada.'}
        </Text>

        <PrimaryButton
          label="Marcar como ENTREGUE"
          variant="success"
          onPress={onConfirmDelivered}
          loading={loading}
          style={styles.button}
        />

        <PrimaryButton
          label="Marcar FALHA"
          variant="danger"
          onPress={() => setShowFailureModal(true)}
          loading={loading}
          style={styles.button}
        />
      </View>

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
    marginBottom: 12,
    color: colors.textSecondary,
    fontSize: 12
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
