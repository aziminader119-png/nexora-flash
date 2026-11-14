#!/usr/bin/env node
// Read-only pinned-block catalog audit. No signer, keys, broadcast or approval.
// Run on a machine with configured RPCs; outputs independent evidence by network.
import fs from 'node:fs';
import path from 'node:path';
import {NETWORKS,withEnvProviders} from '../lib/networks.mjs';
import {makeChain} from '../lib/chain-ethers.mjs';
import {loadMultiHopCatalog,catalogHasTrustedVenues} from '../lib/multihop-catalog.mjs';
import {verifyCatalogIdentities} from '../lib/catalog-preflight.mjs';
const env=process.env;
const catalogPath=env.MULTIHOP_CATALOG_FILE;
if(!catalogPath||!fs.existsSync(catalogPath)){
 console.error('MULTIHOP_CATALOG_FILE must point to an existing reviewed catalog');
 process.exit(2);
}
const nets=NETWORKS.map(n=>withEnvProviders(n,env));
const catalog=loadMultiHopCatalog(catalogPath,nets,()=>{});
if(!catalog.size){console.error('No validated catalog chain entries');process.exit(2);}
const result={schema:1,mode:'SCAN_ONLY_CATALOG_PREFLIGHT',createdAt:new Date().toISOString(),
 networks:[],passed:0,failed:0,executable:false,
 note:'Router code, token decimals and sample quote validation alone are not factory/protocol proofs, fork transaction simulations, or trading approvals.'};
for(const net of nets){
 const edges=catalog.get(net.id);
 if(!edges)continue;
 const chain=makeChain(net,env['RPC_'+net.id]||net.rpcDefault,{timeoutMs:9000});
 try {
  const block=await chain.blockNumber();
  // Verify EVERY edge in bounded chunks, pinned to the same block.
  // Quoting only the first 12 edges would silently omit large catalogs.
  const CHUNK_SIZE=12;
  const chunks=[];
  for(let start=0;start<edges.length;start+=CHUNK_SIZE){
    const check=await verifyCatalogIdentities({chain,net,
      edges:edges.slice(start,start+CHUNK_SIZE),block,
      maxContracts:80,maxTokens:40,maxQuotes:CHUNK_SIZE});
    chunks.push({start,end:Math.min(edges.length,start+CHUNK_SIZE),
      passed:check.passed,status:check.status,quoteChecks:check.quoteChecks,
      failures:check.failures.map(f=>f.edge===undefined?f:{...f,edge:f.edge+start})});
  }
  const auditPassed=chunks.length>0&&chunks.every(x=>x.passed);
  const registryVenueMatch=catalogHasTrustedVenues(net,edges);
  const found={chainId:net.id,network:net.name,edgeCount:edges.length,
    block,chunks,quoteChecks:chunks.reduce((n,c)=>n+c.quoteChecks,0),
    registryVenueMatch,passed:auditPassed&&registryVenueMatch,
    status:!registryVenueMatch?'UNREVIEWED_VENUE':auditPassed?
       'QUOTE_PREFLIGHT_PASSED':'REJECTED',
    failures:chunks.flatMap(c=>c.failures),executable:false};
  result.networks.push(found);
  if(found.passed)result.passed++;else result.failed++;
 }catch(e){
  result.failed++;
  result.networks.push({chainId:net.id,network:net.name,
   status:'REJECTED',passed:false,reason:String(e.message||e).slice(0,160),executable:false});
 }finally{chain.destroy();}
}
const filename=env.CATALOG_PREFLIGHT_REPORT || path.join('validation','catalog-preflight.json');
fs.mkdirSync(path.dirname(path.resolve(filename)),{recursive:true});
fs.writeFileSync(filename,JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({report:filename,chains:result.networks.length,
 passed:result.passed,failed:result.failed,executable:false}));
process.exitCode=result.failed?1:0;
