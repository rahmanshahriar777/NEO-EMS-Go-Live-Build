import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code = 'INTERNAL_ERROR';
    let details: any = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, any>;
        message = obj.message || exception.message;
        code = obj.error || 'HTTP_EXCEPTION';
        details = obj.details || (Array.isArray(obj.message) ? obj.message : undefined);
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // F22: map Prisma codes to HTTP semantics without leaking internals
      // (constraint names, SQL, driver messages).
      switch (exception.code) {
        case 'P2002':
          status = HttpStatus.CONFLICT;
          code = 'UNIQUE_CONSTRAINT_VIOLATION';
          message = 'A record with the same value already exists.';
          break;
        case 'P2025':
          status = HttpStatus.NOT_FOUND;
          code = 'RECORD_NOT_FOUND';
          message = 'The requested record was not found.';
          break;
        default:
          status = HttpStatus.BAD_REQUEST;
          code = 'DATABASE_ERROR';
          message = 'The request could not be processed.';
          break;
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      code = 'INVALID_QUERY';
      message = 'The request could not be processed.';
    } else if (exception instanceof Error) {
      // F22: non-HTTP errors (Prisma init failures, driver errors, bugs)
      // must never reach the client verbatim. Message goes to server logs only.
      message = 'Internal server error';
      code = 'INTERNAL_ERROR';
    }

    // F22: any 5xx — including explicitly thrown InternalServerErrorException
    // with a detailed message — is replaced with a generic body. Internals
    // (stack, SQL, constraint names) stay in server logs.
    if (status >= 500) {
      message = 'Internal server error';
      code = 'INTERNAL_ERROR';
      details = null;
      this.logger.error(
        `[${request.method}] ${request.url} - ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`[${request.method}] ${request.url} - ${status} ${code} ${message}`);
    }

    response.status(status).json({
      success: false,
      error: {
        code,
        message,
        statusCode: status,
        details,
        path: request.url,
        timestamp: new Date().toISOString(),
      },
    });
  }
}
