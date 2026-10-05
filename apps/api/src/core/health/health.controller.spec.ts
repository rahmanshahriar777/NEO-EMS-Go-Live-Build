import { HttpStatus } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const res = () => {
    const r: any = {};
    r.status = jest.fn().mockReturnValue(r);
    return r;
  };

  it('liveness always reports UP with a timestamp', () => {
    const c = new HealthController({} as any, {} as any);
    const body = c.liveness();
    expect(body.status).toBe('UP');
    expect(typeof body.timestamp).toBe('string');
  });

  it('readiness returns 200 when DB and Redis are up', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const redis = { getIsConnected: jest.fn().mockReturnValue(true) };
    const c = new HealthController(prisma as any, redis as any);
    const r = res();
    const body = await c.readiness(r);
    expect(r.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(body.status).toBe('UP');
    expect(body.services).toEqual({ database: 'UP', redis: 'UP' });
    // No fingerprintable internals in the body.
    expect(JSON.stringify(body)).not.toMatch(/memory|version/i);
  });

  it('readiness returns 503 when the DB is down', async () => {
    const prisma = { $queryRaw: jest.fn().mockRejectedValue(new Error('conn refused')) };
    const redis = { getIsConnected: jest.fn().mockReturnValue(true) };
    const c = new HealthController(prisma as any, redis as any);
    const r = res();
    const body = await c.readiness(r);
    expect(r.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.status).toBe('DOWN');
    expect(body.services.database).toBe('DOWN');
  });

  it('readiness returns 503 when Redis is down', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const redis = { getIsConnected: jest.fn().mockReturnValue(false) };
    const c = new HealthController(prisma as any, redis as any);
    const r = res();
    const body = await c.readiness(r);
    expect(r.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.services.redis).toBe('DOWN');
  });
});
