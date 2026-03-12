import { RouteDetail, RouteStatus, Waypoint, WaypointStatus } from '../api/types';
import { getApiError, getAuthAccessToken, httpClient } from '../api/httpClient';
import { buildFastRouteApiUrl } from '../config/api';
import { enrichWaypointsWithAddressData, resolveDriverUserIdFromAuthId } from '../api/supabaseDataApi';
import {
  applyLocalWaypointReorder,
  backfillPendingImportDriverId,
  SyncQueueItem,
  countPendingSyncOperations,
  deleteLocalRoute,
  getAppSetting,
  getCurrentDriverId,
  getDailySyncTime,
  getLocalRoute,
  getLocalWaypoint,
  getLastDailySyncDate,
  getLastSyncAt,
  isInitialSyncDone,
  listLocalWaypoints,
  listLocalRoutes,
  listPendingSyncOperations,
  markSyncOperationDone,
  markSyncOperationFailed,
  mergeRouteSnapshot,
  saveRouteSnapshot,
  setAppSetting,
  setCurrentDriverId,
  setInitialSyncDone,
  setLastDailySyncDate,
  setLastSyncAt,
  updateLocalRouteStatus,
  updateLocalWaypointStatus
} from './localDb';
import { loadAuthSession } from '../utils/authStorage';

type SyncTrigger = 'manual' | 'scheduled';

export interface SyncResult {
  ok: boolean;
  trigger: SyncTrigger;
  pulledRoutes: number;
  processedOperations: number;
  pendingOperations: number;
  error?: string;
}

interface SyncOptions {
  fullPull?: boolean;
}

type SyncFinishedListener = (result: SyncResult) => void;

interface ApiRecord {
  [key: string]: unknown;
}

interface ProcessPendingQueueResult {
  processed: number;
  failed: boolean;
  failedMessage: string | null;
  pushedItems: SyncQueueItem[];
  requiresRemoteOverwrite: boolean;
}

interface ProcessPendingQueueItemResult {
  item: SyncQueueItem;
  ok: boolean;
  failedMessage: string | null;
  pushed: boolean;
  requiresRemoteOverwrite: boolean;
}

interface PendingQueueItemWithLocks {
  item: SyncQueueItem;
  lockKeys: string[];
  queueIndex: number;
}

type SyncMutationEntityType = 'route' | 'route_waypoint';

interface SyncMutation {
  queueItemId: number;
  mutationId: string;
  deviceId: string;
  entityType: SyncMutationEntityType;
  entityId: number;
  op: string;
  baseVersion: number;
  payload: Record<string, unknown>;
  allowNotFound?: boolean;
}

interface SyncPushMutationResult {
  mutationId: string;
  status: string;
  serverVersion?: number;
}

interface PushSingleMutationResult {
  ok: boolean;
  message?: string;
  recoveredDuplicateCreate?: boolean;
}

interface PushMutationsResult {
  ok: boolean;
  message?: string;
  recoveredDuplicateCreate: boolean;
}

let syncInFlight: Promise<SyncResult> | null = null;
const syncFinishedListeners = new Set<SyncFinishedListener>();
const SYNC_TIMEOUT_MS = 180000;
const SYNC_PULL_HTTP_TIMEOUT_MS = 45000;
const SYNC_PUSH_HTTP_TIMEOUT_MS = 25000;
const SYNC_CONNECTIVITY_PROBE_TIMEOUT_MS = 3000;
const SYNC_PUSH_BATCH_SIZE = 30;
const SYNC_QUEUE_WORKERS = 3;
const MAX_TRANSIENT_PUSH_ATTEMPTS = 3;
const TRANSIENT_PUSH_RETRY_BASE_DELAYS_MS = [700, 1400];
const TRANSIENT_PUSH_RETRY_JITTER_MS = 500;
const ROUTE_STATUS_RANK: Record<RouteStatus, number> = {
  CRIADA: 1,
  PENDENTE: 2,
  EM_ROTA: 3,
  EM_ANDAMENTO: 3,
  FINALIZADA: 4
};
const WAYPOINT_STATUS_RANK: Record<WaypointStatus, number> = {
  PENDENTE: 1,
  REORDENADO: 2,
  EM_ROTA: 3,
  CONCLUIDO: 4,
  'FALHA TEMPO ADVERSO': 4,
  'FALHA MORADOR AUSENTE': 4
};
const SYNC_DEVICE_ID_KEY = 'sync_device_id';
const ROUTE_VERSION_KEY_PREFIX = 'sync_version_route_';
const WAYPOINT_VERSION_KEY_PREFIX = 'sync_version_waypoint_';

function normalizeText(value: unknown) {
  return String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function normalizeRouteStatus(value: unknown): RouteStatus {
  const normalized = normalizeText(value);

  if (normalized.includes('CRIADA')) {
    return 'CRIADA';
  }
  if (normalized.includes('EM_ROTA')) {
    return 'EM_ROTA';
  }
  if (normalized.includes('EM_ANDAMENTO') || normalized.includes('EM ANDAMENTO')) {
    return 'EM_ANDAMENTO';
  }
  if (normalized.includes('FINAL') || normalized.includes('CONCL')) {
    return 'FINALIZADA';
  }
  return 'PENDENTE';
}

function normalizeWaypointStatus(value: unknown): WaypointStatus {
  const normalized = normalizeText(value);

  if (normalized.includes('REORDEN')) {
    return 'REORDENADO';
  }
  if (normalized.includes('EM_ROTA')) {
    return 'EM_ROTA';
  }
  if (normalized.includes('FALHA TEMPO ADVERSO')) {
    return 'FALHA TEMPO ADVERSO';
  }
  if (normalized.includes('FALHA MORADOR AUSENTE')) {
    return 'FALHA MORADOR AUSENTE';
  }
  if (normalized.includes('CONCL') || normalized.includes('ENTREGUE')) {
    return 'CONCLUIDO';
  }
  return 'PENDENTE';
}

function toQueueRouteId(payload: Record<string, unknown>) {
  const routeId = Math.trunc(Number(payload.routeId ?? payload.route_id));
  if (!Number.isFinite(routeId) || routeId <= 0) {
    return null;
  }
  return routeId;
}

function toQueueWaypointId(payload: Record<string, unknown>) {
  const waypointId = Math.trunc(Number(payload.waypointId ?? payload.waypoint_id));
  if (!Number.isFinite(waypointId) || waypointId <= 0) {
    return null;
  }
  return waypointId;
}

function extractImportRouteIds(payload: Record<string, unknown>) {
  const routeIds = Array.isArray(payload.route_ids)
    ? payload.route_ids
        .map((entry) => Math.trunc(Number(entry)))
        .filter((routeId) => Number.isFinite(routeId) && routeId > 0)
    : [];

  if (routeIds.length === 0) {
    const routeId = toQueueRouteId(payload);
    if (routeId) {
      routeIds.push(routeId);
    }
  }

  return [...new Set(routeIds)].sort((a, b) => a - b);
}

function isTerminalWaypointStatus(status: WaypointStatus) {
  return status === 'CONCLUIDO' || status === 'FALHA TEMPO ADVERSO' || status === 'FALHA MORADOR AUSENTE';
}

function shouldUpgradeRouteStatus(current: RouteStatus, target: RouteStatus) {
  return ROUTE_STATUS_RANK[target] > ROUTE_STATUS_RANK[current];
}

function shouldUpgradeWaypointStatus(current: WaypointStatus, target: WaypointStatus) {
  return WAYPOINT_STATUS_RANK[target] > WAYPOINT_STATUS_RANK[current];
}

function normalizeQueuedWaypointStatus(value: unknown): WaypointStatus | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  if (normalized.includes('ENTREGUE') || normalized.includes('CONCLUID')) {
    return 'CONCLUIDO';
  }
  if (normalized.includes('FALHA TEMPO ADVERSO')) {
    return 'FALHA TEMPO ADVERSO';
  }
  if (normalized.includes('FALHA MORADOR AUSENTE')) {
    return 'FALHA MORADOR AUSENTE';
  }
  if (normalized.includes('EM_ROTA')) {
    return 'EM_ROTA';
  }
  if (normalized.includes('REORDEN')) {
    return 'REORDENADO';
  }
  if (normalized.includes('PEND')) {
    return 'PENDENTE';
  }
  return null;
}

function extractQueuedReorderedWaypoints(payload: Record<string, unknown>) {
  const rawList = Array.isArray(payload.reorderedWaypoints) ? payload.reorderedWaypoints : [];
  return rawList
    .map((entry) => asRecord(entry))
    .filter((entry): entry is ApiRecord => Boolean(entry))
    .map((entry) => ({
      seqorder: Math.trunc(Number(entry.seqorder)),
      waypoint_id: Math.trunc(Number(entry.waypoint_id))
    }))
    .filter(
      (entry) =>
        Number.isFinite(entry.seqorder) &&
        entry.seqorder > 0 &&
        Number.isFinite(entry.waypoint_id) &&
        entry.waypoint_id > 0
    );
}

function asRecord(value: unknown): ApiRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as ApiRecord;
}

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toOptionalPositiveInt(value: unknown): number | null {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function toNullableNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pickString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function decodeBase64UrlToUtf8(value: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const paddingSize = (4 - (normalized.length % 4)) % 4;
  const padded = `${normalized}${'='.repeat(paddingSize)}`;

  let bitsBuffer = 0;
  let bitsCount = 0;
  let binary = '';

  for (const char of padded) {
    if (char === '=') {
      break;
    }
    const charIndex = alphabet.indexOf(char);
    if (charIndex < 0) {
      return null;
    }

    bitsBuffer = (bitsBuffer << 6) | charIndex;
    bitsCount += 6;
    if (bitsCount >= 8) {
      bitsCount -= 8;
      binary += String.fromCharCode((bitsBuffer >> bitsCount) & 0xff);
    }
  }

  try {
    const escaped = binary
      .split('')
      .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join('');
    return decodeURIComponent(escaped);
  } catch {
    return binary;
  }
}

function parseJwtPayload(token?: string | null): ApiRecord | null {
  const normalizedToken = pickString(token);
  if (!normalizedToken) {
    return null;
  }

  const parts = normalizedToken.split('.');
  if (parts.length < 2) {
    return null;
  }

  const payloadRaw = decodeBase64UrlToUtf8(parts[1]);
  if (!payloadRaw) {
    return null;
  }

  try {
    return asRecord(JSON.parse(payloadRaw));
  } catch {
    return null;
  }
}

function extractAuthUserIdFromToken(token?: string | null) {
  const jwtPayload = parseJwtPayload(token);
  if (!jwtPayload) {
    return null;
  }

  return (
    pickString(
      jwtPayload.sub,
      jwtPayload.auth_user_id,
      jwtPayload.authUserId,
      jwtPayload.user_id,
      jwtPayload.userId
    ) ?? null
  );
}

async function resolveDriverIdentityForSync(
  payload: Record<string, unknown>,
  authSession: { userId?: string | null; token?: string | null } | null
) {
  const authUserIdFromPayload = pickString(payload.auth_user_id, payload.authUserId) ?? null;
  const authUserIdFromSession = pickString(authSession?.userId) ?? null;
  const authUserIdFromToken = extractAuthUserIdFromToken(
    pickString(authSession?.token, getAuthAccessToken()) ?? null
  );
  const authUserId = authUserIdFromPayload ?? authUserIdFromSession ?? authUserIdFromToken;

  let driverId =
    toOptionalPositiveInt(payload.driver_id) ??
    toOptionalPositiveInt(payload.driverId) ??
    toOptionalPositiveInt(payload.user_id) ??
    toOptionalPositiveInt(payload.userId) ??
    toOptionalPositiveInt(authSession?.userId) ??
    toOptionalPositiveInt(authUserId) ??
    (await getCurrentDriverId());

  if (!driverId && authUserId) {
    const resolvedDriverId = await resolveDriverUserIdFromAuthId(authUserId);
    driverId = toOptionalPositiveInt(resolvedDriverId);
  }

  if (driverId) {
    await setCurrentDriverId(driverId).catch(() => null);
  }

  return {
    driverId,
    authUserId
  };
}

function extractArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const candidates = [
    record.routes,
    record.items,
    record.result,
    record.results,
    record.records,
    record.snapshot,
    record.data,
    record.payload
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
    const nested = asRecord(candidate);
    if (nested?.routes && Array.isArray(nested.routes)) {
      return nested.routes;
    }
  }

  return [];
}

