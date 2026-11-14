// Pure scan-only RPC budget planner. Maximize exploration where observed
// quoted economics are promising without starving any other route depth.
// No market metadata, stale block data or execution permission is consumed.
const LEVELS=['two','three','four','long'];
const FLOOR={two:24,three:16,four:16,long:40};
const CAP={two:80,three:64,four:64,long:80};
const PRIOR={two:5,three:3,four:2,long:1};
export const TOTAL_DEPTH_QUOTES=152;
export function routeDepthBudgets(previous=[]){
 if(!Array.isArray(previous))throw Error('Invalid previous observations');
 const maxima={two:-Infinity,three:-Infinity,four:-Infinity,long:-Infinity};
 for(const c of previous){
  const h=c?.hopCount??c?.legs?.length,profit=c?.netEstimate;
  if(!Number.isFinite(profit)||!Number.isInteger(h)||h<2||h>10)continue;
  const name=h===2?'two':h===3?'three':h===4?'four':'long';
  maxima[name]=Math.max(maxima[name],profit);
 }
 const weight={...PRIOR};
 // Profit evidence updates weights, but the 40-call long-route floor
 // still allows complete 10-hop paths for four sizes every scan.
 for(const name of LEVELS)if(maxima[name]>0){
  weight[name]+=Math.min(12,Math.floor(Math.log2(1+maxima[name])*3)+2);
 }
 const budgets={...FLOOR};
 let remaining=TOTAL_DEPTH_QUOTES-Object.values(FLOOR).reduce((a,b)=>a+b,0);
 while(remaining>0){
  const available=LEVELS.filter(name=>budgets[name]<CAP[name]);
  if(!available.length)throw Error('Insufficient depth budget capacity');
  available.sort((a,b)=>{
   const pa=(budgets[a]-FLOOR[a]+1)/weight[a];
   const pb=(budgets[b]-FLOOR[b]+1)/weight[b];
   return pa-pb || LEVELS.indexOf(a)-LEVELS.indexOf(b);
  });
  budgets[available[0]]++;remaining--;
 }
 return {budgets,weight,
  previousBest:Object.fromEntries(LEVELS.map(k=>[k,Number.isFinite(maxima[k])?maxima[k]:null])),
  mode:'SCAN_ONLY_BUDGET',totalQuotes:TOTAL_DEPTH_QUOTES};
}
