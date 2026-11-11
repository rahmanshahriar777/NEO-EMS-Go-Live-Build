'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  listOutboxFiles,
  updateOutboxFile,
  OutboxFile,
  getDraft,
  deleteDraft,
} from '../../lib/field-reports-idb';
import {
  createUploadSession,
  uploadChunkBinary,
  completeUploadSession,
} from '../../lib/field-reports-queries';
import { ApiError } from '../../lib/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, RefreshCw } from 'lucide-react';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MiB

async function sha256OfChunk(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const OutboxRunner: React.FC = () => {
  const queryClient = useQueryClient();
  const [activeSyncing, setActiveSyncing] = useState(false);
  const [authPaused, setAuthPaused] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const isRunningRef = useRef(false);

  const drainOutbox = useCallback(async () => {
    if (isRunningRef.current) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    isRunningRef.current = true;
    setActiveSyncing(true);
    setSyncError(null);

    try {
      const files = await listOutboxFiles();
      const pendingFiles = files.filter(
        (f) => f.status === 'QUEUED' || f.status === 'UPLOADING' || f.status === 'FAILED',
      );

      for (const file of pendingFiles) {
        if (!navigator.onLine) break;

        const draft = await getDraft(file.localDraftId);
        if (!draft || !draft.reportId || !draft.revisionNumber) {
          // Draft has not been synced to a remote report ID yet
          continue;
        }

        try {
          await updateOutboxFile(file.clientCaptureId, {
            status: 'UPLOADING',
            lastAttemptAt: new Date().toISOString(),
          });

          // 1. Create upload session if needed
          let sessionId = file.sessionId;
          if (!sessionId) {
            const session = await createUploadSession(draft.reportId, draft.revisionNumber, {
              clientCaptureId: file.clientCaptureId,
              fileName: file.fileName,
              mimeType: file.mimeType,
              byteSize: file.byteSize,
              clientSha256: file.clientSha256,
              capturedAt: file.capturedAt,
            });
            sessionId = session.sessionId;
            await updateOutboxFile(file.clientCaptureId, { sessionId });
          }

          // 2. Upload chunks in 5 MiB slices
          const totalChunks = Math.ceil(file.byteSize / CHUNK_SIZE);
          let currentChunk = Math.floor(file.uploadedBytes / CHUNK_SIZE);

          while (currentChunk < totalChunks) {
            const start = currentChunk * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.byteSize);
            const chunkSlice = file.blob.slice(start, end);
            const chunkSha = await sha256OfChunk(chunkSlice);

            await uploadChunkBinary(sessionId, currentChunk, chunkSlice, chunkSha);
            currentChunk++;
            await updateOutboxFile(file.clientCaptureId, {
              uploadedBytes: Math.min(currentChunk * CHUNK_SIZE, file.byteSize),
            });
          }

          // 3. Complete session
          const attachment = await completeUploadSession(sessionId);
          await updateOutboxFile(file.clientCaptureId, {
            status: 'SYNCED',
            attachmentId: attachment?.attachmentId || attachment?.id,
          });

          // Check if all files for this draft are now SYNCED
          const filesNow = await listOutboxFiles();
          const draftFilesNow = filesNow.filter((f) => f.localDraftId === file.localDraftId);
          if (draft.reportId && draftFilesNow.every((f) => f.status === 'SYNCED')) {
            await deleteDraft(draft.localId);
          }

          queryClient.invalidateQueries({ queryKey: ['field-reports'] });
        } catch (err: any) {
          if (err instanceof ApiError && err.status === 401) {
            setAuthPaused(true);
            await updateOutboxFile(file.clientCaptureId, {
              status: 'PAUSED_AUTH',
              lastError: 'Session expired. Please re-authenticate.',
            });
            break;
          }

          if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
            // Reset expired or invalidated session on outbox file
            await updateOutboxFile(file.clientCaptureId, {
              sessionId: undefined,
              uploadedBytes: 0,
            });
          }

          const message = err?.message || 'Upload failed';
          setSyncError(`File "${file.fileName}" failed: ${message}`);
          await updateOutboxFile(file.clientCaptureId, {
            status: 'FAILED',
            lastError: message,
            retryCount: (file.retryCount || 0) + 1,
          });
        }
      }
    } finally {
      isRunningRef.current = false;
      setActiveSyncing(false);
    }
  }, [queryClient]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Trigger outbox drain on online, focus, visibilitychange
    const onOnline = () => {
      setAuthPaused(false);
      drainOutbox();
    };
    const onFocus = () => drainOutbox();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') drainOutbox();
    };

    // Listen for service worker background sync event
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'EMS_FIELD_REPORTS_SYNC') {
        drainOutbox();
      }
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    navigator.serviceWorker?.addEventListener('message', onMessage);

    // Initial drain
    drainOutbox();

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
    };
  }, [drainOutbox]);

  if (authPaused) {
    return (
      <div
        role="alert"
        className="fixed bottom-4 right-4 z-50 flex items-center gap-3 bg-amber-500 text-slate-950 px-4 py-3 rounded-lg shadow-lg border border-amber-400 text-sm font-medium"
      >
        <AlertCircle className="w-5 h-5 flex-shrink-0" />
        <div>
          <span>Field report sync paused: session expired. Please sign in again.</span>
        </div>
      </div>
    );
  }

  if (activeSyncing) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed bottom-4 right-4 z-50 flex items-center gap-2 bg-slate-900 text-white px-3 py-2 rounded-lg shadow-md border border-slate-700 text-xs"
      >
        <RefreshCw className="w-4 h-4 animate-spin text-blue-400" />
        <span>Uploading field media...</span>
      </div>
    );
  }

  return null;
};

