import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverMultiHopCycles, validateCycleEdges} from '../lib/multihop.mjs';
import {catalogHasTrustedVenues} from '../lib/multihop-catalog.mjs';
import {DEFAULT_SETTINGS} from '../lib/settings.mjs';
import {S, AAVE, testNet} from './helpers/fake-chain.mjs';

const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
function setup(n, factor = 101n) {
  const net = testNet();
  const coins = [S, ...Array.from({length: n - 1}, (_, i) => addr(i + 100)), S];
  const edges = Array.from({length: n}, (_, i) => ({
    pool: {key:'pool-'+i, name:'Test DEX '+i, type:'v2', router: addr(1000+i), routerKind:0, fee:0, forkValidated:true},
    tokenIn:{address:coins[i], symbol:'T'+i}, tokenOut:{address:coins[i+1],symbol:i === n-1?'USDC':'T'+(i+1)},
  }));
  const chain = {
    calls:[], async quoteV2(router, amount, a, b, block) {
      this.calls.push({router, amount, a, b, block});
      return amount * factor / 100n;
    },
  };
  const infos=[{kind:'AAVE_V3',address:AAVE,ok:true,available:1_000_000_000000n,feeModel:'aave-bps',feeParam:5}];
  const settings=structuredClone(DEFAULT_SETTINGS);
  settings.sizeSteps=[1];
  return {net:{...net,routeEdges:edges}, chain, settings, infos};
}
async function run(o, extra={}) {
  return discoverMultiHopCycles({
    chain:o.chain,net:o.net,settings:o.settings,block:4321,
    gasPrice:1_000_000n,nativePrice:2_000_000_000n,infos:o.infos,
    preferKinds:['AAVE_V3'],at:'2026-11-14T00:00:00Z',...extra,
  });
}
test('five distinct conversions form one closed USDC cycle, always observation only', async()=>{
  const o=setup(5);
  const r=await run(o);
  assert.equal(r.candidates.length,1);
  const c=r.candidates[0];
  assert.equal(c.hopCount,5);
  assert.equal(c.legs[0].tokenIn,S);
  assert.equal(c.legs.at(-1).tokenOut,S);
  assert.equal(c.executable,false);
  assert.equal(c.mode,'MULTIHOP_OBSERVE_ONLY');
  assert.ok(c.netEstimate > 0, 'quoted profit net of 5 legs and gas');
  assert.equal(o.chain.calls.length,5);
  assert.ok(o.chain.calls.every((q)=>q.block===4321),'all quotes pinned to the same block');
});
test('ten-hop cycle discovered at depth 10 but not depth 9', async()=>{
  const o=setup(10);
  const result=await run(o);
  assert.equal(result.candidates[0].hopCount,10);
  const shallower=await run(o,{maxDepth:9});
  assert.equal(shallower.candidates.length,0);
});
test('never count open paths, repeated tokens, or pool reuse as a cycle',async()=>{
  const o=setup(5);
  o.net.routeEdges[4].tokenOut.address=addr(9999);
  assert.equal((await run(o)).candidates.length,0);
  o.net.routeEdges[4].tokenOut.address=S;
  o.net.routeEdges[2].tokenOut.address=o.net.routeEdges[1].tokenIn.address;
  assert.equal((await run(o)).candidates.length,0);
  o.net.routeEdges=setup(5).net.routeEdges;
  o.net.routeEdges[4].pool.key=o.net.routeEdges[0].pool.key;
  assert.equal((await run(o)).candidates.length,0);
});
test('quote budget is bounded and explicitly reported as truncated',async()=>{
  const o=setup(10);
  const r=await run(o,{maxQuotes:3});
  assert.equal(r.candidates.length,0);
  assert.equal(r.scannedQuotes,3);
  assert.equal(r.truncated,true);
});
test('unvalidated lenders, gas ceilings and venues never make multi-hop trade executable',async()=>{
  const o=setup(5);
  o.net.routeEdges[0].pool.forkValidated=false;
  const r=await run(o,{preferKinds:[]});
  assert.equal(r.candidates[0].provider,null);
  assert.equal(r.candidates[0].executable,false);
  assert.ok(r.candidates[0].blockers.some((x)=>/not fork-validated/.test(x)));
  assert.ok(r.candidates[0].blockers.some((x)=>/no flash provider/.test(x)));
  const high=await run(o,{gasPrice:100_000_000_000n});
  assert.ok(high.candidates[0].blockers.includes('gas above ceiling'));
});
test('malformed route edges fail validation and no network catalog means no quotes',async()=>{
  const o=setup(5);
  assert.equal((await run({...o,net:{...o.net,routeEdges:[]}})).scannedQuotes,0);
  o.net.routeEdges[1].pool.router='invalid';
  assert.throws(()=>validateCycleEdges(o.net.routeEdges,o.net.stable),/Invalid multi-hop edge/);
});

