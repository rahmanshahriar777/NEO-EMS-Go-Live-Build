// ---------------------------------------------------------------------------
// Prisma parity guards (Phase 1 refactoring: "one enum set").
//
// Why not `export { X } from '@prisma/client'` directly?
// The web app imports these enums in client components (sidebar, auth
// context, …). A RUNTIME import of '@prisma/client' would drag the Prisma
// query-engine runtime into the browser bundle and break `next build`.
// So this file stays the single runtime source of truth, while the
// TYPE-ONLY imports below (erased at compile time — zero bundle impact)
// assert every shared enum is value-identical to the Prisma-generated one.
// If the schema adds/renames a member, `tsc` fails on the parity map first.
//
// PermissionAction / PermissionSubject have no Prisma counterpart (they back
// the permissions table rows, not a schema enum) and are intentionally
// shared-only.
// ---------------------------------------------------------------------------
import type {
  SystemRole as PrismaSystemRole,
  EmploymentStatus as PrismaEmploymentStatus,
  Gender as PrismaGender,
  AttendanceStatus as PrismaAttendanceStatus,
  LeaveStatus as PrismaLeaveStatus,
  LeaveTypeEnum as PrismaLeaveTypeEnum,
  PayrollStatus as PrismaPayrollStatus,
  SalaryComponentType as PrismaSalaryComponentType,
  CalculationType as PrismaCalculationType,
  ReviewStatus as PrismaReviewStatus,
  GoalStatus as PrismaGoalStatus,
  FeedbackType as PrismaFeedbackType,
  AuditAction as PrismaAuditAction,
  ErasureStatus as PrismaErasureStatus,
} from '@prisma/client';

export enum SystemRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  HR_ADMIN = 'HR_ADMIN',
  MANAGER = 'MANAGER',
  EMPLOYEE = 'EMPLOYEE',
  AUDITOR = 'AUDITOR',
}

export enum PermissionAction {
  CREATE = 'CREATE',
  READ = 'READ',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  MANAGE = 'MANAGE',
  APPROVE = 'APPROVE',
}

export enum PermissionSubject {
  USER = 'USER',
  EMPLOYEE = 'EMPLOYEE',
  DEPARTMENT = 'DEPARTMENT',
  DESIGNATION = 'DESIGNATION',
  ATTENDANCE = 'ATTENDANCE',
  LEAVE = 'LEAVE',
  PAYROLL = 'PAYROLL',
  PERFORMANCE = 'PERFORMANCE',
  AUDIT_LOG = 'AUDIT_LOG',
  DOCUMENT = 'DOCUMENT',
}

export enum EmploymentStatus {
  FULL_TIME = 'FULL_TIME',
  PART_TIME = 'PART_TIME',
  CONTRACT = 'CONTRACT',
  PROBATION = 'PROBATION',
  INTERN = 'INTERN',
  TERMINATED = 'TERMINATED',
  RESIGNED = 'RESIGNED',
}

export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
  PREFER_NOT_TO_SAY = 'PREFER_NOT_TO_SAY',
}

export enum AttendanceStatus {
  PRESENT = 'PRESENT',
  LATE = 'LATE',
  HALF_DAY = 'HALF_DAY',
  ABSENT = 'ABSENT',
  ON_LEAVE = 'ON_LEAVE',
}

export enum LeaveStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  DRAFT = 'DRAFT',
}

export enum LeaveTypeEnum {
  ANNUAL = 'ANNUAL',
  SICK = 'SICK',
  CASUAL = 'CASUAL',
  MATERNITY = 'MATERNITY',
  PATERNITY = 'PATERNITY',
  UNPAID = 'UNPAID',
  BEREAVEMENT = 'BEREAVEMENT',
}

export enum PayrollStatus {
  DRAFT = 'DRAFT',
  PROCESSING = 'PROCESSING',
  APPROVED = 'APPROVED',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
}

export enum SalaryComponentType {
  EARNING = 'EARNING',
  DEDUCTION = 'DEDUCTION',
}

export enum CalculationType {
  FIXED = 'FIXED',
  PERCENTAGE_OF_BASIC = 'PERCENTAGE_OF_BASIC',
  PERCENTAGE_OF_GROSS = 'PERCENTAGE_OF_GROSS',
}

