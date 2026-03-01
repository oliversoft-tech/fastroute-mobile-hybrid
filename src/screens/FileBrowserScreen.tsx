import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { setPendingImportFile } from '../state/importFileSelection';

type Props = NativeStackScreenProps<RootStackParamList, 'FileBrowser'>;

const folders = [
  { name: 'pedidos_driver_a.xlsx', date: '2.4 MB', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { name: 'Documents.csv', date: '512 KB', highlight: true, mimeType: 'text/csv' },
  { name: 'Download.xlsx', date: '1.8 MB', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { name: 'epsxe.csv', date: '350 KB', mimeType: 'text/csv' }
];

export function FileBrowserScreen({ navigation }: Props) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.container}>
        {folders.map((folder) => (
          <TouchableOpacity
            key={folder.name}
            style={[styles.row, folder.highlight && styles.highlightRow]}
            onPress={() => {
              setPendingImportFile({
                uri: `file:///local/${folder.name}`,
                name: folder.name,
                mimeType: folder.mimeType,
                size: folder.date.includes('MB')
                  ? Math.round(Number(folder.date.replace('MB', '').trim()) * 1024 * 1024)
                  : Math.round(Number(folder.date.replace('KB', '').trim()) * 1024)
              });
              navigation.goBack();
            }}
          >
            <Text style={styles.icon}>[]</Text>
            <View style={styles.textCol}>
              <Text style={styles.title}>{folder.name}</Text>
              <Text style={styles.sub}>{folder.date}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 16,
    paddingBottom: 24
  },
  container: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: '#f1f1f1',
    overflow: 'hidden'
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#dedede',
    backgroundColor: '#f5f5f5'
  },
  highlightRow: {
    borderWidth: 2,
    borderColor: '#18d43f',
    marginHorizontal: 2,
    marginVertical: 2,
    borderRadius: 4,
    backgroundColor: '#fff'
  },
  icon: {
    fontSize: 18
  },
  textCol: {
    marginLeft: 10
  },
  title: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  sub: {
    marginTop: 2,
    color: colors.textSecondary,
    fontSize: 12
  }
});
