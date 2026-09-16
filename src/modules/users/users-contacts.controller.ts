import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { addContactSchema, contactReasonSchema, updateContactSchema, verifyContactSchema } from './users.schema';
import * as contacts from './users-contacts.service';
import type { ContactRow } from './users.repository';
import { findUserLabels } from './users.service';

/**
 * K-B1 — the contacts routes, in two mounts that share one service.
 *
 * `/users/me/contacts/*` is the person on their own account: no reason, no
 * audit row beyond the generic one, a verified contact needed before it can
 * become the primary. `/users/:id/contacts/*` is the desk on somebody else's:
 * every write carries a `reason` and is audited against the account with the
 * acting admin in the metadata (`USER_CONTACT_ADDED`, `USER_CONTACT_REMOVED`,
 * `USER_CONTACT_MARKED_VERIFIED`, `USER_PRIMARY_CHANGED`) — identity edits
 * are the highest-trust writes in the console, and the reason is the field
 * nobody can reconstruct later.
 */

function parse<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  return parsed.data;
}

const me = (req: Request) => req.user!.sub;
const target = (req: Request) => req.params['id'] as string;
const contactId = (req: Request) => req.params['contactId'] as string;

async function viewOf(row: ContactRow) {
  const labels = await findUserLabels([row.addedById]);
  return contacts.toView(row, labels.get(row.addedById)?.name ?? null);
}

/* ── reads ──────────────────────────────────────────────────────── */

export async function listMyContacts(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await contacts.listContacts(me(req)) });
}

export async function listUserContacts(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await contacts.listContacts(target(req)) });
}

/* ── add ────────────────────────────────────────────────────────── */

export async function addMyContact(req: Request, res: Response): Promise<void> {
  const input = parse(addContactSchema, req.body);
  const row = await contacts.addContact(me(req), me(req), input);
  await logActivity(me(req), 'CONTACT_ADDED', req, { contactId: row.id, kind: row.kind });
  res.status(201).json({ success: true, data: await viewOf(row) });
}

export async function addUserContact(req: Request, res: Response): Promise<void> {
  const input = parse(addContactSchema, req.body);
  if (!input.reason) throw new ApiError(400, 'VALIDATION_ERROR', 'Say why this contact is being added.');
  const userId = target(req);
  const row = await contacts.addContact(userId, me(req), input);
  await logActivity(userId, 'USER_CONTACT_ADDED', {
    req,
    module: 'users',
    targetType: 'UserContact',
    targetId: row.id,
    diff: auditDiff(null, { kind: row.kind, value: row.value, label: row.label }),
    metadata: { addedBy: me(req), reason: input.reason, userId },
  });
  res.status(201).json({ success: true, data: await viewOf(row) });
}

/* ── label ──────────────────────────────────────────────────────── */

export async function updateMyContact(req: Request, res: Response): Promise<void> {
  const { label } = parse(updateContactSchema, req.body);
  const row = await contacts.updateContactLabel(me(req), contactId(req), label);
  res.json({ success: true, data: await viewOf(row) });
}

export async function updateUserContact(req: Request, res: Response): Promise<void> {
  const { label } = parse(updateContactSchema, req.body);
  const userId = target(req);
  const row = await contacts.updateContactLabel(userId, contactId(req), label);
  await logActivity(userId, 'USER_CONTACT_UPDATED', {
    req,
    module: 'users',
    targetType: 'UserContact',
    targetId: row.id,
    metadata: { updatedBy: me(req), label: row.label, userId },
  });
  res.json({ success: true, data: await viewOf(row) });
}

/* ── remove ─────────────────────────────────────────────────────── */

export async function removeMyContact(req: Request, res: Response): Promise<void> {
  const row = await contacts.removeContact(me(req), contactId(req));
  await logActivity(me(req), 'CONTACT_REMOVED', req, { contactId: row.id, kind: row.kind });
  res.json({ success: true, data: { message: 'Contact removed' } });
}

export async function removeUserContact(req: Request, res: Response): Promise<void> {
  const { reason } = parse(contactReasonSchema, req.body);
  const userId = target(req);
  const row = await contacts.removeContact(userId, contactId(req));
  await logActivity(userId, 'USER_CONTACT_REMOVED', {
    req,
    module: 'users',
    targetType: 'UserContact',
    targetId: row.id,
    diff: auditDiff({ kind: row.kind, value: row.value, label: row.label, verifiedAt: row.verifiedAt }, null),
    metadata: { removedBy: me(req), reason, userId },
  });
  res.json({ success: true, data: { message: 'Contact removed' } });
}

