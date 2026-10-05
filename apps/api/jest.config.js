/**
 * Jest configuration for @ems/api.
 *
 * Coverage policy (review §5.5 / Phase 2-3 acceptance criteria):
 * - Release-critical modules touched by the production-ready release
 *   (auth, payroll, leaves, guards) carry a 70% statements/lines gate below.
 * - The GLOBAL gate is intentionally lower: many modules (employees,
 *   departments, documents, notifications, dashboard, AI, …) still have no
 *   specs, so a global 70% gate is ASPIRATIONAL — it cannot plausibly be met
 *   until every module has unit tests. Raise the global thresholds to 70%
 *   when module coverage is complete and enforce it in CI (review §5.5).
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  testEnvironment: 'node',

  // Coverage is collected on demand via `pnpm test:cov` (jest --coverage).
  coverageDirectory: '../coverage',
  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.spec.ts',
    '!**/main.ts', // bootstrap only; covered by e2e instead
  ],
  coverageReporters: ['text', 'lcov', 'html'],

  coverageThreshold: {
    // Ratchet (2026-10-05, go-live hardening, worker 5): jest's TRUE global
    // coverage (the number the threshold check enforces — NOT the "All
    // files" row, which is an unweighted mean of file percentages) is
    // 66.88% statements / ~44-48% branches / 64.25% functions / 68.06% lines,
    // measured with 88 suites / 706 tests. That is up from 55.01% / 42.88% /
    // 52.08% / 55.92% at the start of the go-live branch (other workers'
    // feature work had added uncovered source faster than tests).
    //
    // New contributors since the last ratchet: worker processor unit specs
    // (notification/maintenance/attendance/email — mocked Prisma, plus a real
    // fake-SMTP wire test for the email channel), refresh-token
    // double-rotation race, recovery-code double-spend race, invitation
    // single-use race, Phase 2 item 4 payroll golden vectors (proration +
    // unpaid-leave), 17 controller wiring specs, departments/designations
    // service specs, auth-cookies contract spec, configuration.ts
    // pure-function specs.
    //
    // Floors are set just under the measured true values. NOTE: the tree is
    // shared with 5 other workers landing feature code concurrently, so the
    // denominator moves between runs — re-measure before release. The 70%
    // target (review §5.5) is NOT yet stably met: reaching it needs
    // service-level specs for the branchiest uncovered modules
    // (documents.service ~220 stmts, attendance.service ~156,
    // employees.service ~111, ai-orchestrator ~84, performance.service ~64).
    // The per-module 70% gates below continue to hold the release-critical
    // files (auth, payroll, leaves, guards).
    //
    global: {
      statements: 66,
      branches: 44,
      functions: 64,
      lines: 68,
    },
    // 70% statements/lines gate for the release-critical modules covered
    // by the production-ready test suite.
    '**/modules/auth/auth.service.ts': { statements: 70, lines: 70 },
    '**/modules/auth/token.service.ts': { statements: 70, lines: 70 },
    '**/modules/auth/password.service.ts': { statements: 70, lines: 70 },
    '**/modules/payroll/payroll.service.ts': { statements: 70, lines: 70 },
    '**/modules/leaves/leaves.service.ts': { statements: 70, lines: 70 },
    '**/modules/leaves/holidays.ts': { statements: 70, lines: 70 },
    '**/common/guards/jwt-auth.guard.ts': { statements: 70, lines: 70 },
    '**/common/guards/roles.guard.ts': { statements: 70, lines: 70 },
    '**/common/guards/permissions.guard.ts': { statements: 70, lines: 70 },
  },
};
