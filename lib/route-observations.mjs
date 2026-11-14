// Bounded read-only multihop results, independent of execution journal and dashboard top-100.
import fs from 'node:fs';
import path from 'node:path';

const MAX_HISTORY = 50000;
const MAX_CANDIDATES = 500;
const MAX_PAGE = 200;
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const score = (c) => Number.isFinite(c.netEstimate) ? c.netEstimate : -Infinity;

function bounded(input, fallback, low, high, label) {
  if (input == null || input === '') return fallback;
  const n = Number(input);
  if (!Number.isSafeInteger(n) || n < low || n > high) throw Error('Invalid ' + label);
  return n;
}
function options(q = {}) {
  const chainId = q.chainId == null || q.chainId === '' ? null : bounded(q.chainId,null,1,999999999,'chainId');
  const limit = bounded(q.limit,50,1,MAX_PAGE,'limit');
  const offset = bounded(q.offset,0,0,10000,'offset');
  const minHops = bounded(q.minHops,3,3,10,'minHops');
  const maxHops = bounded(q.maxHops,10,3,10,'maxHops');
  const maxImpactBps = q.maxImpactBps == null || q.maxImpactBps === '' ? null : bounded(q.maxImpactBps,null,0,10000,'maxImpactBps');
  if (minHops > maxHops) throw Error('minHops cannot exceed maxHops');
  if (q.positiveOnly != null && !['true','false',''].includes(q.positiveOnly)) throw Error('Invalid positiveOnly');
  return {chainId,limit,offset,minHops,maxHops,maxImpactBps,positiveOnly:q.positiveOnly === 'true'};
}
function summarize(item,cycles,threshold) {
  return {
    chainId:item.chainId,network:item.network,at:item.at,block:item.block,
    mode:'SCAN_ONLY_OBSERVATION',quotes:item.quotes,cycles:cycles.length,
    profitableQuotes:cycles.filter(c=>score(c)>0).length,
    aboveMinProfitQuotes:cycles.filter(c=>score(c)>=threshold).length,
    executable:cycles.filter(c=>c.executable===true).length,
    bestNetEstimate:cycles.length?score(cycles[0]):null,
    truncated:item.truncated,error:item.error,
    missingProvider:cycles.filter(c=>!c.provider).length,
    unvalidatedVenues:cycles.filter(c=>(c.blockers||[]).includes('venue not fork-validated')).length
  };
}
export class RouteObservations {
  constructor(file=null,{maxHistory=MAX_HISTORY}={}) {
    this.file=file;this.maxHistory=maxHistory;this.latest=new Map();this.history=[];
    if (!file) return;
    fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true,mode:0o700});
    if (!fs.existsSync(file)) return;
    const size=fs.statSync(file).size;
    const fd=fs.openSync(file,'r');let raw;
    try {
      const n=Math.min(size,MAX_LOG_BYTES),b=Buffer.alloc(n);
      fs.readSync(fd,b,0,n,size-n);raw=b.toString('utf8');
    } finally {fs.closeSync(fd);}
    if(size>MAX_LOG_BYTES) raw=raw.slice(raw.indexOf('\n')+1);
    for(const line of raw.split('\n')) try{
      const e=JSON.parse(line);
      if(e?.schema===1 && Number.isInteger(e.chainId) && typeof e.at==='string') this.history.push(e);
    }catch{/* tolerate truncated final line */}
    this.history=this.history.slice(-this.maxHistory);
  }
  record(net,state,candidates,{minimumProfit=0,at=new Date().toISOString()}={}) {
    const cycles=(Array.isArray(candidates)?candidates:[])
      .filter(c=>Number.isInteger(c.hopCount)&&c.hopCount>=3&&c.hopCount<=10)
      .sort((a,b)=>score(b)-score(a)).slice(0,MAX_CANDIDATES);
    const item={chainId:net.id,network:net.name,at,block:state?.block??null,
      quotes:state?.multiHopQuotes||0,truncated:!!state?.multiHopTruncated,
      error:state?.multiHopError||state?.error||null,cycles};
    const stat=summarize(item,cycles,Number.isFinite(minimumProfit)?minimumProfit:0);
    const entry={schema:1,...stat};
    if(this.file){
      fs.appendFileSync(this.file,JSON.stringify(entry)+'\n',{mode:0o600});
      if(fs.statSync(this.file).size>MAX_LOG_BYTES){
        fs.renameSync(this.file,this.file+'.1');
        fs.writeFileSync(this.file,'',{mode:0o600});
      }
    }
    this.history.push(entry);
    if(this.history.length>this.maxHistory) this.history.splice(0,this.history.length-this.maxHistory);
    this.latest.set(net.id,{...item,stat});
    return stat;
  }
  stats(){
    const now=Date.now(), since=now-72*60*60*1000;
    const rolling=new Map();
    for(const record of this.history){
      const time=Date.parse(record.at);
      if(!Number.isFinite(time)||time<since||time>now+60_000) continue;
      const current=rolling.get(record.chainId)||{
        chainId:record.chainId,network:record.network,scans:0,quotes:0,cycles:0,
        profitableIndicativeQuotes:0,aboveMinProfitIndicativeQuotes:0,
        truncatedScans:0,errorScans:0
      };
      current.scans++;
      current.quotes+=record.quotes||0;
      current.cycles+=record.cycles||0;
      current.profitableIndicativeQuotes+=record.profitableQuotes||0;
      current.aboveMinProfitIndicativeQuotes+=record.aboveMinProfitQuotes||0;
      if(record.truncated) current.truncatedScans++;
      if(record.error) current.errorScans++;
      rolling.set(record.chainId,current);
    }
    return {mode:'SCAN_ONLY_OBSERVATION',networks:[...this.latest.values()].map(x=>x.stat),
      historySamples:this.history.length,rolling72h:[...rolling.values()]};
  }
  cycles(query={}){
    const o=options(query),records=[...this.latest.values()].filter(x=>o.chainId===null||x.chainId===o.chainId);
    const items=records.flatMap(x=>x.cycles)
      .filter(c=>c.hopCount>=o.minHops&&c.hopCount<=o.maxHops&&(!o.positiveOnly||score(c)>0))
      // Impact filtering is deliberately fail-closed: NOT_PROBED and partial
      // diagnostics do not count as sufficiently liquid.
      .filter(c=>o.maxImpactBps===null || (c.diagnostics?.probesIncomplete===false &&
        c.diagnostics?.maximumImpactBps!==null && Number.isFinite(c.diagnostics?.maximumImpactBps) &&
        c.diagnostics.maximumImpactBps<=o.maxImpactBps))
      .sort((a,b)=>score(b)-score(a));
    return {mode:'SCAN_ONLY_OBSERVATION',total:items.length,limit:o.limit,offset:o.offset,
      latestByNetwork:records.map(x=>({chainId:x.chainId,network:x.network,at:x.at,block:x.block,truncated:x.truncated})),
      cycles:items.slice(o.offset,o.offset+o.limit)};
  }
  scans(query={}){
    const o=options(query);
    const items=this.history.filter(e=>o.chainId===null||e.chainId===o.chainId);
    return {mode:'SCAN_ONLY_OBSERVATION',total:items.length,limit:o.limit,offset:o.offset,
      scans:items.slice().reverse().slice(o.offset,o.offset+o.limit)};
  }
}
