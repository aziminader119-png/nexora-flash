// Converts a scanner candidate into the exact on-chain Plan struct for NexoraFlashExecutor.start().
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export function validateFreshCandidate(c, {currentBlock, now, maxQuoteAgeMs, maxBlockLag = 64}) {
  if (!c || !Number.isSafeInteger(currentBlock) || currentBlock < 0) throw Error('Invalid chain block');
  if (!Number.isSafeInteger(c.block) || c.block > currentBlock || currentBlock - c.block > maxBlockLag) throw Error('Stale opportunity block');
  const t = Date.parse(c.at);
  if (!Number.isFinite(t) || t > now + 1000 || now - t > maxQuoteAgeMs) throw Error('Stale opportunity quote');
  if (c.status !== 'QUOTE_ONLY' || c.executable !== true || c.mode === 'MULTIHOP_OBSERVE_ONLY') throw Error('Route not executable');
  return true;
}

/**
 * @param c candidate from scanner
 * @param opts.slippageBps per-leg slippage allowance (compounding along the path)
 * @param opts.minProfitUnits on-chain profit floor (BigInt, > 0)
 * @param opts.maxFeeUnits maximum lender fee accepted on-chain (BigInt)
 * @param opts.deadline unix seconds
 */
export function buildPlan(c, {slippageBps, minProfitUnits, maxFeeUnits, deadline}) {
  if (!c?.provider || !ADDR.test(c.provider.address)) throw Error('Candidate has no flash provider');
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 200) throw Error('Invalid slippage');
  if (typeof minProfitUnits !== 'bigint' || minProfitUnits <= 0n) throw Error('Minimum profit must be positive');
  if (typeof maxFeeUnits !== 'bigint' || maxFeeUnits < 0n) throw Error('Invalid max fee');
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw Error('Invalid deadline');
  if (!Array.isArray(c.legs) || c.legs.length < 2 || c.legs.length > 10) throw Error('Invalid leg count');
  if (c.legs[0].tokenIn.toLowerCase() !== c.asset.toLowerCase() || c.legs.at(-1).tokenOut.toLowerCase() !== c.asset.toLowerCase()) throw Error('Not a round trip');
  let keep = 10000n;
  // For routes over four swaps, the configured slippage is a TOTAL-route
  // budget, not a separate full allowance repeated ten times.
  // Rounded down per hop: fail closed if some legs cannot clear this limit.
  const perLegSlippage = c.legs.length > 4
    ? Math.floor(slippageBps / c.legs.length)
    : slippageBps;
  const legs = c.legs.map((l, i) => {
    if (!ADDR.test(l.router) || !ADDR.test(l.tokenIn) || !ADDR.test(l.tokenOut)) throw Error('Invalid leg address');
    if (i > 0 && c.legs[i - 1].tokenOut.toLowerCase() !== l.tokenIn.toLowerCase()) throw Error('Broken path');
    if (![0, 1, 2].includes(l.routerKind)) throw Error('Unsupported router kind');
    if ((l.routerKind === 0) !== (Number(l.fee) === 0)) throw Error('Fee tier inconsistent with router kind');
    const quoted = BigInt(l.quotedOut);
    if (quoted <= 0n) throw Error('Invalid quote');
    keep = keep * BigInt(10000 - perLegSlippage) / 10000n;
    return {router: l.router, kind: l.routerKind, tokenIn: l.tokenIn, tokenOut: l.tokenOut, fee: Number(l.fee), minOut: quoted * keep / 10000n};
  });
  return {
    provider: c.provider.address,
    asset: c.asset,
    amount: BigInt(c.amount),
    maxFee: maxFeeUnits,
    minProfit: minProfitUnits,
    deadline: BigInt(deadline),
    legs,
  };
}

/** Quote-to-simulation consistency: simulated gross must be within tolerance of the quoted gross. */
export function checkQuoteConsistency({quotedOut, amount, simProfit, simFee, toleranceBps}) {
  const simOut = BigInt(amount) + BigInt(simProfit) + BigInt(simFee);
  const q = BigInt(quotedOut);
  const tol = q * BigInt(toleranceBps) / 10000n;
  if (simOut + tol < q) throw Error(`Simulation output ${simOut} below quote ${q} beyond tolerance`);
  return {simOut, deviation: simOut - q};
}
