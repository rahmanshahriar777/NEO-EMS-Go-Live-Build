import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

/**
 * B2 — invitation-based onboarding module.
 * Imports AuthModule for PasswordService (UserService not needed — the accept
 * flow writes through Prisma directly inside one transaction).
 */
@Module({
  imports: [AuthModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
