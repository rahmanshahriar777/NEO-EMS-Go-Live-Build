import { Global, Module } from '@nestjs/common';
import { AccessPolicyService } from './access-policy.service';

/**
 * Global module: every feature module can inject AccessPolicyService without
 * importing this module explicitly.
 */
@Global()
@Module({
  providers: [AccessPolicyService],
  exports: [AccessPolicyService],
})
export class AccessPolicyModule {}
