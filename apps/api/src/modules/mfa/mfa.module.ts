import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { MfaController } from './mfa.controller';
import { SessionsController } from './sessions.controller';
import { MfaService } from './mfa.service';

/**
 * Phase 2, item 8 — MFA module.
 * Imports AuthModule for PasswordService, TokenService and AuthService
 * (completeMfaLogin). One-directional: AuthModule never imports MfaModule.
 */
@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [MfaController, SessionsController],
  providers: [MfaService],
  exports: [MfaService],
})
export class MfaModule {}
