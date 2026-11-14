#!/usr/bin/env node
// Independent read-only deployed-executor eth_call preflight.
// This file has no signer, transaction construction for broadcast, or writes
// to trade configuration. A passing eth_call is NOT realized net profit.
import fs from 'node:fs';
import path from 'node:path';
import {NETWORKS,withEnvProviders} from '../lib/networks.mjs';
import {makeChain} from '../lib/chain-ethers.mjs';
import {loadSettings} from '../lib/settings.mjs';
import {auditAtomicOpportunity} from '../lib/atomic-preflight.mjs';
if(process.env.LIVE_EXECUTION==='true'||
 process.env.MULTIHOP_EXECUTION_ENABLED==='true')
 throw Error('Read-only audit requires LIVE_EXECUTION=false and MULTIHOP_EXECUTION_ENABLED=false');
const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);
 return i<0?fallback:process.argv[i+1];};
const source=arg('candidates','validation/latest-opportunities.json');
const output=arg('output','validation/atomic-read-only-audit.json');
const limit=Number(arg('limit','3'));
if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('Invalid limit');
const doc=JSON.parse(fs.readFileSync(source,'utf8'));
const all=Array.isArray(doc)?doc:Array.isArray(doc.opportunities)?doc.opportunities:[];
if(!all.length)throw Error('No observed candidates to audit');
let persistedSettings=null;
try{persistedSettings=JSON.parse(fs.readFileSync(process.env.CONFIG_PATH||
 '/var/lib/nexora/settings.json','utf8'));}catch{}
const settings=loadSettings(persistedSettings);
const nets=NETWORKS.map(n=>withEnvProviders(n,process.env));
const result={mode:'ATOMIC_ETH_CALL_ONLY',createdAt:new Date().toISOString(),
 checks:[],executable:false,
 note:'Read-only eth_call and gas estimate on a deployed authorized executor; never signs or submits. No guaranteed inclusion or realized profits.'};
const chains=new Map();
try{
 for(const c of all.filter(c=>c?.netEstimate>=settings.minProfitUSD)
  .sort((a,b)=>b.netEstimate-a.netEstimate).slice(0,limit)){
  const net=nets.find(n=>n.id===c.chainId);
  if(!net){result.checks.push({status:'UNVERIFIED',reason:'UNKNOWN_CHAIN',executable:false});continue;}
  const executorAddress=process.env['EXECUTOR_'+net.id];
  const operatorAddress=process.env.OPERATOR_ADDRESS;
  if(!executorAddress||!operatorAddress){
   result.checks.push({chainId:net.id,status:'UNVERIFIED',
     reason:'DEPLOYED_EXECUTOR_OR_OPERATOR_REQUIRED',executable:false});
   continue;
  }
  if(!chains.has(net.id))chains.set(net.id,makeChain(net,
   process.env['RPC_'+net.id]||net.rpcDefault,{timeoutMs:12000}));
  const check=await auditAtomicOpportunity({chain:chains.get(net.id),
   net,candidate:c,settings,executorAddress,operatorAddress});
  result.checks.push(check);
 }
}finally{for(const chain of chains.values())chain.destroy();}
result.passed=result.checks.filter(c=>c.passed).length;
result.unverified=result.checks.length-result.passed;
fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({report:output,checks:result.checks.length,
 passed:result.passed,unverified:result.unverified,executable:false}));
if(result.unverified)process.exitCode=1;
