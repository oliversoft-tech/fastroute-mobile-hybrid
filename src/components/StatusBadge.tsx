import { StyleSheet, Text, View } from 'react-native';
import { getStatusColor, getRouteStatusLabel, getWaypointStatusLabel } from '../utils/status';
import { RouteStatus, WaypointStatus } from '../api/types';

interface StatusBadgeProps {
  status: RouteStatus | WaypointStatus;
  type: 'route' | 'waypoint';
}

export function StatusBadge({ status, type }: StatusBadgeProps) {
  const label = type === 'route' ? getRouteStatusLabel(status as RouteStatus) : getWaypointStatusLabel(status as WaypointStatus);
  const color = getStatusColor(status);

  return (
    <View style={[styles.badge, { borderColor: color, backgroundColor: `${color}15` }]}>
      <Text style={[styles.text, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 4,
    alignSelf: 'flex-start'
  },
  text: {
    fontSize: 10,
    fontWeight: '700'
  }
});
