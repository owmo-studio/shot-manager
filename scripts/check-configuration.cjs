// Isolated filesystem/backend checks; never uses the real app configuration or media.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'shot-configuration-check-')));
    let server;
    try {
        const entry = join(root, 'fixture.ts');
        await fs.writeFile(entry, [
            `export * from ${JSON.stringify(join(__dirname, '../desktop/configuration.ts'))};`,
            `export * from ${JSON.stringify(join(__dirname, '../server/thumbnails.ts'))};`,
            `export * from ${JSON.stringify(join(__dirname, '../server/app.ts'))};`,
            `export * from ${JSON.stringify(join(__dirname, '../server/sources.ts'))};`,
            `export * from ${JSON.stringify(join(__dirname, '../server/fingerprints.ts'))};`,
        ].join('\n'));
        const { build } = await import('vite');
        const bundle = await build({ configFile: false, logLevel: 'silent', build: {
            ssr: true, write: false, rollupOptions: { input: entry, external: ['fastify'], output: { format: 'cjs' } },
        } });
        const Module = require('node:module');
        const loaded = new Module(__filename, module);
        loaded.paths = module.paths;
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { readConfiguration, saveConfiguration, ThumbnailQueue, inspectThumbnailCache, createServer, SourceRegistry,
            VideoFingerprintStore, commonFingerprintMetadata, videoSampleRanges, VIDEO_SAMPLE_BYTES } = loaded.exports;
        const configPath = join(root, 'settings', 'configuration.json');
        assert.deepEqual(await readConfiguration(configPath), { version: 1, libraryPath: null });
        const chosen = { version: 1, libraryPath: join(root, 'dummy-library') };
        await saveConfiguration(configPath, chosen);
        assert.deepEqual(await readConfiguration(configPath), chosen, 'Configuration survives a fresh read');
        assert.deepEqual(await fs.readdir(join(root, 'settings')), ['configuration.json'], 'No partial state left behind');
        await fs.writeFile(configPath, '{broken');
        await assert.rejects(readConfiguration(configPath), /preserved/);
        assert.equal(await fs.readFile(configPath, 'utf8'), '{broken');
        await fs.writeFile(configPath, JSON.stringify({ version: 1, libraryPath: 'relative' }));
        await assert.rejects(readConfiguration(configPath));

        const cache = join(root, 'cache');
        assert.deepEqual(await inspectThumbnailCache(cache), { files: 0, bytes: 0 });
        await fs.mkdir(cache);
        const outside = join(root, 'original.mp4');
        await fs.writeFile(outside, 'source stays untouched');
        await fs.writeFile(join(cache, 'a'.repeat(64) + '.jpg'), 'cached-image');
        await fs.writeFile(join(cache, 'b'.repeat(64) + '.12345678-1234-1234-1234-123456789abc.tmp'), 'partial');
        await fs.writeFile(join(cache, 'unrelated.txt'), 'keep');
        await fs.symlink(outside, join(cache, 'c'.repeat(64) + '.jpg'));
        await fs.mkdir(join(cache, 'd'.repeat(64) + '.jpg'));
        assert.deepEqual(await inspectThumbnailCache(cache), { files: 2, bytes: 19 });
        const queue = new ThumbnailQueue(cache);
        // Simulate an active extraction which settles only after cancellation.
        let started;
        const active = new Promise(resolve => { started = resolve; });
        queue.extract = async (_input, _identity, signal) => {
            started();
            await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
            signal.throwIfAborted();
        };
        let published = false;
        queue.enqueue(['dummy'], '', new AbortController().signal, async () => true, () => { published = true; });
        await active;
        await queue.clearCache();
        assert.equal(published, false, 'Cancelled extraction must not republish stale previews');
        assert.deepEqual(await queue.cacheSummary(), { files: 0, bytes: 0 });
        assert.equal(await fs.readFile(outside, 'utf8'), 'source stays untouched');
        assert.equal(await fs.readFile(join(cache, 'unrelated.txt'), 'utf8'), 'keep');
        assert.equal((await fs.lstat(join(cache, 'c'.repeat(64) + '.jpg'))).isSymbolicLink(), true);
        await queue.close();

        const contentCache = join(root, 'content-cache');
        const firstVideo = join(root, 'first-video.mp4');
        const copiedVideo = join(root, 'different-source', 'renamed-video.mov');
        await fs.mkdir(join(root, 'different-source'));
        await fs.writeFile(firstVideo, 'unique original video bytes');
        await fs.copyFile(firstVideo, copiedVideo);
        const customBytes = Buffer.from([0xff, 0xd8, 0x10, 0x20, 0xff, 0xd9]);
        const customUrl = `data:image/jpeg;base64,${customBytes.toString('base64')}`;
        const contentQueue = new ThumbnailQueue(contentCache);
        try {
            await contentQueue.setCustomImage(firstVideo, 'source-a', customUrl, async () => true);
            assert.equal(await contentQueue.customImage(copiedVideo, 'unrelated-source'), customUrl, 'Copied/renamed videos reuse custom captures');
            const restartedQueue = new ThumbnailQueue(contentCache);
            assert.equal(await restartedQueue.customImage(copiedVideo, 'new-session'), customUrl, 'Content association survives a fresh queue');
            await restartedQueue.close();
            const originalTimes = await fs.stat(copiedVideo);
            await new Promise(resolve => setTimeout(resolve, 10));
            await fs.writeFile(copiedVideo, 'mutant original video bytes');
            assert.equal((await fs.stat(copiedVideo)).size, originalTimes.size);
            await fs.utimes(copiedVideo, originalTimes.atime, originalTimes.mtime);
            assert.equal(await contentQueue.customImage(copiedVideo, 'unrelated-source'), null, 'Changed contents never inherit a capture merely from filename/mtime');
            assert.equal(await contentQueue.customImage(firstVideo, 'source-a'), customUrl);

            const generatedVideo = join(root, 'generated.mp4');
            require('node:child_process').execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x36:d=0.1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', generatedVideo]);
            const extract = (input, source) => new Promise(resolve => contentQueue.enqueue([input], source, new AbortController().signal, async () => true, resolve));
            assert.ok(await extract(generatedVideo, 'first-source'));
            const paths = await contentQueue.cachePaths(generatedVideo, 'first-source', undefined, new AbortController().signal);
            await fs.writeFile(paths.generated, customBytes);
            const relocated = join(root, 'relocated.mp4');
            await fs.copyFile(generatedVideo, relocated);
            assert.equal(await extract(relocated, 'second-source'), customUrl, 'Generated cache is reused without decoding a new frame');

            // Existing path-keyed custom entries migrate when their old location is known.
            const legacyVideo = join(root, 'legacy.mp4');
            await fs.writeFile(legacyVideo, 'legacy video bytes');
            const info = await fs.stat(legacyVideo);
            const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}:${info.size}:${info.mtimeMs}`;
            const key = require('node:crypto').createHash('sha256').update(`custom-preview-rec709-v2:passthrough:old-root:${legacyVideo}:${identity}`).digest('hex');
            await fs.writeFile(join(contentCache, `${key}.jpg`), customBytes);
            const movedVideo = join(root, 'legacy-moved.mp4');
            await fs.rename(legacyVideo, movedVideo);
            contentQueue.rememberLegacyLocation(identity, legacyVideo, 'old-root');
            assert.equal(await contentQueue.customImage(movedVideo, 'new-root'), customUrl, 'Legacy custom cache survives a known relink');
            const copiedLegacy = join(root, 'legacy-copy.mp4');
            await fs.copyFile(movedVideo, copiedLegacy);
            assert.equal(await contentQueue.customImage(copiedLegacy, 'third-root'), customUrl, 'Promoted captures become location independent');
        } finally { await contentQueue.close(); }

        const recordDirectory = join(root, 'fingerprints');
        const fingerprintStore = new VideoFingerprintStore(recordDirectory);
        const sampledVideo = join(root, 'sampled-video.mp4');
        await fs.writeFile(sampledVideo, Buffer.alloc(3 * 1024 * 1024));
        const signal = new AbortController().signal;
        const common = commonFingerprintMetadata(undefined, { recordingDate: '2026-11-04T12:00:00Z', durationSeconds: 10, frameCount: '300' });
        const baseline = await fingerprintStore.identify(sampledVideo, common, signal);
        assert.equal(baseline.scheme, 'sampled-sha256-v1');
        assert.equal(baseline.algorithm, 'sha256');
        assert.equal(baseline.sampledBytes, 5 * VIDEO_SAMPLE_BYTES);
        assert.ok(baseline.sampledBytes < baseline.fileSize);
        const sampleRanges = videoSampleRanges(baseline.fileSize);
        assert.equal(sampleRanges[0].offset, 0);
        assert.equal(sampleRanges.at(-1).offset + sampleRanges.at(-1).length, baseline.fileSize);
        for (let index = 1; index < sampleRanges.length; index++) {
            assert.ok(sampleRanges[index].offset >= sampleRanges[index - 1].offset + sampleRanges[index - 1].length);
        }
        assert.deepEqual(await new VideoFingerprintStore(recordDirectory).identify(sampledVideo, common, signal), baseline);
        const persisted = (await fs.readdir(recordDirectory)).filter(name => name.endsWith('.json'));
        assert.equal(persisted.length, 1);
        const record = JSON.parse(await fs.readFile(join(recordDirectory, persisted[0]), 'utf8'));
        assert.equal(record.fingerprint.value, baseline.value);
        assert.equal(JSON.stringify(record).includes(sampledVideo), false, 'Fingerprint record does not identify clips by path');
        const sampledCopy = join(root, 'elsewhere.mp4');
        await fs.copyFile(sampledVideo, sampledCopy);
        assert.equal((await fingerprintStore.identify(sampledCopy, common, signal)).value, baseline.value);
        const small = await fingerprintStore.identify(firstVideo, commonFingerprintMetadata(), signal);
        assert.equal(small.sampledBytes, (await fs.stat(firstVideo)).size, 'Small files are read once without overlapping samples');
        for (const range of sampleRanges) {
            const file = await fs.open(sampledCopy, 'r+');
            try { await file.write(Buffer.from([17]), 0, 1, range.offset + 17); }
            finally { await file.close(); }
            assert.notEqual((await fingerprintStore.identify(sampledCopy, common, signal)).value, baseline.value, 'Every sample point contributes to the fingerprint');
            const restore = await fs.open(sampledCopy, 'r+');
            try { await restore.write(Buffer.from([0]), 0, 1, range.offset + 17); }
            finally { await restore.close(); }
        }
        assert.notEqual((await fingerprintStore.identify(sampledVideo, { ...common, recordingDate: '2026-11-04T12:00:01Z' }, signal)).value, baseline.value, 'Recording metadata distinguishes otherwise identical samples');
        await assert.rejects(fingerprintStore.identify(sampledVideo, common, AbortSignal.abort()));
        const durableQueue = new ThumbnailQueue(contentCache, fingerprintStore);
        await durableQueue.clearCache();
        assert.ok((await fs.readdir(recordDirectory)).includes(persisted[0]), 'Clearing thumbnails preserves fingerprint records');
        await durableQueue.close();

        server = createServer('fixture-token', undefined, cache);
        assert.equal((await server.inject({ method: 'DELETE', url: '/api/cache' })).statusCode, 401);
        const headers = { authorization: 'Bearer fixture-token' };
        await fs.writeFile(join(cache, 'a'.repeat(64) + '.jpg'), 'test');
        assert.deepEqual((await server.inject({ method: 'GET', url: '/api/cache', headers })).json(), { files: 1, bytes: 4 });
        assert.deepEqual((await server.inject({ method: 'DELETE', url: '/api/cache', headers })).json(), { files: 0, bytes: 0 });
        assert.deepEqual((await server.inject({ method: 'DELETE', url: '/api/cache', headers })).json(), { files: 0, bytes: 0 });
        assert.equal(await fs.readFile(outside, 'utf8'), 'source stays untouched');
        const registry = new SourceRegistry(undefined, recordDirectory);
        try {
            const original = join(root, 'source-a');
            const other = join(root, 'source-b');
            const moved = join(root, 'source-moved');
            const replacement = join(root, 'replacement');
            await Promise.all([fs.mkdir(original), fs.mkdir(other), fs.mkdir(replacement)]);
            // An unreadable-video fixture must still be discoverable and safe to rescan.
            await fs.writeFile(join(original, 'clip.mp4'), 'synthetic invalid video');
            const savedScan=registry.scanner.organization.scanned.bind(registry.scanner.organization);
            let releaseAttributes, enteredAttributes;
            const attributesReady=new Promise(resolve=>{releaseAttributes=resolve;});
            const attributesEntered=new Promise(resolve=>{enteredAttributes=resolve;});
            registry.scanner.organization.scanned=async (...args)=>{enteredAttributes();await attributesReady;return savedScan(...args);};
            const first = await registry.add(original);
            await attributesEntered;
            assert.equal(registry.scanner.snapshot().shots.length,0,'Unprocessed candidates stay out of the clip view');
            releaseAttributes();
            registry.scanner.organization.scanned=savedScan;
            const second = await registry.add(other);
            async function settle(id) {
                for (let i = 0; i < 500; i++) {
                    if (!registry.scanner.isBusy(id)) return;
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
                throw new Error('Scan did not finish');
            }
            await settle(first.id); await settle(second.id);
            const clipId = registry.scanner.snapshot().shots[0].id;
            const clipFingerprint = registry.scanner.snapshot().shots[0].fingerprint;
            assert.equal(clipId,clipFingerprint.value,'The fingerprint is the published clip and asset ID');
            assert.equal(clipFingerprint.scheme, 'sampled-sha256-v1', 'Every discovered video retains its fingerprint');
            await assert.rejects(registry.relink(first.id, moved), /unavailable/);
            await fs.rename(original, moved);
            assert.equal((await registry.list())[0].available, false);
            assert.equal(registry.scanner.snapshot().shots[0].editable, true, 'Offline clips remain editable');
            assert.equal((await registry.scanner.details(clipId)).file.filename, 'clip.mp4', 'Offline inspection uses cached metadata');
            await assert.rejects(registry.scanner.openVideo(clipId), /unavailable/);
            await assert.rejects(registry.relink(first.id, other), /already a source/);
            await assert.rejects(registry.relink(first.id, join(root, 'missing')));
            assert.equal((await registry.list())[0].path, original, 'Failed relink keeps old source');
            const relinked = await registry.relink(first.id, moved);
            assert.equal(relinked.source.id, first.id, 'A moved directory keeps source identity');
            assert.equal(relinked.collection.shots[0].id, clipId, 'Old clips retained during rescan');
            assert.equal(relinked.collection.shots[0].editable, false);
            await settle(first.id);
            assert.deepEqual((await registry.list()).map(source => source.id), [first.id, second.id]);
            assert.equal(registry.scanner.snapshot().shots[0].id, clipId);
            assert.deepEqual(registry.scanner.snapshot().shots[0].fingerprint, clipFingerprint, 'Relink retains the video fingerprint');
            assert.equal(registry.scanner.snapshot().shots[0].editable, true);
            assert.equal((await registry.scanner.details(clipId)).file.path, join(moved, 'clip.mp4'));
            await registry.scanner.updateOrganization([clipId],{field:'notes',operation:'set',value:'Original clip note'});
            await fs.rename(join(moved,'clip.mp4'),join(moved,'renamed.mp4'));
            await registry.refresh(first.id); await settle(first.id);
            assert.equal(registry.scanner.snapshot().shots[0].id,clipId,'Renaming preserves clip identity');
            assert.equal((await registry.scanner.details(clipId)).file.path,join(moved,'renamed.mp4'));
            const opened=await registry.scanner.openVideo(clipId); await opened.file.close();
            await fs.writeFile(join(moved,'renamed.mp4'),'a completely different synthetic video');
            await assert.rejects(registry.scanner.openVideo(clipId),/accessible/,'Old fingerprint cannot play replacement content');
            await registry.refresh(first.id); await settle(first.id);
            const replaced=registry.scanner.snapshot().shots[0];
            assert.notEqual(replaced.id,clipId,'New content at the same path is a different clip');
            assert.equal(replaced.id,replaced.fingerprint.value);
            assert.equal(replaced.organization.notes,'','Replacement cannot inherit the previous note');
            await assert.rejects(registry.scanner.details(clipId),/no longer available/);
            await fs.writeFile(join(moved,'renamed.mp4'),'synthetic invalid video');
            await registry.refresh(first.id); await settle(first.id);
            assert.equal(registry.scanner.snapshot().shots[0].id,clipId);
            assert.equal(registry.scanner.snapshot().shots[0].organization.notes,'Original clip note','Restoring original content restores its attributes');
            await fs.rename(moved, join(root, 'moved-again'));
            await registry.list();
            const changed = await registry.relink(first.id, replacement);
            assert.notEqual(changed.source.id, first.id, 'Different directory must not inherit old identity');
            await settle(changed.source.id);
            assert.equal(registry.scanner.snapshot().shots.length, 0);
        } finally { await registry.scanner.close(); }
        console.log('Configuration, cache, and source relink/rescan identity and recovery checks passed.');
    } finally {
        await server?.close();
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
