import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Executor} from '../lib/engine.mjs';
import {Journal} from '../lib/journal.mjs';
import {scanNetwork} from '../lib/scanner.mjs';
import {DEFAULT_SETTINGS} from '../lib/settings.mjs';
import {FakeChain, testNet, fakeSigner, passingReport, EXE, OPERATOR} from './helpers/fake-chain.mjs';

function rig({live = true, longRouteEnabled = false, report = passingReport(), file = null, settings: so = {}, chain: existing = null, clock = null} = {}) {
  const clk = clock || {t: Date.now()};
  const now = () => clk.t;
  const chain = existing || new FakeChain({now});
  chain.now = now;
  const net = testNet();
  const r = {chain, net, clk, paused: []};
  r.settings = {...structuredClone(DEFAULT_SETTINGS), liveChains: [8453], maxGasPerTxUSD: 5, ...so};
  r.journal = new Journal(file, {now});
  r.ex = new Executor({
    journal: r.journal, settings: () => r.settings, chainFor: () => chain, signer: fakeSigner(), contracts: {8453: EXE},
    gateReport: () => report, liveEnabled: live, longRouteEnabled, now,
    onAutoPause: (why) => { r.settings = {...r.settings, paused: true}; r.paused.push(why); },
    sleep: async () => { clk.t += 1500; if (chain.autoMine) chain.mine(); },
    options: {receiptTimeoutMs: 9000},
  });
  r.scan = async () => (await scanNetwork({chain, net, settings: r.settings, now})).candidates[0];
  return r;
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-e-')), 'journal.jsonl');
const decodePlan = (chain, tx) => chain.decodeCall(tx.data).plan;

test('locked unless LIVE_EXECUTION is enabled', async () => {
  const r = rig({live: false});
  const res = await r.ex.attempt(await r.scan(), r.net);
  assert.equal(res.status, 'blocked');
  assert.match(res.reason, /LIVE_EXECUTION/);
  assert.equal(r.chain.broadcasts.length, 0);
});

test('locked without a passing validation report', async () => {
  const r = rig({report: null});
  const res = await r.ex.attempt(await r.scan(), r.net);
  assert.match(res.reason, /no validation report/);
  assert.equal(r.chain.broadcasts.length, 0);
});

test('locked when deployed bytecode differs from the validated build', async () => {
  const r = rig();
  r.chain.exe.codehash = '0x' + '00'.repeat(32);
  const res = await r.ex.attempt(await r.scan(), r.net);
  assert.match(res.reason, /bytecode differs/);
  assert.equal(r.chain.broadcasts.length, 0);
});

test('full path: simulate, sign, broadcast, confirm; realized profit == simulated profit', async () => {
  const r = rig();
  const c = await r.scan();
  const res = await r.ex.attempt(c, r.net);
  assert.equal(res.status, 'confirmed');
  assert.equal(r.chain.broadcasts.length, 1);
  const tx = r.chain.broadcasts[0];
  assert.equal(tx.nonce, 0);
  assert.equal(tx.chainId, 8453);
  assert.ok(tx.gasLimit <= 1_200_000n);
  const plan = decodePlan(r.chain, tx);
  const sub = r.journal.events.find((e) => e.status === 'submitted');
  const done = r.journal.events.find((e) => e.status === 'confirmed');
  assert.equal(done.profitUnits, sub.expectedProfitUnits, 'quote -> simulation -> execution consistent');
  // On-chain floor covers min net profit + worst-case gas with 20% buffer.
  const gasReserveUnits = BigInt(Math.ceil(sub.gasReserveUSD * 1e6));
  assert.ok(plan.minProfit >= 3_000000n + gasReserveUnits, 'protected floor enforced on-chain');
  assert.ok(done.netAfterGas > 3, 'net after real gas above minimum');
  assert.equal(r.journal.trades().length, 1);
  assert.equal(r.journal.pending().length, 0);
});


test('long-route trading requires separate opt-in, fork test and owner-approved contract cap', async () => {
  const makeLong = async (r) => {
    const c = await r.scan();
    const [buy, sell] = c.legs;
    c.legs = [buy, sell, buy, sell, buy, sell].map((x) => ({...x}));
    c.mode = 'MULTIHOP_EXECUTION_CANDIDATE';
    c.hopCount = 6;
    c.executable = true;
    c.id += ':six-leg';
    return c;
  };
  let r = rig();
  assert.match((await r.ex.attempt(await makeLong(r), r.net)).reason, /long-cycle execution disabled/);
  assert.equal(r.chain.broadcasts.length, 0);

  r = rig({longRouteEnabled: true});
  assert.match((await r.ex.attempt(await makeLong(r), r.net)).reason, /long-cycle fork execution gate missing/);
  assert.equal(r.chain.broadcasts.length, 0);

  const report = passingReport();
  report.forge.fork.push({suite:'ForkBaseTest', test:'test_multihop_realVenues_roundTrip', status:'Success'});
  r = rig({longRouteEnabled: true, report});
  assert.match((await r.ex.attempt(await makeLong(r), r.net)).reason, /on-chain route length not authorized/);
  assert.equal(r.chain.broadcasts.length, 0);

  r = rig({longRouteEnabled: true, report});
  r.chain.exe.maxRouteLegs = 6n;
  assert.match((await r.ex.attempt(await makeLong(r), r.net)).reason, /long route not approved by cold owner/);
  assert.equal(r.chain.broadcasts.length, 0);
});

test('AUDIT H-1: mock-venue fork mechanics passes cannot unlock funded long routes', async () => {
  const report = passingReport();
  for (const name of ['test_longRouteMechanics_fiveLegs', 'test_longRouteMechanics_tenLegs', 'test_multihop_roundTrip'])
    report.forge.fork.push({suite: 'ForkBaseTest', test: name, status: 'Success'});
  const r = rig({longRouteEnabled: true, report});
  const c = await r.scan();
  const legs = [c.legs[0]];
  const tokens = ['0x' + '11'.repeat(20), '0x' + '12'.repeat(20), '0x' + '13'.repeat(20), '0x' + '14'.repeat(20)];
  let prev = c.legs[0].tokenOut;
  for (const token of tokens) { legs.push({...c.legs[0], tokenIn: prev, tokenOut: token}); prev = token; }
  legs.push({...c.legs[1], tokenIn: prev});
  const candidate = {...c, legs, mode: 'MULTIHOP_EXECUTION_CANDIDATE', hopCount: legs.length, executable: true, id: c.id + ':mock-fork'};
  const attempt = await r.ex.attempt(candidate, r.net);
  assert.equal(attempt.status, 'blocked');
  assert.match(attempt.reason, /long-cycle fork execution gate missing/);
  assert.equal(r.chain.broadcasts.length, 0);
});

test('market moved after quote: simulation rejects, nothing broadcast', async () => {
  const r = rig();
  const c = await r.scan();
  r.chain.pools.b.rS = 20_000_000n * 10n ** 6n; // competitor closed the gap
  const res = await r.ex.attempt(c, r.net);
  assert.equal(res.status, 'blocked');
  assert.match(res.reason, /simulation reverted: (insufficient profit|slippage)/);
  assert.equal(r.chain.broadcasts.length, 0);
});

test('quote/simulation mismatch beyond tolerance is rejected', async () => {
  const r = rig();
  const c = await r.scan();
  r.chain.pools.b.rS = 20_300_000n * 10n ** 6n; // still profitable, but well below the quote
  const res = await r.ex.attempt(c, r.net);
  assert.match(res.reason, /below quote/);
  assert.equal(r.chain.broadcasts.length, 0);
});

test('stale quote rejected', async () => {
  const r = rig();
  const c = await r.scan();
  r.clk.t += 7000;
  const res = await r.ex.attempt(c, r.net);
  assert.match(res.reason, /Stale opportunity quote/);
});

test('gas limit, per-tx gas cap and daily budget are enforced', async () => {
  let r = rig();
  r.chain.startGas = 1_100_000n;
  assert.match((await r.ex.attempt(await r.scan(), r.net)).reason, /exceeds configured/);
  r = rig({settings: {maxGasPerTxUSD: 0.5}});
  assert.match((await r.ex.attempt(await r.scan(), r.net)).reason, /per-transaction cap/);
  r = rig();
  r.journal.append({kind: 'tx', status: 'submitted', purpose: 'arbitrage', chainId: 8453, nonce: 99, hash: '0xold', gasReserveUSD: 4.5});
  r.journal.append({kind: 'tx', status: 'confirmed', purpose: 'arbitrage', chainId: 8453, nonce: 99, hash: '0xold', actualGasUSD: 4.5});
  assert.match((await r.ex.attempt(await r.scan(), r.net)).reason, /daily gas budget/);
  assert.equal(r.chain.broadcasts.length, 0);
});

test('contract paused on-chain or signer not operator => blocked', async () => {
  let r = rig();
  r.chain.exe.paused = true;
  assert.match((await r.ex.attempt(await r.scan(), r.net)).reason, /paused on-chain/);
  r = rig();
  r.chain.exe.operator = '0x' + '7'.repeat(40);
  assert.match((await r.ex.attempt(await r.scan(), r.net)).reason, /not the contract operator/);
});

test('pending transaction blocks new broadcasts across a service restart, then resolves', async () => {
  const file = tmpFile();
  const clock = {t: Date.now()};
  const r = rig({file, clock});
  r.chain.autoMine = false;
  const first = await r.ex.attempt(await r.scan(), r.net);
  assert.equal(first.status, 'pending', `first attempt blocked: ${JSON.stringify(first)}`);
  // --- service restart: new journal + executor instances on the same files/chain
  const r2 = rig({file, clock, chain: r.chain});
  assert.equal(r2.journal.pending(8453).length, 1);
  r2.chain.block++;
  const second = await r2.ex.attempt(await r2.scan(), r2.net);
  assert.match(second.reason, /still pending/);
  assert.equal(r.chain.broadcasts.length, 1, 'no second broadcast while pending');
  r2.chain.mine();
  assert.deepEqual(await r2.ex.reconcile(r2.net), {pending: 0});
  assert.ok(r2.journal.events.some((e) => e.status === 'confirmed'));
});

test('receipt RPC errors fail closed and preserve journaled pending nonce', async () => {
  const file = tmpFile();
  const clock = {t: Date.now()};
  const r = rig({file, clock});
  r.chain.autoMine = false;
  assert.equal((await r.ex.attempt(await r.scan(), r.net)).status, 'pending');
  const r2 = rig({file, clock, chain: r.chain});
  const realReceipt = r.chain.getReceipt.bind(r.chain);
  r.chain.getReceipt = async () => { throw Error('could not coalesce error'); };
  const second = await r2.ex.attempt(await r2.scan(), r2.net);
  assert.equal(second.status, 'blocked');
  assert.match(second.reason, /still pending/);
  assert.equal(r.chain.broadcasts.length, 1, 'must not broadcast another transaction');
  assert.equal(r2.journal.pending(r.net.id).length, 1, 'pending journal entry must survive RPC failure');
  r.chain.getReceipt = realReceipt;
  r.chain.mine();
  assert.deepEqual(await r2.ex.reconcile(r2.net), {pending: 0});
});

test('stuck transaction is cancelled with a same-nonce, higher-fee replacement', async () => {
  const r = rig();
  r.chain.autoMine = false;
  assert.equal((await r.ex.attempt(await r.scan(), r.net)).status, 'pending');
  const orig = r.chain.broadcasts[0];
  r.clk.t += 200_000;
  await r.ex.reconcile(r.net);
  const cancel = r.chain.broadcasts[1];
  assert.equal(cancel.nonce, orig.nonce);
  assert.equal(cancel.to, OPERATOR);
  assert.ok(cancel.maxFeePerGas > orig.maxFeePerGas);
  r.chain.mine();
  assert.deepEqual(await r.ex.reconcile(r.net), {pending: 0});
  assert.ok(r.journal.events.some((e) => e.status === 'cancelled'));
  assert.equal(r.chain.receipts.get(orig.hash), undefined, 'original trade never executed');
});

test('transaction dropped from mempool is rebroadcast from the journal', async () => {
  const r = rig();
  r.chain.autoMine = false;
  await r.ex.attempt(await r.scan(), r.net);
  r.chain.mempool = [];
  r.clk.t += 40_000;
  await r.ex.reconcile(r.net);
  assert.ok(r.journal.events.some((e) => e.status === 'rebroadcast'));
  assert.equal(r.chain.mempool.length, 1);
  r.chain.mine();
  assert.deepEqual(await r.ex.reconcile(r.net), {pending: 0});
});

test('RPC failure before signing => no transaction; RPC failure after broadcast => recovered', async () => {
  let r = rig();
  const c = await r.scan();
  r.chain.down = true;
  const res = await r.ex.attempt(c, r.net);
  assert.match(res.reason, /RPC down/);
  assert.equal(r.chain.broadcasts.length, 0);

  r = rig();
  r.chain.autoMine = false;
  const c2 = await r.scan();
  r.ex.sleep = async () => { r.clk.t += 1500; r.chain.down = true; };
  assert.equal((await r.ex.attempt(c2, r.net)).status, 'pending');
  r.chain.down = false;
  r.chain.mine();
  assert.deepEqual(await r.ex.reconcile(r.net), {pending: 0});
  assert.ok(r.journal.events.some((e) => e.status === 'confirmed'));
});

test('on-chain revert is recorded; circuit breaker auto-pauses after N failures', async () => {
  const r = rig({settings: {maxConsecutiveFailures: 2}});
  r.chain.autoMine = false;
  for (let i = 0; i < 2; i++) {
    const c = await r.scan();
    assert.equal((await r.ex.attempt(c, r.net)).status, 'pending');
    const saved = r.chain.pools.b.rS;
    r.chain.pools.b.rS = 20_000_000n * 10n ** 6n; // front-run before inclusion
    r.chain.mine();
    r.chain.pools.b.rS = saved;
    await r.ex.reconcile(r.net);
  }
  assert.equal(r.journal.events.filter((e) => e.status === 'failed').length, 2);
  assert.equal(r.settings.paused, true);
  assert.match(r.paused[0], /circuit breaker/);
  const after = await r.ex.attempt(await r.scan(), r.net);
  assert.match(after.reason, /paused|circuit breaker/);
});

test('uncertain broadcast error retains pending nonce and prevents another signed trade', async () => {
  const r = rig();
  r.chain.broadcastError = 'nonce too low';
  const res = await r.ex.attempt(await r.scan(), r.net);
  assert.equal(res.status, 'broadcast_error');
  assert.equal(r.journal.pending().length, 1, 'RPC error does not prove a broadcast was rejected');
  assert.equal(r.journal.pending()[0].nonce, 0);
  assert.ok(!r.journal.events.some((e) => e.status === 'dropped'));

  const distinctCandidate = await r.scan();
  distinctCandidate.id += '-next-block';
  const second = await r.ex.attempt(distinctCandidate, r.net);
  assert.equal(second.status, 'blocked');
  assert.match(second.reason, /still pending/);
  assert.equal(r.chain.broadcasts.length, 0, 'never broadcast a new transaction while first nonce is unresolved');
  // When on-chain pending nonce is actually consumed, reconciliation can resolve it.
  r.chain.nonceLatest = 1;
  assert.deepEqual(await r.ex.reconcile(r.net), {pending: 0});
});

test('ambiguous network timeout also keeps the transaction journaled', async () => {
  const r = rig();
  r.chain.broadcastError = 'RPC timeout';
  assert.equal((await r.ex.attempt(await r.scan(), r.net)).status, 'broadcast_error');
  assert.equal(r.journal.pending(r.net.id).length, 1);
});

test('emergency stop: local pause + on-chain pause(); replaces a stuck trade', async () => {
  let r = rig();
  const out = await r.ex.emergencyStop([r.net], 'test');
  assert.equal(out[0].status, 'pause-sent');
  assert.equal(r.chain.exe.paused, true);
  assert.equal(r.settings.paused, true);
  assert.match((await r.ex.attempt(await r.scan(), r.net)).reason, /paused/);

  r = rig();
  r.chain.autoMine = false;
  await r.ex.attempt(await r.scan(), r.net);
  const trade = r.chain.broadcasts[0];
  await r.ex.emergencyStop([r.net], 'test');
  const pause = r.chain.broadcasts[1];
  assert.equal(pause.nonce, trade.nonce, 'pause replaces the pending trade');
  r.chain.mine();
  assert.equal(r.chain.exe.paused, true);
  assert.equal(r.chain.receipts.get(trade.hash), undefined);
  assert.deepEqual(await r.ex.reconcile(r.net), {pending: 0});
});

test('same opportunity is never attempted twice', async () => {
  const r = rig();
  r.chain.exe.paused = true;
  const c = await r.scan();
  await r.ex.attempt(c, r.net);
  assert.match((await r.ex.attempt(c, r.net)).reason, /already attempted/);
});

test('AUDIT H-1: emergency stop during simulation prevents transaction signing and broadcast', async () => {
  const r = rig();
  const c = await r.scan();
  const original = r.chain.simulateStart.bind(r.chain);
  let stopped = false;
  r.chain.simulateStart = async (...args) => {
    if (!stopped) { stopped = true; await r.ex.emergencyStop([], 'stop during simulation'); }
    return original(...args);
  };
  const out = await r.ex.attempt(c, r.net);
  assert.equal(out.status, 'blocked');
  assert.match(out.reason, /emergency stop/);
  assert.equal(r.chain.broadcasts.length, 0);
  assert.equal(r.journal.events.filter((e) => e.kind === 'tx').length, 0);
});

test('AUDIT M-2: mined transaction with delayed receipt cannot be marked replaced', async () => {
  const r = rig();
  r.chain.autoMine = false;
  assert.equal((await r.ex.attempt(await r.scan(), r.net)).status, 'pending');
  const hash = r.chain.broadcasts[0].hash;
  r.chain.mine();
  const original = r.chain.getReceipt.bind(r.chain);
  r.chain.getReceipt = async () => null;
  await r.ex.reconcile(r.net);
  assert.equal(r.journal.events.some((e) => e.status === 'replaced'), false);
  assert.equal(r.journal.pending(r.net.id).length, 1);
  r.chain.getReceipt = original;
  assert.deepEqual(await r.ex.reconcile(r.net), {pending: 0});
  const confirmed = r.journal.events.find((e) => e.status === 'confirmed' && e.hash === hash);
  assert.ok(confirmed && confirmed.profitUnits);
});
