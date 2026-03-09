import { openDatabaseAsync, SQLiteDatabase } from 'expo-sqlite';
import { RouteDetail, RouteStatus, Waypoint, WaypointStatus } from '../api/types';

export type SyncOperationType =
  | 'IMPORT_ROUTE_FILE'
  | 'START_ROUTE'
  | 'FINISH_ROUTE'
  | 'UPDATE_WAYPOINT_STATUS'
  | 'REORDER_WAYPOINTS'
  | 'DELETE_ROUTE';

export interface SyncQueueItem {
  id: number;
  opType: SyncOperationType;
  payload: Record<string, unknown>;
  createdAt: string;
  lastError: string | null;
  retryCount: number;
}

const DATABASE_NAME = 'fastroute_offline.db';
const DEFAULT_SYNC_TIME = '19:00';
const SETTINGS_KEY_DAILY_SYNC_TIME = 'daily_sync_time';
const SETTINGS_KEY_LAST_SYNC_AT = 'last_sync_at';
const SETTINGS_KEY_LAST_DAILY_SYNC_DATE = 'last_daily_sync_date';
const SETTINGS_KEY_INITIAL_SYNC_DONE = 'initial_sync_done';
const SETTINGS_KEY_LAST_IMPORTED_ROUTE_IDS = 'last_imported_route_ids';

let dbPromise: Promise<SQLiteDatabase> | null = null;
let schemaReady = false;
let dbClient: LocalDbClient | null = null;

type LocalDbClient = Pick<
  SQLiteDatabase,
  'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync' | 'withTransactionAsync'
>;

type RouteRow = {
  id: number;
  cluster_id: number | null;
  status: string;
  created_at: string | null;
  waypoints_count: number | null;
};

type WaypointRow = {
  id: number;
  route_id: number;
  address_id: number | null;
  user_id: number | null;
  seq_order: number | null;
  status: string;
  title: string | null;
  subtitle: string | null;
  latitude: number | null;
  longitude: number | null;
};

type QueueRow = {
  id: number;
  op_type: string;
  payload: string;
  created_at: string;
  last_error: string | null;
  retry_count: number | null;
};

type WaypointPhotoRow = {
  local_uri: string;
};

function normalizeRouteStatus(status: unknown): RouteStatus {
  const normalized = String(status ?? '')
    .trim()
    .toUpperCase();

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

function normalizeWaypointStatus(status: unknown): WaypointStatus {
  const normalized = String(status ?? '')
    .trim()
    .toUpperCase();

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

function toPositiveInt(value: unknown, fallback = 0) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return n;
}

function parsePayload(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore invalid payload
  }
  return {};
}

async function ensureSchema(db: SQLiteDatabase) {
  if (schemaReady) {
    return;
  }

  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY NOT NULL,
      cluster_id INTEGER,
      status TEXT NOT NULL,
      created_at TEXT,
      waypoints_count INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS waypoints (
      id INTEGER PRIMARY KEY NOT NULL,
      route_id INTEGER NOT NULL,
      address_id INTEGER,
      user_id INTEGER,
      seq_order INTEGER DEFAULT 0,
      status TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      latitude REAL,
      longitude REAL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_waypoints_route_id ON waypoints(route_id);
    CREATE TABLE IF NOT EXISTS waypoint_photos (
      waypoint_id INTEGER PRIMARY KEY NOT NULL,
      local_uri TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_error TEXT,
      retry_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  schemaReady = true;
}

function isStaleNativeDatabaseError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? error ?? '');
  return (
    message.includes('cannot be cast to type SharedObject<NativeDatabase>') ||
    message.includes('SharedObject<NativeDatabase>') ||
    message.includes('Unable to find the native shared object associated with given JavaScript object')
  );
}

function resetDatabaseHandle() {
  dbPromise = null;
  schemaReady = false;
}

async function openAndPrepareDatabase() {
  const db = await openDatabaseAsync(DATABASE_NAME);
  await ensureSchema(db);
  return db;
}

