import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildPlan, validateFreshCandidate, checkQuoteConsistency} from '../lib/planner.mjs';
import {Journal} from '../lib/journal.mjs';
import {globalGateBlockers, networkGateBlockers, parseForgeJson, forkTestPassed} from '../lib/gates.mjs';
import {passingReport, CODEHASH} from './helpers/fake-chain.mjs';

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), R1 = '0x' + '3'.repeat(40), R2 = '0x' + '4'.repeat(40), P = '0x' + '5'.repeat(40);
const cand = (over = {}) => ({
  id: 'x', block: 100, at: new Date(1_700_000_000_000).toISOString(), status: 'QUOTE_ONLY', executable: true,
  asset: A, amount: '1000000000', provider: {kind: 'AAVE_V3', address: P, fee: '500000'},
  legs: [
    {router: R1, routerKind: 0, fee: 0, tokenIn: A, tokenOut: B, quotedOut: '500000000000000000'},
    {router: R2, routerKind: 1, fee: 500, tokenIn: B, tokenOut: A, quotedOut: '1016000000'},
  ],
  ...over,
});
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-')), 'journal.jsonl');

test('plan: compounding slippage floors and exact struct', () => {
  const p = buildPlan(cand(), {slippageBps: 30, minProfitUnits: 4_200000n, maxFeeUnits: 500000n, deadline: 1_700_000_060});
  assert.equal(p.amount, 1000_000000n);
  assert.equal(p.legs[0].minOut, 500000000000000000n * 9970n / 10000n);
  assert.equal(p.legs[1].minOut, 1016000000n * (9970n * 9970n / 10000n) / 10000n);
  assert.equal(p.legs[1].fee, 500);
  assert.equal(p.minProfit, 4_200000n);
  assert.equal(p.deadline, 1_700_000_060n);
});

test('plan: rejects malformed routes', () => {
  const o = {slippageBps: 30, minProfitUnits: 1n, maxFeeUnits: 0n, deadline: 1};
  assert.throws(() => buildPlan(cand({legs: [cand().legs[0], {...cand().legs[1], tokenOut: B}]}), o), /round trip/);
  assert.throws(() => buildPlan(cand({legs: [{...cand().legs[0], fee: 500}, cand().legs[1]]}), o), /Fee tier/);
  assert.throws(() => buildPlan(cand({provider: null}), o), /provider/);
  assert.throws(() => buildPlan(cand(), {...o, minProfitUnits: 0n}), /positive/);
  assert.throws(() => buildPlan(cand(), {...o, slippageBps: 500}), /slippage/);
});

test('freshness: stale block/time and non-executable rejected', () => {
  const now = 1_700_000_000_000 + 1000;
  assert.equal(validateFreshCandidate(cand(), {currentBlock: 101, now, maxQuoteAgeMs: 6000}), true);
  assert.throws(() => validateFreshCandidate(cand(), {currentBlock: 99, now, maxQuoteAgeMs: 6000}), /Stale opportunity block/);
  assert.throws(() => validateFreshCandidate(cand(), {currentBlock: 300, now, maxQuoteAgeMs: 6000}), /Stale opportunity block/);
  assert.throws(() => validateFreshCandidate(cand(), {currentBlock: 101, now: now + 10000, maxQuoteAgeMs: 6000}), /Stale opportunity quote/);
  assert.throws(() => validateFreshCandidate(cand({executable: false}), {currentBlock: 101, now, maxQuoteAgeMs: 6000}), /not executable/);
});

test('quote-to-simulation consistency check', () => {
  assert.equal(checkQuoteConsistency({quotedOut: 1016_000000n, amount: 1000_000000n, simProfit: 15_500000n, simFee: 500000n, toleranceBps: 30}).deviation, 0n);
  assert.throws(() => checkQuoteConsistency({quotedOut: 1016_000000n, amount: 1000_000000n, simProfit: 5_000000n, simFee: 500000n, toleranceBps: 30}), /below quote/);
});

test('journal: pending tx survives restart and resolves', () => {
  const f = tmp();
  const j = new Journal(f);
  j.append({kind: 'tx', status: 'submitted', purpose: 'arbitrage', chainId: 56, nonce: 7, hash: '0xa', raw: '0xraw', gasReserveUSD: 0.4});
  const restarted = new Journal(f);
  assert.equal(restarted.pending(56).length, 1);
  assert.equal(restarted.pending(56)[0].raw['0xa'], '0xraw');
  restarted.append({kind: 'tx', status: 'confirmed', purpose: 'arbitrage', chainId: 56, nonce: 7, hash: '0xa', actualGasUSD: 0.1});
  assert.equal(new Journal(f).pending(56).length, 0);
});

