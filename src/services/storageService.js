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

function buildObjectKey({ orderReference, fileName, contentType }) {
  const prefix = normalizePrefix(env.s3ReceiptsPrefix);
  const extension = inferExtensionFromMime(contentType);
  const baseName = sanitizeFileName(fileName).replace(/\.[a-zA-Z0-9]+$/, '') || 'receipt';

  return [prefix, orderReference, `${Date.now()}-${baseName}.${extension}`]
    .filter(Boolean)
    .join('/');
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

export async function createTransferProofUploadTarget({
  orderReference,
  fileName,
  contentType,
}) {
  assertS3Configured();

  const objectKey = buildObjectKey({
    orderReference,
    fileName,
    contentType,
  });

  const uploadUrl = await getSignedUrl(
    s3Client,
    new PutObjectCommand({
      Bucket: env.s3BucketName,
      Key: objectKey,
      ContentType: contentType,
      ContentDisposition: `inline; filename="${sanitizeFileName(fileName)}"`,
    }),
    { expiresIn: DEFAULT_PRESIGNED_EXPIRY_SECONDS },
  );

  return {
    storage: 'S3',
    objectKey,
    uploadUrl,
    expiresInSeconds: DEFAULT_PRESIGNED_EXPIRY_SECONDS,
  };
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
