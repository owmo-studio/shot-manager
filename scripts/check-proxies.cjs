// Synthetic media and temporary local destinations only. Never consult the user's configuration.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const execute = require('node:util').promisify(require('node:child_process').execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, message) { for (let i = 0; i < 1000; i++) { if (await test()) return; await sleep(20); } throw new Error(`Timed out: ${message}`); }

(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'owmo-proxy-check-')));
    let scanner, queue, proxies;
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, ['server/proxies.ts', 'server/scanner.ts', 'server/ingestion.ts', 'server/library.ts', 'server/rsync.ts'].map(file => `export * from ${JSON.stringify(join(__dirname, '..', file))};`).join('\n'));
        const { build } = await import('vite');
        const bundle = await build({ configFile: false, logLevel: 'silent', build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'cjs' } } } });
        const loaded = new (require('node:module'))(__filename, module); loaded.paths = module.paths;
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { ProxyQueue, ShotScanner, IngestQueue, inspectLibrary, inspectScratch, encodeProxy, rsyncFile, libraryFileIdentity, scratchFolder } = loaded.exports;
        const source = join(root, 'source'), library = join(root, 'library'), scratch = join(root, 'scratch');
        await Promise.all([source, library, scratch].map(path => fs.mkdir(path)));
        for (const [index, size] of ['1600x900', '900x1600', '1440x1440'].entries()) {
            await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${['blue', 'red', 'green'][index]}:s=${size}:r=30`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.4', '-vf', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'aac', '-timecode', '01:02:03:00', join(source, `${index}.mov`)]);
        }
        const originals = await Promise.all((await fs.readdir(source)).map(async name => [name, await fs.readFile(join(source, name))]));
        const config = { version: 1, libraryPath: library, libraryMount: (await inspectLibrary(library)).mount, scratchPath: scratch, scratchMount: (await inspectLibrary(scratch)).mount };
        scanner = new ShotScanner(join(root, 'thumbs'), join(root, 'fingerprints'), join(root, 'drafts.json'));
        let encodeCount = 0, encoders = 0, maxEncoders = 0, releaseEncode, releaseTransfer;
        let encodingHeld = false, transferHeld = false, overlap = false;
        const abortableGate = signal => new Promise((resolve, reject) => {
            releaseEncode = () => { signal.removeEventListener('abort', abort); resolve(); };
            const abort = () => reject(new Error('Stopped test encode'));
            signal.addEventListener('abort', abort, { once: true });
        });
        let holdEncoding = true, holdTransfer = true, holdAt = 2;
        let holdCheck = false, checkEntered = false, releaseCheck;
        proxies = new ProxyQueue(scanner, async () => config, async (...args) => {
            encodeCount++; encoders++; maxEncoders = Math.max(maxEncoders, encoders);
            try {
                if (holdEncoding && encodeCount === holdAt) { encodingHeld = true; args[4](50); await abortableGate(args[3]); }
                await encodeProxy(...args);
            } finally { encoders--; }
        });
        queue = new IngestQueue(scanner, async () => library, async (...args) => {
            if (holdCheck) { holdCheck = false; checkEntered = true; await new Promise(resolve => { releaseCheck = resolve; }); }
            return inspectLibrary(...args);
        }, async (...args) => {
            if (holdTransfer) {
                holdTransfer = false; transferHeld = true; overlap = encoders === 1;
                await new Promise((resolve, reject) => { releaseTransfer = resolve; args[2].addEventListener('abort', () => reject(new Error('Stopped test transfer')), { once: true }); });
            }
            await rsyncFile(...args);
        }, proxies);
        scanner.onChange = () => { proxies.schedule(); queue.backgroundChanged(); };
        await queue.status();
        scanner.discover({ id: 'synthetic', path: source, name: 'Synthetic', type: 'folder', available: true, cameraModels: [] });
        await until(() => scanner.snapshot().shots.length === 3 && scanner.snapshot().shots.every(shot => shot.thumbnailStatus === 'ready'), 'thumbnails ready');
        await until(() => encodingHeld && scanner.snapshot().shots.some(shot => shot.proxyState === 'ready'), 'first proxy ready, second encoding');
        const shots = scanner.snapshot().shots;
        const backgroundProgress = (await queue.status()).tasks;
        assert.deepEqual({ total: backgroundProgress.total, completed: backgroundProgress.completed, proxies: backgroundProgress.proxiesRemaining, transfers: backgroundProgress.transfersRemaining },
            { total: 3, completed: 1, proxies: 2, transfers: 0 }, 'Background encoding reports tasks before a Commit');
        assert.ok(backgroundProgress.percent > 33 && backgroundProgress.percent < 100, 'Partial encode progress contributes to overall progress');
        assert.ok(shots.some(shot => shot.proxyLocation === 'cache'), 'Generated proxy is identified as local');
        const pending = shots.find(shot => shot.proxyState === 'encoding');
        assert.equal(pending.editable, true, 'Encoding does not lock metadata edits');
        await scanner.updateOrganization([pending.id], { field: 'notes', operation: 'set', value: 'Edited during encoding' });
        const review = await queue.preview(shots.map(shot => shot.id));
        assert.ok(review.clips.every(clip => clip.files.length === 4));
        assert.ok(review.clips.some(clip => clip.proxyReady), 'Review shows generated proxies as ready');
        assert.ok(review.clips.some(clip => !clip.proxyReady), 'Review shows proxies still being generated as queued');
        await queue.submit(review.token, shots.map(shot => shot.id));
        await until(() => transferHeld, `ready clip transfers while another encodes: ${JSON.stringify(await queue.status())}`);
        const mixedProgress = (await queue.status()).tasks;
        assert.deepEqual({ total: mixedProgress.total, proxies: mixedProgress.proxiesRemaining, transfers: mixedProgress.transfersRemaining },
            { total: 6, proxies: 2, transfers: 3 }, 'Commit adds one transfer per clip to existing proxy work');
        assert.equal(overlap, true, 'Encoder and rsync worker can run concurrently');
        assert.ok(scanner.snapshot().shots.every(shot => !shot.editable), 'Submitted clips are locked, including those waiting for a proxy');
        assert.ok(scanner.snapshot().shots.some(shot => shot.ingestState === 'processing'));
        await assert.rejects(scanner.updateOrganization([pending.id], { field: 'notes', operation: 'set', value: 'locked' }), /locked/);
        holdEncoding = false; releaseEncode();
        await until(() => scanner.snapshot().shots.every(shot => shot.proxyState === 'ready'), 'remaining proxies finish while transfer waits');
        assert.equal((await queue.status()).tasks.completed, 3, 'Completed encodes count while transfers are still pending');
        releaseTransfer();
        await until(async () => !(await queue.status()).active, 'all submitted clips synced');
        assert.deepEqual((await queue.status()).errors, []);
        assert.equal((await queue.status()).completed, 3);
        assert.deepEqual((await queue.status()).tasks, { completed: 6, total: 6, percent: 100, proxiesRemaining: 0, transfersRemaining: 0 }, 'Both kinds of work must finish for overall 100%');
        assert.ok(scanner.snapshot().shots.every(shot => shot.proxyLocation === 'library'), 'Published proxies are identified as Library assets');
        assert.equal(maxEncoders, 1);
        const scratchDirectory = join(scratch, scratchFolder, 'proxies');
        assert.deepEqual(await fs.readdir(scratchDirectory), [], 'Scratch copies removed after successful publication');
        for (const shot of shots) {
            assert.equal(scanner.snapshot().shots.find(current => current.id === shot.id).ingestState, 'synced');
            const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', join(library, `${shot.id}.proxy.mov`)]);
            const streams = JSON.parse(stdout).streams, video = streams.find(stream => stream.codec_type === 'video'), audio = streams.find(stream => stream.codec_type === 'audio');
            const expected = { '0.mov': [1280, 720], '1.mov': [720, 1280], '2.mov': [1280, 1280] }[shot.filename];
            assert.deepEqual([video.width, video.height], expected);
            assert.equal(video.codec_name, 'prores'); assert.equal(video.profile, 'Proxy'); assert.equal(video.pix_fmt, 'yuv422p10le');
            assert.equal(video.r_frame_rate, '30/1'); assert.equal(Number(video.nb_frames), 12);
            assert.equal(video.color_primaries, 'bt709'); assert.equal(video.color_transfer, 'bt709');
            assert.equal(video.tags.timecode, '01:02:03:00'); assert.equal(audio.channels, 2); assert.equal(audio.sample_rate, '48000');
        }
        assert.equal(JSON.parse(await fs.readFile(join(library, `${pending.id}.metadata.json`))).notes, 'Edited during encoding');
        const first = shots[0], proxyPath = join(library, `${first.id}.proxy.mov`), before = await fs.stat(proxyPath), count = encodeCount;
        await scanner.updateOrganization([first.id], { field: 'notes', operation: 'set', value: 'Metadata-only update' });
        let plan = await queue.preview([first.id]); await queue.submit(plan.token, [first.id]);
        await until(async () => !(await queue.status()).active, 'metadata-only update');
        assert.equal((await fs.stat(proxyPath)).ino, before.ino, 'Existing Library proxy is not overwritten');
        assert.equal(encodeCount, count, 'Metadata updates do not regenerate proxies');
        assert.equal((await queue.status()).tasks.total, 1, 'A fresh Commit with an existing proxy counts only its transfer');

        // Pause before deleting: refresh must expose the missing proxy and make the shot eligible.
        await queue.stop();
        await fs.unlink(proxyPath); await queue.refreshLibrary();
        await until(() => scanner.snapshot().shots.find(shot => shot.id === first.id).proxyState === 'missing', 'missing proxy after Library refresh');
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === first.id).ingestState, 'changes-pending');
        const pausedCount = encodeCount;
        await sleep(200); assert.equal(encodeCount, pausedCount, 'Stop suspends automatic generation');
        await queue.refreshWork();
        assert.equal((await queue.status()).active, false, 'Refresh resumes asset preparation, never cancelled sync submissions');
        await until(() => scanner.snapshot().shots.find(shot => shot.id === first.id).proxyState === 'ready', 'Resume generates deleted Library proxy');
        assert.ok(await fs.stat(join(scratchDirectory, `${first.id}.proxy.mov`)));
        await queue.stop();
        assert.ok(await fs.stat(join(scratchDirectory, `${first.id}.proxy.mov`)), 'Stop preserves completed scratch proxies');
        const cachedCount = encodeCount;
        plan = await queue.preview([first.id]); await queue.submit(plan.token, [first.id]);
        await until(async () => !(await queue.status()).active, 'processing automatically resumes necessary work');
        assert.deepEqual((await queue.status()).errors, []);
        assert.equal(encodeCount, cachedCount, 'Completed scratch output is reused without re-encoding');
        await queue.stop();
        await fs.unlink(proxyPath); await queue.refreshLibrary();
        encodingHeld = false; holdEncoding = true; holdAt = encodeCount + 1;
        plan = await queue.preview([first.id]);
        assert.equal(proxies.status().paused, false, 'Commit refreshes presence and resumes preparation after Stop');
        await until(() => encodingHeld, 'active encoding before Stop');
        await queue.submit(plan.token, [first.id]);
        await until(async () => (await queue.status()).waiting === 1, 'sync batch waits for encoding');
        await queue.stop();
        assert.equal((await queue.status()).active, false, 'Stop clears Commit submissions');
        assert.equal((await queue.status()).tasks.transfersRemaining, 0, 'Cancelling Commit removes transfer tasks from progress');
        assert.equal(encoders, 0, 'Stop terminates active encoding');
        assert.equal((await queue.status()).tasks.proxiesRemaining, 0, 'Stop all removes unfinished proxy tasks from progress');
        assert.equal(proxies.status().paused, true);
        const cancelledCount = encodeCount;
        await sleep(250); assert.equal(encodeCount, cancelledCount, 'Stop does not immediately refill the background queue');
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === first.id).editable, true, 'Cancelled background encoding leaves metadata editable');
        assert.ok(!(await fs.readdir(scratchDirectory)).some(name => name.endsWith('.partial')), 'Cancelled temporary outputs are cleaned up');
        holdCheck = true;
        const refreshing = queue.refreshWork();
        await until(() => checkEntered, 'refresh presence check held');
        await queue.stop(); releaseCheck(); await refreshing;
        assert.equal(proxies.status().paused, true, 'A refresh finishing after Stop cannot restart background work');
        assert.equal((await queue.status()).active, false, 'Refresh does not resurrect cancelled sync submissions');
        holdCheck = true; checkEntered = false;
        const stoppedReview = queue.preview([first.id]);
        await until(() => checkEntered, 'Commit presence check held');
        await queue.stop(); releaseCheck();
        await assert.rejects(stoppedReview, /Work was stopped/);
        assert.equal(proxies.status().paused, true, 'A Commit review finishing after Stop cannot restart work');
        // Exercise cancellation of an actual FFmpeg child after it reports a frame.
        const abort = new AbortController();
        await assert.rejects(encodeProxy(join(source, first.filename), join(root, 'cancelled.partial'), first, abort.signal, () => abort.abort()), /stopped/);
        await assert.rejects(inspectScratch({ ...config, scratchPath: source }, [source]), /different folders/);
        await assert.rejects(inspectScratch({ ...config, scratchPath: '/Volumes/owmo-no-such-scratch' }, [source]), /not mounted/);
        const nestedRoot = join(root, 'nested-scratch');
        await fs.mkdir(nestedRoot);
        const nestedConfig = { ...config, scratchPath: nestedRoot, libraryPath: join(nestedRoot, scratchFolder, 'proxies') };
        const nestedStorage = await inspectScratch(nestedConfig, [source]);
        const sharedProxy = join(nestedStorage.directory, `${first.id}.proxy.mov`);
        await fs.writeFile(sharedProxy, 'synthetic completed proxy');
        const sharing = new ProxyQueue(scanner, async () => nestedConfig);
        try {
            await sharing.stop();
            await sharing.published(first.id, { path: sharedProxy, identity: await libraryFileIdentity(sharedProxy), bytes: 25, scratch: nestedStorage }, nestedConfig.libraryPath);
            assert.equal(await fs.readFile(sharedProxy, 'utf8'), 'synthetic completed proxy', 'Nested scratch cleanup must preserve a file already inside the Library');
        } finally { await sharing.close(); }
        for (const [name, bytes] of originals) assert.deepEqual(await fs.readFile(join(source, name)), bytes, 'Source footage untouched');
        console.log('PASS: ProRes Proxy dimensions/color/audio/timecode, non-blocking edits, parallel encoding/transfers, dependency scheduling, Library reuse, scratch cleanup, Stop/Resume, missing-proxy refresh, and scratch mount/path safety.');
    } finally { await queue?.close(); await proxies?.close(); await scanner?.close(); await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