test('journal: torn final line after crash is ignored', () => {
  const f = tmp();
  fs.writeFileSync(f, JSON.stringify({kind: 'tx', status: 'submitted', chainId: 1, nonce: 0, hash: '0x1', purpose: 'arbitrage', at: new Date().toISOString()}) + '\n{"kind":"tx","sta');
  assert.equal(new Journal(f).pending(1).length, 1);
});

test('journal: gas budget counts reservations until actual cost is known', () => {
  const j = new Journal(null);
  j.append({kind: 'tx', status: 'submitted', purpose: 'arbitrage', chainId: 1, nonce: 0, hash: '0x1', gasReserveUSD: 0.5});
  assert.equal(j.gasSpentToday(), 0.5);
  j.append({kind: 'tx', status: 'confirmed', purpose: 'arbitrage', chainId: 1, nonce: 0, hash: '0x1', actualGasUSD: 0.2});
  assert.equal(j.gasSpentToday(), 0.2);
});

test('journal: consecutive failures and reset', () => {
  const j = new Journal(null);
  j.append({kind: 'tx', status: 'failed', purpose: 'arbitrage', chainId: 1, nonce: 0, hash: '0x1'});
  j.append({kind: 'broadcast_error', chainId: 1, nonce: 1});
  assert.equal(j.consecutiveFailures(), 2);
  j.append({kind: 'reset_failures'});
  assert.equal(j.consecutiveFailures(), 0);
  j.append({kind: 'tx', status: 'failed', purpose: 'arbitrage', chainId: 1, nonce: 2, hash: '0x2'});
  j.append({kind: 'tx', status: 'confirmed', purpose: 'arbitrage', chainId: 1, nonce: 3, hash: '0x3'});
  assert.equal(j.consecutiveFailures(), 0);
});

test('gate: missing, stale or failing reports lock execution', () => {
  assert.match(globalGateBlockers(null)[0], /no validation report/);
  assert.deepEqual(globalGateBlockers(passingReport()), []);
  assert.ok(globalGateBlockers(passingReport({generatedAt: '2020-01-01T00:00:00Z'})).some((x) => /older/.test(x)));
  const failing = passingReport();
  failing.steps[2].exitCode = 1;
  assert.ok(globalGateBlockers(failing).some((x) => /forge-unit/.test(x)));
  const missing = passingReport();
  missing.steps = missing.steps.filter((s) => s.id !== 'e2e-local');
  assert.ok(globalGateBlockers(missing).some((x) => /e2e-local/.test(x)));
});

test('gate: bytecode and per-network/provider fork tests are bound', () => {
  const r = passingReport();
  assert.deepEqual(networkGateBlockers(r, {suite: 'ForkBaseTest', providerKind: 'AAVE_V3', onchainCodehash: CODEHASH}), []);
  assert.ok(networkGateBlockers(r, {suite: 'ForkBaseTest', providerKind: 'AAVE_V3', onchainCodehash: '0x' + 'cd'.repeat(32)}).some((x) => /bytecode/.test(x)));
  assert.ok(networkGateBlockers(r, {suite: 'ForkBaseTest', providerKind: 'MORPHO_BLUE', onchainCodehash: CODEHASH}).some((x) => /MORPHO_BLUE/.test(x)));
  assert.ok(networkGateBlockers(r, {suite: 'ForkBNBTest', providerKind: 'AAVE_V3', onchainCodehash: CODEHASH}).length >= 2);
});

test('gate: forge --json parsing', () => {
  const sample = JSON.stringify({
    'test/fork/ForkNetworks.t.sol:ForkBaseTest': {duration: '1s', test_results: {
      'test_aave_roundTrip()': {status: 'Success', reason: null},
      'test_morpho_roundTrip()': {status: 'Failure', reason: 'lender lacks liquidity at fork block'},
    }},
  });
  const rows = parseForgeJson(sample);
  assert.equal(rows.length, 2);
  assert.equal(forkTestPassed({forge: {fork: rows}}, 'ForkBaseTest', 'test_aave_roundTrip'), true);
  assert.equal(forkTestPassed({forge: {fork: rows}}, 'ForkBaseTest', 'test_morpho_roundTrip'), false);
});
