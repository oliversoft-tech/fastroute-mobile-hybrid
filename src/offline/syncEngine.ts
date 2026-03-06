import { RouteDetail, RouteStatus, Waypoint, WaypointStatus } from '../api/types';
import { getApiError, getAuthAccessToken, httpClient } from '../api/httpClient';
import { buildFastRouteApiUrl } from '../config/api';
import { enrichWaypointsWithAddressData, resolveDriverUserIdFromAuthId } from '../api/supabaseDataApi';
import {
  applyLocalWaypointReorder,
  SyncQueueItem,
  countPendingSyncOperations,
  deleteLocalRoute,
  getAppSetting,
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

let syncInFlight: Promise<SyncResult> | null = null;
const syncFinishedListeners = new Set<SyncFinishedListener>();
const SYNC_TIMEOUT_MS = 180000;
const SYNC_HTTP_TIMEOUT_MS = 120000;
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
  const id = toPositiveInt(item.id ?? item.waypoint_id ?? item.waypointId, 0);
  if (!id) {
    return null;
  }

  const seqOrder = toPositiveInt(item.seq_order ?? item.seqorder ?? item.seqOrder, index + 1);
  const latitude = toNullableNumber(item.latitude ?? item.lat ?? address?.latitude ?? address?.lat);
  const longitude = toNullableNumber(
    item.longitude ??
      item.long ??
      item.lng ??
      item.lon ??
      address?.longitude ??
      address?.lng ??
      address?.long
  );

  return {
    id,
    route_id: toPositiveInt(item.route_id ?? item.routeId, routeId),
    address_id: toPositiveInt(item.address_id ?? item.addressId ?? address?.id, id),
    user_id: toNullableNumber(item.user_id ?? item.userId),
    seq_order: seqOrder,
    status: normalizeWaypointStatus(item.status),
    title: pickString(
      item.detailed_address,
      item.title,
      item.name,
      address?.detailed_address,
      address?.title,
      address?.street
    ),
    subtitle: pickString(item.subtitle, item.address_subtitle, address?.subtitle, address?.city),
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

function mergeRouteDetails(existing: RouteDetail | undefined, incoming: RouteDetail): RouteDetail {
  const incomingWaypoints = incoming.waypoints ?? [];
  const existingWaypoints = existing?.waypoints ?? [];

  const mergedWaypointsById = new Map<number, Waypoint>();
  for (const waypoint of existingWaypoints) {
    mergedWaypointsById.set(waypoint.id, waypoint);
  }
  for (const waypoint of incomingWaypoints) {
    mergedWaypointsById.set(waypoint.id, waypoint);
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
    timeout: SYNC_HTTP_TIMEOUT_MS
  });
  if (!isPayloadOk(routeSnapshotResponse.data)) {
    return [] as RouteDetail[];
  }

  return extractRoutesFromPullResponse(routeSnapshotResponse.data);
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

      const waypoint = normalizeWaypoint(waypointRaw, routeId, 0);
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
      mergedWaypointsMap.set(waypoint.id, waypoint);
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
  return normalized !== 'ENDERECO NAO INFORMADO';
}

async function enrichRoutesWithDetailedAddress(routes: RouteDetail[]) {
  if (routes.length === 0) {
    return routes;
  }

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

      try {
        const enrichedWaypoints = await enrichWaypointsWithAddressData(baseWaypoints);
        return {
          ...route,
          waypoints: enrichedWaypoints,
          waypoints_count: enrichedWaypoints.length
        };
      } catch {
        return route;
      }
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
    allowNotFound = false
  ) => {
    const normalizedOp = normalizeText(op);
    const baseVersion = normalizedOp.includes('CREATE')
      ? 0
      : await getStoredEntityVersion('route', routeId);
    mutations.push({
      queueItemId: item.id,
      mutationId: `${item.id}-route-${routeId}-${randomId()}`,
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
    allowNotFound = false
  ) => {
    const normalizedOp = normalizeText(op);
    const baseVersion = normalizedOp.includes('CREATE')
      ? 0
      : await getStoredEntityVersion('route_waypoint', waypointId);
    mutations.push({
      queueItemId: item.id,
      mutationId: `${item.id}-waypoint-${waypointId}-${randomId()}`,
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
      for (const entry of reordered) {
        await pushWaypointMutation(
          entry.waypoint_id,
          'UPDATE',
          { route_id: routeId ?? undefined, seq_order: entry.seqorder, status: 'REORDENADO' }
        );
      }
      return mutations;
    }
    case 'DELETE_ROUTE': {
      const routeId = toQueueRouteId(payload);
      if (!routeId) {
        return mutations;
      }
      await pushRouteMutation(routeId, 'DELETE', { status: 'CANCELADA', ativa: false });
      return mutations;
    }
    case 'IMPORT_ROUTE_FILE': {
      const authSession = await loadAuthSession().catch(() => null);
      const authUserIdFromSession = pickString(authSession?.userId) ?? null;
      const authUserIdFromPayload = pickString(payload.auth_user_id, payload.authUserId) ?? null;
      const authUserId = authUserIdFromPayload ?? authUserIdFromSession;
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

      if (routeIds.length === 0) {
        throw new Error('Falha no sync: payload de IMPORT_ROUTE_FILE sem route_ids válidos.');
      }

      let driverId =
        toOptionalPositiveInt(payload.driver_id) ??
        toOptionalPositiveInt(payload.driverId) ??
        toOptionalPositiveInt(payload.user_id) ??
        toOptionalPositiveInt(payload.userId) ??
        toOptionalPositiveInt(authSession?.userId) ??
        toOptionalPositiveInt(authUserId);

      if (!driverId && authUserId) {
        try {
          const resolvedDriverId = await resolveDriverUserIdFromAuthId(authUserId);
          driverId = toOptionalPositiveInt(resolvedDriverId);
        } catch (error) {
          throw new Error(`Falha no sync: erro ao resolver driver_id via auth_user_id: ${getApiError(error)}`);
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

      for (const routeId of routeIds) {
        const localRoute = await getLocalRoute(routeId);
        if (!localRoute) {
          continue;
        }

        const localWaypoints = await listLocalWaypoints(routeId);
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
        });

        for (const waypoint of localWaypoints) {
          await pushWaypointMutation(waypoint.id, 'CREATE', {
            id: waypoint.id,
            route_id: routeId,
            user_id: waypoint.user_id ?? driverId ?? null,
            address_id: waypoint.address_id ?? null,
            seq_order: waypoint.seq_order ?? 0,
            status: mapQueuedWaypointStatusToServer(waypoint.status),
            detailed_address: waypoint.title ?? null,
            lat: waypoint.latitude ?? null,
            long: waypoint.longitude ?? null
          });
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

async function pushSingleMutation(mutation: SyncMutation): Promise<{ ok: boolean; message?: string }> {
  let currentBaseVersion = mutation.baseVersion;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data } = await httpClient.post(
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
        timeout: SYNC_HTTP_TIMEOUT_MS
      }
    );

    if (!isPayloadOk(data)) {
      return { ok: false, message: readErrorMessage(data, 'Falha ao sincronizar mutação pendente.') };
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
    return { ok: false, message: `Mutação ${mutation.mutationId} rejeitada com status ${normalizedStatus}${serverVersionMessage}.` };
  }

  return { ok: false, message: 'Falha desconhecida ao aplicar mutação pendente.' };
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
  const pending = await listPendingSyncOperations(500);
  if (pending.length === 0) {
    return { processed: 0, failed: false, failedMessage: null as string | null, pushedItems: [] };
  }

  const deviceId = await getSyncDeviceId();
  const pushedItems: SyncQueueItem[] = [];
  let processed = 0;
  let firstFailureMessage: string | null = null;

  for (const item of pending) {
    try {
      const mutations = await buildMutationsForQueueItem(item, deviceId);

      if (mutations.length === 0) {
        await markSyncOperationDone(item.id);
        processed += 1;
        pushedItems.push(item);
        continue;
      }

      let itemFailedMessage: string | null = null;
      for (const mutation of mutations) {
        const mutationResult = await pushSingleMutation(mutation);
        if (!mutationResult.ok) {
          itemFailedMessage = mutationResult.message ?? 'Falha ao sincronizar mutação pendente.';
          break;
        }
      }

      if (itemFailedMessage) {
        await markSyncOperationFailed(item.id, itemFailedMessage);
        if (!firstFailureMessage) {
          firstFailureMessage = itemFailedMessage;
        }
        break;
      }

      await markSyncOperationDone(item.id);
      processed += 1;
      pushedItems.push(item);
    } catch (error) {
      const message = getApiError(error);
      await markSyncOperationFailed(item.id, message);
      if (!firstFailureMessage) {
        firstFailureMessage = message;
      }
      break;
    }
  }

  return {
    processed,
    failed: firstFailureMessage !== null,
    failedMessage: firstFailureMessage,
    pushedItems
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
    timeout: SYNC_HTTP_TIMEOUT_MS
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
    pulledRoutes = await pullRemoteSnapshot(options);
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
