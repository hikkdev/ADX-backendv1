import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getEffectiveKycConfig, type KycConfig } from './integrationConfig.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DigioPurpose = 'AADHAAR_VERIFICATION' | 'PAN_VERIFICATION' | 'DRIVING_LICENCE';

type DigiInitiateResponse = {
  id: string;             // kycId
  customer_identifier: string;
  access_token: { id: string; entity_id: string; valid_till: string };
};

type DigioWebhookStatus = 'approved' | 'rejected' | 'pending' | 'cancelled';

export type DigioWebhookPayload = {
  id: string;             // kycId
  customer_identifier: string;
  status: DigioWebhookStatus;
  message?: string;
  kyc_documents?: {
    type: string;
    status: DigioWebhookStatus;
    name?: string;
    dob?: string;
        id_number?: string;
  }[];
  completed_at?: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAuthHeader(cfg: KycConfig): string {
  const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  return `Basic ${creds}`;
}

function isConfigured(cfg: KycConfig): boolean {
  return !!(cfg.clientId && cfg.clientSecret);
}

// ─── Initiate ─────────────────────────────────────────────────────────────────

export async function initiateDigioKyc(
  publisherId: string,
  customerName: string,
  customerEmail: string,
  customerMobile: string,
): Promise<{ kycId: string; accessToken: string; validTill: string; sdkUrl: string }> {
  const cfg = await getEffectiveKycConfig();

  if (!isConfigured(cfg)) {
    // Dev mode — simulate a pending KYC so the flow can be tested without real credentials
    logger.warn('Digio not configured — returning mock KYC initiation (dev only)');
    const mockKycId = `digio_mock_${publisherId}_${Date.now()}`;

    await prisma.publisherKyc.upsert({
      where: { publisherId },
      update: {
        method: 'DIGIO',
        digioRequestId: mockKycId,
        digioReferenceId: publisherId,
        digioStatus: 'pending',
        submittedAt: new Date(),
      },
      create: {
        publisherId,
        method: 'DIGIO',
        digioRequestId: mockKycId,
        digioReferenceId: publisherId,
        digioStatus: 'pending',
        submittedAt: new Date(),
      },
    });

    const sdkBase = cfg.baseUrl!.replace('https://', 'https://');
    return { kycId: mockKycId, accessToken: 'mock_token', validTill: new Date(Date.now() + 3600_000).toISOString(), sdkUrl: `${sdkBase}/#${mockKycId}?token=mock_token` };
  }

  const referenceId = `adx-${publisherId}-${Date.now()}`;

  if (!env.BASE_URL) {
    logger.warn('BASE_URL is not set — Digio webhook callbacks will not work until it is configured');
  }

  const body = {
    customer_identifier: customerEmail || customerMobile,
    customer_name: customerName,
    reference_id: referenceId,
    notify_customer: true,
    ...(env.BASE_URL ? { callback_url: `${env.BASE_URL}/api/v1/webhooks/digio` } : {}),
    purpose: 'KYC',
  };

  const response = await fetch(`${cfg.baseUrl}/client/kyc/v2/request/with_template`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': getAuthHeader(cfg),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error('Digio initiate failed', { status: response.status, body: err });
    throw new Error(`Digio KYC initiation failed: ${response.status}`);
  }

  const data = await response.json() as DigiInitiateResponse;

  await prisma.publisherKyc.upsert({
    where: { publisherId },
    update: {
      method: 'DIGIO',
      digioRequestId: data.id,
      digioReferenceId: referenceId,
      digioStatus: 'pending',
      submittedAt: new Date(),
    },
    create: {
      publisherId,
      method: 'DIGIO',
      digioRequestId: data.id,
      digioReferenceId: referenceId,
      digioStatus: 'pending',
      submittedAt: new Date(),
    },
  });

  return {
    kycId: data.id,
    accessToken: data.access_token.id,
    validTill: data.access_token.valid_till,
    sdkUrl: `${cfg.baseUrl}/#${data.id}?token=${data.access_token.id}`,
  };
}

// ─── Webhook Handler ──────────────────────────────────────────────────────────

export async function handleDigioWebhook(payload: DigioWebhookPayload): Promise<void> {
  const { id: kycId, status, completed_at } = payload;

  logger.info('Digio webhook received', { kycId, status });

  const kyc = await prisma.publisherKyc.findFirst({ where: { digioRequestId: kycId } });
  if (!kyc) {
    logger.warn('Digio webhook: no KYC record found for kycId', { kycId });
    return;
  }

  const isApproved = status === 'approved';
  const isRejected = status === 'rejected';

  await prisma.publisherKyc.update({
    where: { id: kyc.id },
    data: {
      digioStatus: status,
      digioPayload: payload as any,
      digioVerifiedAt: completed_at ? new Date(completed_at) : (isApproved ? new Date() : undefined),
      status: isApproved ? 'VERIFIED' : isRejected ? 'REJECTED' : 'PENDING',
      reviewedAt: isApproved || isRejected ? new Date() : undefined,
      rejectionReason: isRejected ? (payload.message ?? 'KYC rejected by Digio') : undefined,
    },
  });

  // Notify the publisher's agent
  const publisher = await prisma.publisher.findUnique({
    where: { id: kyc.publisherId },
    include: { agent: { include: { user: true } } },
  });

  if (publisher) {
    await prisma.notification.create({
      data: {
        userId: publisher.agent!.userId,
        type: 'KYC',
        title: isApproved ? 'KYC Approved' : isRejected ? 'KYC Rejected' : 'KYC Update',
        subtitle: publisher.name,
        message: isApproved
          ? `KYC for publisher ${publisher.name} has been verified via Digio.`
          : isRejected
          ? `KYC for publisher ${publisher.name} was rejected. ${payload.message ?? ''}`
          : `KYC status updated to ${status} for ${publisher.name}.`,
        relatedId: publisher.id,
      },
    });
  }
}

// ─── Status Check ─────────────────────────────────────────────────────────────

export async function getDigioKycStatus(publisherId: string): Promise<{
  method: string;
  digioStatus: string | null;
  kycStatus: string;
  digioVerifiedAt: Date | null;
} | null> {
  const kyc = await prisma.publisherKyc.findUnique({ where: { publisherId } });
  if (!kyc) return null;
  return {
    method: kyc.method,
    digioStatus: kyc.digioStatus,
    kycStatus: kyc.status,
    digioVerifiedAt: kyc.digioVerifiedAt,
  };
}
