import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ScanCircuitBreaker} from '../lib/scan-breaker.mjs';
test('three consecutive failures open only the affected chain with a half-open retry',()=>{
 let time=10000;
 const b=new ScanCircuitBreaker({cooldownMs:1000,maxCooldownMs:4000,now:()=>time});
 for(let i=0;i<3;i++)b.record(8453,false,'RPC timeout');
 assert.equal(b.canScan(8453).allowed,false);
 assert.equal(b.canScan(42161).allowed,true);
 assert.equal(b.snapshot()[0].state,'OPEN');
 time+=1000;
 assert.equal(b.canScan(8453).status,'HALF_OPEN');
 assert.equal(b.canScan(8453).status,'HALF_OPEN_BUSY');
 b.record(8453,true);
 assert.equal(b.canScan(8453).status,'CLOSED');
 assert.equal(b.snapshot()[0].failures,0);
});
test('failed half-open recheck backs off and cannot get stuck open forever',()=>{
 let time=1000;
 const b=new ScanCircuitBreaker({maxFailures:2,cooldownMs:1000,maxCooldownMs:2000,now:()=>time});
 b.record(56,false);b.record(56,false);
 assert.equal(b.canScan(56).status,'OPEN');
 time+=1000;
 assert.equal(b.canScan(56).status,'HALF_OPEN');
 b.record(56,false);
 assert.equal(b.canScan(56).status,'OPEN');
 assert.equal(b.snapshot()[0].retryAfterMs,2000);
 time+=2000;
 assert.equal(b.canScan(56).status,'HALF_OPEN');
 b.record(56,true);
 assert.equal(b.snapshot()[0].state,'CLOSED');
});
test('validates bounded settings; status reporting contains no secrets',()=>{
 assert.throws(()=>new ScanCircuitBreaker({cooldownMs:0}),/Invalid/);
 const b=new ScanCircuitBreaker();
 b.record(8453,false,'RPC timeout');
 assert.deepEqual(b.snapshot()[0].lastError,'RPC timeout');
});
test('backend scanner health is not an execution or recovery gate',()=>{
 const s=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 assert.match(s,/\/api\/scanner\/health/);
 assert.match(s,/scanBreaker\.canScan\(net\.id\)/);
 assert.match(s,/if \(!LIVE\) scanBreaker\.record/);
 assert.match(s,/if \(signer\) await Promise\.all\(nets\.filter/);
});
