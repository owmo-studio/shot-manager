// Storage retry policy checks. Only synthetic failures and timers are used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');

(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(require('node:os').tmpdir(), 'owmo-storage-recovery-')));
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, `export * from ${JSON.stringify(resolve('server/storageRecovery.ts'))};\n`);
        const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: {
            ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'cjs' } },
        }});
        const loaded = new (require('node:module'))(__filename, module);
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { DEFAULT_STORAGE_WAIT_SECONDS, storageWaitSeconds, withStorageRecovery } = loaded.exports;
        assert.equal(DEFAULT_STORAGE_WAIT_SECONDS, 10);
        assert.equal(storageWaitSeconds(undefined), 10);
        assert.equal(storageWaitSeconds(0), 0);
        assert.equal(storageWaitSeconds(120), 120);
        assert.throws(() => storageWaitSeconds(-1), /whole number/);
        assert.throws(() => storageWaitSeconds(1.5), /whole number/);

        let attempts = 0, active = 0, maximumActive = 0;
        const retries = [];
        const value = await withStorageRecovery(async () => {
            active++; maximumActive = Math.max(maximumActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
            attempts++;
            if (attempts < 3) throw Object.assign(new Error('temporary SMB response'), { code: 'ETIMEDOUT' });
            return 'ready';
        }, 2, undefined, info => retries.push(info));
        assert.equal(value, 'ready');
        assert.equal(attempts, 3);
        assert.equal(maximumActive, 1, 'storage checks never overlap');
        assert.equal(retries.length, 2);
        assert.equal(retries[0].code, 'ETIMEDOUT');

        let denied = 0;
        await assert.rejects(withStorageRecovery(async () => {
            denied++;
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }, 1), /permission denied/);
        assert.equal(denied, 1, 'permission failures are not retried');
        let wrappedDenied = 0;
        await assert.rejects(withStorageRecovery(async () => {
            wrappedDenied++;
            throw new Error('storage unavailable', { cause: Object.assign(new Error('permission denied'), { code: 'EACCES' }) });
        }, 1), /storage unavailable/);
        assert.equal(wrappedDenied, 1, 'wrapped permission failures are not retried');

        let changed = 0;
        await assert.rejects(withStorageRecovery(async () => {
            changed++;
            throw new Error('The Library folder or mounted volume changed.');
        }, 1), /mounted volume changed/);
        assert.equal(changed, 1, 'review mismatches are not retried');

        const controller = new AbortController();
        let abortedAttempts = 0;
        const waiting = withStorageRecovery(async () => {
            abortedAttempts++;
            throw Object.assign(new Error('temporary SMB response'), { code: 'EIO' });
        }, 10, controller.signal);
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(waiting);
        assert.equal(abortedAttempts, 1, 'Stop aborts the recovery delay');
        console.log('PASS: storage wait validation, sequential transient retries, no permission/review retries, and cancellation.');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
