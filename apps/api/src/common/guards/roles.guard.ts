import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

const ROLE_EQUIVALENT_PERMISSIONS: Partial<Record<SystemRole, string[]>> = {
  [SystemRole.HR_ADMIN]: [
    'EMPLOYEE:CREATE', 'EMPLOYEE:READ', 'EMPLOYEE:UPDATE', 'EMPLOYEE:DELETE', 'EMPLOYEE:MANAGE',
    'DEPARTMENT:CREATE', 'DEPARTMENT:READ', 'DEPARTMENT:UPDATE', 'DEPARTMENT:DELETE', 'DEPARTMENT:MANAGE',
    'DESIGNATION:CREATE', 'DESIGNATION:READ', 'DESIGNATION:UPDATE', 'DESIGNATION:DELETE', 'DESIGNATION:MANAGE',
    'DOCUMENT:CREATE', 'DOCUMENT:READ', 'DOCUMENT:UPDATE', 'DOCUMENT:DELETE', 'DOCUMENT:MANAGE',
    'USER:READ', 'USER:UPDATE', 'USER:MANAGE',
  ],
  [SystemRole.MANAGER]: [
    'EMPLOYEE:READ', 'LEAVE:APPROVE', 'ATTENDANCE:APPROVE', 'PERFORMANCE:APPROVE', 'PERFORMANCE:CREATE',
  ],
  [SystemRole.EMPLOYEE]: [
    'EMPLOYEE:READ', 'LEAVE:CREATE', 'LEAVE:READ', 'ATTENDANCE:CREATE', 'ATTENDANCE:READ',
  ],
  [SystemRole.AUDITOR]: [
    'AUDIT_LOG:READ', 'EMPLOYEE:READ', 'USER:READ', 'PAYROLL:READ',
  ],
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<SystemRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<{ user: JwtPayload }>();
    if (!user || !user.roles) {
      throw new ForbiddenException('Access denied: insufficient role privileges');
    }

    // Super Admin has universal access
    if (user.roles.includes(SystemRole.SUPER_ADMIN)) {
      return true;
    }

    // Direct role match
    const hasRole = requiredRoles.some((role) => user.roles.includes(role));
    if (hasRole) {
      return true;
    }

    // Custom role permission empowerment:
    // If the caller has a custom role with permissions equivalent to the required role, grant access
    const userPermSet = new Set(user.permissions || []);
    const hasEquivalentPermission = requiredRoles.some((role) => {
      const equiv = ROLE_EQUIVALENT_PERMISSIONS[role];
      return equiv && equiv.some((perm) => userPermSet.has(perm));
    });

    if (hasEquivalentPermission) {
      return true;
    }

    throw new ForbiddenException(`Access denied: requires one of [${requiredRoles.join(', ')}]`);
  }
}