async function getPreparedDatabase() {
  if (!dbPromise) {
    dbPromise = openAndPrepareDatabase();
  }

  try {
    const db = await dbPromise;
    // Healthcheck leve para evitar retorno de handle nativo stale.
    await db.getFirstAsync<{ ok: number }>('SELECT 1 AS ok');
    return db;
  } catch (error) {
    if (!isStaleNativeDatabaseError(error)) {
      throw error;
    }

    resetDatabaseHandle();
    dbPromise = openAndPrepareDatabase();
    const db = await dbPromise;
    await db.getFirstAsync<{ ok: number }>('SELECT 1 AS ok');
    return db;
  }
}

async function withDatabaseRetry<T>(operation: (db: SQLiteDatabase) => Promise<T>) {
  const db = await getPreparedDatabase();
  try {
    return await operation(db);
  } catch (error) {
    if (!isStaleNativeDatabaseError(error)) {
      throw error;
    }

    resetDatabaseHandle();
    const freshDb = await getPreparedDatabase();
    return operation(freshDb);
  }
}

function callDatabaseMethod<T>(
  db: SQLiteDatabase,
  method: 'runAsync' | 'getAllAsync' | 'getFirstAsync',
  source: string,
  params: unknown[]
) {
  return Reflect.apply(
    (db as unknown as Record<string, (...args: unknown[]) => unknown>)[method],
    db,
    [source, ...params]
  ) as T;
}

function buildDatabaseClient(): LocalDbClient {
  if (dbClient) {
    return dbClient;
  }

  dbClient = {
    execAsync(source) {
      return withDatabaseRetry((db) => db.execAsync(source));
    },
    runAsync(source, ...params) {
      return withDatabaseRetry((db) =>
        callDatabaseMethod<ReturnType<SQLiteDatabase['runAsync']>>(db, 'runAsync', source, params)
      );
    },
    getAllAsync(source, ...params) {
      return withDatabaseRetry((db) =>
        callDatabaseMethod<ReturnType<SQLiteDatabase['getAllAsync']>>(db, 'getAllAsync', source, params)
      );
    },
    getFirstAsync(source, ...params) {
      return withDatabaseRetry((db) =>
        callDatabaseMethod<ReturnType<SQLiteDatabase['getFirstAsync']>>(db, 'getFirstAsync', source, params)
      );
    },
    withTransactionAsync(task) {
      return withDatabaseRetry((db) => db.withTransactionAsync(task));
    }
  };

  return dbClient;
}

export async function getLocalDb() {
  return buildDatabaseClient();
}

export async function initializeLocalDb() {
  await getLocalDb();
}

export async function saveRouteSnapshot(routes: RouteDetail[]) {
  const db = await getLocalDb();
  const timestamp = new Date().toISOString();

  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM waypoints');
    await db.runAsync('DELETE FROM routes');

    for (const route of routes) {
      await db.runAsync(
        `INSERT INTO routes (id, cluster_id, status, created_at, waypoints_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        route.id,
        route.cluster_id ?? 0,
        route.status,
        route.created_at ?? timestamp,
        route.waypoints_count ?? route.waypoints?.length ?? 0,
        timestamp
      );

      for (const waypoint of route.waypoints ?? []) {
        await db.runAsync(
          `INSERT INTO waypoints (
            id, route_id, address_id, user_id, seq_order, status, title, subtitle, latitude, longitude, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          waypoint.id,
          waypoint.route_id || route.id,
          waypoint.address_id ?? null,
          waypoint.user_id ?? null,
          waypoint.seq_order ?? 0,
          waypoint.status,
          waypoint.title ?? null,
          waypoint.subtitle ?? null,
          waypoint.latitude ?? null,
          waypoint.longitude ?? null,
          timestamp
        );
      }
    }

    await db.runAsync('DELETE FROM waypoint_photos WHERE waypoint_id NOT IN (SELECT id FROM waypoints)');
  });
}