function normalizeWaypoint(raw: unknown, routeId: number, index: number): Waypoint | null {
  const item = asRecord(raw);
  if (!item) {
    return null;
  }

  const address = asRecord(item.address);
  const id = toPositiveInt(item.id ?? item.waypoint_id ?? item.waypointId ?? item.stop_id, 0);
  if (!id) {
    return null;
  }

  const fallbackSeqOrder = index >= 0 ? index + 1 : 0;
  const seqOrder = toPositiveInt(item.seq_order ?? item.seqorder ?? item.seqOrder, fallbackSeqOrder);
  const latitude = toNullableNumber(
    item.latitude ??
      item.lat ??
      item.geo_lat ??
      item.latlng_lat ??
      item['Receiver to Latitude'] ??
      item.receiver_to_latitude ??
      address?.latitude ??
      address?.lat
  );
  const longitude = toNullableNumber(
    item.longitude ??
      item.long ??
      item.lng ??
      item.lon ??
      item.geo_lng ??
      item['Receiver to Longitude'] ??
      item.receiver_to_longitude ??
      address?.longitude ??
      address?.lng ??
      address?.long
  );
  const explicitTitle = pickString(
    item.detailed_address,
    item['detailed address'],
    item['Detailed address'],
    item['Detailed Address'],
    item['Detailed address '],
    item.detailedAddress,
    item.full_address,
    item['full address'],
    item['Full address'],
    item['Full Address'],
    item.fullAddress,
    item.formatted_address,
    item['formatted address'],
    item['Formatted address'],
    item['Formatted Address'],
    item.formattedAddress,
    item['Receiver to Street'],
    item.receiver_to_street,
    item.title,
    item.name,
    item.address_text,
    item.addressLine,
    item.address_line,
    address?.detailed_address,
    address?.['detailed address'],
    address?.['Detailed address'],
    address?.detailedAddress,
    address?.full_address,
    address?.['full address'],
    address?.['Full address'],
    address?.fullAddress,
    address?.formatted_address,
    address?.['formatted address'],
    address?.['Formatted address'],
    address?.formattedAddress,
    address?.title,
    address?.name,
    address?.address_text
  );
  const street = pickString(
    item.street,
    item.logradouro,
    item.rua,
    item.address,
    address?.street,
    address?.logradouro,
    address?.rua,
    address?.address
  );
  const number = pickString(item.number, item.numero, address?.number, address?.numero);
  const district = pickString(
    item.district,
    item.neighborhood,
    item.bairro,
    address?.district,
    address?.neighborhood,
    address?.bairro
  );
  const city = pickString(item.city, item.cidade, address?.city, address?.cidade);
  const state = pickString(item.state, item.uf, address?.state, address?.uf);
  const zip = pickString(
    item.zipcode,
    item.zip_code,
    item['Zip Code'],
    item['zip code'],
    item.cep,
    address?.zipcode,
    address?.zip_code,
    address?.['Zip Code'],
    address?.['zip code'],
    address?.cep
  );
  const complement = pickString(item.complement, item.complemento, address?.complement, address?.complemento);
  const streetLine = [street, number].filter(Boolean).join(', ').trim();
  const regionParts = [district, city, state].filter(Boolean).join(' - ').trim();
  const inferredTitle = explicitTitle ?? (streetLine || regionParts || undefined);
  const inferredSubtitle =
    pickString(item.subtitle, item.address_subtitle, item.description, item.desc, address?.subtitle, address?.city) ??
    ([zip, regionParts, complement].filter(Boolean).join(' • ') || undefined);

  // Do not infer address_id from waypoint id on pull payloads.
  // If the backend omits address_id, we prefer keeping the existing local value during merge.
  const fallbackAddressId = 0;

  return {
    id,
    route_id: toPositiveInt(item.route_id ?? item.routeId, routeId),
    address_id: toPositiveInt(
      item.address_id ??
        item.addressId ??
        item['address id'] ??
        item['Address ID'] ??
        address?.id ??
        address?.address_id ??
        address?.addressId ??
        address?.['address id'] ??
        address?.['Address ID'],
      fallbackAddressId
    ),
    user_id: toNullableNumber(item.user_id ?? item.userId),
    seq_order: seqOrder,
    status: normalizeWaypointStatus(item.status),
    title: inferredTitle,
    subtitle: inferredSubtitle,
    latitude,
    longitude
  };
}

function parseJsonObject(value: string) {
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    )
  ) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function asStructuredRecord(value: unknown): ApiRecord | null {
  if (typeof value === 'string') {
    const parsed = parseJsonObject(value);
    return asRecord(parsed);
  }
  return asRecord(value);
}

function isWaypointOnlyRecord(item: ApiRecord) {
  const hasWaypointFields =
    item.seq_order !== undefined ||
    item.seqorder !== undefined ||
    item.address_id !== undefined ||
    item.addressId !== undefined ||
    item.waypoint_id !== undefined ||
    item.waypointId !== undefined;

  const hasRouteFields =
    item.cluster_id !== undefined ||
    item.clusterId !== undefined ||
    item.waypoints_count !== undefined ||
    item.waypointsCount !== undefined ||
    item.waypoints !== undefined ||
    item.route_waypoints !== undefined ||
    item.stops !== undefined ||
    item.points !== undefined ||
    item.ativa !== undefined ||
    item.iniciada_em !== undefined ||
    item.finalizada_em !== undefined;

  return hasWaypointFields && !hasRouteFields;
}

function sortWaypoints(waypoints: Waypoint[]) {
  return [...waypoints].sort((a, b) => a.seq_order - b.seq_order || a.id - b.id);
}

function buildAddressSeqKey(waypoint: Pick<Waypoint, 'address_id' | 'seq_order'>) {
  const addressId = toOptionalPositiveInt(waypoint.address_id);
  const seqOrder = toOptionalPositiveInt(waypoint.seq_order);
  if (!addressId || !seqOrder) {
    return null;
  }
  return `${addressId}:${seqOrder}`;
}

function hydrateDetailedWaypointFields(baseWaypoints: Waypoint[], sourceWaypoints: Waypoint[]) {
  if (baseWaypoints.length === 0 || sourceWaypoints.length === 0) {
    return baseWaypoints;
  }

  const sourceById = new Map<number, Waypoint>();
  const sourceByAddressSeq = new Map<string, Waypoint>();
  const sourceByAddressId = new Map<number, Waypoint>();
  const sourceByOrder = new Map<number, Waypoint>();

  for (const source of sortWaypoints(sourceWaypoints)) {
    if (!hasDetailedAddressTitle(source.title)) {
      continue;
    }

    sourceById.set(source.id, source);
    const key = buildAddressSeqKey(source);
    if (key && !sourceByAddressSeq.has(key)) {
      sourceByAddressSeq.set(key, source);
    }

    const addressId = toOptionalPositiveInt(source.address_id);
    if (addressId && !sourceByAddressId.has(addressId)) {
      sourceByAddressId.set(addressId, source);
    }
    const seqOrder = toOptionalPositiveInt(source.seq_order);
    if (seqOrder && !sourceByOrder.has(seqOrder)) {
      sourceByOrder.set(seqOrder, source);
    }
  }

  return baseWaypoints.map((waypoint) => {
    if (hasDetailedAddressTitle(waypoint.title)) {
      return waypoint;
    }

    const sourceByWaypointId = sourceById.get(waypoint.id);
    const key = buildAddressSeqKey(waypoint);
    const sourceBySeq = key ? sourceByAddressSeq.get(key) : undefined;
    const addressId = toOptionalPositiveInt(waypoint.address_id);
    const sourceByAddress = addressId ? sourceByAddressId.get(addressId) : undefined;
    const seqOrder = toOptionalPositiveInt(waypoint.seq_order);
    const sourceByOrderMatch = seqOrder ? sourceByOrder.get(seqOrder) : undefined;
    const source = sourceByWaypointId ?? sourceBySeq ?? sourceByAddress ?? sourceByOrderMatch;
    if (!source || !hasDetailedAddressTitle(source.title)) {
      return waypoint;
    }

    return {
      ...waypoint,
      address_id: toOptionalPositiveInt(waypoint.address_id) ?? toOptionalPositiveInt(source.address_id) ?? 0,
      title: pickString(source.title) ?? waypoint.title,
      subtitle: pickString(waypoint.subtitle) ?? pickString(source.subtitle),
      latitude: toNullableNumber(waypoint.latitude) ?? toNullableNumber(source.latitude),
      longitude: toNullableNumber(waypoint.longitude) ?? toNullableNumber(source.longitude)
    };
  });
}

function mergeWaypointDetails(existing: Waypoint | undefined, incoming: Waypoint): Waypoint {
  const incomingAddressId = toOptionalPositiveInt(incoming.address_id);
  const existingAddressId = toOptionalPositiveInt(existing?.address_id);
  const incomingSeqOrder = toOptionalPositiveInt(incoming.seq_order);
  const existingSeqOrder = toOptionalPositiveInt(existing?.seq_order);
  const incomingTitle = pickString(incoming.title);
  const existingTitle = pickString(existing?.title);
  const incomingSubtitle = pickString(incoming.subtitle);
  const existingSubtitle = pickString(existing?.subtitle);
  const incomingLatitude = toNullableNumber(incoming.latitude);
  const existingLatitude = toNullableNumber(existing?.latitude);
  const incomingLongitude = toNullableNumber(incoming.longitude);
  const existingLongitude = toNullableNumber(existing?.longitude);
  const incomingHasDetailedTitle = hasDetailedAddressTitle(incomingTitle);
  const existingHasDetailedTitle = hasDetailedAddressTitle(existingTitle);

  let resolvedTitle = incomingTitle ?? existingTitle;
  if (!incomingHasDetailedTitle && existingHasDetailedTitle) {
    resolvedTitle = existingTitle;
  }
  if (incomingHasDetailedTitle) {
    resolvedTitle = incomingTitle;
  }

  return {
    ...incoming,
    address_id: incomingAddressId ?? existingAddressId ?? 0,
    user_id: incoming.user_id ?? existing?.user_id,
    seq_order: incomingSeqOrder ?? existingSeqOrder ?? 0,
    title: resolvedTitle,
    subtitle: incomingSubtitle ?? existingSubtitle,
    latitude: incomingLatitude ?? existingLatitude,
    longitude: incomingLongitude ?? existingLongitude
  };
}

