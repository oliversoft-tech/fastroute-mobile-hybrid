import { ImportResult, RouteDetail } from '../api/types';
import { importOrders as importOrdersRemote } from '../api/ordersRemoteApi';
import { getAuthAccessToken } from '../api/httpClient';
import {
  deleteRoute as deleteRouteRemote,
  finishRoute as finishRouteRemote,
  listRouteWaypoints as listRouteWaypointsRemote,
  listRoutes as listRoutesRemote,
  startRoute as startRouteRemote,
  updateWaypointOrder as updateWaypointOrderRemote,
  updateWaypointStatus as updateWaypointStatusRemote
} from '../api/routesRemoteApi';
import {
  SyncQueueItem,
  countPendingSyncOperations,
  getLastDailySyncDate,
  getDailySyncTime,
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
type SyncWaypointFinishStatus =
  | 'PENDENTE'
  | 'REORDENADO'
  | 'EM_ROTA'
  | 'CONCLUIDO'
  | 'ENTREGUE'
  | 'FALHA TEMPO ADVERSO'
  | 'FALHA MORADOR AUSENTE';

export interface SyncResult {
  ok: boolean;
  trigger: SyncTrigger;
  pulledRoutes: number;
  processedOperations: number;
  pendingOperations: number;
  error?: string;
}

type SyncFinishedListener = (result: SyncResult) => void;

let syncInFlight: Promise<SyncResult> | null = null;
const syncFinishedListeners = new Set<SyncFinishedListener>();
const SYNC_TIMEOUT_MS = 45000;

function notifySyncFinished(result: SyncResult) {
  syncFinishedListeners.forEach((listener) => {
    try {
      listener(result);
    } catch {
      // Ignora erros de listener para não quebrar o fluxo de sync.
    }
  });
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

async function processQueueItem(item: SyncQueueItem) {
  const payload = item.payload;

  if (item.opType === 'IMPORT_ROUTE_FILE') {
    const file = {
      uri: String(payload.uri ?? ''),
      name: String(payload.name ?? ''),
      mimeType: payload.mimeType ? String(payload.mimeType) : undefined,
      epsMeters: Number(payload.eps_meters)
    };
    await importOrdersRemote(file);
    return;
  }

  if (item.opType === 'START_ROUTE') {
    const routeId = Math.trunc(Number(payload.routeId));
    if (Number.isFinite(routeId) && routeId > 0) {
      await startRouteRemote(routeId);
    }
    return;
  }

  if (item.opType === 'FINISH_ROUTE') {
    const routeId = Math.trunc(Number(payload.routeId));
    if (Number.isFinite(routeId) && routeId > 0) {
      await finishRouteRemote(routeId);
    }
    return;
  }

  if (item.opType === 'DELETE_ROUTE') {
    const routeId = Math.trunc(Number(payload.routeId));
    if (Number.isFinite(routeId) && routeId > 0) {
      await deleteRouteRemote(routeId);
    }
    return;
  }

  if (item.opType === 'UPDATE_WAYPOINT_STATUS') {
    const routeId = Math.trunc(Number(payload.routeId));
    const waypointId = Math.trunc(Number(payload.waypointId));
    const status = String(payload.status ?? 'PENDENTE') as SyncWaypointFinishStatus;
    const options = (payload.options ?? {}) as {
      obs_falha?: string;
      file_name?: string;
      user_id?: string | number;
      address_id?: number;
      image_uri?: string;
    };
    if (Number.isFinite(routeId) && routeId > 0 && Number.isFinite(waypointId) && waypointId > 0) {
      await updateWaypointStatusRemote(routeId, waypointId, status, options);
    }
    return;
  }

  if (item.opType === 'REORDER_WAYPOINTS') {
    const routeId = Math.trunc(Number(payload.routeId));
    const reorderedWaypointsRaw = Array.isArray(payload.reorderedWaypoints)
      ? payload.reorderedWaypoints
      : [];
    const reorderedWaypoints = reorderedWaypointsRaw
      .map((entry) => ({
        seqorder: Math.trunc(Number((entry as Record<string, unknown>).seqorder)),
        waypoint_id: Math.trunc(Number((entry as Record<string, unknown>).waypoint_id))
      }))
      .filter((entry) => Number.isFinite(entry.seqorder) && Number.isFinite(entry.waypoint_id));

    if (Number.isFinite(routeId) && routeId > 0) {
      await updateWaypointOrderRemote({
        routeId,
        reorderedWaypoints
      });
    }
    return;
  }
}

async function processPendingQueue() {
  const pending = await listPendingSyncOperations(500);
  if (pending.length === 0) {
    return { processed: 0, failed: false, failedMessage: null as string | null };
  }

  let processed = 0;
  for (const item of pending) {
    try {
      await processQueueItem(item);
      await markSyncOperationDone(item.id);
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao sincronizar dados.';
      await markSyncOperationFailed(item.id, message);
      return { processed, failed: true, failedMessage: message };
    }
  }

  return { processed, failed: false, failedMessage: null as string | null };
}

async function pullRemoteSnapshot() {
  const remoteRoutes = await listRoutesRemote({ forceRefresh: true });
  const detailedRoutes = await Promise.all(
    remoteRoutes.map(async (route) => {
      const waypoints = await listRouteWaypointsRemote(route.id, { forceRefresh: true });
      const detail: RouteDetail = {
        ...route,
        waypoints_count: waypoints.length,
        waypoints
      };
      return detail;
    })
  );
  await saveRouteSnapshot(detailedRoutes);
  return detailedRoutes.length;
}

async function runSync(trigger: SyncTrigger): Promise<SyncResult> {
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
    pulledRoutes = await pullRemoteSnapshot();
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

async function runSyncWithTimeout(trigger: SyncTrigger): Promise<SyncResult> {
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

  const result = await Promise.race([runSync(trigger), timeoutResultPromise]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  return result;
}

export async function syncNow(trigger: SyncTrigger = 'manual'): Promise<SyncResult> {
  if (!syncInFlight) {
    syncInFlight = runSyncWithTimeout(trigger)
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
