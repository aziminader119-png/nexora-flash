import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {scanNetwork, sizesFor} from '../lib/scanner.mjs';
import {DEFAULT_SETTINGS} from '../lib/settings.mjs';
import {routeGasUnits, weiToStable} from '../lib/profit.mjs';
import {FakeChain, testNet, AAVE, MORPHO} from './helpers/fake-chain.mjs';

const settings = (o = {}) => ({...structuredClone(DEFAULT_SETTINGS), ...o});

test('sizes derive from the configured loan size', () => {
  assert.deepEqual(sizesFor(settings(), 6).map((s) => s.units), [500_000000n, 1000_000000n]);
  assert.deepEqual(sizesFor(settings({loanSize: 250, sizeSteps: [1]}), 18).map((s) => s.usd), [250]);
});

test('scanner finds the dislocated route with exact on-chain-quote arithmetic', async () => {
  const chain = new FakeChain();
  const {state, candidates} = await scanNetwork({chain, net: testNet(), settings: settings()});
  assert.equal(state.status, 'quotes-live');
  const top = candidates[0];
  assert.equal(top.buy, 'DexA V2');
  assert.equal(top.sell, 'DexB V3 0.05%');
  assert.equal(top.size, 1000);
  assert.equal(top.provider.kind, 'AAVE_V3', 'Morpho has no liquidity in this market');
  const mid = FakeChain.out(chain.pools.a, 1000_000000n, true);
  const out = FakeChain.out(chain.pools.b, mid, false);
  assert.equal(top.legs[0].quotedOut, mid.toString());
  assert.equal(top.legs[1].quotedOut, out.toString());
  const native = FakeChain.out(chain.pools.b, 10n ** 18n, false);
  const gas = weiToStable(routeGasUnits('AAVE_V3', top.legs) * 10n ** 9n, native);
  assert.equal(BigInt(top.netUnits), out - 1000_000000n - 500000n - gas);
  assert.ok(top.netEstimate > 3, 'profitable after fee and gas');
  assert.equal(top.executable, true);
  assert.ok(candidates.some((c) => c.buy === 'DexB V3 0.05%' && c.netEstimate < 0), 'reverse direction is quoted and negative');
});

test('scanner prefers a zero-fee provider when it has liquidity', async () => {
  const chain = new FakeChain();
  chain.providers[MORPHO].available = 10n ** 15n;
  const {candidates} = await scanNetwork({chain, net: testNet(), settings: settings()});
  assert.equal(candidates[0].provider.kind, 'MORPHO_BLUE');
  assert.equal(candidates[0].provider.fee, '0');
});

test('balanced market produces no positive candidate (no fake profit)', async () => {
  const chain = new FakeChain();
  chain.pools.b.rS = 20_000_000n * 10n ** 6n; // both pools at 2000
  const {candidates} = await scanNetwork({chain, net: testNet(), settings: settings()});
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((c) => c.netEstimate < 0));
});

test('no provider liquidity => quote only, never executable', async () => {
  const chain = new FakeChain();
  chain.providers[AAVE].available = 0n;
  const {candidates} = await scanNetwork({chain, net: testNet(), settings: settings()});
  assert.ok(candidates.every((c) => !c.executable && c.blockers.some((b) => /no flash provider/.test(b))));
});

test('venue without fork validation is never executable', async () => {
  const net = testNet();
  net.venues = net.venues.map((v) => (v.id === 'a' ? {...v, forkValidated: false} : v));
  const {candidates} = await scanNetwork({chain: new FakeChain(), net, settings: settings()});
  assert.ok(candidates.every((c) => !c.executable));
});

test('RPC outage and wrong chain are reported, not hidden', async () => {
  const down = new FakeChain();
  down.down = true;
  const a = await scanNetwork({chain: down, net: testNet(), settings: settings()});
  assert.equal(a.state.status, 'unavailable');
  assert.match(a.state.error, /RPC down/);
  assert.equal(a.candidates.length, 0);
  const b = await scanNetwork({chain: new FakeChain({chainId: 1}), net: testNet(), settings: settings()});
  assert.match(b.state.error, /does not match/);
});

test('gas price above ceiling shows quotes but never allows execution', async () => {
  const chain = new FakeChain();
  chain.gas.gasPrice = 50n * 10n ** 9n;
  const {state, candidates} = await scanNetwork({chain, net: testNet(), settings: settings({maxGasGwei: 5})});
  assert.equal(state.status, 'quotes-live');
  assert.ok(candidates.length > 0, 'quotes still visible');
  assert.ok(candidates.every((c) => !c.executable && c.blockers.some((x) => /above ceiling/.test(x))), 'execution blocked');
});

test('OP-stack networks include the L1 data fee in the gas estimate', async () => {
  const a = await scanNetwork({chain: new FakeChain(), net: testNet(), settings: settings()});
  const b = await scanNetwork({chain: new FakeChain(), net: testNet({l1Fee: 'op-stack'}), settings: settings()});
  assert.ok(BigInt(b.candidates[0].gasStableUnits) > BigInt(a.candidates[0].gasStableUnits));
});

test('provider selection is restricted to gate-eligible lenders when available', async () => {
  const chain = new FakeChain();
  chain.providers[MORPHO].available = 10n ** 15n;
  const {candidates} = await scanNetwork({chain, net: testNet(), settings: settings(), preferKinds: ['AAVE_V3']});
  assert.equal(candidates[0].provider.kind, 'AAVE_V3', 'Morpho is cheaper but not validated');
  const fallback = await scanNetwork({chain, net: testNet(), settings: settings(), preferKinds: ['EULER_V2']});
  assert.equal(fallback.candidates[0].provider, null, 'an unvalidated lender must never be selected');
  assert.ok(fallback.candidates.every((c) => !c.executable && c.blockers.some((x) => /no flash provider/.test(x))));
  const none = await scanNetwork({chain, net: testNet(), settings: settings(), preferKinds: []});
  assert.ok(none.candidates.every((c) => !c.executable && c.provider === null), 'empty validated-provider list must fail closed');
});

test('raw gas/native prices remain available even when all buy quotes fail',async()=>{
 const chain=new FakeChain(),net=testNet();
 const originalV2=chain.quoteV2.bind(chain),originalV3=chain.quoteV3.bind(chain);
 chain.quoteV2=async(router,amount,a,b,block)=>{
  if(a.toLowerCase()===net.stable.address.toLowerCase())throw Error('buy quote failure');
  return originalV2(router,amount,a,b,block);
 };
 chain.quoteV3=async(quoter,a,b,fee,amount,block)=>{
  if(a.toLowerCase()===net.stable.address.toLowerCase())throw Error('buy quote failure');
  return originalV3(quoter,a,b,fee,amount,block);
 };
 const {state,candidates}=await scanNetwork({chain,net,settings:settings()});
 assert.equal(state.status,'quotes-live');
 assert.equal(candidates.length,0);
 assert.ok(Number.isSafeInteger(state.block));
 assert.match(state.gasPriceWei,/^[1-9][0-9]*$/);
 assert.match(state.nativePriceUnits,/^[1-9][0-9]*$/);
 assert.ok(Number.isFinite(Date.parse(state.quotedAt)));
});
test('catalog scan no longer depends on the legacy USDC-WETH result count',()=>{
 const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 assert.doesNotMatch(server,/if \(!c\) return r;/);
 assert.match(server,/gasPrice: BigInt\(r\.state\.gasPriceWei\)/);
 assert.match(server,/nativePrice: BigInt\(r\.state\.nativePriceUnits\)/);
 assert.match(server,/size refinement: /);
});
