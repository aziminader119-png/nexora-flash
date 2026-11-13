// Persistent structured logs (JSONL with size-based rotation) plus an in-memory ring for the dashboard.
import fs from 'node:fs';
import path from 'node:path';

export function createLogger({file = null, maxBytes = 10 * 1024 * 1024, keep = 300, echo = true} = {}) {
  const ring = [];
  if (file) fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true});
  function rotate() {
    try { if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`); } catch { /* not yet created */ }
  }
  function log(level, message, extra) {
    const e = {at: new Date().toISOString(), level, message: String(message).slice(0, 2000), ...(extra ? {extra} : {})};
    ring.unshift(e);
    if (ring.length > keep) ring.length = keep;
    if (file) { rotate(); try { fs.appendFileSync(file, JSON.stringify(e) + '\n', {mode: 0o600}); } catch { /* disk issue must not stop trading safety logic */ } }
    if (echo) console.log(`[${level}] ${e.message}`);
    return e;
  }
  log.recent = (n = 100) => ring.slice(0, n);
  return log;
}
