/**
 * Avatar object-storage wiring (go-live Phase 3 item 8).
 *
 * - data:image/*;base64 URLs are decoded and uploaded to object storage; the
 *   DB stores only the `avatars/...` key (never the base64 blob).
 * - External URLs / existing keys pass through untouched.
 * - Stored keys resolve to presigned URLs on read; old keys are
 *   best-effort deleted on replace/remove.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { EmployeesService } from './employees.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { AccessPolicyService } from '../../core/access-policy/access-policy.service';
import { AvatarStorageService } from '../../core/storage/avatar-storage.service';

describe('EmployeesService — avatar object storage', () => {
  let service: EmployeesService;
  let prisma: any;
  let avatars: any;

  const existingEmployee = (overrides: any = {}) => ({
    id: 'emp-1',
    email: 'ada@example.com',
    avatarUrl: null,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      employee: {
        findFirst: jest.fn(async () => ({ id: 'emp-1' })),
        findUnique: jest.fn(async () => existingEmployee()),
        update: jest.fn(async ({ data }: any) => ({ id: 'emp-1', ...data })),
      },
    };
    avatars = {
      uploadAvatar: jest.fn(async () => ({ key: 'avatars/emp-1/abc.png', mimeType: 'image/png', bytes: 10 })),
      deleteAvatar: jest.fn(async () => undefined),
      getAvatarUrl: jest.fn(async (key: string) => `https://minio.local/${key}?sig=x`),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmployeesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn(async () => ({})) } },
        { provide: AccessPolicyService, useValue: { can: jest.fn() } },
        { provide: AvatarStorageService, useValue: avatars },
      ],
    }).compile();

    service = module.get<EmployeesService>(EmployeesService);
  });

  it('uploads base64 data URLs to object storage and stores the key', async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;

    const res: any = await service.updateMyAvatar('user-1', 'emp-1', dataUrl, 'ada@example.com');

    expect(avatars.uploadAvatar).toHaveBeenCalledWith(
      'emp-1',
      expect.any(Buffer),
      'image/png',
    );
    expect(prisma.employee.update).toHaveBeenCalledWith({
      where: { id: 'emp-1' },
      data: { avatarUrl: 'avatars/emp-1/abc.png' },
    });
    // Response carries a client-usable (presigned) URL, not the raw key.
    expect(res.data.avatarUrl).toBe('https://minio.local/avatars/emp-1/abc.png?sig=x');
  });

  it('deletes the previous object-storage avatar on replace', async () => {
    prisma.employee.findUnique.mockResolvedValue(existingEmployee({ avatarUrl: 'avatars/emp-1/old.png' }));
    const dataUrl = `data:image/jpeg;base64,${Buffer.from('x').toString('base64')}`;

    await service.updateMyAvatar('user-1', 'emp-1', dataUrl, 'ada@example.com');

    expect(avatars.deleteAvatar).toHaveBeenCalledWith('avatars/emp-1/old.png');
  });

  it('passes external URLs through without uploading', async () => {
    await service.updateMyAvatar('user-1', 'emp-1', 'https://cdn.example/a.png', 'ada@example.com');

    expect(avatars.uploadAvatar).not.toHaveBeenCalled();
    expect(prisma.employee.update).toHaveBeenCalledWith({
      where: { id: 'emp-1' },
      data: { avatarUrl: 'https://cdn.example/a.png' },
    });
  });

  it('deletes the stored key when the avatar is removed', async () => {
    prisma.employee.findUnique.mockResolvedValue(existingEmployee({ avatarUrl: 'avatars/emp-1/old.png' }));

    const res: any = await service.updateMyAvatar('user-1', 'emp-1', null, 'ada@example.com');

    expect(avatars.deleteAvatar).toHaveBeenCalledWith('avatars/emp-1/old.png');
    expect(res.data.avatarUrl).toBeNull();
  });

  it('getMyAvatarUrl resolves a stored key to a presigned URL', async () => {
    prisma.employee.findUnique.mockResolvedValue({ avatarUrl: 'avatars/emp-1/abc.png' });

    await expect(service.getMyAvatarUrl('user-1', 'emp-1')).resolves.toEqual({
      avatarUrl: 'https://minio.local/avatars/emp-1/abc.png?sig=x',
    });
  });

  it('getMyAvatarUrl returns null when no avatar is set', async () => {
    prisma.employee.findUnique.mockResolvedValue({ avatarUrl: null });

    await expect(service.getMyAvatarUrl('user-1', 'emp-1')).resolves.toEqual({ avatarUrl: null });
    expect(avatars.getAvatarUrl).not.toHaveBeenCalled();
  });
});
