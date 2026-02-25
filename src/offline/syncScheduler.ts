import { AppState, AppStateStatus } from 'react-native';
import { maybeRunScheduledSync } from './syncEngine';

const SCHEDULER_INTERVAL_MS = 60_000;

let schedulerStarted = false;
let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let appStateSubscription: { remove: () => void } | null = null;
let checkInFlight = false;

async function runCheck() {
  if (checkInFlight) {
    return;
  }
  checkInFlight = true;
  try {
    await maybeRunScheduledSync();
  } finally {
    checkInFlight = false;
  }
}

function handleAppStateChange(nextState: AppStateStatus) {
  if (nextState === 'active') {
    void runCheck();
  }
}

export function startOfflineSyncScheduler() {
  if (schedulerStarted) {
    return;
  }
  schedulerStarted = true;

  void runCheck();
  schedulerInterval = setInterval(() => {
    void runCheck();
  }, SCHEDULER_INTERVAL_MS);

  appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
}

export function stopOfflineSyncScheduler() {
  schedulerStarted = false;
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  appStateSubscription?.remove();
  appStateSubscription = null;
}

