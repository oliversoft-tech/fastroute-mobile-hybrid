const runtimeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process;

export const GOOGLE_MAPS_API_KEY =
  runtimeProcess?.env?.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? 'AIzaSyDXekeN6DJFGze2kPzG4AMEPPNz9XH24mc';
