// Market scanner: on-chain quotes only (V2 getAmountsOut / V3 QuoterV2) pinned to one block per cycle.
// No price APIs, no synthetic inputs. Output candidates are QUOTES until the executor re-simulates them on-chain.
import {pools, PROVIDER_KIND} from './networks.mjs';
import {parseUnits, toFloat} from './units.mjs';
import {selectProvider, routeGasUnits, weiToStable, netProfitUnits} from './profit.mjs';

const OP_STACK_TX_BYTES = 1100; // conservative size of a signed start() transaction (2 legs)

export function sizesFor(settings, decimals) {
  const seen = new Set();
  const out = [];
  for (const f of settings.sizeSteps) {
    const usd = Math.max(10, Math.floor(settings.loanSize * f * 100) / 100);
    const units = parseUnits(usd.toFixed(2), decimals);
    if (!seen.has(units)) { seen.add(units); out.push({usd, units}); }
  }
  return out;
}

async function quote(chain, pool, tokenIn, tokenOut, amountIn, blockTag) {
  try {
    const out = pool.type === 'v2'
      ? await chain.quoteV2(pool.router, amountIn, tokenIn, tokenOut, blockTag)
      : await chain.quoteV3(pool.quoter, tokenIn, tokenOut, pool.fee, amountIn, blockTag);
    return typeof out === 'bigint' && out > 0n ? out : null;
  } catch {
    return null;
  }
}

/**
 * @param preferKinds optional list of provider kinds that passed the validation gate for this network; selection is
 *        restricted to them when any is available, so the attached lender is one the executor is allowed to use.
 */
