export interface AppConfig {
  nodeEnv: string;
  port: number;
  appName: string;
  apiPrefix: string;
  frontendUrl: string;
  /** FRONTEND_URL plus every comma-separated entry in ALLOWED_ORIGINS. */
  allowedOrigins: string[];
  apiUrl: string;
  database: {
    url: string;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
    url: string;
  };
  s3: {
    endpoint: string;
    port: number;
    accessKey: string;
    secretKey: string;
    bucket: string;
    useSsl: boolean;
    region: string;
  };
  jwt: {
    accessSecret: string;
    accessExpiration: string;
    /**
     * Refresh-token lifetime (opaque random tokens stored hashed server-side,
     * rotated on every use). Parsed to milliseconds for expiry computation.
     * NOTE: JWT_REFRESH_SECRET was removed (Phase 1 hardening, item 7):
     * refresh tokens were never JWTs, so the secret was dead config.
     */
    refreshExpiration: string;
    refreshTtlMs: number;
  };
  throttle: {
    ttl: number;
    limit: number;
  };
  security: {
    /**
     * Invite-only onboarding switch. Default false closes open
     * self-registration (B2): POST /auth/register rejects with 403 while
     * disabled. New users arrive via HR-issued invitations or the first-admin
     * bootstrap script.
     */
    allowPublicRegistration: boolean;
    /**
     * Number of trusted reverse-proxy hops for Express 'trust proxy'.
     * main.ts must call app.set('trust proxy', trustProxyHops) so req.ip (and
     * therefore throttler tracker keys) reflects the real client IP behind the
     * load balancer (B8). Default 1 = one reverse proxy in front of the API.
     */
    trustProxyHops: number;
    /** Name of the non-httpOnly double-submit CSRF cookie. */
    csrfCookieName: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
    from: string;
    /** True when SMTP_HOST is set; otherwise the dev log fallback is used. */
    enabled: boolean;
  };
  oauth: {
    enabled: boolean;
    google: { clientId: string; clientSecret: string; redirectUri: string };
    microsoft: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
      tenant: string;
    };
  };
  mfa: {
    /** Issuer label shown in authenticator apps. */
    issuer: string;
    /** Allowed TOTP clock-skew windows on either side (otplib `window`). */
    totpWindow: number;
  };
  invitations: {
    /** Hours before an invitation token expires. */
    ttlHours: number;
  };
  passwordReset: {
    /** Minutes before a password-reset token expires. */
    ttlMinutes: number;
  };
  vapid: {
    publicKey: string;
    privateKey: string;
    subject: string;
  };
}

/**
 * Parse a human duration like '15m', '7d', '3600' (seconds) into milliseconds.
 * Throws on garbage so misconfiguration fails fast at startup.
 */
export function parseDurationMs(raw: string, varName: string): number {
  const value = (raw || '').trim();
  if (/^\d+$/.test(value)) {
    return parseInt(value, 10) * 1000; // bare number = seconds
  }
  const match = value.match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!match) {
    throw new Error(
      `[config] ${varName} has an invalid duration '${raw}'. ` +
        `Expected e.g. '15m', '7d', '3600' (seconds) or '500ms'.`,
    );
  }
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return amount * multipliers[unit];
}

/**
 * Parse the CORS allowlist: FRONTEND_URL plus ALLOWED_ORIGINS (comma-separated).
 * Used by main.ts instead of reflective `origin: true`.
 * In production, localhost and 127.0.0.1 are never included by default.
 */
export function parseAllowedOrigins(frontendUrl: string): string[] {
  const isProduction = process.env.NODE_ENV === 'production';
  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cloudRunOrigins = [
    'https://ndems-app-knbmj7xqka-uc.a.run.app',
    'https://ndems-app-479560345714.us-central1.run.app',
  ];
  const devOrigins = isProduction ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000'];
  return [...new Set([frontendUrl, ...devOrigins, ...cloudRunOrigins, ...extra])];
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true';
}

