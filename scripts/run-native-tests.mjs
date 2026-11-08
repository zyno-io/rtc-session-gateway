import { spawnSync } from 'node:child_process';
import { prepareNativeRuntime } from './prepare-sipbridge-runtime.mjs';
const fixture = prepareNativeRuntime();
try {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/sipbridge-native.test.ts'], {
        stdio: 'inherit',
        env: { ...process.env, SIPBRIDGE_TEST_BINARY: fixture.binary }
    });
    process.exitCode = child.status ?? 1;
} finally {
    fixture.close();
}
