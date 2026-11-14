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

/**
 * A catalog's 'forkValidated' flag is untrusted operator data. For funded
 * execution, require exact matching to a hard-coded network venue whose
 * router, kind, quoter and fee tier are already approved in the registry.
 * Additional token approval must be separately checked on-chain.
 */
export function catalogHasTrustedVenues(net, edges) {
  if (!Array.isArray(edges) || !edges.length) return false;
  const lower = (x) => String(x || '').toLowerCase();
  return edges.every((edge) => net.venues.some((v) =>
    v.forkValidated === true
    && edge.pool.forkValidated === true
    && v.type === edge.pool.type
    && lower(v.router) === lower(edge.pool.router)
    && (v.type === 'v2'
      ? edge.pool.routerKind === 0 && (edge.pool.fee || 0) === 0
      : edge.pool.routerKind === v.routerKind
        && lower(v.quoter) === lower(edge.pool.quoter)
        && v.fees.includes(edge.pool.fee))
  ));
}
