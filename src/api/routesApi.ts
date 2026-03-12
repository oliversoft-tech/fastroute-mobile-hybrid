import {
  canFinishRoute
} from '@oliverbill/fastroute-domain';
import * as FileSystem from 'expo-file-system';
import { RouteDetail, Waypoint, WaypointStatus } from './types';
import {
  applyLocalWaypointReorder,
  backfillLocalWaypointTitlesByAddress,
  deleteLocalRoute,
  enqueueSyncOperation,
  getLastImportedRouteIds as getStoredLastImportedRouteIds,
  getLocalDb,
  getLocalRoute,
  getLocalWaypointPhotoUri,
  getLocalWaypoint,
  listLocalRoutes,
  listLocalWaypoints,
  removeLastImportedRouteId,
  replaceLocalRouteWaypoints,
  setLastImportedRouteIds as setStoredLastImportedRouteIds,
  updatePendingImportRouteIds,
  upsertLocalWaypointPhotoUri,
  updateLocalRouteStatus,
  updateLocalWaypointStatus,
  upsertLocalRoute
} from '../offline/localDb';
import { enrichWaypointsWithAddressData } from './supabaseDataApi';
import { getRouteDetails as getRemoteRouteDetails } from './routesRemoteApi';
import { ensureE2ESeedData } from '../e2e/seedData';

interface QueryCacheOptions {
  forceRefresh?: boolean;
  ttlMs?: number;
}

export type WaypointFinishStatus =
  | WaypointStatus
  | 'ENTREGUE'
  | 'FALHA TEMPO ADVERSO'
  | 'FALHA MORADOR AUSENTE';

type DeleteRouteResult = {
  queuedForSync: boolean;
};

