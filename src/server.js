import { app } from './app.js';
import { env } from './config/env.js';
import { ensureDatabaseCompatibility } from './config/dbCompat.js';

async function startServer() {
  await ensureDatabaseCompatibility();
  app.listen(env.port, () => {
    console.log(`Backend listening on http://localhost:${env.port}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start backend:', error);
  process.exit(1);
});
