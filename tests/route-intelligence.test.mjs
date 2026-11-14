import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {rankRouteFamilies,chooseImpactProbes} from '../lib/route-intelligence.mjs';
const A='0x'+'11'.repeat(20),B='0x'+'22'.repeat(20);
function cand(size,net,{block=100,id='x',provider=true,impact=20,fee='INDICATIVE_WITH_QUOTED_LENDER_FEE',blocked=false}={}){
 return {id,chainId:8453,network:'Base',pair:'USDC/WETH',block,size,netEstimate:net,
  provider:provider?{fee:'1',kind:'AAVE_V3'}:null,profitQualification:fee,
  blockers:blocked?['venue not fork-validated']:['scan-only: funded execution disabled'],
  legs:[{pool:'p1',tokenIn:A,tokenOut:B,fee:500},{pool:'p2',tokenIn:B,tokenOut:A,fee:500}],
  diagnostics:impact==null?null:{probesIncomplete:false,maximumImpactBps:impact},
  executable:false};
}
test('different loan sizes group within exact same-block route and optimize net dollars, not percentage',()=>{
 const r=rankRouteFamilies([cand(50,1),cand(100,4),cand(250,2)]);
 assert.equal(r.totalFamilies,1);
 assert.equal(r.families[0].bestQuotedSizeUSD,100);
 assert.equal(r.families[0].bestNetEstimateUSD,4);
 assert.equal(r.families[0].sizeComparisons.length,3);
 assert.equal(r.families[0].eligibleForForkReview,true);
 assert.equal(r.families[0].executable,false);
});
test('do not merge stale-block outcomes into fresh-size optimization',()=>{
 const r=rankRouteFamilies([cand(50,90,{block:99}),cand(100,-2,{block:100})]);
 assert.equal(r.families[0].bestQuotedSizeUSD,100);
 assert.equal(r.families[0].bestNetEstimateUSD,-2);
 assert.equal(r.skipped.multiBlock,1);
});
test('size optimum with no lender quote or incomplete impact remains blocked',()=>{
 const r=rankRouteFamilies([cand(100,200,{provider:false}),cand(50,120,{impact:null,fee:'INCOMPLETE_MISSING_LENDER_FEE'})]);
 assert.equal(r.families[0].eligibleForForkReview,false);
 assert.equal(r.families[0].assessment,'LENDER_FEE_UNVERIFIED');
 assert.equal(r.eligibleForForkReview,0);
});
test('different pool identities do not cross-optimize',()=>{
 const b=cand(100,9);b.legs[1].pool='different';
 assert.equal(rankRouteFamilies([cand(50,4),b]).totalFamilies,2);
});
test('impact probe prioritizes distinct profitable routes and skips negative noise',()=>{
 const a=cand(50,-15), b=cand(100,20), c=cand(250,15);
 const d=cand(100,18);d.legs[1].pool='other';
 assert.deepEqual(chooseImpactProbes([a,c,d,b],{maxRoutes:2}).map(x=>x.netEstimate),[20,18]);
 assert.deepEqual(chooseImpactProbes([a],{}),[]);
});
test('reject invalid limits and estimates; output never marks routes executable',()=>{
 assert.throws(()=>rankRouteFamilies([], {maxFamilies:0}),/Invalid/);
 assert.throws(()=>chooseImpactProbes([], {maxRoutes:5}),/Invalid/);
 assert.equal(rankRouteFamilies([cand(100,NaN)]).totalFamilies,0);
 assert.equal(rankRouteFamilies([cand(100,8,{blocked:true})]).eligibleForForkReview,0);
});
test('server exposes read-only size ranking; no effect on live execution flag',()=>{
 const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 assert.match(server,/\/api\/routes\/intelligence/);
 assert.match(server,/rankRouteFamilies\(\[\.\.\.twoHop,\.\.\.all\]/);
 assert.match(server,/chooseImpactProbes\(extra\.candidates/);
 assert.match(server,/if \(LIVE && settings\.autoExecute\)/);
});

test('best economic size can be unsafe while smaller complete size remains reviewable',()=>{
 const r=rankRouteFamilies([cand(200,15,{impact:null}),cand(100,12,{impact:40})]);
 assert.equal(r.families[0].bestQuotedSizeUSD,200);
 assert.equal(r.families[0].assessment,'IMPACT_UNVERIFIED');
 assert.equal(r.families[0].bestReviewableSizeUSD,100);
 assert.equal(r.families[0].bestReviewableNetEstimateUSD,12);
 assert.equal(r.families[0].eligibleForForkReview,true);
 assert.equal(r.families[0].executable,false);
});

test('conflicting quotes at identical block and size are excluded rather than selecting a convenient winner',()=>{
 const x=cand(100,9),y=cand(100,99);
 const r=rankRouteFamilies([x,y]);
 assert.equal(r.totalFamilies,0);
 assert.equal(r.skipped.duplicate,1);
 assert.equal(r.eligibleForForkReview,0);
 assert.equal(x.executable,false);
});
test('conflicting large size cannot hide independently quoted smaller size',()=>{
 const r=rankRouteFamilies([cand(100,9),cand(100,99),cand(50,3)]);
 assert.equal(r.totalFamilies,1);
 assert.equal(r.families[0].bestQuotedSizeUSD,50);
 assert.equal(r.families[0].executable,false);
});
