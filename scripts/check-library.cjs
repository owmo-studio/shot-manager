// Library boundary and scale checks. Only temporary local folders and generated entries.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');

(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(require('node:os').tmpdir(), 'owmo-library-')));
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, ['server/library.ts', 'shared/library.ts'].map(file => `export * from ${JSON.stringify(resolve(file))};`).join('\n'));
        const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: {
            ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'cjs' } },
        } });
        const loaded = new (require('node:module'))(__filename, module);
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { libraryAssetName, parseLibraryAssetName, indexLibraryEntries, listLibrary } = loaded.exports;
        const id = number => number.toString(16).padStart(64, '0');
        assert.equal(libraryAssetName(id(1), 'source', 'mp4'), `${id(1)}.source.mp4`);
        assert.deepEqual(parseLibraryAssetName(`${id(1)}.source.mp4`), { id: id(1), role: 'source', extension: 'mp4' });
        for (const name of [`${id(1)}.proxy.partial`, `${id(1)}.source.mp4.partial`, `.${id(1)}.source.mp4.abcd`,
            `${id(1)}.metadata.abcd.partial`, `${id(1)}.waveform.png`, `${id(10).toUpperCase()}.source.mp4`, '../escape']) {
            assert.equal(parseLibraryAssetName(name), null, name);
        }
        assert.throws(() => libraryAssetName('../escape', 'thumb', 'jpg'));
        assert.throws(() => libraryAssetName(id(1), '../escape', 'jpg'));

        const library = join(root, 'library'); await fs.mkdir(library);
        // Contents deliberately cannot be parsed as metadata/media; presence must only use filenames.
        for (const name of ['source.mp4', 'thumb.jpg', 'metadata.json', 'proxy.mov']) await fs.writeFile(join(library, `${id(1)}.${name}`), 'not media or JSON');
        await fs.writeFile(join(library, `${id(2)}.proxy.mov`), 'proxy only');
        await fs.writeFile(join(library, `${id(3)}.source.mp4`), 'ambiguous');
        await fs.writeFile(join(library, `${id(3)}.source.mov`), 'ambiguous');
        await fs.writeFile(join(library, `${id(3)}.thumb.jpg`), 'thumbnail');
        await fs.writeFile(join(library, `${id(3)}.metadata.json`), 'metadata');
        await fs.symlink(join(library, `${id(1)}.source.mp4`), join(library, `${id(4)}.source.mp4`));
        await fs.mkdir(join(library, `${id(4)}.thumb.png`));
        await fs.writeFile(join(library, `${id(5)}.metadata.json.partial`), 'unfinished');
        await fs.writeFile(join(library, `${id(6)}.waveform.png`), 'other tool');
        const listing = await listLibrary({ path: library, identity: 'fixture', mount: 'fixture' });
        assert.deepEqual([...listing.complete], [id(1)]);
        assert.deepEqual([...listing.existing].sort(), [id(1), id(3)]);
        assert.deepEqual([...listing.proxies].sort(), [id(1), id(2)]);
        assert.ok(listing.assets.get(id(4)).includes(`${id(4)}.thumb.png`), 'Non-files still flag role conflicts');
        assert.ok(!listing.existing.has(id(4)), 'Symlinks/directories cannot establish asset presence');
        assert.ok(!listing.assets.has(id(5)) && !listing.assets.has(id(6)), 'Unpublished and optional derived files stay out of the reserved-role index');
        await assert.rejects(listLibrary({ path: join(root, 'missing') }), { code: 'ENOENT' }, 'Unavailable is an error, never an empty Library');

        const count = 25000;
        let yielded = 0;
        async function* largeLibrary() {
            for (let number = 1; number <= count; number++) for (const role of ['source.mp4', 'thumb.jpg', 'metadata.json', 'proxy.mov']) {
                yielded++; yield { name: `${id(number)}.${role}`, isFile: () => true };
            }
        }
        const start = performance.now();
        const large = await indexLibraryEntries(largeLibrary());
        assert.equal(yielded, 100000, 'One streamed pass');
        assert.equal(large.complete.size, count);
        assert.equal(large.proxies.size, count);
        for (const number of [1, 10, 100, 1000, count]) assert.equal(large.assets.get(id(number)).length, 4);
        console.log(`PASS: streamed 100,000 asset entries for 25,000 clips in ${Math.round(performance.now() - start)} ms (in-memory fixture, not an SMB benchmark); strict names, regular-file presence, role conflicts, and unavailable-folder handling.`);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
