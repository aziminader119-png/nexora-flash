// Append-only JSONL execution journal: survives restarts, drives pending-transaction recovery and gas budgets.
import fs from 'node:fs';
import path from 'node:path';

export const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const TX_OPEN = new Set(['submitted', 'rebroadcast', 'cancel_submitted']);
const TX_FINAL = new Set(['confirmed', 'failed', 'replaced', 'cancelled', 'dropped']);

export class Journal {
  constructor(file, {now = () => Date.now()} = {}) {
    this.file = file;
    this.now = now;
    this.events = [];
    if (file) {
      fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true});
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { this.events.push(JSON.parse(line)); } catch { /* torn final line after crash: ignore */ }
        }
      }
    }
  }

  append(event) {
    const e = {at: new Date(this.now()).toISOString(), ...event};
    if (this.file) {
      const fd = fs.openSync(this.file, 'a', 0o600);
      try { fs.writeSync(fd, JSON.stringify(e) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    this.events.push(e);
    if (this.events.length > 20000) this.events = this.events.slice(-10000);
    return e;
  }

  /** Unresolved transactions grouped by chain+nonce (a nonce may carry an original tx and a cancel tx). */
  pending(chainId) {
    const byNonce = new Map();
    for (const e of this.events) {
      if (e.kind !== 'tx' || (chainId != null && e.chainId !== chainId)) continue;
      const k = `${e.chainId}:${e.nonce}`;
      if (!byNonce.has(k)) byNonce.set(k, {chainId: e.chainId, nonce: e.nonce, hashes: [], raw: {}, submittedAt: null, final: null, purpose: null, gasReserveUSD: 0, cancelSent: false, maxFeePerGas: null});
      const g = byNonce.get(k);
      if (TX_OPEN.has(e.status)) {
        if (e.hash && !g.hashes.includes(e.hash)) g.hashes.push(e.hash);
        if (e.raw) g.raw[e.hash] = e.raw;
        if (e.status === 'submitted') { g.submittedAt = e.at; g.purpose = e.purpose; g.gasReserveUSD = e.gasReserveUSD || 0; g.maxFeePerGas = e.maxFeePerGas || null; g.meta = e; }
        if (e.status === 'cancel_submitted') g.cancelSent = true;
      }
      if (TX_FINAL.has(e.status)) g.final = e.status;
    }
    return [...byNonce.values()].filter((g) => g.hashes.length && !g.final).sort((a, b) => a.nonce - b.nonce);
  }

  /** Gas spent/reserved today (USD-equivalent stable units). Reservations count until actual cost is known. */
  gasSpentToday(t = this.now()) {
    const today = day(t);
    let total = 0;
    const settled = new Map();
    for (const e of this.events) if (e.kind === 'tx' && day(Date.parse(e.at)) === today && e.actualGasUSD != null) settled.set(`${e.chainId}:${e.nonce}`, e.actualGasUSD);
    const reserved = new Map();
    for (const e of this.events) if (e.kind === 'tx' && e.status === 'submitted' && day(Date.parse(e.at)) === today) reserved.set(`${e.chainId}:${e.nonce}`, e.gasReserveUSD || 0);
    for (const [k, v] of reserved) total += settled.has(k) ? settled.get(k) : v;
    for (const [k, v] of settled) if (!reserved.has(k)) total += v;
    return total;
  }

  /** Consecutive failed executions (reverted on-chain or broadcast errors) since the last success. */
  consecutiveFailures() {
    let n = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.kind === 'tx' && e.purpose === 'arbitrage' && e.status === 'confirmed') break;
      if (e.kind === 'reset_failures') break;
      if ((e.kind === 'tx' && e.purpose === 'arbitrage' && e.status === 'failed') || e.kind === 'broadcast_error') n++;
    }
    return n;
  }

  trades() {
    return this.events.filter((e) => e.kind === 'tx' && e.purpose === 'arbitrage' && (e.status === 'confirmed' || e.status === 'failed'));
  }

  recent(n = 100) { return this.events.slice(-n); }
}