function mergeRouteDetails(existing: RouteDetail | undefined, incoming: RouteDetail): RouteDetail {
  const incomingWaypoints = incoming.waypoints ?? [];
  const existingWaypoints = existing?.waypoints ?? [];

  const mergedWaypointsById = new Map<number, Waypoint>();
  for (const waypoint of existingWaypoints) {
    mergedWaypointsById.set(waypoint.id, waypoint);
  }
  for (const waypoint of incomingWaypoints) {
    mergedWaypointsById.set(waypoint.id, mergeWaypointDetails(mergedWaypointsById.get(waypoint.id), waypoint));
  }

  const mergedWaypoints = sortWaypoints(Array.from(mergedWaypointsById.values()));
  const mergedCount = Math.max(
    existing?.waypoints_count ?? 0,
    incoming.waypoints_count ?? 0,
    mergedWaypoints.length
  );

  return {
    id: incoming.id,
    cluster_id:
      incoming.cluster_id || incoming.cluster_id === 0
        ? incoming.cluster_id
        : existing?.cluster_id ?? 0,
    status: incoming.status ?? existing?.status ?? 'PENDENTE',
    created_at: incoming.created_at ?? existing?.created_at ?? new Date().toISOString(),
    waypoints_count: mergedCount,
    waypoints: mergedWaypoints
  };
}

async function hydrateRoutesFromLegacyRouteSnapshotEndpoint() {
  const routeSnapshotResponse = await httpClient.get(buildFastRouteApiUrl('/route'), {
    timeout: SYNC_PULL_HTTP_TIMEOUT_MS
  });
  if (!isPayloadOk(routeSnapshotResponse.data)) {
    return [] as RouteDetail[];
  }

  return extractRoutesFromPullResponse(routeSnapshotResponse.data);
}

async function hydrateRouteByIdFromLegacyRouteEndpoint(routeId: number) {
  const normalizedRouteId = toPositiveInt(routeId, 0);
  if (!normalizedRouteId) {
    return null;
  }

  const routeSnapshotResponse = await httpClient.get(buildFastRouteApiUrl('/route'), {
    params: { route_id: normalizedRouteId },
    timeout: SYNC_PULL_HTTP_TIMEOUT_MS
  });
  if (!isPayloadOk(routeSnapshotResponse.data)) {
    return null;
  }

  const routes = extractRoutesFromPullResponse(routeSnapshotResponse.data);
  if (routes.length === 0) {
    return null;
  }

  return routes.find((entry) => entry.id === normalizedRouteId) ?? routes[0];
}

function normalizeRoute(raw: unknown): RouteDetail | null {
  const item = asRecord(raw);
  if (!item) {
    return null;
  }

  if (isWaypointOnlyRecord(item)) {
    return null;
  }

  const id = toPositiveInt(item.id ?? item.route_id ?? item.routeId, 0);
  if (!id) {
    return null;
  }

  const rawWaypoints =
    extractArray(item.waypoints).length > 0
      ? extractArray(item.waypoints)
      : extractArray(item.route_waypoints).length > 0
        ? extractArray(item.route_waypoints)
        : extractArray(item.paradas).length > 0
          ? extractArray(item.paradas)
        : extractArray(item.stops).length > 0
          ? extractArray(item.stops)
          : extractArray(item.points);

  const waypoints = rawWaypoints
    .map((entry, index) => normalizeWaypoint(entry, id, index))
    .filter((entry): entry is Waypoint => Boolean(entry))
    .sort((a, b) => a.seq_order - b.seq_order || a.id - b.id);

  return {
    id,
    cluster_id: Math.trunc(Number(item.cluster_id ?? item.clusterId ?? 0)),
    status: normalizeRouteStatus(item.status ?? item.route_status),
    created_at: pickString(item.created_at, item.createdAt) ?? new Date().toISOString(),
    waypoints_count: toPositiveInt(item.waypoints_count ?? item.waypointsCount, waypoints.length),
    waypoints
  };
}

function extractRoutesFromPullResponse(payload: unknown): RouteDetail[] {
  const directRoutes = extractArray(payload)
    .map((entry) => normalizeRoute(entry))
    .filter((entry): entry is RouteDetail => Boolean(entry));

  const root = asRecord(payload);
  if (!root) {
    return directRoutes;
  }

  const deduplicated = new Map<number, RouteDetail>();
  for (const route of directRoutes) {
    deduplicated.set(route.id, route);
  }

  const changes = extractArray(root.changes)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is ApiRecord => Boolean(entry));

  for (const change of changes) {
    const entityType = normalizeText(change.entity_type ?? change.entityType);
    const entityId = toPositiveInt(change.entity_id ?? change.entityId, 0);
    const payloadRecord = asStructuredRecord(change.payload);
    const changeCreatedAt = pickString(change.created_at, change.createdAt) ?? new Date().toISOString();

    if (entityType === 'ROUTE') {
      const routeCandidate = normalizeRoute({
        ...(payloadRecord ?? {}),
        id: payloadRecord?.id ?? payloadRecord?.route_id ?? payloadRecord?.routeId ?? entityId,
        created_at: payloadRecord?.created_at ?? payloadRecord?.createdAt ?? changeCreatedAt
      });

      if (!routeCandidate) {
        continue;
      }

      deduplicated.set(
        routeCandidate.id,
        mergeRouteDetails(deduplicated.get(routeCandidate.id), routeCandidate)
      );
      continue;
    }

    if (entityType === 'ROUTE_WAYPOINT') {
      const waypointRaw: ApiRecord = {
        ...(payloadRecord ?? {}),
        id: payloadRecord?.id ?? payloadRecord?.waypoint_id ?? payloadRecord?.waypointId ?? entityId
      };
      const routeId = toPositiveInt(waypointRaw.route_id ?? waypointRaw.routeId, 0);
      if (!routeId) {
        continue;
      }

      const waypoint = normalizeWaypoint(waypointRaw, routeId, -1);
      if (!waypoint) {
        continue;
      }

      const baseRoute = deduplicated.get(routeId) ?? {
        id: routeId,
        cluster_id: 0,
        status: 'PENDENTE' as RouteStatus,
        created_at: changeCreatedAt,
        waypoints_count: 0,
        waypoints: []
      };

      const mergedWaypointsMap = new Map<number, Waypoint>((baseRoute.waypoints ?? []).map((item) => [item.id, item]));
      mergedWaypointsMap.set(waypoint.id, mergeWaypointDetails(mergedWaypointsMap.get(waypoint.id), waypoint));
      const mergedWaypoints = sortWaypoints(Array.from(mergedWaypointsMap.values()));

      deduplicated.set(routeId, {
        ...baseRoute,
        waypoints: mergedWaypoints,
        waypoints_count: Math.max(baseRoute.waypoints_count ?? 0, mergedWaypoints.length)
      });
      continue;
    }

    const legacyRouteCandidates = [
      change.route,
      change.data,
      payloadRecord,
      asStructuredRecord(change.data)?.route,
      payloadRecord?.route
    ];
    for (const candidate of legacyRouteCandidates) {
      const normalizedCandidate = normalizeRoute(candidate);
      if (!normalizedCandidate) {
        continue;
      }
      deduplicated.set(
        normalizedCandidate.id,
        mergeRouteDetails(deduplicated.get(normalizedCandidate.id), normalizedCandidate)
      );
    }
  }

  return Array.from(deduplicated.values());
}

function hasDetailedAddressTitle(title: unknown) {
  if (typeof title !== 'string') {
    return false;
  }

  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const normalized = normalizeText(trimmed);
  if (/^ENDERECO\s+\d+$/.test(normalized) || /^WAYPOINT\s*#?\s*\d+$/.test(normalized)) {
    return false;
  }
  return normalized !== 'ENDERECO NAO INFORMADO';
}

async function enrichRoutesWithDetailedAddress(routes: RouteDetail[]) {
  if (routes.length === 0) {
    return routes;
  }

  let legacySnapshotPromise: Promise<RouteDetail[] | null> | null = null;
  const legacyRouteByIdPromises = new Map<number, Promise<RouteDetail | null>>();
  const loadLegacySnapshot = async () => {
    if (!legacySnapshotPromise) {
      legacySnapshotPromise = hydrateRoutesFromLegacyRouteSnapshotEndpoint()
        .then((snapshot) => snapshot)
        .catch(() => null);
    }
    return legacySnapshotPromise;
  };
  const loadLegacyRouteById = async (routeId: number) => {
    const normalizedRouteId = toPositiveInt(routeId, 0);
    if (!normalizedRouteId) {
      return null;
    }
    if (!legacyRouteByIdPromises.has(normalizedRouteId)) {
      legacyRouteByIdPromises.set(
        normalizedRouteId,
        hydrateRouteByIdFromLegacyRouteEndpoint(normalizedRouteId).catch(() => null)
      );
    }
    return legacyRouteByIdPromises.get(normalizedRouteId) ?? null;
  };

  const enrichedRoutes = await Promise.all(
    routes.map(async (route) => {
      const baseWaypoints = route.waypoints ?? [];
      if (baseWaypoints.length === 0) {
        return route;
      }

      const needsAddressEnrichment = baseWaypoints.some((waypoint) => !hasDetailedAddressTitle(waypoint.title));
      if (!needsAddressEnrichment) {
        return route;
      }

      let resolvedWaypoints = baseWaypoints;
      try {
        resolvedWaypoints = await enrichWaypointsWithAddressData(baseWaypoints);
      } catch {
        resolvedWaypoints = baseWaypoints;
      }

      if (resolvedWaypoints.some((waypoint) => !hasDetailedAddressTitle(waypoint.title))) {
        const legacyRoutes = await loadLegacySnapshot();
        const legacyRoute = legacyRoutes?.find((entry) => entry.id === route.id);
        if (legacyRoute?.waypoints?.length) {
          resolvedWaypoints = hydrateDetailedWaypointFields(resolvedWaypoints, legacyRoute.waypoints);
        }
      }

      if (resolvedWaypoints.some((waypoint) => !hasDetailedAddressTitle(waypoint.title))) {
        const legacyRouteById = await loadLegacyRouteById(route.id);
        if (legacyRouteById?.waypoints?.length) {
          resolvedWaypoints = hydrateDetailedWaypointFields(resolvedWaypoints, legacyRouteById.waypoints);
        }
      }

      return {
        ...route,
        waypoints: resolvedWaypoints,
        waypoints_count: Math.max(route.waypoints_count ?? 0, resolvedWaypoints.length)
      };
    })
  );

  return enrichedRoutes;
}

function readErrorMessage(payload: unknown, fallback: string) {
  const record = asRecord(payload);
  if (!record) {
    return fallback;
  }

  const candidates = [record.msg, record.message, record.error, record.hint];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return fallback;
}

