// Bounded multi-token cyclic arbitrage discovery, READ-ONLY.
// Route catalog is explicit: net.routeEdges supplies validated chain-specific token/pool
// edges. Never infer contracts, never place an order, and never silently loosen safety gates.
import {PROVIDER_KIND} from './networks.mjs';
import {sizesFor} from './scanner.mjs';
import {routeGasUnits, weiToStable, netProfitUnits, selectProvider} from './profit.mjs';
import {toFloat} from './units.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const lower = (s) => String(s).toLowerCase();
const LIMITS = Object.freeze({maxDepth: 10, maxQuotes: 80, maxCandidates: 100, maxEdges: 150});

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
  maxDurationMs = 8000, allowExecution = false, rotation = null,
}) {
  if (!Number.isInteger(minDepth) || minDepth < 2 || !Number.isInteger(maxDepth) || maxDepth > LIMITS.maxDepth
    || minDepth > maxDepth || !Number.isInteger(maxQuotes) || maxQuotes < 1 || maxQuotes > 2000
    || !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 500
    || !Number.isInteger(maxDurationMs) || maxDurationMs < 100 || maxDurationMs > 60000
    || (rotation !== null && (!Number.isSafeInteger(rotation) || rotation < 0))) throw Error('Invalid multi-hop search limits');

  const graph = validateCycleEdges(net.routeEdges || [], net.stable);
  const base = lower(net.stable.address);
  // Prune branches that cannot return to the borrowed asset within the
  // remaining hop budget. This is a topology-only over-approximation; the
  // actual walk still rejects repeated intermediate tokens and pools.
  // Crucially, we never spend scarce on-chain quotes on proven dead ends.
  const reverse = new Map();
  for (const [token, outgoing] of graph) for (const edge of outgoing) {
    const to = lower(edge.tokenOut.address);
    if (!reverse.has(to)) reverse.set(to, new Set());
    reverse.get(to).add(token);
  }
  const distanceToBase = new Map([[base, 0]]);
  const queue = [base];
  for (let pos = 0; pos < queue.length; pos++) {
    const token = queue[pos];
    for (const predecessor of reverse.get(token) || []) {
      if (!distanceToBase.has(predecessor)) {
        distanceToBase.set(predecessor, distanceToBase.get(token) + 1);
        queue.push(predecessor);
      }
    }
  }
  const candidates = [];
  let quotes = 0;
  let truncated = false;
  const deadline = Date.now() + maxDurationMs;
  const allowed = preferKinds === null ? infos : infos.filter((x) => preferKinds.includes(x.kind));
  const maxGasGweiExceeded = Number(gasPrice) / 1e9 > settings.maxGasGwei;

  // AUDIT M-B: reserve a fair quote budget for each requested loan size.
  const sizes = sizesFor(settings, net.stable.decimals);
  const perSize = Math.max(1, Math.floor(maxQuotes / sizes.length));
  let sizeQuotes = 0;
  let sizeTruncated = false;
  let rootQuotes = 0, rootBudget = perSize, rootExhausted = false;
  let rootsExplored = 0, rootsEligible = 0;
  async function getQuote(edge, amount) {
    if (quotes >= maxQuotes || sizeQuotes >= perSize || Date.now() >= deadline) { truncated = true; sizeTruncated = true; return null; }
    if (rootQuotes >= rootBudget) { truncated = true; rootExhausted = true; return null; }
    quotes++;
    sizeQuotes++;
    rootQuotes++;
    try {
      const {pool, tokenIn, tokenOut} = edge;
      const out = pool.type === 'v2'
        ? await chain.quoteV2(pool.router, amount, tokenIn.address, tokenOut.address, block)
        : await chain.quoteV3(pool.quoter, tokenIn.address, tokenOut.address, pool.fee, amount, block);
      return typeof out === 'bigint' && out > 0n ? out : null;
    } catch { return null; }
  }

  if (!graph.has(base)) return {candidates: [], scannedQuotes: 0, truncated: false, maxDepth, monitored: true};
  // AUDIT M-A: block mod root options can alias with a fixed block stride.
  const turn = BigInt(rotation ?? block);
  for (const size of sizes) {
    if (quotes >= maxQuotes || Date.now() >= deadline || candidates.length >= maxCandidates) { truncated = true; break; }
    sizeQuotes = 0;
    sizeTruncated = false;
    rootExhausted = false;
    const {best: provider, rejected} = selectProvider(allowed, size.units);
    const visitedTokens = new Set([base]);
    const usedPools = new Set();
    // Reserve enough calls for a complete minimum-depth route. Rotate root
    // branches between scans rather than allowing one DFS subtree to consume
    // the whole per-size quote budget. This is observation-only scheduling.
    const rootOptions = (graph.get(base) || []).filter(e => {
      const to = lower(e.tokenOut.address);
      return to !== base && distanceToBase.has(to) && distanceToBase.get(to) <= maxDepth - 1;
    });
    rootsEligible = Math.max(rootsEligible, rootOptions.length);
    const rootSlots = Math.max(1, Math.min(rootOptions.length, Math.floor(perSize / minDepth)));
    const rootBudgetForSize = Math.floor(perSize / rootSlots);
    let sizeRootsExplored = 0;
    const legs = [];

    async function walk(token, amount, depth) {
      if (sizeTruncated || candidates.length >= maxCandidates || (depth > 0 && rootExhausted)) { truncated = true; return; }
      // Rotate only the first-hop order between blocks, so an exhausted
      // quote budget does not permanently starve the same later branches.
      // No random ordering or price estimates are used to prioritize routes.
      const options = graph.get(token) || [];
      const outgoing = depth === 0 && options.length > 1
        ? [...options.slice(Number(turn % BigInt(options.length))), ...options.slice(0, Number(turn % BigInt(options.length)))]
        : options;
      for (const edge of outgoing) {
        if (sizeTruncated || candidates.length >= maxCandidates || (depth > 0 && rootExhausted)) { truncated = true; break; }
        if (depth === 0) {
          if (sizeRootsExplored >= rootSlots) { truncated = true; break; }
          // Only count branches which can return within the hop bound.
          const to = lower(edge.tokenOut.address);
          if (to === base || !distanceToBase.has(to) || distanceToBase.get(to) > maxDepth - 1) continue;
          sizeRootsExplored++;
          rootsExplored++;
          rootQuotes = 0;
          rootBudget = rootBudgetForSize;
          rootExhausted = false;
        }
        const next = lower(edge.tokenOut.address);
        const returning = next === base;
        if (returning && depth + 1 > maxDepth) continue;
        if (usedPools.has(edge.pool.key)) continue;
        if (returning && depth + 1 < minDepth) continue;
        if (!returning && (depth + 1 >= maxDepth || visitedTokens.has(next))) continue;
        if (!returning && (!distanceToBase.has(next) || distanceToBase.get(next) > maxDepth - depth - 1)) continue;
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
          const blockers = [];
          if (!allowExecution) blockers.push('multi-hop execution requires separate validation and explicit opt-in');
          if (!provider) blockers.push('no flash provider: ' + (rejected.map((v) => `${v.kind} ${v.reason}`).join(', ') || 'none configured'));
          if (maxGasGweiExceeded) blockers.push('gas above ceiling');
          if (gasUnits > BigInt(settings.maxGasUnits)) blockers.push('estimated gas above configured units ceiling');
          if (toFloat(gasStable, net.stable.decimals) > settings.maxGasPerTxUSD) blockers.push('estimated gas above per-transaction USD ceiling');
          if (toFloat(profit.net, net.stable.decimals) < settings.minProfitUSD) blockers.push('below minimum net profit');
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
            status: 'QUOTE_ONLY', executable: allowExecution && blockers.length === 0,
            mode: allowExecution ? 'MULTIHOP_EXECUTION_CANDIDATE' : 'MULTIHOP_OBSERVE_ONLY',
            hopCount: legs.length, blockers,
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
  return {candidates, scannedQuotes: quotes, truncated, maxDepth, monitored: true,
    rootsExplored, rootsEligible};
}
