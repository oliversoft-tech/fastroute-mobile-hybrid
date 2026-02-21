import { useState } from 'react';
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { StatusBadge } from '../components/StatusBadge';
import { getWaypointMeta } from '../utils/waypointMeta';
import { PrimaryButton } from '../components/PrimaryButton';
import { updateWaypointStatus } from '../api/routesApi';
import { getApiError } from '../api/httpClient';
import { WaypointStatus } from '../api/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Delivery'>;

export function DeliveryScreen({ route, navigation }: Props) {
  const { routeId, waypoint } = route.params;
  const [currentStatus, setCurrentStatus] = useState(waypoint.status);
  const [loading, setLoading] = useState(false);
  const meta = getWaypointMeta(waypoint);

  const setStatus = async (status: WaypointStatus) => {
    try {
      setLoading(true);
      await updateWaypointStatus(routeId, waypoint.id, status);
      setCurrentStatus(status);
      Alert.alert('Status atualizado', `Novo status: ${status}`);
    } catch (error) {
      Alert.alert('Falha ao atualizar', getApiError(error));
    } finally {
      setLoading(false);
    }
  };

  const onFailDelivery = async () => {
    try {
      setLoading(true);
      await updateWaypointStatus(routeId, waypoint.id, 'PENDENTE');
      setCurrentStatus('PENDENTE');
      Alert.alert('Falha registrada', 'Entrega marcada como falha.');
    } catch {
      setCurrentStatus('PENDENTE');
      Alert.alert('Falha simulada', 'Falha registrada localmente (simulado).');
    } finally {
      setLoading(false);
    }
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
          variant="neutral"
          onPress={openInMaps}
          style={styles.button}
        />

        <PrimaryButton
          label="Tirar foto (simulado)"
          variant="neutral"
          onPress={() => Alert.alert('Simulado', 'Captura de foto simulada.')}
          style={styles.button}
        />

        <PrimaryButton
          label="Marcar como ENTREGUE"
          variant="success"
          onPress={() => setStatus('CONCLUIDO')}
          loading={loading}
          style={styles.button}
        />

        <PrimaryButton
          label="Marcar FALHA"
          variant="danger"
          onPress={onFailDelivery}
          loading={loading}
          style={styles.button}
        />
      </View>

      <PrimaryButton
        label="Próxima entrega"
        onPress={() => navigation.goBack()}
        style={styles.nextButton}
      />
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
  nextButton: {
    marginTop: 10
  }
});
