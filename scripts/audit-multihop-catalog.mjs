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
  const audit=await verifyCatalogIdentities({chain,net,edges,block,
   maxContracts:80,maxTokens:40,maxQuotes:12});
  const registryVenueMatch=catalogHasTrustedVenues(net,edges);
  const found={chainId:net.id,network:net.name,edgeCount:edges.length,
   ...audit,registryVenueMatch,
   passed:audit.passed&&registryVenueMatch,
   status:!registryVenueMatch?'UNREVIEWED_VENUE':audit.status};
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
