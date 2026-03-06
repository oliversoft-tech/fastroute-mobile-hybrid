import {
  clusterizeAddressPointsByMeters,
  generateWaypointsForCluster,
  groupByClusterId
} from '@oliverbill/fastroute-domain';
import * as FileSystem from 'expo-file-system';
import * as XLSX from 'xlsx';
import { ImportResult, Waypoint } from './types';
import {
  enqueueSyncOperation,
  getLocalDb,
  replaceLocalRouteWaypoints,
  upsertLocalRoute
} from '../offline/localDb';
import { loadAuthSession } from '../utils/authStorage';

interface LocalFile {
  uri: string;
  name: string;
  mimeType?: string;
  webFile?: Blob;
  epsMeters?: number;
}

type ImportRow = Record<string, unknown>;
type ImportPoint = {
  address_id: number;
  lat: number;
  longitude: number;
  title?: string;
  subtitle?: string;
};

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

async function readFileAsUtf8(file: LocalFile) {
  if (file.webFile) {
    return file.webFile.text();
  }

  return FileSystem.readAsStringAsync(file.uri, {
    encoding: FileSystem.EncodingType.UTF8
  });
}

function parseCsvLine(line: string) {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  out.push(current.trim());
  return out;
}

function parseCsvRows(raw: string): ImportRow[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error('Arquivo sem linhas suficientes para importação.');
  }

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row: ImportRow = {};
    headers.forEach((header, index) => {
      row[header] = cols[index] ?? null;
    });
    return row;
  });
}

function parseJsonRows(raw: string): ImportRow[] {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Arquivo JSON inválido.');
  }

  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is ImportRow => Boolean(item && typeof item === 'object'));
  }

  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { addresses?: unknown[] }).addresses)) {
    return ((parsed as { addresses: unknown[] }).addresses).filter(
      (item): item is ImportRow => Boolean(item && typeof item === 'object')
    );
  }

  throw new Error('JSON inválido: esperado array de endereços.');
}

async function parseXlsxRows(file: LocalFile): Promise<ImportRow[]> {
  let workbook: XLSX.WorkBook;
  if (file.webFile) {
    const buffer = await file.webFile.arrayBuffer();
    workbook = XLSX.read(buffer, { type: 'array' });
  } else {
    const base64 = await readFileAsBase64(file);
    workbook = XLSX.read(base64, { type: 'base64' });
  }

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error('Planilha sem abas válidas.');
  }
  const worksheet = workbook.Sheets[firstSheetName];
  if (!worksheet) {
    throw new Error('Planilha inválida.');
  }

  const rows = XLSX.utils.sheet_to_json<ImportRow>(worksheet, {
    defval: null,
    raw: false
  });
  if (rows.length === 0) {
    throw new Error('Planilha vazia.');
  }
  return rows;
}