/* ── the code ───────────────────────────────────────────────────── */

export async function sendMyContactCode(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await contacts.sendContactCode(me(req), contactId(req)) });
}

export async function sendUserContactCode(req: Request, res: Response): Promise<void> {
  const userId = target(req);
  const result = await contacts.sendContactCode(userId, contactId(req));
  await logActivity(userId, 'USER_CONTACT_CODE_SENT', {
    req,
    module: 'users',
    targetType: 'UserContact',
    targetId: contactId(req),
    metadata: { sentBy: me(req), kind: result.kind, userId },
  });
  // The desk never sees the code, whatever the environment.
  const { devOtp: _devOtp, ...safe } = result;
  res.json({ success: true, data: safe });
}

export async function verifyMyContact(req: Request, res: Response): Promise<void> {
  const { code } = parse(verifyContactSchema, req.body);
  const row = await contacts.verifyContact(me(req), contactId(req), code);
  await logActivity(me(req), 'CONTACT_VERIFIED', req, { contactId: row.id, kind: row.kind });
  res.json({ success: true, data: await viewOf(row) });
}

export async function verifyUserContact(req: Request, res: Response): Promise<void> {
  const { code } = parse(verifyContactSchema, req.body);
  const userId = target(req);
  const row = await contacts.verifyContact(userId, contactId(req), code);
  await logActivity(userId, 'USER_CONTACT_VERIFIED', {
    req,
    module: 'users',
    targetType: 'UserContact',
    targetId: row.id,
    metadata: { verifiedBy: me(req), kind: row.kind, how: 'CODE', userId },
  });
  res.json({ success: true, data: await viewOf(row) });
}

/** The desk's word — no code was typed here; the person read it back on a call. */
export async function markUserContactVerified(req: Request, res: Response): Promise<void> {
  const { reason } = parse(contactReasonSchema, req.body);
  const userId = target(req);
  const row = await contacts.markContactVerified(userId, contactId(req));
  await logActivity(userId, 'USER_CONTACT_MARKED_VERIFIED', {
    req,
    module: 'users',
    targetType: 'UserContact',
    targetId: row.id,
    diff: auditDiff({ verifiedAt: null }, { verifiedAt: row.verifiedAt }, ['verifiedAt']),
    metadata: { markedBy: me(req), reason, kind: row.kind, how: 'READ_BACK', userId },
  });
  res.json({ success: true, data: await viewOf(row) });
}

/* ── make primary ───────────────────────────────────────────────── */

export async function makeMyContactPrimary(req: Request, res: Response): Promise<void> {
  const userId = me(req);
  const change = await contacts.makePrimary(userId, userId, contactId(req), {
    allowUnverified: false,
    action: 'PRIMARY_CONTACT_CHANGED',
  });
  res.json({ success: true, data: primaryPayload(change) });
}

export async function makeUserContactPrimary(req: Request, res: Response): Promise<void> {
  const { reason } = parse(contactReasonSchema, req.body);
  const userId = target(req);
  // Lot K2 (Lot K verifier): the desk's power to promote an unverified
  // contact is for other people's accounts. An admin proves their own
  // contact like everyone else, from their own settings.
  if (userId === me(req)) {
    throw new ApiError(403, 'USE_YOUR_OWN_SETTINGS', 'Change your own primary from your own settings, with a verified contact.');
  }
  const change = await contacts.makePrimary(userId, me(req), contactId(req), {
    allowUnverified: true,
    action: 'USER_PRIMARY_CHANGED',
    metadata: { reason },
  });
  res.json({ success: true, data: primaryPayload(change) });
}

function primaryPayload(change: contacts.PrimaryChange) {
  return {
    kind: change.kind,
    before: change.before,
    after: change.after,
    wasVerified: change.wasVerified,
    primary: { mobile: change.user.mobile, email: change.user.email },
    // A phone promotion ends every session the account held (K-B1 reuses the
    // two-code change's post-swap work); an email one ends none.
    sessionsRevoked: change.kind === 'PHONE',
  };
}
