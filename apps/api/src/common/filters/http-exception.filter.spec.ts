import { HttpException, HttpStatus, ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from './http-exception.filter';

describe('AllExceptionsFilter (F22)', () => {
  let filter: AllExceptionsFilter;

  function mockHost(): { host: ArgumentsHost; json: jest.Mock; status: jest.Mock } {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/api/v1/test' }),
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;
    return { host, json, status };
  }

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    jest.spyOn((filter as any).logger, 'error').mockImplementation(() => undefined);
    jest.spyOn((filter as any).logger, 'warn').mockImplementation(() => undefined);
  });

  it('should map Prisma P2002 to 409 without leaking constraint internals', () => {
    const { host, json, status } = mockHost();
    const err = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`email`)',
      { code: 'P2002', clientVersion: 'test' },
    );

    filter.catch(err, host);

    expect(status).toHaveBeenCalledWith(409);
    const body = json.mock.calls[0][0];
    expect(body.error.code).toBe('UNIQUE_CONSTRAINT_VIOLATION');
    expect(JSON.stringify(body)).not.toContain('Unique constraint failed');
  });

  it('should map Prisma P2025 to 404', () => {
    const { host, json, status } = mockHost();
    const err = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: 'test',
    });

    filter.catch(err, host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json.mock.calls[0][0].error.code).toBe('RECORD_NOT_FOUND');
  });

  it('should return a generic body for 500s and never leak the original message', () => {
    const { host, json, status } = mockHost();

    filter.catch(new Error('secret db password hunter2 exploded'), host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0];
    expect(body.error.message).toBe('Internal server error');
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.details).toBeNull();
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('should sanitize explicitly thrown 5xx HttpExceptions', () => {
    const { host, json, status } = mockHost();

    filter.catch(
      new HttpException('Connection string postgresql://admin:s3cret@db:5432 failed', HttpStatus.BAD_GATEWAY),
      host,
    );

    expect(status).toHaveBeenCalledWith(502);
    const body = json.mock.calls[0][0];
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('s3cret');
  });

  it('should preserve 4xx HttpException messages (client-safe)', () => {
    const { host, json, status } = mockHost();

    filter.catch(new HttpException('Invalid email or password', HttpStatus.UNAUTHORIZED), host);

    expect(status).toHaveBeenCalledWith(401);
    expect(json.mock.calls[0][0].error.message).toBe('Invalid email or password');
  });

  it('should preserve the EMAIL_NOT_VERIFIED code from the auth service', () => {
    const { host, json, status } = mockHost();

    filter.catch(
      new HttpException(
        { statusCode: 403, error: 'EMAIL_NOT_VERIFIED', message: 'Verify your email' },
        403,
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(403);
    const body = json.mock.calls[0][0];
    expect(body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(body.error.message).toBe('Verify your email');
  });
});
