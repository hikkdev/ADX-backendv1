import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate } from '../../shared/auth';
import { verifyCaptcha } from '../../shared/security';
import {
  passwordAuthLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  refreshLimiter,
} from '../../shared/security';
import {
  sendOtpHandler,
  verifyOtpHandler,
  sendOtpEmailHandler,
  verifyOtpEmailHandler,
} from './otp/otp.controller';
import { refreshTokenHandler, logoutHandler } from './tokens/tokens.controller';
import {
  loginPasswordHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  changePasswordHandler,
} from './password/password.controller';
import {
  publisherSendOtpHandler,
  publisherVerifyOtpHandler,
} from './publisher/publisher-auth.controller';

export const authRouter = Router();

// Captcha guards the "request" endpoints (where scripted abuse pays off) —
// not verify/reset-consume/refresh, which either require a secret already in
// hand or gain nothing from a per-request bot check.
authRouter.post('/send-otp', otpRequestLimiter, verifyCaptcha, asyncHandler(sendOtpHandler));
authRouter.post('/verify-otp', otpVerifyLimiter, asyncHandler(verifyOtpHandler));
authRouter.post('/send-otp-email', otpRequestLimiter, verifyCaptcha, asyncHandler(sendOtpEmailHandler));
authRouter.post('/verify-otp-email', otpVerifyLimiter, asyncHandler(verifyOtpEmailHandler));
authRouter.post('/refresh', refreshLimiter, asyncHandler(refreshTokenHandler));
authRouter.post('/logout', refreshLimiter, asyncHandler(logoutHandler));

// Email + password login
authRouter.post('/login-password', passwordAuthLimiter, verifyCaptcha, asyncHandler(loginPasswordHandler));
authRouter.post('/forgot-password', passwordAuthLimiter, verifyCaptcha, asyncHandler(forgotPasswordHandler));
authRouter.post('/reset-password', passwordAuthLimiter, asyncHandler(resetPasswordHandler));
authRouter.post('/change-password', authenticate, asyncHandler(changePasswordHandler));

// Publisher self-registration / login
authRouter.post('/publisher/send-otp', otpRequestLimiter, verifyCaptcha, asyncHandler(publisherSendOtpHandler));
authRouter.post('/publisher/verify-otp', otpVerifyLimiter, asyncHandler(publisherVerifyOtpHandler));
