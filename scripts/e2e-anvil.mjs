#!/usr/bin/env node
// End-to-end test of the REAL off-chain stack (ethers adapter + scanner + executor + journal) against an anvil EVM.
//   node scripts/e2e-anvil.mjs local   -> mock lender/DEXes deployed on a fresh anvil chain
//   node scripts/e2e-anvil.mjs fork    -> anvil forked from Base mainnet (BASE_RPC_URL), real Aave/Morpho/Balancer/Uniswap
// Requires: forge build (artifacts in ./out), anvil on PATH, npm install (ethers).
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {JsonRpcProvider, Wallet, HDNodeWallet, ContractFactory, Contract, Transaction, keccak256} from 'ethers';
import {makeChain} from '../lib/chain-ethers.mjs';
import {scanNetwork} from '../lib/scanner.mjs';
import {Executor} from '../lib/engine.mjs';
import {Journal} from '../lib/journal.mjs';
import {DEFAULT_SETTINGS} from '../lib/settings.mjs';
import {NETWORKS, PROVIDER_KIND, withEnvProviders} from '../lib/networks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] || 'local';
const PORT = Number(process.env.E2E_ANVIL_PORT || 8546);
const URL = `http://127.0.0.1:${PORT}`;
// Ephemeral test-only accounts; never persist private keys in source.
const testMnemonic = Wallet.createRandom().mnemonic.phrase;
const K = [0, 1, 2].map((i) => HDNodeWallet.fromPhrase(testMnemonic, undefined, `m/44'/60'/0'/0/${i}`).privateKey);
const results = [];
const pass = (name, detail = '') => { results.push({name, ok: true}); console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`); };

function artifact(file, name) {
  const p = path.join(root, 'out', file, `${name}.json`);
  if (!fs.existsSync(p)) throw Error(`missing ${p}; run forge build first`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
async function deploy(signer, file, name, ...args) {
  const a = artifact(file, name);
  const c = await new ContractFactory(a.abi, a.bytecode.object, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}
const send = async (p) => (await p).wait();

async function startAnvil(extra) {
  const proc = spawn('anvil', ['--port', String(PORT), '--silent', '--mnemonic', testMnemonic, ...extra], {stdio: ['ignore', 'ignore', 'inherit']});
  const provider = new JsonRpcProvider(URL, undefined, {staticNetwork: false});
  for (let i = 0; i < 120; i++) {
    try { await provider.send('eth_chainId', []); return {proc, provider}; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  proc.kill();
  throw Error('anvil did not start');
}

function signerOf(wallet) {
  return {address: wallet.address, async signTransaction(tx) { const raw = await wallet.signTransaction(tx); return {raw, hash: Transaction.from(raw).hash}; }};
}

function e2eReport(codehash, suite) {
  // In-memory gate report used ONLY inside this test to exercise the gated path. It is never written to disk.
  const rows = ['test_aave_roundTrip', 'test_aave_revertKeepsLenderWhole', 'test_morpho_roundTrip', 'test_balancer_roundTrip'].map((test) => ({suite, test, status: 'Success'}));
  return {schema: 1, generatedAt: new Date().toISOString(), steps: ['node-unit', 'forge-build', 'forge-unit', 'e2e-local'].map((id) => ({id, exitCode: 0})), executor: {runtimeCodehash: codehash}, forge: {fork: rows}};
}

function makeExecutor({net, journalFile, settingsRef, report, contracts, operator, url = URL, options = {}}) {
  const chain = makeChain(net, url, {timeoutMs: 20000});
  return new Executor({
    journal: new Journal(journalFile), settings: () => settingsRef.s, chainFor: () => chain, signer: signerOf(operator), contracts,
    gateReport: () => report, liveEnabled: true, onAutoPause: () => { settingsRef.s = {...settingsRef.s, paused: true}; },
    log: (l, m) => console.log(`  [${l}] ${m}`), options: {receiptTimeoutMs: 4000, pollMs: 500, ...options},
  });
}

async function scanTop(net, settings) {
  const {state, candidates} = await scanNetwork({chain: makeChain(net, URL, {timeoutMs: 20000}), net, settings});
  assert.equal(state.status, 'quotes-live', `scan failed: ${state.error}`);
  return candidates;
}

async function common({provider, net, exe, owner, operator, treasury, stable, settingsRef, report, expectProfit}) {
  const journalFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-e2e-')), 'journal.jsonl');
  const contracts = {[net.id]: await exe.getAddress()};
  const bal = () => stable.balanceOf(treasury);

  // 1. scanner -> executor -> confirmed atomic flash-loan arbitrage
  let cands = await scanTop(net, settingsRef.s);
  const top = cands[0];
  assert.ok(top.executable && top.netEstimate >= settingsRef.s.minProfitUSD, `no executable profitable candidate: ${JSON.stringify(top?.blockers)} net=${top?.netEstimate}`);
  pass('scanner found executable route', `${top.buy} -> ${top.sell} via ${top.provider.kind}, est. net ${top.netEstimate.toFixed(4)}`);
  const ex = makeExecutor({net, journalFile, settingsRef, report, contracts, operator});
  const before = await bal();
  const r = await ex.attempt(top, net);
  assert.equal(r.status, 'confirmed', `attempt: ${JSON.stringify(r)}`);
  const sub = ex.journal.events.find((e) => e.status === 'submitted');
  const done = ex.journal.events.find((e) => e.status === 'confirmed');
  const delta = (await bal()) - before;
  assert.equal(delta.toString(), done.profitUnits, 'treasury delta == Executed.profit');
  assert.equal(done.profitUnits, sub.expectedProfitUnits, 'executed profit == simulated profit');
  if (expectProfit != null) assert.equal(delta, expectProfit, 'profit equals exact quote arithmetic');
  assert.ok(done.netAfterGas > 0, 'positive after actual gas');
  pass('atomic flash-loan arbitrage confirmed', `profit ${done.profit} ${top.assetSymbol}, gas $${done.actualGasUSD.toFixed(4)}, net $${done.netAfterGas.toFixed(4)}, tx ${done.hash}`);
  assert.equal(await stable.balanceOf(await exe.getAddress()), 0n, 'executor keeps nothing');
  pass('repayment + payout accounting', 'executor balance 0, treasury delta == event profit == eth_call profit');

  // 2. RPC failure -> nothing signed
  cands = await scanTop(net, settingsRef.s);
  const nonce0 = await provider.getTransactionCount(operator.address);
  const dead = makeExecutor({net, journalFile: null, settingsRef, report, contracts, operator, url: 'http://127.0.0.1:1'});
  const rd = await dead.attempt(cands[0], net);
  assert.equal(rd.status, 'blocked');
  assert.equal(await provider.getTransactionCount(operator.address), nonce0);
  pass('RPC failure blocks execution', rd.reason);

  // 3. pending transaction across restart
  await provider.send('evm_setAutomine', [false]);
  cands = await scanTop(net, settingsRef.s);
  const exP = makeExecutor({net, journalFile, settingsRef, report, contracts, operator, options: {receiptTimeoutMs: 1500}});
  assert.equal((await exP.attempt(cands[0], net)).status, 'pending');
  const restarted = makeExecutor({net, journalFile, settingsRef, report, contracts, operator});
  assert.equal(restarted.journal.pending(net.id).length, 1);
  const blocked = await restarted.attempt({...cands[0], id: cands[0].id + ':again'}, net);
  assert.match(blocked.reason, /still pending/);
  await provider.send('evm_mine', []);
  assert.deepEqual(await restarted.reconcile(net), {pending: 0});
  pass('pending tx survives restart, blocks new broadcast, then reconciles');

  // 4. stuck transaction cancelled with same-nonce replacement
  cands = await scanTop(net, settingsRef.s);
  const exC = makeExecutor({net, journalFile, settingsRef, report, contracts, operator, options: {receiptTimeoutMs: 1000, cancelAfterMs: 0}});
  assert.equal((await exC.attempt(cands[0], net)).status, 'pending');
  const stuck = exC.journal.pending(net.id)[0];
  const tBefore = await bal();
  await exC.reconcile(net);
  await provider.send('evm_mine', []);
  assert.deepEqual(await exC.reconcile(net), {pending: 0});
  assert.equal(await provider.getTransactionReceipt(stuck.hashes[0]), null, 'original never mined');
  assert.equal(await bal(), tBefore);
  pass('stuck transaction cancelled', `nonce ${stuck.nonce}`);
  await provider.send('evm_setAutomine', [true]);

  // 5. emergency stop -> on-chain pause
  const exS = makeExecutor({net, journalFile, settingsRef, report, contracts, operator});
  const stop = await exS.emergencyStop([net], 'e2e');
  assert.equal(stop[0].status, 'pause-sent');
  assert.equal(await exe.paused(), true);
  cands = await scanTop({...net}, {...settingsRef.s, paused: false});
  settingsRef.s = {...settingsRef.s, paused: false};
  const afterStop = await makeExecutor({net, journalFile, settingsRef, report, contracts, operator}).attempt(cands[0], net);
  assert.match(afterStop.reason, /paused on-chain/);
  pass('emergency stop pauses contract; execution refused', stop[0].hash);
  await send(exe.connect(owner).unpause());

  // 6. reverted route keeps lender whole (direct contract call with an unachievable floor)
  const plan = {provider: top.provider.address, asset: top.asset, amount: BigInt(top.amount), maxFee: BigInt(top.provider.fee), minProfit: 10n ** 30n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600), legs: top.legs.map((l) => ({router: l.router, kind: l.routerKind, tokenIn: l.tokenIn, tokenOut: l.tokenOut, fee: l.fee, minOut: 0n}))};
  await assert.rejects(exe.connect(operator).start.staticCall(plan), /insufficient profit/);
  pass('unprofitable plan reverts atomically');
}

async function local() {
  const {proc, provider} = await startAnvil([]);
  try {
    const [owner, operator, t] = K.map((k) => new Wallet(k, provider));
    const treasury = t.address;
    const usd = await deploy(owner, 'Mocks.sol', 'MockToken', 'USD Coin', 'USDC', 6);
    const weth = await deploy(owner, 'Mocks.sol', 'MockToken', 'Wrapped Ether', 'WETH', 18);
    const aave = await deploy(owner, 'Mocks.sol', 'MockAavePool');
    const cheap = await deploy(owner, 'Mocks.sol', 'MockRouter');
    const rich = await deploy(owner, 'Mocks.sol', 'MockRouter');
    const quoter = await deploy(owner, 'Mocks.sol', 'MockQuoterV2', await rich.getAddress());
    const [U, Wt, A, C, R, Q] = await Promise.all([usd, weth, aave, cheap, rich, quoter].map((c) => c.getAddress()));
    await send(usd.mint(A, 10n ** 12n));
    await send(weth.mint(C, 10n ** 22n));
    await send(usd.mint(R, 10n ** 12n));
    await send(cheap.setRate(U, Wt, 505_000_000_000n, 1000n));
    await send(rich.setRate(Wt, U, 2000_000000n, 10n ** 18n));
    const exe = await deploy(owner, 'NexoraFlashExecutor.sol', 'NexoraFlashExecutor', owner.address, operator.address, treasury);
    const E = await exe.getAddress();
    for (const action of [() => exe.setProvider(A, 1), () => exe.setRouter(C, true), () => exe.setRouter(R, true), () => exe.setToken(U, true), () => exe.setToken(Wt, true), () => exe.setMaxLoan(U, 1000_000000n), () => exe.unpause()]) await send(action());

    const codehash = keccak256(await provider.getCode(E));
    const built = keccak256(artifact('NexoraFlashExecutor.sol', 'NexoraFlashExecutor').deployedBytecode.object);
    assert.equal(codehash, built, 'on-chain runtime code == forge artifact deployedBytecode (gate binding)');
    pass('deployed codehash matches build artifact', codehash);

    const net = {id: 31337, name: 'Anvil', native: 'ETH', txType: 2, l1Fee: null, maxQuoteAgeMs: 60000, forkSuite: 'E2E',
      stable: {address: U, symbol: 'USDC', decimals: 6}, wrapped: {address: Wt, symbol: 'WETH', decimals: 18},
      providers: [{kind: 'AAVE_V3', address: A}],
      venues: [{id: 'cheap', name: 'Cheap V2', type: 'v2', router: C, forkValidated: true}, {id: 'rich', name: 'Rich V3', type: 'v3', router: R, routerKind: 1, quoter: Q, fees: [500], forkValidated: true}]};
    const settingsRef = {s: {...structuredClone(DEFAULT_SETTINGS), sizeSteps: [1], liveChains: [31337], maxGasGwei: 100, maxGasPerTxUSD: 5, maxDailyGasUSD: 100, maxQuoteAgeMs: 60000}};
    // 1000 USDC -> 0.505 WETH -> 1010 USDC; Aave premium 0.5 => profit exactly 9.5 USDC
    await common({provider, net, exe, owner, operator, treasury, stable: usd, settingsRef, report: e2eReport(codehash, 'E2E'), expectProfit: 9_500000n});
  } finally { proc.kill(); }
}

async function fork() {
  const rpc = process.env.BASE_RPC_URL;
  if (!rpc) throw Error('BASE_RPC_URL is required for fork mode');
  const {proc, provider} = await startAnvil(['--fork-url', rpc]);
  try {
    const base = withEnvProviders(NETWORKS.find((n) => n.id === 8453));
    const net = {...base, maxQuoteAgeMs: 120000, venues: base.venues.filter((v) => v.forkValidated)};
    const [owner, operator, whale] = K.map((k) => new Wallet(k, provider));
    const treasury = Wallet.createRandom().address;
    const exe = await deploy(owner, 'NexoraFlashExecutor.sol', 'NexoraFlashExecutor', owner.address, operator.address, treasury);
    for (const p of net.providers) await send(exe.setProvider(p.address, PROVIDER_KIND[p.kind]));
    for (const v of net.venues) await send(exe.setRouter(v.router, true));
    for (const t of [net.stable.address, net.wrapped.address]) await send(exe.setToken(t, true));
    await send(exe.setMaxLoan(net.stable.address, 1000_000000n));
    await send(exe.unpause());
    const codehash = keccak256(await provider.getCode(await exe.getAddress()));

    // Dislocate the real Uniswap V2 USDC/WETH pool so a genuine arbitrage exists on the fork.
    const v2 = net.venues.find((v) => v.type === 'v2').router;
    const factory = new Contract(await new Contract(v2, ['function factory() view returns (address)'], provider).factory(), ['function getPair(address,address) view returns (address)'], provider);
    const pair = new Contract(await factory.getPair(net.stable.address, net.wrapped.address), ['function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)'], provider);
    const [r0, r1] = await pair.getReserves();
    const rW = (await pair.token0()).toLowerCase() === net.wrapped.address.toLowerCase() ? r0 : r1;
    const dump = rW / 8n;
    await provider.send('anvil_setBalance', [whale.address, '0x' + (dump * 2n + 10n ** 18n).toString(16)]);
    const weth = new Contract(net.wrapped.address, ['function deposit() payable', 'function approve(address,uint256) returns (bool)'], whale);
    await send(weth.deposit({value: dump}));
    await send(weth.approve(v2, dump));
    await send(new Contract(v2, ['function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])'], whale)
      .swapExactTokensForTokens(dump, 0n, [net.wrapped.address, net.stable.address], whale.address, BigInt(Math.floor(Date.now() / 1000) + 3600)));
    pass('real Uniswap V2 pool dislocated on fork', `dumped ${dump} wei WETH`);

    const usdc = new Contract(net.stable.address, ['function balanceOf(address) view returns (uint256)'], provider);
    const settingsRef = {s: {...structuredClone(DEFAULT_SETTINGS), sizeSteps: [1], liveChains: [8453], maxGasGwei: 100, maxGasPerTxUSD: 5, maxDailyGasUSD: 100, maxQuoteAgeMs: 120000}};
    await common({provider, net, exe, owner, operator, treasury, stable: usdc, settingsRef, report: e2eReport(codehash, net.forkSuite)});
  } finally { proc.kill(); }
}

try {
  await (mode === 'fork' ? fork() : local());
  console.log(`\nE2E ${mode}: ${results.length} checks passed`);
  process.exit(0);
} catch (e) {
  console.error(`\nE2E ${mode} FAILED: ${e.stack || e}`);
  process.exit(1);
}
