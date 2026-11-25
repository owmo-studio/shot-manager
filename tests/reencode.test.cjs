// Library-only jobs with synthetic media, isolated roots, and a controllable encoder.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(test, message) {
    for (let n = 0; n < 500; n++) { if (await test()) return; await wait(20); }
    throw Error(message);
}

(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'shot-reencode-')));
    let catalogue, queue, proxies, scanner;
    async function close() { await queue?.close(); await proxies?.close(); await catalogue?.close(); await scanner?.close(); }
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, ['server/proxies', 'server/catalogue', 'server/scanner', 'server/ingestion', 'server/library',
            'server/fingerprints', 'shared/shots', 'server/sync', 'server/rsync'].map(f => `export * from ${JSON.stringify(resolve(f + '.ts'))}`).join('\n'));
        const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: { ssr: true, write: false,
            rollupOptions: { input: entry, output: { format: 'cjs' } } } });
        const mod = new (require('node:module'))(__filename, module); mod.paths = module.paths;
        mod._compile(bundle.output.find(c => c.isEntry).code, __filename);
        const { ProxyQueue, ShotScanner, IngestQueue, LibraryCatalogue, inspectLibrary, VideoFingerprintStore,
            emptyVideoMetadata, LibrarySync, rsyncFile } = mod.exports;
        const library = join(root, 'library'), cache = join(root, 'cache'), dest = join(root, 'export');
        await Promise.all([library, cache, dest].map(path => fs.mkdir(path)));
        const config = { version: 1, libraryPath: library, scratchPath: cache, scratchMount: (await inspectLibrary(cache)).mount };
        const original = Buffer.from('synthetic original');
        const file = join(root, 'sample.mp4'); await fs.writeFile(file, original);
        const fingerprint = await new VideoFingerprintStore().identify(file, new AbortController().signal);
        const id = fingerprint.value, target = join(library, id + '.proxy.mov'), source = join(library, id + '.source.mp4');
        const metadata = { id, fingerprint, originalFilename: 'Camera.mp4', bytes: original.length, recordedAt: '2026-01-02T00:00:00Z',
            dateSource: 'camera', dateEvidence: 'fixture', dateConfidence: 'declared', durationSeconds: 1, metadata: emptyVideoMetadata(),
            warnings: [], identity: null, project: 'Test', scene: '', notes: '', tags: [], ingestion: { completedAt: '2026-01-03T00:00:00Z', transfer: 'rsync' } };
        await fs.writeFile(source, original); await fs.writeFile(target, 'old');
        await fs.writeFile(join(library, id + '.metadata.json'), JSON.stringify(metadata));
        await fs.writeFile(join(library, id + '.thumb.jpg'), Buffer.from([255,216,255,217]));
        const before = await fs.stat(source);
        let hold = false, entered = false, calls = 0, fail = false;
        const encode = async (path, out, shot, signal, progress) => {
            entered = true; calls++;
            assert.equal(path, join(library, shot.id + '.source.mp4'));
            await fs.writeFile(out, 'replacement-' + calls); progress(50);
            while (hold) { signal.throwIfAborted(); await wait(5); }
            if (fail) throw Error('Synthetic encode failed');
        };
        let afterPublish;
        const inspect = async () => {
            const location = await inspectLibrary(library);
            if (afterPublish) await afterPublish();
            return location;
        };
        let sync;
        function start() {
            scanner = new ShotScanner(join(cache, 'thumbs'), undefined, join(cache, 'drafts.json'));
            proxies = new ProxyQueue(scanner, async () => config, encode);
            queue = new IngestQueue(scanner, async () => library, inspect, rsyncFile, proxies);
            catalogue = new LibraryCatalogue(scanner, async () => library, inspect, queue, join(cache, 'catalogue.json'),
                join(cache, 'thumbs'), undefined, async () => 0, undefined, proxies);
            sync = new LibrarySync(catalogue, scanner, queue, inspect);
        }
        start();
        const shot = async () => (await catalogue.snapshot()).shots[0];
        const review = () => catalogue.previewReencode([id]);
        const submit = async () => catalogue.submitReencode((await review()).token, [id]);
        const staged = () => until(async () => (await shot())?.editable && (await shot()).pendingProxy, 'No staged replacement');
        await catalogue.refresh();
        const staleSource = await review();
        await fs.writeFile(source, 'different footage');
        await assert.rejects(catalogue.submitReencode(staleSource.token, [id]), /source|changed/i);
        await fs.writeFile(source, original);
        const restored = await fs.stat(source);
        assert.equal(restored.ino, before.ino);
        const staleStop = await review(); await queue.stop();
        await assert.rejects(catalogue.submitReencode(staleStop.token, [id]), /review/i);
        hold = true; await submit(); await until(() => entered, 'Encoder did not start');
        assert.equal((await shot()).editable, false);
        assert.equal((await shot()).proxyState, 'encoding');
        await assert.rejects(review(), /available|locked|queued/);
        await queue.stop(); hold = false;
        assert.equal((await shot()).editable, true); assert.equal((await shot()).pendingProxy, false);
        assert.equal(await fs.readFile(target, 'utf8'), 'old');
        fail = true; await submit();
        await until(async () => (await queue.status()).errors.some(e => e.message.includes('Synthetic encode failed')), 'Missing encoder failure');
        fail = false; await submit(); await staged();
        assert.equal((await shot()).ingestState, 'changes-pending');
        assert.equal(await fs.readFile(target, 'utf8'), 'old');
        assert.equal(scanner.snapshot().shots.length, 0);
        await catalogue.refresh(); assert.equal((await shot()).pendingProxy, true);
        await close(); start(); await catalogue.refresh();
        assert.equal((await shot()).pendingProxy, true, 'Verified output survives backend restart');
        const exportReview = await sync.preview([id], (await sync.choose(dest)).token);
        assert.match(exportReview.clips[0].issue, /Commit or Revert/);
        const stale = await catalogue.preview([id]);
        await fs.writeFile(target, 'external change');
        await assert.rejects(catalogue.submit(stale.token, [id]), /changed/);
        await catalogue.revert([id]); assert.equal((await shot()).pendingProxy, false);
        assert.equal(await fs.readFile(target, 'utf8'), 'external change');
        await submit(); await staged();
        await catalogue.update([id], { field: 'notes', operation: 'set', value: 'also commit notes' });
        let plan = await catalogue.preview([id]);
        assert.equal(plan.metadataOnly, false); assert.ok(plan.clips[0].files.some(file => file.from === 'Replace proxy'));
        catalogue.transfer = async (...args) => { await rsyncFile(...args); await fs.writeFile(target, 'changed during upload'); };
        await catalogue.submit(plan.token, [id]);
        await until(async () => !(await queue.status()).active, 'Commit did not finish');
        assert.equal((await shot()).pendingProxy, true);
        assert.equal(await fs.readFile(target, 'utf8'), 'changed during upload');
        // Model a share reporting a different timestamp under the final name.
        // Same-size corruption must still block metadata publication and preserve the staged copy.
        let corrupt = true;
        catalogue.transfer = async (from, part, ...rest) => {
            await rsyncFile(from, part, ...rest);
            afterPublish = async () => {
                try { await fs.stat(part); return; }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
                afterPublish = undefined;
                if (corrupt) await fs.writeFile(target, Buffer.alloc((await fs.stat(target)).size, 0xff));
                await fs.utimes(target, new Date(0), new Date(0));
            };
        };
        plan = await catalogue.preview([id]); await catalogue.submit(plan.token, [id]);
        await until(async () => !(await queue.status()).active, 'Corrupt publication did not finish');
        assert.ok((await queue.status()).errors.some(error => /contents differ/.test(error.message)));
        assert.equal((await shot()).pendingProxy, true);
        assert.equal(JSON.parse(await fs.readFile(join(library, id + '.metadata.json'))).notes, '');
        corrupt = false;
        plan = await catalogue.preview([id]); await catalogue.submit(plan.token, [id]);
        await until(async () => !(await queue.status()).active, 'Publication did not finish');
        catalogue.transfer = rsyncFile;
        assert.equal(await fs.readFile(target, 'utf8'), 'replacement-' + calls);
        assert.equal((await shot()).pendingProxy, false);
        assert.equal((await shot()).ingestState, undefined);
        assert.equal(JSON.parse(await fs.readFile(join(library, id + '.metadata.json'))).notes, 'also commit notes');
        assert.equal((await fs.stat(source)).mtimeMs, restored.mtimeMs);
        assert.deepEqual(await fs.readFile(source), original);
        assert.deepEqual(await fs.readdir(join(cache, 'Shot Manager Cache', 'proxies')), []);
        assert.ok(!(await fs.readdir(library)).some(name => name.endsWith('.partial')));
        // Two selected clips share the normal proxy worker. Pause preserves the batch and Stop releases it.
        const secondFile = join(root, 'second.mp4');
        await fs.writeFile(secondFile, 'another synthetic original');
        const second = await new VideoFingerprintStore().identify(secondFile, new AbortController().signal);
        await fs.copyFile(secondFile, join(library, second.value + '.source.mp4'));
        await fs.writeFile(join(library, second.value + '.metadata.json'), JSON.stringify({ ...metadata, id: second.value,
            fingerprint: second, originalFilename: 'Second.mp4', bytes: (await fs.stat(secondFile)).size }));
        await fs.copyFile(join(library, id + '.thumb.jpg'), join(library, second.value + '.thumb.jpg'));
        const ids = [id, second.value];
        const batch = await catalogue.previewReencode(ids);
        assert.deepEqual(batch.clips.map(clip => clip.filename), ['Camera.mp4', 'Second.mp4']);
        await queue.controlQueue('proxy', true);
        const initial = calls;
        await catalogue.submitReencode(batch.token, ids);
        assert.equal(calls, initial);
        assert.ok((await catalogue.snapshot()).shots.every(clip => !clip.editable && clip.proxyState === 'queued'));
        hold = true;
        await queue.controlQueue('proxy', false);
        await until(() => calls === initial + 1, 'Batch did not start');
        await queue.controlQueue('proxy', true);
        assert.ok((await catalogue.snapshot()).shots.every(clip => !clip.editable && !clip.pendingProxy));
        hold = false;
        await queue.controlQueue('proxy', false);
        await until(async () => (await catalogue.snapshot()).shots.every(clip => clip.editable && clip.pendingProxy), 'Batch did not resume');
        const batchCommit = await catalogue.preview([second.value]);
        await catalogue.submit(batchCommit.token, [second.value]);
        await until(async () => !(await queue.status()).active, 'Missing original proxy was not repaired');
        assert.match(await fs.readFile(join(library, second.value + '.proxy.mov'), 'utf8'), /^replacement-/);
        assert.equal((await catalogue.snapshot()).shots.find(clip => clip.id === id).pendingProxy, true);
        await catalogue.revert([id]);
        const subset = await catalogue.previewReencode(ids);
        for (const invalid of [[], [id, id], [id, '0'.repeat(64)]]) {
            await assert.rejects(catalogue.submitReencode(subset.token, invalid), /review/i);
        }
        const beforeSubset = calls;
        assert.deepEqual(await catalogue.submitReencode(subset.token, [second.value]), { queued: 1 });
        await until(async () => (await catalogue.snapshot()).shots.some(clip => clip.id === second.value && clip.editable && clip.pendingProxy), 'Included clip was not encoded');
        assert.equal(calls, beforeSubset + 1);
        const excluded = (await catalogue.snapshot()).shots.find(clip => clip.id === id);
        assert.equal(excluded.pendingProxy, false);
        assert.equal(excluded.editable, true);
        console.log('PASS: reviewed Library proxy encoding, Stop/failure, restart, Revert, Export gating, guarded Commit and source preservation.');
    } finally { await close(); await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
