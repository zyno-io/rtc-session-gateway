import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const pin = JSON.parse(readFileSync(new URL('../dependencies/sipbridge-contract.json', import.meta.url), 'utf8'));
const runtime = JSON.parse(readFileSync(new URL('../dependencies/sipbridge-runtime.json', import.meta.url), 'utf8'));
if (pin.repository !== runtime.repository || pin.sipbridgeRevision !== runtime.revision || pin.schema_sha256 !== runtime.schema_sha256)
    throw new Error('SIP contract must match the pinned sipbridge distribution');
for (const { path, sha256 } of Object.values(pin.files)) {
    if (
        createHash('sha256')
            .update(readFileSync(new URL('../' + path, import.meta.url)))
            .digest('hex') !== sha256
    )
        throw new Error('Canonical SIP contract drift: ' + path);
}
console.log('Pinned canonical SIP schema and generated JSON contracts verified');
