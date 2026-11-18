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
        const { cacheInventory, pruneManagedCache, prepareLibraryCache, cacheFiles, clearSelectedCache } = loaded.exports;
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
        const legacy=join(cache,'library-thumbnails');await fs.mkdir(legacy);
        const libraryThumb=join(legacy,`${id('9')}.jpg`);await fs.writeFile(libraryThumb,'downloaded thumbnail');
        await prepareLibraryCache(cache);
        const nested=join(cache,'library','thumbnails',`${id('9')}.jpg`);
        assert.equal(cacheFiles(cache).library.thumbnails,join(cache,'library','thumbnails'));
        assert.equal(await fs.readFile(nested,'utf8'),'downloaded thumbnail','Startup preserves existing cached thumbnails');
        await assert.rejects(fs.lstat(legacy),{code:'ENOENT'});
        assert.equal((await cacheInventory(cache)).thumbnails.files,2,'Nested Library thumbnails count toward cache size');
        await fs.utimes(nested,old,old);
        assert.equal((await pruneManagedCache(cache,90,Date.now(),new Set([id('1')]))).removed,1,'Nested Library assets follow retention');
        await fs.writeFile(nested,'new thumbnail');await fs.mkdir(legacy);await fs.writeFile(join(legacy,`${id('8')}.jpg`),'legacy');
        await prepareLibraryCache(cache);
        assert.equal(await fs.readFile(nested,'utf8'),'new thumbnail','Existing new location is never overwritten');
        const selection={catalogue:false,metadata:false,thumbnails:false,fingerprints:false,proxies:false};
        await clearSelectedCache(cache,selection);assert.ok(await fs.stat(nested),'Keeping thumbnails retains downloaded Library assets');
        const partial=nested+'.00000000-0000-0000-0000-000000000000.tmp';await fs.writeFile(partial,'partial Library thumbnail');
        await fs.writeFile(join(cache,'library','thumbnails','notes.txt'),'keep unknown file');
        await clearSelectedCache(cache,{...selection,thumbnails:true});
        for(const path of [nested,partial,newThumb,join(legacy,`${id('8')}.jpg`)])await assert.rejects(fs.lstat(path),{code:'ENOENT'});
        assert.equal(await fs.readFile(join(cache,'library','thumbnails','notes.txt'),'utf8'),'keep unknown file');
        console.log('PASS: Cache inventory and 90-day retention preserve active, recent, corrupt, unknown, and symlink files.');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
