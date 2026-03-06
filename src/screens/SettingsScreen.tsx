import { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { PrimaryButton } from '../components/PrimaryButton';
import {
  getDailySyncTime,
  getLastSyncAt,
  setDailySyncTime
} from '../offline/localDb';
import { formatSyncSummary, syncNow } from '../offline/syncEngine';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

function formatLastSync(value: string | null) {
  if (!value) {
    return 'Nunca sincronizado';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function normalizeTime(value: string) {
  const trimmed = value.trim();
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function SettingsScreen({ navigation }: Props) {
  const [dailySyncTime, setDailySyncTimeInput] = useState('19:00');
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [time, lastSync] = await Promise.all([getDailySyncTime(), getLastSyncAt()]);
      setDailySyncTimeInput(time);
      setLastSyncAt(lastSync);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void loadData();
    }, [loadData])
  );

  const onSaveTime = async () => {
    const normalized = normalizeTime(dailySyncTime);
    if (!normalized) {
      Alert.alert('Horário inválido', 'Use formato HH:mm (ex: 19:00).');
      return;
    }
    await setDailySyncTime(normalized);
    setDailySyncTimeInput(normalized);
    Alert.alert('Configuração salva', `Sync diário definido para ${normalized}.`);
  };

  const onManualSync = async () => {
    try {
      setLoading(true);
      const result = await syncNow('manual');
      await loadData();
      if (result.ok) {
        Alert.alert('Sync concluído', formatSyncSummary(result), [
          {
            text: 'OK',
            onPress: () => navigation.goBack()
          }
        ]);
        return;
      }
      Alert.alert('Falha no sync', formatSyncSummary(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao sincronizar.';
      Alert.alert('Falha no sync', message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void loadData();
          }}
        />
      }
    >
      <View style={styles.card}>
        <Text style={styles.title}>Sincronização</Text>

        <Text style={styles.label}>Horário da sincronização diária (HH:mm)</Text>
        <TextInput
          value={dailySyncTime}
          onChangeText={setDailySyncTimeInput}
          style={styles.input}
          placeholder="19:00"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
        />

        <PrimaryButton
          label="Salvar horário"
          onPress={() => {
            void onSaveTime();
          }}
          disabled={loading}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Última sincronização</Text>
        <Text style={styles.value}>{formatLastSync(lastSyncAt)}</Text>

        <PrimaryButton
          label="Sincronizar agora"
          onPress={() => {
            void onManualSync();
          }}
          loading={loading}
          style={styles.syncButton}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 20
  },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 14,
    gap: 10
  },
  title: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '800'
  },
  label: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  value: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '700'
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.textPrimary,
    backgroundColor: '#fff'
  },
  syncButton: {
    marginTop: 6
  }
});
