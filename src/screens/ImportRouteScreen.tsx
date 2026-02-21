import { useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { PrimaryButton } from '../components/PrimaryButton';
import { importOrders } from '../api/ordersApi';
import { getApiError } from '../api/httpClient';
import { ImportResult } from '../api/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ImportRoute'>;

export function ImportRouteScreen({ navigation }: Props) {
  const [selectedFile, setSelectedFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const pickFile = async () => {
    const response = await DocumentPicker.getDocumentAsync({
      type: [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'text/csv'
      ],
      multiple: false,
      copyToCacheDirectory: true
    });

    if (!response.canceled && response.assets.length > 0) {
      setSelectedFile(response.assets[0]);
      setResult(null);
    }
  };

  const onImport = async () => {
    if (!selectedFile) {
      Alert.alert('Arquivo obrigatório', 'Selecione um arquivo XLSX ou CSV para continuar.');
      return;
    }

    try {
      setLoading(true);
      const payload = await importOrders({
        uri: selectedFile.uri,
        name: selectedFile.name,
        mimeType: selectedFile.mimeType,
        webFile: (selectedFile as DocumentPicker.DocumentPickerAsset & { file?: Blob }).file
      });
      setResult(payload);
      Alert.alert('Importação concluída', 'Pedidos importados com sucesso.');
      navigation.goBack();
    } catch (error) {
      Alert.alert('Erro na importação', getApiError(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.title}>Importar arquivo de rota</Text>
        <Text style={styles.subtitle}>Selecione um arquivo de pedidos para importação.</Text>

        <TouchableOpacity style={styles.dropzone} onPress={pickFile}>
          <Text style={styles.dropzoneTitle}>Toque para selecionar</Text>
          <Text style={styles.dropzoneSub}>XLSX ou CSV</Text>
        </TouchableOpacity>

        {selectedFile ? (
          <View style={styles.fileCard}>
            <Text style={styles.fileName}>{selectedFile.name}</Text>
            <Text style={styles.fileMeta}>{Math.round((selectedFile.size ?? 0) / 1024)} KB</Text>
          </View>
        ) : null}

        <PrimaryButton
          label="Confirmar importação"
          onPress={onImport}
          loading={loading}
          disabled={!selectedFile}
        />

        <PrimaryButton
          label="Voltar"
          variant="neutral"
          onPress={() => navigation.goBack()}
          style={styles.secondaryButton}
        />
      </View>

      {result ? (
        <View style={styles.resultCard}>
          <Text style={styles.resultTitle}>Resumo da importação</Text>
          <Text style={styles.resultItem}>Pedidos criados: {result.orders_created}</Text>
          <Text style={styles.resultItem}>Endereços criados: {result.addresses_created}</Text>
          <Text style={styles.resultItem}>Rotas geradas: {result.routes_generated}</Text>
        </View>
      ) : null}
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
    fontSize: 18,
    fontWeight: '800',
    color: colors.textPrimary
  },
  subtitle: {
    color: colors.textSecondary
  },
  dropzone: {
    marginTop: 6,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#9BB1DA',
    borderRadius: 12,
    backgroundColor: '#F8FAFF',
    paddingVertical: 24,
    alignItems: 'center'
  },
  dropzoneTitle: {
    color: colors.primary,
    fontWeight: '700'
  },
  dropzoneSub: {
    color: colors.textSecondary,
    marginTop: 4
  },
  fileCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    backgroundColor: '#fff'
  },
  fileName: {
    color: colors.textPrimary,
    fontWeight: '700'
  },
  fileMeta: {
    marginTop: 2,
    color: colors.textSecondary,
    fontSize: 12
  },
  secondaryButton: {
    marginTop: 4
  },
  resultCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14
  },
  resultTitle: {
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: 6
  },
  resultItem: {
    color: colors.textSecondary,
    marginBottom: 3
  }
});
