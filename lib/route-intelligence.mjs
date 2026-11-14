// Scan-only per-route economic intelligence. Does not authorize execution.
// Preserve 2-10 hop routes; group identical pool/direction/fee paths at one block.
const safeNum = v => typeof v === 'number' && Number.isFinite(v);
function keyFor(c){
 if(!Number.isInteger(c?.chainId)||!Array.isArray(c.legs)||c.legs.length<2||c.legs.length>10) return null;
 if(c.legs.some(l=>!l.pool||!l.tokenIn||!l.tokenOut||!Number.isInteger(Number(l.fee??0))))return null;
 return c.chainId+'|'+c.legs.map(l=>[
  String(l.pool).toLowerCase(),String(l.tokenIn).toLowerCase(),
  String(l.tokenOut).toLowerCase(),Number(l.fee??0)
 ].join(':')).join('>');
}
function assessment(c,minProfitUSD,maxImpactBps){
 if(!safeNum(c?.netEstimate))return 'INVALID_ESTIMATE';
 if(c.netEstimate<minProfitUSD)return 'BELOW_MIN_PROFIT';
 if(!c.provider||c.profitQualification!=='INDICATIVE_WITH_QUOTED_LENDER_FEE')
  return 'LENDER_FEE_UNVERIFIED';
 if((c.blockers||[]).some(x=>x!=='scan-only: funded execution disabled'&&
   x!=='multi-hop execution requires separate validation and explicit opt-in'))return 'OTHER_BLOCKER';
 if(!c.diagnostics||c.diagnostics.probesIncomplete!==false||
   !safeNum(c.diagnostics.maximumImpactBps))return 'IMPACT_UNVERIFIED';
 if(c.diagnostics.maximumImpactBps>maxImpactBps)return 'HIGH_IMPACT';
 return 'FORK_VALIDATION_REQUIRED';
}
export function rankRouteFamilies(candidates=[],{minProfitUSD=3,maxImpactBps=300,
 maxFamilies=30}={}){
 if(!Array.isArray(candidates)||!safeNum(minProfitUSD)||minProfitUSD<=0||
 !Number.isInteger(maxImpactBps)||maxImpactBps<0||maxImpactBps>10000||
 !Number.isInteger(maxFamilies)||maxFamilies<1||maxFamilies>100)
 throw Error('Invalid route intelligence inputs');
 const groups=new Map(),issues={invalid:0,duplicate:0,multiBlock:0};
 const known=new Set();
 for(const c of candidates){
  const key=keyFor(c);
  if(!key||!safeNum(c.size)||c.size<=0||!safeNum(c.netEstimate)||
   !Number.isSafeInteger(c.block)||c.block<0){issues.invalid++;continue;}
  const instance=key+'|'+c.block+'|'+c.size;
  if(known.has(instance)){issues.duplicate++;continue;}
  known.add(instance);
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(c);
 }
 const families=[];
 for(const [routeKey,rows] of groups){
  const latestBlock=Math.max(...rows.map(c=>c.block));
  const sameBlock=rows.filter(c=>c.block===latestBlock);
  issues.multiBlock+=rows.length-sameBlock.length;
  sameBlock.sort((a,b)=>b.netEstimate-a.netEstimate||a.size-b.size);
  const best=sameBlock[0]; // best observed economics, regardless of review readiness
  const status=assessment(best,minProfitUSD,maxImpactBps);
  const bestReviewable=sameBlock.find(c=>assessment(c,minProfitUSD,maxImpactBps)==='FORK_VALIDATION_REQUIRED')||null;
  const sizes=sameBlock.slice().sort((a,b)=>a.size-b.size).map(c=>({
   sizeUSD:c.size,netEstimateUSD:c.netEstimate,
   grossUSD:safeNum(c.gross)?c.gross:null,
   gasCostUSD:safeNum(c.gasCost)?c.gasCost:null,
   flashFeeUSD:safeNum(c.flashFee)?c.flashFee:null,
   assessment:assessment(c,minProfitUSD,maxImpactBps)
  }));
  families.push({routeKey,chainId:best.chainId,network:best.network,
   pair:best.pair,hopCount:best.legs.length,block:best.block,
   sizesObserved:sizes.length,bestQuotedSizeUSD:best.size,
   bestNetEstimateUSD:best.netEstimate,
   expectedReturnBps:best.size?Math.round(best.netEstimate/best.size*1e4):null,
   assessment:status,eligibleForForkReview:bestReviewable!==null,
   bestReviewableSizeUSD:bestReviewable?.size??null,
   bestReviewableNetEstimateUSD:bestReviewable?.netEstimate??null,
   sizeComparisons:sizes,executable:false});
 }
 families.sort((a,b)=>b.bestNetEstimateUSD-a.bestNetEstimateUSD||
 a.hopCount-b.hopCount||a.routeKey.localeCompare(b.routeKey));
 const statusCounts={};
 for(const f of families)statusCounts[f.assessment]=(statusCounts[f.assessment]||0)+1;
 return {mode:'SCAN_ONLY_ROUTE_INTELLIGENCE',totalFamilies:families.length,
  candidateCount:candidates.length,skipped:issues,assessmentCounts:statusCounts,
  profitableQuotedFamilies:families.filter(f=>f.bestNetEstimateUSD>=minProfitUSD).length,
  eligibleForForkReview:families.filter(f=>f.eligibleForForkReview).length,
  families:families.slice(0,maxFamilies),
  caveat:'Size optimum is only among successfully quoted amounts at the same block. Market orders, transactions, and realizable profits are NOT verified. All rows are non-executable.'};
}
/**
 * Probe promising routes first, rather than spending capped RPC diagnostics
 * on highly negative paths. Distinct route families only; never follow
 * unverified market metadata with an on-chain execution.
 */
export function chooseImpactProbes(candidates=[],{minProfitUSD=3,maxRoutes=2}={}){
 if(!Array.isArray(candidates)||!safeNum(minProfitUSD)||minProfitUSD<=0||
   !Number.isInteger(maxRoutes)||maxRoutes<0||maxRoutes>4)
 throw Error('Invalid probe selection');
 const seen=new Set();
 return candidates.filter(c=>safeNum(c?.netEstimate)&&c.netEstimate>=minProfitUSD)
  .sort((a,b)=>b.netEstimate-a.netEstimate).filter(c=>{
   const key=keyFor(c);
   if(!key||seen.has(key))return false;
   seen.add(key);return true;
  }).slice(0,maxRoutes);
}
