'use client';

import React, { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Camera,
  Paperclip,
  MapPin,
  Calendar,
  AlertCircle,
  CheckCircle2,
  X,
  UploadCloud,
  FileText,
  Shield,
  ArrowLeft,
} from 'lucide-react';
import {
  FieldReportCategory,
  FIELD_REPORT_ALLOWED_MIMES,
  FIELD_REPORT_LIMITS,
  FIELD_REPORT_INPUT_ACCEPT,
} from '@ems/shared';
import {
  useCreateFieldReportMutation,
  useSubmitRevisionMutation,
  useFieldReportSitesQuery,
  FieldReportSite,
} from '../../../../lib/field-reports-queries';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import {
  saveDraft,
  queueOutboxFile,
  LocalDraft,
  OutboxFile,
} from '../../../../lib/field-reports-idb';
import '../../../../styles/field-reports.css';

interface SelectedMedia {
  id: string;
  file: File;
  previewUrl?: string;
  sha256Hex: string;
  isImage: boolean;
}

async function computeSha256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export default function NewFieldReportPage() {
  const router = useRouter();
  const createMutation = useCreateFieldReportMutation();
  const { data: sites } = useFieldReportSitesQuery();

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<FieldReportCategory>(FieldReportCategory.SITE_INSPECTION);
  const [siteId, setSiteId] = useState('');
  const [incidentAt, setIncidentAt] = useState(new Date().toISOString().slice(0, 16));
  const [notes, setNotes] = useState('');

  // GPS state
  const [gpsConsent, setGpsConsent] = useState(false);
  const [coords, setCoords] = useState<{
    latitude: number;
    longitude: number;
    accuracyMeters?: number;
  } | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);

  // Files
  const [mediaList, setMediaList] = useState<SelectedMedia[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  const handleGpsToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    setGpsConsent(checked);
    setGpsError(null);

    if (checked) {
      if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setCoords({
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracyMeters: pos.coords.accuracy,
            });
          },
          (err) => {
            setGpsError(`Could not obtain GPS location: ${err.message}`);
            setCoords(null);
          },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
        );
      } else {
        setGpsError('Geolocation is not supported by your browser.');
      }
    } else {
      setCoords(null);
    }
  };

  const handleFileSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setFileError(null);

    if (mediaList.length + files.length > FIELD_REPORT_LIMITS.maxFilesPerRevision) {
      setFileError(`Maximum ${FIELD_REPORT_LIMITS.maxFilesPerRevision} files per report allowed.`);
      return;
    }

    const additions: SelectedMedia[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (file.size > FIELD_REPORT_LIMITS.maxFileSizeBytes) {
        setFileError(`File "${file.name}" exceeds the 50 MiB per-file limit.`);
        continue;
      }

      const isImage = file.type.startsWith('image/');
      const sha256Hex = await computeSha256(file);
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;

      additions.push({
        id: crypto.randomUUID(),
        file,
        previewUrl,
        sha256Hex,
        isImage,
      });
    }

    setMediaList((prev) => [...prev, ...additions]);
  };

  const handleRemoveMedia = (id: string) => {
    setMediaList((prev) => {
      const item = prev.find((m) => m.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((m) => m.id !== id);
    });
  };

  const handleSubmit = async (shouldSubmit: boolean) => {
    if (!title.trim()) {
      setSubmitError('Title is required.');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    const localDraftId = crypto.randomUUID();

    try {
      // If online, create the report directly on the server
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        const report = await createMutation.mutateAsync({
          title: title.trim(),
          notes: notes.trim() || undefined,
          category,
          siteId: siteId || undefined,
          incidentAt: incidentAt ? new Date(incidentAt).toISOString() : undefined,
          gpsConsent,
          latitude: coords?.latitude,
          longitude: coords?.longitude,
          accuracyMeters: coords?.accuracyMeters,
        });

        // Queue selected files into outbox with the remote report ID
        const localDraft: LocalDraft = {
          localId: localDraftId,
          reportId: report.id,
          revisionNumber: report.currentRevisionNumber,
          title: title.trim(),
          notes: notes.trim(),
          category,
          siteId: siteId || undefined,
          incidentAt: incidentAt ? new Date(incidentAt).toISOString() : undefined,
          gpsConsent,
          latitude: coords?.latitude,
          longitude: coords?.longitude,
          accuracyMeters: coords?.accuracyMeters,
          updatedAt: new Date().toISOString(),
        };
        await saveDraft(localDraft);

        for (const item of mediaList) {
          const outboxFile: OutboxFile = {
            clientCaptureId: crypto.randomUUID(),
            localDraftId,
            fileName: item.file.name,
            mimeType: item.file.type || 'application/octet-stream',
            byteSize: item.file.size,
            clientSha256: item.sha256Hex,
            capturedAt: new Date().toISOString(),
            blob: item.file,
            status: 'QUEUED',
            uploadedBytes: 0,
            retryCount: 0,
          };
          await queueOutboxFile(outboxFile);
        }

        router.push(`/field-reports/${report.id}`);
      } else {
        // Offline: save fully to IndexedDB outbox
        const localDraft: LocalDraft = {
          localId: localDraftId,
          title: title.trim(),
          notes: notes.trim(),
          category,
          siteId: siteId || undefined,
          incidentAt: incidentAt ? new Date(incidentAt).toISOString() : undefined,
          gpsConsent,
          latitude: coords?.latitude,
          longitude: coords?.longitude,
          accuracyMeters: coords?.accuracyMeters,
          updatedAt: new Date().toISOString(),
        };
        await saveDraft(localDraft);

        for (const item of mediaList) {
          const outboxFile: OutboxFile = {
            clientCaptureId: crypto.randomUUID(),
            localDraftId,
            fileName: item.file.name,
            mimeType: item.file.type || 'application/octet-stream',
            byteSize: item.file.size,
            clientSha256: item.sha256Hex,
            capturedAt: new Date().toISOString(),
            blob: item.file,
            status: 'QUEUED',
            uploadedBytes: 0,
            retryCount: 0,
          };
          await queueOutboxFile(outboxFile);
        }

        alert('You are offline. Report draft saved to Outbox; media will upload once connection resumes.');
        router.push('/field-reports');
      }
    } catch (err: any) {
      setSubmitError(err?.message || 'Failed to save field report.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DashboardLayout title="New Field Report">
      <div className="field-reports-editorial-wrapper">
        <div className="fr-page max-w-3xl">
          <div className="flex items-center gap-3">
            <Link href="/field-reports" className="fr-btn-secondary p-2 min-h-10 min-w-10">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div>
              <h1 className="fr-title text-2xl">New Field Report</h1>
              <p className="fr-subtitle text-xs">Capture photos, documents, and observation details</p>
            </div>
          </div>

          {submitError && (
            <div className="p-3.5 rounded-xl bg-[#fef2f2] border border-[#fecaca] text-[#b42318] text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          <div className="fr-viewer-card space-y-6">
            {/* Core details */}
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-[#4a4642] mb-1.5">
                  Report Title *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Roof inspection after storm / Safety hazard near generator"
                  className="fr-input w-full font-medium"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-[#4a4642] mb-1.5">
                    Category *
                  </label>
                  <select
                    className="fr-input w-full"
                    value={category}
                    onChange={(e) => setCategory(e.target.value as FieldReportCategory)}
                  >
                    {Object.values(FieldReportCategory).map((cat) => (
                      <option key={cat} value={cat}>
                        {cat.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-[#4a4642] mb-1.5">
                    Site / Location (Optional)
                  </label>
                  <select
                    className="fr-input w-full"
                    value={siteId}
                    onChange={(e) => setSiteId(e.target.value)}
                  >
                    <option value="">No specific site</option>
                    {sites?.map((s: FieldReportSite) => (
                      <option key={s.id} value={s.id}>
                        {s.name} {s.code ? `(${s.code})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-[#4a4642] mb-1.5">
                  Incident / Observation Date & Time
                </label>
                <input
                  type="datetime-local"
                  className="fr-input w-full"
                  value={incidentAt}
                  onChange={(e) => setIncidentAt(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-[#4a4642] mb-1.5">
                  Notes & Field Observations
                </label>
                <textarea
                  rows={4}
                  placeholder="Detail what was observed, conditions, equipment serial numbers, or actions taken..."
                  className="fr-input w-full resize-y font-normal"
                  style={{ height: 'auto', padding: '10px 14px' }}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>

            {/* GPS Consent & Capture */}
            <div className="p-4 rounded-xl bg-[#faf9f7] border border-[#e2dfda] space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={gpsConsent}
                  onChange={handleGpsToggle}
                  className="mt-1 w-4 h-4 text-[#2c5f4a] rounded border-[#e2dfda] focus:ring-[#2c5f4a]"
                />
                <div>
                  <span className="text-sm font-semibold text-[#1a1816] block">
                    Include GPS Location with this report
                  </span>
                  <span className="text-xs text-[#6b6560] block mt-0.5">
                    Coordinates are preserved in the bit-exact original for incident verification and
                    automatically stripped from resized derivatives.
                  </span>
                </div>
              </label>

              {gpsConsent && (
                <div className="pt-2 border-t border-[#ece9e4]">
                  {coords ? (
                    <div className="flex items-center gap-2 text-xs font-mono text-[#2c7a4e] bg-[#e8f5ec] p-2.5 rounded-lg border border-[#cfe0d5]">
                      <MapPin className="w-4 h-4 text-[#2c7a4e] flex-shrink-0" />
                      <span>
                        Lat: {coords.latitude.toFixed(6)}, Lon: {coords.longitude.toFixed(6)}
                        {coords.accuracyMeters && ` (±${Math.round(coords.accuracyMeters)}m)`}
                      </span>
                    </div>
                  ) : gpsError ? (
                    <div className="flex items-center gap-2 text-xs text-[#b8860b] bg-[#fdf6e3] p-2.5 rounded-lg border border-[#f5d9a8]">
                      <AlertCircle className="w-4 h-4 text-[#b8860b] flex-shrink-0" />
                      <span>{gpsError}</span>
                    </div>
                  ) : (
                    <div className="text-xs text-[#6b6560] flex items-center gap-2">
                      <div className="w-3.5 h-3.5 border-2 border-[#2c5f4a] border-t-transparent rounded-full animate-spin" />
                      <span>Acquiring GPS coordinates...</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Media Attachments */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-[#1a1816]">Attachments & Media</h3>
                  <p className="text-xs text-[#6b6560]">
                    Full-resolution phone photos (EXIF preserved) or documents (PDF, DOCX, XLSX)
                  </p>
                </div>
                <span className="text-xs font-semibold text-[#8a857f] font-mono">
                  {mediaList.length} / {FIELD_REPORT_LIMITS.maxFilesPerRevision} files
                </span>
              </div>

              {fileError && (
                <div className="p-3 rounded-lg bg-[#fef2f2] border border-[#fecaca] text-[#b42318] text-xs">
                  {fileError}
                </div>
              )}

              {/* Action buttons with 40px touch targets */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  className="fr-btn-secondary justify-center text-[#2c5f4a] border-[#cfe0d5] hover:bg-[#e8f0ec]"
                >
                  <Camera className="w-4 h-4" />
                  <span>Take Photo (Camera)</span>
                </button>
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                  capture="environment"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFileSelect(e.target.files)}
                />

                <button
                  type="button"
                  onClick={() => docInputRef.current?.click()}
                  className="fr-btn-secondary justify-center text-[#4a4642]"
                >
                  <Paperclip className="w-4 h-4" />
                  <span>Attach File / Doc</span>
                </button>
                <input
                  ref={docInputRef}
                  type="file"
                  accept=".pdf,.docx,.xlsx,.pptx,.csv,.txt,image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFileSelect(e.target.files)}
                />
              </div>

              {/* Media previews */}
              {mediaList.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2">
                  {mediaList.map((m) => (
                    <div
                      key={m.id}
                      className="relative group border border-[#e2dfda] rounded-xl overflow-hidden bg-[#faf9f7] p-2.5 flex flex-col justify-between"
                    >
                      {m.previewUrl ? (
                        <div className="aspect-video w-full rounded-lg bg-[#f0eeea] overflow-hidden mb-2 relative">
                          <img
                            src={m.previewUrl}
                            alt={m.file.name}
                            className="w-full h-full object-cover"
                          />
                        </div>
                      ) : (
                        <div className="aspect-video w-full rounded-lg bg-[#f0eeea] flex items-center justify-center mb-2">
                          <FileText className="w-7 h-7 text-slate-400" />
                        </div>
                      )}

                      <div className="text-xs">
                        <p className="font-semibold text-[#1a1816] truncate" title={m.file.name}>
                          {m.file.name}
                        </p>
                        <p className="text-[#8a857f] font-mono text-[11px]">{(m.file.size / (1024 * 1024)).toFixed(1)} MB</p>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleRemoveMedia(m.id)}
                        className="absolute top-1.5 right-1.5 bg-[#1a1816]/75 text-white rounded-full p-1 hover:bg-[#1a1816] transition-colors"
                        title="Remove"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Submit Actions */}
            <div className="pt-4 border-t border-[#ece9e4] flex items-center justify-end gap-3">
              <Link href="/field-reports" className="fr-btn-secondary">
                Cancel
              </Link>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => handleSubmit(false)}
                className="fr-btn-secondary"
              >
                Save Draft
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => handleSubmit(true)}
                className="fr-btn-primary"
              >
                {isSubmitting ? (
                  <span className="flex items-center gap-2">
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Saving...
                  </span>
                ) : (
                  'Save & View Report'
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
