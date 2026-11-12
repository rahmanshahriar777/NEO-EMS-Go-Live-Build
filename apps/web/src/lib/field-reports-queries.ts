/**
 * TanStack Query hooks and mutation helpers for Field Reporting.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api-client';
import {
  FieldReportCategory,
  FieldReportStatus,
  FieldReportDownloadVariant,
  FieldReportReviewDecision,
  FieldMediaScanStatus,
  FieldMediaProcessingStatus,
  SystemRole,
} from '@ems/shared';

export interface FieldReportItem {
  id: string;
  reportNumber: string;
  employeeId: string;
  employee?: {
    id: string;
    firstName: string;
    lastName: string;
    employeeNumber: string;
    department?: { id: string; name: string };
  };
  siteId?: string;
  site?: { id: string; name: string; code?: string };
  category: FieldReportCategory;
  status: FieldReportStatus;
  currentRevisionNumber: number;
  latitude?: number;
  longitude?: number;
  gpsConsent: boolean;
  incidentAt?: string;
  submittedAt?: string;
  closedAt?: string;
  revisions: FieldReportRevisionDetail[];
  comments?: FieldReportCommentItem[];
  createdAt: string;
  updatedAt: string;
}

export interface FieldReportRevisionDetail {
  id: string;
  revisionNumber: number;
  title: string;
  notes?: string;
  isImmutable: boolean;
  status: FieldReportStatus;
  createdAt: string;
  attachments: FieldReportAttachmentDetail[];
  reviews?: FieldReportReviewDetail[];
}

export interface FieldReportAttachmentDetail {
  id: string;
  attachmentId?: string;
  storageKey?: string;
  mediaKind?: string;
  originalFileName?: string;
  fileName?: string;
  mimeType: string;
  fileSizeBytes?: number;
  byteSize?: number;
  checksumSha256?: string;
  sha256Checksum?: string;
  width?: number;
  height?: number;
  widthPx?: number;
  heightPx?: number;
  isImage?: boolean;
  scanStatus: FieldMediaScanStatus;
  scanThreats?: string[];
  scanFailureReason?: string;
  processingStatus: FieldMediaProcessingStatus;
  processingErrorCode?: string;
  processingError?: string;
  createdAt: string;
  derivatives?: FieldReportDerivativeDetail[];
}

export interface FieldReportDerivativeDetail {
  id: string;
  kind: 'THUMBNAIL' | 'WEB_PREVIEW' | 'RESIZED';
  storageKey: string;
  byteSize: number;
  width: number;
  height: number;
  mimeType: string;
}

export interface FieldReportReviewDetail {
  id: string;
  reviewerEmployeeId: string;
  reviewer?: { id: string; firstName: string; lastName: string };
  decision: FieldReportReviewDecision;
  comments?: string;
  delegatedFromEmployeeId?: string;
  createdAt: string;
}

export interface FieldReportCommentItem {
  id: string;
  authorEmployeeId: string;
  author?: { id: string; firstName: string; lastName: string };
  content: string;
  createdAt: string;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface FieldReportSite {
  id: string;
  name: string;
  code?: string;
  address?: string;
}

export interface FieldReportPolicyItem {
  id?: string;
  role?: SystemRole | string;
  roleName?: string;
  defaultDownloadVariant: FieldReportDownloadVariant;
  allowDownloadOriginal?: boolean;
  allowOriginalDownload?: boolean;
  updatedAt?: string;
}

export interface FieldReportDelegationItem {
  id: string;
  managerEmployeeId: string;
  manager?: { id: string; firstName: string; lastName: string };
  delegateEmployeeId: string;
  delegate?: { id: string; firstName: string; lastName: string };
  startsAt: string;
  expiresAt: string;
  reason?: string;
  revokedAt?: string;
}

// Queries
export function useMyFieldReportsQuery(params?: {
  page?: number;
  limit?: number;
  status?: string;
  category?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
}) {
  const query = new URLSearchParams();
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.status) query.set('status', params.status);
  if (params?.category) query.set('category', params.category);
  if (params?.fromDate) query.set('fromDate', params.fromDate);
  if (params?.toDate) query.set('toDate', params.toDate);
  if (params?.search) query.set('search', params.search);

  const qs = query.toString();
  return useQuery({
    queryKey: ['field-reports', 'my', qs],
    queryFn: () => api.get<PaginatedResult<FieldReportItem>>(`/field-reports/my${qs ? `?${qs}` : ''}`),
  });
}

export function useTeamFieldReportsQuery(params?: {
  page?: number;
  limit?: number;
  status?: string;
  category?: string;
  employeeId?: string;
  siteId?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
}) {
  const query = new URLSearchParams();
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.status) query.set('status', params.status);
  if (params?.category) query.set('category', params.category);
  if (params?.employeeId) query.set('employeeId', params.employeeId);
  if (params?.siteId) query.set('siteId', params.siteId);
  if (params?.fromDate) query.set('fromDate', params.fromDate);
  if (params?.toDate) query.set('toDate', params.toDate);
  if (params?.search) query.set('search', params.search);

  const qs = query.toString();
  return useQuery({
    queryKey: ['field-reports', 'team', qs],
    queryFn: () => api.get<PaginatedResult<FieldReportItem>>(`/field-reports/team${qs ? `?${qs}` : ''}`),
  });
}

export function useFieldReportQuery(id: string, options?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: ['field-reports', 'detail', id],
    queryFn: () => api.get<FieldReportItem>(`/field-reports/${id}`),
    enabled: Boolean(id),
    refetchInterval: options?.refetchInterval,
  });
}

export function useFieldReportSitesQuery() {
  return useQuery({
    queryKey: ['field-reports', 'sites'],
    queryFn: () => api.get<FieldReportSite[]>('/field-reports/sites'),
  });
}

export interface FieldReportPoliciesPayload {
  effectivePolicy?: {
    defaultDownloadVariant: FieldReportDownloadVariant;
    allowOriginalDownload: boolean;
    hasDownloadOriginalPermission: boolean;
    canDownloadOriginal: boolean;
    requireGpsForCategories?: string[];
  };
  policies: FieldReportPolicyItem[];
}

export function useFieldReportPoliciesQuery() {
  return useQuery({
    queryKey: ['field-reports', 'policies'],
    queryFn: async () => {
      const res = await api.get<FieldReportPoliciesPayload | FieldReportPolicyItem[]>('/field-reports/policies');
      if (Array.isArray(res)) return res;
      if (res && Array.isArray((res as any).policies)) return (res as any).policies as FieldReportPolicyItem[];
      return [];
    },
  });
}

export function useFieldReportDelegationsQuery(enabled = true) {
  return useQuery({
    queryKey: ['field-reports', 'delegations'],
    queryFn: () => api.get<FieldReportDelegationItem[]>('/field-reports/delegations'),
    enabled,
  });
}

// Mutations
export function useCreateFieldReportMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: {
      title: string;
      notes?: string;
      category: FieldReportCategory;
      siteId?: string;
      occurredAt?: string;
      incidentAt?: string;
      gpsConsent?: boolean;
      gpsConsentGranted?: boolean;
      latitude?: number;
      gpsLatitude?: number;
      longitude?: number;
      gpsLongitude?: number;
      accuracyMeters?: number;
      gpsAccuracyMeters?: number;
    }) => api.post<FieldReportItem>('/field-reports', dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['field-reports'] });
    },
  });
}

export function useUpdateRevisionMutation(reportId: string, revisionNumber: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: { title?: string; notes?: string }) =>
      api.put<FieldReportItem>(`/field-reports/${reportId}/revisions/${revisionNumber}`, dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['field-reports', 'detail', reportId] });
      queryClient.invalidateQueries({ queryKey: ['field-reports'] });
    },
  });
}

export function useSubmitRevisionMutation(reportId: string, revisionNumber: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<FieldReportItem>(`/field-reports/${reportId}/revisions/${revisionNumber}/submit`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['field-reports', 'detail', reportId] });
      queryClient.invalidateQueries({ queryKey: ['field-reports'] });
    },
  });
}

export function useReviewRevisionMutation(reportId: string, revisionNumber: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: { decision: FieldReportReviewDecision; comments?: string }) =>
      api.post<FieldReportItem>(`/field-reports/${reportId}/revisions/${revisionNumber}/review`, dto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['field-reports', 'detail', reportId] });
      queryClient.invalidateQueries({ queryKey: ['field-reports'] });
    },
  });
}

export function useAddCommentMutation(reportId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      api.post<FieldReportCommentItem>(`/field-reports/${reportId}/comments`, { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['field-reports', 'detail', reportId] });
    },
  });
}

export async function createUploadSession(
  reportId: string,
  revisionNumber: number,
  dto: {
    clientCaptureId: string;
    fileName: string;
    mimeType: string;
    byteSize: number;
    clientSha256: string;
    width?: number;
    height?: number;
    capturedAt?: string;
  },
): Promise<{ sessionId: string; chunkSize: number; totalChunks: number; expiresAt: string }> {
  return api.post<{ sessionId: string; chunkSize: number; totalChunks: number; expiresAt: string }>(
    `/field-reports/${reportId}/revisions/${revisionNumber}/upload-sessions`,
    {
      originalFileName: dto.fileName,
      fileName: dto.fileName,
      claimedMimeType: dto.mimeType,
      mimeType: dto.mimeType,
      declaredSizeBytes: dto.byteSize,
      byteSize: dto.byteSize,
      declaredSha256: dto.clientSha256,
      clientSha256: dto.clientSha256,
      clientCaptureId: dto.clientCaptureId,
      width: dto.width,
      height: dto.height,
      capturedAt: dto.capturedAt,
    },
  );
}

export async function uploadChunkBinary(
  sessionId: string,
  chunkIndex: number,
  data: Blob | Uint8Array,
  sha256Hex: string,
): Promise<{ chunkIndex: number; receivedBytes: number; acceptedSha256: string }> {
  return api.putBinary<{ chunkIndex: number; receivedBytes: number; acceptedSha256: string }>(
    `/field-reports/upload-sessions/${sessionId}/chunks/${chunkIndex}`,
    data,
    {
      headers: {
        'x-chunk-sha256': sha256Hex,
      },
    },
  );
}

export async function completeUploadSession(sessionId: string): Promise<FieldReportAttachmentDetail> {
  return api.post<FieldReportAttachmentDetail>(`/field-reports/upload-sessions/${sessionId}/complete`, {});
}

export async function mintDownloadGrant(
  attachmentId: string,
  variant: FieldReportDownloadVariant,
): Promise<{ grant: string; expiresAt: string; downloadUrl: string }> {
  return api.post<{ grant: string; expiresAt: string; downloadUrl: string }>(
    `/field-reports/attachments/${attachmentId}/download-token`,
    { variant },
  );
}

export async function mintZipGrant(
  reportId: string,
  revisionNumber: number,
  variant: FieldReportDownloadVariant,
): Promise<{ grant: string; expiresAt: string; downloadUrl: string; fileCount: number }> {
  return api.post<{ grant: string; expiresAt: string; downloadUrl: string; fileCount: number }>(
    `/field-reports/${reportId}/revisions/${revisionNumber}/zip-token`,
    { variant },
  );
}

