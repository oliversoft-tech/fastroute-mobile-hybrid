import { ImportResult } from './types';
import { httpClient } from './httpClient';

interface LocalFile {
  uri: string;
  name: string;
  mimeType?: string;
  webFile?: Blob;
}

export async function importOrders(file: LocalFile) {
  const formData = new FormData();

  if (file.webFile) {
    formData.append('file', file.webFile, file.name);
  } else {
    formData.append('file', {
      uri: file.uri,
      name: file.name,
      type: file.mimeType ?? 'application/octet-stream'
    } as unknown as Blob);
  }

  const { data } = await httpClient.post<ImportResult | string | null>('route/import', formData);

  if (typeof data === 'object' && data !== null) {
    return {
      orders_created: data.orders_created ?? 0,
      addresses_created: data.addresses_created ?? 0,
      routes_generated: data.routes_generated ?? 0
    };
  }

  return {
    orders_created: 0,
    addresses_created: 0,
    routes_generated: 0
  };
}
