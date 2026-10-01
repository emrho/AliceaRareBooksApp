import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const db = openDb();
const app = createApp(db);
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.listen(port, host, () => {
  console.log(`Book shop app running at http://localhost:${port}`);
});