export async function mergeRouteSnapshot(routes: RouteDetail[]) {
  const db = await getLocalDb();
  const timestamp = new Date().toISOString();

  await db.withTransactionAsync(async () => {
    for (const route of routes) {
      const routeWaypoints = route.waypoints ?? [];
      const reportedCount = route.waypoints_count ?? routeWaypoints.length;

      await db.runAsync(
        `INSERT INTO routes (id, cluster_id, status, created_at, waypoints_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cluster_id = excluded.cluster_id,
           status = excluded.status,
           created_at = excluded.created_at,
           waypoints_count = CASE
             WHEN COALESCE(routes.waypoints_count, 0) > excluded.waypoints_count THEN routes.waypoints_count
             ELSE excluded.waypoints_count
           END,
           updated_at = excluded.updated_at`,
        route.id,
        route.cluster_id ?? 0,
        route.status,
        route.created_at ?? timestamp,
        reportedCount,
        timestamp
      );

      for (const waypoint of routeWaypoints) {
        await db.runAsync(
          `INSERT INTO waypoints (
            id, route_id, address_id, user_id, seq_order, status, title, subtitle, latitude, longitude, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            route_id = excluded.route_id,
            address_id = CASE
              WHEN excluded.address_id IS NULL OR excluded.address_id <= 0 THEN waypoints.address_id
              ELSE excluded.address_id
            END,
            user_id = COALESCE(excluded.user_id, waypoints.user_id),
            seq_order = CASE
              WHEN excluded.seq_order IS NULL OR excluded.seq_order <= 0 THEN waypoints.seq_order
              ELSE excluded.seq_order
            END,
            status = excluded.status,
            title = COALESCE(NULLIF(TRIM(excluded.title), ''), waypoints.title),
            subtitle = COALESCE(NULLIF(TRIM(excluded.subtitle), ''), waypoints.subtitle),
            latitude = COALESCE(excluded.latitude, waypoints.latitude),
            longitude = COALESCE(excluded.longitude, waypoints.longitude),
            updated_at = excluded.updated_at`,
          waypoint.id,
          waypoint.route_id || route.id,
          waypoint.address_id ?? null,
          waypoint.user_id ?? null,
          waypoint.seq_order ?? 0,
          waypoint.status,
          waypoint.title ?? null,
          waypoint.subtitle ?? null,
          waypoint.latitude ?? null,
          waypoint.longitude ?? null,
          timestamp
        );
      }
    }
  });
}

export async function listLocalRoutes(): Promise<RouteDetail[]> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync<RouteRow>(
    `SELECT
       id,
       cluster_id,
       status,
       created_at,
       (SELECT COUNT(1) FROM waypoints w WHERE w.route_id = routes.id) AS waypoints_count
     FROM routes
     ORDER BY datetime(created_at) DESC, id DESC`
  );

  return rows.map((row) => ({
    id: row.id,
    cluster_id: row.cluster_id ?? 0,
    status: normalizeRouteStatus(row.status),
    created_at: row.created_at ?? new Date().toISOString(),
    waypoints_count: toPositiveInt(row.waypoints_count, 0),
    waypoints: []
  }));
}

export async function getLocalRoute(routeId: number): Promise<RouteDetail | null> {
  const db = await getLocalDb();
  const row = await db.getFirstAsync<RouteRow>(
    `SELECT
       id,
       cluster_id,
       status,
       created_at,
       (SELECT COUNT(1) FROM waypoints w WHERE w.route_id = routes.id) AS waypoints_count
     FROM routes
     WHERE id = ?`,
    routeId
  );

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    cluster_id: row.cluster_id ?? 0,
    status: normalizeRouteStatus(row.status),
    created_at: row.created_at ?? new Date().toISOString(),
    waypoints_count: toPositiveInt(row.waypoints_count, 0),
    waypoints: []
  };
}

export async function listLocalWaypoints(routeId: number): Promise<Waypoint[]> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync<WaypointRow>(
    `SELECT
      id, route_id, address_id, user_id, seq_order, status, title, subtitle, latitude, longitude
     FROM waypoints
     WHERE route_id = ?
     ORDER BY seq_order ASC, id ASC`,
    routeId
  );

  return rows.map((row, index) => ({
    id: row.id,
    route_id: row.route_id,
    address_id: toPositiveInt(row.address_id, row.id),
    user_id: row.user_id ?? undefined,
    seq_order: toPositiveInt(row.seq_order, index + 1),
    status: normalizeWaypointStatus(row.status),
    title: row.title ?? undefined,
    subtitle: row.subtitle ?? undefined,
    latitude: typeof row.latitude === 'number' ? row.latitude : undefined,
    longitude: typeof row.longitude === 'number' ? row.longitude : undefined
  }));
}

