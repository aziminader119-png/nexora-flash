// Fail-closed selection of scan candidates.
// Never retain failed-network or previous-cycle quotes as fresh opportunities.
const ADDR=/^0x[0-9a-f]{40}$/i;
const lower=x=>String(x||'').toLowerCase();
function closedRoute(c){
 if(!Array.isArray(c?.legs)||c.legs.length<2||c.legs.length>10||
   !ADDR.test(c.asset)||c.hopCount!=null&&c.hopCount!==c.legs.length)return false;
 const legs=c.legs;
 if(legs.some(l=>!l||!ADDR.test(l.tokenIn)||!ADDR.test(l.tokenOut)||!l.pool||
   lower(l.tokenIn)===lower(l.tokenOut)))return false;
 if(lower(legs[0].tokenIn)!==lower(c.asset)||
   lower(legs.at(-1).tokenOut)!==lower(c.asset))return false;
 for(let i=1;i<legs.length;i++)
  if(lower(legs[i-1].tokenOut)!==lower(legs[i].tokenIn))return false;
 return true;
}
export function projectCurrentScan(enabled,results,{maxDirect=20,maxCycles=5}={}){
 if(!Array.isArray(enabled)||!Array.isArray(results)||enabled.length!==results.length||
 !Number.isInteger(maxDirect)||maxDirect<0||maxDirect>100||
 !Number.isInteger(maxCycles)||maxCycles<0||maxCycles>100)
 throw Error('Invalid scan projection inputs');
 const candidates=[],networks=[],failures=[];
 for(let i=0;i<results.length;i++){
  const r=results[i],net=enabled[i],state=r?.state;
  const valid=state?.status==='quotes-live' && state.chainId===net.id &&
   Number.isSafeInteger(state.block)&&state.block>=0 && Array.isArray(r.candidates);
  if(!valid){
   failures.push({chainId:net.id,network:net.name,
     reason:String(state?.error||'scan unavailable').slice(0,160)});
   networks.push({chainId:net.id,name:net.name,status:'unavailable',
     error:String(state?.error||'scan unavailable').slice(0,160),
     block:state?.block??null});
   continue;
  }
  const rows=r.candidates.filter(c=>c && c.chainId===net.id && c.block===state.block &&
   Number.isFinite(c.netEstimate) && Number.isFinite(c.size) && c.size>0 &&
   closedRoute(c));
  const ordered=[...rows].sort((a,b)=>b.netEstimate-a.netEstimate);
  candidates.push(...ordered.filter(c=>(c.hopCount??c.legs.length)<3).slice(0,maxDirect),
   ...ordered.filter(c=>(c.hopCount??c.legs.length)>=3).slice(0,maxCycles));
  networks.push(state);
 }
 candidates.sort((a,b)=>b.netEstimate-a.netEstimate);
 return {candidates,networks,failures,healthyNetworks:networks.length-failures.length,
  totalNetworks:networks.length,scanComplete:failures.length===0};
}
