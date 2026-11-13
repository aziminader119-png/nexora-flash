#!/usr/bin/env node
// Read-only real-market smoke test. Does NOT load a signer, create a transaction,
// use a wallet, deploy a contract, or enable LIVE_EXECUTION.
// This test NEVER manipulates pool prices (unlike the deterministic fork harness).
import fs from 'node:fs';
import path from 'node:path';
import {NETWORKS, withEnvProviders} from '../lib/networks.mjs';
import {DEFAULT_SETTINGS} from '../lib/settings.mjs';
import {makeChain} from '../lib/chain-ethers.mjs';
import {scanNetwork} from '../lib/scanner.mjs';

const settings = structuredClone(DEFAULT_SETTINGS);
const report = {
  schema: 1,
  mode: 'SCAN_ONLY',
  generatedAt: new Date().toISOString(),
  productionTradingEnabled: false,
  usesArtificialDislocation: false,
  settings: {
    loanSizesUSD: settings.sizeSteps.map((v) => settings.loanSize * v),
    maxLoanUSD: settings.maxLoanUSD,
    minNetProfitUSD: settings.minProfitUSD,
    maxGasGwei: settings.maxGasGwei,
  },
  networks: [],
};
const env = {...process.env, ENABLE_BALANCER_V2: 'false'};
await Promise.all(NETWORKS.map(async (base) => {
  // Do not disclose custom RPC URLs, API keys or environment settings in results.
  const net = withEnvProviders(base, env);
  const chain = makeChain(net, process.env[`RPC_${net.id}`] || net.rpcDefault, {timeoutMs: 9000});
  try {
    const {state, candidates} = await scanNetwork({chain, net, settings});
    const positive = candidates.filter((c) => c.netEstimate >= settings.minProfitUSD);
    report.networks.push({
      id: net.id, name: net.name, status: state.status, error: state.error || null,
      block: state.block, estimatedGasGwei: state.gasGwei,
      quotedRoutes: candidates.length, aboveMinNet: positive.length,
      executableAboveMinNet: positive.filter((c) => c.executable).length,
      top: candidates.slice(0, 10).map((c) => ({
        pair: c.pair, buy: c.buy, sell: c.sell, loanUSD: c.size,
        estimatedGrossUSD: c.gross, estimatedFlashFeeUSD: c.flashFee,
        estimatedGasUSD: c.gasCost, estimatedNetUSD: c.netEstimate,
        provider: c.provider?.kind || null, executable: c.executable,
        blockers: c.blockers,
      })),
    });
  } catch (e) {
    report.networks.push({id: net.id, name: net.name, status: 'unavailable',
      error: String(e.message || e).slice(0, 200), quotedRoutes: 0,
      aboveMinNet: 0, executableAboveMinNet: 0, top: []});
  } finally {
    chain.destroy();
  }
}));
report.networks.sort((a, b) => a.id - b.id);
report.summary = {
  networksQuoting: report.networks.filter((n) => n.status === 'quotes-live').length,
  totalQuotedRoutes: report.networks.reduce((sum, n) => sum + n.quotedRoutes, 0),
  aboveMinNet: report.networks.reduce((sum, n) => sum + n.aboveMinNet, 0),
  executableAboveMinNet: report.networks.reduce((sum, n) => sum + n.executableAboveMinNet, 0),
  executedTrades: 0,
};
const output = path.join('validation', 'market-scan.json');
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log('NEXORA read-only live market scan: NO ORDERS, NO WALLET, NO TRADES');
for (const n of report.networks)
  console.log(`${n.name}: ${n.status}, block=${n.block ?? 'n/a'}, quoted=${n.quotedRoutes}, eligible=${n.executableAboveMinNet}${n.error ? ', error=' + n.error : ''}`);
console.log('Summary:', JSON.stringify(report.summary));
console.log('Saved:', output);
// A useful failure signal; RPC outages must not be misreported as 0 opportunities.
if (!report.summary.networksQuoting) process.exitCode = 1;
