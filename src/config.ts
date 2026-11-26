import 'dotenv/config';

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me',
  jwtTtl: process.env.JWT_TTL ?? '12h',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  publicApiUrl: (process.env.PUBLIC_API_URL ?? `http://localhost:${num(process.env.PORT, 4000)}`).replace(/\/$/, ''),
  appUrl: (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  inviteTtlHours: num(process.env.INVITE_TTL_HOURS, 72),
  maxUploadMb: num(process.env.MAX_UPLOAD_MB, 10),
  storage: {
    driver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
    localDir: process.env.LOCAL_STORAGE_DIR ?? './uploads',
    bucket: process.env.S3_BUCKET ?? '',
    region: process.env.S3_REGION ?? 'ap-south-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || undefined,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || undefined,
    urlTtlSeconds: num(process.env.S3_URL_TTL_SECONDS, 900),
  },
  seedAdmin: {
    email: process.env.SEED_ADMIN_EMAIL ?? '',
    password: process.env.SEED_ADMIN_PASSWORD ?? '',
    name: process.env.SEED_ADMIN_NAME ?? 'Admin',
  },
  brand: {
    company: process.env.BRAND_COMPANY ?? 'VAICS Consulting',
    primary: process.env.BRAND_PRIMARY ?? '#0D47A1',
  },
};

export function assertProdConfig(): void {
  if (config.env === 'production' && (config.jwtSecret === 'dev-only-change-me' || config.jwtSecret.length < 32)) {
    throw new Error('JWT_SECRET must be set to a long random value in production');
  }
}
