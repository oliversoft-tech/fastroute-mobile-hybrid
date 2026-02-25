import {
  canFinishRoute,
  isAllowedWaypointCurrentStatus,
  isAllowedWaypointTargetStatus,
  validateFinishWaypoint
} from '@oliverbill/fastroute-domain';
import * as FileSystem from 'expo-file-system';
import { RouteDetail, Waypoint, WaypointStatus } from './types';
import {
  applyLocalWaypointReorder,
  deleteLocalRoute,
  enqueueSyncOperation,
  getLocalRoute,
  getLocalWaypointPhotoUri,
  getLocalWaypoint,
  listLocalRoutes,
  listLocalWaypoints,
  replaceLocalRouteWaypoints,
  upsertLocalWaypointPhotoUri,
  updateLocalRouteStatus,
  updateLocalWaypointStatus,
  upsertLocalRoute
} from '../offline/localDb';
import {
  deleteRoute as deleteRouteRemote,
  getWaypointPhoto as getWaypointPhotoRemote
} from './routesRemoteApi';
import { API_BASE_URL } from '../config/api';
import { getAuthAccessToken } from './httpClient';

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
  throw new Error(`Rota #${routeId} não encontrada no banco local. Faça sync manual primeiro.`);
}

function isWaypointDeliveredStatus(status: string | WaypointStatus | undefined) {
  const normalized = String(status ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  return normalized.includes('ENTREGUE') || normalized.includes('CONCLUID');
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

function normalizePhotoUrl(rawUrl: string) {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const base = API_BASE_URL.endsWith('/') ? API_BASE_URL.slice(0, -1) : API_BASE_URL;
  const normalizedPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${base}${normalizedPath}`;
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

async function persistWaypointPhotoFromUrl(
  waypointId: number,
  fileName: string,
  rawUrl: string
) {
  const directory = ensureWaypointPhotoDirectory();
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const localUri = `${directory}/${normalizePhotoFileName(fileName, waypointId)}`;
  const normalizedUrl = normalizePhotoUrl(rawUrl);
  const token = getAuthAccessToken();
  await FileSystem.downloadAsync(normalizedUrl, localUri, {
    headers: token
      ? {
          Authorization: `Bearer ${token}`
        }
      : undefined
  });
  return localUri;
}

export async function listRoutes(_options?: QueryCacheOptions) {
  return listLocalRoutes();
}

export async function getRouteDetails(routeId: number, _options?: QueryCacheOptions) {
  const route = await getLocalRoute(routeId);
  if (!route) {
    throw new Error(`Rota #${routeId} não encontrada no banco local. Faça sync manual primeiro.`);
  }
  const waypoints = await listLocalWaypoints(routeId);
  return {
    ...route,
    waypoints_count: waypoints.length,
    waypoints
  };
}

export async function listRouteWaypoints(routeId: number, _options?: QueryCacheOptions) {
  return listLocalWaypoints(routeId);
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
    throw new Error(`Waypoint #${waypointId} não encontrado no banco local.`);
  }
  if (Number(localWaypoint.route_id) !== Number(routeId)) {
    throw new Error('Waypoint não pertence à rota selecionada.');
  }

  const currentStatus = mapWaypointStatusToDomain(localWaypoint.status);
  if (!isAllowedWaypointCurrentStatus(currentStatus)) {
    throw new Error(`Status atual inválido para finalizar waypoint: ${localWaypoint.status}`);
  }

  const targetStatus = mapTargetStatusToDomain(status);
  if (!isAllowedWaypointTargetStatus(targetStatus)) {
    throw new Error('Status de destino inválido para finalização do waypoint.');
  }

  const normalizedFileName = options?.file_name?.trim() || `entrega_${waypointId}.jpg`;
  const photo = {
    waypoint_id: waypointId,
    filename: normalizedFileName,
    user_id: String(options?.user_id ?? localWaypoint.user_id ?? 'offline-user'),
    object_path: normalizedFileName,
    file_size_bytes: 1,
    photo_url: options?.image_uri?.trim() || `offline://${normalizedFileName}`
  };

  const validation = validateFinishWaypoint({
    currentWaypoint: {
      id: localWaypoint.id,
      route_id: localWaypoint.route_id,
      status: currentStatus
    },
    targetStatus,
    obs_falha: options?.obs_falha ?? '',
    photo
  });

  if (!validation.ok) {
    throw new Error(validation.error);
  }

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

  const remotePhoto = await getWaypointPhotoRemote(waypointId);
  if (!remotePhoto) {
    return null;
  }

  let persistedUri: string;
  if (remotePhoto.kind === 'base64') {
    persistedUri = await persistWaypointPhotoBase64(
      waypointId,
      remotePhoto.fileName,
      remotePhoto.base64
    );
  } else {
    persistedUri = await persistWaypointPhotoFromUrl(
      waypointId,
      remotePhoto.fileName,
      remotePhoto.url
    );
  }

  await upsertLocalWaypointPhotoUri(waypointId, persistedUri);
  return persistedUri;
}

export async function deleteRoute(routeId: number): Promise<DeleteRouteResult> {
  await deleteLocalRoute(routeId);

  try {
    await deleteRouteRemote(routeId);
    return { queuedForSync: false };
  } catch {
    await enqueueSyncOperation('DELETE_ROUTE', { routeId });
    return { queuedForSync: true };
  }
}
