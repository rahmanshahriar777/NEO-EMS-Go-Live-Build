import { FieldReportCategory, FieldReportStatus } from '../enums/index.js';

/** Browser-safe Field Reporting limits and accept strings (zero Node/Prisma deps). */
export const FIELD_REPORT_LIMITS = {
  maxFileSizeBytes: 52_428_800, // 50 MiB
  maxFilesPerRevision: 20,
  maxTotalBytesPerRevision: 262_144_000, // 250 MiB
  chunkSizeBytes: 5_242_880, // 5 MiB
  maxInputPixels: 100_000_000, // 100 MP
  maxDimensionPx: 16_384,
} as const;

export const FIELD_REPORT_IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

export const FIELD_REPORT_DOCUMENT_MIMES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/plain',
] as const;

export const FIELD_REPORT_ALLOWED_MIMES: readonly string[] = [
  ...FIELD_REPORT_IMAGE_MIMES,
  ...FIELD_REPORT_DOCUMENT_MIMES,
];

export const FIELD_REPORT_INPUT_ACCEPT =
  'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx,application/vnd.openxmlformats-officedocument.presentationml.presentation,.pptx,text/csv,.csv,text/plain,.txt';

export const FIELD_REPORT_CATEGORY_LABELS: Record<FieldReportCategory, string> = {
  [FieldReportCategory.SITE_INSPECTION]: 'Site Inspection',
  [FieldReportCategory.INCIDENT_SAFETY]: 'Incident & Safety',
  [FieldReportCategory.CLIENT_VISIT]: 'Client Visit',
  [FieldReportCategory.EQUIPMENT_AUDIT]: 'Equipment Audit',
  [FieldReportCategory.DELIVERY_VERIFICATION]: 'Delivery Verification',
  [FieldReportCategory.MAINTENANCE]: 'Maintenance',
  [FieldReportCategory.OTHER]: 'Other',
};

export const FIELD_REPORT_STATUS_LABELS: Record<FieldReportStatus, string> = {
  [FieldReportStatus.DRAFT]: 'Draft',
  [FieldReportStatus.SUBMITTED]: 'Submitted',
  [FieldReportStatus.CHANGES_REQUESTED]: 'Changes Requested',
  [FieldReportStatus.APPROVED]: 'Approved',
  [FieldReportStatus.REJECTED]: 'Rejected',
};

export const GPS_CONSENT_POLICY_VERSION = 'v1-2026-11';

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(val >= 100 ? 0 : 1)} ${units[idx]}`;
}

