// Pure read-only acceptance scoring for scheduled shadow scans.
// Scan-only reliability cannot establish executable arbitrage profitability.
const NETWORKS=[56,8453,42161,10,137];
const valid=p=>p&&typeof p==='object'&&Array.isArray(p.networks);
export function summarizeShadowSoak(samples=[],{
 minSamples=360,minimumAvailability=0.95,maxConsecutiveUnhealthy=10
}={}){
 if(!Array.isArray(samples)||!Number.isInteger(minSamples)||minSamples<1||
  !Number.isFinite(minimumAvailability)||minimumAvailability<0.5||minimumAvailability>1||
  !Number.isInteger(maxConsecutiveUnhealthy)||maxConsecutiveUnhealthy<1)
 throw Error('Invalid shadow soak parameters');
 const observations=samples.filter(valid);
 const violations=[];
 let modesOff=0,invalidModes=0,tradeCount=0,signerCount=0;
 const stats=new Map(NETWORKS.map(id=>[id,{chainId:id,observed:0,healthy:0,
  longestUnhealthy:0,consecutiveUnhealthy:0,quoteSamples:0,positiveSamples:0}]));
 for(const s of observations){
  const safe=s.mode==='SCAN_ONLY'&&s.liveExecutionEnabled===false&&
   s.longRouteExecutionOptIn===false&&s.settings?.autoExecute===false&&
   Array.isArray(s.settings?.liveChains)&&s.settings.liveChains.length===0;
  if(safe)modesOff++;else invalidModes++;
  if(s.signer)signerCount++;
  tradeCount+=Array.isArray(s.trades)?s.trades.length:0;
  for(const [id,st] of stats){
   const n=s.networks.find(v=>v.chainId===id);
   if(!n)continue;
   st.observed++;
   const healthy=n.status==='quotes-live'&&Number.isSafeInteger(n.block)&&n.block>=0;
   if(healthy){st.healthy++;st.consecutiveUnhealthy=0;}
   else {
    st.consecutiveUnhealthy++;
    st.longestUnhealthy=Math.max(st.longestUnhealthy,st.consecutiveUnhealthy);
   }
   st.quoteSamples+=Number.isFinite(n.multiHopQuotes)?n.multiHopQuotes:0;
   st.positiveSamples+=Number.isFinite(n.multiHopCycles)?n.multiHopCycles:0;
  }
 }
 if(!observations.length)violations.push('NO_STATUS_OBSERVATIONS');
 if(invalidModes)violations.push('TRADING_MODE_OR_SETTINGS_NOT_DISABLED');
 if(tradeCount||signerCount)violations.push('TRADING_HISTORY_OR_SIGNER_PRESENT');
 const networks=[...stats.values()].map(s=>({
  chainId:s.chainId,observed:s.observed,healthy:s.healthy,
  availability:s.observed?s.healthy/s.observed:null,
  longestUnhealthy:s.longestUnhealthy,
  quotedHopCalls:s.quoteSamples,observedCycles:s.positiveSamples
 }));
 const insufficient=observations.length<minSamples||
  networks.some(n=>n.observed<minSamples);
 const unavailable=networks.some(n=>n.availability!==null&&
  (n.availability<minimumAvailability||n.longestUnhealthy>maxConsecutiveUnhealthy));
 if(unavailable)violations.push('RPC_NETWORK_AVAILABILITY_BELOW_TARGET');
 const safetyBad=invalidModes>0||tradeCount>0||signerCount>0;
 const decision=safetyBad||unavailable?'REJECTED':
   insufficient?'INCOMPLETE':'PASS_SCAN_ONLY';
 return {mode:'SCAN_ONLY_SOAK_ACCEPTANCE',decision,sampleCount:observations.length,
  configuredMinimumSamples:minSamples,minimumAvailability,
  operatingModeSafe:safetyBad===false,networks,violations,
  profitableArbitrageProven:false,atomicSimulationProven:false,
  caveat:'An operational scan-only soak cannot prove real net profit or transaction execution safety.'};
}