export async function backfillLocalWaypointTitlesByAddress(routeId: number) {
  const db = await getLocalDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE waypoints
     SET title = COALESCE(
           NULLIF(TRIM(title), ''),
           (
             SELECT source.title
             FROM waypoints AS source
             WHERE source.address_id = waypoints.address_id
               AND source.id <> waypoints.id
               AND source.title IS NOT NULL
               AND TRIM(source.title) <> ''
             ORDER BY datetime(source.updated_at) DESC, source.id DESC
             LIMIT 1
           )
         ),
         subtitle = COALESCE(
           NULLIF(TRIM(subtitle), ''),
           (
             SELECT source.subtitle
             FROM waypoints AS source
             WHERE source.address_id = waypoints.address_id
               AND source.id <> waypoints.id
               AND source.subtitle IS NOT NULL
               AND TRIM(source.subtitle) <> ''
             ORDER BY datetime(source.updated_at) DESC, source.id DESC
             LIMIT 1
           )
         ),
         updated_at = ?
     WHERE route_id = ?
       AND (title IS NULL OR TRIM(title) = '')`,
    now,
    routeId
  );
}

export async function getLocalWaypoint(waypointId: number): Promise<Waypoint | null> {
  const db = await getLocalDb();
  const row = await db.getFirstAsync<WaypointRow>(
    `SELECT
      id, route_id, address_id, user_id, seq_order, status, title, subtitle, latitude, longitude
     FROM waypoints
     WHERE id = ?`,
    waypointId
  );

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    route_id: row.route_id,
    address_id: toPositiveInt(row.address_id, row.id),
    user_id: row.user_id ?? undefined,
    seq_order: toPositiveInt(row.seq_order, 1),
    status: normalizeWaypointStatus(row.status),
    title: row.title ?? undefined,
    subtitle: row.subtitle ?? undefined,
    latitude: typeof row.latitude === 'number' ? row.latitude : undefined,
    longitude: typeof row.longitude === 'number' ? row.longitude : undefined
  };
}

export async function upsertLocalRoute(route: RouteDetail) {
  const db = await getLocalDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO routes (id, cluster_id, status, created_at, waypoints_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       cluster_id = excluded.cluster_id,
       status = excluded.status,
       created_at = excluded.created_at,
       waypoints_count = excluded.waypoints_count,
       updated_at = excluded.updated_at`,
    route.id,
    route.cluster_id ?? 0,
    route.status,
    route.created_at ?? now,
    route.waypoints_count ?? route.waypoints?.length ?? 0,
    now
  );
}

