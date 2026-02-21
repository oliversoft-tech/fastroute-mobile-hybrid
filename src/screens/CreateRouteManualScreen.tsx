import { useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { PrimaryButton } from '../components/PrimaryButton';
import { createRoute } from '../api/routesApi';
import { getApiError } from '../api/httpClient';

type Props = NativeStackScreenProps<RootStackParamList, 'CreateRouteManual'>;

export function CreateRouteManualScreen({ route, navigation }: Props) {
  const initialCluster = route.params?.clusterId;
  const [clusterId, setClusterId] = useState(initialCluster ? String(initialCluster) : '');
  const [loading, setLoading] = useState(false);

  const clusterHint = useMemo(() => {
    if (!initialCluster) {
      return 'Informe um cluster_id para criar a rota manualmente.';
    }

    return `Cluster sugerido pela clusterização: ${initialCluster}`;
  }, [initialCluster]);

  const onCreate = async () => {
    const parsedCluster = Number(clusterId);

    if (!Number.isInteger(parsedCluster) || parsedCluster < 0) {
      Alert.alert('Cluster inválido', 'Digite um cluster_id numérico válido.');
      return;
    }

    try {
      setLoading(true);
      const created = await createRoute(parsedCluster);
      Alert.alert('Rota criada', `Rota #${created.id} criada com sucesso.`);
      navigation.replace('RouteDetail', { routeId: created.id });
    } catch (error) {
      Alert.alert('Erro ao criar rota', getApiError(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.title}>Criar Rota Manual</Text>
        <Text style={styles.subtitle}>{clusterHint}</Text>

        <Text style={styles.label}>cluster_id</Text>
        <TextInput
          value={clusterId}
          onChangeText={setClusterId}
          keyboardType="number-pad"
          style={styles.input}
          placeholder="Ex: 1"
          placeholderTextColor={colors.textSecondary}
        />

        <PrimaryButton label="Criar rota" onPress={onCreate} loading={loading} />
        <PrimaryButton label="Voltar" variant="neutral" onPress={() => navigation.goBack()} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 16,
    paddingBottom: 24
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 10
  },
  title: {
    color: colors.textPrimary,
    fontWeight: '800',
    fontSize: 18
  },
  subtitle: {
    color: colors.textSecondary,
    marginBottom: 4
  },
  label: {
    color: colors.textSecondary,
    fontWeight: '700',
    fontSize: 12,
    textTransform: 'uppercase'
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: colors.textPrimary,
    backgroundColor: '#fff'
  }
});
