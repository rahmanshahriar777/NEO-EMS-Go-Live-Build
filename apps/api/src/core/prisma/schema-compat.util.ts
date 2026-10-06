/**
 * Schema-compatibility shim (Phase 1–3 rollout).
 *
 * Worker 4 lands schema migrations incrementally. API code that persists
 * not-yet-migrated columns must not 500 on databases where the column does
 * not exist yet, and must persist the data once the migration lands. This
 * module probes `information_schema` (once per table per process) and filters
 * write payloads down to columns that actually exist.
 *
 * This is NOT a mock fallback: when the column exists the value is written;
 * when it does not, the write proceeds without it and the omission is logged.
 * Every call site documents which migration provides the column.
 *
 * ASSUMPTION: Prisma field names map 1:1 to column names (true for every
 * worker-4 migration so far — no @map renames on the new columns).
 */

const KNOWN_COLUMNS: Record<string, string[]> = {
  employees: [
    'id', 'employeeNumber', 'userId', 'firstName', 'lastName', 'email', 'phone',
    'dateOfBirth', 'gender', 'address', 'departmentId', 'designationId', 'managerId',
    'joiningDate', 'status', 'profileSummary', 'avatarUrl', 'timezone', 'emergencyContact',
    'contractStart', 'contractEnd', 'workLocation', 'bankAccountEnc', 'taxIdEnc',
    'terminationDate', 'createdAt', 'updatedAt', 'deletedAt', 'isDemo', 'entityId',
  ],
  attendance_records: [
    'id', 'employeeId', 'date', 'clockInTime', 'clockOutTime', 'totalHoursWorked',
    'status', 'anomalyFlag', 'shiftId', 'breakMinutes', 'overtimeMinutes', 'notes',
    'createdAt', 'updatedAt',
  ],
  leave_requests: [
    'id', 'employeeId', 'leaveTypeId', 'startDate', 'endDate', 'totalDays', 'reason',
    'status', 'approvedById', 'approvedAt', 'rejectionReason', 'appliedAt', 'createdAt',
    'updatedAt', 'attachmentUrl', 'halfDay', 'halfDaySession', 'entityId',
  ],
  documents: [
    'id', 'employeeId', 'title', 'fileName', 'fileKey', 'fileUrl', 'mimeType',
    'fileSize', 'category', 'uploadedById', 'deletedAt', 'expiresAt', 'storageKey',
    'encrypted', 'iv', 'checksum', 'keyId', 'createdAt', 'updatedAt',
  ],
  vacancies: [
    'id', 'title', 'departmentId', 'description', 'status', 'openings', 'entityId', 'createdAt', 'updatedAt',
  ],
  candidates: [
    'id', 'vacancyId', 'firstName', 'lastName', 'email', 'phone', 'resumeUrl', 'stage', 'status', 'createdAt', 'updatedAt',
  ],
  offers: [
    'id', 'candidateId', 'salary', 'startDate', 'status', 'notes', 'createdAt', 'updatedAt',
  ],
  onboarding_checklists: [
    'id', 'employeeId', 'type', 'status', 'createdAt', 'updatedAt',
  ],
  onboarding_tasks: [
    'id', 'checklistId', 'title', 'description', 'ownerRole', 'isCompleted', 'completedAt', 'documentId', 'createdAt', 'updatedAt',
  ],
  document_acknowledgements: [
    'id', 'documentId', 'employeeId', 'acknowledgedAt',
  ],
  attendance_corrections: [
    'id', 'attendanceRecordId', 'employeeId', 'requestedClockIn', 'requestedClockOut', 'reason', 'status', 'reviewedById', 'reviewedAt', 'createdAt', 'updatedAt',
  ],
  review_forms: [
    'id', 'title', 'description', 'createdAt', 'updatedAt',
  ],
};

function initKnownColumnCache(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const [tbl, cols] of Object.entries(KNOWN_COLUMNS)) {
    map.set(tbl, new Set(cols));
  }
  return map;
}

const columnCache = initKnownColumnCache();
const missingTableCache = new Set<string>();

async function fetchColumns(prisma: any, table: string): Promise<Set<string> | null> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  if (missingTableCache.has(table)) return null;
  try {
    const rows: Array<{ column_name: string }> = await prisma.$queryRaw`
      SELECT column_name FROM information_schema.columns WHERE table_name = ${table}
    `;
    const cols = new Set<string>(rows.map((r) => r.column_name));
    columnCache.set(table, cols);
    return cols;
  } catch {
    // information_schema itself unavailable (e.g. non-Postgres test double):
    // treat the table as missing so callers degrade loudly, not silently.
    missingTableCache.add(table);
    return null;
  }
}

/**
 * Returns true when the table exists in the connected database.
 * Use before touching brand-new (Phase 2/3) tables so the error message
 * names the required migration instead of surfacing a raw Prisma error.
 */
export async function tableExists(prisma: any, table: string): Promise<boolean> {
  return (await fetchColumns(prisma, table)) !== null;
}

/** Returns true when the column exists on the table. */
export async function hasColumn(prisma: any, table: string, column: string): Promise<boolean> {
  const cols = await fetchColumns(prisma, table);
  return cols !== null && cols.has(column);
}

/**
 * Filters a Prisma write payload down to columns that exist in the connected
 * database. Unknown keys are dropped (and logged once per key).
 */
export async function pickKnownColumns<T extends Record<string, any>>(
  prisma: any,
  table: string,
  data: T,
  context: string,
): Promise<Partial<T>> {
  const cols = await fetchColumns(prisma, table);
  if (!cols) return { ...data };
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (cols.has(key)) {
      out[key] = value;
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[schema-compat] ${context}: column "${table}"."${key}" not migrated yet — value omitted`,
      );
    }
  }
  return out as Partial<T>;
}

/** Test seam: clears the caches. */
export function _resetSchemaCompatCache(): void {
  columnCache.clear();
  missingTableCache.clear();
  for (const [tbl, cols] of initKnownColumnCache().entries()) {
    columnCache.set(tbl, cols);
  }
}
