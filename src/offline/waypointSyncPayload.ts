interface SyncPayloadRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): SyncPayloadRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as SyncPayloadRecord;
}

function pickString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function sanitizePathSegment(value: string) {
  const normalized = value.trim().replace(/\\/g, '/');
  const withoutQuery = normalized.split('?')[0]?.split('#')[0] ?? normalized;
  return withoutQuery;
}

function basenameFromPath(value: string) {
  const normalized = sanitizePathSegment(value);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  return parts[parts.length - 1];
}

function deriveObjectPathFromImageUri(imageUri?: string, fileName?: string) {
  const normalizedImageUri = pickString(imageUri);
  if (!normalizedImageUri) {
    return fileName;
  }

  const normalizedPath = sanitizePathSegment(normalizedImageUri);
  const deliveryPhotosMarker = '/delivery-photos/';
  const markerIndex = normalizedPath.lastIndexOf(deliveryPhotosMarker);
  if (markerIndex >= 0) {
    const pathAfterMarker = normalizedPath.slice(markerIndex + deliveryPhotosMarker.length).trim();
    if (pathAfterMarker.length > 0) {
      return pathAfterMarker;
    }
  }

  return basenameFromPath(normalizedPath) ?? fileName;
}

function toOptionalNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasValue(value: unknown) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return true;
}

export function hasWaypointPhotoMetadataInQueuePayload(queuePayload: Record<string, unknown>) {
  const options = asRecord(queuePayload.options) ?? {};
  const photo = asRecord(queuePayload.photo) ?? {};

  const photoCandidates = [
    photo.file_name,
    photo.filename,
    photo.user_id,
    photo.userId,
    photo.object_path,
    photo.objectPath,
    photo.photo_url,
    photo.photoUrl,
    photo.image_uri,
    photo.imageUri,
    photo.image_base64,
    photo.imageBase64,
    photo.image_mime_type,
    photo.imageMimeType,
    photo.file_size_bytes,
    photo.fileSizeBytes,
    queuePayload.file_name,
    queuePayload.fileName,
    queuePayload.user_id,
    queuePayload.userId,
    queuePayload.object_path,
    queuePayload.objectPath,
    queuePayload.image_uri,
    queuePayload.imageUri,
    queuePayload.image_base64,
    queuePayload.imageBase64,
    queuePayload.image_mime_type,
    queuePayload.imageMimeType,
    queuePayload.photo_url,
    queuePayload.photoUrl,
    queuePayload.file_size_bytes,
    queuePayload.fileSizeBytes,
    options.file_name,
    options.fileName,
    options.user_id,
    options.userId,
    options.object_path,
    options.objectPath,
    options.image_uri,
    options.imageUri,
    options.image_base64,
    options.imageBase64,
    options.image_mime_type,
    options.imageMimeType,
    options.photo_url,
    options.photoUrl,
    options.file_size_bytes,
    options.fileSizeBytes
  ];

  return photoCandidates.some(hasValue);
}

export function buildWaypointStatusUpdateMutationPayload(params: {
  queuePayload: Record<string, unknown>;
  routeId: number;
  waypointId: number;
  status: string;
}) {
  const { queuePayload, routeId, waypointId, status } = params;
  const options = asRecord(queuePayload.options) ?? {};

  const obsFalha = pickString(options.obs_falha, options.obsFalha, queuePayload.obs_falha, queuePayload.obsFalha);
  const fileName = pickString(options.file_name, options.fileName, queuePayload.file_name, queuePayload.fileName);
  const imageUri = pickString(options.image_uri, options.imageUri, queuePayload.image_uri, queuePayload.imageUri);
  const imageBase64 = pickString(
    options.image_base64,
    options.imageBase64,
    queuePayload.image_base64,
    queuePayload.imageBase64
  );
  const imageMimeType = pickString(
    options.image_mime_type,
    options.imageMimeType,
    queuePayload.image_mime_type,
    queuePayload.imageMimeType
  );
  const objectPath = pickString(
    options.object_path,
    options.objectPath,
    queuePayload.object_path,
    queuePayload.objectPath
  ) ?? deriveObjectPathFromImageUri(imageUri, fileName);
  const fileSizeBytes = toOptionalNumber(
    options.file_size_bytes ?? options.fileSizeBytes ?? queuePayload.file_size_bytes ?? queuePayload.fileSizeBytes
  );
  const userId =
    options.user_id ??
    options.userId ??
    queuePayload.user_id ??
    queuePayload.userId ??
    queuePayload.driver_id ??
    queuePayload.driverId;

  const photoMetadata = compactRecord({
    waypoint_id: waypointId,
    file_name: fileName,
    filename: fileName,
    user_id: userId,
    object_path: objectPath,
    file_size_bytes: fileSizeBytes,
    photo_url: imageUri
  });

  return compactRecord({
    route_id: routeId,
    status,
    obs_falha: obsFalha,
    file_name: fileName,
    user_id: userId,
    image_uri: imageUri,
    image_base64: imageBase64,
    image_mime_type: imageMimeType,
    object_path: objectPath,
    file_size_bytes: fileSizeBytes,
    photo: Object.keys(photoMetadata).length > 0 ? photoMetadata : undefined
  });
}

function compactRecord(record: Record<string, unknown>) {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }
  return compacted;
}
