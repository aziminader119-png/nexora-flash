// Bounded multi-token cyclic arbitrage discovery, READ-ONLY.
// Route catalog is explicit: net.routeEdges supplies validated chain-specific token/pool
// edges. Never infer contracts, never place an order, and never silently loosen safety gates.
import {PROVIDER_KIND} from './networks.mjs';
import {sizesFor} from './scanner.mjs';
import {routeGasUnits, weiToStable, netProfitUnits, selectProvider} from './profit.mjs';
import {toFloat} from './units.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const lower = (s) => String(s).toLowerCase();
const LIMITS = Object.freeze({maxDepth: 10, maxQuotes: 350, maxCandidates: 100, maxEdges: 150});

/** Explicit edge: {pool:{key,name,type,router,routerKind,quoter?,fee?,forkValidated},
 * tokenIn:{address,symbol}, tokenOut:{address,symbol}}. Fee is charged by the
 * actual on-chain quoter; we do not multiply an extra estimated DEX fee.
 */
export function validateCycleEdges(edges, stable) {
  if (!Array.isArray(edges) || edges.length > LIMITS.maxEdges) throw Error('Invalid multi-hop edge catalog');
  const graph = new Map();
  for (const edge of edges) {
    const {pool, tokenIn, tokenOut} = edge || {};
    if (!pool || !tokenIn || !tokenOut || !ADDRESS.test(tokenIn.address) || !ADDRESS.test(tokenOut.address)
      || !ADDRESS.test(pool.router) || (pool.type !== 'v2' && pool.type !== 'v3')
      || (pool.type === 'v3' && (!ADDRESS.test(pool.quoter) || !Number.isInteger(pool.fee)))
      || !pool.key || !pool.name || lower(tokenIn.address) === lower(tokenOut.address)) throw Error('Invalid multi-hop edge');
    const key = lower(tokenIn.address);
    if (!graph.has(key)) graph.set(key, []);
    graph.get(key).push(edge);
  }
  if (!ADDRESS.test(stable.address)) throw Error('Invalid base asset');
  return graph;
}

/** Discover only closed, simple cycles (no intermediate token repeats).
 * Every quote is pinned to the same block. Search is bounded by quote-call
 * and route budgets; a cap being hit is exposed as truncated, never hidden.
 */
