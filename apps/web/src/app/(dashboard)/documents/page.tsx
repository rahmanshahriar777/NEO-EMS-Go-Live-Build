'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { FileText, Upload, Download, Trash2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { requireApiBaseUrl } from '../../../lib/env';
import { ErrorBanner } from '../../../components/ui/error-banner';
import { SkeletonCardGrid } from '../../../components/ui/skeleton';
import { PaginationControls } from '../../../components/ui/pagination';
import { useAuth } from '../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import '../../../styles/documents.css';

interface DocumentItem {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  category: string;
  employeeId?: string;
  uploadedById?: string;
  createdAt: string;
  // Extended fields (document lifecycle): expiry + policy acknowledgement
  // are forwarded to /documents/upload when the API supports them; the API
  // ignores unknown fields otherwise (documented, not fabricated).
  expiresAt?: string | null;
  requiresAcknowledgement?: boolean;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
}

const CATEGORIES = ['ALL', 'GENERAL', 'RESUME', 'CONTRACT', 'POLICY', 'CERTIFICATE', 'ID_PROOF', 'OTHER'];
const PAGE_SIZE = 12;

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function expiryState(expiresAt?: string | null): { label: string; cls: string } | null {
  if (!expiresAt) return null;
  const d = new Date(expiresAt);
  if (isNaN(d.getTime())) return null;
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
  if (days < 0) return { label: `Expired ${d.toLocaleDateString()}`, cls: 'doc-expiry-overdue' };
  if (days <= 30) return { label: `Expires in ${days}d`, cls: 'doc-expiry-soon' };
  return { label: `Valid until ${d.toLocaleDateString()}`, cls: 'doc-expiry-ok' };
}

/**
 * Documents workspace (Phase 2 item 7): upload/browse, categories, expiry
 * dates, policy acknowledgement.
 *
 * API surface used:
 *   GET    /documents?category=&page=&limit=   (exists)
 *   POST   /documents/upload  (multipart: file, title, category, employeeId,
 *                              expiresAt — exists; expiresAt is forwarded and
 *                              persisted when the API supports it)
 *   DELETE /documents/:id                      (exists — soft delete)
 *   GET    /documents/:id/download              (Phase 1 B5 — decrypting
 *                              AES-256-GCM download; failures surface loudly
 *                              with the real error below)
 *   POST   /documents/:id/acknowledge           (policy acknowledgement)
 */
