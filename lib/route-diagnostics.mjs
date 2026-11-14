// Read-only quote diagnostics. Never changes trade plans, execution gates or slippage floors.
// Per-hop output tokens have different units/prices; DO NOT interpret a raw
// amount ratio as a USD return. Only same-pool same-direction scale comparisons
// are valid as a rough price-impact warning.
const MAX_PROBES = 20;
const MAX_ROUTES = 4;

export function traceAmounts(candidate, routeEdges = []) {
  if (!candidate || !Array.isArray(candidate.legs) || !candidate.legs.length) return [];
  let amount;
  try { amount = BigInt(candidate.amount); } catch { return []; }
  if (amount <= 0n) return [];
  return candidate.legs.map((leg, index) => {
    const matching = routeEdges.find(e =>
      String(e.pool?.key).toLowerCase() === String(leg.pool).toLowerCase() &&
      String(e.tokenIn?.address).toLowerCase() === String(leg.tokenIn).toLowerCase() &&
      String(e.tokenOut?.address).toLowerCase() === String(leg.tokenOut).toLowerCase());
    const amountIn = amount;
    try { amount = BigInt(leg.quotedOut); } catch { amount = 0n; }
    return {
      hop: index + 1, pool: leg.pool, venue: leg.name,
      tokenIn: leg.tokenIn, tokenOut: leg.tokenOut,
      tokenInSymbol: matching?.tokenIn?.symbol ?? null,
      tokenOutSymbol: matching?.tokenOut?.symbol ?? null,
      amountInUnits: amountIn.toString(), amountOutUnits: amount.toString(),
      priceImpactBps: null, impactStatus: 'NOT_PROBED',
    };
  });
}

export async function probeRouteImpact({chain, candidates=[], routeEdges=[], block, maxProbes=MAX_PROBES,
  maxRoutes=MAX_ROUTES, probeDenominator=10, warningBps=300, hardWarningBps=1500}) {
  if (!Number.isInteger(maxProbes) || maxProbes < 0 || maxProbes > MAX_PROBES ||
      !Number.isInteger(maxRoutes) || maxRoutes < 0 || maxRoutes > MAX_ROUTES ||
      !Number.isInteger(probeDenominator) || probeDenominator < 2 || probeDenominator > 100 ||
      !Number.isInteger(warningBps) || warningBps < 0 || warningBps > 10000 ||
      !Number.isInteger(hardWarningBps) || hardWarningBps < warningBps || hardWarningBps > 10000)
    throw Error('Invalid impact probe limits');
  let used = 0;
  const diagnostics = new Map();
  for (const candidate of candidates.slice(0, maxRoutes)) {
    const trace = traceAmounts(candidate, routeEdges);
    let highest = null, failed = 0;
    for (let i = 0; i < trace.length; i++) {
      const leg = candidate.legs[i], row = trace[i];
      if (used >= maxProbes) break;
      const fullIn = BigInt(row.amountInUnits);
      const fullOut = BigInt(row.amountOutUnits);
      const smallIn = fullIn / BigInt(probeDenominator);
      if (smallIn <= 0n || fullOut <= 0n) { row.impactStatus = 'UNAVAILABLE'; failed++; continue; }
      used++;
      try {
        const smallOut = leg.type === 'v2'
          ? await chain.quoteV2(leg.router, smallIn, leg.tokenIn, leg.tokenOut, block)
          : await chain.quoteV3(routeEdges.find(e =>
              String(e.pool?.key).toLowerCase() === String(leg.pool).toLowerCase() &&
              String(e.tokenIn?.address).toLowerCase() === String(leg.tokenIn).toLowerCase())?.pool?.quoter,
              leg.tokenIn, leg.tokenOut, leg.fee, smallIn, block);
        if (typeof smallOut !== 'bigint' || smallOut <= 0n) { row.impactStatus='UNAVAILABLE'; failed++; continue; }
        const linear = smallOut * fullIn / smallIn;
        if (linear <= 0n) { row.impactStatus='UNAVAILABLE'; failed++; continue; }
        // Negative impact is clipped; positive impact indicates a less-than-linear quote
        // for the larger size, but does not prove market depth or USD value.
        const bps = fullOut >= linear ? 0 : Number(((linear - fullOut) * 10000n + linear - 1n) / linear);
        row.priceImpactBps = Math.min(bps, 10000);
        row.impactStatus = bps >= hardWarningBps ? 'HIGH_IMPACT' : bps >= warningBps ? 'WARNING' : 'OK';
        highest = Math.max(highest ?? 0, row.priceImpactBps);
      } catch {
        row.impactStatus = 'UNAVAILABLE';
        failed++;
      }
    }
    const probed = trace.filter(x => x.impactStatus === 'OK' ||
      x.impactStatus === 'WARNING' || x.impactStatus === 'HIGH_IMPACT').length;
    diagnostics.set(candidate.id, {
      method:'SAME_POOL_10_PERCENT_QUOTE_SCALE',block,
      trace, quotedHops:probed, totalHops:trace.length,
      probesIncomplete:probed !== trace.length, failedQuotes:failed,
      maximumImpactBps:highest,
      liquidityRisk:highest === null ? 'UNKNOWN' :
        highest >= hardWarningBps ? 'HIGH' :
        highest >= warningBps ? 'ELEVATED' : 'NO_LARGE_IMPACT_OBSERVED',
      caveat:'A same-block quote-size comparison, NOT an oracle USD valuation or a proof of executable profit.',
    });
  }
  return {diagnostics, probesUsed:used, capReached:used>=maxProbes};
}
