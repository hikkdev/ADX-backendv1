/**
 * Creates (or updates) a user that can sign in through the admin UI's
 * password login. The seed fixtures deliberately leave passwordHash null —
 * they exist for OTP flows — so a fresh database has no password-login
 * account until this runs.
 *
 * Usage:
 *   npx tsx src/scripts/createUser.ts <email> <password> [mobile] [role] [name]
 *
 * Re-running with the same email resets that account's password rather than
 * failing, so it doubles as a "I forgot the dev password" reset.
 */
import '../config/loadEnv';
import { prisma } from '../lib/prisma';
import { hashPassword } from '../services/password.service';
import type { Role } from '../generated/prisma';

async function main(): Promise<void> {
  const [email, password, mobile, role, name] = process.argv.slice(2);

  if (!email || !password) {
    console.error('Usage: npx tsx src/scripts/createUser.ts <email> <password> [mobile] [role] [name]');
    process.exit(1);
  }

  const resolvedRole = (role ?? 'ADMIN') as Role;
  const resolvedMobile = mobile ?? `+9199${Date.now().toString().slice(-8)}`;
  const passwordHash = await hashPassword(password);

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, isActive: true },
    create: {
      email,
      passwordHash,
      mobile: resolvedMobile,
      name: name ?? 'Admin User',
      isActive: true,
    },
    include: { roles: true },
  });

  // Roles live in a separate table, so an upsert on User alone can leave an
  // existing account without the role it needs to see the admin screens.
  if (!user.roles.some((r) => r.role === resolvedRole)) {
    await prisma.userRole.create({ data: { userId: user.id, role: resolvedRole } });
  }

  const roles = await prisma.userRole.findMany({ where: { userId: user.id } });

  console.log('\nLogin user ready');
  console.log('  id      :', user.id);
  console.log('  email   :', user.email);
  console.log('  password:', password);
  console.log('  mobile  :', user.mobile);
  console.log('  roles   :', roles.map((r) => r.role).join(', '));
  console.log('  active  :', user.isActive);
}

main()
  .catch((err) => {
    console.error('Failed to create user:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
