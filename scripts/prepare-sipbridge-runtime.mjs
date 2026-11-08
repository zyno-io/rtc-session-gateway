import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const runtime = JSON.parse(readFileSync(new URL('../dependencies/sipbridge-runtime.json', import.meta.url), 'utf8'));
export function prepareNativeRuntime() {
    if (!/^gcr\.s24\.dev\/signal24\/oss\/sipbridge:[a-f0-9]{40}@sha256:[a-f0-9]{64}$/.test(runtime.image))
        throw new Error('Native runtime requires an immutable canonical image');
    const contract = JSON.parse(readFileSync(new URL('../dependencies/sipbridge-contract.json', import.meta.url), 'utf8'));
    if (contract.schema_sha256 !== runtime.schema_sha256) throw new Error('Native runtime/schema pin mismatch');
    execFileSync('docker', ['pull', runtime.image], { stdio: 'inherit' });
    const revision = execFileSync(
        'docker',
        ['image', 'inspect', runtime.image, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}'],
        { encoding: 'utf8' }
    ).trim();
    if (revision !== runtime.revision) throw new Error('Published native runtime revision mismatch');
    const directory = mkdtempSync(join(tmpdir(), 'rtc-pinned-native-'));
    let container;
    try {
        container = execFileSync('docker', ['create', runtime.image], { encoding: 'utf8' }).trim();
        execFileSync('docker', ['cp', container + ':/sipbridge', join(directory, 'sipbridge')]);
        execFileSync('docker', ['cp', container + ':/usr/share/sipbridge/control-schema.json', join(directory, 'control-schema.json')]);
        const receipt = JSON.parse(readFileSync(join(directory, 'control-schema.json'), 'utf8'));
        if (
            receipt.schema_sha256 !== runtime.schema_sha256 ||
            receipt.generated_ts_sha256 !== contract.generated_ts_sha256 ||
            receipt.generated_json_validation_sha256 !== contract.generated_json_validation_sha256
        )
            throw new Error('Published native runtime contract mismatch');
        return {
            binary: join(directory, 'sipbridge'),
            image: runtime.image,
            close: () => rmSync(directory, { recursive: true, force: true })
        };
    } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
    } finally {
        if (container) execFileSync('docker', ['rm', container], { stdio: 'ignore' });
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const fixture = prepareNativeRuntime();
    try {
        console.log('Pinned native runtime and canonical schema verified: ' + fixture.image);
    } finally {
        fixture.close();
    }
}
