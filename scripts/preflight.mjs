#!/usr/bin/env node
// Read-only production preflight. For each network: RPC + chain id, bytecode at every configured address,
// flash-provider health/liquidity/fee, a real on-chain quote, and (if configured) the deployed executor's
// roles, allow-lists, cap, pause state and codehash vs the validation report. Non-zero exit on any failure
// for a network listed in LIVE_CHAINS (comma separated) or, by default, any network with EXECUTOR_<id>.
import {NETWORKS, withEnvProviders, pools, PROVIDER_KIND} from '../lib/networks.mjs';
import {makeChain} from '../lib/chain-ethers.mjs';
import {loadGateReport, globalGateBlockers, networkGateBlockers} from '../lib/gates.mjs';
import {loadSigner} from '../lib/keys.mjs';
import {toFloat} from '../lib/units.mjs';

const report = loadGateReport(process.env.GATE_REPORT || 'validation/gate-report.json');
const signer = await loadSigner().catch((e) => { console.log(`signer: ${e.message}`); return null; });
const strict = (process.env.LIVE_CHAINS || '').split(',').filter(Boolean).map(Number);
let failures = 0;
console.log(`Validation gate: ${globalGateBlockers(report).join('; ') || 'PASS'}`);
console.log(`Operator signer: ${signer?.address || 'not loaded'}\n`);

for (const net0 of NETWORKS) {
  const net = withEnvProviders(net0);
  const exeAddr = process.env[`EXECUTOR_${net.id}`];
  const critical = strict.length ? strict.includes(net.id) : Boolean(exeAddr);
  const chain = makeChain(net, process.env[`RPC_${net.id}`] || net.rpcDefault, {timeoutMs: 15000});
  const lines = [];
  let ok = true;
  const check = async (label, fn) => {
    try { const v = await fn(); lines.push(`  PASS ${label}${v ? ': ' + v : ''}`); return true; }
    catch (e) { ok = false; lines.push(`  FAIL ${label}: ${String(e.shortMessage || e.message).slice(0, 160)}`); return false; }
  };
  await check('rpc chain id', async () => { const id = await chain.chainId(); if (id !== net.id) throw Error(`got ${id}`); return `block ${await chain.blockNumber()}`; });
  const addrs = [['stable', net.stable.address], ['wrapped', net.wrapped.address], ...net.providers.map((p) => [p.kind, p.address]), ...net.venues.map((v) => [v.name, v.router]), ...net.venues.filter((v) => v.quoter).map((v) => [`${v.name} quoter`, v.quoter])];
  for (const [label, a] of addrs) await check(`code ${label}`, async () => { if (!(await chain.codehash(a))) throw Error(`no code at ${a}`); return a; });
  const block = await chain.blockNumber().catch(() => 'latest');
  for (const p of net.providers) {
    await check(`provider ${p.kind}`, async () => {
      const i = await chain.providerInfo(p, net.stable.address, block);
      if (!i.ok) throw Error(i.error);
      return `available ${toFloat(i.available, net.stable.decimals).toLocaleString()} ${net.stable.symbol}, fee ${i.feeModel}:${i.feeParam}`;
    });
  }
  const one = 10n ** BigInt(net.wrapped.decimals);
  for (const pool of pools(net)) {
    await check(`quote ${pool.name}${pool.forkValidated ? '' : ' (quote-only venue)'}`, async () => {
      const out = pool.type === 'v2' ? await chain.quoteV2(pool.router, one, net.wrapped.address, net.stable.address, block) : await chain.quoteV3(pool.quoter, net.wrapped.address, net.stable.address, pool.fee, one, block);
      return `1 ${net.wrapped.symbol} = ${toFloat(out, net.stable.decimals)} ${net.stable.symbol}`;
    });
  }
  if (exeAddr) {
    await check('executor', async () => {
      const routers = net.venues.filter((v) => v.forkValidated).map((v) => v.router);
      const st = await chain.executorState(exeAddr, {provider: net.providers[0].address, routers, tokens: [net.stable.address, net.wrapped.address], asset: net.stable.address});
      if (signer && st.operator.toLowerCase() !== signer.address.toLowerCase()) throw Error(`operator ${st.operator} != signer ${signer.address}`);
      if (st.owner.toLowerCase() === st.operator.toLowerCase()) throw Error('owner and operator must be different keys');
      if (Number(st.providerKind) !== PROVIDER_KIND[net.providers[0].kind]) throw Error('primary provider not allow-listed');
      if (!st.routersAllowed.every(Boolean) || !st.tokensAllowed.every(Boolean)) throw Error('allow-lists incomplete');
      return `owner ${st.owner}, operator ${st.operator}, paused=${st.paused}, maxLoan ${toFloat(st.maxLoan, net.stable.decimals)} ${net.stable.symbol}`;
    });
    await check('executor gate binding', async () => {
      const codehash = await chain.codehash(exeAddr);
      const b = net.providers.map((p) => [p.kind, networkGateBlockers(report, {suite: net.forkSuite, providerKind: p.kind, onchainCodehash: codehash})]);
      const usable = b.filter(([, x]) => !x.length).map(([k]) => k);
      if (!usable.length) throw Error(b.map(([k, x]) => `${k}: ${x.join(', ')}`).join(' | '));
      return `live-eligible providers: ${usable.join(', ')}`;
    });
    if (signer) await check('operator gas balance', async () => `${toFloat(await chain.getBalance(signer.address), 18)} ${net.native}`);
  }
  console.log(`${ok ? 'PASS' : critical ? 'FAIL' : 'WARN'} ${net.name} (${net.id})${critical ? ' [live-critical]' : ''}`);
  console.log(lines.join('\n'));
  if (!ok && critical) failures++;
  chain.destroy();
}
console.log(`\nPreflight ${failures ? 'FAILED' : 'passed'} (read-only; no transaction was sent).`);
process.exit(failures ? 1 : 0);
