// Ranking of read-only observations. Nothing returned here is an execution approval.
// A quote is not a real-liquidity fork test, a simulation, or a guaranteed trade.
const allowedNonTradeBlockers=new Set([
  'scan-only: funded execution disabled',
  'multi-hop execution requires separate validation and explicit opt-in',
]);
function safeProfit(c){return typeof c.netEstimate==='number'&&Number.isFinite(c.netEstimate)?c.netEstimate:-Infinity;}
function incomplete(c){
 const d=c?.diagnostics;
 return !d || d.probesIncomplete!==false ||
  typeof d.maximumImpactBps!=='number' || !Number.isFinite(d.maximumImpactBps);
}
export function reviewObservedRoutes(candidates,{minProfitUSD=3,maxImpactBps=300,maxResults=10}={}){
 if(!Array.isArray(candidates) || !Number.isFinite(minProfitUSD) || minProfitUSD<=0 ||
   !Number.isInteger(maxImpactBps) || maxImpactBps<0 || maxImpactBps>10000 ||
   !Number.isInteger(maxResults) || maxResults<1 || maxResults>100)
   throw Error('Invalid route review inputs');
 const counts={observed:0,negativeOrBelowMin:0,missingLenderQuote:0,
  unprobedOrPartial:0,highImpact:0,otherBlocked:0,reviewCandidates:0};
 const eligible=[];
 for(const c of candidates){
  if(!c || (c.hopCount!=null && (!Number.isInteger(c.hopCount) || c.hopCount<2 || c.hopCount>10)))continue;
  counts.observed++;
  if(safeProfit(c)<minProfitUSD){counts.negativeOrBelowMin++;continue;}
  if(!c.provider || !c.profitQualification?.includes('QUOTED_LENDER_FEE')){counts.missingLenderQuote++;continue;}
  if(incomplete(c)){counts.unprobedOrPartial++;continue;}
  if(c.diagnostics.maximumImpactBps>maxImpactBps){counts.highImpact++;continue;}
  if((c.blockers||[]).some(b=>!allowedNonTradeBlockers.has(b))){counts.otherBlocked++;continue;}
  eligible.push(c);
 }
 eligible.sort((a,b)=>safeProfit(b)-safeProfit(a));
 counts.reviewCandidates=eligible.length;
 return {
  mode:'READ_ONLY_REVIEW',minimumProfitUSD:minProfitUSD,maxImpactBps,
  counts,noQualifiedRoute:eligible.length===0,
  caveat:'These are candidates for independent fork review only. No trade is authorized or guaranteed.',
  candidates:eligible.slice(0,maxResults).map(c=>({
   id:c.id,chainId:c.chainId,network:c.network,pair:c.pair,hopCount:c.hopCount ?? c.legs?.length ?? 2,
   size:c.size,netEstimate:c.netEstimate,flashFee:c.flashFee,gasCost:c.gasCost,
   maximumImpactBps:c.diagnostics.maximumImpactBps,
   reviewStatus:'REQUIRES_REAL_VENUE_FORK_TEST',
   executable:false,
  })),
 };
}
