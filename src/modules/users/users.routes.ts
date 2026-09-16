import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import {
  getMe,
  updateMe,
  assignRole,
  bootstrapAdmin,
  createUser,
  getAllUsers,
  deleteUser,
  updateUserByAdmin,
  getMyPreferences,
  saveMyPreferences,
  resubscribeMyEmail,
  listMySessions,
  revokeMySession,
  revokeMyOtherSessions,
  listMyActivity,
  listUserSessions,
  listUserActivity,
  sendResetLink,
  chooseParty,
  onboardingManifest,
  getUserById,
  setRoleConfig,
  resetTwoFactorFallback,
  inviteUser,
  listUserInvites,
  resendUserInvite,
  revokeUserInvite,
} from './users.controller';
import {
  startImpersonationHandler,
  endImpersonationHandler,
  listImpersonationsHandler,
} from './impersonation/impersonation.controller';
import * as contacts from './users-contacts.controller';

export const userRouter = Router();

// Bootstrap: no auth required — only works when zero admins exist. It must be
// registered before the authenticate() layer below.
userRouter.post('/bootstrap-admin', asyncHandler(bootstrapAdmin));

userRouter.use(authenticate);

userRouter.get('/me', asyncHandler(getMe));
userRouter.patch('/me', asyncHandler(updateMe));
userRouter.post('/me/party', asyncHandler(chooseParty));
userRouter.get('/me/onboarding-manifest', asyncHandler(onboardingManifest));
userRouter.get('/me/preferences', asyncHandler(getMyPreferences));
userRouter.put('/me/preferences', asyncHandler(saveMyPreferences));
/* E11-1: the person's own undo of the public unsubscribe link. */
userRouter.post('/me/email-resubscribe', asyncHandler(resubscribeMyEmail));
userRouter.get('/me/sessions', asyncHandler(listMySessions));
/* E6: sign out every other device in one call, keeping this one. */
userRouter.delete('/me/sessions', asyncHandler(revokeMyOtherSessions));
userRouter.delete('/me/sessions/:id', asyncHandler(revokeMySession));
userRouter.get('/me/activity', asyncHandler(listMyActivity));

/* K-B1: the person's own contacts beside the primary pair. A contact starts
 * unverified, is proved with a code, and only a verified one may become the
 * primary from here. */
userRouter.get('/me/contacts', asyncHandler(contacts.listMyContacts));
userRouter.post('/me/contacts', asyncHandler(contacts.addMyContact));
userRouter.patch('/me/contacts/:contactId', asyncHandler(contacts.updateMyContact));
userRouter.delete('/me/contacts/:contactId', asyncHandler(contacts.removeMyContact));
userRouter.post('/me/contacts/:contactId/send-code', asyncHandler(contacts.sendMyContactCode));
userRouter.post('/me/contacts/:contactId/verify', asyncHandler(contacts.verifyMyContact));
userRouter.post('/me/contacts/:contactId/make-primary', asyncHandler(contacts.makeMyContactPrimary));

// Admin only
userRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllUsers));
userRouter.post('/', requireRole('ADMIN'), asyncHandler(createUser));
userRouter.post('/roles', requireRole('ADMIN'), asyncHandler(assignRole));

/* Invitations to the console (Lot A, Q26). The flow lives in `auth`, which
 * owns credentials and the anonymous half at /auth/accept-invite; these are
 * the console's end of it, mounted where an admin looks for them. Registered
 * before '/:id' so "invites" is never read as a user id. */
userRouter.post('/invites', requireRole('ADMIN'), asyncHandler(inviteUser));
userRouter.get('/invites', requireRole('ADMIN'), asyncHandler(listUserInvites));
userRouter.post('/invites/:id/resend', requireRole('ADMIN'), asyncHandler(resendUserInvite));
userRouter.delete('/invites/:id', requireRole('ADMIN'), asyncHandler(revokeUserInvite));

/* Read-only impersonation (Lot A, Q27). Before '/:id' for the same reason.
 * `system.impersonate` is the permission behind it; the launch rule gives it
 * to an admin with no role config, so this is not a lockout. */
userRouter.get('/impersonations', requireRole('ADMIN'), asyncHandler(listImpersonationsHandler));
userRouter.post('/impersonations/:id/end', requireRole('ADMIN'), asyncHandler(endImpersonationHandler));

userRouter.get('/:id', requireRole('ADMIN'), asyncHandler(getUserById));
userRouter.patch('/:id', requireRole('ADMIN'), asyncHandler(updateUserByAdmin));
userRouter.delete('/:id', requireRole('ADMIN'), asyncHandler(deleteUser));
userRouter.put('/:id/role-config', requireRole('ADMIN'), asyncHandler(setRoleConfig));
userRouter.post('/:id/2fa/reset', requireRole('ADMIN'), asyncHandler(resetTwoFactorFallback));
/* E6: the desk's view of one account's sessions and activity, and the reset link. */
userRouter.get('/:id/sessions', requireRole('ADMIN'), asyncHandler(listUserSessions));
userRouter.get('/:id/activity', requireRole('ADMIN'), asyncHandler(listUserActivity));
userRouter.post('/:id/reset-password', requireRole('ADMIN'), asyncHandler(sendResetLink));
/* K-B1: the desk on somebody's contacts — every write with a reason, audited. */
userRouter.get('/:id/contacts', requireRole('ADMIN'), asyncHandler(contacts.listUserContacts));
userRouter.post('/:id/contacts', requireRole('ADMIN'), asyncHandler(contacts.addUserContact));
userRouter.patch('/:id/contacts/:contactId', requireRole('ADMIN'), asyncHandler(contacts.updateUserContact));
userRouter.delete('/:id/contacts/:contactId', requireRole('ADMIN'), asyncHandler(contacts.removeUserContact));
userRouter.post('/:id/contacts/:contactId/send-code', requireRole('ADMIN'), asyncHandler(contacts.sendUserContactCode));
userRouter.post('/:id/contacts/:contactId/verify', requireRole('ADMIN'), asyncHandler(contacts.verifyUserContact));
userRouter.post('/:id/contacts/:contactId/mark-verified', requireRole('ADMIN'), asyncHandler(contacts.markUserContactVerified));
userRouter.post('/:id/contacts/:contactId/make-primary', requireRole('ADMIN'), asyncHandler(contacts.makeUserContactPrimary));
userRouter.post(
  '/:id/impersonate',
  requireRole('ADMIN'),
  requirePermission('system.impersonate'),
  asyncHandler(startImpersonationHandler),
);
