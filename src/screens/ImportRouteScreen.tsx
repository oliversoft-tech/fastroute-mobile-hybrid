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
import { getRouteDetails, listRouteWaypoints, listRoutes } from '../api/routesApi';

type Props = NativeStackScreenProps<RootStackParamList, 'ImportRoute'>;

export function ImportRouteScreen({ navigation }: Props) {
  const [selectedFile, setSelectedFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [recentFiles, setRecentFiles] = useState<Array<{ name: string; sizeKb: number; type: string }>>([]);

  const toRecentFileEntry = (file: DocumentPicker.DocumentPickerAsset) => ({
    name: file.name,
    sizeKb: Math.round((file.size ?? 0) / 1024),
    type: file.mimeType?.includes('json')
      ? 'JSON'
      : file.mimeType?.includes('sheet') || file.mimeType?.includes('excel')
        ? 'XLSX'
        : 'CSV'
  });

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
      const file = response.assets[0];
      setSelectedFile(file);
      setResult(null);
    }
  };

  const resolveCreatedRouteId = async (
    payload: ImportResult,
    previousRouteIds: Set<number>
  ) => {
    if (payload.route_id) {
      return payload.route_id;
    }

    if (payload.route_ids && payload.route_ids.length > 0) {
      return payload.route_ids[0];
    }

    const routesAfterImport = await listRoutes();
    if (routesAfterImport.length === 0) {
      return null;
    }

    const candidates = routesAfterImport.filter((entry) => !previousRouteIds.has(entry.id));
    if (candidates.length === 0) {
      return null;
    }

    const sortedRoutes = [...candidates].sort((a, b) => {
      const dateA = Date.parse(a.created_at);
      const dateB = Date.parse(b.created_at);
      if (Number.isFinite(dateA) && Number.isFinite(dateB) && dateA !== dateB) {
        return dateB - dateA;
      }

      return b.id - a.id;
    });

    return sortedRoutes[0].id;
  };

  const onImport = async () => {
    if (!selectedFile) {
      Alert.alert('Arquivo obrigatório', 'Selecione um arquivo XLSX ou CSV para continuar.');
      return;
    }

    try {
      setLoading(true);
      const routesBeforeImport = await listRoutes();
      const previousRouteIds = new Set(routesBeforeImport.map((entry) => entry.id));
      const payload = await importOrders({
        uri: selectedFile.uri,
        name: selectedFile.name,
        mimeType: selectedFile.mimeType,
        webFile: (selectedFile as DocumentPicker.DocumentPickerAsset & { file?: Blob }).file
      });
      setResult(payload);
      const importedEntry = toRecentFileEntry(selectedFile);
      setRecentFiles((prev) => [importedEntry, ...prev.filter((entry) => entry.name !== importedEntry.name)].slice(0, 5));

      const routeId = await resolveCreatedRouteId(payload, previousRouteIds);
      if (!routeId) {
        Alert.alert(
          'Importação concluída',
          'Pedidos importados com sucesso, mas o backend não retornou o ID da nova rota.'
        );
        navigation.goBack();
        return;
      }

      const detail = await getRouteDetails(routeId);
      const waypoints =
        detail.waypoints && detail.waypoints.length > 0
          ? detail.waypoints
          : await listRouteWaypoints(routeId);

      if (waypoints.length === 0) {
        Alert.alert('Importação concluída', 'Rota criada, mas sem waypoints para reordenação.');
        navigation.replace('RouteDetail', { routeId });
        return;
      }

      Alert.alert(
        'Importação concluída',
        'Rota Importada com Sucesso. Você pode alterar a ordem dos pontos da rota arrastando-os uns sobre os outros, se desejar.'
      );
      navigation.replace('Map', {
        routeId,
        waypoints
      });
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

        <TouchableOpacity style={styles.linkInline} onPress={() => navigation.navigate('FileBrowser')}>
          <Text style={styles.linkInlineText}>Abrir arquivos locais</Text>
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

      <View style={styles.resultCard}>
        <View style={styles.recentHeader}>
          <Text style={styles.resultTitle}>Arquivos Recentes</Text>
          <TouchableOpacity onPress={() => setRecentFiles([])}>
            <Text style={styles.clearText}>Limpar histórico</Text>
          </TouchableOpacity>
        </View>
        {recentFiles.length === 0 ? (
          <Text style={styles.resultItem}>Nenhum arquivo recente.</Text>
        ) : (
          recentFiles.map((file) => (
            <TouchableOpacity
              key={file.name}
              style={styles.recentRow}
              onPress={() => {
                Alert.alert('Arquivo selecionado', file.name);
              }}
            >
              <View style={styles.recentIconWrap}>
                <Text style={styles.recentIcon}>{file.type.slice(0, 1)}</Text>
              </View>
              <View style={styles.recentTextCol}>
                <Text style={styles.fileName}>{file.name}</Text>
                <Text style={styles.fileMeta}>{file.sizeKb} KB</Text>
              </View>
              <Text style={styles.recentArrow}>›</Text>
            </TouchableOpacity>
          ))
        )}
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
  linkInline: {
    alignSelf: 'flex-start'
  },
  linkInlineText: {
    color: colors.primary,
    fontWeight: '700',
    fontSize: 12
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
  recentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8
  },
  resultTitle: {
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: 6
  },
  clearText: {
    color: colors.primary,
    fontWeight: '700',
    fontSize: 12
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  recentIconWrap: {
    width: 24,
    height: 24,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF4FF'
  },
  recentIcon: {
    color: colors.primary,
    fontWeight: '800',
    fontSize: 11
  },
  recentTextCol: {
    marginLeft: 10,
    flex: 1
  },
  recentArrow: {
    color: colors.textSecondary,
    fontSize: 18,
    lineHeight: 18
  },
  resultItem: {
    color: colors.textSecondary,
    marginBottom: 3
  }
});
