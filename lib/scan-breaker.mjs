// Independent per-network RPC circuit breaker for read-only scanning.
// Never interferes with pending transaction recovery or funded execution.
// Monotonic retry times relative to caller-supplied clock.
export class ScanCircuitBreaker {
 constructor({maxFailures=3,cooldownMs=60000,maxCooldownMs=300000,now=()=>Date.now()}={}){
  if(!Number.isInteger(maxFailures)||maxFailures<1||maxFailures>20||
   !Number.isInteger(cooldownMs)||cooldownMs<1000||
   !Number.isInteger(maxCooldownMs)||maxCooldownMs<cooldownMs)
    throw Error('Invalid scan breaker settings');
  this.maxFailures=maxFailures;this.cooldownMs=cooldownMs;
  this.maxCooldownMs=maxCooldownMs;this.now=now;this.map=new Map();
 }
 state(id){
  return this.map.get(id)||{failures:0,until:0,opens:0,trial:false,lastError:null};
 }
 canScan(id){
  const s=this.state(id),t=this.now();
  if(s.failures<this.maxFailures)return {allowed:true,status:'CLOSED'};
  if(t<s.until)return {allowed:false,status:'OPEN',retryAfterMs:s.until-t};
  if(s.trial)return {allowed:false,status:'HALF_OPEN_BUSY',retryAfterMs:0};
  this.map.set(id,{...s,trial:true});
  return {allowed:true,status:'HALF_OPEN'};
 }
 record(id,ok,reason=null){
  const s=this.state(id);
  if(ok){this.map.set(id,{failures:0,until:0,opens:s.opens,trial:false,lastError:null});return;}
  const failures=s.failures+1,opens=failures>=this.maxFailures?s.opens+1:s.opens;
  const backoff=Math.min(this.maxCooldownMs,this.cooldownMs*(2**Math.min(4,Math.max(0,opens-1))));
  this.map.set(id,{failures,until:failures>=this.maxFailures?this.now()+backoff:0,
   opens,trial:false,lastError:String(reason||'RPC_SCAN_ERROR').slice(0,120)});
 }
 snapshot(){
  return [...this.map].map(([chainId,s])=>({chainId,failures:s.failures,
   state:s.failures<this.maxFailures?'CLOSED':this.now()<s.until?'OPEN':'RETRY_READY',
   retryAfterMs:Math.max(0,s.until-this.now()),opens:s.opens,
   lastError:s.lastError}));
 }
}
