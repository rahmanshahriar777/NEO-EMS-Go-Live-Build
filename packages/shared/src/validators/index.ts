import { z } from 'zod';
import {
  SystemRole,
  EmploymentStatus,
  Gender,
  AttendanceStatus,
  LeaveStatus,
  SalaryComponentType,
  CalculationType,
  GoalStatus,
  FeedbackType,
} from '../enums/index.js';

// Auth Schemas
export const passwordValidation = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(100, 'Password must not exceed 100 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: passwordValidation,
  firstName: z.string().min(1, 'First name is required').max(50),
  lastName: z.string().min(1, 'Last name is required').max(50),
  roles: z.array(z.nativeEnum(SystemRole)).optional().default([SystemRole.EMPLOYEE]),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordValidation,
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(10, 'Refresh token is required'),
});

// Employee Schemas
export const createEmployeeSchema = z.object({
  firstName: z.string().min(1, 'First name is required').max(50),
  lastName: z.string().min(1, 'Last name is required').max(50),
  email: z.string().email('Invalid work email address'),
  phone: z.string().max(20).optional(),
  dateOfBirth: z.string().datetime().optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  gender: z.nativeEnum(Gender).optional(),
  address: z.string().max(255).optional(),
  departmentId: z.string().uuid().optional(),
  designationId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
  joiningDate: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  status: z.nativeEnum(EmploymentStatus).default(EmploymentStatus.FULL_TIME),
  profileSummary: z.string().max(1000).optional(),
  avatarUrl: z.string().url().optional(),
});

export const updateEmployeeSchema = createEmployeeSchema.partial();

export const employeeQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
  departmentId: z.string().uuid().optional(),
  designationId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
  status: z.nativeEnum(EmploymentStatus).optional(),
  sortBy: z.enum(['firstName', 'lastName', 'joiningDate', 'employeeNumber', 'createdAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// Department & Designation
export const createDepartmentSchema = z.object({
  name: z.string().min(1, 'Department name is required').max(100),
  code: z.string().min(2).max(10).toUpperCase(),
  description: z.string().max(500).optional(),
  parentId: z.string().uuid().optional(),
  headEmployeeId: z.string().uuid().optional(),
});

export const updateDepartmentSchema = createDepartmentSchema.partial();

export const createDesignationSchema = z.object({
  title: z.string().min(1, 'Designation title is required').max(100),
  code: z.string().min(2).max(20).toUpperCase(),
  description: z.string().max(500).optional(),
  level: z.number().int().min(1).max(15).default(1),
  departmentId: z.string().uuid().optional(),
});

export const updateDesignationSchema = createDesignationSchema.partial();

// Attendance Schemas
export const clockInSchema = z.object({
  employeeId: z.string().uuid().optional(), // if admin clocks in for employee
  notes: z.string().max(255).optional(),
  location: z.string().max(100).optional(),
});

export const clockOutSchema = z.object({
  employeeId: z.string().uuid().optional(),
  notes: z.string().max(255).optional(),
});

export const attendanceQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  employeeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  status: z.nativeEnum(AttendanceStatus).optional(),
});

// Leave Schemas
export const createLeaveRequestSchema = z.object({
  leaveTypeId: z.string().uuid('Valid leave type required'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format must be YYYY-MM-DD'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format must be YYYY-MM-DD'),
  reason: z.string().min(5, 'Reason must be at least 5 characters').max(500),
});

export const approveLeaveSchema = z.object({
  status: z.enum([LeaveStatus.APPROVED, LeaveStatus.REJECTED]),
  remarks: z.string().max(500).optional(),
});

// Payroll Schemas
export const createSalaryStructureSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  currency: z.string().default('BDT'),
  components: z.array(
    z.object({
      name: z.string().min(1),
      type: z.nativeEnum(SalaryComponentType),
      calculationType: z.nativeEnum(CalculationType),
      value: z.number().min(0),
    }),
  ).min(1, 'At least one salary component is required'),
});

export const assignSalarySchema = z.object({
  employeeId: z.string().uuid(),
  salaryStructureId: z.string().uuid(),
  baseSalary: z.number().positive('Base salary must be positive'),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const createPayrollRunSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020).max(2100),
  departmentId: z.string().uuid().optional(),
});

// Performance Schemas
export const createReviewCycleSchema = z.object({
  title: z.string().min(2).max(100),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().max(500).optional(),
});

export const submitSelfReviewSchema = z.object({
  selfRating: z.number().min(1).max(5),
  achievements: z.string().min(10).max(2000),
  areasOfImprovement: z.string().min(10).max(2000),
});

export const submitManagerReviewSchema = z.object({
  managerRating: z.number().min(1).max(5),
  managerFeedback: z.string().min(10).max(2000),
  recommendedPromotion: z.boolean().default(false),
  recommendedBonus: z.number().min(0).default(0),
});

export const goalSchema = z.object({
  title: z.string().min(2).max(150),
  description: z.string().max(1000).optional(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  progress: z.number().min(0).max(100).default(0),
  status: z.nativeEnum(GoalStatus).default(GoalStatus.NOT_STARTED),
});

export const feedbackSchema = z.object({
  recipientId: z.string().uuid(),
  type: z.nativeEnum(FeedbackType).default(FeedbackType.PEER),
  comments: z.string().min(5).max(1000),
  rating: z.number().min(1).max(5).optional(),
});

export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>;
export type CreatePayrollRunInput = z.infer<typeof createPayrollRunSchema>;
