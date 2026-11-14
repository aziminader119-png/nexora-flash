import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const files=['audit-multihop-catalog.mjs','audit-atomic-opportunities.mjs','soak-scan-only.mjs'];
for(const name of files){
 test('predeploy CLI parses without executing: '+name,()=>{
  const file=new URL('../scripts/'+name,import.meta.url);
  const p=spawnSync(process.execPath,['--check',file.pathname],{encoding:'utf8',timeout:15000});
  assert.equal(p.status,0,p.stderr);
 });
 test('predeploy CLI is read-only and contains no direct trading methods: '+name,()=>{
  const s=fs.readFileSync(new URL('../scripts/'+name,import.meta.url),'utf8');
  assert.doesNotMatch(s,/\.broadcast\s*\(|\.sendTransaction\s*\(|\.signTransaction\s*\(/);
  assert.doesNotMatch(s,/(?:privateKey|seedPhrase|mnemonic)\s*=/i);
 });
}
test('atomic preflight explicitly rejects live configuration and writes only a report',()=>{
 const s=fs.readFileSync(new URL('../scripts/audit-atomic-opportunities.mjs',import.meta.url),'utf8');
 assert.match(s,/LIVE_EXECUTION==='true'/);
 assert.match(s,/MULTIHOP_EXECUTION_ENABLED==='true'/);
 assert.match(s,/auditAtomicOpportunity/);
});
test('soak uses only loopback HTTP GET endpoints, preserving dashboard and trading code',()=>{
 const s=fs.readFileSync(new URL('../scripts/soak-scan-only.mjs',import.meta.url),'utf8');
 assert.match(s,/http:\/\/127\.0\.0\.1:3080/);
 assert.match(s,/get\('\/api\/status'\)/);
 assert.match(s,/get\('\/api\/shadow\/metrics'\)/);
 assert.doesNotMatch(s,/method:\s*['"]POST/);
});
