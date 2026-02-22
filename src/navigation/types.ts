import { Waypoint } from '../api/types';

export type RootStackParamList = {
  Login: undefined;
  Routes: undefined;
  ImportRoute: undefined;
  FileBrowser: undefined;
  RouteDetail: { routeId: number; refreshAt?: number };
  Delivery: { routeId: number; waypoint: Waypoint };
  Map: { routeId: number; waypoints: Waypoint[] };
};
