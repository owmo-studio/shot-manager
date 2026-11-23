// Only temporary directories; no real app configuration, sources, or NAS access.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');

(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(require('node:os').tmpdir(), 'shot-manager-health-')));
    try {
        const entry = join(root, 'fixture.ts');
        await fs.writeFile(entry, ['server/applicationStatus.ts', 'server/library.ts']
            .map(file => `export * from ${JSON.stringify(resolve(file))};`).join('\n'));
        const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: {
            ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'cjs' } }
        } });
        const loaded = new (require('node:module'))(__filename, module);
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { ApplicationMonitor, inspectLibrary } = loaded.exports;
        const library = join(root, 'library');
        await fs.mkdir(library);
        const lib = await inspectLibrary(library);
        let settings = { version: 1, libraryPath: null }, sources = [], workError, corrupt = false;
        const monitor = new ApplicationMonitor(async () => {
            if (corrupt) throw new Error('Unreadable configuration');
            return structuredClone(settings);
        }, () => sources, () => workError);
        const expect = async (level, message) => {
            const result = await monitor.status();
            assert.deepEqual({ level: result.level, message: result.message }, { level, message });
        };
        await expect('error', 'Library Not Configured');
        settings = { version: 1, libraryPath: library, libraryMount: lib.mount };
        await expect('ready', 'Ready');
        assert.equal((await inspectLibrary(library, [root])).path, library, 'Nested Library under source is allowed');
        assert.equal((await inspectLibrary(root, [library])).path, root, 'Parent Library above source is allowed');
        await assert.rejects(inspectLibrary(library, [library]), /different folders/);
        await fs.rename(library, library + '-offline');
        await expect('error', 'Library Unavailable');
        await assert.rejects(inspectLibrary(library), /configured Library folder is missing/);
        sources = [{ id: 'dummy', name: 'Card', path: join(root, 'card'), available: false, warning: 'Disconnected' }];
        await expect('error', 'Library Unavailable');
        sources = [];
        await expect('error', 'Library Unavailable');
        corrupt = true;
        await expect('error', 'Configuration Error');
        corrupt = false;
        await fs.rename(library + '-offline', library);
        await expect('ready', 'Ready');
        settings.libraryMount = 'wrong-volume';
        await expect('error', 'Library Unavailable');
        settings.libraryMount = lib.mount;
        workError = 'Encoding failed';
        await expect('warning', 'Proxy Unavailable');
        workError = undefined;
        await expect('ready', 'Ready');

        let release, reads = 0;
        const blocked = new Promise(resolve => { release = resolve; });
        const slow = new ApplicationMonitor(async () => { reads++; await blocked; return settings; }, () => [], () => undefined);
        // Keep the fixture alive while the monitor's unref'ed response deadline expires.
        const keepAlive = setTimeout(() => {}, 5000);
        try {
            assert.equal((await slow.status()).message, 'Locations Unverified');
            const second = slow.status(); release();
            assert.equal((await second).message, 'Ready');
            assert.equal(reads, 1, 'Slow checks share one filesystem operation rather than piling up');
        } finally { clearTimeout(keepAlive); }
        console.log('PASS: app health priority/recency, Library-only configuration, source/location recovery, mount mismatch, and slow-check coalescing.');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