function normalizeRouteStatus(status: string | undefined) {
  const value = String(status ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
  if (value.includes('FINAL') || value.includes('CONCL')) {
    return 'FINALIZADA' as const;
  }
  if (value.includes('EM_ROTA')) {
    return 'EM_ROTA' as const;
  }
  if (value.includes('EM_ANDAMENTO') || value.includes('ANDAMENTO')) {
    return 'EM_ANDAMENTO' as const;
  }
  if (value.includes('CRIADA')) {
    return 'CRIADA' as const;
  }
  return 'PENDENTE' as const;
}

function mapRouteStatusToDomain(status: string | undefined) {
  const normalized = normalizeRouteStatus(status);
  if (normalized === 'EM_ANDAMENTO' || normalized === 'EM_ROTA') {
    return 'EM_ANDAMENTO' as const;
  }
  if (normalized === 'FINALIZADA') {
    return 'CONCLUÍDA' as const;
  }
  return 'PLANEJADA' as const;
}

function mapWaypointStatusToDomain(status: WaypointStatus | string) {
  const value = String(status)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  if (value.includes('REORDEN')) {
    return 'REORDENADO' as const;
  }
  if (value.includes('ENTREGUE') || value.includes('CONCLUID')) {
    return 'ENTREGUE' as const;
  }
  if (value.includes('FALHA TEMPO ADVERSO')) {
    return 'FALHA TEMPO ADVERSO' as const;
  }
  if (value.includes('FALHA MORADOR AUSENTE')) {
    return 'FALHA MORADOR AUSENTE' as const;
  }
  return 'PENDENTE' as const;
}

function mapTargetStatusToDomain(status: WaypointFinishStatus) {
  const normalized = mapWaypointStatusToDomain(String(status));
  if (normalized === 'ENTREGUE') {
    return 'ENTREGUE';
  }
  if (normalized === 'FALHA TEMPO ADVERSO') {
    return 'FALHA TEMPO ADVERSO';
  }
  if (normalized === 'FALHA MORADOR AUSENTE') {
    return 'FALHA MORADOR AUSENTE';
  }
  return String(status).toUpperCase();
}

function mapDomainStatusToLocal(status: string): WaypointStatus {
  if (status === 'ENTREGUE') {
    return 'CONCLUIDO';
  }
  if (status === 'FALHA TEMPO ADVERSO') {
    return 'FALHA TEMPO ADVERSO';
  }
  if (status === 'FALHA MORADOR AUSENTE') {
    return 'FALHA MORADOR AUSENTE';
  }
  if (status === 'REORDENADO') {
    return 'REORDENADO';
  }
  if (status === 'EM_ROTA') {
    return 'EM_ROTA';
  }
  return 'PENDENTE';
}

function ensureRouteExists(route: RouteDetail | null, routeId: number) {
  if (route) {
    return route;
  }
  throw new Error(`Rota #${routeId} não encontrada.`);
}

function isWaypointDeliveredStatus(status: string | WaypointStatus | undefined) {
  const normalized = String(status ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  return normalized.includes('ENTREGUE') || normalized.includes('CONCLUID');
}

function hasDetailedWaypointTitle(title: unknown) {
  if (typeof title !== 'string') {
    return false;
  }

  const normalized = title
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  if (!normalized) {
    return false;
  }

  if (normalized === 'ENDERECO NAO INFORMADO') {
    return false;
  }

  if (/^ENDERECO\s+\d+$/.test(normalized) || /^WAYPOINT\s*#?\s*\d+$/.test(normalized)) {
    return false;
  }

  return true;
}

function toPositiveInteger(value: unknown) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function buildWaypointAddressSeqKey(waypoint: Pick<Waypoint, 'address_id' | 'seq_order'>) {
  const addressId = toPositiveInteger(waypoint.address_id);
  const seqOrder = toPositiveInteger(waypoint.seq_order);
  if (!addressId || !seqOrder) {
    return null;
  }
  return `${addressId}:${seqOrder}`;
}

function mergeDetailedWaypointsFromRemote(
  localWaypoints: Waypoint[],
  remoteWaypoints: Waypoint[]
) {
  const remoteDetailed = remoteWaypoints.filter((waypoint) => hasDetailedWaypointTitle(waypoint.title));
  if (remoteDetailed.length === 0) {
    return { waypoints: localWaypoints, changed: false };
  }

  const remoteById = new Map<number, Waypoint>();
  const remoteByAddressSeq = new Map<string, Waypoint>();
  const remoteByAddressId = new Map<number, Waypoint>();
  const remoteBySeqOrder = new Map<number, Waypoint>();

  for (const waypoint of remoteDetailed) {
    remoteById.set(waypoint.id, waypoint);
    const addressSeqKey = buildWaypointAddressSeqKey(waypoint);
    if (addressSeqKey && !remoteByAddressSeq.has(addressSeqKey)) {
      remoteByAddressSeq.set(addressSeqKey, waypoint);
    }

    const addressId = toPositiveInteger(waypoint.address_id);
    if (addressId && !remoteByAddressId.has(addressId)) {
      remoteByAddressId.set(addressId, waypoint);
    }
    const seqOrder = toPositiveInteger(waypoint.seq_order);
    if (seqOrder && !remoteBySeqOrder.has(seqOrder)) {
      remoteBySeqOrder.set(seqOrder, waypoint);
    }
  }

  let changed = false;
  const merged = localWaypoints.map((waypoint) => {
    if (hasDetailedWaypointTitle(waypoint.title)) {
      return waypoint;
    }

    const byId = remoteById.get(waypoint.id);
    const addressSeqKey = buildWaypointAddressSeqKey(waypoint);
    const byAddressSeq = addressSeqKey ? remoteByAddressSeq.get(addressSeqKey) : undefined;
    const byAddressId = (() => {
      const addressId = toPositiveInteger(waypoint.address_id);
      return addressId ? remoteByAddressId.get(addressId) : undefined;
    })();
    const bySeqOrder = (() => {
      const seqOrder = toPositiveInteger(waypoint.seq_order);
      return seqOrder ? remoteBySeqOrder.get(seqOrder) : undefined;
    })();
    const source = byId ?? byAddressSeq ?? byAddressId ?? bySeqOrder;
    if (!source || !hasDetailedWaypointTitle(source.title)) {
      return waypoint;
    }

    const nextWaypoint: Waypoint = {
      ...waypoint,
      address_id: toPositiveInteger(waypoint.address_id) ?? toPositiveInteger(source.address_id) ?? waypoint.address_id,
      title: source.title,
      subtitle: waypoint.subtitle?.trim() ? waypoint.subtitle : source.subtitle,
      latitude: typeof waypoint.latitude === 'number' ? waypoint.latitude : source.latitude,
      longitude: typeof waypoint.longitude === 'number' ? waypoint.longitude : source.longitude
    };

    changed =
      changed ||
      nextWaypoint.address_id !== waypoint.address_id ||
      nextWaypoint.title !== waypoint.title ||
      nextWaypoint.subtitle !== waypoint.subtitle ||
      nextWaypoint.latitude !== waypoint.latitude ||
      nextWaypoint.longitude !== waypoint.longitude;

    return nextWaypoint;
  });

  return { waypoints: merged, changed };
}

function ensureWaypointPhotoDirectory() {
  const documentDirectory = FileSystem.documentDirectory;
  if (!documentDirectory) {
    throw new Error('Diretório local indisponível para salvar foto da entrega.');
  }
  return `${documentDirectory}delivery-photos`;
}

function normalizePhotoFileName(fileName: string, waypointId: number) {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return `entrega_${waypointId}.jpg`;
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function persistWaypointPhotoBase64(
  waypointId: number,
  fileName: string,
  base64: string
) {
  const directory = ensureWaypointPhotoDirectory();
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const localUri = `${directory}/${normalizePhotoFileName(fileName, waypointId)}`;
  await FileSystem.writeAsStringAsync(localUri, base64, {
    encoding: FileSystem.EncodingType.Base64
  });
  return localUri;
}

export async function listRoutes(_options?: QueryCacheOptions) {
  await ensureE2ESeedData();
  return listLocalRoutes();
}

export async function getRouteDetails(routeId: number, _options?: QueryCacheOptions) {
  await ensureE2ESeedData();
  const route = await getLocalRoute(routeId);
  if (!route) {
    throw new Error(`Rota #${routeId} não encontrada.`);
  }
  const waypoints = await listRouteWaypoints(routeId, _options);
  return {
    ...route,
    waypoints_count: waypoints.length,
    waypoints
  };
}

export async function listRouteWaypoints(routeId: number, _options?: QueryCacheOptions) {
  await ensureE2ESeedData();
  let waypoints = await listLocalWaypoints(routeId);
  const needsLocalBackfill = waypoints.some((waypoint) => !hasDetailedWaypointTitle(waypoint.title));
  if (needsLocalBackfill) {
    await backfillLocalWaypointTitlesByAddress(routeId);
    waypoints = await listLocalWaypoints(routeId);
  }

  const needsAddressEnrichment = waypoints.some((waypoint) => !hasDetailedWaypointTitle(waypoint.title));
  if (!needsAddressEnrichment) {
    return waypoints;
  }

  try {
    const enriched = await enrichWaypointsWithAddressData(waypoints);
    const wasEnriched = enriched.some((waypoint, index) => {
      const original = waypoints[index];
      if (!original) {
        return false;
      }

      return (
        waypoint.address_id !== original.address_id ||
        waypoint.title !== original.title ||
        waypoint.subtitle !== original.subtitle ||
        waypoint.latitude !== original.latitude ||
        waypoint.longitude !== original.longitude
      );
    });

    if (wasEnriched) {
      await replaceLocalRouteWaypoints(routeId, enriched);
    }

    waypoints = enriched;
    if (!waypoints.some((waypoint) => !hasDetailedWaypointTitle(waypoint.title))) {
      return waypoints;
    }
  } catch {
    // segue para fallback remoto quando enriquecimento por endereço falhar
  }

  try {
    const remoteDetail = await getRemoteRouteDetails(routeId, { forceRefresh: true });
    const remoteWaypoints = (remoteDetail.waypoints ?? []).filter((waypoint) => {
      const normalizedRouteId = Number(waypoint.route_id);
      return !Number.isFinite(normalizedRouteId) || normalizedRouteId === routeId;
    });
    const fallback = mergeDetailedWaypointsFromRemote(waypoints, remoteWaypoints);
    if (fallback.changed) {
      await replaceLocalRouteWaypoints(routeId, fallback.waypoints);
      return fallback.waypoints;
    }
  } catch {
    // mantém resposta local quando fallback remoto estiver indisponível
  }

  return waypoints;
}

export async function startRoute(routeId: number) {
  const route = ensureRouteExists(await getLocalRoute(routeId), routeId);
  const nextStatus = route.status === 'EM_ROTA' ? 'EM_ROTA' : 'EM_ANDAMENTO';
  await updateLocalRouteStatus(routeId, nextStatus);
  await enqueueSyncOperation('START_ROUTE', { routeId });
}

export async function finishRoute(routeId: number) {
  const route = ensureRouteExists(await getLocalRoute(routeId), routeId);
  const waypoints = await listLocalWaypoints(routeId);
  const validation = canFinishRoute({
    route: {
      id: route.id,
      status: mapRouteStatusToDomain(route.status)
    },
    waypoints: waypoints.map((item) => ({
      status: mapWaypointStatusToDomain(item.status)
    }))
  });

  if (!validation.ok) {
    throw new Error(validation.error);
  }

  await updateLocalRouteStatus(routeId, 'FINALIZADA');
  await enqueueSyncOperation('FINISH_ROUTE', { routeId });
}

export async function updateWaypointStatus(
  routeId: number,
  waypointId: number,
  status: WaypointFinishStatus,
  options?: {
    obs_falha?: string;
    file_name?: string;
    user_id?: string | number;
    address_id?: number;
    image_uri?: string;
  }
) {
  const localWaypoint = await getLocalWaypoint(waypointId);
  if (!localWaypoint) {
    throw new Error(`Waypoint #${waypointId} não encontrado.`);
  }
  if (Number(localWaypoint.route_id) !== Number(routeId)) {
    throw new Error('Waypoint não pertence à rota selecionada.');
  }

  const targetStatus = mapTargetStatusToDomain(status);

  const normalizedFileName = options?.file_name?.trim() || `entrega_${waypointId}.jpg`;

  const localStatus = mapDomainStatusToLocal(targetStatus);
  await updateLocalWaypointStatus(waypointId, localStatus);
  if (options?.image_uri) {
    await upsertLocalWaypointPhotoUri(waypointId, options.image_uri);
  }

  await enqueueSyncOperation('UPDATE_WAYPOINT_STATUS', {
    routeId,
    waypointId,
    status: targetStatus,
    options: {
      ...options,
      file_name: normalizedFileName
    }
  });
}

export async function updateWaypointOrder(params: {
  routeId: number;
  reorderedWaypoints: Array<{
    seqorder: number;
    waypoint_id: number;
  }>;
}) {
  const routeId = Math.trunc(Number(params.routeId));
  const reorderedWaypoints = params.reorderedWaypoints
    .map((item) => ({
      seqorder: Math.trunc(Number(item.seqorder)),
      waypoint_id: Math.trunc(Number(item.waypoint_id))
    }))
    .filter(
      (item) =>
        Number.isFinite(item.seqorder) &&
        item.seqorder > 0 &&
        Number.isFinite(item.waypoint_id) &&
        item.waypoint_id > 0
    );

  if (!Number.isFinite(routeId) || routeId <= 0) {
    throw new Error('route_id inválido para reordenação.');
  }

  await applyLocalWaypointReorder(routeId, reorderedWaypoints);
  const latestWaypoints = await listLocalWaypoints(routeId);
  const route = await getLocalRoute(routeId);
  if (route) {
    await upsertLocalRoute({
      ...route,
      waypoints_count: latestWaypoints.length
    });
    await replaceLocalRouteWaypoints(routeId, latestWaypoints);
  }

  await enqueueSyncOperation('REORDER_WAYPOINTS', {
    routeId,
    reorderedWaypoints
  });
}

function enforceMinimumWaypointsPerRouteGroup(
  groups: number[][],
  minimumWaypointsPerRoute: number
) {
  const normalizedGroups = groups
    .map((group) =>
      [...new Set(
        group
          .map((value) => Math.trunc(Number(value)))
          .filter((value) => Number.isFinite(value) && value > 0)
      )]
    )
    .filter((group) => group.length > 0);

  if (normalizedGroups.length <= 1 || minimumWaypointsPerRoute <= 1) {
    return normalizedGroups;
  }

  let guard = 0;
  while (guard < 1000) {
    guard += 1;

    const smallGroupIndex = normalizedGroups.findIndex(
      (group) => group.length > 0 && group.length < minimumWaypointsPerRoute
    );
    if (smallGroupIndex < 0 || normalizedGroups.length <= 1) {
      break;
    }

    let targetGroupIndex = -1;
    let maxSize = -1;
    for (let index = 0; index < normalizedGroups.length; index += 1) {
      if (index === smallGroupIndex) {
        continue;
      }
      const size = normalizedGroups[index].length;
      if (size > maxSize) {
        maxSize = size;
        targetGroupIndex = index;
      }
    }

    if (targetGroupIndex < 0) {
      targetGroupIndex = smallGroupIndex === 0 ? 1 : 0;
    }

    normalizedGroups[targetGroupIndex] = [
      ...normalizedGroups[targetGroupIndex],
      ...normalizedGroups[smallGroupIndex]
    ];
    normalizedGroups.splice(smallGroupIndex, 1);
  }

  return normalizedGroups;
}

export async function confirmImportedRoutesGrouping(params: {
  importRouteIds: number[];
  groupedWaypointIds: number[][];
}) {
  const importRouteIds = [...new Set(
    params.importRouteIds
      .map((value) => Math.trunc(Number(value)))
      .filter((value) => Number.isFinite(value) && value > 0)
  )].sort((a, b) => a - b);

  if (importRouteIds.length === 0) {
    return [] as number[];
  }

  const groups = params.groupedWaypointIds
    .map((group) =>
      [...new Set(
        group
          .map((value) => Math.trunc(Number(value)))
          .filter((value) => Number.isFinite(value) && value > 0)
      )]
    )
    .filter((group) => group.length > 0);

  if (groups.length === 0) {
    throw new Error('Nenhum agrupamento válido para confirmar.');
  }

  const sourceWaypoints = (
    await Promise.all(importRouteIds.map((routeId) => listLocalWaypoints(routeId)))
  ).flat();
  const sourceWaypointById = new Map<number, Waypoint>(sourceWaypoints.map((waypoint) => [waypoint.id, waypoint]));
  if (sourceWaypointById.size === 0) {
    throw new Error('Nenhum waypoint encontrado para as rotas importadas.');
  }

  const assignedWaypointIds = new Set<number>();
  let normalizedGroups = groups.map((group) =>
    group.filter((waypointId) => {
      if (!sourceWaypointById.has(waypointId) || assignedWaypointIds.has(waypointId)) {
        return false;
      }
      assignedWaypointIds.add(waypointId);
      return true;
    })
  ).filter((group) => group.length > 0);

  const missingWaypointIds = [...sourceWaypointById.keys()].filter((waypointId) => !assignedWaypointIds.has(waypointId));
  if (missingWaypointIds.length > 0) {
    if (normalizedGroups.length === 0) {
      normalizedGroups.push(missingWaypointIds);
    } else {
      normalizedGroups[0] = [...normalizedGroups[0], ...missingWaypointIds];
    }
  }

  normalizedGroups = enforceMinimumWaypointsPerRouteGroup(normalizedGroups, 2);

  const currentRoutes = await listLocalRoutes();
  const currentRouteById = new Map(currentRoutes.map((entry) => [entry.id, entry]));
  const templateRoute = currentRouteById.get(importRouteIds[0]) ?? null;

  const maxRouteId = currentRoutes.reduce((max, entry) => Math.max(max, Math.trunc(Number(entry.id))), 0);
  let nextRouteId = maxRouteId + 1;
  const finalRouteIds = normalizedGroups.map((_, index) => importRouteIds[index] ?? nextRouteId++);
  const finalRouteIdSet = new Set(finalRouteIds);
  const now = new Date().toISOString();

  const db = await getLocalDb();
  await db.withTransactionAsync(async () => {
    for (let index = 0; index < finalRouteIds.length; index += 1) {
      const routeId = finalRouteIds[index];
      const group = normalizedGroups[index];
      const routeMeta = currentRouteById.get(routeId) ?? templateRoute;
      const routeStatus = routeMeta?.status ?? 'CRIADA';
      const createdAt = routeMeta?.created_at ?? now;

      await db.runAsync(
        `INSERT INTO routes (id, cluster_id, status, created_at, waypoints_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cluster_id = excluded.cluster_id,
           status = excluded.status,
           created_at = excluded.created_at,
           waypoints_count = excluded.waypoints_count,
           updated_at = excluded.updated_at`,
        routeId,
        index + 1,
        routeStatus,
        createdAt,
        group.length,
        now
      );

      for (let groupIndex = 0; groupIndex < group.length; groupIndex += 1) {
        const waypointId = group[groupIndex];
        await db.runAsync(
          `UPDATE waypoints
           SET route_id = ?, seq_order = ?, updated_at = ?
           WHERE id = ?`,
          routeId,
          groupIndex + 1,
          now,
          waypointId
        );
      }

      await db.runAsync(
        `UPDATE routes
         SET waypoints_count = (SELECT COUNT(1) FROM waypoints WHERE route_id = ?),
             updated_at = ?
         WHERE id = ?`,
        routeId,
        now,
        routeId
      );
    }

    for (const routeId of importRouteIds) {
      if (finalRouteIdSet.has(routeId)) {
        continue;
      }
      await db.runAsync(
        `DELETE FROM waypoint_photos
         WHERE waypoint_id IN (SELECT id FROM waypoints WHERE route_id = ?)`,
        routeId
      );
      await db.runAsync('DELETE FROM waypoints WHERE route_id = ?', routeId);
      await db.runAsync('DELETE FROM routes WHERE id = ?', routeId);
    }
  });

  await updatePendingImportRouteIds(importRouteIds, finalRouteIds);
  await setStoredLastImportedRouteIds(finalRouteIds);
  return finalRouteIds;
}

export async function getWaypointDeliveryPhoto(
  waypointId: number,
  currentStatus?: string | WaypointStatus
) {
  const localPhotoUri = await getLocalWaypointPhotoUri(waypointId);
  if (localPhotoUri) {
    return localPhotoUri;
  }

  if (!isWaypointDeliveredStatus(currentStatus)) {
    return null;
  }
  return null;
}

export async function getLastImportedRouteIds() {
  return getStoredLastImportedRouteIds();
}

export async function deleteRoute(routeId: number, cancelReason?: string): Promise<DeleteRouteResult> {
  const normalizedCancelReason = cancelReason?.trim() || undefined;
  await deleteLocalRoute(routeId);
  await removeLastImportedRouteId(routeId);
  await enqueueSyncOperation('DELETE_ROUTE', {
    routeId,
    cancel_reason: normalizedCancelReason,
    justificativa_cancel: normalizedCancelReason
  });
  return { queuedForSync: true };
}
