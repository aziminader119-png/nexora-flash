// Validation gate: funded execution stays locked unless a fresh validation report shows that every critical
// test passed for the EXACT executor bytecode deployed on-chain, including the mainnet-fork test of the
// network and flash provider being used.
import fs from 'node:fs';
import {PROVIDER_FORK_TEST} from './networks.mjs';

export const CRITICAL_STEPS = Object.freeze(['node-unit', 'forge-build', 'forge-unit', 'e2e-local']);

export function loadGateReport(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const passed = (s) => /^(success|pass|passed)$/i.test(String(s || ''));

export function forkTestPassed(report, suite, test) {
  const r = report?.forge?.fork?.find((t) => t.suite === suite && (t.test === test || t.test === `${test}()`));
  return Boolean(r && passed(r.status));
}

/** Network-independent part of the gate. Returns a list of blocking reasons (empty == pass). */
export function globalGateBlockers(report, {now = Date.now(), maxAgeDays = 14} = {}) {
  if (!report) return ['no validation report (run: npm run validate)'];
  const b = [];
  if (report.schema !== 1) b.push('unsupported validation report schema');
  const age = now - Date.parse(report.generatedAt);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeDays * 86400000) b.push(`validation report older than ${maxAgeDays} days`);
  for (const id of CRITICAL_STEPS) {
    const s = report.steps?.find((x) => x.id === id);
    if (!s) b.push(`critical step missing: ${id}`);
    else if (s.exitCode !== 0) b.push(`critical step failed: ${id}`);
  }
  if (!/^0x[0-9a-f]{64}$/.test(report.executor?.runtimeCodehash || '')) b.push('report lacks executor runtime codehash');
  return b;
}

/** Gate for one network + provider. `onchainCodehash` is keccak256(eth_getCode(executor)). */
export function networkGateBlockers(report, {suite, providerKind, onchainCodehash}) {
  const b = [];
  if (!report) return ['no validation report'];
  if (!onchainCodehash || onchainCodehash.toLowerCase() !== String(report.executor?.runtimeCodehash).toLowerCase()) b.push('deployed executor bytecode differs from validated build');
  if (!forkTestPassed(report, suite, 'test_aave_revertKeepsLenderWhole')) b.push(`fork revert test not passed for ${suite}`);
  const t = PROVIDER_FORK_TEST[providerKind];
  if (!t || !forkTestPassed(report, suite, t)) b.push(`fork round-trip not passed for ${providerKind} on ${suite}`);
  return b;
}

/** Parse `forge test --json` output into flat rows. Tolerates both legacy and current key styles. */
export function parseForgeJson(text) {
  const rows = [];
  let data;
  try { data = JSON.parse(text); } catch {
    // forge may print one JSON object per line in some versions
    data = {};
    for (const line of String(text).split('\n')) { try { Object.assign(data, JSON.parse(line)); } catch { /* skip */ } }
  }
  for (const [key, suite] of Object.entries(data || {})) {
    const name = key.includes(':') ? key.split(':').pop() : key;
    for (const [test, r] of Object.entries(suite?.test_results || {})) {
      rows.push({suite: name, test: test.replace(/\(.*\)$/, ''), status: r?.status ?? 'Unknown', reason: r?.reason ?? null});
    }
  }
  return rows;
}
