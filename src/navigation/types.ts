import { RouteStatus, Waypoint } from '../api/types';

export type RootStackParamList = {
  Login: undefined;
  Routes: undefined;
  Settings: undefined;
  ImportRoute: undefined;
  FileBrowser: undefined;
  RouteDetail: { routeId: number; refreshAt?: number };
  Delivery: { routeId: number; waypoint: Waypoint };
  Map: {
    routeId: number;
    waypoints: Waypoint[];
    routeStatus?: RouteStatus;
    forceEnableReorderActions?: boolean;
  };
};