function isPayloadOk(payload: unknown) {
  const record = asRecord(payload);
  if (!record) {
    return true;
  }
  if (record.ok === false) {
    return false;
  }
  const statusCode = Number(record.statusCode ?? record.status_code ?? record.code);
  return !(Number.isFinite(statusCode) && statusCode >= 400);
}

function toLocalDate(now: Date) {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseSyncTime(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }

  return { hh, mm };
}

function randomId() {
  return `${Date.now()}-${Math.trunc(Math.random() * 1_000_000_000)}`;
}

function buildStableMutationId(
  queueItemId: number,
  entityType: SyncMutationEntityType,
  entityId: number,
  op: string,
  variant?: string | number
) {
  const normalizedOp = normalizeText(op) || 'UNKNOWN';
  const normalizedVariant =
    variant !== undefined && variant !== null
      ? normalizeText(String(variant)).replace(/[^A-Z0-9_-]/g, '')
      : '';
  const variantSuffix = normalizedVariant ? `-${normalizedVariant}` : '';
  return `${queueItemId}-${entityType}-${entityId}-${normalizedOp}${variantSuffix}`;
}

function isDuplicateCreateAlreadyApplied(message: string, mutation: SyncMutation) {
  if (!normalizeText(mutation.op).includes('CREATE')) {
    return false;
  }

  const normalizedMessage = normalizeText(message);
  const hasDuplicateSignal =
    normalizedMessage.includes('DUPLICATE KEY VALUE') ||
    normalizedMessage.includes('VIOLATES UNIQUE CONSTRAINT') ||
    normalizedMessage.includes('UNIQUE CONSTRAINT') ||
    normalizedMessage.includes('SQLSTATE 23505') ||
    normalizedMessage.includes('CODE 23505') ||
    normalizedMessage.includes(' 23505 ');

  if (!hasDuplicateSignal) {
    return false;
  }

  if (mutation.entityType === 'route') {
    return true;
  }

  if (mutation.entityType === 'route_waypoint') {
    return true;
  }

  return false;
}

function isTransientPushFailureMessage(message: string) {
  const normalized = normalizeText(message);
  return (
    normalized.includes('FETCH FAILED') ||
    normalized.includes('NETWORK ERROR') ||
    normalized.includes('TIMEOUT') ||
    normalized.includes('ECONNABORTED') ||
    normalized.includes('ETIMEDOUT') ||
    normalized.includes('ECONNRESET') ||
    normalized.includes('ENOTFOUND') ||
    normalized.includes('EAI_AGAIN') ||
    normalized.includes('BAD GATEWAY') ||
    normalized.includes('GATEWAY TIMEOUT') ||
    normalized.includes('SERVICE UNAVAILABLE') ||
    normalized.includes('ERRO AO BUSCAR WAYPOINT PARA SYNC')
  );
}

function getTransientPushRetryDelayMs(attemptIndex: number) {
  const jitter = Math.trunc(Math.random() * (TRANSIENT_PUSH_RETRY_JITTER_MS + 1));

  if (attemptIndex < 0) {
    return TRANSIENT_PUSH_RETRY_BASE_DELAYS_MS[0] + jitter;
  }
  const boundedIndex = Math.min(attemptIndex, TRANSIENT_PUSH_RETRY_BASE_DELAYS_MS.length - 1);
  return TRANSIENT_PUSH_RETRY_BASE_DELAYS_MS[boundedIndex] + jitter;
}

function waitForMs(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function splitIntoChunks<T>(items: T[], chunkSize: number) {
  const size = Math.max(1, Math.trunc(Number(chunkSize)));
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function normalizePushStatus(value: unknown) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return 'UNKNOWN';
  }
  return normalized;
}

function routeVersionKey(routeId: number) {
  return `${ROUTE_VERSION_KEY_PREFIX}${routeId}`;
}

function waypointVersionKey(waypointId: number) {
  return `${WAYPOINT_VERSION_KEY_PREFIX}${waypointId}`;
}

function getVersionKey(entityType: SyncMutationEntityType, entityId: number) {
  return entityType === 'route' ? routeVersionKey(entityId) : waypointVersionKey(entityId);
}

async function getStoredEntityVersion(entityType: SyncMutationEntityType, entityId: number) {
  const raw = await getAppSetting(getVersionKey(entityType, entityId));
  const parsed = Math.trunc(Number(raw));
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return 1;
}

async function setStoredEntityVersion(entityType: SyncMutationEntityType, entityId: number, version: number) {
  const normalized = Math.trunc(Number(version));
  if (!Number.isFinite(normalized) || normalized < 0) {
    return;
  }
  await setAppSetting(getVersionKey(entityType, entityId), String(normalized));
}

async function getSyncDeviceId() {
  const existing = await getAppSetting(SYNC_DEVICE_ID_KEY);
  if (existing && existing.trim().length > 0) {
    return existing;
  }

  const generated = `device-${randomId()}`;
  await setAppSetting(SYNC_DEVICE_ID_KEY, generated);
  return generated;
}

function mapQueuedWaypointStatusToServer(value: unknown) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return 'PENDENTE';
  }
  if (normalized.includes('ENTREGUE') || normalized.includes('CONCLUID')) {
    return 'ENTREGUE';
  }
  if (normalized.includes('FALHA TEMPO ADVERSO')) {
    return 'FALHA TEMPO ADVERSO';
  }
  if (normalized.includes('FALHA MORADOR AUSENTE')) {
    return 'FALHA MORADOR AUSENTE';
  }
  if (normalized.includes('REORDEN')) {
    return 'REORDENADO';
  }
  if (normalized.includes('EM_ROTA')) {
    return 'EM_ROTA';
  }
  return 'PENDENTE';
}

function mapRouteStatusToServer(value: unknown) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return 'PENDENTE';
  }
  if (normalized.includes('CRIADA')) {
    return 'CRIADA';
  }
  if (normalized.includes('EM_ANDAMENTO') || normalized.includes('EM ANDAMENTO') || normalized.includes('EM_ROTA')) {
    return 'EM_ANDAMENTO';
  }
  if (normalized.includes('FINAL') || normalized.includes('CONCL')) {
    return 'CONCLUÍDA';
  }
  return 'PENDENTE';
}

async function buildMutationsForQueueItem(
  item: SyncQueueItem,
  deviceId: string
): Promise<SyncMutation[]> {
  const payload = item.payload ?? {};
  const mutations: SyncMutation[] = [];

  const pushRouteMutation = async (
    routeId: number,
    op: string,
    mutationPayload: Record<string, unknown>,
    allowNotFound = false,
    variant?: string | number
  ) => {
    const normalizedOp = normalizeText(op);
    const baseVersion = normalizedOp.includes('CREATE')
      ? 0
      : await getStoredEntityVersion('route', routeId);
    mutations.push({
      queueItemId: item.id,
      mutationId: buildStableMutationId(item.id, 'route', routeId, op, variant),
      deviceId,
      entityType: 'route',
      entityId: routeId,
      op,
      baseVersion,
      payload: mutationPayload,
      allowNotFound
    });
  };

  const pushWaypointMutation = async (
    waypointId: number,
    op: string,
    mutationPayload: Record<string, unknown>,
    allowNotFound = false,
    variant?: string | number
  ) => {
    const normalizedOp = normalizeText(op);
    const baseVersion = normalizedOp.includes('CREATE')
      ? 0
      : await getStoredEntityVersion('route_waypoint', waypointId);
    mutations.push({
      queueItemId: item.id,
      mutationId: buildStableMutationId(item.id, 'route_waypoint', waypointId, op, variant),
      deviceId,
      entityType: 'route_waypoint',
      entityId: waypointId,
      op,
      baseVersion,
      payload: mutationPayload,
      allowNotFound
    });
  };

  switch (item.opType) {
    case 'START_ROUTE': {
      const routeId = toQueueRouteId(payload);
      if (!routeId) {
        return mutations;
      }
      await pushRouteMutation(routeId, 'UPDATE', { status: 'EM_ANDAMENTO' });
      return mutations;
    }
    case 'FINISH_ROUTE': {
      const routeId = toQueueRouteId(payload);
      if (!routeId) {
        return mutations;
      }
      await pushRouteMutation(routeId, 'UPDATE', { status: 'CONCLUÍDA', ativa: false });
      return mutations;
    }
    case 'UPDATE_WAYPOINT_STATUS': {
      const waypointId = toQueueWaypointId(payload);
      if (!waypointId) {
        return mutations;
      }

      const localWaypoint = await getLocalWaypoint(waypointId);
      if (!localWaypoint) {
        return mutations;
      }
      await pushWaypointMutation(
        waypointId,
        'UPDATE',
        {
          route_id: localWaypoint.route_id,
          status: mapQueuedWaypointStatusToServer(payload.status)
        }
      );
      return mutations;
    }
    case 'REORDER_WAYPOINTS': {
      const routeId = toQueueRouteId(payload);
      const reordered = extractQueuedReorderedWaypoints(payload);
      for (const [reorderIndex, entry] of reordered.entries()) {
        await pushWaypointMutation(
          entry.waypoint_id,
          'UPDATE',
          { route_id: routeId ?? undefined, seq_order: entry.seqorder, status: 'REORDENADO' },
          false,
          `${entry.seqorder}-${reorderIndex}`
        );
      }
      return mutations;
    }
    case 'DELETE_ROUTE': {
      const routeId = toQueueRouteId(payload);
      if (!routeId) {
        return mutations;
      }
      const cancelReason = pickString(
        payload.justificativa_cancel,
        payload.cancel_reason,
        payload.cancelReason
      );
      await pushRouteMutation(
        routeId,
        'UPDATE',
        {
          status: 'CANCELADA',
          ativa: false,
          justificativa_cancel: cancelReason ?? null
        },
        true
      );
      return mutations;
    }
    case 'IMPORT_ROUTE_FILE': {
      const authSession = await loadAuthSession().catch(() => null);
      const routeIds = extractImportRouteIds(payload);

      if (routeIds.length === 0) {
        throw new Error('Falha no sync: payload de IMPORT_ROUTE_FILE sem route_ids válidos.');
      }

      const localWaypointsByRouteId = new Map<number, Waypoint[]>();
      const listRouteWaypoints = async (routeId: number) => {
        if (!localWaypointsByRouteId.has(routeId)) {
          localWaypointsByRouteId.set(routeId, await listLocalWaypoints(routeId));
        }
        return localWaypointsByRouteId.get(routeId) ?? [];
      };

      let driverId: number | null = null;
      let authUserId: string | null = null;
      try {
        const resolvedIdentity = await resolveDriverIdentityForSync(payload, authSession);
        driverId = resolvedIdentity.driverId;
        authUserId = resolvedIdentity.authUserId;
      } catch (error) {
        throw new Error(`Falha no sync: erro ao resolver driver_id via auth_user_id: ${getApiError(error)}`);
      }

      if (!driverId) {
        for (const routeId of routeIds) {
          const routeWaypoints = await listRouteWaypoints(routeId);
          const driverIdFromWaypoint = routeWaypoints.reduce<number | null>((resolved, waypoint) => {
            if (resolved) {
              return resolved;
            }
            return toOptionalPositiveInt(waypoint.user_id);
          }, null);
          if (driverIdFromWaypoint) {
            driverId = driverIdFromWaypoint;
            await setCurrentDriverId(driverIdFromWaypoint).catch(() => null);
            break;
          }
        }
      }

      const importIdFromPayload =
        toOptionalPositiveInt(payload.import_id) ?? toOptionalPositiveInt(payload.importId);
      const importId =
        importIdFromPayload && importIdFromPayload > 0
          ? importIdFromPayload
          : routeIds.length > 0
            ? routeIds[0]
            : null;

      if (!importId) {
        throw new Error('Falha no sync: payload de IMPORT_ROUTE_FILE sem import_id válido para route CREATE.');
      }

      if (!driverId) {
        throw new Error(
          'Falha no sync: payload de rota incompleto para sync CREATE: coluna obrigatória ausente (driver_id).'
        );
      }

      for (const [routeIndex, routeId] of routeIds.entries()) {
        const localRoute = await getLocalRoute(routeId);
        if (!localRoute) {
          continue;
        }

        const localWaypoints = await listRouteWaypoints(routeId);
        const routeClusterId =
          toOptionalPositiveInt(localRoute.cluster_id) ??
          toOptionalPositiveInt(payload.cluster_id) ??
          toOptionalPositiveInt(payload.clusterId) ??
          1;
        await pushRouteMutation(routeId, 'CREATE', {
          id: routeId,
          import_id: importId,
          driver_id: driverId,
          user_id: driverId,
          auth_user_id: authUserId ?? undefined,
          cluster_id: routeClusterId,
          status: mapRouteStatusToServer(localRoute.status),
          created_at: localRoute.created_at ?? new Date().toISOString(),
          waypoints_count: localWaypoints.length,
          ativa: false
        }, false, routeIndex);

        for (const [waypointIndex, waypoint] of localWaypoints.entries()) {
          await pushWaypointMutation(waypoint.id, 'CREATE', {
            id: waypoint.id,
            route_id: routeId,
            user_id: toOptionalPositiveInt(waypoint.user_id) ?? driverId,
            address_id: waypoint.address_id ?? null,
            seq_order: waypoint.seq_order ?? 0,
            status: mapQueuedWaypointStatusToServer(waypoint.status),
            detailed_address: waypoint.title ?? null,
            lat: waypoint.latitude ?? null,
            long: waypoint.longitude ?? null
          }, false, waypointIndex);
        }
      }
      return mutations;
    }
    default:
      return mutations;
  }
}

