import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const pin = JSON.parse(readFileSync(new URL('../dependencies/sipbridge-contract.json', import.meta.url), 'utf8'));
for (const { path, sha256 } of Object.values(pin.files)) {
    if (
        createHash('sha256')
            .update(readFileSync(new URL('../' + path, import.meta.url)))
            .digest('hex') !== sha256
    )
        throw new Error('Canonical SIP contract drift: ' + path);
}
console.log('Pinned canonical SIP schema and generated JSON contracts verified');