export default (): AppConfig => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const refreshExpiration = process.env.JWT_REFRESH_EXPIRATION || '7d';
  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '4000', 10),
    appName: process.env.APP_NAME || 'NEO Employee Management System',
    apiPrefix: process.env.API_PREFIX || '/api/v1',
    frontendUrl,
    allowedOrigins: parseAllowedOrigins(frontendUrl),
    apiUrl: process.env.API_URL || 'http://localhost:4000',
    database: {
      // F3: no hardcoded credential fallback. Empty when unset; the entrypoint
      // and validateRequiredSecrets() fail closed instead of fail-open.
      url: process.env.DATABASE_URL || '',
    },
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    },
    s3: {
      endpoint: process.env.S3_ENDPOINT || 'localhost',
      port: parseInt(process.env.S3_PORT || '9000', 10),
      // F3: MinIO/S3 keys must come from the environment — never defaults.
      accessKey: process.env.S3_ACCESS_KEY || '',
      secretKey: process.env.S3_SECRET_KEY || '',
      bucket: process.env.S3_BUCKET || 'ems-documents',
      useSsl: process.env.S3_USE_SSL === 'true',
      region: process.env.S3_REGION || 'us-east-1',
    },
    jwt: {
      // F3: JWT secrets must come from the environment — never hardcoded.
      accessSecret: process.env.JWT_ACCESS_SECRET || '',
      accessExpiration: process.env.JWT_ACCESS_EXPIRATION || '15m',
      refreshExpiration,
      refreshTtlMs: parseDurationMs(refreshExpiration, 'JWT_REFRESH_EXPIRATION'),
    },
    throttle: {
      ttl: parseInt(process.env.THROTTLE_TTL || '60', 10),
      limit: parseInt(process.env.THROTTLE_LIMIT || '100', 10),
    },
    security: {
      allowPublicRegistration: parseBool(process.env.ALLOW_PUBLIC_REGISTRATION, false),
      trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS || '1', 10),
      csrfCookieName: process.env.CSRF_COOKIE_NAME || 'csrf',
    },
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: parseBool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER || undefined,
      pass: process.env.SMTP_PASSWORD || undefined,
      from: process.env.SMTP_FROM || 'noreply@ems.local',
      enabled: Boolean(process.env.SMTP_HOST),
    },
    oauth: {
      enabled: parseBool(process.env.OAUTH_ENABLED, false),
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
        redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
      },
      microsoft: {
        clientId: process.env.MICROSOFT_CLIENT_ID || '',
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
        redirectUri: process.env.MICROSOFT_REDIRECT_URI || '',
        tenant: process.env.MICROSOFT_TENANT || 'common',
      },
    },
    mfa: {
      issuer: process.env.MFA_ISSUER || process.env.APP_NAME || 'NEO EMS',
      totpWindow: parseInt(process.env.MFA_TOTP_WINDOW || '1', 10),
    },
    invitations: {
      ttlHours: parseInt(process.env.INVITATION_TTL_HOURS || '72', 10),
    },
    passwordReset: {
      ttlMinutes: parseInt(process.env.PASSWORD_RESET_TTL_MINUTES || '60', 10),
    },
    vapid: {
      publicKey: process.env.VAPID_PUBLIC_KEY || '',
      privateKey: process.env.VAPID_PRIVATE_KEY || '',
      subject: process.env.VAPID_SUBJECT || 'mailto:admin@ems.local',
    },
  };
};

/**
 * F3 — fail-closed secret validation, called once at bootstrap (see main.ts).
 *
 * In production every secret below MUST be set; otherwise the process throws
 * and the container never starts. In non-production a loud warning is logged
 * instead so local development is not blocked — but nothing secret ever falls
 * back to a hardcoded value.
 *
 * Phase 1 extension: SMTP_HOST is required in production because invitation,
 * verification and password-reset emails are security-critical delivery paths
 * (B2); the dev log fallback is dev-only by design. OAuth credentials are
 * required in production only when OAUTH_ENABLED=true, and only for providers
 * that are actually configured.
 */
