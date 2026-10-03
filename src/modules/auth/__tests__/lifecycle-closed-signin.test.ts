import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026): closed means closed. Every auth path that
 * used to read `User.isActive` alone now reads the shared working-user check
 * (`isActive` AND `closedAt` null), with the same 401 "Account not active" a
 * deactivated account gets. The paths with their own behavioural tests
 * (Google, Facebook, the 2FA challenge) pin the answer; this pins that no
 * path is left reading the switch alone, so a new one cannot slip back.
 */

const AUTH = path.join(__dirname, '..');
const PATHS = [
  'auth.session.ts',
  'facebook/facebook.controller.ts',
  'google/google.controller.ts',
  'otp/otp.controller.ts',
  'password/password.controller.ts',
  'publisher/publisher-auth.controller.ts',
  'tokens/tokens.controller.ts',
  'two-factor/authenticator.service.ts',
  'two-factor/two-factor.controller.ts',
  'two-factor/two-factor.service.ts',
];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('every sign-in path refuses a closed account', () => {
  it.each(PATHS)('%s reads the working-user check', (file) => {
    const text = fs.readFileSync(path.join(AUTH, file), 'utf8');
    expect(text).toContain("from '");
    expect(text).toMatch(/import \{ isWorkingUser \} from '(\.\.\/)+shared\/party-status';/);
    expect(text).toMatch(/!isWorkingUser\(user\)/);
  });

  it('no auth source reads `user.isActive` on its own any more', () => {
    for (const file of sources(AUTH)) {
      expect(fs.readFileSync(file, 'utf8'), file).not.toMatch(/!user\.isActive\b/);
    }
  });
});
