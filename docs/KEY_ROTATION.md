# NEO EMS — Encryption Key Rotation Procedure

Covers `DOCUMENT_ENCRYPTION_KEY` (AES-256-GCM document encryption) and the
JWT/S3/Redis secrets. Documents are encrypted per-object; each object carries
a `keyId` column identifying which key version encrypted it, so rotation is
online with no downtime.

## 1. Document encryption key rotation

### 1.1. Generate the new key

```bash
openssl rand -hex 32   # 64 hex chars = 32 bytes for AES-256-GCM
```

Record in the rotation log (date, keyId, operator, reason). Example keyIds:
`doc-enc-2026-10`, `doc-enc-2027-04`. KeyIds must be unique and monotonic.

### 1.2. Dual-key deployment

The document service must accept BOTH keys during rotation: `keyId` on each
object selects the decryption key; NEW uploads use the new key. Deploy the
new key as `DOCUMENT_ENCRYPTION_KEY` and keep the old key available as
`DOCUMENT_ENCRYPTION_KEY_PREVIOUS` (code support for `_PREVIOUS` is a Phase 1
documents-hardening item — confirm it exists before rotating).

### 1.3. Re-encrypt (background)

Run the re-encryption job (worker/maintenance): for each object whose
`keyId` != new keyId — download, decrypt with old key, re-encrypt with new
key, upload, update `keyId`. The job is idempotent and resumable; progress is
logged structurally. Verify with a random sample: download + decrypt +
checksum against the pre-rotation manifest.

### 1.4. Promote and retire

1. Confirm zero objects remain on the old `keyId`
   (`SELECT keyId, COUNT(*) FROM documents GROUP BY keyId;`).
2. Remove `DOCUMENT_ENCRYPTION_KEY_PREVIOUS` from secrets; redeploy.
3. Securely destroy the old key material (secret manager version deletion).
4. Update the rotation log. Note: backups taken before rotation can only be
   restored with the key that was active when taken — annotate backup files
   with the active `keyId`.

### 1.5. Emergency rotation (suspected compromise)

Same as above, but ALSO: rotate `JWT_ACCESS_SECRET` (invalidates all
sessions — users re-login), rotate S3 credentials, and treat any document
downloaded during the exposure window as potentially disclosed (notify DPO).

## 2. JWT secret rotation

1. Generate new `JWT_ACCESS_SECRET`.
2. Deploy: all API replicas must switch atomically (rolling update is fine —
   in-flight access tokens up to 15 min old will 401 and clients refresh).
3. Old refresh-token families: the rotation invalidates them; users sign in
   again. Announce a maintenance window for large deployments.

## 3. S3 / Redis credential rotation

1. Create new credentials alongside the old (MinIO: new service account;
   Redis: `CONFIG SET requirepass` supports a single password — schedule a
   brief restart).
2. Update `ems-secrets` (k8s) or `.env.production` (compose); rolling restart.
3. Delete old credentials; verify with the fail-closed boot check.

## 4. Rotation cadence (documented assumptions — confirm with security)

- Document encryption key: every 12 months, or on personnel change / incident.
- JWT secrets: every 6 months.
- S3/Redis credentials: every 6 months.
- Backups of keys: secret-manager versioning; never in git, chat, or tickets.
