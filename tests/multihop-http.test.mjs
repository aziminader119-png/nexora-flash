import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
import {DEFAULT_SETTINGS} from '../lib/settings.mjs';

async function availablePort(){
 const s=net.createServer();
 await new Promise((resolve,reject)=>s.once('error',reject).listen(0,'127.0.0.1',resolve));
 const port=s.address().port;
 await new Promise(resolve=>s.close(resolve));
 return port;
}

test('read-only multihop endpoints start under SCAN_ONLY, reject malformed requests and preserve legacy API', {timeout:15000}, async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'nexora-api-'));
 const config=path.join(home,'settings.json');
 fs.writeFileSync(config,JSON.stringify({...DEFAULT_SETTINGS,paused:true}),{mode:0o600});
 const port=await availablePort();
 const server=spawn(process.execPath,[new URL('../server.js',import.meta.url).pathname],{
  cwd:new URL('..',import.meta.url).pathname,
  env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',DATA_DIR:home,CONFIG_PATH:config,
    LIVE_EXECUTION:'false',MULTIHOP_EXECUTION_ENABLED:'false',ADMIN_TOKEN:'testtoken'.repeat(8),
    GATE_REPORT:path.join(home,'missing-report.json')},
  stdio:['ignore','pipe','pipe']
 });
 let errors='';
 server.stderr.on('data',chunk=>{errors+=String(chunk).slice(0,500)});
 const base=`http://127.0.0.1:${port}`;
 try {
  let ready=false;
  for(let i=0;i<60;i++){
    if(server.exitCode!==null) throw Error('server exited: '+errors);
    try{const r=await fetch(base+'/api/health');if(r.ok){ready=true;break}}catch{}
    await pause(100);
  }
  assert.ok(ready,'server did not start: '+errors);
  const status=await (await fetch(base+'/api/status')).json();
  assert.equal(status.mode,'SCAN_ONLY');
  assert.equal(status.liveExecutionEnabled,false);
  assert.equal(status.longRouteExecutionOptIn,false);
  assert.equal(status.signer,null);
  assert.ok(Array.isArray(status.opportunities));
  const stats=await (await fetch(base+'/api/multihop/stats')).json();
  assert.equal(stats.mode,'SCAN_ONLY_OBSERVATION');
  assert.deepEqual(stats.networks,[]);
  assert.deepEqual(stats.rolling72h,[]);
  const cycles=await (await fetch(base+'/api/multihop/cycles?chainId=8453&limit=25')).json();
  assert.equal(cycles.total,0);
  assert.deepEqual(cycles.cycles,[]);
  const history=await (await fetch(base+'/api/multihop/history')).json();
  assert.equal(history.total,0);
  const invalid=await fetch(base+'/api/multihop/cycles?limit=100000');
  assert.equal(invalid.status,400);
  const post=await fetch(base+'/api/multihop/cycles',{method:'POST'});
  assert.equal(post.status,403,'POST endpoints need admin token');
 } finally {
  server.kill('SIGTERM');
  await Promise.race([new Promise(resolve=>server.once('exit',resolve)),pause(2500)]);
  if(server.exitCode===null) server.kill('SIGKILL');
  fs.rmSync(home,{recursive:true,force:true});
 }
});
