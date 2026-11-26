import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/uat_test';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = path.join(os.tmpdir(), 'uat-test-uploads');
process.env.PUBLIC_API_URL = 'http://localhost:4000';
process.env.APP_URL = 'http://localhost:5173';
