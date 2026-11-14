// Operator-provided on-chain route catalog. Read-only use only.
// No automatic DEX discovery or unverified token/router allow-list promotions.
import fs from 'node:fs';
import {NETWORK_IDS} from './networks.mjs';
import {validateCycleEdges} from './multihop.mjs';

export function loadMultiHopCatalog(file, nets, log = () => {}) {
  if (!file) return new Map();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { log('warning', 'multi-hop catalog unavailable: ' + String(e.message || e).slice(0,120)); return new Map(); }
  if (!raw || raw.schema !== 1 || !raw.chains || typeof raw.chains !== 'object' || Array.isArray(raw.chains)) {
    log('warning', 'multi-hop catalog rejected: invalid schema');
    return new Map();
  }
  const output = new Map();
  for (const [id, entries] of Object.entries(raw.chains)) {
    const n = Number(id);
    const net = nets.find((v) => v.id === n);
    if (!Number.isSafeInteger(n) || !NETWORK_IDS.includes(n) || !net) {
      log('warning', 'multi-hop ignored unknown network ' + id);
      continue;
    }
    try {
      validateCycleEdges(entries, net.stable);
      output.set(n, entries);
    } catch (e) {
      log('warning', 'multi-hop catalog rejected on network ' + id + ': ' + String(e.message || e));
    }
  }
  return output;
}
