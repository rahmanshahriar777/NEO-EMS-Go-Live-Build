import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { validateRequiredSecrets } from './config/configuration';
import { requestIdMiddleware } from '@ems/shared';
import { correlationMiddleware } from './common/correlation/correlation';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // F3: fail closed before anything else boots when secrets are missing in prod.
  validateRequiredSecrets();

  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('nodeEnv', 'development');
  const isProduction = nodeEnv === 'production';
  const port = configService.get<number>('port', 4000);
  const apiPrefix = configService.get<string>('apiPrefix', '/api/v1');
  const allowedOrigins = configService.get<string[]>('allowedOrigins', [
    'http://localhost:3000',
  ]);

  // F30: tightened body-parser limits (was 10 MB — unnecessary for JSON APIs and
  // a cheap DoS vector). File uploads go through the S3/MinIO path, not JSON.
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  // Phase 1 observability (worker 6): request-ID propagation. Mounted before
  // any Nest handling so every request gets `req.id` + an echoed
  // `x-request-id` response header (incoming IDs are honoured when sane).
  app.use(requestIdMiddleware);

  // Go-live Phase 3 item 10: propagate the inbound x-request-id into
  // AsyncLocalStorage so BullMQ job payloads carry the request's correlation
  // ID instead of minting fresh UUIDs at enqueue time.
  app.use(correlationMiddleware);

  // B8: trust the reverse proxy so `req.ip` (throttler tracker keys, audit
  // logs) reflects the real client IP behind the load balancer.
  // TRUST_PROXY_HOPS (default 1) = number of trusted proxy hops.
  // (`app.set` is Express-specific — reach it via the HTTP adapter.)
  app.getHttpAdapter().getInstance().set('trust proxy', configService.get<number>('security.trustProxyHops', 1));

  // F30: security headers with an explicit Content Security Policy.
  // script/style 'unsafe-inline' is tolerated only because Swagger UI
  // (non-production) needs inline assets; the API itself serves no HTML.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
        },
      },
    }),
  );

  // F5: CORS allowlist — never reflect arbitrary origins with credentials.
  // Requests without an Origin header (curl, server-to-server, same-origin)
  // are still allowed; browsers from non-allowlisted origins are rejected.
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      logger.warn(`Blocked CORS request from non-allowlisted origin: ${origin}`);
      return callback(new Error(`Origin ${origin} is not allowed by CORS policy`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'x-csrf-token'],
  });

  // Global Prefix: /api/v1
  app.setGlobalPrefix(apiPrefix.replace(/^\//, ''));

  // Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // F30: OpenAPI / Swagger documentation is a development aid — never expose
  // the full API surface map in production.
  if (!isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('NEO EMS API')
      .setDescription(
        'Production-grade RESTful API for NEO EMS - Employee Management, Attendance, Leaves, Payroll, and Performance.',
      )
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'JWT Authorization',
          description: 'Enter your JWT access token',
          in: 'header',
        },
        'bearer',
      )
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
    logger.log(`📚 OpenAPI / Swagger documentation: http://localhost:${port}/api/docs`);
  }

  // Enable Graceful Shutdown
  app.enableShutdownHooks();

  await app.listen(port);
  logger.log(`🚀 NEO EMS Backend API is running at: http://localhost:${port}/${apiPrefix.replace(/^\//, '')}`);
}

void bootstrap();