export async function scanNetwork({chain, net, settings, now = () => Date.now(), preferKinds = null}) {
  const state = {chainId: net.id, name: net.name, status: 'checking', block: null, gasGwei: null, providers: [], nativePrice: null, error: null, quotedPools: 0};
  const candidates = [];
  try {
    const [cid, block, feeData] = await Promise.all([chain.chainId(), chain.blockNumber(), chain.feeData()]);
    if (cid !== net.id) throw Error(`RPC chainId ${cid} does not match ${net.id}`);
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
    if (typeof gasPrice !== 'bigint' || gasPrice <= 0n) throw Error('Unable to read gas price');
    state.block = block;
    state.gasGwei = Number(gasPrice) / 1e9;
    const at = new Date(now()).toISOString();

    const infos = await Promise.all(net.providers.map(async (p) => {
      try { return {...(await chain.providerInfo(p, net.stable.address, block)), kind: p.kind, address: p.address}; }
      catch (e) { return {kind: p.kind, address: p.address, ok: false, error: String(e.shortMessage || e.message || e).slice(0, 120)}; }
    }));
    state.providers = infos.map((i) => ({kind: i.kind, address: i.address, ok: !!i.ok, available: i.ok ? toFloat(i.available, net.stable.decimals) : null, feeModel: i.feeModel, feeParam: i.feeParam != null ? String(i.feeParam) : null, error: i.error || null}));

    const all = pools(net);
    const S = net.stable.address;
    const W = net.wrapped.address;
    const oneWrapped = 10n ** BigInt(net.wrapped.decimals);
    const nativeQuotes = (await Promise.all(all.map((p) => quote(chain, p, W, S, oneWrapped, block)))).filter(Boolean);
    if (!nativeQuotes.length) throw Error('No on-chain native price quote');
    // Highest quote => most expensive gas in stable terms (conservative).
    const nativePrice = nativeQuotes.reduce((a, b) => (b > a ? b : a));
    state.nativePrice = toFloat(nativePrice, net.stable.decimals);
    // Continue quoting with expensive gas so market data stays visible.
    // Every high-gas quote is blocked from execution.
    const gasAboveCeiling = state.gasGwei > settings.maxGasGwei;
    const l1FeeWei = net.l1Fee === 'op-stack' ? BigInt(await chain.l1FeeWei(OP_STACK_TX_BYTES)) * 3n / 2n : 0n;

    for (const size of sizesFor(settings, net.stable.decimals)) {
      // A non-null allow-list is authoritative. An empty list means the gate
      // has validated no lender for this chain, NOT 'use every lender'.
      const eligibleInfos = preferKinds == null ? infos : infos.filter((i) => preferKinds.includes(i.kind));
      const {best: provider, rejected} = selectProvider(eligibleInfos, size.units);
      const buys = await Promise.all(all.map(async (p) => ({pool: p, out: await quote(chain, p, S, W, size.units, block)})));
      for (const b of buys.filter((x) => x.out)) {
        state.quotedPools++;
        const sells = await Promise.all(all.filter((p) => p.key !== b.pool.key).map(async (p) => ({pool: p, out: await quote(chain, p, W, S, b.out, block)})));
        for (const s of sells.filter((x) => x.out)) {
          const legs = [
            {venueId: b.pool.venueId, pool: b.pool.key, name: b.pool.name, type: b.pool.type, router: b.pool.router, routerKind: b.pool.routerKind, fee: b.pool.fee, tokenIn: S, tokenOut: W, quotedOut: b.out.toString(), forkValidated: b.pool.forkValidated},
            {venueId: s.pool.venueId, pool: s.pool.key, name: s.pool.name, type: s.pool.type, router: s.pool.router, routerKind: s.pool.routerKind, fee: s.pool.fee, tokenIn: W, tokenOut: S, quotedOut: s.out.toString(), forkValidated: s.pool.forkValidated},
          ];
          const fee = provider ? provider.fee : 0n;
          const gasUnits = routeGasUnits(provider?.kind || 'AAVE_V3', legs);
          const gasStable = weiToStable(gasUnits * gasPrice + l1FeeWei, nativePrice);
          const p = netProfitUnits({amount: size.units, outUnits: s.out, fee, gasStable});
          const blockers = [];
          if (gasAboveCeiling) blockers.push(`Gas ${state.gasGwei.toFixed(4)} gwei above ceiling ${settings.maxGasGwei}`);
          if (!provider) blockers.push(`no flash provider: ${rejected.map((r) => `${r.kind} ${r.reason}`).join(', ') || 'none configured'}`);
          if (!b.pool.forkValidated || !s.pool.forkValidated) blockers.push('venue not fork-validated');
          if (b.pool.router.toLowerCase() === s.pool.router.toLowerCase() && b.pool.type === 'v2') blockers.push('same V2 router both legs');
          const d = net.stable.decimals;
          candidates.push({
            id: `${net.id}:${block}:${size.usd}:${b.pool.key}>${s.pool.key}`,
            chainId: net.id, network: net.name, block, at, pair: `${net.stable.symbol}/${net.wrapped.symbol}`,
            size: size.usd, amount: size.units.toString(), asset: S, assetSymbol: net.stable.symbol, decimals: d,
            provider: provider ? {kind: provider.kind, kindId: PROVIDER_KIND[provider.kind], address: provider.address, fee: provider.fee.toString()} : null,
            legs, buy: b.pool.name, sell: s.pool.name,
            grossUnits: p.gross.toString(), feeUnits: fee.toString(), gasStableUnits: gasStable.toString(), netUnits: p.net.toString(), gasUnits: gasUnits.toString(),
            gross: toFloat(p.gross, d), flashFee: toFloat(fee, d), gasCost: toFloat(gasStable, d), netEstimate: toFloat(p.net, d),
            nativePriceUnits: nativePrice.toString(), gasPriceWei: gasPrice.toString(),
            status: 'QUOTE_ONLY', executable: blockers.length === 0, blockers,
          });
        }
      }
    }
    candidates.sort((x, y) => y.netEstimate - x.netEstimate);
    state.status = 'quotes-live';
  } catch (e) {
    state.status = 'unavailable';
    state.error = String(e.shortMessage || e.message || e).slice(0, 200);
  }
  return {state, candidates};
}
