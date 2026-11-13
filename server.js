// NEXORA v1.0 service: automatic multi-network scanning, gated unattended execution, single-page dashboard.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {NETWORKS, withEnvProviders, PROVIDER_FORK_TEST} from './lib/networks.mjs';
import {loadSettings, applySettingsUpdate, loanCeiling} from './lib/settings.mjs';
import {scanNetwork} from './lib/scanner.mjs';
import {Journal} from './lib/journal.mjs';
import {Executor} from './lib/engine.mjs';
import {loadGateReport, globalGateBlockers, forkTestPassed} from './lib/gates.mjs';
import {createLogger} from './lib/logger.mjs';
import {makeChain} from './lib/chain-ethers.mjs';
import {loadSigner} from './lib/keys.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 3080);
const BIND_HOST = env.BIND_HOST || '127.0.0.1';
const INTERVAL_MS = Math.max(5000, Number(env.SCAN_INTERVAL_MS || 30000));
const ADMIN_TOKEN = env.ADMIN_TOKEN || '';
const DATA_DIR = env.DATA_DIR || path.join(root, 'data');
const CONFIG_PATH = env.CONFIG_PATH || path.join(DATA_DIR, 'settings.json');
const GATE_REPORT = env.GATE_REPORT || path.join(root, 'validation', 'gate-report.json');
const LIVE = env.LIVE_EXECUTION === 'true';

fs.mkdirSync(DATA_DIR, {recursive: true, mode: 0o700});
const log = createLogger({file: env.LOG_PATH || path.join(DATA_DIR, 'nexora.log.jsonl')});
const journal = new Journal(env.JOURNAL_PATH || path.join(DATA_DIR, 'execution-journal.jsonl'));

let settings;
try { settings = loadSettings(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); } catch { settings = loadSettings(null); }
function persistSettings(next) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), {mode: 0o600});
  fs.renameSync(tmp, CONFIG_PATH);
  settings = next;
}

const nets = NETWORKS.map((n) => withEnvProviders(n, env));
const contracts = Object.fromEntries(nets.map((n) => [n.id, env[`EXECUTOR_${n.id}`] || '']).filter(([, a]) => a));
const chains = new Map();
const chainFor = (net) => {
  if (!chains.has(net.id)) chains.set(net.id, makeChain(net, env[`RPC_${net.id}`] || net.rpcDefault, {timeoutMs: Number(env.RPC_TIMEOUT_MS || 9000)}));
  return chains.get(net.id);
};

let gateReport = loadGateReport(GATE_REPORT);
let signer = null;
try { signer = await loadSigner(env); } catch (e) { log('error', `Signer not loaded: ${e.message}`); }
if (signer) log('info', `Operator signer loaded: ${signer.address}`);

const executor = new Executor({
  journal, settings: () => settings, chainFor, signer, contracts, liveEnabled: LIVE,
  gateReport: () => gateReport,
  onAutoPause: (reason) => { if (!settings.paused) { persistSettings({...settings, paused: true}); log('error', `AUTO-PAUSED: ${reason}`); } },
  log: (level, m) => log(level, m),
});

const states = new Map();
let opportunities = [];
let busy = false, lastScan = null, scans = 0;

async function cycle() {
  if (busy) return;
  busy = true;
  scans++;
  try {
    gateReport = loadGateReport(GATE_REPORT);
    // Recovery runs even while paused, so pending transactions always get resolved after restarts.
    if (signer) await Promise.all(nets.filter((n) => contracts[n.id]).map((n) => executor.reconcile(n).catch((e) => log('warning', `${n.name} recovery: ${e.message}`))));
    if (settings.paused) { log('info', 'Paused: scanning and execution suspended'); return; }
    const enabled = nets.filter((n) => settings.enabledChains.includes(n.id));
    // Prefer lenders whose fork round-trip passed for this network, so candidates are executable under the gate.
    const eligible = (net) => (gateReport ? net.providers.map((p) => p.kind).filter((k) => forkTestPassed(gateReport, net.forkSuite, PROVIDER_FORK_TEST[k])) : null);
    const results = await Promise.all(enabled.map((net) => scanNetwork({chain: chainFor(net), net, settings, preferKinds: eligible(net)})));
    const next = [];
    for (const [i, r] of results.entries()) {
      states.set(enabled[i].id, r.state);
      next.push(...r.candidates.slice(0, 25));
      const pos = r.candidates.filter((c) => c.netEstimate >= settings.minProfitUSD);
      if (r.state.status !== 'quotes-live') log('warning', `${r.state.name}: ${r.state.error}`);
      else log(pos.length ? 'candidate' : 'info', `${r.state.name}: ${r.candidates.length} quoted routes, ${pos.length} above $${settings.minProfitUSD} (block ${r.state.block})`);
    }
    for (const id of states.keys()) if (!settings.enabledChains.includes(id)) states.delete(id);
    opportunities = next.sort((a, b) => b.netEstimate - a.netEstimate);
    if (LIVE && settings.autoExecute) {
      for (const net of enabled.filter((n) => settings.liveChains.includes(n.id))) {
        const best = opportunities.find((c) => c.chainId === net.id && c.executable && c.netEstimate >= settings.minProfitUSD);
        if (best) await executor.attempt(best, net);
      }
    }
  } catch (e) {
    log('error', `Cycle failed: ${e.message}`);
  } finally {
    lastScan = new Date().toISOString();
    busy = false;
  }
}

