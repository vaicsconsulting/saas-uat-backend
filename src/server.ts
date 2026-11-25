import { assertProdConfig, config } from './config';
import { createApp } from './app';
import { prisma } from './db';

assertProdConfig();
const app = createApp();
const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`saas-uat-backend listening on :${config.port} (storage: ${config.storage.driver})`);
});

const stop = async () => {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
