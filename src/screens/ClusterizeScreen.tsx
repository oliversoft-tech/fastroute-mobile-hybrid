import { useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { PrimaryButton } from '../components/PrimaryButton';
import { clusterizeAddresses } from '../api/clusteringApi';
import { ClusterResult } from '../api/types';
import { getApiError } from '../api/httpClient';

type Props = NativeStackScreenProps<RootStackParamList, 'Clusterize'>;

interface ClusterSummary {
  clusterId: number;
  totalAddresses: number;
  sampleAddressId: number;
}

export function ClusterizeScreen({ navigation }: Props) {
  const [eps, setEps] = useState('0.01');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ClusterResult[]>([]);

  const clusters = useMemo<ClusterSummary[]>(() => {
    const grouped = new Map<number, number[]>();

    results.forEach((entry) => {
      const addresses = grouped.get(entry.cluster_id) ?? [];
      addresses.push(entry.address_id);
      grouped.set(entry.cluster_id, addresses);
    });

    return Array.from(grouped.entries())
      .map(([clusterId, addressIds]) => ({
        clusterId,
        totalAddresses: addressIds.length,
        sampleAddressId: addressIds[0]
      }))
      .sort((a, b) => a.clusterId - b.clusterId);
  }, [results]);

  const onClusterize = async () => {
    const parsedEps = Number(eps.replace(',', '.'));

    if (!Number.isFinite(parsedEps) || parsedEps <= 0) {
      Alert.alert('Valor inválido', 'Informe um valor de eps maior que zero.');
      return;
    }

    try {
      setLoading(true);
      const data = await clusterizeAddresses(parsedEps);
      setResults(data);
    } catch (error) {
      Alert.alert('Erro na clusterização', getApiError(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.title}>Clusterização de Endereços</Text>
        <Text style={styles.subtitle}>Execute o DBSCAN e gere clusters para criação de rotas.</Text>

        <Text style={styles.label}>eps</Text>
        <TextInput
          value={eps}
          onChangeText={setEps}
          keyboardType="decimal-pad"
          style={styles.input}
          placeholder="0.01"
          placeholderTextColor={colors.textSecondary}
        />

        <PrimaryButton
          label="Executar clusterização"
          onPress={onClusterize}
          loading={loading}
        />
      </View>

      {clusters.length > 0 ? (
        <View style={styles.listCard}>
          <Text style={styles.listTitle}>Clusters gerados</Text>
          {clusters.map((cluster) => (
            <TouchableOpacity
              key={cluster.clusterId}
              style={styles.clusterItem}
              onPress={() => navigation.navigate('CreateRouteManual', { clusterId: cluster.clusterId })}
            >
              <View style={styles.clusterMain}>
                <Text style={styles.clusterText}>Cluster #{cluster.clusterId}</Text>
                <Text style={styles.clusterSub}>
                  {cluster.totalAddresses} endereços • exemplo {cluster.sampleAddressId}
                </Text>
              </View>
              <Text style={styles.clusterAction}>Criar rota</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      <PrimaryButton
        label="Criar rota manual"
        variant="neutral"
        onPress={() => navigation.navigate('CreateRouteManual')}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 16,
    gap: 12,
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
    color: colors.textSecondary
  },
  label: {
    color: colors.textSecondary,
    fontWeight: '700',
    fontSize: 12,
    textTransform: 'uppercase',
    marginTop: 4
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: colors.textPrimary,
    backgroundColor: '#fff'
  },
  listCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 8
  },
  listTitle: {
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 16
  },
  clusterItem: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10
  },
  clusterMain: {
    flex: 1
  },
  clusterText: {
    color: colors.textPrimary,
    fontWeight: '700'
  },
  clusterSub: {
    color: colors.textSecondary,
    marginTop: 2,
    fontSize: 12
  },
  clusterAction: {
    color: colors.primary,
    fontWeight: '700'
  }
});
