// App-owned Cache inventory and retention, using temporary synthetic files only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'owmo-cache-files-')));
    try {
        const entry = join(root, 'fixture.ts');
        await fs.writeFile(entry, `export * from ${JSON.stringify(resolve('server/cacheFiles.ts'))};`);
        const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: {
            ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'cjs' } }
        } });
        const loaded = new (require('node:module'))(__filename, module);
        loaded.paths = module.paths;
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { cacheInventory, pruneManagedCache } = loaded.exports;
        const cache = join(root, 'Shot Manager Cache');
        for (const name of ['thumbnails', 'fingerprints', 'proxies']) await fs.mkdir(join(cache, name), { recursive: true });
        const id = letter => letter.repeat(64);
        const metadata = join(cache, 'metadata.json');
        const staleMetadataTemp = join(cache, 'metadata.json.00000000-0000-0000-0000-000000000000.tmp');
        const oldThumb = join(cache, 'thumbnails', `${id('a')}.jpg`);
        const newThumb = join(cache, 'thumbnails', `${id('b')}.jpg`);
        const validFingerprint = join(cache, 'fingerprints', `${id('c')}.json`);
        const corruptFingerprint = join(cache, 'fingerprints', `${id('d')}.json`);
        const oldProxy = join(cache, 'proxies', `${id('e')}.proxy.mov`);
        const activeProxy = join(cache, 'proxies', `${id('1')}.proxy.mov`);
        const legacyProxy = join(cache, `${id('2')}.proxy.mov`);
        const link = join(cache, 'proxies', `${id('f')}.proxy.mov`);
        await Promise.all([
            fs.writeFile(metadata, '{}'), fs.writeFile(staleMetadataTemp, 'old'), fs.writeFile(oldThumb, 'old'), fs.writeFile(newThumb, 'new'),
            fs.writeFile(validFingerprint, JSON.stringify({ version: 2, fileVersion: 'dummy', fingerprint: {
                scheme: 'sampled-sha256-v2', algorithm: 'sha256', value: id('c'), fileSize: 10,
                sampleBytes: 262144, sampledBytes: 10,
            } })),
            fs.writeFile(corruptFingerprint, '{broken'), fs.writeFile(oldProxy, 'proxy'), fs.writeFile(activeProxy, 'active'), fs.writeFile(legacyProxy, 'legacy'),
            fs.writeFile(join(cache, 'other.txt'), 'leave alone'),
        ]);
        await fs.symlink(oldProxy, link);
        const old = new Date(Date.now() - 91 * 86400000);
        for (const path of [metadata, staleMetadataTemp, oldThumb, validFingerprint, corruptFingerprint, oldProxy, activeProxy, legacyProxy]) await fs.utimes(path, old, old);
        const before = await cacheInventory(cache);
        assert.deepEqual([before.metadata.files, before.thumbnails.files, before.fingerprints.files, before.proxies.files, before.total.files], [2, 2, 2, 3, 9]);
        assert.equal(before.total.bytes, before.metadata.bytes + before.thumbnails.bytes + before.fingerprints.bytes + before.proxies.bytes);
        const result = await pruneManagedCache(cache, 90, Date.now(), new Set([id('1')]));
        assert.deepEqual(result, { removed: 5, failed: 0 });
        for (const path of [staleMetadataTemp, oldThumb, validFingerprint, oldProxy, legacyProxy]) await assert.rejects(fs.lstat(path), { code: 'ENOENT' });
        for (const path of [metadata, newThumb, corruptFingerprint, activeProxy, link, join(cache, 'other.txt')]) await fs.lstat(path);
        assert.equal((await cacheInventory(cache)).total.files, 4, 'Inventory ignores symlinks and unknown files');
        console.log('PASS: Cache inventory and 90-day retention preserve active, recent, corrupt, unknown, and symlink files.');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
