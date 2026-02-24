import { colors } from '../theme/colors';
import { RouteStatus, WaypointStatus } from '../api/types';

export function getRouteStatusLabel(status: RouteStatus) {
  switch (status) {
    case 'PENDENTE':
      return 'PENDENTE';
    case 'CRIADA':
      return 'CRIADA';
    case 'EM_ROTA':
    case 'EM_ANDAMENTO':
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
    case 'REORDENADO':
      return 'REORDENADO';
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
    case 'EM_ANDAMENTO':
      return colors.primary;
    case 'CRIADA':
    case 'PENDENTE':
      return colors.warning;
    case 'REORDENADO':
      return colors.primary;
    case 'FALHA TEMPO ADVERSO':
    case 'FALHA MORADOR AUSENTE':
      return colors.danger;
    default:
      return colors.neutral;
  }
}