export enum ReviewStatus {
  DRAFT = 'DRAFT',
  SELF_REVIEW_SUBMITTED = 'SELF_REVIEW_SUBMITTED',
  MANAGER_REVIEW_SUBMITTED = 'MANAGER_REVIEW_SUBMITTED',
  COMPLETED = 'COMPLETED',
  ARCHIVED = 'ARCHIVED',
}

export enum GoalStatus {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  ON_HOLD = 'ON_HOLD',
  CANCELLED = 'CANCELLED',
}

export enum FeedbackType {
  PEER = 'PEER',
  MANAGER = 'MANAGER',
  SUBORDINATE = 'SUBORDINATE',
  GENERAL = 'GENERAL',
}

export enum AuditAction {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  READ = 'READ',
  LOGIN = 'LOGIN',
  LOGOUT = 'LOGOUT',
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  RUN_PAYROLL = 'RUN_PAYROLL',
  INGEST_DOCUMENT = 'INGEST_DOCUMENT',
  DOCUMENT_DOWNLOAD = 'DOCUMENT_DOWNLOAD',
}

export enum ErasureStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

// ---------------------------------------------------------------------------
// Parity maps: each must cover EVERY member of the Prisma enum (Record<…>).
// A schema change that adds/renames/removes a member fails typecheck here.
// Exported (rather than voided) so tests and docs can reference them.
// ---------------------------------------------------------------------------

/** Shared SystemRole ≡ Prisma SystemRole. */
export const SystemRoleParity: Record<PrismaSystemRole, SystemRole> = {
  SUPER_ADMIN: SystemRole.SUPER_ADMIN,
  HR_ADMIN: SystemRole.HR_ADMIN,
  MANAGER: SystemRole.MANAGER,
  EMPLOYEE: SystemRole.EMPLOYEE,
  AUDITOR: SystemRole.AUDITOR,
};

/** Shared EmploymentStatus ≡ Prisma EmploymentStatus. */
export const EmploymentStatusParity: Record<PrismaEmploymentStatus, EmploymentStatus> = {
  FULL_TIME: EmploymentStatus.FULL_TIME,
  PART_TIME: EmploymentStatus.PART_TIME,
  CONTRACT: EmploymentStatus.CONTRACT,
  PROBATION: EmploymentStatus.PROBATION,
  INTERN: EmploymentStatus.INTERN,
  TERMINATED: EmploymentStatus.TERMINATED,
  RESIGNED: EmploymentStatus.RESIGNED,
};

/** Shared Gender ≡ Prisma Gender. */
export const GenderParity: Record<PrismaGender, Gender> = {
  MALE: Gender.MALE,
  FEMALE: Gender.FEMALE,
  OTHER: Gender.OTHER,
  PREFER_NOT_TO_SAY: Gender.PREFER_NOT_TO_SAY,
};

/** Shared AttendanceStatus ≡ Prisma AttendanceStatus. */
export const AttendanceStatusParity: Record<PrismaAttendanceStatus, AttendanceStatus> = {
  PRESENT: AttendanceStatus.PRESENT,
  LATE: AttendanceStatus.LATE,
  HALF_DAY: AttendanceStatus.HALF_DAY,
  ABSENT: AttendanceStatus.ABSENT,
  ON_LEAVE: AttendanceStatus.ON_LEAVE,
};

/** Shared LeaveStatus ≡ Prisma LeaveStatus. */
export const LeaveStatusParity: Record<PrismaLeaveStatus, LeaveStatus> = {
  PENDING: LeaveStatus.PENDING,
  APPROVED: LeaveStatus.APPROVED,
  REJECTED: LeaveStatus.REJECTED,
  CANCELLED: LeaveStatus.CANCELLED,
  DRAFT: LeaveStatus.DRAFT,
};

