import { env, isWhatsAppConfigured } from '../config/env.js';

function normalizePhoneToE164(phone) {
  const digits = String(phone || '').replace(/\D/g, '');

  if (!digits) {
    return '';
  }

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  if (String(phone || '').trim().startsWith('+')) {
    return String(phone).trim();
  }

  return '';
}

export async function sendWhatsAppTextMessage({ to, text }) {
  const normalizedTo = normalizePhoneToE164(to);

  if (!normalizedTo) {
    return {
      sent: false,
      status: 'invalid_phone',
      reason: 'Buyer phone number is missing or invalid for WhatsApp.',
    };
  }

  if (!isWhatsAppConfigured) {
    console.log('[whatsapp:dry-run]', {
      to: normalizedTo,
      text,
      reason: 'Meta WhatsApp credentials are not configured yet.',
    });

    return {
      sent: false,
      status: 'not_configured',
      reason: 'Meta WhatsApp credentials are not configured yet.',
    };
  }

  const response = await fetch(
    `https://graph.facebook.com/${env.whatsappApiVersion}/${env.whatsappPhoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.whatsappAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: normalizedTo.replace(/^\+/, ''),
        type: 'text',
        text: {
          preview_url: false,
          body: text,
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      sent: false,
      status: 'failed',
      reason: `WhatsApp send failed (${response.status}): ${body || 'Unknown error'}`,
    };
  }

  const payload = await response.json().catch(() => ({}));

  return {
    sent: true,
    status: 'sent',
    providerResponse: payload,
  };
}
