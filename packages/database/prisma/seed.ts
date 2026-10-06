import {
  PrismaClient,
  SystemRole,
  EmploymentStatus,
  Gender,
  AttendanceStatus,
  LeaveStatus,
  LeaveTypeEnum,
  PayrollStatus,
  SalaryComponentType,
  CalculationType,
  ReviewStatus,
  GoalStatus,
  AuditAction,
} from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

// -----------------------------------------------------------------------------
// Seed safety (F1, F26). This seed is DEV-ONLY:
//  - refuses to run unless NODE_ENV=development or ALLOW_SEED=yes is set,
//  - generates a random admin password printed ONCE to stdout (never a static
//    credential like Str0ng!Example9),
//  - never resets an existing user's password on re-run (check-then-create),
//  - flags every demo row with isDemo=true so demo PII is never mistaken for
//    real staff data.
// -----------------------------------------------------------------------------
const isDevSeedAllowed =
  process.env.NODE_ENV === 'development' || process.env.ALLOW_SEED === 'yes';
if (!isDevSeedAllowed) {
  throw new Error(
    '[seed] Refusing to run: set NODE_ENV=development or ALLOW_SEED=yes to seed demo data. ' +
      'Seeding is disabled outside development.',
  );
}

// Admin password: defaults to SEED_DEFAULT_PASSWORD env var if set, otherwise random.
const defaultSeedPassword = process.env.SEED_DEFAULT_PASSWORD;
const SEED_ADMIN_PASSWORD = defaultSeedPassword || crypto.randomBytes(18).toString('base64url');

function hashPassword(password: string): string {
  // Per-user random salt; format matches the API's PasswordService verifier.
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `pbkdf2$100000$${salt}$${hash}`;
}

