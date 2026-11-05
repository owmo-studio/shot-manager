// Isolated filesystem/backend checks; never uses the real app configuration or media.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { delimiter, join } = require('node:path');
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
            VideoFingerprintStore, videoSampleRanges, VIDEO_SAMPLE_BYTES } = loaded.exports;
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

        const previewSource = join(root, 'queued-preview-source');
        const previewCache = join(root, 'queued-preview-cache');
        await fs.mkdir(previewSource);
        const previewOriginals = new Map();
        for (const [name, color] of [['red.mp4','red'],['blue.mp4','blue'],['green.mp4','green']]) {
            const path = join(previewSource,name);
            require('node:child_process').execFileSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i',`color=c=${color}:s=64x36:d=0.1`,'-c:v','libx264','-pix_fmt','yuv420p',path]);
            previewOriginals.set(path,await fs.readFile(path));
        }
        const damagedPath = join(previewSource,'damaged.mp4');
        await fs.writeFile(damagedPath,'synthetic unreadable video');
        previewOriginals.set(damagedPath,await fs.readFile(damagedPath));
        const previewRegistry = new SourceRegistry(previewCache,join(root,'queued-preview-fingerprints'),join(root,'queued-preview-drafts.json'));
        const previewWorker = previewRegistry.scanner.thumbnailQueue;
        const extractPreview = previewWorker.extract.bind(previewWorker);
        const queued = [];
        const enqueuePreview = previewWorker.enqueue.bind(previewWorker);
        previewWorker.enqueue = (...args) => { queued.push(args[0][0]); return enqueuePreview(...args); };
        const waitPreview = async predicate => {
            for (let i=0;i<500;i++) { if (predicate()) return; await new Promise(resolve=>setTimeout(resolve,20)); }
            throw new Error('Background preview fixture did not settle');
        };
        let releasePreview, previewEntered;
        const previewGate = new Promise(resolve=>{releasePreview=resolve;});
        const previewStarted = new Promise(resolve=>{previewEntered=resolve;});
        previewWorker.extract = async (...args) => { previewEntered(); await previewGate; return extractPreview(...args); };
        try {
            const source = await previewRegistry.add(previewSource);
            await previewStarted;
            await waitPreview(()=>!previewRegistry.scanner.isBusy(source.id));
            const pending = previewRegistry.scanner.snapshot().shots;
            assert.equal(pending.length,4);
            assert.equal(queued.length,4,'Discovery queues every clip without a renderer or thumbnail request');
            assert.ok(pending.every(shot=>shot.thumbnailStatus==='pending'),'Scanning completes while the serial preview worker is blocked');
            assert.equal(await previewRegistry.scanner.thumbnail(pending[0].id),null);
            assert.equal(queued.length,4,'Reading a missing preview does not enqueue duplicate generation');
            const queuedRed = pending.find(shot=>shot.filename==='red.mp4');
            await previewRegistry.scanner.setThumbnail(queuedRed.id,customUrl);
            assert.equal(await previewRegistry.scanner.thumbnail(queuedRed.id),customUrl,'A custom capture is readable while other thumbnails remain queued');
            releasePreview();
            await waitPreview(()=>previewRegistry.scanner.snapshot().shots.every(shot=>['ready','failed'].includes(shot.thumbnailStatus)));
            const completed = previewRegistry.scanner.snapshot().shots;
            assert.equal(completed.filter(shot=>shot.thumbnailStatus==='ready').length,3,'All off-screen synthetic videos finish generating');
            assert.equal(completed.find(shot=>shot.filename==='damaged.mp4').thumbnailStatus,'failed','A damaged preview does not block the queue or clip publication');
            for (const shot of completed.filter(shot=>shot.thumbnailStatus==='ready')) assert.match(await previewRegistry.scanner.thumbnail(shot.id),/^data:image\/jpeg;base64,/);
            assert.equal(queued.length,4,'Ready images are read directly from disk without joining the generation queue');
            const red = completed.find(shot=>shot.filename==='red.mp4');
            assert.equal(await previewRegistry.scanner.thumbnail(red.id),customUrl,'A queued generation task cannot overwrite a newer custom capture');
            await previewRegistry.refresh(source.id);
            await waitPreview(()=>!previewRegistry.scanner.isBusy(source.id) && previewRegistry.scanner.snapshot().shots.every(shot=>['ready','failed'].includes(shot.thumbnailStatus)));
            assert.equal(await previewRegistry.scanner.thumbnail(red.id),customUrl,'Background generation preserves custom captures on rescan');

            let cancellationEntered, cancelled=false;
            const cancellationStarted = new Promise(resolve=>{cancellationEntered=resolve;});
            previewWorker.extract = async (_input,_identity,signal) => {
                cancellationEntered();
                await new Promise(resolve=>signal.addEventListener('abort',()=>{cancelled=true;resolve();},{once:true}));
                signal.throwIfAborted();
            };
            await previewRegistry.refresh(source.id);
            await cancellationStarted;
            await previewRegistry.clearLocalData();
            assert.equal(cancelled,true,'Reset cancels background extraction');
            assert.equal(previewRegistry.scanner.snapshot().shots.length,0);
            assert.deepEqual(await previewRegistry.scanner.cacheSummary(),{bytes:0,files:0},'Cancelled tasks cannot repopulate the reset cache');
            for (const [path,bytes] of previewOriginals) assert.deepEqual(await fs.readFile(path),bytes,'Automatic previews never alter original media');
        } finally { releasePreview(); await previewRegistry.close(); }

        const recordDirectory = join(root, 'fingerprints');
        const fingerprintStore = new VideoFingerprintStore(recordDirectory);
        const sampledVideo = join(root, 'sampled-video.mp4');
        await fs.writeFile(sampledVideo, Buffer.alloc(3 * 1024 * 1024));
        const signal = new AbortController().signal;
        const baseline = await fingerprintStore.identify(sampledVideo, signal);
        assert.equal(baseline.scheme, 'sampled-sha256-v2');
        assert.equal(baseline.algorithm, 'sha256');
        assert.equal(baseline.sampledBytes, 5 * VIDEO_SAMPLE_BYTES);
        assert.ok(baseline.sampledBytes < baseline.fileSize);
        const sampleRanges = videoSampleRanges(baseline.fileSize);
        assert.equal(sampleRanges[0].offset, 0);
        assert.equal(sampleRanges.at(-1).offset + sampleRanges.at(-1).length, baseline.fileSize);
        for (let index = 1; index < sampleRanges.length; index++) {
            assert.ok(sampleRanges[index].offset >= sampleRanges[index - 1].offset + sampleRanges[index - 1].length);
        }
        assert.deepEqual(await new VideoFingerprintStore(recordDirectory).identify(sampledVideo, signal), baseline);
        const persisted = (await fs.readdir(recordDirectory)).filter(name => name.endsWith('.json'));
        assert.equal(persisted.length, 1);
        const record = JSON.parse(await fs.readFile(join(recordDirectory, persisted[0]), 'utf8'));
        assert.equal(record.fingerprint.value, baseline.value);
        assert.equal(Object.hasOwn(record, 'metadata'), false, 'Extracted metadata is absent from fingerprint records');
        assert.equal(JSON.stringify(record).includes(sampledVideo), false, 'Fingerprint record does not identify clips by path');
        const recordPath = join(recordDirectory, persisted[0]);
        const savedRecord = await fs.readFile(recordPath, 'utf8');
        for (const invalid of ['{broken', 'null', '[]', JSON.stringify({ ...record, version: 999 }),
            JSON.stringify({ ...record, fingerprint: { ...record.fingerprint, fileSize: 1 } }),
            JSON.stringify({ ...record, fileVersion: 'invalid' })]) {
            await fs.writeFile(recordPath, invalid);
            await assert.rejects(new VideoFingerprintStore(recordDirectory).identify(sampledVideo, signal), /preserved/);
            assert.equal(await fs.readFile(recordPath, 'utf8'), invalid, 'Invalid fingerprint records are never overwritten');
        }
        await fs.unlink(recordPath);
        await fs.mkdir(recordPath);
        await assert.rejects(new VideoFingerprintStore(recordDirectory).identify(sampledVideo, signal), /preserved/);
        assert.equal((await fs.stat(recordPath)).isDirectory(), true, 'Unreadable fingerprint paths remain untouched');
        await fs.rmdir(recordPath);
        await fs.writeFile(recordPath, savedRecord);
        assert.deepEqual(await new VideoFingerprintStore(recordDirectory).identify(sampledVideo, signal), baseline, 'Reading recovers after the saved record is repaired');
        const sampledCopy = join(root, 'elsewhere.mp4');
        await fs.copyFile(sampledVideo, sampledCopy);
        assert.equal((await fingerprintStore.identify(sampledCopy, signal)).value, baseline.value);
        await fs.utimes(sampledCopy, new Date('2000-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
        assert.equal((await new VideoFingerprintStore(recordDirectory).identify(sampledCopy, signal)).value, baseline.value, 'Copy timestamps do not affect clip identity');
        const movedSample = join(root, 'renamed-sample.mov');
        await fs.rename(sampledCopy, movedSample);
        assert.equal((await new VideoFingerprintStore(recordDirectory).identify(movedSample, signal)).value, baseline.value, 'Moving and renaming preserves clip identity');
        await fs.rename(movedSample, sampledCopy);
        const small = await fingerprintStore.identify(firstVideo, signal);
        assert.equal(small.sampledBytes, (await fs.stat(firstVideo)).size, 'Small files are read once without overlapping samples');
        for (const range of sampleRanges) {
            const file = await fs.open(sampledCopy, 'r+');
            try { await file.write(Buffer.from([17]), 0, 1, range.offset + 17); }
            finally { await file.close(); }
            assert.notEqual((await fingerprintStore.identify(sampledCopy, signal)).value, baseline.value, 'Every sample point contributes to the fingerprint');
            const restore = await fs.open(sampledCopy, 'r+');
            try { await restore.write(Buffer.from([0]), 0, 1, range.offset + 17); }
            finally { await restore.close(); }
        }
        await assert.rejects(fingerprintStore.identify(sampledVideo, AbortSignal.abort()));
        const durableQueue = new ThumbnailQueue(contentCache, fingerprintStore);
        await durableQueue.clearCache();
        assert.ok((await fs.readdir(recordDirectory)).includes(persisted[0]), 'Clearing thumbnails preserves fingerprint records');
        await durableQueue.close();

        const corruptSource = join(root, 'corrupt-fingerprint-source');
        const corruptRecords = join(root, 'corrupt-fingerprints');
        await fs.mkdir(corruptSource);
        const corruptVideo = join(corruptSource, 'clip.mp4');
        await fs.writeFile(corruptVideo, 'synthetic invalid video');
        await new VideoFingerprintStore(corruptRecords).identify(corruptVideo, signal);
        const corruptRecord = join(corruptRecords, (await fs.readdir(corruptRecords))[0]);
        await fs.writeFile(corruptRecord, '{broken');
        const corruptRegistry = new SourceRegistry(undefined, corruptRecords);
        try {
            const source = await corruptRegistry.add(corruptSource);
            for (let i = 0; i < 500 && corruptRegistry.scanner.isBusy(source.id); i++) await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(corruptRegistry.scanner.isBusy(source.id), false);
            const snapshot = corruptRegistry.scanner.snapshot();
            assert.equal(snapshot.shots.length, 0, 'A clip with an unreadable fingerprint is not published');
            assert.ok(snapshot.scans[0].warnings.some(warning => warning.includes('saved fingerprint') && warning.includes('preserved')), 'Scan issues report the preserved fingerprint failure');
            assert.equal(await fs.readFile(corruptRecord, 'utf8'), '{broken');
            assert.equal(await fs.readFile(corruptVideo, 'utf8'), 'synthetic invalid video');
        } finally { await corruptRegistry.close(); }

        // Metadata inspection can fail or recover without changing sampled clip identity.
        const probeTools = join(root, 'probe-tools');
        const probeSource = join(root, 'probe-source');
        const probeRecords = join(root, 'probe-fingerprints');
        const probeDrafts = join(root, 'probe-organization.json');
        await fs.mkdir(probeTools); await fs.mkdir(probeSource);
        await fs.writeFile(join(probeSource, 'clip.mp4'), 'unchanged synthetic video bytes');
        const probeExecutable = join(probeTools, 'ffprobe');
        await fs.writeFile(probeExecutable, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
        const originalPath = process.env.PATH;
        let probeRegistry;
        try {
            process.env.PATH = `${probeTools}${delimiter}${originalPath ?? ''}`;
            const scanProbeSource = async () => {
                const source = await probeRegistry.add(probeSource);
                for (let i = 0; i < 500 && probeRegistry.scanner.isBusy(source.id); i++) await new Promise(resolve => setTimeout(resolve, 20));
                assert.equal(probeRegistry.scanner.isBusy(source.id), false, 'Metadata fixture scan finishes');
                const shots = probeRegistry.scanner.snapshot().shots;
                assert.equal(shots.length, 1);
                return shots[0];
            };
            probeRegistry = new SourceRegistry(undefined, probeRecords, probeDrafts);
            const unprobed = await scanProbeSource();
            assert.equal(unprobed.metadata.codec.name, null);
            assert.equal(unprobed.durationSeconds, null);
            assert.equal(unprobed.dateSource, 'file-modified');
            await probeRegistry.scanner.updateOrganization([unprobed.id], { field: 'notes', operation: 'set', value: 'Preserve this draft' });
            await probeRegistry.scanner.updateOrganization([unprobed.id], { field: 'skip', operation: 'set', value: 'true' });
            const savedOrganization = probeRegistry.scanner.snapshot().shots[0].organization;
            await probeRegistry.close();
            await fs.rm(probeRecords, { recursive: true }); // Require a fresh byte read in the next session.
            const probeInfo = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080,
                r_frame_rate: '25/1', avg_frame_rate: '25/1', nb_frames: '250' }],
                format: { duration: '10', tags: { creation_time: '2026-11-04T12:00:00Z' } } };
            await fs.writeFile(probeExecutable, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(probeInfo)}'\n`);
            probeRegistry = new SourceRegistry(undefined, probeRecords, probeDrafts);
            const probed = await scanProbeSource();
            assert.equal(probed.metadata.codec.name, 'h264');
            assert.equal(probed.durationSeconds, 10);
            assert.equal(probed.dateSource, 'embedded');
            assert.deepEqual(probed.fingerprint, unprobed.fingerprint, 'Recovering metadata does not change the fingerprint');
            assert.equal(probed.id, unprobed.id, 'Recovering metadata does not change clip identity');
            assert.deepEqual(probed.organization, savedOrganization, 'Drafts and Skip restore across metadata availability changes and restart');
        } finally {
            await probeRegistry?.close();
            if (originalPath === undefined) delete process.env.PATH;
            else process.env.PATH = originalPath;
        }

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
            assert.equal(clipFingerprint.scheme, 'sampled-sha256-v2', 'Every discovered video retains its fingerprint');
            await assert.rejects(registry.relink(first.id, moved), /unavailable/);
            await fs.rename(original, moved);
            assert.equal(registry.list()[0].available, true, 'Listing returns cached state without checking the moved source');
            const detached = registry.list(); detached[0].name = 'Renderer mutation';
            assert.notEqual(registry.list()[0].name, 'Renderer mutation', 'Listings do not expose mutable backend records');
            registry.startMonitoring(10);
            for (let i = 0; i < 250 && registry.list()[0].available; i++) await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(registry.list()[0].available, false, 'Backend monitoring detects disconnection independently of polling');
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
            const notices = [];
            registry.scanner.onChange = change => notices.push(change);
            await registry.scanner.updateOrganization([clipId],{field:'notes',operation:'set',value:'Original clip note'});
            await registry.scanner.updateOrganization([clipId],{field:'skip',operation:'set',value:'false'});
            assert.equal(notices[0].vocabularyRevision,notices[1].vocabularyRevision,'Notes and Skip do not invalidate vocabulary');
            await registry.scanner.updateOrganization([clipId],{field:'context',operation:'add',value:'notice-check'});
            assert.ok(notices.at(-1).vocabularyRevision > notices[0].vocabularyRevision,'Context suggestions have an independent revision');
            assert.deepEqual(Object.keys(notices[0]).sort(),['revision','vocabularyRevision'],'Change events contain no clip snapshots');
            registry.scanner.onChange = undefined;
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
            await registry.checkAvailability();
            const changed = await registry.relink(first.id, replacement);
            assert.notEqual(changed.source.id, first.id, 'Different directory must not inherit old identity');
            await settle(changed.source.id);
            assert.equal(registry.scanner.snapshot().shots.length, 0);
        } finally { await registry.close(); }
        console.log('Configuration, cache, and source relink/rescan identity and recovery checks passed.');
    } finally {
        await server?.close();
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
