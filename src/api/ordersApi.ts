import { ImportResult } from './types';
import { enqueueSyncOperation } from '../offline/localDb';

interface LocalFile {
  uri: string;
  name: string;
  mimeType?: string;
  webFile?: Blob;
}

export async function importOrders(file: LocalFile): Promise<ImportResult> {
  await enqueueSyncOperation('IMPORT_ROUTE_FILE', {
    uri: file.uri,
    name: file.name,
    mimeType: file.mimeType ?? 'application/octet-stream'
  });

  return {
    orders_created: 0,
    addresses_created: 0,
    routes_generated: 0
  };
}

