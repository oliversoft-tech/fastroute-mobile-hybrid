import { RouteDetail } from '../api/types';
import {
  getAppSetting,
  listLocalRoutes,
  saveRouteSnapshot,
  setAppSetting
} from '../offline/localDb';

const runtimeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process;

function parseBooleanEnv(value: string | undefined, defaultValue: boolean) {
  if (value == null) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

const E2E_BYPASS_LOGIN = parseBooleanEnv(runtimeProcess?.env?.EXPO_PUBLIC_E2E_BYPASS_LOGIN, false);
const E2E_SEED_DATA = parseBooleanEnv(runtimeProcess?.env?.EXPO_PUBLIC_E2E_SEED_DATA, E2E_BYPASS_LOGIN);
const E2E_SEED_KEY = 'e2e_seed_v1';

let ensureSeedPromise: Promise<void> | null = null;

function buildSeedRoutes(): RouteDetail[] {
  const now = new Date().toISOString();

  return [
    {
      id: 9001,
      cluster_id: 1,
      status: 'CRIADA',
      created_at: now,
      waypoints_count: 3,
      waypoints: [
        {
          id: 9101,
          route_id: 9001,
          address_id: 101,
          user_id: 1,
          seq_order: 1,
          status: 'PENDENTE',
          title: 'Entrega E2E A1',
          subtitle: 'Centro - Coimbra',
          latitude: 40.2112,
          longitude: -8.4291
        },
        {
          id: 9102,
          route_id: 9001,
          address_id: 102,
          user_id: 1,
          seq_order: 2,
          status: 'PENDENTE',
          title: 'Entrega E2E A2',
          subtitle: 'Norton de Matos - Coimbra',
          latitude: 40.2142,
          longitude: -8.4312
        },
        {
          id: 9103,
          route_id: 9001,
          address_id: 103,
          user_id: 1,
          seq_order: 3,
          status: 'PENDENTE',
          title: 'Entrega E2E A3',
          subtitle: 'Baixa - Coimbra',
          latitude: 40.2088,
          longitude: -8.4248
        }
      ]
    },
    {
      id: 9002,
      cluster_id: 1,
      status: 'EM_ANDAMENTO',
      created_at: now,
      waypoints_count: 3,
      waypoints: [
        {
          id: 9201,
          route_id: 9002,
          address_id: 201,
          user_id: 1,
          seq_order: 1,
          status: 'PENDENTE',
          title: 'Entrega E2E B1',
          subtitle: 'Santa Clara - Coimbra',
          latitude: 40.1998,
          longitude: -8.4301
        },
        {
          id: 9202,
          route_id: 9002,
          address_id: 202,
          user_id: 1,
          seq_order: 2,
          status: 'PENDENTE',
          title: 'Entrega E2E B2',
          subtitle: 'Solum - Coimbra',
          latitude: 40.2204,
          longitude: -8.4121
        },
        {
          id: 9203,
          route_id: 9002,
          address_id: 203,
          user_id: 1,
          seq_order: 3,
          status: 'PENDENTE',
          title: 'Entrega E2E B3',
          subtitle: 'Celas - Coimbra',
          latitude: 40.2159,
          longitude: -8.4195
        }
      ]
    }
  ];
}

export async function ensureE2ESeedData() {
  if (!E2E_SEED_DATA) {
    return;
  }

  if (ensureSeedPromise) {
    return ensureSeedPromise;
  }

  ensureSeedPromise = (async () => {
    const alreadySeeded = await getAppSetting(E2E_SEED_KEY);
    if (alreadySeeded === '1') {
      return;
    }

    const currentRoutes = await listLocalRoutes();
    if (currentRoutes.length === 0) {
      await saveRouteSnapshot(buildSeedRoutes());
    }

    await setAppSetting(E2E_SEED_KEY, '1');
  })();

  return ensureSeedPromise;
}

export async function forceE2ESeedData() {
  await saveRouteSnapshot(buildSeedRoutes());
  await setAppSetting(E2E_SEED_KEY, '1');
}