function readPushMutationResult(payload: unknown): SyncPushMutationResult | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const mutationId = pickString(record.mutationId, record.mutation_id);
  const status = pickString(record.status);
  if (!mutationId || !status) {
    return null;
  }

  return {
    mutationId,
    status,
    serverVersion: Number.isFinite(Number(record.serverVersion))
      ? Math.trunc(Number(record.serverVersion))
      : Number.isFinite(Number(record.server_version))
        ? Math.trunc(Number(record.server_version))
        : undefined
  };
}

async function isImportRetryFullyPersistedRemotely(
  item: SyncQueueItem,
  expectedCreateMutations: SyncMutation[]
) {
  const toSortedPositiveIntList = (values: unknown[]) =>
    values
      .map((value) => Math.trunc(Number(value)))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);

  const haveSameSortedValues = (left: number[], right: number[]) => {
    if (left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        return false;
      }
    }
    return true;
  };

  const haveSameSortedTextValues = (left: string[], right: string[]) => {
    if (left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        return false;
      }
    }
    return true;
  };

  const buildAddressOrderSignature = (
    waypoints: Array<{
      address_id?: unknown;
      seq_order?: unknown;
    }>
  ) =>
    waypoints
      .map((waypoint) => {
        const addressId = Math.trunc(Number(waypoint.address_id));
        const seqOrder = Math.trunc(Number(waypoint.seq_order));
        if (!Number.isFinite(addressId) || addressId <= 0) {
          return null;
        }
        const normalizedSeqOrder = Number.isFinite(seqOrder) && seqOrder > 0 ? seqOrder : 0;
        return `${normalizedSeqOrder}:${addressId}`;
      })
      .filter((entry): entry is string => Boolean(entry))
      .sort();

  const loadRouteSnapshot = async (routeId?: number): Promise<RouteDetail[] | null> => {
    try {
      const response = await httpClient.get(buildFastRouteApiUrl('/route'), {
        params: routeId ? { route_id: routeId } : undefined,
        timeout: SYNC_PULL_HTTP_TIMEOUT_MS
      });
      if (!isPayloadOk(response.data)) {
        return [];
      }
      return extractRoutesFromPullResponse(response.data);
    } catch {
      return null;
    }
  };

  const expectedByRouteId = new Map<
    number,
    {
      clusterId?: number;
      importId?: number;
      driverId?: number;
      waypointIds: number[];
      waypointAddressIds: number[];
      waypointOrderSignature: string[];
      waypoints: Array<{
        id?: number;
        addressId?: number;
        seqOrder?: number;
      }>;
    }
  >();

  for (const mutation of expectedCreateMutations) {
    if (!normalizeText(mutation.op).includes('CREATE')) {
      continue;
    }

    if (mutation.entityType === 'route') {
      const routeId = Math.trunc(Number(mutation.entityId));
      if (!Number.isFinite(routeId) || routeId <= 0) {
        continue;
      }
      const mutationPayload = mutation.payload as Record<string, unknown>;
      const clusterId = Math.trunc(Number(mutationPayload.cluster_id));
      const importId = toOptionalPositiveInt(mutationPayload.import_id);
      const driverId =
        toOptionalPositiveInt(mutationPayload.driver_id) ??
        toOptionalPositiveInt(mutationPayload.user_id);
      const current =
        expectedByRouteId.get(routeId) ??
        { waypointIds: [], waypointAddressIds: [], waypointOrderSignature: [], waypoints: [] };
      expectedByRouteId.set(routeId, {
        ...current,
        clusterId: Number.isFinite(clusterId) && clusterId > 0 ? clusterId : current.clusterId,
        importId: importId ?? current.importId,
        driverId: driverId ?? current.driverId
      });
      continue;
    }

    if (mutation.entityType === 'route_waypoint') {
      const payload = mutation.payload as Record<string, unknown>;
      const routeId = Math.trunc(Number(payload.route_id));
      if (!Number.isFinite(routeId) || routeId <= 0) {
        continue;
      }

      const waypointId = Math.trunc(Number(payload.id ?? mutation.entityId));
      const addressId = Math.trunc(Number(payload.address_id));
      const seqOrder = Math.trunc(Number(payload.seq_order));
      const normalizedSeqOrder = Number.isFinite(seqOrder) && seqOrder > 0 ? seqOrder : 0;

      const current =
        expectedByRouteId.get(routeId) ??
        { waypointIds: [], waypointAddressIds: [], waypointOrderSignature: [], waypoints: [] };

      const nextWaypointIds = [...current.waypointIds];
      if (Number.isFinite(waypointId) && waypointId > 0 && !nextWaypointIds.includes(waypointId)) {
        nextWaypointIds.push(waypointId);
      }

      const nextWaypointAddressIds = [...current.waypointAddressIds];
      if (Number.isFinite(addressId) && addressId > 0) {
        nextWaypointAddressIds.push(addressId);
      }

      const nextWaypointOrderSignature = [...current.waypointOrderSignature];
      if (Number.isFinite(addressId) && addressId > 0) {
        nextWaypointOrderSignature.push(`${normalizedSeqOrder}:${addressId}`);
      }

      const nextWaypoints = [...current.waypoints];
      nextWaypoints.push({
        id: Number.isFinite(waypointId) && waypointId > 0 ? waypointId : undefined,
        addressId: Number.isFinite(addressId) && addressId > 0 ? addressId : undefined,
        seqOrder: normalizedSeqOrder > 0 ? normalizedSeqOrder : undefined
      });

      expectedByRouteId.set(routeId, {
        ...current,
        waypointIds: nextWaypointIds,
        waypointAddressIds: nextWaypointAddressIds,
        waypointOrderSignature: nextWaypointOrderSignature,
        waypoints: nextWaypoints
      });
    }
  }

  if (expectedByRouteId.size === 0) {
    const payload = item.payload ?? {};
    const routeIds = extractImportRouteIds(payload);
    for (const routeId of routeIds) {
      expectedByRouteId.set(routeId, {
        waypointIds: [],
        waypointAddressIds: [],
        waypointOrderSignature: [],
        waypoints: []
      });
    }
  }

  if (expectedByRouteId.size === 0) {
    return false;
  }

  const loadAllChangesFromSyncPull = async (): Promise<ApiRecord[] | null> => {
    try {
      const response = await httpClient.post(
        buildFastRouteApiUrl('/sync/pull'),
        { sinceTs: '1970-01-01T00:00:00.000Z' },
        { timeout: SYNC_PULL_HTTP_TIMEOUT_MS }
      );
      if (!isPayloadOk(response.data)) {
        return [];
      }

      const root = asRecord(response.data);
      return extractArray(root?.changes)
        .map((entry) => asRecord(entry))
        .filter((entry): entry is ApiRecord => Boolean(entry));
    } catch {
      return null;
    }
  };

  const changesFromPull = await loadAllChangesFromSyncPull();
  if (changesFromPull && changesFromPull.length > 0) {
    const routePayloads = changesFromPull
      .filter((change) => normalizeText(change.entity_type ?? change.entityType) === 'ROUTE')
      .map((change) => asStructuredRecord(change.payload))
      .filter((payload): payload is ApiRecord => Boolean(payload));

    const waypointPayloads = changesFromPull
      .filter((change) => normalizeText(change.entity_type ?? change.entityType) === 'ROUTE_WAYPOINT')
      .map((change) => asStructuredRecord(change.payload))
      .filter((payload): payload is ApiRecord => Boolean(payload));

    let allRoutesConfirmedByChangeLog = true;

    for (const [routeId, expected] of expectedByRouteId.entries()) {
      const routeMatched = routePayloads.some((payload) => {
        const payloadRouteId = toOptionalPositiveInt(payload.id ?? payload.route_id ?? payload.routeId);
        if (payloadRouteId && payloadRouteId === routeId) {
          return true;
        }

        const payloadClusterId = toOptionalPositiveInt(payload.cluster_id ?? payload.clusterId);
        const payloadImportId = toOptionalPositiveInt(payload.import_id ?? payload.importId);
        const payloadDriverId = toOptionalPositiveInt(
          payload.driver_id ?? payload.driverId ?? payload.user_id ?? payload.userId
        );

        if (expected.clusterId && payloadClusterId && payloadClusterId !== expected.clusterId) {
          return false;
        }
        if (expected.importId && payloadImportId && payloadImportId !== expected.importId) {
          return false;
        }
        if (expected.driverId && payloadDriverId && payloadDriverId !== expected.driverId) {
          return false;
        }

        return Boolean(expected.clusterId || expected.importId || expected.driverId);
      });

      if (!routeMatched) {
        allRoutesConfirmedByChangeLog = false;
        break;
      }

      for (const expectedWaypoint of expected.waypoints) {
        const waypointMatched = waypointPayloads.some((payload) => {
          const payloadWaypointId = toOptionalPositiveInt(payload.id ?? payload.waypoint_id ?? payload.waypointId);
          if (expectedWaypoint.id && payloadWaypointId === expectedWaypoint.id) {
            return true;
          }

          const payloadAddressId = toOptionalPositiveInt(payload.address_id ?? payload.addressId);
          const payloadSeqOrder = Math.trunc(Number(payload.seq_order ?? payload.seqorder ?? payload.seqOrder));
          if (
            expectedWaypoint.addressId &&
            payloadAddressId === expectedWaypoint.addressId &&
            (!expectedWaypoint.seqOrder || payloadSeqOrder === expectedWaypoint.seqOrder)
          ) {
            return true;
          }

          return false;
        });

        if (!waypointMatched) {
          allRoutesConfirmedByChangeLog = false;
          break;
        }
      }

      if (!allRoutesConfirmedByChangeLog) {
        break;
      }
    }

    if (allRoutesConfirmedByChangeLog) {
      return true;
    }
  }

  const fallbackRoutes = await loadRouteSnapshot();
  if (fallbackRoutes === null) {
    return false;
  }
  const fallbackRoutePool = [...fallbackRoutes];

  for (const [routeId, expected] of expectedByRouteId.entries()) {
    const expectedWaypointIds = toSortedPositiveIntList(expected.waypointIds);
    const expectedAddressIds = toSortedPositiveIntList(expected.waypointAddressIds);
    const expectedAddressOrderSignature = [...expected.waypointOrderSignature].sort();
    const expectedClusterId = Math.trunc(Number(expected.clusterId));

    const directRoutes = await loadRouteSnapshot(routeId);
    if (directRoutes === null) {
      return false;
    }
    const directRoute = directRoutes.find((route) => route.id === routeId);

    let matchedRoute: RouteDetail | undefined;
    let matchedByContent = false;

    if (directRoute) {
      matchedRoute = directRoute;
    } else {
      const matchIndex = fallbackRoutePool.findIndex((candidate) => {
        const candidateClusterId = Math.trunc(Number(candidate.cluster_id));
        if (
          Number.isFinite(expectedClusterId) &&
          expectedClusterId > 0 &&
          Number.isFinite(candidateClusterId) &&
          candidateClusterId > 0 &&
          candidateClusterId !== expectedClusterId
        ) {
          return false;
        }

        const candidateWaypoints = candidate.waypoints ?? [];
        const candidateAddressIds = toSortedPositiveIntList(
          candidateWaypoints.map((waypoint) => waypoint.address_id)
        );

        if (expectedAddressIds.length > 0 && !haveSameSortedValues(expectedAddressIds, candidateAddressIds)) {
          return false;
        }

        const candidateAddressOrderSignature = buildAddressOrderSignature(candidateWaypoints);
        if (
          expectedAddressOrderSignature.length > 0 &&
          !haveSameSortedTextValues(expectedAddressOrderSignature, candidateAddressOrderSignature)
        ) {
          return false;
        }

        if (expectedWaypointIds.length === 0) {
          return candidateWaypoints.length > 0 || candidate.id === routeId;
        }

        return candidateWaypoints.length >= expectedWaypointIds.length;
      });

      if (matchIndex >= 0) {
        matchedRoute = fallbackRoutePool[matchIndex];
        matchedByContent = true;
        fallbackRoutePool.splice(matchIndex, 1);
      }
    }

    if (!matchedRoute) {
      return false;
    }

    const matchedWaypoints = matchedRoute.waypoints ?? [];
    const remoteWaypointIds = new Set(toSortedPositiveIntList(matchedWaypoints.map((waypoint) => waypoint.id)));

    if (!matchedByContent && expectedWaypointIds.length > 0 && remoteWaypointIds.size === 0) {
      return false;
    }

    if (!matchedByContent) {
      const allWaypointIdsPresent = expectedWaypointIds.every((waypointId) => remoteWaypointIds.has(waypointId));
      if (allWaypointIdsPresent) {
        continue;
      }
    }

    const remoteAddressIds = toSortedPositiveIntList(matchedWaypoints.map((waypoint) => waypoint.address_id));
    if (expectedAddressIds.length > 0 && !haveSameSortedValues(expectedAddressIds, remoteAddressIds)) {
      return false;
    }

    const remoteAddressOrderSignature = buildAddressOrderSignature(matchedWaypoints);
    if (
      expectedAddressOrderSignature.length > 0 &&
      !haveSameSortedTextValues(expectedAddressOrderSignature, remoteAddressOrderSignature)
    ) {
      return false;
    }

    if (!matchedByContent) {
      const expectedCount = Math.max(expectedWaypointIds.length, expectedAddressOrderSignature.length);
      const remoteCount = matchedWaypoints.length;
      if (remoteCount < expectedCount) {
        return false;
      }
    }
  }

  return true;
}

