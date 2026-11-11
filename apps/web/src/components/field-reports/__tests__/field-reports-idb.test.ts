import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveDraft,
  getDraft,
  listDrafts,
  deleteDraft,
  queueOutboxFile,
  listOutboxFiles,
  updateOutboxFile,
  clearFieldReportsOutbox,
  LocalDraft,
  OutboxFile,
} from '../../../lib/field-reports-idb';

describe('field-reports-idb (offline storage & memory fallback)', () => {
  beforeEach(async () => {
    await clearFieldReportsOutbox();
  });

  it('saves and retrieves local drafts', async () => {
    const draft: LocalDraft = {
      localId: 'local-1',
      title: 'Generator inspection',
      notes: 'Oil leak observed on primary pump',
      category: 'EQUIPMENT_ISSUE',
      gpsConsent: true,
      latitude: 51.5074,
      longitude: -0.1278,
      accuracyMeters: 5,
      updatedAt: new Date().toISOString(),
    };

    await saveDraft(draft);
    const retrieved = await getDraft('local-1');

    expect(retrieved).toBeDefined();
    expect(retrieved?.title).toBe('Generator inspection');
    expect(retrieved?.latitude).toBe(51.5074);
  });

  it('lists all local drafts and deletes by ID', async () => {
    await saveDraft({
      localId: 'd1',
      title: 'Draft 1',
      notes: '',
      category: 'OTHER',
      gpsConsent: false,
      updatedAt: new Date().toISOString(),
    });
    await saveDraft({
      localId: 'd2',
      title: 'Draft 2',
      notes: '',
      category: 'SAFETY_INCIDENT',
      gpsConsent: false,
      updatedAt: new Date().toISOString(),
    });

    let drafts = await listDrafts();
    expect(drafts.length).toBe(2);

    await deleteDraft('d1');
    drafts = await listDrafts();
    expect(drafts.length).toBe(1);
    expect(drafts[0].localId).toBe('d2');
  });

  it('queues, updates, and filters outbox files', async () => {
    const fakeBlob = new Blob(['sample-image-bytes'], { type: 'image/jpeg' });
    const file: OutboxFile = {
      clientCaptureId: 'cap-1',
      localDraftId: 'draft-abc',
      fileName: 'photo1.jpg',
      mimeType: 'image/jpeg',
      byteSize: fakeBlob.size,
      clientSha256: 'deadbeef',
      capturedAt: new Date().toISOString(),
      blob: fakeBlob,
      status: 'QUEUED',
      uploadedBytes: 0,
      retryCount: 0,
    };

    await queueOutboxFile(file);
    let files = await listOutboxFiles('draft-abc');
    expect(files.length).toBe(1);
    expect(files[0].status).toBe('QUEUED');

    await updateOutboxFile('cap-1', {
      status: 'UPLOADING',
      uploadedBytes: 1024,
      sessionId: 'sess-123',
    });

    files = await listOutboxFiles('draft-abc');
    expect(files[0].status).toBe('UPLOADING');
    expect(files[0].uploadedBytes).toBe(1024);
    expect(files[0].sessionId).toBe('sess-123');
  });

  it('clearFieldReportsOutbox wipes all drafts and queued files (logout wipe)', async () => {
    await saveDraft({
      localId: 'd-logout',
      title: 'Secret report',
      notes: '',
      category: 'OTHER',
      gpsConsent: false,
      updatedAt: new Date().toISOString(),
    });
    await queueOutboxFile({
      clientCaptureId: 'cap-logout',
      localDraftId: 'd-logout',
      fileName: 'secret.jpg',
      mimeType: 'image/jpeg',
      byteSize: 100,
      clientSha256: '1234',
      capturedAt: new Date().toISOString(),
      blob: new Blob(['bytes']),
      status: 'QUEUED',
      uploadedBytes: 0,
      retryCount: 0,
    });

    await clearFieldReportsOutbox();

    const drafts = await listDrafts();
    const files = await listOutboxFiles();
    expect(drafts.length).toBe(0);
    expect(files.length).toBe(0);
  });
});

