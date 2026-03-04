import { useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { PrimaryButton } from '../components/PrimaryButton';
import { importOrders } from '../api/ordersApi';
import { getApiError } from '../api/httpClient';
import { ImportResult } from '../api/types';
import { listRouteWaypoints, listRoutes } from '../api/routesApi';
import { consumePendingImportFile } from '../state/importFileSelection';
import { useCallback } from 'react';

type Props = NativeStackScreenProps<RootStackParamList, 'ImportRoute'>;

export function ImportRouteScreen({ navigation }: Props) {
  const [selectedFile, setSelectedFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [loading, setLoading] = useState(false);
  const [epsMeters, setEpsMeters] = useState('50');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [recentFiles, setRecentFiles] = useState<Array<{ name: string; sizeKb: number; type: string }>>([]);

  useFocusEffect(
    useCallback(() => {
      const localSelection = consumePendingImportFile();
      if (!localSelection) {
        return;
      }

      setSelectedFile({
        uri: localSelection.uri,
        name: localSelection.name,
        mimeType: localSelection.mimeType,
        size: localSelection.size
      } as DocumentPicker.DocumentPickerAsset);
      setResult(null);
    }, [])
  );

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

  const onImport = async () => {
    if (!selectedFile) {
      Alert.alert('Arquivo obrigatório', 'Selecione um arquivo XLSX ou CSV para continuar.');
      return;
    }

    const parsedEpsMeters = Number(epsMeters);
    if (!Number.isFinite(parsedEpsMeters) || parsedEpsMeters <= 0) {
      Alert.alert('EPS inválido', 'Informe o EPS em metros com valor maior que zero.');
      return;
    }

    try {
      setLoading(true);
      const routesBeforeImport = await listRoutes({ forceRefresh: true });
      const routeIdsBeforeImport = new Set(routesBeforeImport.map((route) => route.id));

      const payload = await importOrders({
        uri: selectedFile.uri,
        name: selectedFile.name,
        mimeType: selectedFile.mimeType,
        epsMeters: Math.trunc(parsedEpsMeters),
        webFile: (selectedFile as DocumentPicker.DocumentPickerAsset & { file?: Blob }).file
      });
      setResult(payload);
      const importedEntry = toRecentFileEntry(selectedFile);
      setRecentFiles((prev) => [importedEntry, ...prev.filter((entry) => entry.name !== importedEntry.name)].slice(0, 5));

      const routes = await listRoutes({ forceRefresh: true });
      const routeIdsFromResponse = [
        ...(payload.route_ids ?? []),
        Number(payload.route_id)
      ]
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.trunc(value));
      const preferredRouteIds = [...new Set(routeIdsFromResponse)];
      const createdRouteIdsAfterImport = routes
        .filter((route) => !routeIdsBeforeImport.has(route.id))
        .map((route) => route.id);
      const importedRouteIds = [...new Set([...preferredRouteIds, ...createdRouteIdsAfterImport])]
        .sort((a, b) => a - b);

      if (importedRouteIds.length > 1) {
        const firstRouteId = importedRouteIds[0];
        const firstRoute = routes.find((entry) => entry.id === firstRouteId) ?? null;
        const firstRouteWaypoints = await listRouteWaypoints(firstRouteId, { forceRefresh: true });
        navigation.replace('Map', {
          routeId: firstRouteId,
          routeIds: importedRouteIds,
          importEpsMeters: Math.trunc(parsedEpsMeters),
          waypoints: firstRouteWaypoints,
          routeStatus: firstRoute?.status
        });
        return;
      }

      const routeCreatedAfterImport = routes.find((route) => !routeIdsBeforeImport.has(route.id));
      const targetRoute =
        routes.find((route) => importedRouteIds.includes(route.id)) ??
        routeCreatedAfterImport;

      if (!targetRoute) {
        navigation.replace('Routes');
        return;
      }

      const waypoints = await listRouteWaypoints(targetRoute.id, { forceRefresh: true });
      navigation.replace('Map', {
        routeId: targetRoute.id,
        waypoints,
        routeStatus: targetRoute.status,
        forceEnableReorderActions: true
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

        <View style={styles.inputBlock}>
          <Text style={styles.inputLabel}>EPS (metros)</Text>
          <TextInput
            value={epsMeters}
            onChangeText={setEpsMeters}
            keyboardType="number-pad"
            placeholder="Ex: 50"
            placeholderTextColor={colors.textSecondary}
            style={styles.input}
          />
        </View>

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
  inputBlock: {
    gap: 6
  },
  inputLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#fff',
    color: colors.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 10
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
