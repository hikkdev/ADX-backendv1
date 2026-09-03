import { z } from 'zod';

const mobileNumber = z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid mobile number');

export const sendOtpSchema = z.object({ mobile: mobileNumber });

export const verifyOtpSchema = z.object({
  // Deliberately a bare string, not `mobileNumber`: the value is normalised
  // before lookup, and a stricter rule here would reject formats that sending
  // accepted.
  mobile: z.string(),
  otp: z.string().length(6),
});

export const sendOtpEmailSchema = z.object({ email: z.string().email() });

export const verifyOtpEmailSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
});

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });

export const logoutSchema = z.object({ refreshToken: z.string().min(1) });

export const loginPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// The credential is Google's ID token, so there is nothing else to validate
// here: every claim inside it is checked cryptographically in google.service.
// A bare non-empty string keeps a malformed token a 401 from the verifier
// rather than a 400 from Zod, so probing the endpoint yields one answer.
export const googleLoginSchema = z.object({ idToken: z.string().min(1) });

export const forgotPasswordSchema = z.object({ email: z.string().email() });

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

export const changePasswordSchema = z.object({
  // Optional because this endpoint doubles as "set my initial password" for
  // accounts created without one.
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

export const publisherRegisterSchema = z.object({ mobile: mobileNumber });

export const publisherVerifyOtpSchema = z.object({
  mobile: z.string(),
  otp: z.string().length(6),
  // Required only on first registration (after OTP verified, store name etc.)
  name: z.string().min(1).optional(),
});
