#!/usr/bin/env node
// Passive market observation. Never sends a transaction and never moves prices.
//   node scripts/observe-market.mjs --minutes 60 [--interval 15] [--chains 56,8453,42161,10,137]
// Each cycle scans real pools on the configured RPCs. If EXECUTOR_<chainId> is set and a candidate is positive,
// the exact start() call is also simulated (eth_call, from the configured operator address) so quoted vs.
// simulated profit can be compared. Realized profit can only come from confirmed trades (see the journal).
// Output: validation/observation-<timestamp>.jsonl + .md summary. Zero opportunities is a valid, recorded result.
import fs from 'node:fs';
import path from 'node:path';
import {NETWORKS, withEnvProviders} from '../lib/networks.mjs';
import {makeChain} from '../lib/chain-ethers.mjs';
import {scanNetwork} from '../lib/scanner.mjs';
import {DEFAULT_SETTINGS} from '../lib/settings.mjs';
import {buildPlan} from '../lib/planner.mjs';
import {protectedFloorUnits} from '../lib/profit.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const minutes = Number(arg('minutes', '60'));
const interval = Number(arg('interval', '15')) * 1000;
const ids = arg('chains', NETWORKS.map((n) => n.id).join(',')).split(',').map(Number);
const nets = NETWORKS.filter((n) => ids.includes(n.id)).map((n) => withEnvProviders(n));
const settings = {...structuredClone(DEFAULT_SETTINGS), enabledChains: nets.map((n) => n.id)};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.mkdirSync('validation', {recursive: true});
const out = path.join('validation', `observation-${stamp}.jsonl`);
const chains = new Map(nets.map((n) => [n.id, makeChain(n, process.env[`RPC_${n.id}`] || n.rpcDefault, {timeoutMs: 15000})]));
const stats = new Map(nets.map((n) => [n.id, {name: n.name, cycles: 0, failedCycles: 0, quoted: 0, positive: 0, executablePositive: 0, simulated: 0, simReverted: 0, bestNet: null, blocks: []}]));
const end = Date.now() + minutes * 60000;

while (Date.now() < end) {
  const t0 = Date.now();
  await Promise.all(nets.map(async (net) => {
    const st = stats.get(net.id);
    const chain = chains.get(net.id);
    const {state, candidates} = await scanNetwork({chain, net, settings});
    st.cycles++;
    if (state.status !== 'quotes-live') { st.failedCycles++; fs.appendFileSync(out, JSON.stringify({at: new Date().toISOString(), chainId: net.id, error: state.error}) + '\n'); return; }
    st.blocks.push(state.block);
    st.quoted += candidates.length;
    const pos = candidates.filter((c) => c.netEstimate > 0);
    st.positive += pos.length;
    for (const c of pos) {
      if (st.bestNet == null || c.netEstimate > st.bestNet) st.bestNet = c.netEstimate;
      const rec = {at: c.at, chainId: net.id, block: c.block, route: `${c.buy} -> ${c.sell}`, provider: c.provider?.kind, size: c.size, quotedGross: c.gross, lenderFee: c.flashFee, gasEstimate: c.gasCost, quotedNet: c.netEstimate, executable: c.executable, blockers: c.blockers};
      const exe = process.env[`EXECUTOR_${net.id}`];
      const from = process.env.OPERATOR_ADDRESS;
      if (c.executable) st.executablePositive++;
      if (c.executable && exe && from) {
        st.simulated++;
        try {
          const plan = buildPlan(c, {slippageBps: settings.slippageBps, minProfitUnits: protectedFloorUnits({minNetUnits: 1n, gasStableUnits: BigInt(c.gasStableUnits)}), maxFeeUnits: BigInt(c.provider.fee), deadline: Math.floor(Date.now() / 1000) + 60});
          const sim = await chain.simulateStart(exe, plan, from);
          rec.simulatedProfitUnits = sim.profit.toString();
          rec.simulatedNet = Number(sim.profit) / 10 ** c.decimals - c.gasCost;
        } catch (e) { st.simReverted++; rec.simulation = String(e.message).slice(0, 160); }
      }
      fs.appendFileSync(out, JSON.stringify(rec) + '\n');
    }
  }));
  await new Promise((r) => setTimeout(r, Math.max(0, interval - (Date.now() - t0))));
}

const md = [`# Passive market observation ${stamp}`, '', `Duration ${minutes} min, interval ${interval / 1000}s, loan sizes ${settings.sizeSteps.map((f) => f * settings.loanSize).join('/')} (stable units). No transactions were sent; prices were not moved.`, '',
  '| Network | Cycles | Failed | First–last block | Routes quoted | Quoted net > 0 | Executable & > 0 | Simulated | Sim reverted | Best quoted net |', '|---|---|---|---|---|---|---|---|---|---|',
  ...[...stats.values()].map((s) => `| ${s.name} | ${s.cycles} | ${s.failedCycles} | ${s.blocks[0] ?? '—'}–${s.blocks.at(-1) ?? '—'} | ${s.quoted} | ${s.positive} | ${s.executablePositive} | ${s.simulated} | ${s.simReverted} | ${s.bestNet == null ? 'none' : s.bestNet.toFixed(4)} |`),
  '', 'Quoted values are estimates; simulated values are eth_call results; realized values exist only for confirmed transactions in the execution journal.', `Raw records: ${out}`];
fs.writeFileSync(out.replace(/\.jsonl$/, '.md'), md.join('\n'));
console.log(md.join('\n'));
for (const c of chains.values()) c.destroy();
