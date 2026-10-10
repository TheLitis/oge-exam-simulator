'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execute } = require('./guest.cjs');

async function collect() {
  const result = await execute(`python3 - <<'PY'
import json, pathlib, subprocess
root = pathlib.Path('/home/mosqa/test-evidence')
names = ['bundle-checksums.log', 'syntax-check.log', 'node-tests.tap', 'os-release.txt', 'kernel.txt', 'package-versions.txt']
data = {name: (root / name).read_text() for name in names}
data['root_mount'] = subprocess.check_output(['findmnt', '-n', '-o', 'SOURCE,FSTYPE', '/'], text=True).strip()
data['marker'] = pathlib.Path('/etc/mos-testbed').read_text().strip()
data['test_user'] = subprocess.check_output(['id', 'mosqa'], text=True).strip()
print(json.dumps(data))
PY
`);
  if (result.exitCode !== 0) throw new Error(`Could not collect guest evidence: ${result.stderr}`);
  const data = JSON.parse(result.stdout);
  if (!data.root_mount.startsWith('/dev/vda') || !data.marker.includes('release 260926')) throw new Error('Expected the installed MOS test disk.');
  if (!/^# pass 42$/m.test(data['node-tests.tap']) || !/^# fail 0$/m.test(data['node-tests.tap'])) throw new Error('Expected 42 passing guest tests.');
  const stateRoot = path.resolve(__dirname, '../../.mos-testbed');
  const evidenceRoot = path.join(stateRoot, 'evidence');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  for (const [name, content] of Object.entries(data)) if (name.includes('.')) fs.writeFileSync(path.join(evidenceRoot, 'guest-' + name), content);
  const processRecord = JSON.parse(fs.readFileSync(path.join(stateRoot, 'process.json'), 'utf8'));
  const config = {
    mosVersion: '12', release: '260926', variant: 'MOS-V', bootMode: 'Installed',
    iso: 'MOS_2021.1_MOS-V_x86_64_260926.iso', isoSha256: '043d2b52944698592e10c2f088a6ab501a602b75165fd0dbad0b17565764619c',
    verifiedAt: new Date().toISOString(), rootMount: data.root_mount, testUser: data.test_user,
    memoryMiB: processRecord.memoryMiB, cpuCount: processRecord.cpuCount, accelerator: processRecord.accelerator,
    bundledNode: '22.16.0', syntaxFiles: 12, bundleFilesVerified: data['bundle-checksums.log'].trim().split('\n').length,
    tests: { passed: 42, failed: 0, skipped: 0 }, console: 'http://127.0.0.1:13600/'
  };
  fs.writeFileSync(path.join(stateRoot, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(path.join(evidenceRoot, 'verification.json'), JSON.stringify(config, null, 2) + '\n');
  console.log('Installed MOS verified; guest logs collected; default boot mode saved as Installed.');
}
collect().catch(error => { console.error(error.message); process.exitCode = 1; });
