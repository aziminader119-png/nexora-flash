import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const script=fs.readFileSync(new URL('../scripts/install-scan-only-update.sh',import.meta.url),'utf8');
test('one-shot installer is explicit source-pin and never changes live trading configuration',()=>{
 assert.match(script,/EXPECTED_COMMIT/);
 assert.match(script,/git rev-parse HEAD/);
 assert.match(script,/LIVE_EXECUTION=false/);
 assert.match(script,/MULTIHOP_EXECUTION_ENABLED=false/);
 assert.match(script,/s\.autoExecute!==false/);
 assert.match(script,/s\.liveChains\.length!==0/);
 assert.match(script,/\.mode=="SCAN_ONLY"/);
 assert.doesNotMatch(script,/(?:\bapt(?:-get)?\b|\bnpm install\b|\bterraform\b|\bchmod.*777\b)/);
});
test('one-shot installer backs up service before replacement and has rollback trap',()=>{
 assert.match(script,/cp -a "\$\{DEST\}\/lib" "\$\{DEST\}\/server\.js" "\$\{BACKUP\}\/"/);
 assert.match(script,/trap rollback ERR/);
 assert.match(script,/UPDATE FAILED: restoring original backend/);
 assert.match(script,/systemctl stop/);
 assert.match(script,/systemctl start/);
 assert.match(script,/systemctl is-active --quiet/);
 assert.doesNotMatch(script,/\/opt\/nexora\/public/);
});
