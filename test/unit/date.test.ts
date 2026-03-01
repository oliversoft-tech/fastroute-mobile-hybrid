import test from 'node:test';
import assert from 'node:assert/strict';

import { formatDate } from '../../src/utils/date';

test('formatDate retorna placeholder quando data é inválida', () => {
  assert.equal(formatDate('foo'), '-');
});

test('formatDate usa padrão pt-BR', () => {
  assert.equal(formatDate('2026-01-15T10:00:00.000Z'), '15/01/2026');
});