export async function discoverMultiHopCycles({
  chain, net, settings, block, gasPrice, nativePrice, l1FeeWei = 0n,
  infos = [], preferKinds = null, at = new Date().toISOString(),
  minDepth = 5, maxDepth = 10, maxQuotes = LIMITS.maxQuotes, maxCandidates = LIMITS.maxCandidates,
}) {
  if (!Number.isInteger(minDepth) || minDepth < 2 || !Number.isInteger(maxDepth) || maxDepth > LIMITS.maxDepth
    || minDepth > maxDepth || !Number.isInteger(maxQuotes) || maxQuotes < 1 || maxQuotes > 2000
    || !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 500) throw Error('Invalid multi-hop search limits');

  const graph = validateCycleEdges(net.routeEdges || [], net.stable);
  const base = lower(net.stable.address);
  const candidates = [];
  let quotes = 0;
  let truncated = false;
  const allowed = preferKinds === null ? infos : infos.filter((x) => preferKinds.includes(x.kind));
  const maxGasGweiExceeded = Number(gasPrice) / 1e9 > settings.maxGasGwei;

  async function getQuote(edge, amount) {
    if (quotes >= maxQuotes) { truncated = true; return null; }
    quotes++;
    try {
      const {pool, tokenIn, tokenOut} = edge;
      const out = pool.type === 'v2'
        ? await chain.quoteV2(pool.router, amount, tokenIn.address, tokenOut.address, block)
        : await chain.quoteV3(pool.quoter, tokenIn.address, tokenOut.address, pool.fee, amount, block);
      return typeof out === 'bigint' && out > 0n ? out : null;
    } catch { return null; }
  }

  for (const size of sizesFor(settings, net.stable.decimals)) {
    if (truncated || candidates.length >= maxCandidates) { truncated = true; break; }
    const {best: provider, rejected} = selectProvider(allowed, size.units);
    const visitedTokens = new Set([base]);
    const usedPools = new Set();
    const legs = [];

    async function walk(token, amount, depth) {
      if (truncated || candidates.length >= maxCandidates) { truncated = true; return; }
      const outgoing = graph.get(token) || [];
      for (const edge of outgoing) {
        if (truncated || candidates.length >= maxCandidates) { truncated = true; break; }
        const next = lower(edge.tokenOut.address);
        const returning = next === base;
        if (usedPools.has(edge.pool.key)) continue;
        if (returning && depth + 1 < minDepth) continue;
        if (!returning && (depth + 1 >= maxDepth || visitedTokens.has(next))) continue;
        const out = await getQuote(edge, amount);
        if (out === null) continue;
        const p = edge.pool;
        const leg = {
          venueId: p.venueId || p.key, pool: p.key, name: p.name,
          type: p.type, router: p.router, routerKind: p.routerKind,
          fee: p.fee || 0, tokenIn: edge.tokenIn.address, tokenOut: edge.tokenOut.address,
          quotedOut: out.toString(), forkValidated: p.forkValidated === true,
        };
        legs.push(leg);
        usedPools.add(p.key);
        if (returning) {
          const fee = provider ? provider.fee : 0n;
          // Add byte-size margin per extra leg for L1 data overhead; the
          // future executor must still use eth_estimateGas + eth_call.
          const gasUnits = routeGasUnits(provider?.kind || 'AAVE_V3', legs);
          const l1Approx = l1FeeWei + (l1FeeWei * BigInt(Math.max(0, legs.length - 2)) / 2n);
          const gasStable = weiToStable(gasUnits * gasPrice + l1Approx, nativePrice);
          const profit = netProfitUnits({amount: size.units, outUnits: out, fee, gasStable});
          const blockers = ['multi-hop cycle monitoring only: live executor limited to 4 legs'];
          if (!provider) blockers.push('no flash provider: ' + (rejected.map((v) => `${v.kind} ${v.reason}`).join(', ') || 'none configured'));
          if (maxGasGweiExceeded) blockers.push('gas above ceiling');
          if (legs.some((v) => !v.forkValidated)) blockers.push('venue not fork-validated');
          candidates.push({
            id: `${net.id}:${block}:${size.usd}:multi:${legs.map((x) => x.pool + ':' + lower(x.tokenOut)).join('>')}`,
            chainId: net.id, network: net.name, block, at,
            pair: `${[net.stable.symbol, ...legs.map((x) => (net.routeEdges || []).find((e) => lower(e.tokenOut.address) === lower(x.tokenOut))?.tokenOut.symbol || x.tokenOut)].join(' → ')}`,
            size: size.usd, amount: size.units.toString(), asset: net.stable.address,
            assetSymbol: net.stable.symbol, decimals: net.stable.decimals,
            provider: provider ? {kind: provider.kind, kindId: PROVIDER_KIND[provider.kind], address: provider.address, fee: fee.toString()} : null,
            legs: legs.map((v) => ({...v})), buy: legs[0].name, sell: legs.at(-1).name,
            grossUnits: profit.gross.toString(), feeUnits: fee.toString(),
            gasStableUnits: gasStable.toString(), netUnits: profit.net.toString(), gasUnits: gasUnits.toString(),
            gross: toFloat(profit.gross, net.stable.decimals), flashFee: toFloat(fee, net.stable.decimals),
            gasCost: toFloat(gasStable, net.stable.decimals), netEstimate: toFloat(profit.net, net.stable.decimals),
            nativePriceUnits: nativePrice.toString(), gasPriceWei: gasPrice.toString(),
            status: 'QUOTE_ONLY', executable: false, mode: 'MULTIHOP_OBSERVE_ONLY', hopCount: legs.length, blockers,
          });
        } else {
          visitedTokens.add(next);
          await walk(next, out, depth + 1);
          visitedTokens.delete(next);
        }
        usedPools.delete(p.key);
        legs.pop();
      }
    }
    await walk(base, size.units, 0);
  }
  candidates.sort((a, b) => b.netEstimate - a.netEstimate);
  return {candidates, scannedQuotes: quotes, truncated, maxDepth, monitored: true};
}
