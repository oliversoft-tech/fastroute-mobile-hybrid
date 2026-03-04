import { ImportResult } from './types';
import { enqueueSyncOperation } from '../offline/localDb';
import * as FileSystem from 'expo-file-system';

interface LocalFile {
  uri: string;
  name: string;
  mimeType?: string;
  webFile?: Blob;
  epsMeters?: number;
}

async function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Falha ao converter arquivo para base64.'));
        return;
      }
      const [, base64 = ''] = result.split(',');
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Falha ao ler arquivo para importação.'));
    reader.readAsDataURL(blob);
  });
}

async function readFileAsBase64(file: LocalFile) {
  if (file.webFile) {
    return readBlobAsBase64(file.webFile);
  }

  return FileSystem.readAsStringAsync(file.uri, {
    encoding: FileSystem.EncodingType.Base64
  });
}

export async function importOrders(file: LocalFile): Promise<ImportResult> {
  const parsedEpsMeters = Number(file.epsMeters);
  const normalizedEps = Number.isFinite(parsedEpsMeters) && parsedEpsMeters > 0
    ? Math.trunc(parsedEpsMeters)
    : undefined;
  const fileBase64 = await readFileAsBase64(file);

  await enqueueSyncOperation('IMPORT_ROUTE_FILE', {
    uri: file.uri,
    name: file.name,
    file_name: file.name,
    mimeType: file.mimeType ?? 'application/octet-stream',
    file_mime_type: file.mimeType ?? 'application/octet-stream',
    file_base64: fileBase64,
    content_base64: fileBase64,
    eps_meters: normalizedEps,
    eps: normalizedEps
  });

  return {
    orders_created: 0,
    addresses_created: 0,
    routes_generated: 0
  };
}
