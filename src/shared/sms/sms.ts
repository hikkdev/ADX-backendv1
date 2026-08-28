import { logger } from '../logging/logger';
import { getEffectiveSmsConfig } from '../integrations/integration-config';

/**
 * Sends an SMS via MSG91 whenever MSG91 credentials are configured (dev or
 * production alike). Logs the message to the console instead if unconfigured.
 */
export async function sendSms(mobile: string, message: string): Promise<void> {
  const { authKey, templateId } = await getEffectiveSmsConfig();

  if (!authKey) {
    logger.info(`[SMS UNCONFIGURED] -> ${mobile}: ${message}`);
    return;
  }

  // MSG91 Flow API (transactional SMS)
  // Docs: https://docs.msg91.com/reference/send-sms
  const body = {
    template_id: templateId,
    short_url: '0',
    recipients: [
      {
        mobiles: mobile.startsWith('+') ? mobile.replace('+', '') : `91${mobile.replace(/^0/, '')}`,
        var1: message, // mapped to {{var1}} in your MSG91 template
      },
    ],
  };

  const response = await fetch('https://control.msg91.com/api/v5/flow', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'authkey': authKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error('MSG91 send failed', { mobile, status: response.status, body: err });
    throw new Error(`SMS delivery failed: ${response.status}`);
  }

  const data = await response.json() as { type?: string; message?: string };
  if (data.type === 'error') {
    logger.error('MSG91 error response', { mobile, data });
    throw new Error(`SMS delivery error: ${data.message}`);
  }

  logger.info('SMS sent via MSG91', { mobile });
}
