import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AvatarStorageService } from './avatar-storage.service';

/**
 * Object-storage module (avatars today; document-adjacent binaries later).
 * Imported by EmployeesModule per the wiring patch in the go-live report.
 */
@Module({
  imports: [ConfigModule],
  providers: [AvatarStorageService],
  exports: [AvatarStorageService],
})
export class StorageModule {}
