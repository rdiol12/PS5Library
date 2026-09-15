import { configuration } from './config.js';
import { createApp } from './api/app.js';
const config = configuration();
const app = await createApp(config);
await app.listen({ host: config.HOST, port: config.PORT });
console.log(`PS5Library listening on ${config.PUBLIC_URL}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void app.close());
