import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import configuration from './config/configuration';

// Core Modules
import { PrismaModule } from './core/prisma/prisma.module';
import { AccessPolicyModule } from './core/access-policy/access-policy.module';
import { RedisModule } from './core/redis/redis.module';
import { RedisService } from './core/redis/redis.service';
import { QueuesModule } from './core/queues/queues.module';
import { HealthModule } from './core/health/health.module';
import { MetricsModule } from './core/metrics/metrics.module';
import { AuditModule } from './core/audit/audit.module';

// Common Filters, Guards & Email
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { AppThrottlerGuard } from './common/guards/throttler.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { CsrfGuard } from './common/guards/csrf.guard';
import { RedisThrottlerStorage } from './common/throttle/redis-throttler.storage';
import { EmailModule } from './common/email/email.module';

// Feature Modules
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { MfaModule } from './modules/mfa/mfa.module';
import { RolesModule } from './modules/roles/roles.module';
import { DepartmentsModule } from './modules/departments/departments.module';
import { DesignationsModule } from './modules/designations/designations.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { LeavesModule } from './modules/leaves/leaves.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { PerformanceModule } from './modules/performance/performance.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AiModule } from './modules/ai/ai.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ReportsModule } from './modules/reports/reports.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { PayrollStatutoryModule } from './modules/payroll-statutory/payroll-statutory.module';
import { GdprModule } from './modules/gdpr/gdpr.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { RosteringModule } from './modules/rostering/rostering.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { RecruitmentModule } from './modules/recruitment/recruitment.module';
import { AiAssistantModule } from './modules/ai-assistant/ai-assistant.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env', '../.env'],
      load: [configuration],
    }),

    // Rate Limiting (B8)
    // A single global 'default' bucket (100 req / 60 s, configurable).
    // Sensitive routes tighten it per-route via
    //   @Throttle({ default: { limit: 5, ttl: 60_000 } })
    // NOTE: @nestjs/throttler v6 applies EVERY named throttler to EVERY route
    // by default, so separate named buckets ('auth', 'strict', ...) would
    // throttle the whole API to the strictest bucket. Per-route overrides of
    // the default bucket are the safe pattern here.
    //
    // Counters live in Redis (RedisThrottlerStorage) so the budget is shared
    // across API replicas instead of per-process. Keys are userId:ip for
    // authenticated requests (AppThrottlerGuard) and ip for anonymous ones.
    // When Redis is down the storage fails OPEN (allows the request) — rate
    // limiting is a DoS control, not an auth boundary.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService, RedisService],
      useFactory: (config: ConfigService, redis: RedisService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('throttle.ttl', 60) * 1000,
            limit: config.get<number>('throttle.limit', 100),
          },
        ],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),

    // Core
    PrismaModule,
    RedisModule,
    // QueuesModule is @Global() but must still be imported once for its
    // providers (QueueService) to exist. It was previously orphaned — nothing
    // could inject QueueService, which the auth verification-email wiring
    // (and any future producer) depends on.
    QueuesModule,
    HealthModule,
    MetricsModule,
    AuditModule,
    EmailModule,

    // Feature Modules
    AuthModule,
    AdminModule,
    // Global access-policy module (self / direct-reports / HR authorization).
    AccessPolicyModule,
    InvitationsModule,
    MfaModule,
    RolesModule,
    DepartmentsModule,
    DesignationsModule,
    EmployeesModule,
    AttendanceModule,
    LeavesModule,
    PayrollModule,
    PerformanceModule,
    DocumentsModule,
    NotificationsModule,
    AiModule,
    GdprModule,
    CalendarModule,
    RosteringModule,
    // Phase 3: onboarding/offboarding, recruitment pipeline, grounded AI assistant.
    OnboardingModule,
    RecruitmentModule,
    AiAssistantModule,
    DashboardModule,
    ReportsModule,
    IntegrationsModule,
    PayrollStatutoryModule,
  ],
  providers: [
    // B1 — authentication-first guard chain, evaluated in registration order:
    //   1. JwtAuthGuard      — establishes req.user (or 401); @Public() bypasses.
    //   2. AppThrottlerGuard — rate limits AFTER auth so tracker keys can be
    //                          userId:ip for authenticated requests (B8).
    //                          Trade-off: unauthenticated floods reach the JWT
    //                          parse first; the strict per-route @Throttle
    //                          overrides on auth endpoints stay IP-keyed.
    //   3. RolesGuard        — @Roles() checks (SUPER_ADMIN bypasses).
    //   4. PermissionsGuard  — @Permissions() checks (SUPER_ADMIN bypasses).
    //   5. CsrfGuard         — Origin/Referer + double-submit CSRF token for
    //                          cookie-authenticated mutations (item 8).
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AppThrottlerGuard,
    },
    // F21: PBAC activation. RolesGuard passes through when no @Roles()
    // metadata is present, and PermissionsGuard passes through when no
    // @Permissions() metadata is present, so registering both globally is
    // behaviour-preserving for existing routes. Order matters: role checks
    // run before the finer-grained permission checks.
    // NOTE (decision): @Permissions() metadata is intentionally NOT attached
    // to any route yet. The seed mints the 60-entry permission matrix but
    // assigns zero permissions to any role, so attaching metadata now would
    // fail-closed in the wrong direction and lock every non-SUPER_ADMIN user
    // out (only the SUPER_ADMIN bypass would pass). Once role → permission
    // grants are seeded, attach e.g. @Permissions('AUDIT_LOG:READ') to
    // GET /ai/logs and @Permissions('AI:GENERATE') to POST /ai/generate.
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    {
      provide: APP_GUARD,
      useClass: CsrfGuard,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
