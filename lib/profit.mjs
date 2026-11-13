// Integer-exact fee, gas and profit arithmetic (token base units, BigInt only).
import {GAS_MODEL} from './networks.mjs';

/** Aave V3 premium: WadRayMath.percentMul -> (amount * bps + 5000) / 10000 (half-up). */
export const aavePremium = (amount, bps) => (amount * BigInt(bps) + 5000n) / 10000n;

/** Balancer V2: FixedPoint.mulUp(amount, feePercentage) with 1e18 = 100%. */
export function balancerFee(amount, pctWad) {
  const product = amount * BigInt(pctWad);
  return product === 0n ? 0n : (product - 1n) / 10n ** 18n + 1n;
}

export function providerFee(info, amount) {
  if (info.feeModel === 'aave-bps') return aavePremium(amount, info.feeParam);
  if (info.feeModel === 'balancer-wad') return balancerFee(amount, info.feeParam);
  if (info.feeModel === 'zero') return 0n;
  throw Error(`Unknown fee model ${info.feeModel}`);
}

/** Choose the cheapest healthy provider able to lend `amount`; ties go to the lower-gas provider. */
export function selectProvider(infos, amount) {
  const ranked = [];
  const rejected = [];
  for (const info of infos || []) {
    if (!info || !info.ok) { rejected.push({address: info?.address, kind: info?.kind, reason: info?.error || 'unavailable'}); continue; }
    if (info.available < amount) { rejected.push({address: info.address, kind: info.kind, reason: 'insufficient liquidity'}); continue; }
    const fee = providerFee(info, amount);
    ranked.push({...info, fee, gas: GAS_MODEL[info.kind] ?? 120000n});
  }
  ranked.sort((a, b) => (a.fee === b.fee ? (a.gas < b.gas ? -1 : a.gas > b.gas ? 1 : 0) : a.fee < b.fee ? -1 : 1));
  return {best: ranked[0] || null, ranked, rejected};
}

export function routeGasUnits(providerKind, legs) {
  let g = GAS_MODEL.base + (GAS_MODEL[providerKind] ?? 120000n);
  for (const l of legs) g += l.type === 'v2' ? GAS_MODEL.v2Leg : GAS_MODEL.v3Leg;
  return g;
}

/** Convert native wei to stable units using an on-chain native price (stable units per 1e18 wei). */
export const weiToStable = (wei, nativePriceUnits) => (wei * nativePriceUnits + 10n ** 18n - 1n) / 10n ** 18n; // round up (conservative)

/**
 * Net profit after lender fee and gas, in stable base units.
 * outUnits: final stable out of the route; amount: principal; fee: lender fee; gasStable: gas cost in stable units.
 */
export function netProfitUnits({amount, outUnits, fee, gasStable}) {
  for (const v of [amount, outUnits, fee, gasStable]) if (typeof v !== 'bigint' || v < 0n) throw Error('Invalid integer input');
  const gross = outUnits - amount;
  return {gross, afterFee: gross - fee, net: gross - fee - gasStable};
}

/**
 * On-chain minimum profit floor: target net + gas reserve * (1 + safety). Enforced by the contract, so an
 * optimistic off-chain estimate can never authorise a transaction that would lose money after gas.
 */
export function protectedFloorUnits({minNetUnits, gasStableUnits, safetyBps = 2000}) {
  if (typeof minNetUnits !== 'bigint' || minNetUnits <= 0n) throw Error('Minimum net profit must be positive');
  if (typeof gasStableUnits !== 'bigint' || gasStableUnits < 0n) throw Error('Invalid gas reserve');
  if (!Number.isInteger(safetyBps) || safetyBps < 0 || safetyBps > 10000) throw Error('Invalid safety margin');
  return minNetUnits + (gasStableUnits * BigInt(10000 + safetyBps) + 9999n) / 10000n;
}