function normalizeHeader(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function getRowValue(row: ImportRow, candidateKeys: string[]) {
  const normalizedMap = new Map<string, unknown>();
  Object.entries(row).forEach(([key, value]) => {
    normalizedMap.set(normalizeHeader(key), value);
  });

  for (const key of candidateKeys) {
    const value = normalizedMap.get(normalizeHeader(key));
    if (value === undefined || value === null || value === '') {
      continue;
    }
    return value;
  }

  return null;
}

function toFiniteNumber(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return NaN;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function toText(value: unknown) {
  if (value === null || value === undefined) {
    return undefined;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function extractImportPoints(rows: ImportRow[]) {
  const points: ImportPoint[] = [];
  const usedAddressIds = new Set<number>();
  let fallbackAddressId = 1;

  rows.forEach((row, index) => {
    const lat = toFiniteNumber(
      getRowValue(row, [
        'lat',
        'latitude',
        'receiver to latitude',
        'actual delivery latitude',
        'actual_delivery_latitude'
      ])
    );
    const longitude = toFiniteNumber(
      getRowValue(row, [
        'longitude',
        'long',
        'lng',
        'receiver to longitude',
        'actual delivery longitude',
        'actual_delivery_longitude'
      ])
    );

    if (!Number.isFinite(lat) || !Number.isFinite(longitude)) {
      return;
    }

    const addressIdRaw = toFiniteNumber(
      getRowValue(row, ['address_id', 'address id', 'addressid', 'id', 'waybill number'])
    );

    let addressId = Number.isFinite(addressIdRaw) && addressIdRaw > 0 ? Math.trunc(addressIdRaw) : index + 1;
    if (usedAddressIds.has(addressId) || addressId <= 0) {
      while (usedAddressIds.has(fallbackAddressId)) {
        fallbackAddressId += 1;
      }
      addressId = fallbackAddressId;
      fallbackAddressId += 1;
    }
    usedAddressIds.add(addressId);

    const title = toText(
      getRowValue(row, [
        'detailed_address',
        'detailed address',
        'address',
        'full_address',
        'receiver to street'
      ])
    );

    const subtitle = toText(
      getRowValue(row, ['postal_code', 'zip', 'city', 'zipcode', 'receiver to city'])
    );

    points.push({
      address_id: addressId,
      lat,
      longitude,
      title,
      subtitle
    });
  });

  return points;
}

async function parseImportRows(file: LocalFile) {
  const filename = file.name.toLowerCase();
  const mimetype = String(file.mimeType ?? '').toLowerCase();

  if (filename.endsWith('.xlsx') || filename.endsWith('.xls') || mimetype.includes('sheet') || mimetype.includes('excel')) {
    return parseXlsxRows(file);
  }

  const raw = (await readFileAsUtf8(file)).trim();
  if (!raw) {
    throw new Error('Arquivo vazio.');
  }

  if (filename.endsWith('.json') || mimetype.includes('json')) {
    return parseJsonRows(raw);
  }

  return parseCsvRows(raw);
}

async function getNextIds() {
  const db = await getLocalDb();
  const routeRow = await db.getFirstAsync<{ maxId: number }>('SELECT COALESCE(MAX(id), 0) AS maxId FROM routes');
  const waypointRow = await db.getFirstAsync<{ maxId: number }>(
    'SELECT COALESCE(MAX(id), 0) AS maxId FROM waypoints'
  );

  return {
    nextRouteId: Math.trunc(Number(routeRow?.maxId ?? 0)) + 1,
    nextWaypointId: Math.trunc(Number(waypointRow?.maxId ?? 0)) + 1
  };
}

export async function importOrders(file: LocalFile): Promise<ImportResult> {
  const parsedEpsMeters = Number(file.epsMeters);
  const normalizedEps = Number.isFinite(parsedEpsMeters) && parsedEpsMeters > 0
    ? Math.trunc(parsedEpsMeters)
    : 50;

  const rows = await parseImportRows(file);
  const points = extractImportPoints(rows);
  if (points.length === 0) {
    throw new Error('Nenhum ponto com latitude/longitude válido encontrado no arquivo.');
  }

  const clusterized =
    points.length === 1
      ? {
          ok: true as const,
          value: [{ ...points[0], cluster_id: 1 }]
        }
      : clusterizeAddressPointsByMeters(
          points.map((point) => ({
            address_id: point.address_id,
            lat: point.lat,
            longitude: point.longitude
          })),
          { epsMeters: normalizedEps, minPts: 2 }
        );

  if (!clusterized.ok) {
    throw new Error(clusterized.error);
  }

  const metadataByAddressId = new Map<number, { title?: string; subtitle?: string; lat: number; longitude: number }>();
  points.forEach((point) => {
    metadataByAddressId.set(point.address_id, {
      title: point.title,
      subtitle: point.subtitle,
      lat: point.lat,
      longitude: point.longitude
    });
  });

  const grouped = groupByClusterId(clusterized.value);
  const clusterEntries = Object.entries(grouped)
    .map(([key, value]) => ({
      clusterId: Math.trunc(Number(key)),
      points: value
    }))
    .filter((entry) => Array.isArray(entry.points) && entry.points.length > 0)
    .sort((a, b) => a.clusterId - b.clusterId);

  if (clusterEntries.length === 0) {
    throw new Error('Não foi possível gerar clusters a partir dos pontos importados.');
  }

  let { nextRouteId, nextWaypointId } = await getNextIds();
  const createdAt = new Date().toISOString();
  const routeIds: number[] = [];
  const authSession = await loadAuthSession().catch(() => null);
  const parsedDriverId = Math.trunc(Number(authSession?.userId ?? 0));
  const driverId = Number.isFinite(parsedDriverId) && parsedDriverId > 0 ? parsedDriverId : null;

  for (const [clusterIndex, clusterEntry] of clusterEntries.entries()) {
    const routeId = nextRouteId;
    nextRouteId += 1;
    routeIds.push(routeId);

    const domainWaypoints = generateWaypointsForCluster({
      route_id: routeId,
      cluster_id: clusterEntry.clusterId > 0 ? clusterEntry.clusterId : clusterIndex + 1,
      addresses: clusterEntry.points.map((point) => ({ address_id: point.address_id }))
    });

    if (!domainWaypoints.ok) {
      throw new Error(domainWaypoints.error);
    }

    const waypoints: Waypoint[] = domainWaypoints.value.map((waypoint) => {
      const metadata = metadataByAddressId.get(waypoint.address_id);
      const builtWaypoint: Waypoint = {
        id: nextWaypointId,
        route_id: routeId,
        address_id: waypoint.address_id,
        seq_order: waypoint.seq_order,
        status: 'PENDENTE',
        title: metadata?.title,
        subtitle: metadata?.subtitle,
        latitude: metadata?.lat,
        longitude: metadata?.longitude
      };
      nextWaypointId += 1;
      return builtWaypoint;
    });

    await upsertLocalRoute({
      id: routeId,
      cluster_id: clusterEntry.clusterId > 0 ? clusterEntry.clusterId : clusterIndex + 1,
      status: 'CRIADA',
      created_at: createdAt,
      waypoints_count: waypoints.length
    });
    await replaceLocalRouteWaypoints(routeId, waypoints);
  }

  await enqueueSyncOperation('IMPORT_ROUTE_FILE', {
    file_name: file.name,
    mime_type: file.mimeType ?? 'application/octet-stream',
    eps_meters: normalizedEps,
    route_ids: routeIds,
    user_id: driverId
  });

  return {
    orders_created: rows.length,
    addresses_created: points.length,
    routes_generated: routeIds.length,
    route_ids: routeIds,
    route_id: routeIds.length === 1 ? routeIds[0] : undefined
  };
}
