'use client';

import React, { useState, use, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Camera,
  ArrowLeft,
  Calendar,
  MapPin,
  Clock,
  User,
  Shield,
  Download,
  Archive,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  FileText,
  MessageSquare,
  Send,
  Eye,
  RefreshCw,
  ExternalLink,
  X,
  FileCheck2,
} from 'lucide-react';
import { useAuth } from '../../../../context/auth-context';
import {
  SystemRole,
  FieldReportStatus,
  FieldReportCategory,
  FieldReportDownloadVariant,
  FieldReportReviewDecision,
  FieldMediaScanStatus,
  FieldMediaProcessingStatus,
} from '@ems/shared';
import {
  useFieldReportQuery,
  useSubmitRevisionMutation,
  useReviewRevisionMutation,
  useAddCommentMutation,
  mintDownloadGrant,
  mintZipGrant,
  FieldReportAttachmentDetail,
} from '../../../../lib/field-reports-queries';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import { api } from '../../../../lib/api-client';
import '../../../../styles/field-reports.css';

export default function FieldReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { user, hasRole, hasPermission } = useAuth();

  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Review modal state
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [reviewDecision, setReviewDecision] = useState<FieldReportReviewDecision>(
    FieldReportReviewDecision.APPROVE,
  );
  const [reviewComments, setReviewComments] = useState('');
  const [reviewError, setReviewError] = useState<string | null>(null);

  // Comment state
  const [commentText, setCommentText] = useState('');

  // Fetch report with 4s polling
  const { data: report, isLoading, refetch } = useFieldReportQuery(id, {
    refetchInterval: 4000,
  });

  const submitRevisionMutation = useSubmitRevisionMutation(
    report?.id || '',
    report?.currentRevisionNumber || 1,
  );
  const reviewMutation = useReviewRevisionMutation(
    report?.id || '',
    report?.currentRevisionNumber || 1,
  );
  const addCommentMutation = useAddCommentMutation(report?.id || '');

  const activeRevisionNumber = selectedRevision ?? report?.currentRevisionNumber ?? 1;
  const currentRev = useMemo(() => {
    if (!report) return undefined;
    return (
      report.revisions.find((r) => r.revisionNumber === activeRevisionNumber) ||
      report.revisions[0]
    );
  }, [report, activeRevisionNumber]);

  const canDownloadOriginal =
    hasPermission('FIELD_REPORT:DOWNLOAD_ORIGINAL') ||
    hasRole(SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN, SystemRole.MANAGER);

  const isAuthor = user?.employeeId === report?.employeeId;
  const isManagerOrAdmin = hasRole(
    SystemRole.MANAGER,
    SystemRole.HR_ADMIN,
    SystemRole.SUPER_ADMIN,
  );

  const canReview =
    isManagerOrAdmin &&
    report?.status === FieldReportStatus.SUBMITTED &&
    currentRev?.revisionNumber === report?.currentRevisionNumber;

  const canSubmit =
    isAuthor &&
    (report?.status === FieldReportStatus.DRAFT ||
      report?.status === FieldReportStatus.CHANGES_REQUESTED);

  const allImagesReady = useMemo(() => {
    if (!currentRev?.attachments) return true;
    const images = currentRev.attachments.filter((a) => a.isImage);
    if (images.length === 0) return true;
    return images.every((a) => a.processingStatus === FieldMediaProcessingStatus.READY);
  }, [currentRev]);

  // Download single attachment
  const handleDownload = async (
    attachmentId: string,
    variant: FieldReportDownloadVariant,
  ) => {
    setDownloadingId(`${attachmentId}-${variant}`);
    setDownloadError(null);
    try {
      const grant = await mintDownloadGrant(attachmentId, variant);
      // Trigger browser download via minted signed grant URL
      const link = document.createElement('a');
      link.href = grant.downloadUrl;
      link.setAttribute('download', '');
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err: any) {
      setDownloadError(err?.message || 'Download failed');
    } finally {
      setDownloadingId(null);
    }
  };

  // Download bulk ZIP
  const handleZipDownload = async (variant: FieldReportDownloadVariant) => {
    if (!report || !currentRev) return;
    setDownloadingId(`zip-${variant}`);
    setDownloadError(null);
    try {
      const grant = await mintZipGrant(report.id, currentRev.revisionNumber, variant);
      const link = document.createElement('a');
      link.href = grant.downloadUrl;
      link.setAttribute('download', '');
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err: any) {
      setDownloadError(err?.message || 'Bulk ZIP download failed');
    } finally {
      setDownloadingId(null);
    }
  };

  // View image preview in lightbox
  const handleOpenPreview = async (att: FieldReportAttachmentDetail) => {
    try {
      const grant = await mintDownloadGrant(att.id, FieldReportDownloadVariant.RESIZED);
      setLightboxUrl(grant.downloadUrl);
    } catch {
      // Fallback to original if resized not available
      const grant = await mintDownloadGrant(att.id, FieldReportDownloadVariant.ORIGINAL);
      setLightboxUrl(grant.downloadUrl);
    }
  };

  const handleReviewSubmit = async () => {
    if (
      reviewDecision !== FieldReportReviewDecision.APPROVE &&
      !reviewComments.trim()
    ) {
      setReviewError('Comments are required when requesting changes or rejecting.');
      return;
    }
    setReviewError(null);
    try {
      await reviewMutation.mutateAsync({
        decision: reviewDecision,
        comments: reviewComments.trim() || undefined,
      });
      setShowReviewModal(false);
      setReviewComments('');
    } catch (err: any) {
      setReviewError(err?.message || 'Review failed.');
    }
  };

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    try {
      await addCommentMutation.mutateAsync(commentText.trim());
      setCommentText('');
    } catch (err: any) {
      alert(err?.message || 'Failed to post comment.');
    }
  };

  if (isLoading) {
    return (
      <div className="fr-page">
        <div className="text-center py-24 text-slate-500">Loading field report...</div>
      </div>
    );
  }

  if (!report) {
    return (
      <DashboardLayout title="Field Report Not Found">
        <div className="field-reports-editorial-wrapper">
          <div className="fr-page">
            <div className="fr-empty">
              <h2 className="fr-empty-title">Field Report Not Found</h2>
              <p className="fr-empty-sub">The requested field report could not be found or you do not have permission to view it.</p>
              <Link href="/field-reports" className="fr-btn-secondary mt-4">
                Back to Field Reports
              </Link>
            </div>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title={`${report.reportNumber} — Field Report`}>
      <div className="field-reports-editorial-wrapper">
        <div className="fr-page">
      {/* Top back navigation */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/field-reports" className="fr-btn-secondary p-2 min-h-10 min-w-10">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-bold text-slate-500">
                {report.reportNumber}
              </span>
              <span className={`fr-status-pill fr-status-${report.status}`}>
                {report.status.replace(/_/g, ' ')}
              </span>
            </div>
            <h1 className="fr-title text-xl mt-0.5">{currentRev?.title || 'Untitled Report'}</h1>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          {canSubmit && (
            <button
              onClick={() => submitRevisionMutation.mutate()}
              disabled={submitRevisionMutation.isPending}
              className="fr-btn-primary fr-touch-target"
            >
              <CheckCircle2 className="w-4 h-4" />
              Submit for Review
            </button>
          )}
          {canReview && (
            <button
              onClick={() => setShowReviewModal(true)}
              className="fr-btn-primary fr-touch-target bg-emerald-600 hover:bg-emerald-700"
            >
              <FileCheck2 className="w-4 h-4" />
              Review Report
            </button>
          )}
        </div>
      </div>

      {downloadError && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs">
          {downloadError}
        </div>
      )}

      {/* Revisions Bar (if multiple revisions exist) */}
      {report.revisions.length > 1 && (
        <div className="flex items-center gap-2 p-2 rounded-lg bg-slate-100 border border-slate-200 text-xs">
          <span className="font-bold text-slate-700 px-2">Revisions:</span>
          {report.revisions.map((rev) => (
            <button
              key={rev.id}
              onClick={() => setSelectedRevision(rev.revisionNumber)}
              className={`px-3 py-1 rounded font-medium ${
                rev.revisionNumber === activeRevisionNumber
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-slate-700 hover:bg-slate-200'
              }`}
            >
              Rev {rev.revisionNumber}
              {rev.revisionNumber === report.currentRevisionNumber ? ' (Current)' : ''}
            </button>
          ))}
        </div>
      )}

      {/* Main detail card */}
      <div className="fr-card p-6 space-y-6">
        {/* Metadata grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs">
          <div>
            <span className="text-slate-500 block uppercase font-bold text-[10px]">Submitter</span>
            <span className="font-semibold text-slate-800 text-sm mt-0.5 block">
              {report.employee?.firstName} {report.employee?.lastName}
            </span>
            <span className="text-slate-500">{report.employee?.department?.name || 'Field Ops'}</span>
          </div>
          <div>
            <span className="text-slate-500 block uppercase font-bold text-[10px]">Category</span>
            <span className="font-semibold text-slate-800 text-sm mt-0.5 block">
              {report.category.replace(/_/g, ' ')}
            </span>
          </div>
          <div>
            <span className="text-slate-500 block uppercase font-bold text-[10px]">Site Location</span>
            <span className="font-semibold text-slate-800 text-sm mt-0.5 block">
              {report.site?.name || 'Off-site / Field'}
            </span>
          </div>
          <div>
            <span className="text-slate-500 block uppercase font-bold text-[10px]">Date & Time</span>
            <span className="font-semibold text-slate-800 text-sm mt-0.5 block">
              {new Date(report.createdAt).toLocaleString()}
            </span>
          </div>
        </div>

        {/* GPS Privacy verification banner */}
        {report.gpsConsent && report.latitude !== undefined && report.longitude !== undefined && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
            <MapPin className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span>
              <strong>Verified Incident Location:</strong> Lat {report.latitude.toFixed(6)}, Lon{' '}
              {report.longitude.toFixed(6)}. (Preserved in Original download; automatically stripped from Resized downloads).
            </span>
          </div>
        )}

        {/* Notes */}
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-1">
            Field Notes & Observations
          </h3>
          <div className="p-4 rounded-lg bg-white border border-slate-200 text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
            {currentRev?.notes || 'No notes entered for this revision.'}
          </div>
        </div>

        {/* Attachments & Media Section */}
        <div className="space-y-4 pt-4 border-t border-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Attachments ({currentRev?.attachments?.length || 0})
              </h3>
              <p className="text-xs text-slate-500">
                Full-resolution originals and privacy-sanitized resized derivatives
              </p>
            </div>

            {/* Bulk ZIP downloads */}
            {currentRev?.attachments && currentRev.attachments.length > 0 && (
              <div className="flex items-center gap-2">
                {canDownloadOriginal && (
                  <button
                    onClick={() => handleZipDownload(FieldReportDownloadVariant.ORIGINAL)}
                    disabled={downloadingId === `zip-${FieldReportDownloadVariant.ORIGINAL}`}
                    className="fr-btn-secondary text-xs h-9 min-h-9"
                    title="Download all attachments bit-exact in a streamed ZIP"
                  >
                    <Archive className="w-3.5 h-3.5" />
                    ZIP (Original)
                  </button>
                )}
                <button
                  onClick={() => handleZipDownload(FieldReportDownloadVariant.RESIZED)}
                  disabled={
                    !allImagesReady ||
                    downloadingId === `zip-${FieldReportDownloadVariant.RESIZED}`
                  }
                  className="fr-btn-secondary text-xs h-9 min-h-9"
                  title={
                    allImagesReady
                      ? 'Download all images resized (GPS stripped) in a streamed ZIP'
                      : 'Disabled until all image derivatives finish processing'
                  }
                >
                  <Archive className="w-3.5 h-3.5" />
                  ZIP (Resized)
                </button>
              </div>
            )}
          </div>

          {/* Attachment Cards */}
          {currentRev?.attachments && currentRev.attachments.length > 0 ? (
            <div className="space-y-3">
              {currentRev.attachments.map((att) => {
                const isScanning = att.scanStatus === FieldMediaScanStatus.PENDING_SCAN;
                const isInfected = att.scanStatus === FieldMediaScanStatus.INFECTED;
                const isProcessing =
                  att.isImage &&
                  (att.processingStatus === FieldMediaProcessingStatus.PENDING ||
                    att.processingStatus === FieldMediaProcessingStatus.PROCESSING);
                const isReady =
                  !att.isImage || att.processingStatus === FieldMediaProcessingStatus.READY;

                return (
                  <div
                    key={att.id}
                    className="p-4 rounded-xl border border-slate-200 bg-white hover:border-slate-300 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      {att.isImage ? (
                        <div
                          onClick={() => handleOpenPreview(att)}
                          className="w-14 h-14 rounded-lg bg-slate-100 border border-slate-200 flex-shrink-0 flex items-center justify-center cursor-pointer hover:opacity-80 overflow-hidden"
                          title="Click to preview"
                        >
                          <Camera className="w-6 h-6 text-slate-400" />
                        </div>
                      ) : (
                        <div className="w-14 h-14 rounded-lg bg-slate-100 border border-slate-200 flex-shrink-0 flex items-center justify-center">
                          <FileText className="w-6 h-6 text-slate-400" />
                        </div>
                      )}

                      <div className="min-w-0">
                        <h4 className="text-sm font-bold text-slate-900 truncate" title={att.fileName}>
                          {att.fileName}
                        </h4>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-0.5">
                          <span>{(att.byteSize / (1024 * 1024)).toFixed(2)} MB</span>
                          <span>•</span>
                          <span className="font-mono text-[10px] text-slate-400 truncate max-w-[150px]">
                            SHA: {att.sha256Checksum.slice(0, 12)}…
                          </span>
                        </div>

                        {/* Status Badges */}
                        <div className="flex flex-wrap items-center gap-2 mt-2">
                          {isScanning ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                              <RefreshCw className="w-3 h-3 animate-spin" /> Scanning (ClamAV)...
                            </span>
                          ) : isInfected ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-700 bg-red-50 px-2 py-0.5 rounded border border-red-200">
                              <AlertTriangle className="w-3 h-3" /> Malware Detected:{' '}
                              {att.scanFailureReason || 'Infected'}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                              <CheckCircle2 className="w-3 h-3" /> Clean
                            </span>
                          )}

                          {att.isImage &&
                            (isProcessing ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                                <RefreshCw className="w-3 h-3 animate-spin" /> Resizing...
                              </span>
                            ) : isReady ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-700 bg-slate-100 px-2 py-0.5 rounded">
                                Resized Ready
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-700 bg-red-50 px-2 py-0.5 rounded border border-red-200">
                                Resizing Failed
                              </span>
                            ))}
                        </div>
                      </div>
                    </div>

                    {/* Download Buttons */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {att.isImage && (
                        <button
                          type="button"
                          onClick={() => handleOpenPreview(att)}
                          className="fr-btn-secondary text-xs h-9 min-h-9"
                          title="Preview in browser"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Preview
                        </button>
                      )}

                      {/* Download Resized: disabled until derivatives are ready */}
                      {att.isImage ? (
                        <button
                          type="button"
                          disabled={
                            !isReady ||
                            isInfected ||
                            downloadingId === `${att.id}-${FieldReportDownloadVariant.RESIZED}`
                          }
                          onClick={() =>
                            handleDownload(att.id, FieldReportDownloadVariant.RESIZED)
                          }
                          className="fr-btn-secondary text-xs h-9 min-h-9"
                          title={
                            isReady
                              ? 'Download Resized (EXIF/GPS stripped)'
                              : 'Generating resized image...'
                          }
                        >
                          <Download className="w-3.5 h-3.5 text-blue-600" />
                          {isReady ? 'Resized' : 'Processing...'}
                        </button>
                      ) : null}

                      {/* Download Original: gated by permission */}
                      {canDownloadOriginal && (
                        <button
                          type="button"
                          disabled={
                            isInfected ||
                            downloadingId === `${att.id}-${FieldReportDownloadVariant.ORIGINAL}`
                          }
                          onClick={() =>
                            handleDownload(att.id, FieldReportDownloadVariant.ORIGINAL)
                          }
                          className="fr-btn-secondary text-xs h-9 min-h-9 font-semibold text-slate-800"
                          title="Download bit-exact Original with full EXIF intact"
                        >
                          <Download className="w-3.5 h-3.5" />
                          {att.isImage ? 'Original' : 'Download'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 bg-slate-50 rounded-lg text-xs text-slate-500">
              No attachments uploaded for this revision.
            </div>
          )}
        </div>

        {/* Comments & Audit Trail */}
        <div className="space-y-4 pt-4 border-t border-slate-200">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-blue-600" />
            Comments & Review History
          </h3>

          {/* Past reviews */}
          {currentRev?.reviews && currentRev.reviews.length > 0 && (
            <div className="space-y-2">
              {currentRev.reviews.map((rev) => (
                <div
                  key={rev.id}
                  className={`p-3 rounded-lg border text-xs ${
                    rev.decision === FieldReportReviewDecision.APPROVE
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      : rev.decision === FieldReportReviewDecision.REQUEST_CHANGES
                      ? 'bg-amber-50 border-amber-200 text-amber-900'
                      : 'bg-red-50 border-red-200 text-red-900'
                  }`}
                >
                  <div className="flex items-center justify-between font-bold mb-1">
                    <span>
                      {rev.decision.replace(/_/g, ' ')} by {rev.reviewer?.firstName}{' '}
                      {rev.reviewer?.lastName}
                    </span>
                    <span className="font-normal text-[11px]">
                      {new Date(rev.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {rev.comments && <p className="mt-1">{rev.comments}</p>}
                </div>
              ))}
            </div>
          )}

          {/* Comments list */}
          {report.comments && report.comments.length > 0 && (
            <div className="space-y-2">
              {report.comments.map((c) => (
                <div key={c.id} className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs">
                  <div className="flex items-center justify-between text-slate-500 mb-1">
                    <span className="font-semibold text-slate-800">
                      {c.author?.firstName} {c.author?.lastName}
                    </span>
                    <span>{new Date(c.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="text-slate-800 whitespace-pre-wrap">{c.content}</p>
                </div>
              ))}
            </div>
          )}

          {/* Post comment form */}
          <form onSubmit={handleAddComment} className="flex gap-2">
            <input
              type="text"
              placeholder="Add a comment or follow-up note..."
              className="fr-input flex-1"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
            />
            <button
              type="submit"
              disabled={!commentText.trim() || addCommentMutation.isPending}
              className="fr-btn-secondary fr-touch-target"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>

      {/* Lightbox dialog */}
      {lightboxUrl && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightboxUrl(null)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] bg-slate-900 rounded-xl overflow-hidden p-2"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setLightboxUrl(null)}
              className="absolute top-4 right-4 z-10 bg-black/60 text-white rounded-full p-2 hover:bg-black"
            >
              <X className="w-5 h-5" />
            </button>
            <img
              src={lightboxUrl}
              alt="Preview"
              className="max-h-[85vh] w-auto mx-auto object-contain rounded"
            />
          </div>
        </div>
      )}

      {/* Review Modal */}
      {showReviewModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-slate-900">Review Field Report</h2>
              <button
                onClick={() => setShowReviewModal(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {reviewError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs">
                {reviewError}
              </div>
            )}

            <div className="space-y-3">
              <label className="block text-xs font-bold uppercase text-slate-700">Decision</label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setReviewDecision(FieldReportReviewDecision.APPROVE)}
                  className={`p-2.5 rounded-lg border text-xs font-bold text-center ${
                    reviewDecision === FieldReportReviewDecision.APPROVE
                      ? 'bg-emerald-50 border-emerald-500 text-emerald-800 ring-2 ring-emerald-500/20'
                      : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => setReviewDecision(FieldReportReviewDecision.REQUEST_CHANGES)}
                  className={`p-2.5 rounded-lg border text-xs font-bold text-center ${
                    reviewDecision === FieldReportReviewDecision.REQUEST_CHANGES
                      ? 'bg-amber-50 border-amber-500 text-amber-800 ring-2 ring-amber-500/20'
                      : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Request Changes
                </button>
                <button
                  type="button"
                  onClick={() => setReviewDecision(FieldReportReviewDecision.REJECT)}
                  className={`p-2.5 rounded-lg border text-xs font-bold text-center ${
                    reviewDecision === FieldReportReviewDecision.REJECT
                      ? 'bg-red-50 border-red-500 text-red-800 ring-2 ring-red-500/20'
                      : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Reject
                </button>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase text-slate-700 mb-1">
                  Comments {reviewDecision !== FieldReportReviewDecision.APPROVE ? '*' : '(Optional)'}
                </label>
                <textarea
                  rows={4}
                  placeholder={
                    reviewDecision === FieldReportReviewDecision.APPROVE
                      ? 'Optional approval notes...'
                      : 'Explain what changes are needed or reason for rejection...'
                  }
                  className="fr-input w-full"
                  value={reviewComments}
                  onChange={(e) => setReviewComments(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowReviewModal(false)}
                className="fr-btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={reviewMutation.isPending}
                onClick={handleReviewSubmit}
                className="fr-btn-primary"
              >
                {reviewMutation.isPending ? 'Submitting...' : 'Confirm Decision'}
              </button>
            </div>
          </div>
        </div>
      )}
        </div>
      </div>
    </DashboardLayout>
  );
}