export default function DocumentsPage() {
  const { hasRole } = useAuth();
  const canUpload = hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.MANAGER, SystemRole.EMPLOYEE);

  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState('ALL');
  const [search, setSearch] = useState('');

  const [showUpload, setShowUpload] = useState(false);
  const [upFile, setUpFile] = useState<File | null>(null);
  const [upTitle, setUpTitle] = useState('');
  const [upCategory, setUpCategory] = useState('GENERAL');
  const [upExpiry, setUpExpiry] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchDocs = useCallback(async (pageToLoad: number, cat: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getPaginated<DocumentItem>('/documents', {
        params: {
          page: pageToLoad,
          limit: PAGE_SIZE,
          category: cat === 'ALL' ? undefined : cat,
        },
      });
      setDocs(res.items);
      setTotal(res.total);
      setPage(res.page);
    } catch (err: any) {
      setError(err?.message || 'Could not load documents.');
      setDocs([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDocs(1, category);
  }, [category, fetchDocs]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return docs;
    return docs.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        d.fileName.toLowerCase().includes(q) ||
        d.category.toLowerCase().includes(q),
    );
  }, [docs, search]);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!upFile) {
      setUploadError('Choose a file to upload.');
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append('file', upFile);
      form.append('title', upTitle.trim() || upFile.name);
      form.append('category', upCategory);
      // Expiry is forwarded to the upload endpoint; the API persists it when
      // the document-lifecycle fields are supported (documented, not
      // fabricated into the list).
      if (upExpiry) form.append('expiresAt', new Date(upExpiry).toISOString());

      const base = requireApiBaseUrl();
      const res = await fetch(`${base}/documents/upload`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.message || `Upload failed with status ${res.status}`);
      }
      setShowUpload(false);
      setUpFile(null);
      setUpTitle('');
      setUpExpiry('');
      setUpCategory('GENERAL');
      await fetchDocs(1, category);
    } catch (err: any) {
      setUploadError(err?.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (doc: DocumentItem) => {
    setBusyId(doc.id);
    setActionError(null);
    try {
      // Phase 1 B5: the API must decrypt AES-256-GCM and stream the file from
      // this endpoint. Worker 2 owns it; until it lands, a 404 surfaces here.
      await api.downloadFile(
        `/documents/${doc.id}/download`,
        doc.fileName || `${doc.title}.bin`,
      );
    } catch (err: any) {
      // Go-live §3.3: report the REAL failure. A 404 means the download
      // endpoint is not deployed; anything else (403, 5xx, decryption error,
      // network) is surfaced verbatim — never misattributed.
      const status = err?.status;
      const reason = err?.message || 'download failed';
      setActionError(
        status === 404
          ? `Could not download "${doc.title}": ${reason} (the download endpoint did not respond).`
          : `Could not download "${doc.title}": ${reason}`,
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (doc: DocumentItem) => {
    if (!window.confirm(`Delete "${doc.title}"? This is a soft delete.`)) return;
    setBusyId(doc.id);
    try {
      await api.delete(`/documents/${doc.id}`);
      await fetchDocs(page, category);
    } catch (err: any) {
      setActionError(`Could not delete "${doc.title}": ${err?.message || 'request failed'}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleAcknowledge = async (doc: DocumentItem) => {
    if (!window.confirm(`Confirm you have read and understood "${doc.title}"? This is recorded.`)) return;
    setBusyId(doc.id);
    setActionError(null);
    try {
      await api.post(`/documents/${doc.id}/acknowledge`, {});
      setDocs((prev) =>
        prev.map((d) => (d.id === doc.id ? { ...d, acknowledgedAt: new Date().toISOString() } : d)),
      );
    } catch (err: any) {
      // Report the real failure verbatim (see handleDownload above).
      setActionError(
        `Could not record acknowledgement: ${err?.message || 'request failed'}`,
      );
    } finally {
      setBusyId(null);
    }
  };

  const pendingAcks = docs.filter(
    (d) => d.category === 'POLICY' && d.requiresAcknowledgement !== false && !d.acknowledgedAt,
  );

  return (
    <DashboardLayout title="Documents Workspace">
      <div className="doc-page">
        <div className="doc-header">
          <div>
            <h1 className="doc-title">Documents Workspace</h1>
            <p className="doc-subtitle">
              Encrypted document vault. Browse by category, track expiry, and
              acknowledge policies. Downloads are decrypted server-side.
            </p>
          </div>
          {canUpload && (
            <button className="doc-btn doc-btn-primary" onClick={() => setShowUpload(true)}>
              <Upload className="w-4 h-4" />
              Upload document
            </button>
          )}
        </div>

        {pendingAcks.length > 0 && (
          <div className="doc-ack-banner" role="alert">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              <strong>{pendingAcks.length}</strong> polic
              {pendingAcks.length === 1 ? 'y' : 'ies'} awaiting your acknowledgement.
            </span>
          </div>
        )}

        {error && (
          <ErrorBanner resource="documents" detail={error} onRetry={() => fetchDocs(1, category)} retrying={loading} />
        )}
        {actionError && (
          <div className="doc-error" role="alert">
            {actionError}{' '}
            <button className="underline font-semibold" onClick={() => setActionError(null)}>
              Dismiss
            </button>
          </div>
        )}

        <div className="doc-toolbar">
          <input
            className="doc-search"
            placeholder="Search title, file name, category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search documents"
          />
          <select
            className="doc-select"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Filter by category"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c === 'ALL' ? 'All categories' : c}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <div aria-live="polite" aria-label="Loading documents">
            <SkeletonCardGrid cards={6} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="doc-empty">
            <FileText className="w-8 h-8 mx-auto mb-2 text-slate-300" />
            {error ? 'Documents could not be loaded.' : 'No documents match your filters.'}
          </div>
        ) : (
          <>
            <div className="doc-grid" aria-live="polite" aria-label="Documents list">
              {filtered.map((d) => {
                const exp = expiryState(d.expiresAt);
                const needsAck =
                  d.category === 'POLICY' && d.requiresAcknowledgement !== false && !d.acknowledgedAt;
                return (
                  <div key={d.id} className="doc-card">
                    <div className="doc-card-top">
                      <div className="doc-file-icon">
                        <FileText className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="doc-card-title">{d.title}</div>
                        <div className="doc-card-meta">
                          {d.fileName} · {formatSize(d.fileSize)}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`doc-cat ${
                          d.category === 'POLICY'
                            ? 'doc-cat-policy'
                            : d.category === 'CONTRACT'
                            ? 'doc-cat-contract'
                            : d.category === 'CERTIFICATE'
                            ? 'doc-cat-certificate'
                            : ''
                        }`}
                      >
                        {d.category}
                      </span>
                      {exp && <span className={`doc-expiry ${exp.cls}`}>{exp.label}</span>}
                      {d.acknowledgedAt && (
                        <span className="doc-expiry doc-expiry-ok inline-flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Acknowledged
                        </span>
                      )}
                    </div>
                    <div className="doc-card-actions">
                      <button
                        className="doc-btn doc-btn-ghost"
                        disabled={busyId === d.id}
                        onClick={() => handleDownload(d)}
                        aria-label={`Download ${d.title}`}
                      >
                        <Download className="w-3.5 h-3.5" aria-hidden="true" />
                        {busyId === d.id ? 'Working…' : 'Download'}
                      </button>
                      {needsAck && (
                        <button
                          className="doc-btn doc-btn-primary"
                          disabled={busyId === d.id}
                          onClick={() => handleAcknowledge(d)}
                          aria-label={`Acknowledge ${d.title}`}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                          Acknowledge
                        </button>
                      )}
                      {hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN) && (
                        <button
                          className="doc-btn doc-btn-danger"
                          disabled={busyId === d.id}
                          onClick={() => handleDelete(d)}
                          aria-label={`Delete ${d.title}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <PaginationControls
              page={page}
              limit={PAGE_SIZE}
              total={total}
              onPageChange={(p) => fetchDocs(p, category)}
            />
          </>
        )}

        {showUpload && (
          <div className="doc-modal-backdrop" onClick={() => setShowUpload(false)}>
            <div
              className="doc-modal"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label="Upload document"
            >
              <h3>Upload document</h3>
              <p className="doc-modal-sub">
                Files are encrypted server-side (AES-256-GCM) before storage.
              </p>
              {uploadError && <div className="doc-error" role="alert">{uploadError}</div>}
              <form onSubmit={handleUpload}>
                <div className="doc-form-group">
                  <label className="doc-label" htmlFor="up-file">File</label>
                  <input
                    id="up-file"
                    type="file"
                    className="doc-input"
                    onChange={(e) => setUpFile(e.target.files?.[0] || null)}
                    required
                  />
                </div>
                <div className="doc-form-group">
                  <label className="doc-label" htmlFor="up-title">Title</label>
                  <input
                    id="up-title"
                    className="doc-input"
                    value={upTitle}
                    onChange={(e) => setUpTitle(e.target.value)}
                    placeholder="Defaults to the file name"
                    maxLength={200}
                  />
                </div>
                <div className="doc-form-group">
                  <label className="doc-label" htmlFor="up-category">Category</label>
                  <select
                    id="up-category"
                    className="doc-input"
                    value={upCategory}
                    onChange={(e) => setUpCategory(e.target.value)}
                  >
                    {CATEGORIES.filter((c) => c !== 'ALL').map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div className="doc-form-group">
                  <label className="doc-label" htmlFor="up-expiry">
                    Expiry date <span className="text-slate-400 font-normal">(optional)</span>
                  </label>
                  <input
                    id="up-expiry"
                    type="date"
                    className="doc-input"
                    value={upExpiry}
                    onChange={(e) => setUpExpiry(e.target.value)}
                  />
                  <p className="text-[11px] text-slate-400 mt-1">
                    Expiry tracking is persisted when the API supports the
                    document-lifecycle fields.
                  </p>
                </div>
                <div className="flex gap-2 justify-end mt-4">
                  <button
                    type="button"
                    className="doc-btn doc-btn-ghost"
                    onClick={() => setShowUpload(false)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="doc-btn doc-btn-primary" disabled={uploading}>
                    {uploading ? 'Uploading…' : 'Upload'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
