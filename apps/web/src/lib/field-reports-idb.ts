/**
 * Offline IndexedDB Outbox for Field Reporting.
 *
 * Requirements:
 * - Database name: 'ems-field-reports-v1', version: 1
 * - Object stores:
 *   - 'drafts' (keyPath: 'localId')
 *   - 'outboxFiles' (keyPath: 'clientCaptureId')
 * - Safe fallback when IndexedDB is not available (SSR, private mode without storage)
 * - Zero caching of API responses (fulfills offline outbox requirement without caching /api/*)
 * - Wipe on logout (GDPR / shared device privacy)
 */

export interface LocalDraft {
  localId: string;
  reportId?: string; // remote report id if saved remotely
  revisionNumber?: number;
  title: string;
  notes: string;
  category: string;
  siteId?: string;
  incidentAt?: string;
  gpsConsent: boolean;
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  updatedAt: string;
}

export type OutboxFileStatus = 'QUEUED' | 'UPLOADING' | 'FAILED' | 'PAUSED_AUTH' | 'SYNCED';

export interface OutboxFile {
  clientCaptureId: string;
  localDraftId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  clientSha256: string; // SHA-256 hex string computed in browser
  capturedAt: string;
  blob: Blob; // Original full-resolution media blob
  status: OutboxFileStatus;
  sessionId?: string;
  uploadedBytes: number;
  lastAttemptAt?: string;
  lastError?: string;
  retryCount: number;
  attachmentId?: string;
}

const DB_NAME = 'ems-field-reports-v1';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function isIndexedDBAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function getDb(): Promise<IDBDatabase> {
  if (!isIndexedDBAvailable()) {
    return Promise.reject(new Error('IndexedDB is not available in this environment'));
  }
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('drafts')) {
          db.createObjectStore('drafts', { keyPath: 'localId' });
        }
        if (!db.objectStoreNames.contains('outboxFiles')) {
          const store = db.createObjectStore('outboxFiles', { keyPath: 'clientCaptureId' });
          store.createIndex('by_draft', 'localDraftId', { unique: false });
          store.createIndex('by_status', 'status', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error || new Error('Failed to open IndexedDB'));
      };
    });
  }
  return dbPromise;
}

// In-memory fallback if IndexedDB is unavailable
const memoryDrafts = new Map<string, LocalDraft>();
const memoryOutbox = new Map<string, OutboxFile>();

export async function saveDraft(draft: LocalDraft): Promise<void> {
  if (!isIndexedDBAvailable()) {
    memoryDrafts.set(draft.localId, draft);
    return;
  }
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite');
    const store = tx.objectStore('drafts');
    const req = store.put(draft);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getDraft(localId: string): Promise<LocalDraft | undefined> {
  if (!isIndexedDBAvailable()) {
    return memoryDrafts.get(localId);
  }
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readonly');
    const store = tx.objectStore('drafts');
    const req = store.get(localId);
    req.onsuccess = () => resolve(req.result || undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function listDrafts(): Promise<LocalDraft[]> {
  if (!isIndexedDBAvailable()) {
    return Array.from(memoryDrafts.values());
  }
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readonly');
    const store = tx.objectStore('drafts');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteDraft(localId: string): Promise<void> {
  if (!isIndexedDBAvailable()) {
    memoryDrafts.delete(localId);
    for (const [key, file] of memoryOutbox.entries()) {
      if (file.localDraftId === localId) memoryOutbox.delete(key);
    }
    return;
  }
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['drafts', 'outboxFiles'], 'readwrite');
    tx.objectStore('drafts').delete(localId);
    const fileStore = tx.objectStore('outboxFiles');
    const idx = fileStore.index('by_draft');
    const req = idx.openKeyCursor(IDBKeyRange.only(localId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        fileStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function queueOutboxFile(file: OutboxFile): Promise<void> {
  if (!isIndexedDBAvailable()) {
    memoryOutbox.set(file.clientCaptureId, file);
    return;
  }
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outboxFiles', 'readwrite');
    const store = tx.objectStore('outboxFiles');
    const req = store.put(file);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function listOutboxFiles(localDraftId?: string): Promise<OutboxFile[]> {
  if (!isIndexedDBAvailable()) {
    const files = Array.from(memoryOutbox.values());
    return localDraftId ? files.filter((f) => f.localDraftId === localDraftId) : files;
  }
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outboxFiles', 'readonly');
    const store = tx.objectStore('outboxFiles');
    if (localDraftId) {
      const idx = store.index('by_draft');
      const req = idx.getAll(IDBKeyRange.only(localDraftId));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    } else {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }
  });
}

export async function updateOutboxFile(
  clientCaptureId: string,
  patch: Partial<OutboxFile>,
): Promise<OutboxFile | undefined> {
  if (!isIndexedDBAvailable()) {
    const existing = memoryOutbox.get(clientCaptureId);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    memoryOutbox.set(clientCaptureId, updated);
    return updated;
  }
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outboxFiles', 'readwrite');
    const store = tx.objectStore('outboxFiles');
    const getReq = store.get(clientCaptureId);
    getReq.onsuccess = () => {
      const existing = getReq.result as OutboxFile | undefined;
      if (!existing) {
        resolve(undefined);
        return;
      }
      const updated: OutboxFile = { ...existing, ...patch };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(updated);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function deleteOutboxFile(clientCaptureId: string): Promise<void> {
  if (!isIndexedDBAvailable()) {
    memoryOutbox.delete(clientCaptureId);
    return;
  }
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outboxFiles', 'readwrite');
    const store = tx.objectStore('outboxFiles');
    const req = store.delete(clientCaptureId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Clear all stored drafts and outbox files on user sign-out. */
export async function clearFieldReportsOutbox(): Promise<void> {
  memoryDrafts.clear();
  memoryOutbox.clear();
  if (!isIndexedDBAvailable()) return;
  try {
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['drafts', 'outboxFiles'], 'readwrite');
      tx.objectStore('drafts').clear();
      tx.objectStore('outboxFiles').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Non-fatal if clearing fails during teardown
  }
}