test('separate long-route flag allows only fully qualified executable candidates', async () => {
  const five = setup(5);
  const enabled = await run(five, {allowExecution: true});
  assert.equal(enabled.candidates.length, 1);
  assert.equal(enabled.candidates[0].mode, 'MULTIHOP_EXECUTION_CANDIDATE');
  assert.equal(enabled.candidates[0].executable, true);
  assert.equal(enabled.candidates[0].blockers.length, 0);
  const ten = setup(10);
  ten.settings.maxGasUnits = 5_000_000;
  const tenResult = await run(ten, {allowExecution: true});
  assert.equal(tenResult.candidates[0].hopCount, 10);
  assert.equal(tenResult.candidates[0].executable, true);
  const capped = await run(setup(10), {allowExecution: true});
  assert.equal(capped.candidates[0].executable, false);
  assert.match(capped.candidates[0].blockers.join(' '), /gas above configured units/);
});

test('untrusted pool or missing lender blocks long-route execution even when requested', async () => {
  const o = setup(5);
  o.net.routeEdges[0].pool.forkValidated = false;
  const untrusted = await run(o, {allowExecution: true});
  assert.equal(untrusted.candidates[0].executable, false);
  assert.match(untrusted.candidates[0].blockers.join(' '), /fork-validated/);
  const missing = await run(o, {allowExecution: true, preferKinds: []});
  assert.equal(missing.candidates[0].executable, false);
  assert.match(missing.candidates[0].blockers.join(' '), /no flash provider/);
});

test('long-route catalog cannot self-approve unrecognized routers or fee tiers', () => {
  const o = setup(5);
  const known = {...o.net, venues:[{type:'v2', router:o.net.routeEdges[0].pool.router, forkValidated:true}]};
  assert.equal(catalogHasTrustedVenues(known, [o.net.routeEdges[0]]), true);
  assert.equal(catalogHasTrustedVenues(known, o.net.routeEdges), false);
  assert.equal(catalogHasTrustedVenues(known, [{...o.net.routeEdges[0], pool:{...o.net.routeEdges[0].pool, forkValidated:false}}]), false);
  assert.equal(catalogHasTrustedVenues(known, [{...o.net.routeEdges[0], pool:{...o.net.routeEdges[0].pool, router:addr(99999)}}]), false);
  const v3pool = {...o.net.routeEdges[0].pool,type:'v3',routerKind:2,quoter:addr(9000),fee:500};
  const v3Known = {...o.net, venues:[{type:'v3',router:v3pool.router,routerKind:2,quoter:v3pool.quoter,fees:[500],forkValidated:true}]};
  assert.equal(catalogHasTrustedVenues(v3Known, [{...o.net.routeEdges[0],pool:v3pool}]),true);
  assert.equal(catalogHasTrustedVenues(v3Known, [{...o.net.routeEdges[0],pool:{...v3pool,fee:3000}}]),false);
});

test('all six depths 5..10 remain block-pinned and permission-gated', async () => {
  for (let depth = 5; depth <= 10; depth++) {
    const o = setup(depth);
    o.settings.maxGasUnits = 5_000_000;
    const observed = await run(o);
    assert.equal(observed.candidates.length, 1, 'observed depth ' + depth);
    assert.equal(observed.candidates[0].hopCount, depth);
    assert.equal(observed.candidates[0].executable, false);
    assert.equal(observed.candidates[0].mode, 'MULTIHOP_OBSERVE_ONLY');
    const executable = await run(o, {allowExecution: true});
    assert.equal(executable.candidates.length, 1);
    assert.equal(executable.candidates[0].hopCount, depth);
    assert.equal(executable.candidates[0].executable, true);
    assert.ok(o.chain.calls.every((call) => call.block === 4321), 'block-pinned depth ' + depth);
  }
});

test('a failed intermediate quote fails closed without emitting a partial cycle', async () => {
  const o = setup(8);
  const original = o.chain.quoteV2.bind(o.chain);
  o.chain.quoteV2 = async (router, amount, a, b, block) =>
    router === o.net.routeEdges[5].pool.router ? null : original(router, amount, a, b, block);
  const r = await run(o, {allowExecution: true});
  assert.equal(r.candidates.length, 0);
});