const REQUIRED_SECRETS = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
] as const;

function oauthProvidersConfigured(): string[] {
  const providers: string[] = [];
  if (process.env.GOOGLE_CLIENT_ID) providers.push('google');
  if (process.env.MICROSOFT_CLIENT_ID) providers.push('microsoft');
  return providers;
}

function missingOAuthSecrets(): string[] {
  const missing: string[] = [];
  if (process.env.GOOGLE_CLIENT_ID) {
    if (!process.env.GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
    if (!process.env.GOOGLE_REDIRECT_URI) missing.push('GOOGLE_REDIRECT_URI');
  }
  if (process.env.MICROSOFT_CLIENT_ID) {
    if (!process.env.MICROSOFT_CLIENT_SECRET) missing.push('MICROSOFT_CLIENT_SECRET');
    if (!process.env.MICROSOFT_REDIRECT_URI) missing.push('MICROSOFT_REDIRECT_URI');
  }
  return missing;
}

const CRYPTO_SECRETS_TO_CHECK = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'DOCUMENT_ENCRYPTION_KEY',
] as const;

const INSECURE_DEFAULT_SUBSTRINGS = [
  'change_in_prod',
  'changeme',
  'default-fallback-secret',
  'secret123',
  'password123',
  'replace_with',
  'example_key',
];

export function validateRequiredSecrets(): void {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  const missing: string[] = REQUIRED_SECRETS.filter((key) => !process.env[key]);

  if (isProduction) {
    if (!process.env.SMTP_HOST) {
      missing.push('SMTP_HOST');
    }
    if (parseBool(process.env.OAUTH_ENABLED, false)) {
      if (oauthProvidersConfigured().length === 0) {
        missing.push('GOOGLE_CLIENT_ID or MICROSOFT_CLIENT_ID');
      } else {
        missing.push(...missingOAuthSecrets());
      }
    }
  }

  const weakOrDefault: string[] = [];
  for (const key of CRYPTO_SECRETS_TO_CHECK) {
    const val = process.env[key];
    if (val) {
      if (val.length < 32) {
        weakOrDefault.push(`${key} too short (must be >= 32 chars)`);
      }
      if (isProduction) {
        for (const pattern of INSECURE_DEFAULT_SUBSTRINGS) {
          if (val.toLowerCase().includes(pattern)) {
            weakOrDefault.push(`${key} contains insecure default '${pattern}'`);
            break;
          }
        }
      }
    }
  }

  const errors: string[] = [];
  if (missing.length > 0) {
    errors.push(`Missing required secrets: ${missing.join(', ')}`);
  }
  if (weakOrDefault.length > 0) {
    errors.push(`Insecure or weak secrets: ${weakOrDefault.join(', ')}`);
  }

  // Fail fast on malformed durations even in dev — cheap to validate.
  try {
    parseDurationMs(process.env.JWT_REFRESH_EXPIRATION || '7d', 'JWT_REFRESH_EXPIRATION');
    parseDurationMs(process.env.JWT_ACCESS_EXPIRATION || '15m', 'JWT_ACCESS_EXPIRATION');
  } catch (e) {
    errors.push((e as Error).message);
  }

  if (errors.length === 0) {
    return;
  }

  const message =
    `${errors.join('. ')}. ` +
    `Refusing to start with fail-open or insecure defaults — set them in the environment ` +
    `(see .env.example; generate with: openssl rand -base64 48).`;

  if (isProduction) {
    throw new Error(`[config] ${message}`);
  }

  // eslint-disable-next-line no-console
  console.warn(`[config] WARNING: ${message} (allowed only because NODE_ENV=${nodeEnv})`);
}