async function pushSingleMutation(mutation: SyncMutation): Promise<PushSingleMutationResult> {
  let currentBaseVersion = mutation.baseVersion;

  retryTransient: for (let transientAttempt = 0; transientAttempt < MAX_TRANSIENT_PUSH_ATTEMPTS; transientAttempt += 1) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let data: unknown;
      try {
        const response = await httpClient.post(
          buildFastRouteApiUrl('/sync/push'),
          {
            mutations: [
              {
                deviceId: mutation.deviceId,
                mutationId: mutation.mutationId,
                entityType: mutation.entityType,
                entityId: mutation.entityId,
                op: mutation.op,
                baseVersion: currentBaseVersion,
                payload: mutation.payload
              }
            ]
          },
          {
            timeout: SYNC_PUSH_HTTP_TIMEOUT_MS
          }
        );
        data = response.data;
      } catch (error) {
        const failureMessage = getApiError(error);
        if (isDuplicateCreateAlreadyApplied(failureMessage, mutation)) {
          return { ok: true, recoveredDuplicateCreate: true };
        }
        if (
          isTransientPushFailureMessage(failureMessage) &&
          transientAttempt < MAX_TRANSIENT_PUSH_ATTEMPTS - 1
        ) {
          await waitForMs(getTransientPushRetryDelayMs(transientAttempt));
          continue retryTransient;
        }
        return { ok: false, message: failureMessage };
      }

      if (!isPayloadOk(data)) {
        const failureMessage = readErrorMessage(data, 'Falha ao sincronizar mutação pendente.');
        if (isDuplicateCreateAlreadyApplied(failureMessage, mutation)) {
          return { ok: true, recoveredDuplicateCreate: true };
        }
        if (
          isTransientPushFailureMessage(failureMessage) &&
          transientAttempt < MAX_TRANSIENT_PUSH_ATTEMPTS - 1
        ) {
          await waitForMs(getTransientPushRetryDelayMs(transientAttempt));
          continue retryTransient;
        }
        return { ok: false, message: failureMessage };
      }

      const root = asRecord(data);
      const rawResults = Array.isArray(root?.results) ? root?.results : [];
      const parsedResult = rawResults
        .map((entry) => readPushMutationResult(entry))
        .find((entry) => entry?.mutationId === mutation.mutationId);

      if (!parsedResult) {
        return { ok: false, message: 'Resposta inválida de sync/push: resultado da mutação não encontrado.' };
      }

      const normalizedStatus = normalizePushStatus(parsedResult.status);
      if (normalizedStatus === 'APPLIED') {
        await setStoredEntityVersion(mutation.entityType, mutation.entityId, currentBaseVersion + 1);
        return { ok: true };
      }

      if (normalizedStatus === 'DUPLICATE') {
        return { ok: true };
      }

      if (normalizedStatus === 'NOT_FOUND' && mutation.allowNotFound) {
        return { ok: true };
      }

      if (normalizedStatus === 'NOT_FOUND' && normalizeText(mutation.op).includes('CREATE')) {
        return {
          ok: false,
          message:
            'Falha no sync: backend não suporta criação de rotas/waypoints via /sync/push. Atualize o backend para aceitar mutações CREATE.'
        };
      }

      if (
        normalizedStatus === 'CONFLICT' &&
        attempt === 0 &&
        Number.isFinite(parsedResult.serverVersion) &&
        (parsedResult.serverVersion ?? -1) >= 0
      ) {
        currentBaseVersion = Math.trunc(parsedResult.serverVersion ?? currentBaseVersion);
        await setStoredEntityVersion(mutation.entityType, mutation.entityId, currentBaseVersion);
        continue;
      }

      const serverVersionMessage = Number.isFinite(parsedResult.serverVersion)
        ? ` (serverVersion=${parsedResult.serverVersion})`
        : '';
      const rejectionMessage = `Mutação ${mutation.mutationId} rejeitada com status ${normalizedStatus}${serverVersionMessage}.`;
      if (
        isTransientPushFailureMessage(rejectionMessage) &&
        transientAttempt < MAX_TRANSIENT_PUSH_ATTEMPTS - 1
      ) {
        await waitForMs(getTransientPushRetryDelayMs(transientAttempt));
        continue retryTransient;
      }
      return { ok: false, message: rejectionMessage };
    }
  }

  return { ok: false, message: 'Falha desconhecida ao aplicar mutação pendente.' };
}

async function pushMutationsIndividually(mutations: SyncMutation[]): Promise<PushMutationsResult> {
  let recoveredDuplicateCreate = false;

  for (const mutation of mutations) {
    const mutationResult = await pushSingleMutation(mutation);
    if (!mutationResult.ok) {
      return {
        ok: false,
        message: mutationResult.message ?? 'Falha ao sincronizar mutação pendente.',
        recoveredDuplicateCreate
      };
    }

    if (mutationResult.recoveredDuplicateCreate) {
      recoveredDuplicateCreate = true;
    }
  }

  return { ok: true, recoveredDuplicateCreate };
}

