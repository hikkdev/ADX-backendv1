import rateLimit from 'express-rate-limit';

// Password-based endpoints are brute-forceable (unlike OTP, which requires an
// SMS to be sent per attempt), so throttle them per-IP.
export const passwordAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Please try again later.' },
});