test('bounded search prunes unreachable branches before consuming on-chain quote budget', async () => {
  const o = setup(5);
  const dead = Array.from({length: 6}, (_, i) => ({
    pool: {key: 'dead-' + i, name: 'Dead DEX', type: 'v2', router: addr(2000 + i), routerKind: 0, fee: 0, forkValidated: true},
    tokenIn: {address: i === 0 ? S : addr(3000 + i - 1), symbol: 'D' + i},
    tokenOut: {address: addr(3000 + i), symbol: 'D' + (i + 1)},
  }));
  o.net.routeEdges = [...dead, ...o.net.routeEdges];
  const result = await run(o, {maxQuotes: 5});
  assert.equal(result.candidates.length, 1, 'reachable five-hop path should survive');
  assert.equal(result.candidates[0].hopCount, 5);
  assert.equal(result.scannedQuotes, 5, 'never spend a quote on a dead end');
  assert.equal(o.chain.calls.length, 5);
  assert.ok(o.chain.calls.every(x => x.router !== dead[0].pool.router));
});

test('first-hop traversal rotates by quoted block without weakening safety gates', async () => {
  const o = setup(5);
  const alternate = setup(5);
  const alt = alternate.net.routeEdges.map((e, i) => ({
    ...e,
    pool: {...e.pool, key: 'alt-' + i, router: addr(5000 + i)},
    tokenIn: {...e.tokenIn, address: e.tokenIn.address === S ? S : addr(6000 + i - 1)},
    tokenOut: {...e.tokenOut, address: e.tokenOut.address === S ? S : addr(6000 + i)},
  }));
  o.net.routeEdges = [...o.net.routeEdges, ...alt];
  const first = await run(o, {block: 4320, maxQuotes: 5});
  const second = await run(o, {block: 4321, maxQuotes: 5});
  assert.equal(first.candidates.length, 1);
  assert.equal(second.candidates.length, 1);
  assert.equal(first.candidates[0].legs.length, 5);
  assert.equal(second.candidates[0].legs.length, 5);
  assert.notEqual(first.candidates[0].legs[0].pool, second.candidates[0].legs[0].pool);
  assert.equal(first.candidates[0].executable, false);
  assert.equal(second.candidates[0].executable, false);
});

function star(k) {
  const net = testNet();
  const edges = [];
  for (let c = 0; c < k; c++) {
    const coins = [S, ...Array.from({length: 4}, (_, i) => addr(5000 + c * 10 + i)), S];
    for (let i = 0; i < 5; i++) edges.push({
      pool: {key: `c${c}-p${i}`, name: `Cycle ${c} DEX ${i}`, type: 'v2', router: addr(7000 + c * 10 + i), routerKind: 0, fee: 0, forkValidated: true},
      tokenIn: {address: coins[i], symbol: 'X'}, tokenOut: {address: coins[i + 1], symbol: i === 4 ? 'USDC' : 'X'},
    });
  }
  const chain = {calls: [], async quoteV2(router, amount, a, b, block) { this.calls.push({router, amount, block}); return amount * 101n / 100n; }};
  const infos = [{kind: 'AAVE_V3', address: AAVE, ok: true, available: 1_000_000_000000n, feeModel: 'aave-bps', feeParam: 5}];
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sizeSteps = [1];
  return {net: {...net, routeEdges: edges}, chain, settings, infos};
}
const firstCycle = (r) => r.candidates[0]?.legs[0].pool.split('-')[0];

test('AUDIT M-A: first-hop rotation does not alias with a fixed block stride between scans', async () => {
  const o = star(5);
  const seen = new Set();
  for (let scan = 0; scan < 5; scan++) {
    const r = await run(o, {block: 1000 + 15 * scan, maxQuotes: 5, rotation: scan});
    seen.add(firstCycle(r));
  }
  assert.equal(seen.size, 5, `every first-hop branch must get a turn; saw ${[...seen]}`);
});

test('AUDIT M-B: quote budget is shared fairly across loan sizes (full size not starved)', async () => {
  const o = star(3);
  o.settings.sizeSteps = [0.5, 1];
  const r = await run(o, {maxQuotes: 10});
  const sizes = new Set(r.candidates.map((c) => c.size));
  assert.ok(sizes.has(1000), `the full $1,000 loan size must be explored; explored ${[...sizes]}`);
  assert.ok(sizes.has(500));
  assert.equal(r.truncated, true);
});


test('fair scanning samples multiple root branches in a single scan without exceeding per-size quotes',async()=>{
 const o=star(6);
 o.settings.sizeSteps=[1];
 const r=await run(o,{maxQuotes:20,rotation:0});
 assert.equal(r.rootsEligible,6);
 assert.equal(r.rootsExplored,4);
 assert.equal(r.scannedQuotes,20);
 assert.equal(r.candidates.length,4);
 assert.equal(new Set(r.candidates.map(first=>first.legs[0].pool)).size,4);
 assert.equal(r.truncated,true);
 assert.ok(r.candidates.every(c=>c.executable===false));
 assert.ok(o.chain.calls.every(call=>call.block===4321));
});