async function pushMutationBatch(mutations: SyncMutation[]): Promise<PushMutationsResult> {
  if (mutations.length === 0) {
    return { ok: true, recoveredDuplicateCreate: false };
  }

  if (mutations.length === 1) {
    const mutationResult = await pushSingleMutation(mutations[0]);
    return {
      ok: mutationResult.ok,
      message: mutationResult.message,
      recoveredDuplicateCreate: Boolean(mutationResult.recoveredDuplicateCreate)
    };
  }

  const mutationById = new Map<string, SyncMutation>(mutations.map((entry) => [entry.mutationId, entry]));
  const currentBaseVersionById = new Map<string, number>(mutations.map((entry) => [entry.mutationId, entry.baseVersion]));

  retryTransient: for (let transientAttempt = 0; transientAttempt < MAX_TRANSIENT_PUSH_ATTEMPTS; transientAttempt += 1) {
    let pendingMutationIds = mutations.map((entry) => entry.mutationId);
    let pendingMutations = mutations;

    for (let conflictAttempt = 0; conflictAttempt < 2; conflictAttempt += 1) {
      let data: unknown;
      try {
        const response = await httpClient.post(
          buildFastRouteApiUrl('/sync/push'),
          {
            mutations: pendingMutations.map((mutation) => ({
              deviceId: mutation.deviceId,
              mutationId: mutation.mutationId,
              entityType: mutation.entityType,
              entityId: mutation.entityId,
              op: mutation.op,
              baseVersion: currentBaseVersionById.get(mutation.mutationId) ?? mutation.baseVersion,
              payload: mutation.payload
            }))
          },
          {
            timeout: SYNC_PUSH_HTTP_TIMEOUT_MS
          }
        );
        data = response.data;
      } catch (error) {
        const failureMessage = getApiError(error);
        if (
          isTransientPushFailureMessage(failureMessage) &&
          transientAttempt < MAX_TRANSIENT_PUSH_ATTEMPTS - 1
        ) {
          await waitForMs(getTransientPushRetryDelayMs(transientAttempt));
          continue retryTransient;
        }

        // Fallback de compatibilidade: em alguns ambientes o backend pode não
        // devolver resultado granular no batch. Nesse caso volta ao fluxo já estável.
        return pushMutationsIndividually(mutations);
      }

      if (!isPayloadOk(data)) {
        const failureMessage = readErrorMessage(data, 'Falha ao sincronizar mutações pendentes.');
        if (
          isTransientPushFailureMessage(failureMessage) &&
          transientAttempt < MAX_TRANSIENT_PUSH_ATTEMPTS - 1
        ) {
          await waitForMs(getTransientPushRetryDelayMs(transientAttempt));
          continue retryTransient;
        }
        return pushMutationsIndividually(mutations);
      }

      const root = asRecord(data);
      const rawResults = Array.isArray(root?.results) ? root?.results : [];
      const parsedResultsByMutationId = new Map<string, SyncPushMutationResult>();
      for (const entry of rawResults) {
        const parsed = readPushMutationResult(entry);
        if (!parsed?.mutationId) {
          continue;
        }
        parsedResultsByMutationId.set(parsed.mutationId, parsed);
      }

      // Se faltar qualquer resultado, usa fallback seguro por mutação.
      const missingResult = pendingMutationIds.some((mutationId) => !parsedResultsByMutationId.has(mutationId));
      if (missingResult) {
        return pushMutationsIndividually(mutations);
      }

      const conflictedMutationIds: string[] = [];
      for (const mutationId of pendingMutationIds) {
        const mutation = mutationById.get(mutationId);
        const parsedResult = parsedResultsByMutationId.get(mutationId);
        if (!mutation || !parsedResult) {
          return pushMutationsIndividually(mutations);
        }

        const normalizedStatus = normalizePushStatus(parsedResult.status);
        const currentBaseVersion = currentBaseVersionById.get(mutationId) ?? mutation.baseVersion;

        if (normalizedStatus === 'APPLIED') {
          await setStoredEntityVersion(mutation.entityType, mutation.entityId, currentBaseVersion + 1);
          continue;
        }

        if (normalizedStatus === 'DUPLICATE') {
          continue;
        }

        if (normalizedStatus === 'NOT_FOUND' && mutation.allowNotFound) {
          continue;
        }

        if (normalizedStatus === 'NOT_FOUND' && normalizeText(mutation.op).includes('CREATE')) {
          return {
            ok: false,
            message:
              'Falha no sync: backend não suporta criação de rotas/waypoints via /sync/push. Atualize o backend para aceitar mutações CREATE.',
            recoveredDuplicateCreate: false
          };
        }

        if (
          normalizedStatus === 'CONFLICT' &&
          conflictAttempt === 0 &&
          Number.isFinite(parsedResult.serverVersion) &&
          (parsedResult.serverVersion ?? -1) >= 0
        ) {
          const serverVersion = Math.trunc(parsedResult.serverVersion ?? currentBaseVersion);
          currentBaseVersionById.set(mutationId, serverVersion);
          await setStoredEntityVersion(mutation.entityType, mutation.entityId, serverVersion);
          conflictedMutationIds.push(mutationId);
          continue;
        }

        const serverVersionMessage = Number.isFinite(parsedResult.serverVersion)
          ? ` (serverVersion=${parsedResult.serverVersion})`
          : '';
        return {
          ok: false,
          message: `Mutação ${mutation.mutationId} rejeitada com status ${normalizedStatus}${serverVersionMessage}.`,
          recoveredDuplicateCreate: false
        };
      }

      if (conflictedMutationIds.length === 0) {
        return { ok: true, recoveredDuplicateCreate: false };
      }

      pendingMutationIds = conflictedMutationIds;
      pendingMutations = conflictedMutationIds
        .map((mutationId) => mutationById.get(mutationId))
        .filter((entry): entry is SyncMutation => Boolean(entry));
    }
  }

  return pushMutationsIndividually(mutations);
}

async function pushMutationsInBatches(mutations: SyncMutation[]): Promise<PushMutationsResult> {
  if (mutations.length === 0) {
    return { ok: true, recoveredDuplicateCreate: false };
  }

  let recoveredDuplicateCreate = false;
  const chunks = splitIntoChunks(mutations, SYNC_PUSH_BATCH_SIZE);
  for (const chunk of chunks) {
    const chunkResult = await pushMutationBatch(chunk);
    if (!chunkResult.ok) {
      return {
        ok: false,
        message: chunkResult.message ?? 'Falha ao sincronizar mutações pendentes.',
        recoveredDuplicateCreate: recoveredDuplicateCreate || chunkResult.recoveredDuplicateCreate
      };
    }
    if (chunkResult.recoveredDuplicateCreate) {
      recoveredDuplicateCreate = true;
    }
  }

  return { ok: true, recoveredDuplicateCreate };
}

function normalizeLockKeys(lockKeys: string[]) {
  return [...new Set(
    lockKeys
      .map((key) => key.trim())
      .filter((key) => key.length > 0)
  )].sort();
}

async function resolveQueueItemLockKeys(item: SyncQueueItem) {
  const payload = item.payload ?? {};
  const lockKeys: string[] = [];

  switch (item.opType) {
    case 'IMPORT_ROUTE_FILE': {
      const routeIds = extractImportRouteIds(payload);
      for (const routeId of routeIds) {
        lockKeys.push(`route:${routeId}`);
      }

      const importId = toOptionalPositiveInt(payload.import_id ?? payload.importId);
      if (importId) {
        lockKeys.push(`import:${importId}`);
      }

      if (lockKeys.length === 0) {
        lockKeys.push(`import-queue:${item.id}`);
      }
      break;
    }
    case 'START_ROUTE':
    case 'FINISH_ROUTE':
    case 'REORDER_WAYPOINTS':
    case 'DELETE_ROUTE': {
      const routeId = toQueueRouteId(payload);
      if (routeId) {
        lockKeys.push(`route:${routeId}`);
      }
      break;
    }
    case 'UPDATE_WAYPOINT_STATUS': {
      const payloadRouteId = toQueueRouteId(payload);
      if (payloadRouteId) {
        lockKeys.push(`route:${payloadRouteId}`);
        break;
      }

      const waypointId = toQueueWaypointId(payload);
      if (!waypointId) {
        break;
      }

      const localWaypoint = await getLocalWaypoint(waypointId);
      const localRouteId = toOptionalPositiveInt(localWaypoint?.route_id);
      if (localRouteId) {
        lockKeys.push(`route:${localRouteId}`);
      } else {
        lockKeys.push(`waypoint:${waypointId}`);
      }
      break;
    }
    default:
      break;
  }

  if (lockKeys.length === 0) {
    lockKeys.push(`queue:${item.id}`);
  }

  return normalizeLockKeys(lockKeys);
}

async function processPendingQueueItem(
  item: SyncQueueItem,
  deviceId: string
): Promise<ProcessPendingQueueItemResult> {
  try {
    const mutations = await buildMutationsForQueueItem(item, deviceId);

    if (mutations.length === 0) {
      await markSyncOperationDone(item.id);
      return {
        item,
        ok: true,
        failedMessage: null,
        pushed: true,
        requiresRemoteOverwrite: false
      };
    }

    let itemFailedMessage: string | null = null;
    let recoveredDuplicateCreate = false;
    const pushResult = await pushMutationsInBatches(mutations);
    if (!pushResult.ok) {
      itemFailedMessage = pushResult.message ?? 'Falha ao sincronizar mutação pendente.';
    }
    if (pushResult.recoveredDuplicateCreate) {
      recoveredDuplicateCreate = true;
    }

    if (itemFailedMessage) {
      await markSyncOperationFailed(item.id, itemFailedMessage);
      return {
        item,
        ok: false,
        failedMessage: itemFailedMessage,
        pushed: false,
        requiresRemoteOverwrite: false
      };
    }

    await markSyncOperationDone(item.id);
    return {
      item,
      ok: true,
      failedMessage: null,
      pushed: true,
      requiresRemoteOverwrite: recoveredDuplicateCreate && item.opType === 'IMPORT_ROUTE_FILE'
    };
  } catch (error) {
    const message = getApiError(error);
    await markSyncOperationFailed(item.id, message);
    return {
      item,
      ok: false,
      failedMessage: message,
      pushed: false,
      requiresRemoteOverwrite: false
    };
  }
}

function notifySyncFinished(result: SyncResult) {
  syncFinishedListeners.forEach((listener) => {
    try {
      listener(result);
    } catch {
      // Ignora erros de listener para não quebrar o fluxo de sync.
    }
  });
}