export async function updateLocalRouteStatus(routeId: number, status: RouteStatus) {
  const db = await getLocalDb();
  await db.runAsync('UPDATE routes SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), routeId);
}

export async function replaceLocalRouteWaypoints(routeId: number, waypoints: Waypoint[]) {
  const db = await getLocalDb();
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM waypoints WHERE route_id = ?', routeId);

    for (const waypoint of waypoints) {
      await db.runAsync(
        `INSERT INTO waypoints (
          id, route_id, address_id, user_id, seq_order, status, title, subtitle, latitude, longitude, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        waypoint.id,
        routeId,
        waypoint.address_id ?? waypoint.id,
        waypoint.user_id ?? null,
        waypoint.seq_order ?? 0,
        waypoint.status,
        waypoint.title ?? null,
        waypoint.subtitle ?? null,
        waypoint.latitude ?? null,
        waypoint.longitude ?? null,
        now
      );
    }

    await db.runAsync(
      'UPDATE routes SET waypoints_count = ?, updated_at = ? WHERE id = ?',
      waypoints.length,
      now,
      routeId
    );
    await db.runAsync(
      `DELETE FROM waypoint_photos
       WHERE waypoint_id NOT IN (SELECT id FROM waypoints)`
    );
  });
}

export async function updateLocalWaypointStatus(waypointId: number, status: WaypointStatus) {
  const db = await getLocalDb();
  await db.runAsync(
    `UPDATE waypoints
     SET status = ?, updated_at = ?
     WHERE id = ?`,
    status,
    new Date().toISOString(),
    waypointId
  );
}

export async function applyLocalWaypointReorder(
  routeId: number,
  reorderedWaypoints: Array<{ seqorder: number; waypoint_id: number }>
) {
  const db = await getLocalDb();
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    for (const entry of reorderedWaypoints) {
      await db.runAsync(
        `UPDATE waypoints
         SET seq_order = ?, status = ?, updated_at = ?
         WHERE id = ? AND route_id = ?`,
        entry.seqorder,
        'REORDENADO',
        now,
        entry.waypoint_id,
        routeId
      );
    }
  });
}

export async function getLocalWaypointPhotoUri(waypointId: number): Promise<string | null> {
  const db = await getLocalDb();
  const row = await db.getFirstAsync<WaypointPhotoRow>(
    'SELECT local_uri FROM waypoint_photos WHERE waypoint_id = ?',
    waypointId
  );
  return row?.local_uri ?? null;
}

export async function upsertLocalWaypointPhotoUri(waypointId: number, localUri: string) {
  const db = await getLocalDb();
  await db.runAsync(
    `INSERT INTO waypoint_photos (waypoint_id, local_uri, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(waypoint_id) DO UPDATE SET
       local_uri = excluded.local_uri,
       updated_at = excluded.updated_at`,
    waypointId,
    localUri,
    new Date().toISOString()
  );
}

export async function deleteLocalRoute(routeId: number) {
  const db = await getLocalDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `DELETE FROM waypoint_photos
       WHERE waypoint_id IN (SELECT id FROM waypoints WHERE route_id = ?)`,
      routeId
    );
    await db.runAsync('DELETE FROM waypoints WHERE route_id = ?', routeId);
    await db.runAsync('DELETE FROM routes WHERE id = ?', routeId);
  });
}

export async function enqueueSyncOperation(
  opType: SyncOperationType,
  payload: Record<string, unknown>
) {
  const db = await getLocalDb();
  await db.runAsync(
    `INSERT INTO sync_queue (op_type, payload, created_at, last_error, retry_count)
     VALUES (?, ?, ?, NULL, 0)`,
    opType,
    JSON.stringify(payload),
    new Date().toISOString()
  );
}

function normalizeRouteIds(values: unknown[]) {
  return [...new Set(
    values
      .map((value) => Math.trunc(Number(value)))
      .filter((value) => Number.isFinite(value) && value > 0)
  )].sort((a, b) => a - b);
}

export async function updatePendingImportRouteIds(previousRouteIds: number[], nextRouteIds: number[]) {
  const db = await getLocalDb();
  const previous = new Set(normalizeRouteIds(previousRouteIds));
  const next = normalizeRouteIds(nextRouteIds);
  if (previous.size === 0 || next.length === 0) {
    return false;
  }

  const rows = await db.getAllAsync<{ id: number; payload: string }>(
    `SELECT id, payload
     FROM sync_queue
     WHERE op_type = 'IMPORT_ROUTE_FILE'
     ORDER BY id DESC`
  );

  for (const row of rows) {
    const payload = parsePayload(row.payload);
    const payloadRouteIds = normalizeRouteIds(Array.isArray(payload.route_ids) ? payload.route_ids : []);
    const intersects = payloadRouteIds.some((routeId) => previous.has(routeId));
    if (!intersects) {
      continue;
    }

    const nextPayload: Record<string, unknown> = {
      ...payload,
      route_ids: next,
      routes_generated: next.length
    };

    if (next.length === 1) {
      nextPayload.route_id = next[0];
    } else {
      delete nextPayload.route_id;
    }

    await db.runAsync(
      `UPDATE sync_queue
       SET payload = ?, last_error = NULL
       WHERE id = ?`,
      JSON.stringify(nextPayload),
      row.id
    );
    return true;
  }

  return false;
}

export async function listPendingSyncOperations(limit = 100): Promise<SyncQueueItem[]> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync<QueueRow>(
    `SELECT id, op_type, payload, created_at, last_error, retry_count
     FROM sync_queue
     ORDER BY id ASC
     LIMIT ?`,
    limit
  );

  return rows.map((row) => ({
    id: row.id,
    opType: row.op_type as SyncOperationType,
    payload: parsePayload(row.payload),
    createdAt: row.created_at,
    lastError: row.last_error,
    retryCount: toPositiveInt(row.retry_count, 0)
  }));
}

export async function markSyncOperationDone(queueId: number) {
  const db = await getLocalDb();
  await db.runAsync('DELETE FROM sync_queue WHERE id = ?', queueId);
}

export async function markSyncOperationFailed(queueId: number, errorMessage: string) {
  const db = await getLocalDb();
  await db.runAsync(
    `UPDATE sync_queue
     SET last_error = ?, retry_count = COALESCE(retry_count, 0) + 1
     WHERE id = ?`,
    errorMessage.slice(0, 800),
    queueId
  );
}

export async function countPendingSyncOperations() {
  const db = await getLocalDb();
  const row = await db.getFirstAsync<{ total: number }>('SELECT COUNT(1) AS total FROM sync_queue');
  return toPositiveInt(row?.total, 0);
}

export async function getAppSetting(key: string): Promise<string | null> {
  const db = await getLocalDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?',
    key
  );
  return row?.value ?? null;
}

export async function setAppSetting(key: string, value: string) {
  const db = await getLocalDb();
  await db.runAsync(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
    key,
    value,
    new Date().toISOString()
  );
}

export async function getDailySyncTime() {
  const value = await getAppSetting(SETTINGS_KEY_DAILY_SYNC_TIME);
  if (!value || !/^\d{2}:\d{2}$/.test(value)) {
    return DEFAULT_SYNC_TIME;
  }
  return value;
}

export async function setDailySyncTime(value: string) {
  await setAppSetting(SETTINGS_KEY_DAILY_SYNC_TIME, value);
}

export async function getLastSyncAt() {
  return getAppSetting(SETTINGS_KEY_LAST_SYNC_AT);
}

export async function setLastSyncAt(value: string) {
  await setAppSetting(SETTINGS_KEY_LAST_SYNC_AT, value);
}

export async function getLastDailySyncDate() {
  return getAppSetting(SETTINGS_KEY_LAST_DAILY_SYNC_DATE);
}

export async function setLastDailySyncDate(value: string) {
  await setAppSetting(SETTINGS_KEY_LAST_DAILY_SYNC_DATE, value);
}

export async function isInitialSyncDone() {
  return (await getAppSetting(SETTINGS_KEY_INITIAL_SYNC_DONE)) === '1';
}

export async function setInitialSyncDone(done: boolean) {
  await setAppSetting(SETTINGS_KEY_INITIAL_SYNC_DONE, done ? '1' : '0');
}

export async function getLastImportedRouteIds() {
  const rawValue = await getAppSetting(SETTINGS_KEY_LAST_IMPORTED_ROUTE_IDS);
  if (!rawValue) {
    return [] as number[];
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) {
      return [] as number[];
    }
    return normalizeRouteIds(parsed);
  } catch {
    return [] as number[];
  }
}

export async function setLastImportedRouteIds(routeIds: number[]) {
  const normalized = normalizeRouteIds(routeIds);
  await setAppSetting(SETTINGS_KEY_LAST_IMPORTED_ROUTE_IDS, JSON.stringify(normalized));
  return normalized;
}

export async function removeLastImportedRouteId(routeId: number) {
  const normalizedRouteId = Math.trunc(Number(routeId));
  if (!Number.isFinite(normalizedRouteId) || normalizedRouteId <= 0) {
    return;
  }

  const currentRouteIds = await getLastImportedRouteIds();
  if (currentRouteIds.length === 0) {
    return;
  }

  const nextRouteIds = currentRouteIds.filter((id) => id !== normalizedRouteId);
  if (nextRouteIds.length === currentRouteIds.length) {
    return;
  }

  await setLastImportedRouteIds(nextRouteIds);
}
