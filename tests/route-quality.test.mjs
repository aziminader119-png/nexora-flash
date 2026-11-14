import test from 'node:test';
import assert from 'node:assert/strict';
import {rankObservedRoutes,reviewObservedRoutes} from '../lib/route-quality.mjs';

const direct=(net,over={})=>({id:'direct',chainId:8453,network:'Base',pair:'USDC/WETH',size:50,
 netEstimate:net,flashFee:0,gasCost:0.03,provider:{kind:'MORPHO_BLUE'},
 profitQualification:'INDICATIVE_WITH_QUOTED_LENDER_FEE',legs:[{},{}],blockers:['scan-only: funded execution disabled'],...over});
const long=(net,over={})=>({id:'long',chainId:8453,network:'Base',pair:'USDC → WETH → DAI → cbBTC → AERO → USDC',
 hopCount:5,size:50,netEstimate:net,flashFee:0,gasCost:0.1,
 provider:{kind:'MORPHO_BLUE'},profitQualification:'INDICATIVE_WITH_QUOTED_LENDER_FEE',
 diagnostics:{probesIncomplete:false,maximumImpactBps:40},
 blockers:['multi-hop execution requires separate validation and explicit opt-in','scan-only: funded execution disabled'],...over});
test('short route with higher net estimate outranks long route even when complexity differs',()=>{
 const r=rankObservedRoutes([long(3.5),direct(4.5)]);
 assert.equal(r.bestObserved.id,'direct');
 assert.equal(r.bestObserved.hopCount,2);
 assert.equal(r.recommendedForFurtherReview.length,1);
 assert.equal(r.recommendedForFurtherReview[0].id,'long');
 assert.ok(r.topObserved.every(c=>c.executable===false));
});
test('profitable short route is labelled impact unverified rather than executable',()=>{
 const r=rankObservedRoutes([direct(8)]);
 assert.equal(r.topObserved[0].status,'IMPACT_UNVERIFIED');
 assert.equal(r.recommendedForFurtherReview.length,0);
});
test('no profitable quote is not presented as actionable even if best among losses',()=>{
 const r=rankObservedRoutes([direct(-1),long(-3)]);
 assert.equal(r.bestObserved.netEstimate,-1);
 assert.equal(r.recommendedForFurtherReview.length,0);
 assert.ok(r.topObserved.every(x=>x.status==='BELOW_MINIMUM_NET_PROFIT'));
});
test('quote-size impact or absent lender prevents review approval',()=>{
 const r=rankObservedRoutes([long(10,{diagnostics:{probesIncomplete:false,maximumImpactBps:4000}}),
   direct(12,{provider:null})]);
 assert.equal(r.recommendedForFurtherReview.length,0);
 assert.ok(r.topObserved.some(x=>x.status==='HIGH_ESTIMATED_PRICE_IMPACT'));
 assert.ok(r.topObserved.some(x=>x.status==='MISSING_VERIFIED_LENDER_FEE'));
});
test('review accepts 2–10 legs but does not mistake short unprobed route for qualified',()=>{
 const r=reviewObservedRoutes([direct(8),long(5)]);
 assert.equal(r.counts.observed,2);
 assert.equal(r.counts.unprobedOrPartial,1);
 assert.equal(r.candidates.length,1);
 assert.equal(r.candidates[0].id,'long');
});

test('quoted profit does not qualify a route with unvalidated venues or gas ceiling blockers',()=>{
 const unvalidated=long(18,{id:'unvalidated',blockers:[
 'multi-hop execution requires separate validation and explicit opt-in',
 'venue not fork-validated','scan-only: funded execution disabled']});
 const gasTooHigh=long(20,{id:'gas',blockers:['gas above ceiling',
 'scan-only: funded execution disabled']});
 const r=rankObservedRoutes([unvalidated,gasTooHigh]);
 assert.equal(r.recommendedForFurtherReview.length,0);
 assert.ok(r.topObserved.every(c=>c.status==='OTHER_BLOCKER'&&!c.eligibleForReview));
 assert.equal(reviewObservedRoutes([unvalidated,gasTooHigh]).candidates.length,0);
});
