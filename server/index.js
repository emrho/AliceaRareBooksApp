import { openDb, getSettings } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const db = openDb();
const app = createApp(db);
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

// Pull from Google Sheets on start-up and then every N minutes (Settings → Google Sheets).
let lastAuto = 0;
async function autoSync() {
  const minutes = Number(getSettings(db).sheets_auto_minutes) || 0;
  if (!minutes || !app.locals.sheetsLinked() || Date.now() - lastAuto < minutes * 60000) return;
  lastAuto = Date.now();
  const r = await app.locals.syncSheets().catch((err) => ({ ok: false, error: err.message }));
  if (!r.ok) console.warn('Google Sheets sync had problems:', JSON.stringify(r.sections || r.error));
}
autoSync();
setInterval(autoSync, 60000).unref();

app.listen(port, host, () => {
  console.log(`Book shop app running at http://localhost:${port}`);
});