async function main() {
  console.log('🌱 Starting comprehensive database seed with rich analytics data...');

  // 1. Roles
  const rolesData = [
    { name: SystemRole.SUPER_ADMIN, description: 'Super Administrator with unrestricted access', isSystem: true },
    { name: SystemRole.HR_ADMIN, description: 'HR Administrator managing employee lifecycles and records', isSystem: true },
    { name: SystemRole.MANAGER, description: 'Team Manager approving leaves and conducting reviews', isSystem: true },
    { name: SystemRole.EMPLOYEE, description: 'Standard Employee with personal access', isSystem: true },
    { name: SystemRole.AUDITOR, description: 'Auditor with read-only compliance and audit log access', isSystem: true },
  ];

  const roles: Record<string, any> = {};
  for (const r of rolesData) {
    roles[r.name] = await prisma.role.upsert({
      where: { name: r.name },
      update: { description: r.description },
      create: r,
    });
  }
  console.log(`✅ Roles seeded (${Object.keys(roles).length})`);

  // 1b. Default entity + HQ site (Phase 3 multi-entity). Matches the 'default'
  // entity created by the phases_1_3 migration; every seeded department and
  // employee is scoped to it below.
  const defaultEntity = await prisma.entity.upsert({
    where: { id: 'default' },
    update: { name: 'Default Entity' },
    create: {
      id: 'default',
      name: 'Default Entity',
      currency: 'GBP',
      timezone: 'Europe/London',
    },
  });
  await prisma.site.upsert({
    where: { id: 'default-hq' },
    update: {},
    create: {
      id: 'default-hq',
      entityId: defaultEntity.id,
      name: 'Headquarters',
      location: 'London, UK',
      timezone: 'Europe/London',
    },
  });
  console.log(`✅ Default entity & site seeded`);

  // 2. Permissions
  const subjects = ['USER', 'EMPLOYEE', 'DEPARTMENT', 'DESIGNATION', 'ATTENDANCE', 'LEAVE', 'PAYROLL', 'PERFORMANCE', 'AUDIT_LOG', 'DOCUMENT'];
  const actions = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'MANAGE', 'APPROVE'];

  const allPerms: Record<string, any> = {};
  for (const subject of subjects) {
    for (const action of actions) {
      const p = await prisma.permission.upsert({
        where: { action_subject: { action, subject } },
        update: {},
        create: {
          action,
          subject,
          description: `Permission to ${action} ${subject}`,
        },
      });
      allPerms[`${subject}:${action}`] = p;
    }
  }
  console.log('✅ Permissions seeded');

  // 2b. Seed role permissions (PBAC activation)
  const rolePermissionGrants: Record<string, string[]> = {
    [SystemRole.SUPER_ADMIN]: Object.keys(allPerms),
    [SystemRole.HR_ADMIN]: [
      'EMPLOYEE:CREATE', 'EMPLOYEE:READ', 'EMPLOYEE:UPDATE', 'EMPLOYEE:DELETE', 'EMPLOYEE:MANAGE',
      'DEPARTMENT:CREATE', 'DEPARTMENT:READ', 'DEPARTMENT:UPDATE', 'DEPARTMENT:DELETE', 'DEPARTMENT:MANAGE',
      'DESIGNATION:CREATE', 'DESIGNATION:READ', 'DESIGNATION:UPDATE', 'DESIGNATION:DELETE', 'DESIGNATION:MANAGE',
      'LEAVE:READ', 'LEAVE:APPROVE', 'LEAVE:MANAGE',
      'DOCUMENT:CREATE', 'DOCUMENT:READ', 'DOCUMENT:UPDATE', 'DOCUMENT:DELETE', 'DOCUMENT:MANAGE',
      'ATTENDANCE:READ', 'ATTENDANCE:MANAGE',
      'PERFORMANCE:READ', 'PERFORMANCE:MANAGE',
      'USER:READ', 'USER:UPDATE', 'USER:MANAGE',
      'AUDIT_LOG:READ',
    ],
    [SystemRole.MANAGER]: [
      'EMPLOYEE:READ',
      'LEAVE:READ', 'LEAVE:APPROVE',
      'ATTENDANCE:READ', 'ATTENDANCE:APPROVE',
      'PERFORMANCE:CREATE', 'PERFORMANCE:READ', 'PERFORMANCE:UPDATE', 'PERFORMANCE:APPROVE',
      'DOCUMENT:READ', 'DOCUMENT:CREATE',
    ],
    [SystemRole.EMPLOYEE]: [
      'EMPLOYEE:READ',
      'LEAVE:CREATE', 'LEAVE:READ',
      'ATTENDANCE:CREATE', 'ATTENDANCE:READ',
      'PERFORMANCE:READ',
      'DOCUMENT:READ', 'DOCUMENT:CREATE',
    ],
    [SystemRole.AUDITOR]: subjects.map((s) => `${s}:READ`),
  };

  for (const [roleName, permKeys] of Object.entries(rolePermissionGrants)) {
    const role = roles[roleName];
    if (!role) continue;
    for (const key of permKeys) {
      const perm = allPerms[key];
      if (!perm) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
  }
  console.log('✅ Role permissions seeded (PBAC activated)');

  // 3. Departments (8 Core Departments)
  const departmentsData = [
    { code: 'ENG', name: 'Engineering', description: 'Core software engineering, architecture, platform systems, and cloud infrastructure.' },
    { code: 'HR', name: 'Human Resources', description: 'Talent acquisition, employee relations, operations, benefits, and culture.' },
    { code: 'FIN', name: 'Finance & Accounting', description: 'Financial forecasting, compensation modeling, audit compliance, and payroll operations.' },
    { code: 'PRD', name: 'Product & Design', description: 'Product roadmap, UX/UI interaction design, user research, and customer discovery.' },
    { code: 'MKT', name: 'Marketing & Growth', description: 'Brand strategy, developer relations, public communications, and growth marketing.' },
    { code: 'LGL', name: 'Legal & Compliance', description: 'Corporate governance, contracts, regulatory compliance, and risk management.' },
    { code: 'CSS', name: 'Customer Success', description: 'Enterprise client onboarding, account management, and strategic technical support.' },
    { code: 'QAT', name: 'Quality Assurance & DevOps', description: 'Automated testing frameworks, performance validation, and CI/CD pipelines.' },
  ];

  const departments: Record<string, any> = {};
  for (const d of departmentsData) {
    departments[d.code] = await prisma.department.upsert({
      where: { code: d.code },
      update: { name: d.name, description: d.description, entityId: 'default' },
      create: { ...d, entityId: 'default' },
    });
  }
  console.log(`✅ Departments seeded (${Object.keys(departments).length})`);

  // 4. Designations (18 Designations)
  const designationsData = [
    { code: 'VP_ENG', title: 'VP of Engineering', level: 6, deptCode: 'ENG' },
    { code: 'ENG_MGR', title: 'Engineering Manager', level: 5, deptCode: 'ENG' },
    { code: 'LEAD_ARCH', title: 'Lead Cloud Architect', level: 5, deptCode: 'ENG' },
    { code: 'SR_ENG', title: 'Senior Software Engineer', level: 4, deptCode: 'ENG' },
    { code: 'SW_ENG_2', title: 'Software Engineer II', level: 3, deptCode: 'ENG' },
    { code: 'FRONT_SPEC', title: 'Frontend Specialist', level: 3, deptCode: 'ENG' },
    { code: 'DIR_HR', title: 'Chief People Officer', level: 6, deptCode: 'HR' },
    { code: 'HR_MGR', title: 'HR Operations Manager', level: 5, deptCode: 'HR' },
    { code: 'TALENT_PARTNER', title: 'Talent Acquisition Partner', level: 3, deptCode: 'HR' },
    { code: 'DIR_FIN', title: 'Finance Director', level: 6, deptCode: 'FIN' },
    { code: 'SR_PAYROLL', title: 'Senior Payroll Specialist', level: 4, deptCode: 'FIN' },
    { code: 'FIN_ANALYST', title: 'Financial Analyst', level: 3, deptCode: 'FIN' },
    { code: 'HEAD_PROD', title: 'Head of Product', level: 6, deptCode: 'PRD' },
    { code: 'SR_DESIGNER', title: 'Senior Product Designer', level: 4, deptCode: 'PRD' },
    { code: 'DIR_MKT', title: 'Marketing Director', level: 6, deptCode: 'MKT' },
    { code: 'GROWTH_MKT', title: 'Growth Marketing Lead', level: 4, deptCode: 'MKT' },
    { code: 'LEAD_AUDITOR', title: 'Compliance Auditor', level: 5, deptCode: 'LGL' },
    { code: 'QA_LEAD', title: 'Lead QA Automation Engineer', level: 4, deptCode: 'QAT' },
  ];

  const designations: Record<string, any> = {};
  for (const des of designationsData) {
    designations[des.code] = await prisma.designation.upsert({
      where: { code: des.code },
      update: { title: des.title, level: des.level },
      create: {
        code: des.code,
        title: des.title,
        level: des.level,
        departmentId: departments[des.deptCode].id,
      },
    });
  }
  console.log(`✅ Designations seeded (${Object.keys(designations).length})`);

  // 5. Shifts
  const defaultShift = await prisma.shift.upsert({
    where: { id: 'default-shift-id' },
    update: {},
    create: {
      id: 'default-shift-id',
      name: 'Standard Core Shift',
      startTime: '09:00',
      endTime: '18:00',
      gracePeriodMinutes: 15,
      isDefault: true,
    },
  });

  const eveningShift = await prisma.shift.upsert({
    where: { id: 'evening-shift-id' },
    update: {},
    create: {
      id: 'evening-shift-id',
      name: 'Global Support Shift',
      startTime: '14:00',
      endTime: '23:00',
      gracePeriodMinutes: 15,
      isDefault: false,
    },
  });
  console.log('✅ Shifts seeded');

  // 6. Leave Types
  const leaveTypesData = [
    { name: 'Annual Paid Leave', code: 'ANNUAL', type: LeaveTypeEnum.ANNUAL, defaultDaysPerYear: 20, isPaid: true },
    { name: 'Sick & Medical Leave', code: 'SICK', type: LeaveTypeEnum.SICK, defaultDaysPerYear: 10, isPaid: true },
    { name: 'Casual & Personal', code: 'CASUAL', type: LeaveTypeEnum.CASUAL, defaultDaysPerYear: 5, isPaid: true },
    { name: 'Maternity Leave', code: 'MATERNITY', type: LeaveTypeEnum.MATERNITY, defaultDaysPerYear: 90, isPaid: true },
    { name: 'Paternity Leave', code: 'PATERNITY', type: LeaveTypeEnum.PATERNITY, defaultDaysPerYear: 10, isPaid: true },
    { name: 'Unpaid Leave', code: 'UNPAID', type: LeaveTypeEnum.UNPAID, defaultDaysPerYear: 30, isPaid: false },
    { name: 'Bereavement Leave', code: 'BEREAVEMENT', type: LeaveTypeEnum.BEREAVEMENT, defaultDaysPerYear: 5, isPaid: true },
  ];

  const leaveTypes: Record<string, any> = {};
  for (const lt of leaveTypesData) {
    leaveTypes[lt.code] = await prisma.leaveType.upsert({
      where: { code: lt.code },
      update: { name: lt.name },
      create: lt,
    });
  }
  console.log('✅ Leave types seeded');

  // 7. Users and Employees (22 Personnel with Diverse Roster)
  // NOTE: every account below gets a RANDOM password. The superadmin password
  // is printed once at the end of this script. This is demo-only data.

  const personnelRoster = [
    {
      num: 'EMP-2026-0001',
      email: 'superadmin@ems.local',
      role: SystemRole.SUPER_ADMIN,
      first: 'System',
      last: 'Administrator',
      phone: '+1 (555) 010-0001',
      dept: 'ENG',
      desig: 'VP_ENG',
      gender: Gender.MALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2023-01-15',
      salary: 14500,
      summary: 'Principal enterprise platform architect and super administrator responsible for global system infrastructure.',
    },
    {
      num: 'EMP-2026-0002',
      email: 'hradmin@ems.local',
      role: SystemRole.HR_ADMIN,
      first: 'Clara',
      last: 'Davenport',
      phone: '+880 1711-000002',
      dept: 'HR',
      desig: 'HR_MGR',
      gender: Gender.FEMALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2023-03-01',
      salary: 10800,
      summary: 'Director of People and Human Resources operations overseeing talent compliance and organizational health.',
    },
    {
      num: 'EMP-2026-0003',
      email: 'manager@ems.local',
      role: SystemRole.MANAGER,
      first: 'Shahriar',
      last: 'Rahman',
      phone: '+880 1711-000003',
      dept: 'ENG',
      desig: 'ENG_MGR',
      gender: Gender.MALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2023-04-10',
      salary: 12500,
      summary: 'Engineering Manager leading distributed microservices, platform reliability, and team mentoring.',
    },
    {
      num: 'EMP-2026-0004',
      email: 'sadia.rahman@ems.local',
      role: SystemRole.EMPLOYEE,
      first: 'Sadia',
      last: 'Rahman',
      phone: '+880 1711-000004',
      dept: 'ENG',
      desig: 'SR_ENG',
      gender: Gender.FEMALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2024-01-10',
      salary: 9500,
      summary: 'Senior Software Engineer specializing in Next.js 14 App Router, TypeScript monorepos, and high-concurrency systems.',
    },
    {
      num: 'EMP-2026-0005',
      email: 'alex.rivera@ems.local',
      role: SystemRole.EMPLOYEE,
      first: 'Alex',
      last: 'Rivera',
      phone: '+1 (555) 010-0005',
      dept: 'ENG',
      desig: 'LEAD_ARCH',
      gender: Gender.MALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2023-06-01',
      salary: 13800,
      summary: 'Cloud Architect driving Google Cloud Run containerization, multi-region failover, and Docker optimizations.',
    },
    {
      num: 'EMP-2026-0006',
      email: 'elena.rostova@ems.local',
      role: SystemRole.EMPLOYEE,
      first: 'Elena',
      last: 'Rostova',
      phone: '+44 20 7946 0006',
      dept: 'ENG',
      desig: 'SW_ENG_2',
      gender: Gender.FEMALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2024-03-15',
      salary: 8200,
      summary: 'Backend Engineer working on NestJS microservices, BullMQ queue offloading, and Prisma query optimizations.',
    },
    {
      num: 'EMP-2026-0007',
      email: 'tariq.mansoor@ems.local',
      role: SystemRole.EMPLOYEE,
      first: 'Tariq',
      last: 'Al-Mansoor',
      phone: '+971 50 123 0007',
      dept: 'ENG',
      desig: 'FRONT_SPEC',
      gender: Gender.MALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2024-05-01',
      salary: 8500,
      summary: 'Frontend Engineer focused on Web Speech API, voice synthesis UX, responsive styling, and web accessibility.',
    },
    {
      num: 'EMP-2026-0008',
      email: 'chloe.martin@ems.local',
      role: SystemRole.MANAGER,
      first: 'Chloe',
      last: 'Martin',
      phone: '+1 (555) 010-0008',
      dept: 'PRD',
      desig: 'HEAD_PROD',
      gender: Gender.FEMALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2023-08-01',
      salary: 13000,
      summary: 'Head of Product managing cross-functional product roadmap, feature telemetry, and user feedback cycles.',
    },
    {
      num: 'EMP-2026-0009',
      email: 'julian.rossi@ems.local',
      role: SystemRole.EMPLOYEE,
      first: 'Julian',
      last: 'Rossi',
      phone: '+39 06 698 0009',
      dept: 'PRD',
      desig: 'SR_DESIGNER',
      gender: Gender.MALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2024-02-01',
      salary: 9200,
      summary: 'Lead Product Designer creator of the Neo editorial design token system, fluid typography, and micro-animations.',
    },
    {
      num: 'EMP-2026-0010',
      email: 'sophia.chen@ems.local',
      role: SystemRole.MANAGER,
      first: 'Sophia',
      last: 'Chen',
      phone: '+1 (555) 010-0010',
      dept: 'FIN',
      desig: 'DIR_FIN',
      gender: Gender.FEMALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2023-02-15',
      salary: 13500,
      summary: 'Finance Director overseeing statutory payroll tax compliance, revenue auditing, and corporate allocations.',
    },
    {
      num: 'EMP-2026-0011',
      email: 'david.kim@ems.local',
      role: SystemRole.EMPLOYEE,
      first: 'David',
      last: 'Kim',
      phone: '+1 (555) 010-0011',
      dept: 'FIN',
      desig: 'SR_PAYROLL',
      gender: Gender.MALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2023-09-01',
      salary: 8800,
      summary: 'Payroll Specialist managing monthly compensation runs, PF/ESI deductions, and payslip generation.',
    },
    {
      num: 'EMP-2026-0012',
      email: 'aisha.patel@ems.local',
      role: SystemRole.EMPLOYEE,
      first: 'Aisha',
      last: 'Patel',
      phone: '+91 98200 00012',
      dept: 'FIN',
      desig: 'FIN_ANALYST',
      gender: Gender.FEMALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2024-04-15',
      salary: 7600,
      summary: 'Financial Analyst modeling headcount forecasting, department operational expenses, and budget variance.',
    },
    {
      num: 'EMP-2026-0013',
      email: 'priya.sharma@ems.local',
      role: SystemRole.EMPLOYEE,
      first: 'Priya',
      last: 'Sharma',
      phone: '+91 98200 00013',
      dept: 'HR',
      desig: 'TALENT_PARTNER',
      gender: Gender.FEMALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2024-03-01',
      salary: 7900,
      summary: 'Talent Acquisition Partner recruiting senior technical staff, managing campus outreach, and interview pipelines.',
    },
    {
      num: 'EMP-2026-0014',
      email: 'benjamin.hayes@ems.local',
      role: SystemRole.MANAGER,
      first: 'Benjamin',
      last: 'Hayes',
      phone: '+1 (555) 010-0014',
      dept: 'MKT',
      desig: 'DIR_MKT',
      gender: Gender.MALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2023-05-15',
      salary: 12800,
      summary: 'Marketing Director driving global product positioning, conference keynotes, and enterprise demand generation.',
    },
    {
      num: 'EMP-2026-0015',
      email: 'sarah.jenkins@ems.local',
      role: SystemRole.EMPLOYEE,
      first: 'Sarah',
      last: 'Jenkins',
      phone: '+1 (555) 010-0015',
      dept: 'MKT',
      desig: 'GROWTH_MKT',
      gender: Gender.FEMALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2024-01-20',
      salary: 8100,
      summary: 'Growth Marketing Lead focusing on developer community evangelism, SEO optimization, and content strategy.',
    },
    {
      num: 'EMP-2026-0016',
      email: 'auditor@ems.local',
      role: SystemRole.AUDITOR,
      first: 'Jonathan',
      last: 'Ward',
      phone: '+1 (555) 010-0016',
      dept: 'LGL',
      desig: 'LEAD_AUDITOR',
      gender: Gender.MALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2023-11-01',
      salary: 11200,
      summary: 'Lead Compliance Auditor inspecting SOC2 Trust Criteria, access control policies, and data confidentiality.',
    },
    {
      num: 'EMP-2026-0017',
      email: 'vikram.mehta@ems.local',
      role: SystemRole.EMPLOYEE,
      first: 'Vikram',
      last: 'Mehta',
      phone: '+91 98200 00017',
      dept: 'QAT',
      desig: 'QA_LEAD',
      gender: Gender.MALE,
      status: EmploymentStatus.FULL_TIME,
      join: '2023-10-10',
      salary: 9100,
      summary: 'Lead QA Engineer architecting automated end-to-end Jest and Playwright testing suites across web and mobile.',
    },
    {
      num: 'EMP-2026-0018',
      email: 'marcus.vance@ems.local',
      role: SystemRole.EMPLOYEE,
      first: 'Marcus',
      last: 'Vance',
      phone: '+1 (555) 010-0018',
      dept: 'HR',
      desig: 'TALENT_PARTNER',
      gender: Gender.MALE,
      status: EmploymentStatus.CONTRACT,
      join: '2024-07-01',
      salary: 7200,
      summary: 'People & Culture Specialist supporting employee onboarding, engagement initiatives, and wellness programs.',
    },
    {
      num: 'EMP-2026-0019',
      email: 'maya.lin@ems.local',
      role: SystemRole.EMPLOYEE,
      first: 'Maya',
      last: 'Lin',
      phone: '+1 (555) 010-0019',
      dept: 'PRD',
      desig: 'SR_DESIGNER',
      gender: Gender.FEMALE,
      status: EmploymentStatus.PROBATION,
      join: '2026-08-01',
      salary: 6800,
      summary: 'Interaction Designer conducting usability testing on AI conversational flows and voice feedback systems.',
    },
    {
      num: 'EMP-2026-0020',
      email: 'liam.oconnor@ems.local',
      role: SystemRole.EMPLOYEE,
      first: 'Liam',
      last: 'O’Connor',
      phone: '+353 1 496 0020',
      dept: 'ENG',
      desig: 'SW_ENG_2',
      gender: Gender.MALE,
      status: EmploymentStatus.INTERN,
      join: '2026-06-01',
      salary: 4500,
      summary: 'Platform Engineering Intern assisting with Redis cache warming, Docker entrypoint tuning, and telemetry metrics.',
    },
  ];

  const employees: Record<string, any> = {};

  for (const p of personnelRoster) {
    // Check-then-create: an existing user keeps its current passwordHash.
    // Never reset credentials on re-run (F1).
    const existingUser = await prisma.user.findUnique({ where: { email: p.email } });
    const user =
      existingUser ??
      (await prisma.user.create({
        data: {
          email: p.email,
          passwordHash: hashPassword(defaultSeedPassword || (p.email === 'superadmin@ems.local' ? SEED_ADMIN_PASSWORD : crypto.randomBytes(18).toString('base64url'))),
          roles: { create: { roleId: roles[p.role].id } },
        },
      }));

    const emp = await prisma.employee.upsert({
      where: { email: p.email },
      update: {
        firstName: p.first,
        lastName: p.last,
        phone: p.phone,
        departmentId: departments[p.dept].id,
        designationId: designations[p.desig].id,
        status: p.status,
        profileSummary: p.summary,
        isDemo: true,
        entityId: 'default',
      },
      create: {
        employeeNumber: p.num,
        userId: user.id,
        firstName: p.first,
        lastName: p.last,
        email: p.email,
        phone: p.phone,
        departmentId: departments[p.dept].id,
        designationId: designations[p.desig].id,
        status: p.status,
        gender: p.gender,
        joiningDate: new Date(p.join),
        profileSummary: p.summary,
        isDemo: true,
        entityId: 'default',
      },
    });

    employees[p.email] = { ...emp, salary: p.salary, deptCode: p.dept };
  }
  // Phase 1 B2: seeded (demo) users are email-verified so sign-in works on a
  // fresh install. Existing rows are updated too — verification is a property
  // of the demo fixture, not of anything the user did.
  await prisma.user.updateMany({
    where: { email: { in: personnelRoster.map((p) => p.email) } },
    data: { emailVerified: true },
  });
  console.log(`✅ Users & Employees seeded (${Object.keys(employees).length})`);

  // Assign Manager relationships
  const managerId = employees['manager@ems.local'].id;
  await prisma.employee.updateMany({
    where: {
      email: {
        in: ['sadia.rahman@ems.local', 'alex.rivera@ems.local', 'elena.rostova@ems.local', 'tariq.mansoor@ems.local', 'liam.oconnor@ems.local'],
      },
    },
    data: { managerId },
  });

  // Assign Department heads
  await prisma.department.update({ where: { code: 'ENG' }, data: { headEmployeeId: managerId } });
  await prisma.department.update({ where: { code: 'HR' }, data: { headEmployeeId: employees['hradmin@ems.local'].id } });
  await prisma.department.update({ where: { code: 'PRD' }, data: { headEmployeeId: employees['chloe.martin@ems.local'].id } });
  await prisma.department.update({ where: { code: 'FIN' }, data: { headEmployeeId: employees['sophia.chen@ems.local'].id } });
  await prisma.department.update({ where: { code: 'MKT' }, data: { headEmployeeId: employees['benjamin.hayes@ems.local'].id } });

  // 8. Leave Balances for ALL employees
  for (const emp of Object.values(employees)) {
    for (const lt of Object.values(leaveTypes)) {
      const allocated = lt.defaultDaysPerYear;
      const used = Math.min(Math.floor(Math.random() * 4), allocated);
      const remaining = allocated - used;

      await prisma.leaveBalance.upsert({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: emp.id,
            leaveTypeId: lt.id,
            year: 2026,
          },
        },
        update: { allocatedDays: allocated, usedDays: used, remainingDays: remaining },
        create: {
          employeeId: emp.id,
          leaveTypeId: lt.id,
          year: 2026,
          allocatedDays: allocated,
          usedDays: used,
          pendingDays: 0,
          remainingDays: remaining,
        },
      });
    }
  }
  console.log('✅ Leave balances seeded for all personnel');

  // 9. Leave Requests (Multiple rich entries across statuses)
  const leaveRequestsSample = [
    {
      email: 'sadia.rahman@ems.local',
      typeCode: 'ANNUAL',
      start: '2026-09-20',
      end: '2026-09-22',
      days: 3,
      reason: 'Attending Google Cloud Summit and microservices architecture workshop.',
      status: LeaveStatus.APPROVED,
    },
    {
      email: 'alex.rivera@ems.local',
      typeCode: 'ANNUAL',
      start: '2026-10-05',
      end: '2026-10-09',
      days: 5,
      reason: 'Annual family holiday and recharge period.',
      status: LeaveStatus.PENDING,
    },
    {
      email: 'elena.rostova@ems.local',
      typeCode: 'SICK',
      start: '2026-09-14',
      end: '2026-09-15',
      days: 2,
      reason: 'Seasonal viral flu recovery. Doctor consultation completed.',
      status: LeaveStatus.APPROVED,
    },
    {
      email: 'tariq.mansoor@ems.local',
      typeCode: 'CASUAL',
      start: '2026-09-28',
      end: '2026-09-29',
      days: 2,
      reason: 'Personal administrative work and passport renewal appointment.',
      status: LeaveStatus.PENDING,
    },
    {
      email: 'julian.rossi@ems.local',
      typeCode: 'ANNUAL',
      start: '2026-11-02',
      end: '2026-11-06',
      days: 5,
      reason: 'Attending European Design Week and Figma user conference in Milan.',
      status: LeaveStatus.PENDING,
    },
    {
      email: 'david.kim@ems.local',
      typeCode: 'CASUAL',
      start: '2026-08-18',
      end: '2026-08-19',
      days: 2,
      reason: 'Home relocation and internet installation.',
      status: LeaveStatus.APPROVED,
    },
    {
      email: 'priya.sharma@ems.local',
      typeCode: 'ANNUAL',
      start: '2026-09-10',
      end: '2026-09-12',
      days: 3,
      reason: 'Family wedding celebrations in Mumbai.',
      status: LeaveStatus.APPROVED,
    },
    {
      email: 'sarah.jenkins@ems.local',
      typeCode: 'UNPAID',
      start: '2026-08-01',
      end: '2026-08-05',
      days: 5,
      reason: 'Personal international travel before high-volume Q4 marketing campaign.',
      status: LeaveStatus.REJECTED,
    },
    {
      email: 'vikram.mehta@ems.local',
      typeCode: 'SICK',
      start: '2026-09-08',
      end: '2026-09-09',
      days: 2,
      reason: 'Dental surgery and prescribed recovery.',
      status: LeaveStatus.APPROVED,
    },
    {
      email: 'liam.oconnor@ems.local',
      typeCode: 'CASUAL',
      start: '2026-09-25',
      end: '2026-09-25',
      days: 1,
      reason: 'University graduation ceremony and convocation.',
      status: LeaveStatus.APPROVED,
    },
  ];

  for (const lr of leaveRequestsSample) {
    const emp = employees[lr.email];
    if (emp) {
      await prisma.leaveRequest.create({
        data: {
          employeeId: emp.id,
          leaveTypeId: leaveTypes[lr.typeCode].id,
          startDate: new Date(lr.start),
          endDate: new Date(lr.end),
          totalDays: lr.days,
          reason: lr.reason,
          status: lr.status,
          approvals:
            lr.status === LeaveStatus.APPROVED
              ? {
                  create: {
                    approverId: managerId,
                    status: LeaveStatus.APPROVED,
                    remarks: 'Approved per company policy',
                  },
                }
              : undefined,
        },
      });
    }
  }
  console.log(`✅ Sample leave requests seeded (${leaveRequestsSample.length})`);

  // 10. Attendance Records (60+ records over past 14 business days)
  const pastDays = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 16, 17];
  const targetStaff = [
    'sadia.rahman@ems.local',
    'alex.rivera@ems.local',
    'elena.rostova@ems.local',
    'tariq.mansoor@ems.local',
    'manager@ems.local',
    'hradmin@ems.local',
    'julian.rossi@ems.local',
    'david.kim@ems.local',
    'priya.sharma@ems.local',
    'vikram.mehta@ems.local',
  ];

  let attCount = 0;
  for (const dayOffset of pastDays) {
    const recordDate = new Date();
    recordDate.setDate(recordDate.getDate() - dayOffset);
    recordDate.setHours(0, 0, 0, 0);

    for (const email of targetStaff) {
      const emp = employees[email];
      if (!emp) continue;

      // Realistic variation: mostly PRESENT on-time, some LATE, occasional WFH notes
      const isLate = Math.random() < 0.15;
      const isHalfDay = !isLate && Math.random() < 0.05;

      const clockInHour = isLate ? 9 : 8;
      const clockInMin = isLate ? Math.floor(Math.random() * 25) + 16 : Math.floor(Math.random() * 55);

      const clockOutHour = isHalfDay ? 13 : 18;
      const clockOutMin = Math.floor(Math.random() * 30);

      const inTime = new Date(recordDate);
      inTime.setHours(clockInHour, clockInMin, 0, 0);

      const outTime = new Date(recordDate);
      outTime.setHours(clockOutHour, clockOutMin, 0, 0);

      const hours = Number(((outTime.getTime() - inTime.getTime()) / (1000 * 60 * 60)).toFixed(2));
      const status = isHalfDay ? AttendanceStatus.HALF_DAY : (isLate ? AttendanceStatus.LATE : AttendanceStatus.PRESENT);

      const notes = isLate
        ? 'Traffic delay reported on highway route.'
        : (isHalfDay ? 'Approved half-day medical leave afternoon.' : 'Standard core sprint hours logged.');

      try {
        await prisma.attendanceRecord.upsert({
          where: {
            employeeId_date: {
              employeeId: emp.id,
              date: recordDate,
            },
          },
          update: { totalHoursWorked: hours, status },
          create: {
            employeeId: emp.id,
            date: recordDate,
            clockInTime: inTime,
            clockOutTime: outTime,
            totalHoursWorked: hours,
            status,
            shiftId: defaultShift.id,
            notes,
          },
        });
        attCount++;
      } catch {}
    }
  }
  console.log(`✅ Historical attendance records seeded (${attCount})`);

  // 11. Salary Structure & Multiple Payroll Runs (June, July, August 2026)
  const standardSalaryStructure = await prisma.salaryStructure.upsert({
    where: { id: 'standard-tech-structure' },
    update: {},
    create: {
      id: 'standard-tech-structure',
      name: 'Global Enterprise Grade Salary Structure',
      description: 'Standard compensation structure with basic, HRA, transit, and tax withholdings',
      currency: 'BDT',
      isDefault: true,
      components: {
        create: [
          { name: 'Basic Pay', type: SalaryComponentType.EARNING, calculationType: CalculationType.PERCENTAGE_OF_GROSS, value: 50, isTaxable: true },
          { name: 'House Rent Allowance (HRA)', type: SalaryComponentType.EARNING, calculationType: CalculationType.PERCENTAGE_OF_BASIC, value: 40, isTaxable: true },
          { name: 'Medical & Transit Allowance', type: SalaryComponentType.EARNING, calculationType: CalculationType.FIXED, value: 500, isTaxable: false },
          { name: 'Provident Fund (PF)', type: SalaryComponentType.DEDUCTION, calculationType: CalculationType.PERCENTAGE_OF_BASIC, value: 12, isTaxable: false },
          { name: 'Income Tax (Estimated TDS)', type: SalaryComponentType.DEDUCTION, calculationType: CalculationType.PERCENTAGE_OF_GROSS, value: 15, isTaxable: false },
        ],
      },
    },
  });

  // Assign salary structure to employees
  for (const emp of Object.values(employees)) {
    await prisma.employeeSalaryStructure.upsert({
      where: { id: `sal-${emp.id}` },
      update: { baseSalary: emp.salary },
      create: {
        id: `sal-${emp.id}`,
        employeeId: emp.id,
        salaryStructureId: standardSalaryStructure.id,
        baseSalary: emp.salary,
        effectiveFrom: new Date('2024-01-01'),
        isActive: true,
      },
    });
  }

  // Seed 3 Monthly Payroll Runs: June, July, August 2026
  const payrollMonths = [
    { m: 6, y: 2026, status: PayrollStatus.PAID, date: '2026-06-30' },
    { m: 7, y: 2026, status: PayrollStatus.PAID, date: '2026-07-31' },
    { m: 8, y: 2026, status: PayrollStatus.APPROVED, date: '2026-08-31' },
  ];

  let payslipTotal = 0;
  for (const pm of payrollMonths) {
    for (const [deptCode, dept] of Object.entries(departments)) {
      const deptStaff = Object.values(employees).filter((e: any) => e.deptCode === deptCode);
      if (deptStaff.length === 0) continue;

      const totalGross = deptStaff.reduce((sum, e: any) => sum + e.salary, 0);
      const totalDeductions = totalGross * 0.18;
      const totalNet = totalGross - totalDeductions;

      const run = await prisma.payrollRun.upsert({
        where: {
          month_year_departmentId: {
            month: pm.m,
            year: pm.y,
            departmentId: dept.id,
          },
        },
        update: {},
        create: {
          month: pm.m,
          year: pm.y,
          departmentId: dept.id,
          status: pm.status,
          totalGross,
          totalDeductions,
          totalNet,
          processedAt: new Date(pm.date),
          approvedAt: new Date(pm.date),
          // Maker/checker FK (F15): resolve the approver to a real user id.
          approvedById: employees['superadmin@ems.local'].userId,
        },
      });

      // Generate individual payslips for department staff
      for (const e of deptStaff) {
        const gross = e.salary;
        const basic = gross * 0.5;
        const hra = basic * 0.4;
        const medical = 500;
        const special = gross - (basic + hra + medical);
        const pf = basic * 0.12;
        const tax = gross * 0.12;
        const deductions = pf + tax;
        const net = gross - deductions;

        await prisma.payslip.upsert({
          where: {
            payrollRunId_employeeId: {
              payrollRunId: run.id,
              employeeId: e.id,
            },
          },
          update: {},
          create: {
            payrollRunId: run.id,
            employeeId: e.id,
            grossPay: gross,
            totalDeductions: deductions,
            netPay: net,
            status: pm.status,
            disbursementDate: new Date(pm.date),
            breakdown: [
              { component: 'Basic Pay', type: 'EARNING', amount: basic },
              { component: 'House Rent Allowance (HRA)', type: 'EARNING', amount: hra },
              { component: 'Medical & Transit Allowance', type: 'EARNING', amount: medical },
              { component: 'Special Performance Allowance', type: 'EARNING', amount: special },
              { component: 'Provident Fund (PF)', type: 'DEDUCTION', amount: pf },
              { component: 'Income Tax (TDS)', type: 'DEDUCTION', amount: tax },
            ],
          },
        });
        payslipTotal++;
      }
    }
  }
  console.log(`✅ Multi-month payroll runs and payslips seeded (${payslipTotal} payslips)`);

  // 12. Performance Review Cycles & Comprehensive Goals
  const reviewCycleH1 = await prisma.performanceReviewCycle.upsert({
    where: { id: 'cycle-h1-2026' },
    update: {},
    create: {
      id: 'cycle-h1-2026',
      title: 'H1 2026 Company Performance Appraisal Cycle',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-06-30'),
      description: 'First half review: Architecture readiness, team delivery, and cross-functional KPIs.',
      isActive: false,
    },
  });

  const reviewCycleH2 = await prisma.performanceReviewCycle.upsert({
    where: { id: 'cycle-h2-2026' },
    update: {},
    create: {
      id: 'cycle-h2-2026',
      title: 'H2 2026 Company Performance Appraisal Cycle',
      startDate: new Date('2026-07-01'),
      endDate: new Date('2026-12-31'),
      description: 'Second half review: Next-gen AI integration, cloud optimization, and security audits.',
      isActive: true,
    },
  });

  const performanceGoalsData = [
    {
      email: 'sadia.rahman@ems.local',
      title: 'Deliver High-Availability AI Inference with Dual-Provider Fallback',
      desc: 'Build circuit-breaker-protected gateway supporting Google Gemini and Groq Llama with zero data loss.',
      date: '2026-10-31',
      prog: 90,
      status: GoalStatus.IN_PROGRESS,
    },
    {
      email: 'sadia.rahman@ems.local',
      title: 'Multimodal Voice Input & Output in AI Assistant Suite',
      desc: 'Integrate Web Speech API with real-time speech streaming, sentence chunking, and markdown cleanup.',
      date: '2026-09-30',
      prog: 100,
      status: GoalStatus.COMPLETED,
    },
    {
      email: 'alex.rivera@ems.local',
      title: 'Optimize Google Cloud Run Multi-Stage Docker Container',
      desc: 'Reduce container image size to under 300MB and achieve sub-6 second cold start initialization.',
      date: '2026-11-15',
      prog: 80,
      status: GoalStatus.IN_PROGRESS,
    },
    {
      email: 'elena.rostova@ems.local',
      title: 'Automate Redis-Backed BullMQ Background Worker Queues',
      desc: 'Offload payroll compute calculations and token audit logging to asynchronous queue workers.',
      date: '2026-10-15',
      prog: 75,
      status: GoalStatus.IN_PROGRESS,
    },
    {
      email: 'tariq.mansoor@ems.local',
      title: 'Full WCAG 2.1 Level AA Accessibility Audit across UI components',
      desc: 'Ensure keyboard accessibility, aria-labels, high-contrast ratios, and screen-reader compliance.',
      date: '2026-12-01',
      prog: 65,
      status: GoalStatus.IN_PROGRESS,
    },
    {
      email: 'julian.rossi@ems.local',
      title: 'Design System Parameter Documentation & Figma UI Tokens',
      desc: 'Publish comprehensive design tokens for typography, HSL tailored palettes, and micro-animations.',
      date: '2026-09-15',
      prog: 100,
      status: GoalStatus.COMPLETED,
    },
    {
      email: 'david.kim@ems.local',
      title: 'Automate Statutory Tax Slabs & TDS Withholding Calculations',
      desc: 'Implement zero-error arbitrary-precision Decimal engine for multi-tier payroll deductions.',
      date: '2026-10-31',
      prog: 85,
      status: GoalStatus.IN_PROGRESS,
    },
    {
      email: 'vikram.mehta@ems.local',
      title: 'Achieve 90%+ Automated Unit and Integration Test Coverage',
      desc: 'Expand Jest suites across auth guards, payroll calculation, leave balance logic, and API controllers.',
      date: '2026-11-30',
      prog: 88,
      status: GoalStatus.IN_PROGRESS,
    },
  ];

  for (const g of performanceGoalsData) {
    const emp = employees[g.email];
    if (emp) {
      await prisma.goal.create({
        data: {
          employeeId: emp.id,
          title: g.title,
          description: g.desc,
          targetDate: new Date(g.date),
          progress: g.prog,
          status: g.status,
        },
      });
    }
  }

  // Reviews
  const reviewsData = [
    {
      email: 'sadia.rahman@ems.local',
      cycleId: reviewCycleH2.id,
      selfRating: 4.9,
      selfAchieve: 'Architected voice input/output in AI Assistant, optimized Next.js App Router, and documented full SRS.',
      selfImprove: 'Expand Kubernetes multi-cluster load balancing experiments.',
      mgrRating: 5.0,
      mgrFeedback: 'Consistently exceptional execution speed and code quality. Core pillar of engineering reliability.',
      finalScore: 4.95,
      status: ReviewStatus.COMPLETED,
    },
    {
      email: 'alex.rivera@ems.local',
      cycleId: reviewCycleH2.id,
      selfRating: 4.7,
      selfAchieve: 'Configured automated Cloud Run deploy pipelines, Knative autoscaling, and SSL edge certificates.',
      selfImprove: 'Document disaster recovery runbooks in engineering wiki.',
      mgrRating: 4.8,
      mgrFeedback: 'Outstanding cloud infrastructure leadership and reliable production operations.',
      finalScore: 4.75,
      status: ReviewStatus.COMPLETED,
    },
    {
      email: 'tariq.mansoor@ems.local',
      cycleId: reviewCycleH2.id,
      selfRating: 4.5,
      selfAchieve: 'Streamlined frontend responsiveness, real-time typing indicators, and mobile drawer transitions.',
      selfImprove: 'Deepen knowledge of WebAssembly and canvas audio visualizers.',
      mgrRating: 4.6,
      mgrFeedback: 'Great aesthetic instincts and strong technical execution on client-side state handling.',
      finalScore: 4.55,
      status: ReviewStatus.COMPLETED,
    },
    {
      email: 'julian.rossi@ems.local',
      cycleId: reviewCycleH2.id,
      selfRating: 4.8,
      selfAchieve: 'Crafted the entire editorial brand identity, refined typography, and designed interactive calendar UI.',
      selfImprove: 'Streamline design handoff specs for engineering sprint tickets.',
      mgrRating: 4.9,
      mgrFeedback: 'Elevated the product look-and-feel to world-class enterprise tier.',
      finalScore: 4.85,
      status: ReviewStatus.COMPLETED,
    },
  ];

  for (const rev of reviewsData) {
    const emp = employees[rev.email];
    if (emp) {
      await prisma.performanceReview.upsert({
        where: {
          cycleId_employeeId: {
            cycleId: rev.cycleId,
            employeeId: emp.id,
          },
        },
        update: {},
        create: {
          cycleId: rev.cycleId,
          employeeId: emp.id,
          reviewerId: managerId,
          selfRating: rev.selfRating,
          selfAchievements: rev.selfAchieve,
          selfImprovements: rev.selfImprove,
          managerRating: rev.mgrRating,
          managerFeedback: rev.mgrFeedback,
          finalScore: rev.finalScore,
          status: rev.status,
        },
      });
    }
  }
  console.log('✅ Performance review cycles, goals, and appraisals seeded');

  // 13. System Audit Logs (20+ realistic SOC2 events)
  const auditLogsData = [
    { email: 'superadmin@ems.local', action: AuditAction.CREATE, type: 'USER', id: 'USR-SEED', details: { message: 'Super Administrator bootstrapped system credentials' }, ip: '192.168.1.1' },
    { email: 'hradmin@ems.local', action: AuditAction.CREATE, type: 'EMPLOYEE', id: 'EMP-2026-0004', details: { employeeNumber: 'EMP-2026-0004', name: 'Sadia Rahman', department: 'Engineering' }, ip: '192.168.1.15' },
    { email: 'manager@ems.local', action: AuditAction.UPDATE, type: 'LEAVE_REQUEST', id: 'LEV-REQ-001', details: { status: 'APPROVED', days: 3, approver: 'Shahriar Rahman' }, ip: '192.168.1.20' },
    { email: 'sophia.chen@ems.local', action: AuditAction.CREATE, type: 'PAYROLL_RUN', id: 'PAY-RUN-AUG26', details: { month: 8, year: 2026, totalDisbursement: 164000.0, status: 'APPROVED' }, ip: '192.168.1.25' },
    { email: 'superadmin@ems.local', action: AuditAction.UPDATE, type: 'AI_PROVIDER_CIRCUIT', id: 'CIRCUIT-GEMINI', details: { provider: 'gemini', state: 'CLOSED', failureCount: 0 }, ip: '192.168.1.1' },
    { email: 'auditor@ems.local', action: AuditAction.APPROVE, type: 'AUDIT_TRAIL_EXPORT', id: 'EXP-Q3-2026', details: { format: 'CSV', count: 1250, scope: 'COMPLIANCE_REVIEW' }, ip: '10.0.4.18' },
    { email: 'hradmin@ems.local', action: AuditAction.UPDATE, type: 'SALARY_STRUCTURE', id: 'standard-tech-structure', details: { updatedFields: ['taxWithholdingRate', 'medicalAllowance'] }, ip: '192.168.1.15' },
    { email: 'manager@ems.local', action: AuditAction.UPDATE, type: 'PERFORMANCE_REVIEW', id: 'REV-H2-004', details: { score: 4.85, status: 'COMPLETED' }, ip: '192.168.1.20' },
    { email: 'superadmin@ems.local', action: AuditAction.CREATE, type: 'CLOUD_DEPLOY', id: 'DEPLOY-REV-0009', details: { revision: 'ndems-app-00009-gqv', region: 'us-central1', traffic: '100%' }, ip: '127.0.0.1' },
    { email: 'sadia.rahman@ems.local', action: AuditAction.CREATE, type: 'ATTENDANCE_CHECKIN', id: 'ATT-2026-0924', details: { checkIn: '08:58:14', status: 'PRESENT', method: 'WEB_PORTAL' }, ip: '103.114.98.5' },
  ];

  // Sequence is NOT NULL UNIQUE: continue the chain after any existing rows.
  // (The API's audit service owns sequence assignment at runtime — worker 2.)
  const maxSeq = await prisma.auditLog.aggregate({ _max: { sequence: true } });
  let nextSeq = (maxSeq._max.sequence ?? 0) + 1;
  for (const al of auditLogsData) {
    const user = employees[al.email];
    await prisma.auditLog.create({
      data: {
        actorId: user ? user.userId : employees['superadmin@ems.local'].userId,
        actorEmail: al.email,
        action: al.action,
        entityType: al.type,
        entityId: al.id,
        afterState: al.details,
        ipAddress: al.ip,
        sequence: nextSeq++,
        schemeVersion: 1,
      },
    });
  }
  console.log(`✅ System audit logs seeded (${auditLogsData.length})`);

  // Go-live HIGH #8: re-sync employee_number_seq AFTER all rows are seeded.
  // The migration's setval runs at `migrate deploy` time — before these rows
  // exist — so on a fresh DB the sequence would sit at 0 and the first
  // app-created employee would re-issue a seeded EMP-YYYY-0001..0020 number
  // (UNIQUE violation). Floor at 999 (same as the migration) so the sequence
  // effectively starts at 1000; idempotent on re-runs.
  await prisma.$executeRawUnsafe(
    `SELECT setval('employee_number_seq', GREATEST(999, COALESCE((SELECT MAX(CAST(SUBSTRING("employeeNumber" FROM '[0-9]+$') AS INTEGER)) FROM "employees"), 0)))`,
  );
  console.log('✅ employee_number_seq re-synced above seeded employee numbers');

  console.log('🎉 Comprehensive database seed finished successfully with rich enterprise dummy data!');
  // Printed exactly ONCE. Valid only when superadmin@ems.local was created by
  // THIS run; re-runs never change existing credentials, so ignore this line
  // if the account already existed.
  console.log(`🔑 DEMO admin (superadmin@ems.local) password for fresh seeds: ${SEED_ADMIN_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error('❌ Error during seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
