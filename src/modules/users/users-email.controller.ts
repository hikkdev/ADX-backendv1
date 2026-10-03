import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { primaryEmailSchema, verifyPrimaryEmailSchema } from './users.schema';
import { profilePayload } from './users.mapper';
import { sendPrimaryEmailCode, verifyPrimaryEmail } from './users-email.service';

function parse<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  return parsed.data;
}

/** ED-1: POST /users/me/email/send-code — a code to the address the person wants as their email. */
export async function sendMyEmailCode(req: Request, res: Response): Promise<void> {
  const { email } = parse(primaryEmailSchema, req.body);
  res.json({ success: true, data: await sendPrimaryEmailCode(req.user!.sub, email) });
}

/** ED-1: POST /users/me/email/verify — the answer; the address becomes the verified primary email. */
export async function verifyMyEmail(req: Request, res: Response): Promise<void> {
  const { email, code } = parse(verifyPrimaryEmailSchema, req.body);
  const user = await verifyPrimaryEmail(req.user!.sub, email, code);
  res.json({ success: true, data: profilePayload(user) });
}
