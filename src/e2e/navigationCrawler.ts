import { RouteStatus, Waypoint } from '../api/types';
import { getRouteDetails, listRouteWaypoints, listRoutes } from '../api/routesApi';
import { navigationRef } from '../navigation/navigationRef';
import { RootStackParamList } from '../navigation/types';
import { setAppSetting } from '../offline/localDb';

const runtimeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
const CRAWLER_STATUS_KEY = 'e2e_ios_crawler_status';
const CRAWLER_LOG_PREFIX = '[E2E_IOS_CRAWLER]';

function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? 'erro desconhecido');
}

function buildFallbackWaypoint(routeId: number): Waypoint {
  return {
    id: 900001,
    route_id: routeId,
    address_id: 900001,
    seq_order: 1,
    status: 'PENDENTE',
    title: 'Entrega E2E fallback',
    subtitle: 'Waypoint de fallback para crawler',
    latitude: 40.211,
    longitude: -8.429
  };
}

type CrawlContext = {
  routeId: number;
  routeIds: number[];
  routeStatus: RouteStatus;
  waypoints: Waypoint[];
  deliveryWaypoint: Waypoint;
};

async function resolveCrawlContext(): Promise<CrawlContext> {
  let routeId = 1001;
  let routeIds = [1001];
  let routeStatus: RouteStatus = 'PENDENTE';
  let waypoints: Waypoint[] = [];

  const routes = await listRoutes({ forceRefresh: true });
  if (routes.length > 0) {
    routeId = routes[0].id;
    routeIds = routes.slice(0, 5).map((item) => item.id);
    routeStatus = routes[0].status;
  }

  try {
    waypoints = await listRouteWaypoints(routeId, { forceRefresh: true });
  } catch {
    waypoints = [];
  }

  if (waypoints.length === 0) {
    try {
      const detail = await getRouteDetails(routeId, { forceRefresh: true });
      waypoints = detail.waypoints ?? [];
      routeStatus = detail.status;
    } catch {
      waypoints = [];
    }
  }

  const deliveryWaypoint = waypoints[0] ?? buildFallbackWaypoint(routeId);
  const mapWaypoints = waypoints.length > 0 ? waypoints : [deliveryWaypoint];

  return {
    routeId,
    routeIds: routeIds.length > 0 ? routeIds : [routeId],
    routeStatus,
    waypoints: mapWaypoints,
    deliveryWaypoint
  };
}

async function setCrawlerStatus(value: string) {
  await setAppSetting(CRAWLER_STATUS_KEY, value);
}

async function waitForNavigationReady(maxAttempts = 30) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (navigationRef.isReady()) {
      return;
    }
    await sleep(200);
  }

  throw new Error('NavigationContainer não ficou pronto para o crawler.');
}

async function navigateStep<TName extends keyof RootStackParamList>(
  screenName: TName,
  params: RootStackParamList[TName],
  waitMs = 750
) {
  if (!navigationRef.isReady()) {
    throw new Error(`Navigation indisponível ao navegar para ${String(screenName)}.`);
  }

  const navigateUnsafe = navigationRef.navigate as unknown as (
    screen: keyof RootStackParamList,
    routeParams?: RootStackParamList[keyof RootStackParamList]
  ) => void;
  navigateUnsafe(screenName, params);
  await sleep(waitMs);
}

export function isE2ENavigationCrawlerEnabled() {
  return parseBooleanEnv(
    process.env.EXPO_PUBLIC_E2E_NAV_CRAWLER ?? runtimeProcess?.env?.EXPO_PUBLIC_E2E_NAV_CRAWLER,
    false
  );
}

export async function runE2ENavigationCrawler() {
  if (!isE2ENavigationCrawlerEnabled()) {
    return;
  }

  await setCrawlerStatus('running');
  console.log(`${CRAWLER_LOG_PREFIX} START`);

  try {
    await waitForNavigationReady();
    const context = await resolveCrawlContext();

    await navigateStep('Routes', undefined, 850);
    await navigateStep('Settings', undefined, 700);
    await navigateStep('ImportRoute', undefined, 700);
    await navigateStep('FileBrowser', undefined, 700);
    await navigateStep('ImportRoutes', { routeIds: context.routeIds }, 850);
    await navigateStep('RouteDetail', { routeId: context.routeId }, 900);
    await navigateStep(
      'Map',
      {
        routeId: context.routeId,
        waypoints: context.waypoints,
        routeIds: context.routeIds,
        routeStatus: context.routeStatus,
        forceEnableReorderActions: true
      },
      1000
    );
    await navigateStep(
      'Delivery',
      {
        routeId: context.routeId,
        waypoint: context.deliveryWaypoint
      },
      1000
    );
    await navigateStep('Routes', undefined, 600);

    await setCrawlerStatus('success');
    console.log(`${CRAWLER_LOG_PREFIX} SUCCESS`);
  } catch (error) {
    const message = toErrorMessage(error);
    await setCrawlerStatus(`failed:${message}`.slice(0, 500));
    console.log(`${CRAWLER_LOG_PREFIX} FAILED: ${message}`);
    throw error;
  }
}
