import { prisma, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { Role } from './enums.js';
import { hashPassword } from './utils/password.js';

/**
 * Creates the first SUPER_ADMIN so the API can be used at all. Idempotent, so it is safe to
 * re-run after a migration. Credentials come from the environment - never hardcode them.
 */
async function seed(): Promise<void> {
  const email = env.SEED_ADMIN_EMAIL;
  const password = env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD before running the seed');
  }

  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    // An existing admin keeps its password; only the role and active flag are re-asserted.
    update: { role: Role.SUPER_ADMIN, isActive: true },
    create: {
      email: email.toLowerCase(),
      passwordHash: await hashPassword(password),
      role: Role.SUPER_ADMIN,
    },
  });

  console.log(`Seeded SUPER_ADMIN: ${user.email}`);
}

try {
  await seed();
} finally {
  await disconnectDatabase();
}
