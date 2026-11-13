// Signer loading. The hot key is the contract OPERATOR only: it cannot withdraw funds, change limits or unpause.
// Preferred: encrypted JSON keystore + password delivered by systemd LoadCredential (never in env or dashboard).
import fs from 'node:fs';
import path from 'node:path';

function assertPrivateFile(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw Error(`${file} is not a regular file`);
  if ((st.mode & 0o077) !== 0) throw Error(`${file} must not be readable by group/others (chmod 600)`);
}

function credentialPath(name) {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  return dir ? path.join(dir, name) : null;
}

/** Returns {address, signTransaction(tx) => {raw, hash}} or null when no key is configured. */
export async function loadSigner(env = process.env) {
  let make = null;
  const keystore = env.EXECUTOR_KEYSTORE;
  if (keystore) {
    assertPrivateFile(keystore);
    const pwFile = env.EXECUTOR_KEYSTORE_PASSWORD_FILE || credentialPath('keystore-password');
    if (!pwFile || !fs.existsSync(pwFile)) throw Error('keystore password file not found (use systemd LoadCredential=keystore-password:...)');
    if (!env.CREDENTIALS_DIRECTORY || !pwFile.startsWith(env.CREDENTIALS_DIRECTORY)) assertPrivateFile(pwFile);
    const password = fs.readFileSync(pwFile, 'utf8').replace(/\r?\n$/, '');
    const json = fs.readFileSync(keystore, 'utf8');
    make = (W) => W.fromEncryptedJson(json, password);
  } else if (env.EXECUTOR_KEY_FILE) {
    assertPrivateFile(env.EXECUTOR_KEY_FILE);
    const key = fs.readFileSync(env.EXECUTOR_KEY_FILE, 'utf8').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw Error('key file must contain a 0x-prefixed 32-byte hex key');
    make = (W) => new W(key);
  } else if (env.EXECUTOR_PRIVATE_KEY) {
    if (env.ALLOW_ENV_PRIVATE_KEY !== 'true') throw Error('EXECUTOR_PRIVATE_KEY in environment is refused; use EXECUTOR_KEYSTORE');
    make = (W) => new W(env.EXECUTOR_PRIVATE_KEY);
  }
  if (!make) return null;
  const {Wallet, Transaction} = await import('ethers');
  const wallet = await make(Wallet);
  return {
    address: wallet.address,
    async signTransaction(tx) {
      const raw = await wallet.signTransaction(tx);
      return {raw, hash: Transaction.from(raw).hash};
    },
  };
}
