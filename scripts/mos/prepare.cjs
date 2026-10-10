'use strict';
// Generates disposable test-VM credentials locally. Never prints passwords.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execute } = require('./guest.cjs');

async function prepare() {
  const root = path.resolve(__dirname, '../../.mos-testbed');
  fs.mkdirSync(root, { recursive: true });
  const credentialsPath = path.join(root, 'credentials.json');
  let credentials;
  if (fs.existsSync(credentialsPath)) credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  else {
    credentials = { user: 'mosqa', password: crypto.randomBytes(18).toString('base64url'), purpose: 'Local MOS test VM only' };
    fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
  }
  if (credentials.user !== 'mosqa' || !/^[A-Za-z0-9_-]{24}$/.test(credentials.password)) throw new Error('Invalid test credentials.');
  const result = await execute(`printf '%s' '${credentials.password}' | openssl passwd -6 -stdin\n`);
  if (result.exitCode !== 0 || !/^\$6\$[./A-Za-z0-9]+\$[./A-Za-z0-9]+\s*$/.test(result.stdout)) throw new Error('Guest password hashing failed.');
  const template = fs.readFileSync(path.join(__dirname, 'anaconda.ks'), 'utf8');
  if (!template.includes('__MOS_QA_PASSWORD_HASH__')) throw new Error('Kickstart template is missing its password placeholder.');
  fs.writeFileSync(path.join(root, 'anaconda.ks'), template.replaceAll('__MOS_QA_PASSWORD_HASH__', result.stdout.trim()));
  console.log('Kickstart prepared. Test VM credentials saved in .mos-testbed/credentials.json (ignored by Git).');
}
prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
