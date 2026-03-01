import test from 'node:test';
import assert from 'node:assert/strict';

import { getRouteStatusLabel, getStatusColor, getWaypointStatusLabel } from '../../src/utils/status';

test('status de rota EM_ANDAMENTO é normalizado para EM ANDAMENTO', () => {
  assert.equal(getRouteStatusLabel('EM_ANDAMENTO'), 'EM ANDAMENTO');
});

test('status de waypoint CONCLUIDO é exibido como ENTREGUE', () => {
  assert.equal(getWaypointStatusLabel('CONCLUIDO'), 'ENTREGUE');
});

test('status finalizado usa cor de sucesso', () => {
  assert.equal(getStatusColor('FINALIZADA'), '#17B26A');
});
