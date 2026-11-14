import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {discoverPublishedSpreads,fetchPublishedPairs,fetchPublishedPairsDetailed,DISCOVERY_VENUES} from '../lib/market-discovery.mjs';
const A='0x'+'11'.repeat(20),B='0x'+'22'.repeat(20);
const pool=(n,price,extras={})=>({
 chainId:'base',pairAddress:'0x'+n.toString(16).padStart(40,'0'),
 dexId:n%2?'uniswap':'aerodrome',baseToken:{address:A,symbol:'AAA'},
 quoteToken:{address:B,symbol:'BBB'},priceNative:String(price),priceUsd:'100',
 liquidity:{usd:500000},volume:{h24:50000},...extras,
});
test('published signals compare only identical direction and token addresses; never promise a trade',()=>{
 const r=discoverPublishedSpreads([pool(1,1),pool(2,1.005),pool(3,1.006,{
  baseToken:{address:B,symbol:'BBB'},quoteToken:{address:A,symbol:'AAA'}})],'base');
 assert.equal(r.observedPools,3);
 assert.equal(r.totalSignals,1);
 assert.equal(r.signals[0].buyPool,pool(1,1).pairAddress.toLowerCase());
 assert.equal(r.signals[0].sellPool,pool(2,1).pairAddress.toLowerCase());
 assert.equal(r.signals[0].actionable,false);
 assert.equal(r.signals[0].executable,false);
 assert.equal(r.signals[0].qualification,'PUBLISHED_SPREAD_ONLY');
});
test('same dex different pools can be compared if token address orientation matches',()=>{
 const r=discoverPublishedSpreads([pool(1,1),pool(3,1.01)],'base');
 assert.equal(r.totalSignals,1);
});
test('reject inactive, illiquid, fake price and unreasonable outlier pools',()=>{
 const r=discoverPublishedSpreads([pool(1,1),pool(2,1.01,{volume:{h24:0}}),
 pool(4,2),pool(5,Infinity),pool(6,1.02,{chainId:'arbitrum'})],'base');
 assert.equal(r.totalSignals,0);
 assert.equal(r.overSpreadLimit,1);
});
test('deduplicate pair IDs and reject invalid inputs',()=>{
 const r=discoverPublishedSpreads([pool(1,1),pool(1,1.1),pool(2,1.2)],'base');
 assert.equal(r.observedPools,2);
 assert.throws(()=>discoverPublishedSpreads([],'ethereum'),/Invalid discovery input/);
 assert.throws(()=>discoverPublishedSpreads([],'base',{minLiquidityUSD:-1}),/Invalid discovery input/);
});
test('uses fixed allowlisted market endpoint; malformed response fails closed',async()=>{
 const urls=[];
 const f=async url=>{urls.push(url);return {ok:true,json:async()=>[pool(1,1)]}};
 const r=await fetchPublishedPairs('base',{fetchFn:f});
 assert.equal(r.length,4);
 assert.equal(urls.length,4);
 assert.ok(urls.every(x=>x.startsWith('https://api.dexscreener.com/token-pairs/v1/base/')));
 await assert.rejects(fetchPublishedPairs('base',{fetchFn:async()=>({ok:true,json:async()=>({})})}),/All published price seeds unavailable/);
});

test('ten curated venue targets are unique and never treated as trading permissions',()=>{
 assert.equal(DISCOVERY_VENUES.length,10);
 assert.equal(new Set(DISCOVERY_VENUES.map(v=>v.name)).size,10);
 assert.ok(DISCOVERY_VENUES.every(v=>v.ids.length>0 && v.chains.length>0));
 const output=discoverPublishedSpreads([pool(1,1),pool(2,1.005)],'base');
 assert.equal(output.venueCoverage.targets,8);
 assert.deepEqual(new Set(output.venueCoverage.observed.map(x=>x.name)),new Set(['Uniswap','Aerodrome']));
 assert.ok(output.venueCoverage.missing.includes('PancakeSwap'));
 assert.equal(output.signals[0].executable,false);
});
test('unknown metadata venue remains excluded, but is visible in diagnostics',()=>{
 const r=discoverPublishedSpreads([pool(1,1),pool(2,1.01,{dexId:'unknown-market'})],'base');
 assert.equal(r.totalSignals,0);
 assert.ok(r.venueCoverage.ignoredDexIds.includes('unknown-market'));
});
test('per-seed market fetch is bounded for both supported chains',async()=>{
 for(const chain of ['base','arbitrum']){
  const urls=[];
  const r=await fetchPublishedPairs(chain,{fetchFn:async url=>{
   urls.push(url);return {ok:true,json:async()=>Array.from({length:350},(_,i)=>pool(i+1,1))};
  }});
  assert.equal(urls.length,chain==='base'?4:5);
  assert.equal(r.length,Math.min(urls.length*250,1500));
 }
});

test('favors liquid active markets over source order when a seed has more than 250 pairs',async()=>{
 const many=Array.from({length:300},(_,i)=>pool(i+1,1,{
  volume:{h24:i===299?1_000_000:i+1},liquidity:{usd:i===299?5_000_000:50_000},
 }));
 const r=await fetchPublishedPairs('base',{fetchFn:async()=>({ok:true,json:async()=>many})});
 assert.equal(r.length,1000);
 assert.ok(r.some(x=>x.pairAddress===many[299].pairAddress),'last but most active pool must be included');
 assert.ok(!r.some(x=>x.pairAddress===many[0].pairAddress),'lowest volume pool should be excluded');
});

test('one failed public market seed is transparent, yet remaining seeds can report indicative data',async()=>{
 let calls=0;
 const f=async()=>{calls++;if(calls===2)throw Error('timeout');
  return {ok:true,json:async()=>[pool(calls,1)]};
 };
 const report=await fetchPublishedPairsDetailed('base',{fetchFn:f});
 assert.equal(report.requestedSeeds,4);
 assert.equal(report.successfulSeeds,3);
 assert.equal(report.failedSeeds.length,1);
 assert.equal(report.coverageComplete,false);
 assert.equal(report.pairs.length,3);
});
test('a fully unavailable market API never returns misleading zero opportunities',async()=>{
 await assert.rejects(fetchPublishedPairsDetailed('base',{fetchFn:async()=>{throw Error('unavailable')}}),/All published price seeds unavailable/);
});
test('strict legacy fetch rejects incomplete coverage instead of silently returning partial data',async()=>{
 let calls=0;const f=async()=>{if(++calls===1)throw Error('oops');
  return {ok:true,json:async()=>[]}};
 await assert.rejects(fetchPublishedPairs('base',{fetchFn:f}),/Incomplete published price coverage/);
});
test('server exposes explicit incomplete published data coverage',()=>{
 const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 assert.match(source,/fetchPublishedPairsDetailed\(chain/);
 assert.match(source,/incomplete:!discovery\.coverageComplete/);
 assert.match(source,/sourceCoverage:/);
});
