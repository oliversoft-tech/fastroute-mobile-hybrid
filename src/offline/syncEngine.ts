import { RouteDetail, RouteStatus, Waypoint, WaypointStatus } from '../api/types';
import { getApiError, getAuthAccessToken, httpClient } from '../api/httpClient';
import { buildFastRouteApiUrl } from '../config/api';
import {
  SyncQueueItem,
  countPendingSyncOperations,
  getDailySyncTime,
  getLastDailySyncDate,
  getLastSyncAt,
  isInitialSyncDone,
  listLocalRoutes,
  listPendingSyncOperations,
  markSyncOperationDone,
  markSyncOperationFailed,
  saveRouteSnapshot,
  setInitialSyncDone,
  setLastDailySyncDate,
  setLastSyncAt
} from './localDb';

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

let syncInFlight: Promise<SyncResult> | null = null;
const syncFinishedListeners = new Set<SyncFinishedListener>();
const SYNC_TIMEOUT_MS = 45000;

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
    record.changes,
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
  const longitude = toNullableNumber(item.longitude ?? item.lng ?? item.lon ?? address?.longitude ?? address?.lng);

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

function normalizeRoute(raw: unknown): RouteDetail | null {
  const item = asRecord(raw);
  if (!item) {
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
    status: normalizeRouteStatus(item.status),
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

  const changeRoutes = extractArray(root.changes)
    .flatMap((change) => {
      const changeRecord = asRecord(change);
      if (!changeRecord) {
        return [] as unknown[];
      }

      return [
        changeRecord.route,
        changeRecord.data,
        changeRecord.payload,
        asRecord(changeRecord.payload)?.route,
        asRecord(changeRecord.data)?.route
      ].filter((candidate) => candidate !== undefined) as unknown[];
    })
    .map((entry) => normalizeRoute(entry))
    .filter((entry): entry is RouteDetail => Boolean(entry));

  const deduplicated = new Map<number, RouteDetail>();
  [...directRoutes, ...changeRoutes].forEach((route) => {
    deduplicated.set(route.id, route);
  });
  return Array.from(deduplicated.values());
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

function notifySyncFinished(result: SyncResult) {
  syncFinishedListeners.forEach((listener) => {
    try {
      listener(result);
    } catch {
      // Ignora erros de listener para não quebrar o fluxo de sync.
    }
  });
}

async function processPendingQueue() {
  const pending = await listPendingSyncOperations(500);
  if (pending.length === 0) {
    return { processed: 0, failed: false, failedMessage: null as string | null };
  }

  const changes = pending.map((item: SyncQueueItem) => ({
    id: item.id,
    op_type: item.opType,
    payload: item.payload,
    created_at: item.createdAt,
    retry_count: item.retryCount
  }));

  try {
    const { data } = await httpClient.post(buildFastRouteApiUrl('/sync/push'), {
      changes
    });

    if (!isPayloadOk(data)) {
      throw new Error(readErrorMessage(data, 'Falha ao sincronizar dados pendentes.'));
    }

    await Promise.all(pending.map((item) => markSyncOperationDone(item.id)));
    return { processed: pending.length, failed: false, failedMessage: null as string | null };
  } catch (error) {
    const message = getApiError(error);
    await markSyncOperationFailed(pending[0].id, message);
    return { processed: 0, failed: true, failedMessage: message };
  }
}

async function pullRemoteSnapshot(options?: SyncOptions) {
  const lastSyncAt = await getLastSyncAt();
  const payload = options?.fullPull ? {} : lastSyncAt ? { last_sync_at: lastSyncAt } : {};

  const { data } = await httpClient.post(buildFastRouteApiUrl('/sync/pull'), payload);

  if (!isPayloadOk(data)) {
    throw new Error(readErrorMessage(data, 'Falha ao atualizar rotas.'));
  }

  let routes = extractRoutesFromPullResponse(data);

  if (routes.length === 0) {
    try {
      // Fallback de compatibilidade: alguns ambientes ainda expõem o snapshot em /route.
      const routeSnapshotResponse = await httpClient.get(buildFastRouteApiUrl('/route'));
      if (isPayloadOk(routeSnapshotResponse.data)) {
        const fallbackRoutes = extractRoutesFromPullResponse(routeSnapshotResponse.data);
        if (fallbackRoutes.length > 0) {
          routes = fallbackRoutes;
        }
      }
    } catch {
      // Mantém silencioso para preservar o fluxo principal de /sync/pull.
    }
  }

  if (routes.length > 0) {
    await saveRouteSnapshot(routes);
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
  const queueWarning = queueResult.failed
    ? queueResult.failedMessage ?? 'Falha ao sincronizar dados pendentes.'
    : undefined;

  let pulledRoutes = 0;
  try {
    pulledRoutes = await pullRemoteSnapshot(options);
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
    pendingOperations,
    error: queueWarning
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
