import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWaypointStatusUpdateMutationPayload,
  hasWaypointPhotoMetadataInQueuePayload
} from '../../src/offline/waypointSyncPayload';

test('buildWaypointStatusUpdateMutationPayload inclui metadados de foto vindos de options', () => {
  const payload = buildWaypointStatusUpdateMutationPayload({
    queuePayload: {
      status: 'CONCLUIDO',
      options: {
        file_name: 'photo_123.jpg',
        user_id: 77,
        image_uri: 'file:///var/mobile/Containers/Data/Application/XYZ/Documents/delivery-photos/photo_123.jpg',
        image_base64: 'YmFzZTY0LWRhZG8=',
        image_mime_type: 'image/jpeg',
        obs_falha: ''
      }
    },
    routeId: 841,
    waypointId: 9001,
    status: 'CONCLUIDO'
  });

  assert.equal(payload.route_id, 841);
  assert.equal(payload.status, 'CONCLUIDO');
  assert.equal(payload.file_name, 'photo_123.jpg');
  assert.equal(payload.user_id, 77);
  assert.equal(payload.image_uri, 'file:///var/mobile/Containers/Data/Application/XYZ/Documents/delivery-photos/photo_123.jpg');
  assert.equal(payload.image_base64, 'YmFzZTY0LWRhZG8=');
  assert.equal(payload.image_mime_type, 'image/jpeg');
  assert.equal(payload.object_path, 'photo_123.jpg');
  assert.deepEqual(payload.photo, {
    waypoint_id: 9001,
    file_name: 'photo_123.jpg',
    filename: 'photo_123.jpg',
    user_id: 77,
    object_path: 'photo_123.jpg',
    photo_url: 'file:///var/mobile/Containers/Data/Application/XYZ/Documents/delivery-photos/photo_123.jpg'
  });
});

test('buildWaypointStatusUpdateMutationPayload preserva compatibilidade com campos top-level antigos', () => {
  const payload = buildWaypointStatusUpdateMutationPayload({
    queuePayload: {
      file_name: 'legacy.jpg',
      user_id: '88',
      image_uri: 'legacy.jpg',
      object_path: 'legacy/path/legacy.jpg'
    },
    routeId: 55,
    waypointId: 66,
    status: 'FALHA MORADOR AUSENTE'
  });

  assert.equal(payload.file_name, 'legacy.jpg');
  assert.equal(payload.user_id, '88');
  assert.equal(payload.object_path, 'legacy/path/legacy.jpg');
  assert.deepEqual(payload.photo, {
    waypoint_id: 66,
    file_name: 'legacy.jpg',
    filename: 'legacy.jpg',
    user_id: '88',
    object_path: 'legacy/path/legacy.jpg',
    photo_url: 'legacy.jpg'
  });
});

test('hasWaypointPhotoMetadataInQueuePayload detecta foto em options', () => {
  assert.equal(
    hasWaypointPhotoMetadataInQueuePayload({
      options: {
        image_base64: 'abc123'
      }
    }),
    true
  );
});

test('hasWaypointPhotoMetadataInQueuePayload detecta ausência de foto', () => {
  assert.equal(
    hasWaypointPhotoMetadataInQueuePayload({
      status: 'CONCLUIDO',
      options: {}
    }),
    false
  );
});
