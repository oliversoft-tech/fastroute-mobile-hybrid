import { colors } from '../theme/colors';
import { RouteStatus, WaypointStatus } from '../api/types';

export function getRouteStatusLabel(status: RouteStatus) {
  switch (status) {
    case 'PENDENTE':
      return 'PENDENTE';
    case 'EM_ROTA':
      return 'EM ANDAMENTO';
    case 'FINALIZADA':
      return 'FINALIZADA';
    default:
      return status;
  }
}

export function getWaypointStatusLabel(status: WaypointStatus) {
  switch (status) {
    case 'PENDENTE':
      return 'PENDENTE';
    case 'EM_ROTA':
      return 'EM ROTA';
    case 'CONCLUIDO':
      return 'ENTREGUE';
    case 'FALHA TEMPO ADVERSO':
      return 'FALHA TEMPO ADVERSO';
    case 'FALHA MORADOR AUSENTE':
      return 'FALHA MORADOR AUSENTE';
    default:
      return status;
  }
}

export function getStatusColor(status: RouteStatus | WaypointStatus) {
  switch (status) {
    case 'CONCLUIDO':
    case 'FINALIZADA':
      return colors.success;
    case 'EM_ROTA':
      return colors.primary;
    case 'PENDENTE':
      return colors.warning;
    case 'FALHA TEMPO ADVERSO':
    case 'FALHA MORADOR AUSENTE':
      return colors.danger;
    default:
      return colors.neutral;
  }
}
