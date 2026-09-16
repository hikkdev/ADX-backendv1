import { z } from 'zod';
import { upperEnum } from '../../shared/validation';

export const ASSIGNABLE_ROLES = [
  'AGENT_PUBLISHER',
  'AGENT_ADVERTISER',
  'PUBLISHER',
  'ADVERTISER',
  'PARTNER',
  'ADMIN',
] as const;

const mobileNumber = z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid mobile number');

export const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  language: z.string().optional(),
  avatarUrl: z.string().url().optional(),
});

export const updateUserByAdminSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  mobile: mobileNumber.optional(),
  isActive: z.boolean().optional(),
  /** K-B1: the two profile fields the person can set on /me, editable from the desk too. */
  language: z.string().trim().min(2).max(10).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  /**
   * Why, when the edit moves an identity somebody signs in with.
   *
   * Required when `mobile` (Lot A) or `email` (K-B1) actually changes — the
   * desk moving a person's number or address is the highest-trust edit in
   * the console: it moves the sign-in identity and the code destination in
   * one write, and the reason is the field a later investigation cannot
   * reconstruct. The service enforces "changes" against the row, so saving an
   * unchanged form never demands one. Ignored on every other field.
   */
  reason: z.string().trim().min(10).max(500).optional(),
  /**
   * M-B: the admin editor's roles patch — the whole list the account should
   * hold afterwards, never a delta. Adding ADMIN turns the second factor
   * on; dropping it clears the console role; either ends the sessions,
   * because the roles are in the token. The last active super admin cannot
   * lose ADMIN this way (409 `LAST_SUPER_ADMIN`, `access-control`'s rule).
   */
  roles: z.array(upperEnum(ASSIGNABLE_ROLES)).min(1, 'At least one role is required').optional(),
});

/**
 * POST /users — the desk creating a person: mobile + name, optional email,
 * at least one role. K-B1: `roleConfigId` names the console role to give an
 * ADMIN in the same breath (the `PUT /users/:id/role-config` rules apply —
 * the target must hold ADMIN, the super-admin role takes a super admin).
 */
export const createUserSchema = z.object({
  mobile: mobileNumber,
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  roles: z.array(upperEnum(ASSIGNABLE_ROLES)).min(1, 'At least one role is required'),
  roleConfigId: z.string().min(1).optional(),
});

export const bootstrapAdminSchema = z.object({ userId: z.string().min(1) });

/**
 * POST /users/me/party — the first question after the first OTP.
 *
 * `party` is which side of the marketplace the account is on; `accountType`
 * is DR 08's Step 1 (Individual / Business Entity / Organisation), which each
 * side keeps in its own legal-form column. The name is optional because the
 * frames ask for it two steps later.
 */
export const PARTIES = ['PUBLISHER', 'ADVERTISER'] as const;
export const ACCOUNT_TYPES = ['INDIVIDUAL', 'BUSINESS', 'ORGANISATION'] as const;

export const choosePartySchema = z.object({
  party: upperEnum(PARTIES),
  accountType: upperEnum(ACCOUNT_TYPES),
  name: z.string().trim().min(1).max(120).optional(),
});

export type Party = (typeof PARTIES)[number];
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type ChoosePartyInput = z.infer<typeof choosePartySchema>;

export const assignRoleSchema = z.object({
  userId: z.string().min(1),
  role: upperEnum(ASSIGNABLE_ROLES),
});

/**
 * GET /users?closed=true|false — Lot A (Q21).
 *
 * Three states, not two: omitted means "everybody", which is what the console
 * has always shown and what the existing callers expect. A closed account is
 * never removed from the table, so without this facet the list slowly fills
 * with rows nobody can act on.
 */
export const USER_STATES = ['ACTIVE', 'INACTIVE', 'CLOSED'] as const;
export type UserState = (typeof USER_STATES)[number];
export const USER_SORTS = ['newest', 'oldest', 'name', 'lastLogin'] as const;
export type UserSort = (typeof USER_SORTS)[number];

export const adminUsersQuerySchema = z.object({
  closed: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  /** E6: name, email or mobile contains; K-B1: any contact's value too. And one role. */
  q: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['ADMIN', 'AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'PUBLISHER', 'ADVERTISER', 'PARTNER']).optional(),
  /**
   * K-B1: the three states the directory's chips draw. CLOSED is
   * `closedAt` set; INACTIVE is `isActive: false` on an open account;
   * ACTIVE is the rest. Beside `closed`, which the console still sends.
   */
  state: z.enum(USER_STATES).optional(),
  sort: z.enum(USER_SORTS).default('newest'),
});

/* ── K-B1: contacts ─────────────────────────────────────────────── */

export const CONTACT_KINDS = ['EMAIL', 'PHONE'] as const;

/** Why — the desk's every identity write carries one. */
const reason = z.string().trim().min(10).max(500);
export const contactReasonSchema = z.object({ reason });
export type ContactReasonInput = z.infer<typeof contactReasonSchema>;

/**
 * `{ kind, value, label? }` — the person's own add; the desk's carries
 * `reason`. The value is validated by kind here and normalised in the
 * service (lower-cased email, E.164 number).
 */
export const addContactSchema = z
  .object({
    kind: upperEnum(CONTACT_KINDS),
    value: z.string().trim().min(3).max(254),
    label: z.string().trim().min(1).max(60).optional(),
    reason: reason.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.kind === 'EMAIL' && !z.string().email().safeParse(input.value).success) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Invalid email address' });
    }
    if (input.kind === 'PHONE' && !mobileNumber.safeParse(input.value).success) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Invalid mobile number' });
    }
  });
export type AddContactInput = z.infer<typeof addContactSchema>;

export const updateContactSchema = z.object({ label: z.string().trim().max(60).nullable() });
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

export const verifyContactSchema = z.object({ code: z.string().trim().min(4).max(12) });

export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type UpdateUserByAdminInput = z.infer<typeof updateUserByAdminSchema>;