function authorized(req) {
  const got = Buffer.from(String(req.headers['x-admin-token'] || ''));
  const want = Buffer.from(ADMIN_TOKEN);
  return ADMIN_TOKEN.length >= 24 && got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const ch of req) { bytes += ch.length; if (bytes > 16384) throw Error('payload too large'); chunks.push(ch); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const json = (res, code, obj) => { res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v))); };

function status() {
  const globalBlockers = globalGateBlockers(gateReport);
  return {
    version: '1.0.0',
    mode: !LIVE ? 'SCAN_ONLY' : settings.paused ? 'PAUSED' : settings.autoExecute ? 'AUTO_EXECUTION' : 'LIVE_MANUAL',
    liveExecutionEnabled: LIVE, signer: signer?.address || null, contracts, loanCeiling: loanCeiling(),
    gate: {passed: globalBlockers.length === 0, blockers: globalBlockers, generatedAt: gateReport?.generatedAt || null, codehash: gateReport?.executor?.runtimeCodehash || null},
    networks: nets.filter((n) => settings.enabledChains.includes(n.id)).map((n) => ({...(states.get(n.id) || {chainId: n.id, name: n.name, status: 'pending'}), liveBlockers: executor.liveBlockers(n), forkSuite: n.forkSuite})),
    registry: nets.map((n) => ({id: n.id, name: n.name, providers: n.providers.map((p) => p.kind), venues: n.venues.map((v) => ({name: v.name, forkValidated: v.forkValidated}))})),
    scans, busy, lastScan, intervalMs: INTERVAL_MS, settings,
    opportunities: opportunities.slice(0, 100),
    trades: journal.trades().slice(-100).reverse(),
    pending: journal.pending(),
    attempts: executor.attempts.slice(-50).reverse(),
    gasSpentTodayUSD: journal.gasSpentToday(),
    consecutiveFailures: journal.consecutiveFailures(),
    logs: log.recent(150),
    configWritable: ADMIN_TOKEN.length >= 24,
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/api/health') return json(res, 200, {alive: true, lastScan, paused: settings.paused, pending: journal.pending().length});
    if (u.pathname === '/api/status' && req.method === 'GET') return json(res, 200, status());
    if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
      if (!authorized(req)) return json(res, 403, {error: 'admin token required'});
      if (u.pathname === '/api/settings') {
        const next = applySettingsUpdate(settings, await body(req));
        if (next.liveChains.length && !LIVE) throw Error('LIVE_EXECUTION=false on the server: live networks cannot be enabled');
        persistSettings(next);
        log('settings', `Updated: maxLoan=$${next.maxLoanUSD} loan=$${next.loanSize} live=[${next.liveChains}] auto=${next.autoExecute} paused=${next.paused}`);
        return json(res, 200, {ok: true, settings});
      }
      if (u.pathname === '/api/scan') { if (busy) return json(res, 409, {error: 'scan running'}); cycle(); return json(res, 202, {started: true}); }
      if (u.pathname === '/api/emergency-stop') {
        const results = await executor.emergencyStop(nets.filter((n) => contracts[n.id]), 'dashboard emergency stop');
        log('error', `EMERGENCY STOP: ${JSON.stringify(results)}`);
        return json(res, 200, {ok: true, results});
      }
      if (u.pathname === '/api/resume') {
        journal.append({kind: 'reset_failures', reason: 'operator resume'});
        persistSettings({...settings, paused: false});
        log('settings', 'Resumed by operator (on-chain unpause, if needed, requires the owner wallet)');
        return json(res, 200, {ok: true});
      }
      if (u.pathname === '/api/execute') {
        const {candidateId} = await body(req);
        const c = opportunities.find((x) => x.id === candidateId);
        if (!c) return json(res, 404, {error: 'candidate not found or expired'});
        return json(res, 200, await executor.attempt(c, nets.find((n) => n.id === c.chainId)));
      }
    }
    if (u.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
      return res.end(fs.readFileSync(path.join(root, 'public', 'index.html')));
    }
    return json(res, 404, {error: 'not found'});
  } catch (e) {
    return json(res, 400, {error: String(e.message || e).slice(0, 500)});
  }
});

let timer;
server.listen(PORT, BIND_HOST, () => {
  log('info', `NEXORA v1.0 on ${BIND_HOST}:${PORT} | live=${LIVE} | gate=${globalGateBlockers(gateReport).length ? 'LOCKED' : 'passed'} | journal pending=${journal.pending().length}`);
  cycle();
  timer = setInterval(cycle, INTERVAL_MS);
});

async function shutdown(sig) {
  log('info', `${sig}: shutting down (pending transactions are recovered from the journal on restart)`);
  clearInterval(timer);
  server.close();
  const until = Date.now() + 30000;
  while ((executor.busy || busy) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  for (const c of chains.values()) c.destroy?.();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
