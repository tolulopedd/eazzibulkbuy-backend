import dotenv from 'dotenv';

dotenv.config();

function normalizeEnvValue(value) {
  if (!value) {
    return '';
  }

  const trimmed = value.trim();
  const equalsIndex = trimmed.indexOf('=');

  if (equalsIndex === -1) {
    return trimmed;
  }

  const prefix = trimmed.slice(0, equalsIndex);
  const remainder = trimmed.slice(equalsIndex + 1).trim();

  if (/^[A-Z0-9_]+$/i.test(prefix) && /^https?:\/\//i.test(remainder)) {
    return remainder;
  }

  return trimmed;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  adminSessionTtlMinutes: Math.max(30, Number(process.env.ADMIN_SESSION_TTL_MINUTES || 480)),
  frontendUrl: normalizeEnvValue(process.env.FRONTEND_URL) || 'http://localhost:5173',
  frontendUrls: process.env.FRONTEND_URLS || '',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  helcimApiToken: process.env.HELCIM_API_TOKEN || '',
  helcimApiBaseUrl: process.env.HELCIM_API_BASE_URL || 'https://api.helcim.com',
  resendApiKey: process.env.RESEND_API_KEY || '',
  resendFrom: process.env.RESEND_FROM || 'EazziBulkBuy <no-reply@eazzibulkbuy.com>',
  s3Region: process.env.AWS_S3_REGION || '',
  s3BucketName: process.env.AWS_S3_BUCKET_NAME || '',
  s3AccessKeyId: process.env.AWS_S3_ACCESS_KEY_ID || '',
  s3SecretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY || '',
  s3ReceiptsPrefix: process.env.AWS_S3_RECEIPTS_PREFIX || 'receipts',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || 'EazziBulkBuy <no-reply@eazzibulkbuy.com>',
  whatsappAccessToken: process.env.META_WHATSAPP_ACCESS_TOKEN || '',
  whatsappPhoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID || '',
  whatsappApiVersion: process.env.META_WHATSAPP_API_VERSION || 'v21.0',
  interacBusinessEmail: process.env.INTERAC_BUSINESS_EMAIL || 'payments@eazzibulkbuy.ca',
  interacTransferInstructions:
    process.env.INTERAC_TRANSFER_INSTRUCTIONS ||
    'Use your Order ID in transfer memo and reply with proof of transfer.',
  bankTransferInstructions:
    process.env.BANK_TRANSFER_INSTRUCTIONS ||
    'Include your Order ID as reference in your bank transfer.',
  superAdminEmail: process.env.SUPERADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@eazzibulkbuy.com',
  superAdminPassword: process.env.SUPERADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'ChangeMe123!',
  legacyAdminEmail: process.env.ADMIN_EMAIL || '',
  legacyAdminPassword: process.env.ADMIN_PASSWORD || '',
  adminSessionSecret: process.env.ADMIN_SESSION_SECRET || 'dev-admin-session-secret',
};

export function validateSecurityConfiguration() {
  const issues = [];

  if (env.nodeEnv === 'production') {
    if (!process.env.ADMIN_SESSION_SECRET || env.adminSessionSecret === 'dev-admin-session-secret') {
      issues.push('ADMIN_SESSION_SECRET must be set to a strong unique value in production.');
    }

    if (
      (!process.env.SUPERADMIN_PASSWORD && !process.env.ADMIN_PASSWORD) ||
      env.superAdminPassword === 'ChangeMe123!'
    ) {
      issues.push('SUPERADMIN_PASSWORD or ADMIN_PASSWORD must be set to a strong unique value in production.');
    }
  }

  return issues;
}

export const allowedFrontendOrigins = [
  env.frontendUrl,
  ...env.frontendUrls
    .split(',')
    .map((value) => normalizeEnvValue(value))
    .filter(Boolean),
];

export const isStripeConfigured = Boolean(env.stripeSecretKey);
export const isHelcimConfigured = Boolean(env.helcimApiToken);
export const isResendConfigured = Boolean(env.resendApiKey);
export const isSmtpConfigured = Boolean(env.smtpHost && env.smtpUser && env.smtpPass);
export const isWhatsAppConfigured = Boolean(env.whatsappAccessToken && env.whatsappPhoneNumberId);
export const isS3Configured = Boolean(
  env.s3Region &&
  env.s3BucketName &&
  env.s3AccessKeyId &&
  env.s3SecretAccessKey,
);
