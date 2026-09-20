import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-6 (17 Sep 2026) — the terms of use and the privacy policy, agreed
 * before any detail is asked.
 *
 * The owner: "it should be asked before we gather any details and not be a
 * part of the progress bar". Pinned: `POST /users/me/consent` stamps the
 * person with the moment and the versions of the two legal documents live
 * at the click — read server-side, never from the body; a document ADX has
 * not published records as version null rather than refusing; the click is
 * idempotent and re-stamps with the versions live now; `GET /users/me`
 * carries `consentAcceptedAt` (null until then) and the two versions, which
 * is what the app's gate reads; the activity log records it.
 */
const { repository, auth, accessControl, audit, legal } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findProfile: vi.fn(),
    recordConsent: vi.fn(),
  },
  auth: {
    normalizeMobile: vi.fn((m: string) => m),
    revokeSessions: vi.fn(),
    requireTwoFactorFor: vi.fn(),
    sendPasswordResetLink: vi.fn(),
    expireOutstandingOtpsForUser: vi.fn(),
  },
  accessControl: { getRoleConfigForUser: vi.fn(), assignRoleConfig: vi.fn(), assignRoleConfigSchema: {}, consoleStandingFor: vi.fn(), assertNotLastSuperAdmin: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})), listActivity: vi.fn() },
  legal: { currentLegalDocument: vi.fn() },
}));

vi.mock('../prisma-users.repository', () => ({ prismaUsersRepository: repository }));
vi.mock('../../auth', () => auth);
vi.mock('../../access-control', () => accessControl);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../publishers', () => ({ registerPublisher: vi.fn() }));
vi.mock('../../advertisers', () => ({ registerAdvertiser: vi.fn() }));
vi.mock('../../legal', () => legal);
vi.mock('../onboarding-manifest.service', () => ({ onboardingManifest: vi.fn() }));

import { ApiError, errorHandler } from '../../../shared/errors';
import { asyncHandler } from '../../../shared/http';
import { authenticate, signAccessToken } from '../../../shared/auth';
import { profilePayload } from '../users.mapper';
import { getMe, recordMyConsent } from '../users.controller';

const NOW = new Date('2026-09-17T02:00:00Z');

const user = (over: Record<string, unknown> = {}) =>
  ({
    id: 'usr_1',
    displayId: 'ADX-1709-2601',
    mobile: '+919845012210',
    name: null,
    firstName: null,
    lastName: null,
    dateOfBirth: null,
    gender: null,
    consentAcceptedAt: null,
    consentTermsVersion: null,
    consentPrivacyVersion: null,
    email: null,
    avatarUrl: null,
    passwordHash: null,
    language: 'en',
    isActive: true,
    closedAt: null,
    closeReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastLoginAt: NOW,
    emailUnsubscribedAt: null,
    twoFactorRequiredAt: null,
    emailOtpFallbackCount: 0,
    emailOtpFallbackResetAt: null,
    roles: [],
    agentProfile: null,
    publisherProfile: null,
    advertiserProfile: null,
    ...over,
  }) as never;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.get('/api/v1/users/me', authenticate, asyncHandler(getMe));
  instance.post('/api/v1/users/me/consent', authenticate, asyncHandler(recordMyConsent));
  instance.use(errorHandler);
  return instance;
}

const token = signAccessToken('usr_1', [], 'ses_1');

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(user());
  repository.findProfile.mockResolvedValue(user());
  repository.recordConsent.mockImplementation(async (_id: string, data: Record<string, unknown>) => user(data));
  legal.currentLegalDocument.mockImplementation(async (kind: string) => ({ kind, version: kind === 'TERMS_OF_SERVICE' ? 3 : 2 }));
  accessControl.consoleStandingFor.mockResolvedValue({ roleConfig: null, isSuperAdmin: false });
});

describe('GET /users/me', () => {
  it('carries the consent stamp — null until the click, then the moment and the two versions', async () => {
    expect(profilePayload(user())).toMatchObject({ consentAcceptedAt: null, consentTermsVersion: null, consentPrivacyVersion: null });
    repository.findProfile.mockResolvedValue(user({ consentAcceptedAt: NOW, consentTermsVersion: 3, consentPrivacyVersion: 2 }));
    const res = await request(app()).get('/api/v1/users/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ consentAcceptedAt: '2026-09-17T02:00:00.000Z', consentTermsVersion: 3, consentPrivacyVersion: 2 });
  });
});

describe('POST /users/me/consent', () => {
  it('stamps the person with the versions live now, read server-side, and logs it', async () => {
    const res = await request(app()).post('/api/v1/users/me/consent').set('Authorization', `Bearer ${token}`).send({ termsVersion: 99 });
    expect(res.status).toBe(200);
    expect(repository.recordConsent).toHaveBeenCalledWith('usr_1', {
      consentAcceptedAt: expect.any(Date),
      consentTermsVersion: 3,
      consentPrivacyVersion: 2,
    });
    expect(res.body.data).toMatchObject({ consentTermsVersion: 3, consentPrivacyVersion: 2 });
    expect(res.body.data.consentAcceptedAt).toBeTruthy();
    expect(audit.logActivity).toHaveBeenCalledWith('usr_1', 'CONSENT_RECORDED', expect.anything(), { termsVersion: 3, privacyVersion: 2 });
    expect(legal.currentLegalDocument).toHaveBeenCalledWith('TERMS_OF_SERVICE');
    expect(legal.currentLegalDocument).toHaveBeenCalledWith('PRIVACY_POLICY');
  });

  it('records a document ADX has not published as version null rather than refusing', async () => {
    legal.currentLegalDocument.mockImplementation(async (kind: string) => {
      if (kind === 'PRIVACY_POLICY') throw new ApiError(404, 'NO_ACTIVE_DOCUMENT', 'none');
      return { kind, version: 3 };
    });
    const res = await request(app()).post('/api/v1/users/me/consent').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(repository.recordConsent).toHaveBeenCalledWith('usr_1', expect.objectContaining({ consentTermsVersion: 3, consentPrivacyVersion: null }));
  });

  it('is idempotent — a second click re-stamps with what is live now', async () => {
    repository.findById.mockResolvedValue(user({ consentAcceptedAt: new Date('2026-01-01T00:00:00Z'), consentTermsVersion: 1, consentPrivacyVersion: 1 }));
    const res = await request(app()).post('/api/v1/users/me/consent').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(repository.recordConsent).toHaveBeenCalledWith('usr_1', expect.objectContaining({ consentTermsVersion: 3, consentPrivacyVersion: 2 }));
  });

  it('404s an account that is gone', async () => {
    repository.findById.mockResolvedValue(null);
    const res = await request(app()).post('/api/v1/users/me/consent').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(404);
    expect(repository.recordConsent).not.toHaveBeenCalled();
  });
});
