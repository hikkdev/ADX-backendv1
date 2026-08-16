import { Router } from 'express';
import {
  sendOtpHandler,
  verifyOtpHandler,
  sendOtpEmailHandler,
  verifyOtpEmailHandler,
  refreshTokenHandler,
  logoutHandler,
  publisherSendOtpHandler,
  publisherVerifyOtpHandler,
  loginPasswordHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  changePasswordHandler,
} from '../controllers/auth';
import { asyncHandler } from '../lib/errors';
import { authenticate } from '../middleware/authenticate';
import { passwordAuthLimiter } from '../middleware/rateLimit';

export const authRouter = Router();

authRouter.post('/send-otp', asyncHandler(sendOtpHandler));
authRouter.post('/verify-otp', asyncHandler(verifyOtpHandler));
authRouter.post('/send-otp-email', asyncHandler(sendOtpEmailHandler));
authRouter.post('/verify-otp-email', asyncHandler(verifyOtpEmailHandler));
authRouter.post('/refresh', asyncHandler(refreshTokenHandler));
authRouter.post('/logout', asyncHandler(logoutHandler));

// Email + password login
authRouter.post('/login-password', passwordAuthLimiter, asyncHandler(loginPasswordHandler));
authRouter.post('/forgot-password', passwordAuthLimiter, asyncHandler(forgotPasswordHandler));
authRouter.post('/reset-password', passwordAuthLimiter, asyncHandler(resetPasswordHandler));
authRouter.post('/change-password', authenticate, asyncHandler(changePasswordHandler));

// Publisher self-registration / login
authRouter.post('/publisher/send-otp', asyncHandler(publisherSendOtpHandler));
authRouter.post('/publisher/verify-otp', asyncHandler(publisherVerifyOtpHandler));
