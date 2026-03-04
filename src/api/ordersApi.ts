import { ImportResult } from './types';
import { enqueueSyncOperation } from '../offline/localDb';

interface LocalFile {
  uri: string;
  name: string;
  mimeType?: string;
  webFile?: Blob;
  epsMeters?: number;
}

export async function importOrders(file: LocalFile): Promise<ImportResult> {
  const parsedEpsMeters = Number(file.epsMeters);
  const normalizedEps = Number.isFinite(parsedEpsMeters) && parsedEpsMeters > 0
    ? Math.trunc(parsedEpsMeters)
    : undefined;

  await enqueueSyncOperation('IMPORT_ROUTE_FILE', {
    uri: file.uri,
    name: file.name,
    mimeType: file.mimeType ?? 'application/octet-stream',
    eps_meters: normalizedEps,
    eps: normalizedEps
  });

  return {
    orders_created: 0,
    addresses_created: 0,
    routes_generated: 0
  };
}
