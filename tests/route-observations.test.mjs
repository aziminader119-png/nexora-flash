import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RouteObservations} from '../lib/route-observations.mjs';

const net={id:8453,name:'Base'};
const state={block:123,multiHopQuotes:80,multiHopTruncated:true};
const make=(n,netEstimate=-100)=>({id:'cycle-'+n,network:'Base',chainId:8453,
  hopCount:5,netEstimate,executable:false,blockers:['no flash provider: none configured']});

test('multihop API keeps all network cycles independently of dashboard 100-item limit',()=>{
 const db=new RouteObservations();
 db.record(net,state,Array.from({length:180},(_,i)=>make(i,i-150)),{minimumProfit:3});
 assert.equal(db.cycles({chainId:'8453'}).total,180);
 assert.equal(db.cycles({chainId:'8453',limit:'200'}).cycles.length,180);
 assert.equal(db.cycles({chainId:'8453',positiveOnly:'true'}).total,29);
 assert.equal(db.cycles({chainId:'8453',offset:'20',limit:'10'}).cycles.length,10);
 assert.equal(db.stats().networks[0].cycles,180);
 assert.equal(db.stats().networks[0].profitableQuotes,29);
 assert.equal(db.stats().networks[0].missingProvider,180);
 assert.equal(db.stats().networks[0].truncated,true);
});

test('fresh cycle snapshots supersede prior cycle lists but retain per-chain history',()=>{
 const db=new RouteObservations();
 db.record(net,state,[make(1)]);
 db.record({id:56,name:'BNB'},state,[{...make(2),chainId:56,network:'BNB'}]);
 db.record(net,state,[]);
 assert.equal(db.cycles().total,1);
 assert.equal(db.cycles({chainId:'8453'}).total,0);
 assert.equal(db.scans().total,3);
});

test('aggregates persist without storing full candidate/token routes',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'nexora-observations-'));
 const file=path.join(tmp,'scans.jsonl');
 const db=new RouteObservations(file);
 db.record(net,state,[make(1),make(2,3.5)],{minimumProfit:3});
 const raw=fs.readFileSync(file,'utf8');
 assert.ok(!raw.includes('cycle-1'));
 assert.equal(new RouteObservations(file).scans().scans[0].cycles,2);
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 fs.rmSync(tmp,{recursive:true,force:true});
});

test('bounded read-only pagination rejects invalid and abusive query parameters',()=>{
 const db=new RouteObservations();
 for(const q of [{limit:'2000'},{offset:'-1'},{minHops:'4'},{maxHops:'11'},
   {positiveOnly:'yes'},{chainId:'nope'}]) assert.throws(()=>db.cycles(q),/Invalid/);
 assert.throws(()=>db.cycles({minHops:'10',maxHops:'5'}),/cannot exceed/);
});

test('unqualified lender never makes a negative observed quote executable',()=>{
 const db=new RouteObservations();
 const report=db.record(net,{...state,multiHopError:'upstream RPC error'},[make(1,-259)],{minimumProfit:3});
 assert.equal(report.profitableQuotes,0);
 assert.equal(report.executable,0);
 assert.equal(report.error,'upstream RPC error');
});

test('legacy /api/status and new API routes coexist without changing UI or execution flags',()=>{
 const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 assert.match(source,/routeObservations\.record\(enabled\[i\], r\.state, r\.candidates/);
 assert.match(source,/\/api\/multihop\/cycles/);
 assert.match(source,/\/api\/multihop\/stats/);
 assert.match(source,/\/api\/multihop\/history/);
 assert.match(source,/opportunities: opportunities\.slice\(0, 100\)/);
 assert.match(source,/if \(LIVE && settings\.autoExecute\)/);
});

test('72-hour rolling health aggregates summarize quote coverage and truncated scans',()=>{
 const db=new RouteObservations();
 db.record(net,state,[make(1,-4),make(2,5)],{minimumProfit:3});
 db.record(net,{...state,multiHopQuotes:10,multiHopTruncated:false},[make(3,-7)],{minimumProfit:3});
 const roll=db.stats().rolling72h.find(x=>x.chainId===8453);
 assert.equal(roll.scans,2);
 assert.equal(roll.quotes,90);
 assert.equal(roll.cycles,3);
 assert.equal(roll.profitableIndicativeQuotes,1);
 assert.equal(roll.aboveMinProfitIndicativeQuotes,1);
 assert.equal(roll.truncatedScans,1);
 assert.equal(roll.errorScans,0);
});
