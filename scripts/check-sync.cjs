// Synthetic flat Libraries and disposable destinations only; never user settings.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test) { for (let i = 0; i < 500; i++) { if (await test()) return; await sleep(10); } throw new Error('Sync timed out'); }
(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(require('node:os').tmpdir(), 'owmo-sync-')));
    let queue, catalogue, scanner;
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, ['server/sync.ts', 'server/catalogue.ts', 'server/scanner.ts', 'server/ingestion.ts', 'server/library.ts', 'shared/shots.ts', 'server/rsync.ts'].map(file => `export * from ${JSON.stringify(resolve(file))};`).join('\n'));
        const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'cjs' } } } });
        const loaded = new (require('node:module'))(__filename, module); loaded.paths = module.paths;
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { LibrarySync, LibraryCatalogue, ShotScanner, IngestQueue, inspectLibrary, emptyVideoMetadata, rsyncFile } = loaded.exports;
        const library = join(root, 'library'), cache = join(root, 'cache'), destination = join(root, 'destination');
        for (const path of [library, cache, destination]) await fs.mkdir(path);
        const ids = ['a'.repeat(64), 'b'.repeat(64)];
        for (const id of ids) {
            const metadata = { id, fingerprint: { value: id, algorithm: 'sha256', scheme: 'sampled-sha256-v2', fileSize: 4, sampleBytes: 262144, sampledBytes: 4 }, originalFilename: `Camera-${id[0]}.MP4`, bytes: 4,
                recordedAt: '2026-11-01T10:00:00Z', dateSource: 'camera', dateEvidence: 'fixture', dateConfidence: 'declared', durationSeconds: 1,
                metadata: emptyVideoMetadata(), warnings: [], identity: null, project: null, scene: '', notes: '', tags: [], ingestion: { completedAt: '2026-11-01T11:00:00Z', transfer: 'rsync' } };
            await fs.writeFile(join(library, `${id}.metadata.json`), JSON.stringify(metadata));
            await fs.writeFile(join(library, `${id}.source.mp4`), 'data');
            await fs.writeFile(join(library, `${id}.proxy.mov`), `proxy-${id[0]}`);
            await fs.writeFile(join(library, `${id}.thumb.jpg`), Buffer.from([255, 216, 255, 217]));
        }
        const original = new Map(await Promise.all((await fs.readdir(library)).map(async name => [name, await fs.readFile(join(library, name))])));
        const inspect = () => inspectLibrary(library);
        scanner = new ShotScanner(join(cache, 'thumbnails'), undefined, join(cache, 'metadata.json'));
        queue = new IngestQueue(scanner, async () => library, inspect);
        await queue.status();
        catalogue = new LibraryCatalogue(scanner, async () => library, inspect, queue, join(cache, 'catalogue.json'), join(cache, 'library-thumbnails'));
        let gate, entered, fail = false, aborts = 0;
        const sync = new LibrarySync(catalogue, scanner, queue, inspect, async (...args) => {
            if (gate) { entered?.(); await new Promise((resolve, reject) => {
                const abort = () => { aborts++; reject(new Error('Stopped fixture')); };
                args[2].addEventListener('abort', abort, { once: true });
                gate = () => { args[2].removeEventListener('abort', abort); gate = undefined; resolve(); };
            }); }
            if (fail) { fail = false; throw new Error('Synthetic transfer failure'); }
            return rsyncFile(...args);
        });
        const choice = await sync.choose(destination);
        const review = selected => sync.preview(selected, choice.token);
        const submit = async selected => { const r = await review(selected); return sync.submit(r.token, selected); };
        const idle = () => until(async () => !(await queue.status()).active);
        await catalogue.refresh();
        await catalogue.update([ids[1]], { field: 'notes', operation: 'set', value: 'Pending' });
        let r = await review(ids);
        assert.match(r.clips[1].issue, /Commit or Revert/);
        await assert.rejects(sync.submit(r.token, ids), /Exclude/);
        assert.equal((await fs.readdir(destination)).length, 0, 'Rejected selection queues nothing');
        await sync.submit(r.token, [ids[0]]); await idle();
        assert.deepEqual((await queue.status()).tasks.sync, { completed: 1, total: 1, percent: 100 }, 'Completed Sync progress is retained until the next work session');
        assert.deepEqual((await fs.readdir(destination)).sort(), [`${ids[0]}.proxy.mov`, `${ids[0]}.source.mp4`], 'Only source and proxy copied, filenames unchanged');
        for (const name of await fs.readdir(destination)) assert.deepEqual(await fs.readFile(join(destination, name)), original.get(name));
        r = await review([ids[0]]); assert.equal(r.clips[0].mode, 'replace');
        const destinationFile = join(destination, `${ids[0]}.source.mp4`);
        const before = await fs.stat(destinationFile);
        await sync.submit(r.token, [ids[0]]); await idle();
        assert.equal((await fs.stat(destinationFile)).ino, before.ino, 'rsync quick check avoids recopying');
        r = await review([ids[0]]);
        await fs.writeFile(destinationFile, 'Changed after review');
        await assert.rejects(sync.submit(r.token, [ids[0]]), /Destination files changed/);
        await submit([ids[0]]); await idle();
        r = await review([ids[0]]);
        await catalogue.update([ids[0]], { field: 'scene', operation: 'set', value: 'After review' });
        await assert.rejects(sync.submit(r.token, [ids[0]]), /Clips changed/);
        await catalogue.update([ids[0]], { field: 'scene', operation: 'set', value: '' });
        await catalogue.update([ids[1]], { field: 'notes', operation: 'set', value: '' });
        const dangerous = await sync.choose(library);
        await assert.rejects(sync.preview([ids[0]], dangerous.token), /outside the Library/);
        await fs.unlink(destinationFile); await fs.symlink(join(library, `${ids[0]}.source.mp4`), destinationFile);
        r = await review([ids[0]]); assert.match(r.clips[0].issue, /regular file/);
        await fs.unlink(destinationFile); await fs.link(join(library, `${ids[0]}.source.mp4`), destinationFile);
        r = await review([ids[0]]); assert.match(r.clips[0].issue, /linked file|aliases/);
        await fs.unlink(destinationFile);
        const savedProxy = join(root, 'saved-proxy'); await fs.rename(join(library, `${ids[1]}.proxy.mov`), savedProxy);
        r = await review(ids); assert.match(r.clips[1].issue, /Proxy unavailable/);
        await fs.rename(savedProxy, join(library, `${ids[1]}.proxy.mov`));
        r = await review([ids[0]]); await queue.stop();
        await assert.rejects(sync.submit(r.token, [ids[0]]), /Review Sync again/);
        let started; const active = new Promise(resolve => { started = resolve; }); gate = true; entered = started;
        await submit([ids[0]]); await active;
        let status = await queue.status(); assert.equal(status.tasks.syncsRemaining, 1); assert.equal(status.tasks.transfersRemaining, 0);
        assert.deepEqual(status.tasks.sync, { completed: 0, total: 1, percent: 0 });
        let view = await catalogue.snapshot(); assert.equal(view.shots.find(s => s.id === ids[0]).workKind, 'sync'); assert.equal(view.shots.find(s => s.id === ids[0]).editable, false);
        await submit([ids[1]]); assert.equal((await queue.status()).tasks.syncsRemaining, 2, 'Append preserves running Sync');
        assert.equal((await queue.status()).tasks.sync.total, 2, 'Appending grows Sync progress without counting Commits');
        await queue.cancel([ids[0]]); gate = undefined; await idle();
        assert.equal(aborts, 1); assert.equal((await catalogue.snapshot()).shots.find(s => s.id === ids[0]).editable, true);
        assert.ok(await fs.stat(join(destination, `${ids[1]}.source.mp4`)), 'Unrelated appended clip completes');
        let globalStarted; const globalActive = new Promise(resolve => { globalStarted = resolve; }); gate = true; entered = globalStarted;
        await submit(ids); await globalActive; await queue.stop(); gate = undefined; await idle();
        assert.equal(aborts, 2, 'Toolbar Stop aborts the active Sync');
        assert.ok((await catalogue.snapshot()).shots.every(s => s.editable), 'Toolbar Stop unlocks queued and active exports');
        r = await review(ids); fail = true; await sync.submit(r.token, ids); await idle();
        status = await queue.status(); assert.equal(status.errors.at(-1).kind, 'sync'); assert.match(status.errors.at(-1).message, /Synthetic transfer failure/);
        assert.ok((await catalogue.snapshot()).shots.every(s => s.editable && !s.ingestState), 'Failures unlock; exports do not create Commit state');
        r = await review([ids[0]]); await fs.rename(destination, `${destination}-offline`); await fs.mkdir(destination);
        await assert.rejects(sync.submit(r.token, [ids[0]]), /destination changed/);
        assert.deepEqual(await fs.readdir(destination), [], 'Changed destination root is never written');
        for (const [name, bytes] of original) assert.deepEqual(await fs.readFile(join(library, name)), bytes, 'Library remains unchanged');
        assert.equal(scanner.snapshot().shots.length, 0, 'Export never adds Import workspace clips');
        console.log('PASS: direct source/proxy copies, unchanged names, exclusions, pending edits, replacements, rsync quick check, stale review and Stop invalidation, symlink/hardlink/root protection, shared queue append/cancel/failure, and read-only Library.');
    } finally {
        await queue?.close(); await catalogue?.close(); await scanner?.close(); await fs.rm(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
