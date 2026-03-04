import { RouteStatus, Waypoint } from '../api/types';

export type RootStackParamList = {
  Login: undefined;
  Routes: undefined;
  ImportRoutes: { routeIds: number[] };
  Settings: undefined;
  ImportRoute: undefined;
  FileBrowser: undefined;
  RouteDetail: { routeId: number; refreshAt?: number };
  Delivery: { routeId: number; waypoint: Waypoint };
  Map: {
    routeId: number;
    waypoints: Waypoint[];
    routeIds?: number[];
    importEpsMeters?: number;
    routeStatus?: RouteStatus;
    forceEnableReorderActions?: boolean;
  };
};