/** Shared LeaveTypeEnum ≡ Prisma LeaveTypeEnum. */
export const LeaveTypeEnumParity: Record<PrismaLeaveTypeEnum, LeaveTypeEnum> = {
  ANNUAL: LeaveTypeEnum.ANNUAL,
  SICK: LeaveTypeEnum.SICK,
  CASUAL: LeaveTypeEnum.CASUAL,
  MATERNITY: LeaveTypeEnum.MATERNITY,
  PATERNITY: LeaveTypeEnum.PATERNITY,
  UNPAID: LeaveTypeEnum.UNPAID,
  BEREAVEMENT: LeaveTypeEnum.BEREAVEMENT,
};

/** Shared PayrollStatus ≡ Prisma PayrollStatus. */
export const PayrollStatusParity: Record<PrismaPayrollStatus, PayrollStatus> = {
  DRAFT: PayrollStatus.DRAFT,
  PROCESSING: PayrollStatus.PROCESSING,
  APPROVED: PayrollStatus.APPROVED,
  PAID: PayrollStatus.PAID,
  CANCELLED: PayrollStatus.CANCELLED,
};

/** Shared SalaryComponentType ≡ Prisma SalaryComponentType. */
export const SalaryComponentTypeParity: Record<PrismaSalaryComponentType, SalaryComponentType> = {
  EARNING: SalaryComponentType.EARNING,
  DEDUCTION: SalaryComponentType.DEDUCTION,
};

/** Shared CalculationType ≡ Prisma CalculationType. */
export const CalculationTypeParity: Record<PrismaCalculationType, CalculationType> = {
  FIXED: CalculationType.FIXED,
  PERCENTAGE_OF_BASIC: CalculationType.PERCENTAGE_OF_BASIC,
  PERCENTAGE_OF_GROSS: CalculationType.PERCENTAGE_OF_GROSS,
};

/** Shared ReviewStatus ≡ Prisma ReviewStatus. */
export const ReviewStatusParity: Record<PrismaReviewStatus, ReviewStatus> = {
  DRAFT: ReviewStatus.DRAFT,
  SELF_REVIEW_SUBMITTED: ReviewStatus.SELF_REVIEW_SUBMITTED,
  MANAGER_REVIEW_SUBMITTED: ReviewStatus.MANAGER_REVIEW_SUBMITTED,
  COMPLETED: ReviewStatus.COMPLETED,
  ARCHIVED: ReviewStatus.ARCHIVED,
};

/** Shared GoalStatus ≡ Prisma GoalStatus. */
export const GoalStatusParity: Record<PrismaGoalStatus, GoalStatus> = {
  NOT_STARTED: GoalStatus.NOT_STARTED,
  IN_PROGRESS: GoalStatus.IN_PROGRESS,
  COMPLETED: GoalStatus.COMPLETED,
  ON_HOLD: GoalStatus.ON_HOLD,
  CANCELLED: GoalStatus.CANCELLED,
};

/** Shared FeedbackType ≡ Prisma FeedbackType. */
export const FeedbackTypeParity: Record<PrismaFeedbackType, FeedbackType> = {
  PEER: FeedbackType.PEER,
  MANAGER: FeedbackType.MANAGER,
  SUBORDINATE: FeedbackType.SUBORDINATE,
  GENERAL: FeedbackType.GENERAL,
};

/** Shared AuditAction ≡ Prisma AuditAction. */
export const AuditActionParity: Record<PrismaAuditAction, AuditAction> = {
  CREATE: AuditAction.CREATE,
  UPDATE: AuditAction.UPDATE,
  DELETE: AuditAction.DELETE,
  READ: AuditAction.READ,
  LOGIN: AuditAction.LOGIN,
  LOGOUT: AuditAction.LOGOUT,
  APPROVE: AuditAction.APPROVE,
  REJECT: AuditAction.REJECT,
  RUN_PAYROLL: AuditAction.RUN_PAYROLL,
  INGEST_DOCUMENT: AuditAction.INGEST_DOCUMENT,
  DOCUMENT_DOWNLOAD: AuditAction.DOCUMENT_DOWNLOAD,
};

/** Shared ErasureStatus ≡ Prisma ErasureStatus. */
export const ErasureStatusParity: Record<PrismaErasureStatus, ErasureStatus> = {
  PENDING: ErasureStatus.PENDING,
  APPROVED: ErasureStatus.APPROVED,
  REJECTED: ErasureStatus.REJECTED,
};