test('four loan sizes all get root coverage and first-hop rotation changes covered branches',async()=>{
 const o=star(5);
 o.settings.sizeSteps=[0.05,0.10,0.25,0.50];
 const first=await run(o,{maxQuotes:80,rotation:0});
 const second=await run(o,{maxQuotes:80,rotation:1});
 assert.deepEqual(new Set(first.candidates.map(c=>c.size)),new Set([50,100,250,500]));
 assert.deepEqual(new Set(second.candidates.map(c=>c.size)),new Set([50,100,250,500]));
 assert.equal(first.scannedQuotes,80);
 assert.equal(first.rootsExplored,16);
 assert.equal(first.rootsEligible,5);
 const a=new Set(first.candidates.filter(c=>c.size===50).map(c=>c.legs[0].pool));
 const b=new Set(second.candidates.filter(c=>c.size===50).map(c=>c.legs[0].pool));
 assert.equal(a.size,4);
 assert.equal(b.size,4);
 assert.notDeepEqual(a,b);
 assert.ok([...first.candidates,...second.candidates].every(c=>c.mode==='MULTIHOP_OBSERVE_ONLY'&&!c.executable));
});

test('scan-only 3-hop and 4-hop discovery returns same-block quotes and never creates executable trades',async()=>{
  for(const n of [3,4]){
    const o=setup(n);
    o.settings.sizeSteps=[0.05,0.1,0.25,0.5];
    const r=await run(o,{minDepth:n,maxDepth:n,maxQuotes:24,allowExecution:false});
    assert.equal(r.candidates.length,4,'all four loan sizes at depth '+n);
    assert.deepEqual(new Set(r.candidates.map(c=>c.size)),new Set([50,100,250,500]));
    assert.ok(r.candidates.every(c=>c.hopCount===n && c.executable===false));
    assert.ok(o.chain.calls.every(q=>q.block===4321),'quotes must be pinned to one block');
    assert.ok(r.scannedQuotes<=24);
  }
});

test('a 3-hop scanner does not report a 4-hop path, or invent a partial cycle',async()=>{
  const o=setup(4);
  const three=await run(o,{minDepth:3,maxDepth:3,maxQuotes:24});
  assert.equal(three.candidates.length,0);
  const four=await run(o,{minDepth:4,maxDepth:4,maxQuotes:24});
  assert.equal(four.candidates.length,1);
  assert.equal(four.candidates[0].executable,false);
});

test('shared read-only quote cache avoids repeated same-block work across route-depth scans',async()=>{
 const o=setup(5);
 // Both 3-hop and 5-hop cycles share their first two swaps.
 const shortcut={...o.net.routeEdges[2],
  pool:{...o.net.routeEdges[2].pool,key:'shortcut',router:addr(9898)},
  tokenOut:{address:S,symbol:'USDC'}};
 o.net.routeEdges.push(shortcut);
 const cache=new Map();
 const a=await run(o,{minDepth:3,maxDepth:3,maxQuotes:30,quoteCache:cache});
 const calls=o.chain.calls.length;
 const b=await run(o,{minDepth:5,maxDepth:5,maxQuotes:30,quoteCache:cache});
 assert.equal(a.candidates.length,1);
 assert.equal(b.candidates.length,1);
 assert.ok(b.cacheHits>=2,'shared path prefixes reused from 3-hop scan');
 assert.ok(o.chain.calls.length-calls<5);
 assert.ok(o.chain.calls.every(q=>q.block===4321));
 assert.equal(b.candidates[0].executable,false);
});
test('quote cache keys include block and exact amount, avoiding stale reuse',async()=>{
 const o=setup(4);
 const cache=new Map();
 await run(o,{minDepth:4,maxDepth:4,maxQuotes:20,quoteCache:cache,block:100});
 const n=o.chain.calls.length;
 const second=await run(o,{minDepth:4,maxDepth:4,maxQuotes:20,quoteCache:cache,block:101});
 assert.equal(second.cacheHits,0);
 assert.equal(o.chain.calls.length,n+4);
 assert.ok(o.chain.calls.slice(n).every(c=>c.block===101));
});
test('funded candidate path never reads externally provided quote cache',async()=>{
 const o=setup(5);
 const cache=new Map();
 await run(o,{minDepth:5,maxDepth:5,maxQuotes:20,quoteCache:cache});
 const prev=o.chain.calls.length;
 const result=await run(o,{minDepth:5,maxDepth:5,maxQuotes:20,quoteCache:cache,allowExecution:true});
 assert.equal(result.cacheHits,0);
 assert.equal(o.chain.calls.length,prev+5);
});
