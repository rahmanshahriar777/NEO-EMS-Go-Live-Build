#!/usr/bin/env ts-node
/**
 * B2 — create the first verified SUPER_ADMIN (invite-only bootstrap).
 *
 * With public registration closed (ALLOW_PUBLIC_REGISTRATION=false), the very
 * first account cannot come from an invitation. Run this script once against
 * a fresh database:
 *
 *   ADMIN_EMAIL=admin@ems.local ADMIN_PASSWORD='<12+ chars>' \
 *     pnpm --filter @ems/api exec ts-node --transpile-only ../../scripts/create-first-admin.ts
 *
 * Behaviour:
 *  - Fails loudly when ADMIN_EMAIL / ADMIN_PASSWORD are missing, when the
 *    password is shorter than 12 characters, or when a SUPER_ADMIN already
 *    exists (idempotent: re-running with the same email is a no-op).
 *  - Creates the user with emailVerified=true (a human operator ran this —
 *    no email round-trip needed), assigns SUPER_ADMIN, and scaffolds the
 *    employee profile.
 *  - The password is hashed with Argon2id (same parameters as
 *    PasswordService) and is NEVER printed or logged.
 *
 * Runtime deps (argon2, @prisma/client, dotenv) are resolved from the
 * @ems/api workspace package so the script works regardless of the cwd it is
 * invoked from.
 */
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createRequire } = require('module');
const apiRequire = createRequire(path.join(__dirname, '..', 'apps', 'api', 'package.json'));
const argon2 = apiRequire('argon2');
const dotenv = apiRequire('dotenv');
const { PrismaClient } = apiRequire('@prisma/client');
// v6 fix #2 — employee numbers come from the shared sequence helper, the
// same path as employees.service and recruitment offer-accept.
const { nextEmployeeNumber } = apiRequire('@ems/shared');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'apps', 'api', '.env') });

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_FIRST_NAME = process.env.ADMIN_FIRST_NAME || 'System';
const ADMIN_LAST_NAME = process.env.ADMIN_LAST_NAME || 'Administrator';

function fail(message: string): never {
  // eslint-disable-next-line no-console
  console.error(`[create-first-admin] ERROR: ${message}`);
  process.exit(1);
}

async function main() {
  if (!ADMIN_EMAIL || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ADMIN_EMAIL)) {
    fail('Set a valid ADMIN_EMAIL environment variable.');
  }
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    fail('Set ADMIN_PASSWORD to at least 12 characters (never commit it anywhere).');
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
    if (existing) {
      // eslint-disable-next-line no-console
      console.log(`[create-first-admin] User ${ADMIN_EMAIL} already exists — nothing to do.`);
      return;
    }

    const superAdminRole = await prisma.role.findUnique({ where: { name: 'SUPER_ADMIN' } });
    if (!superAdminRole) {
      fail('SUPER_ADMIN role not found — run the database seed/migrations first.');
    }

    const existingAdmin = await prisma.userRole.findFirst({
      where: { roleId: superAdminRole.id },
      select: { userId: true },
    });
    if (existingAdmin) {
      fail('A SUPER_ADMIN already exists. Refusing to create another via bootstrap.');
    }

    const passwordHash: string = await argon2.hash(ADMIN_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 2 ** 14,
      timeCost: 2,
      parallelism: 1,
    });

    const user = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash,
        isActive: true,
        emailVerified: true,
        roles: { create: [{ roleId: superAdminRole.id }] },
      },
    });

    // v6 fix #2 — the admin's employee number comes from the
    // employee_number_seq Postgres sequence via the shared helper (same as
    // employees.service and recruitment offer-accept). The old count()+1
    // scheme collides with seeded (EMP-YYYY-0001..0020) and app-created
    // numbers, and races under concurrency. nextEmployeeNumber throws
    // (never fabricates) when the sequence migration has not been applied.
    const employeeNumber = await nextEmployeeNumber((sql: string) =>
      prisma.$queryRawUnsafe(sql),
    );
    await prisma.employee.create({
      data: {
        employeeNumber,
        userId: user.id,
        firstName: ADMIN_FIRST_NAME,
        lastName: ADMIN_LAST_NAME,
        email: ADMIN_EMAIL,
      },
    });

    // eslint-disable-next-line no-console
    console.log(
      `[create-first-admin] Created verified SUPER_ADMIN ${ADMIN_EMAIL} (id=${user.id}). ` +
        'You can now sign in and issue HR invitations.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => fail(e?.message || String(e)));
