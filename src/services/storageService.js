import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, isS3Configured } from '../config/env.js';

const DEFAULT_PRESIGNED_EXPIRY_SECONDS = 60 * 10;

const s3Client = isS3Configured
  ? new S3Client({
      region: env.s3Region,
      credentials: {
        accessKeyId: env.s3AccessKeyId,
        secretAccessKey: env.s3SecretAccessKey,
      },
    })
  : null;

function sanitizeFileName(value) {
  return String(value || 'receipt')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

function inferExtensionFromMime(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'bin';
}

function normalizePrefix(prefix) {
  return String(prefix || '').replace(/^\/+|\/+$/g, '');
}

function buildObjectKey({ scopeKey, fileName, contentType }) {
  const prefix = normalizePrefix(env.s3ReceiptsPrefix);
  const extension = inferExtensionFromMime(contentType);
  const baseName = sanitizeFileName(fileName).replace(/\.[a-zA-Z0-9]+$/, '') || 'receipt';

  return [prefix, scopeKey, `${Date.now()}-${baseName}.${extension}`]
    .filter(Boolean)
    .join('/');
}

function buildProduceImageObjectKey({ fileName, contentType }) {
  const prefix = normalizePrefix(env.s3ProducePrefix);
  const extension = inferExtensionFromMime(contentType);
  const baseName = sanitizeFileName(fileName).replace(/\.[a-zA-Z0-9]+$/, '') || 'produce';

  return [prefix, `${Date.now()}-${baseName}.${extension}`]
    .filter(Boolean)
    .join('/');
}

function buildPublicObjectUrl(objectKey) {
  const publicBaseUrl = String(env.s3PublicBaseUrl || '').replace(/\/$/, '');
  if (publicBaseUrl) {
    return `${publicBaseUrl}/${objectKey}`;
  }

  return `https://${env.s3BucketName}.s3.${env.s3Region}.amazonaws.com/${objectKey}`;
}

function assertS3Configured() {
  if (!s3Client) {
    throw new Error('S3 storage is not configured.');
  }
}

export function isValidReceiptObjectKey(orderReference, objectKey) {
  const prefix = normalizePrefix(env.s3ReceiptsPrefix);
  const expectedStart = [prefix, orderReference].filter(Boolean).join('/');
  return String(objectKey || '').startsWith(expectedStart);
}

export function isValidScopedReceiptObjectKey(scopeKey, objectKey) {
  const prefix = normalizePrefix(env.s3ReceiptsPrefix);
  const expectedStart = [prefix, scopeKey].filter(Boolean).join('/');
  return String(objectKey || '').startsWith(expectedStart);
}

export async function createScopedTransferProofUploadTarget({
  scopeKey,
  fileName,
  contentType,
}) {
  assertS3Configured();

  const objectKey = buildObjectKey({
    scopeKey,
    fileName,
    contentType,
  });

  const uploadUrl = await getSignedUrl(
    s3Client,
    new PutObjectCommand({
      Bucket: env.s3BucketName,
      Key: objectKey,
    }),
    { expiresIn: DEFAULT_PRESIGNED_EXPIRY_SECONDS },
  );

  return {
    storage: 'S3',
    objectKey,
    uploadUrl,
    contentType,
    expiresInSeconds: DEFAULT_PRESIGNED_EXPIRY_SECONDS,
  };
}

export async function createTransferProofUploadTarget({
  orderReference,
  fileName,
  contentType,
}) {
  return createScopedTransferProofUploadTarget({
    scopeKey: orderReference,
    fileName,
    contentType,
  });
}

export async function createTransferProofViewUrl(objectKey) {
  assertS3Configured();

  if (!objectKey) {
    throw new Error('Transfer proof object key is required.');
  }

  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: env.s3BucketName,
      Key: objectKey,
    }),
    { expiresIn: DEFAULT_PRESIGNED_EXPIRY_SECONDS },
  );
}

export async function getS3Object(objectKey) {
  assertS3Configured();

  if (!objectKey) {
    throw new Error('S3 object key is required.');
  }

  return s3Client.send(
    new GetObjectCommand({
      Bucket: env.s3BucketName,
      Key: objectKey,
    }),
  );
}

export async function createProduceImageUploadTarget({
  fileName,
  contentType,
}) {
  assertS3Configured();

  const objectKey = buildProduceImageObjectKey({
    fileName,
    contentType,
  });

  const uploadUrl = await getSignedUrl(
    s3Client,
    new PutObjectCommand({
      Bucket: env.s3BucketName,
      Key: objectKey,
    }),
    { expiresIn: DEFAULT_PRESIGNED_EXPIRY_SECONDS },
  );

  return {
    storage: 'S3',
    objectKey,
    imageUrl: buildPublicObjectUrl(objectKey),
    uploadUrl,
    contentType,
    expiresInSeconds: DEFAULT_PRESIGNED_EXPIRY_SECONDS,
  };
}

export async function uploadProduceImageObject({
  fileName,
  contentType,
  body,
}) {
  assertS3Configured();

  const objectKey = buildProduceImageObjectKey({
    fileName,
    contentType,
  });

  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.s3BucketName,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }),
  );

  return {
    storage: 'S3',
    objectKey,
    imageUrl: buildPublicObjectUrl(objectKey),
    contentType,
  };
}

export function isValidProduceImageObjectKey(objectKey) {
  const prefix = normalizePrefix(env.s3ProducePrefix);
  const expectedStart = prefix ? `${prefix}/` : '';
  return Boolean(objectKey) && (!expectedStart || String(objectKey).startsWith(expectedStart));
}

export function buildStoredTransferProof({
  fileName,
  contentType,
  sizeBytes,
  objectKey,
}) {
  return {
    storage: 'S3',
    fileName,
    contentType,
    sizeBytes,
    objectKey,
    uploadedAt: new Date().toISOString(),
  };
}