async function processPendingQueue(): Promise<ProcessPendingQueueResult> {
  const authSession = await loadAuthSession().catch(() => null);
  try {
    const identity = await resolveDriverIdentityForSync({}, authSession);
    if (identity.driverId) {
      await backfillPendingImportDriverId(identity.driverId);
    }
  } catch {
    // Mantém fluxo de sync mesmo quando não for possível resolver motorista para backfill da fila.
  }

  const pending = await listPendingSyncOperations(500);
  if (pending.length === 0) {
    return {
      processed: 0,
      failed: false,
      failedMessage: null as string | null,
      pushedItems: [],
      requiresRemoteOverwrite: false
    };
  }

  const deviceId = await getSyncDeviceId();
  const pendingWithLocks: PendingQueueItemWithLocks[] = [];
  for (const [queueIndex, item] of pending.entries()) {
    pendingWithLocks.push({
      item,
      lockKeys: await resolveQueueItemLockKeys(item),
      queueIndex
    });
  }

  const results: Array<{
    queueIndex: number;
    result: ProcessPendingQueueItemResult;
  }> = [];
  const activeLocks = new Set<string>();
  const started = new Set<number>();
  const completed = new Set<number>();
  let nextCursor = 0;
  let firstFailureQueueIndex = Number.POSITIVE_INFINITY;
  let firstFailureMessage: string | null = null;
  let shouldStopScheduling = false;

  const canStartEntry = (entry: PendingQueueItemWithLocks) => {
    if (entry.lockKeys.length === 0) {
      return true;
    }
    return entry.lockKeys.every((key) => !activeLocks.has(key));
  };

  const reserveLocks = (entry: PendingQueueItemWithLocks) => {
    for (const key of entry.lockKeys) {
      activeLocks.add(key);
    }
  };

  const releaseLocks = (entry: PendingQueueItemWithLocks) => {
    for (const key of entry.lockKeys) {
      activeLocks.delete(key);
    }
  };

  const claimNextEntry = () => {
    for (let index = nextCursor; index < pendingWithLocks.length; index += 1) {
      if (started.has(index)) {
        continue;
      }
      const entry = pendingWithLocks[index];
      if (!canStartEntry(entry)) {
        continue;
      }
      started.add(index);
      reserveLocks(entry);
      if (index === nextCursor) {
        while (nextCursor < pendingWithLocks.length && started.has(nextCursor)) {
          nextCursor += 1;
        }
      }
      return { index, entry };
    }
    return null;
  };

  const workerCount = Math.max(1, Math.min(SYNC_QUEUE_WORKERS, pendingWithLocks.length));
  const worker = async () => {
    while (true) {
      if (shouldStopScheduling) {
        return;
      }

      const claimed = claimNextEntry();
      if (!claimed) {
        return;
      }

      const { index, entry } = claimed;
      const itemResult = await processPendingQueueItem(entry.item, deviceId);
      results.push({ queueIndex: entry.queueIndex, result: itemResult });
      completed.add(index);
      releaseLocks(entry);

      if (!itemResult.ok && itemResult.failedMessage) {
        if (entry.queueIndex < firstFailureQueueIndex) {
          firstFailureQueueIndex = entry.queueIndex;
          firstFailureMessage = itemResult.failedMessage;
        }
        shouldStopScheduling = true;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const orderedResults = [...results].sort((left, right) => left.queueIndex - right.queueIndex);
  const pushedItems = orderedResults
    .filter((entry) => entry.result.ok && entry.result.pushed)
    .map((entry) => entry.result.item);
  const processed = pushedItems.length;
  const requiresRemoteOverwrite = orderedResults.some((entry) => entry.result.requiresRemoteOverwrite);
  const failedMessage = firstFailureMessage;

  return {
    processed,
    failed: failedMessage !== null,
    failedMessage,
    pushedItems,
    requiresRemoteOverwrite
  };
}

async function reconcileRecentlyPushedOperations(operations: SyncQueueItem[]) {
  if (operations.length === 0) {
    return;
  }

  for (const operation of operations) {
    const payload = operation.payload ?? {};

    switch (operation.opType) {
      case 'START_ROUTE': {
        const routeId = toQueueRouteId(payload);
        if (!routeId) {
          break;
        }
        const route = await getLocalRoute(routeId);
        if (route && shouldUpgradeRouteStatus(route.status, 'EM_ANDAMENTO')) {
          await updateLocalRouteStatus(routeId, 'EM_ANDAMENTO');
        }
        break;
      }
      case 'FINISH_ROUTE': {
        const routeId = toQueueRouteId(payload);
        if (!routeId) {
          break;
        }
        const route = await getLocalRoute(routeId);
        if (route && shouldUpgradeRouteStatus(route.status, 'FINALIZADA')) {
          await updateLocalRouteStatus(routeId, 'FINALIZADA');
        }
        break;
      }
      case 'REORDER_WAYPOINTS': {
        const routeId = toQueueRouteId(payload);
        if (!routeId) {
          break;
        }
        const reorderedWaypoints = extractQueuedReorderedWaypoints(payload);
        if (reorderedWaypoints.length === 0) {
          break;
        }

        const applicableReorder = [];
        for (const entry of reorderedWaypoints) {
          const waypoint = await getLocalWaypoint(entry.waypoint_id);
          if (!waypoint || Number(waypoint.route_id) !== routeId || isTerminalWaypointStatus(waypoint.status)) {
            continue;
          }
          applicableReorder.push(entry);
        }

        if (applicableReorder.length > 0) {
          await applyLocalWaypointReorder(routeId, applicableReorder);
        }
        break;
      }
      case 'UPDATE_WAYPOINT_STATUS': {
        const waypointId = toQueueWaypointId(payload);
        const targetStatus = normalizeQueuedWaypointStatus(payload.status);
        if (!waypointId || !targetStatus) {
          break;
        }
        const waypoint = await getLocalWaypoint(waypointId);
        if (!waypoint) {
          break;
        }

        if (
          waypoint.status === targetStatus ||
          shouldUpgradeWaypointStatus(waypoint.status, targetStatus) ||
          isTerminalWaypointStatus(targetStatus)
        ) {
          await updateLocalWaypointStatus(waypointId, targetStatus);
        }
        break;
      }
      case 'DELETE_ROUTE': {
        const routeId = toQueueRouteId(payload);
        if (!routeId) {
          break;
        }
        await deleteLocalRoute(routeId);
        break;
      }
      default:
        break;
    }
  }
}

async function pullRemoteSnapshot(options?: SyncOptions) {
  const lastSyncAt = await getLastSyncAt();
  const payload = options?.fullPull ? {} : lastSyncAt ? { sinceTs: lastSyncAt } : {};

  const { data } = await httpClient.post(buildFastRouteApiUrl('/sync/pull'), payload, {
    timeout: SYNC_PULL_HTTP_TIMEOUT_MS
  });

  if (!isPayloadOk(data)) {
    throw new Error(readErrorMessage(data, 'Falha ao atualizar rotas.'));
  }

  let routes = extractRoutesFromPullResponse(data);

  if (routes.length === 0) {
    try {
      // Fallback de compatibilidade: alguns ambientes ainda expõem o snapshot em /route.
      const fallbackRoutes = await hydrateRoutesFromLegacyRouteSnapshotEndpoint();
      if (fallbackRoutes.length > 0) {
        routes = fallbackRoutes;
      }
    } catch {
      // Mantém silencioso para preservar o fluxo principal de /sync/pull.
    }
  }

  if (routes.length > 0) {
    const enrichedRoutes = await enrichRoutesWithDetailedAddress(routes);
    if (options?.fullPull) {
      await saveRouteSnapshot(enrichedRoutes);
    } else {
      await mergeRouteSnapshot(enrichedRoutes);
    }
  }

  return routes.length;
}

export async function forceLegacyRouteHydration() {
  const routes = await hydrateRoutesFromLegacyRouteSnapshotEndpoint();
  if (routes.length > 0) {
    const enrichedRoutes = await enrichRoutesWithDetailedAddress(routes);
    await saveRouteSnapshot(enrichedRoutes);
    await setLastSyncAt(new Date().toISOString());
  }
  return routes.length;
}

async function getPreSyncConnectivityError() {
  try {
    await httpClient.get(buildFastRouteApiUrl('/health'), {
      timeout: SYNC_CONNECTIVITY_PROBE_TIMEOUT_MS
    });
    return null;
  } catch (error) {
    const message = getApiError(error);
    if (!isTransientPushFailureMessage(message)) {
      return null;
    }
    return 'Sem conexão com a internet. Verifique a rede e tente novamente.';
  }
}

async function runSync(trigger: SyncTrigger, options?: SyncOptions): Promise<SyncResult> {
  if (!getAuthAccessToken()) {
    const pendingOperations = await countPendingSyncOperations();
    return {
      ok: false,
      trigger,
      pulledRoutes: 0,
      processedOperations: 0,
      pendingOperations,
      error: 'Faça login para sincronizar com o backend.'
    };
  }

  const connectivityError = await getPreSyncConnectivityError();
  if (connectivityError) {
    const pendingOperations = await countPendingSyncOperations();
    return {
      ok: false,
      trigger,
      pulledRoutes: 0,
      processedOperations: 0,
      pendingOperations,
      error: connectivityError
    };
  }

  const queueResult = await processPendingQueue();
  if (queueResult.failed) {
    const pendingOperations = await countPendingSyncOperations();
    return {
      ok: false,
      trigger,
      pulledRoutes: 0,
      processedOperations: queueResult.processed,
      pendingOperations,
      error: queueResult.failedMessage ?? 'Falha ao sincronizar dados pendentes.'
    };
  }

  let pulledRoutes = 0;
  try {
    pulledRoutes = await pullRemoteSnapshot(
      queueResult.requiresRemoteOverwrite ? { ...(options ?? {}), fullPull: true } : options
    );
    await reconcileRecentlyPushedOperations(queueResult.pushedItems);
  } catch (error) {
    const pendingOperations = await countPendingSyncOperations();
    return {
      ok: false,
      trigger,
      pulledRoutes: 0,
      processedOperations: queueResult.processed,
      pendingOperations,
      error: error instanceof Error ? error.message : 'Falha ao atualizar rotas.'
    };
  }

  const nowIso = new Date().toISOString();
  await setLastSyncAt(nowIso);

  if (trigger === 'scheduled') {
    await setLastDailySyncDate(toLocalDate(new Date()));
  }

  const pendingOperations = await countPendingSyncOperations();
  return {
    ok: true,
    trigger,
    pulledRoutes,
    processedOperations: queueResult.processed,
    pendingOperations
  };
}

async function runSyncWithTimeout(trigger: SyncTrigger, options?: SyncOptions): Promise<SyncResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutResultPromise = new Promise<SyncResult>((resolve) => {
    timeoutId = setTimeout(() => {
      void (async () => {
        const pendingOperations = await countPendingSyncOperations();
        resolve({
          ok: false,
          trigger,
          pulledRoutes: 0,
          processedOperations: 0,
          pendingOperations,
          error: 'Tempo limite da sincronização excedido. Tente novamente.'
        });
      })();
    }, SYNC_TIMEOUT_MS);
  });

  const result = await Promise.race([runSync(trigger, options), timeoutResultPromise]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  return result;
}

export async function syncNow(trigger: SyncTrigger = 'manual', options?: SyncOptions): Promise<SyncResult> {
  if (!syncInFlight) {
    syncInFlight = runSyncWithTimeout(trigger, options)
      .then((result) => {
        notifySyncFinished(result);
        return result;
      })
      .finally(() => {
        syncInFlight = null;
      });
  }
  return syncInFlight;
}

export function isSyncRunning() {
  return Boolean(syncInFlight);
}

export async function maybeRunScheduledSync() {
  if (isSyncRunning()) {
    return null;
  }

  const scheduleTime = await getDailySyncTime();
  const parsedTime = parseSyncTime(scheduleTime);
  if (!parsedTime) {
    return null;
  }

  const now = new Date();
  const today = toLocalDate(now);
  const lastDailySyncDate = await getLastDailySyncDate();
  if (lastDailySyncDate === today) {
    return null;
  }

  const scheduleDate = new Date(now);
  scheduleDate.setHours(parsedTime.hh, parsedTime.mm, 0, 0);
  if (now < scheduleDate) {
    return null;
  }

  return syncNow('scheduled');
}

export async function maybeRunInitialAutoSync() {
  if (isSyncRunning()) {
    return null;
  }

  if (!getAuthAccessToken()) {
    return null;
  }

  const initialSyncDone = await isInitialSyncDone();
  if (initialSyncDone) {
    const localRoutes = await listLocalRoutes();
    if (localRoutes.length > 0) {
      return null;
    }
  }

  const result = await syncNow('manual');
  if (result.ok) {
    await setInitialSyncDone(true);
  }
  return result;
}

export function formatSyncSummary(result: SyncResult) {
  if (!result.ok) {
    return result.error ?? 'Falha na sincronização.';
  }

  return `Sincronização concluída. Rotas atualizadas: ${result.pulledRoutes}.`;
}

export function subscribeSyncFinished(listener: SyncFinishedListener) {
  syncFinishedListeners.add(listener);
  return () => {
    syncFinishedListeners.delete(listener);
  };
}
