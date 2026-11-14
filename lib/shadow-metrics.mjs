// Compact, persistent read-only measurement of observed quote decay.
// These metrics are NOT a backtest, realized P&L, or trade authorization.
import fs from 'node:fs';
import path from 'node:path';
const MAX_SAMPLES=1000;
const SAFE_STATUS=new Set(['REQUOTE_ABOVE_THRESHOLD','REQUOTE_BELOW_THRESHOLD',
 'UNKNOWN_POOL','SAME_BLOCK_NO_INDEPENDENT_REQUOTE','INVALID_AMOUNT',
 'EXCEEDS_LOAN_CEILING','RPC_OR_QUOTE_ERROR','INVALID_LENDER_FEE',
 'LENDER_QUOTE_UNAVAILABLE','SHADOW_TIME_BUDGET_EXCEEDED']);
const validNumber=x=>typeof x==='number'&&Number.isFinite(x);
const compact=(chainId,shadow,now)=>({
  schema:1,chainId,at:new Date(now).toISOString(),
  status:shadow.status,
  quotes:Number(shadow.quotes)||0,
  attempts:Array.isArray(shadow.candidates)?shadow.candidates.map(c=>({
    status:SAFE_STATUS.has(c.status)?c.status:'UNRECOGNIZED',
    oldBlock:Number.isSafeInteger(c.oldBlock)?c.oldBlock:null,
    shadowBlock:Number.isSafeInteger(c.shadowBlock)?c.shadowBlock:null,
    quotedNetUSD:validNumber(c.quotedNetUSD)?c.quotedNetUSD:null,
    shadowNetUSD:validNumber(c.shadowNetUSD)?c.shadowNetUSD:null,
    decayUSD:validNumber(c.decayUSD)?c.decayUSD:null,
  })).slice(0,5):[],
});
export class ShadowMetrics{
  constructor(file=null,{maxSamples=MAX_SAMPLES,now=()=>Date.now()}={}){
    if(!Number.isInteger(maxSamples)||maxSamples<1||maxSamples>MAX_SAMPLES)
      throw Error('Invalid maxSamples');
    this.file=file;this.maxSamples=maxSamples;this.now=now;this.rows=[];
    if(!file)return;
    fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true,mode:0o700});
    if(!fs.existsSync(file))return;
    // Read only a bounded tail. A torn last line is excluded from statistics.
    const stat=fs.statSync(file),fd=fs.openSync(file,'r');
    let raw;
    try{
      const n=Math.min(stat.size,2*1024*1024),b=Buffer.alloc(n);
      fs.readSync(fd,b,0,n,stat.size-n);raw=b.toString('utf8');
    }finally{fs.closeSync(fd);}
    if(stat.size>2*1024*1024)raw=raw.slice(raw.indexOf('\n')+1);
    for(const line of raw.split('\n')){
      try{const e=JSON.parse(line);if(e?.schema===1&&
       Number.isInteger(e.chainId)&&Array.isArray(e.attempts))this.rows.push(e);}
      catch{/* ignore torn or invalid record */}
    }
    this.rows=this.rows.slice(-maxSamples);
  }
  record(chainId,shadow){
    if(!Number.isSafeInteger(chainId)||chainId<1||!shadow||typeof shadow.status!=='string')
      throw Error('Invalid shadow metric');
    const r=compact(chainId,shadow,this.now());
    if(this.file){
      fs.appendFileSync(this.file,JSON.stringify(r)+'\n',{mode:0o600});
      // On-disk bound is best-effort; snapshots retain last maxSamples.
      if(fs.statSync(this.file).size>2*1024*1024){
        const tmp=this.file+'.tmp';
        fs.writeFileSync(tmp,[...this.rows.slice(-this.maxSamples+1),r]
          .map(x=>JSON.stringify(x)).join('\n')+'\n',{mode:0o600});
        fs.renameSync(tmp,this.file);
      }
    }
    this.rows.push(r);
    if(this.rows.length>this.maxSamples)this.rows.splice(0,this.rows.length-this.maxSamples);
    return r;
  }
  summary({chainId=null,lookbackMs=24*60*60*1000}={}){
    if(chainId!==null&&(!Number.isInteger(chainId)||chainId<1) ||
      !Number.isFinite(lookbackMs)||lookbackMs<60_000||lookbackMs>30*24*60*60*1000)
      throw Error('Invalid metrics request');
    const from=this.now()-lookbackMs;
    const rows=this.rows.filter(r=>(chainId===null||chainId===r.chainId)&&
      Date.parse(r.at)>=from&&Date.parse(r.at)<=this.now()+60_000);
    const attempts=rows.flatMap(r=>r.attempts);
    const requoted=attempts.filter(x=>['REQUOTE_ABOVE_THRESHOLD','REQUOTE_BELOW_THRESHOLD'].includes(x.status));
    const passed=requoted.filter(x=>x.status==='REQUOTE_ABOVE_THRESHOLD').length;
    const drops=requoted.map(x=>x.decayUSD).filter(validNumber).sort((a,b)=>a-b);
    const percentile=p=>drops.length?drops[Math.max(0,Math.ceil(p*drops.length)-1)]:null;
    return {mode:'SCAN_ONLY_SHADOW_METRICS',chainId,windowMs:lookbackMs,
      scans:rows.length,attempted:attempts.length,
      independentlyRequoted:requoted.length,aboveProfitThreshold:passed,
      belowThreshold:requoted.length-passed,
      retentionRate:requoted.length?passed/requoted.length:null,
      quoteDecayP10USD:percentile(0.10),quoteDecayP50USD:percentile(0.50),
      quoteDecayP90USD:percentile(0.90),
      failures:attempts.filter(x=>!['REQUOTE_ABOVE_THRESHOLD','REQUOTE_BELOW_THRESHOLD'].includes(x.status)).length,
      note:'Only previously detected indicative opportunities, sampled on later blocks. These are NOT actual transaction simulations or executable profits.',
      executable:false};
  }
}
