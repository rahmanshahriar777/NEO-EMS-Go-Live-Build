import { Injectable, Logger } from '@nestjs/common';
import {
  ChunkedCipherService,
  EncryptionKeyRing,
  MinioVaultClient,
  loadEncryptionKeyRingFromEnv,
  loadMinioConfigFromEnv,
} from '@ems/storage';

@Injectable()
export class FieldReportsStorageService {
  private readonly logger = new Logger(FieldReportsStorageService.name);
  private cipherInstance: ChunkedCipherService | null = null;
  private vaultInstance: MinioVaultClient | null = null;

  get cipher(): ChunkedCipherService {
    if (!this.cipherInstance) {
      const ring: EncryptionKeyRing = loadEncryptionKeyRingFromEnv(process.env);
      this.cipherInstance = new ChunkedCipherService(ring);
    }
    return this.cipherInstance;
  }

  get vault(): MinioVaultClient {
    if (!this.vaultInstance) {
      const cfg = loadMinioConfigFromEnv(process.env);
      this.vaultInstance = new MinioVaultClient(cfg);
      this.logger.log(`Initialized MinIO vault client for bucket '${cfg.bucket}'`);
    }
    return this.vaultInstance;
  }
}

