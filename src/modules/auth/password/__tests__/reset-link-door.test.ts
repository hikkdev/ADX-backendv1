import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AE-B: the password-reset link leaves by the ONE door.
 *
 * Before, `forgotPasswordHandler` and `sendPasswordResetLink` called
 * `sendMail` directly and so always went SMTP, whatever `email.primary`
 * said — a Resend-only deployment logged the link and delivered nothing.
 * Pinned here: with the primary on RESEND, Resend is asked and SMTP is
 * not; with the mode on ETHEREAL, the test inbox is used and no host is
 * needed.
 */
const { repository, audit, config, mail, resend } = vi.hoisted(() => ({
  repository: { findByEmail: vi.fn(), setPasswordHash: vi.fn(), findLoginUserByEmail: vi.fn(), findById: vi.fn() },
  audit: { logActivity: vi.fn() },
  config: { getEffectiveEmailConfig: vi.fn(), getEffectiveResendConfig: vi.fn() },
  mail: { sendMail: vi.fn() },
  resend: { sendViaResend: vi.fn() },
}));

vi.mock('../../prisma-auth.repository', () => ({ prismaAuthRepository: repository }));
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../../../shared/integrations/integration-config', () => config);
vi.mock('../../../../shared/email/mail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/email/mail')>();
  return { ...actual, ...mail };
});
vi.mock('../../../../shared/email/resend', () => resend);
vi.mock('../prisma-password.repository', () => ({
  prismaPasswordRepository: { expireOutstandingResetTokens: vi.fn(), createResetToken: vi.fn(), findUsableResetToken: vi.fn(), markResetTokenUsed: vi.fn() },
}));

import { forgotPasswordHandler } from '../password.controller';
import { sendPasswordResetLink } from '../password.service';

const response = () => {
  const res: Record<string, unknown> = {};
  res['status'] = vi.fn(() => res);
  res['json'] = vi.fn(() => res);
  return res as never;
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findByEmail.mockResolvedValue({ id: 'usr_1', email: 'asha@adx.co' });
  config.getEffectiveResendConfig.mockResolvedValue({ apiKey: 're_key', fromEmail: 'ADX <hello@adx.co>' });
  mail.sendMail.mockResolvedValue({ messageId: '<smtp@adx>', response: '250 OK', previewUrl: null });
  resend.sendViaResend.mockResolvedValue({ messageId: 're_1', response: '{"id":"re_1"}' });
});

describe('the reset link and the one door', () => {
  it('forgot-password with the primary on RESEND asks Resend, not SMTP', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue({ primary: 'RESEND', mode: 'SMTP', host: 'smtp.local' });
    const req = { body: { email: 'asha@adx.co' }, ip: '127.0.0.1', headers: {} } as never;
    await forgotPasswordHandler(req, response());

    expect(resend.sendViaResend).toHaveBeenCalledTimes(1);
    const [to, subject, html] = resend.sendViaResend.mock.calls[0]! as [string, string, string];
    expect(to).toBe('asha@adx.co');
    expect(subject).toBe('Reset your ADX Admin password');
    expect(html).toContain('/reset-password?token=');
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith('usr_1', 'PASSWORD_RESET_REQUESTED', req);
  });

  it('the desk`s reset link (sendPasswordResetLink) goes by the same door', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue({ primary: 'RESEND', mode: 'SMTP' });
    await sendPasswordResetLink('usr_1', 'asha@adx.co');
    expect(resend.sendViaResend).toHaveBeenCalledTimes(1);
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('with the primary on SMTP the SMTP helper is the one asked', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue({ primary: 'SMTP', mode: 'ETHEREAL' });
    await sendPasswordResetLink('usr_1', 'asha@adx.co');
    expect(mail.sendMail).toHaveBeenCalledWith('asha@adx.co', 'Reset your ADX Admin password', expect.stringContaining('/reset-password?token='));
    expect(resend.sendViaResend).not.toHaveBeenCalled();
  });
});
