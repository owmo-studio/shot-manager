// Clip Eject and targeted cancellation with synthetic media and temporary local destinations only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const execute = require('node:util').promisify(require('node:child_process').execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) { for (let i = 0; i < 750; i++) { if (await test()) return; await sleep(20); } throw new Error(`Timed out: ${label}`); }
function gate(signal) {
    let release;
    const promise = new Promise((resolve, reject) => {
        const abort = () => reject(new Error('Cancelled fixture job'));
        release = () => { signal.removeEventListener('abort', abort); resolve(); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
    return { promise, release: () => release() };
}
(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'owmo-eject-')));
    let manager, proxies, queue, releasePublication;
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, ['server/sources.ts', 'server/proxies.ts', 'server/ingestion.ts', 'server/library.ts', 'server/rsync.ts', 'server/app.ts']
            .map(path => `export * from ${JSON.stringify(resolve(path))};`).join('\n'));
        const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: {
            ssr: true, write: false, rollupOptions: { input: entry, external: ['fastify'], output: { format: 'cjs' } },
        } });
        const loaded = new (require('node:module'))(__filename, module); loaded.paths = module.paths;
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { SourceRegistry, ProxyQueue, IngestQueue, inspectLibrary, rsyncFile, scratchFolder, createServer } = loaded.exports;
        const input = join(root, 'input'), media = join(input, 'media'), extra = join(root, 'extra'), library = join(root, 'library'), scratch = join(root, 'scratch');
        await Promise.all([media, extra, library, scratch].map(path => fs.mkdir(path, { recursive: true })));
        for (const [name, color] of [['a', 'blue'], ['b', 'red'], ['c', 'green']]) {
            await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=10`, '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(media, `${name}.mp4`)]);
        }
        const originals = await Promise.all((await fs.readdir(media)).map(async name => [name, await fs.readFile(join(media, name))]));
        const config = { version: 1, libraryPath: library, libraryMount: (await inspectLibrary(library)).mount, scratchPath: scratch, scratchMount: (await inspectLibrary(scratch)).mount };
        manager = new SourceRegistry(join(root, 'thumbs'), join(root, 'fingerprints'), join(root, 'metadata.json'));
        const scanner = manager.scanner;
        const holds = new Map(); let holdName = 'c.mp4', activeTransfer, encodeCount = 0;
        proxies = new ProxyQueue(scanner, async () => config, async (_input, output, shot, signal, progress) => {
            encodeCount++;
            await fs.writeFile(output, 'synthetic proxy fixture');
            if (shot.filename === holdName) { const hold = gate(signal); holds.set(shot.filename, hold); progress(40); await hold.promise; }
        });
        let holdTransfer = true;
        queue = new IngestQueue(scanner, async () => library, inspectLibrary, async (...args) => {
            if (holdTransfer && args[0] === join(media, 'a.mp4')) {
                holdTransfer = false; const hold = gate(args[2]); activeTransfer = hold; await hold.promise;
            }
            await rsyncFile(...args);
        }, proxies);
        scanner.onChange = () => { proxies.schedule(); queue.backgroundChanged(); };
        await queue.status();
        await manager.add(input);
        await until(() => scanner.snapshot().shots.length === 3 && scanner.snapshot().shots.every(shot => shot.thumbnailStatus === 'ready') && holds.has('c.mp4') && scanner.snapshot().shots.filter(shot => shot.proxyState === 'ready').length === 2, 'initial preparation');
        const byName = () => Object.fromEntries(scanner.snapshot().shots.map(shot => [shot.filename, shot]));
        const { 'a.mp4': a, 'b.mp4': b, 'c.mp4': c } = byName();
        await scanner.updateOrganization([a.id], { field: 'notes', operation: 'set', value: 'Retained draft' });
        const plan = await queue.preview([a.id, b.id, c.id]); await queue.submit(plan.token, [a.id, b.id, c.id]);
        await until(() => !!activeTransfer, 'active transfer');
        await assert.rejects(queue.eject([a.id]), error => error.code === 'EJECT_CONFIRMATION_REQUIRED');
        assert.equal(scanner.snapshot().shots.length, 3, 'No membership or cancellation changes before confirmation');
        await queue.eject([b.id], true);
        assert.equal((await queue.status()).current.id, a.id, 'Ejecting a waiting clip leaves another transfer active');
        assert.equal(scanner.snapshot().shots.some(shot => shot.id === b.id), false);
        assert.ok(await fs.stat(join(scratch, scratchFolder, 'proxies', `${b.id}.proxy.mov`)), 'Completed cache proxy retained');
        // Adding another folder is independent of the current Commit.
        await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=yellow:s=160x90:r=10', '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(extra, 'd.mp4')]);
        await manager.add(extra);
        await until(() => byName()['d.mp4']?.thumbnailStatus === 'ready', 'discovery during Commit');
        const d = byName()['d.mp4'];
        assert.equal(d.editable, true, 'New unsubmitted clips remain editable');
        await queue.eject([d.id]);
        await queue.eject([a.id], true);
        assert.equal(scanner.snapshot().shots.some(shot => shot.id === a.id), false);
        assert.equal(proxies.status().paused, false, 'Eject does not pause the background worker globally');
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === c.id).proxyState, 'encoding', 'Other encoding continues');
        holds.get('c.mp4').release(); holdName = '';
        await until(async () => !(await queue.status()).active, 'remaining Commit completes');
        assert.equal((await queue.status()).completed, 1);
        assert.deepEqual((await queue.status()).errors, []);
        assert.ok(await fs.stat(join(library, `${c.id}.metadata.json`)), 'Unrelated Library work completes');
        assert.equal(await fs.stat(join(library, `${a.id}.metadata.json`)).catch(() => null), null);
        assert.equal(await fs.stat(join(library, `${b.id}.metadata.json`)).catch(() => null), null);
        const libraryBefore = await fs.readdir(library);
        await queue.eject([c.id]);
        assert.deepEqual(await fs.readdir(library), libraryBefore, 'Ejecting a synced clip preserves Library assets');
        assert.ok(await scanner.organization.ingestion(c.fingerprint), 'Successful receipt retained');
        await scanner.checkDirectories();
        assert.deepEqual(scanner.directoryAvailability(), [], 'Ejecting final members removes directory monitoring references');
        await manager.add(input);
        await until(() => scanner.snapshot().shots.length === 3 && scanner.snapshot().shots.every(shot => shot.proxyState === 'ready' && shot.thumbnailStatus === 'ready'), 'explicit re-add');
        assert.equal(byName()['a.mp4'].organization.notes, 'Retained draft');
        assert.equal(byName()['c.mp4'].ingestState, 'synced');
        const offline = join(input, 'media-offline');
        await fs.rename(media, offline); await manager.checkAvailability();
        const unavailable = scanner.directoryAvailability();
        assert.equal(unavailable.length, 1);
        assert.equal(unavailable[0].path, media, 'Monitor actual containing directory, not the selected root');
        assert.equal(unavailable[0].clipIds.length, 3);
        assert.equal(unavailable[0].available, false);
        const outage = unavailable[0].outage;
        await manager.checkAvailability(); assert.equal(scanner.directoryAvailability()[0].outage, outage, 'One outage identity while unavailable');
        await fs.rename(offline, media); await manager.checkAvailability();
        assert.ok(scanner.snapshot().shots.every(shot => shot.available));
        // Cancelling an unsubmitted encoder needs no Commit confirmation and retains all other clips.
        await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=160x90:r=10', '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(extra, 'e.mp4')]);
        holdName = 'e.mp4'; await manager.add(extra);
        await until(() => holds.has('e.mp4'), 'unsubmitted encoding');
        const e = byName()['e.mp4']; await queue.eject([e.id]);
        assert.equal(scanner.snapshot().shots.some(shot => shot.id === e.id), false);
        assert.ok(!(await fs.readdir(join(scratch, scratchFolder, 'proxies'))).some(name => name.startsWith(e.id)), 'Cancelled partial proxy is cleaned up');
        // Publication wins a cancellation race: Eject waits for receipt persistence before removing the card.
        const mark = scanner.markIngested.bind(scanner); let publicationHeld = false;
        const publication = new Promise(resolve => { releasePublication = resolve; });
        scanner.markIngested = async (...args) => { publicationHeld = true; await publication; return mark(...args); };
        const race = await queue.preview([a.id]); await queue.submit(race.token, [a.id]);
        await until(() => publicationHeld, 'publication boundary');
        let ejected = false; const ejecting = queue.eject([a.id], true).then(() => { ejected = true; });
        await sleep(30); assert.equal(ejected, false, 'Eject waits for completion bookkeeping');
        releasePublication(); await ejecting;
        assert.ok(await scanner.organization.ingestion(a.fingerprint));
        assert.ok(await fs.stat(join(library, `${a.id}.metadata.json`)));
        assert.equal(scanner.snapshot().shots.some(shot => shot.id === a.id), false);
        assert.equal((await queue.status()).completed, 1, 'Published success is not recorded as cancelled');
        for (const [name, bytes] of originals) assert.deepEqual(await fs.readFile(join(media, name)), bytes, 'Original fixture media preserved');
        // Restore exactly current file paths after Cache clearing, never a broad folder containing ejected clips.
        const paths = scanner.snapshot().shots.map(shot => shot.filePath);
        const restore = new SourceRegistry(join(root, 'restore-thumbs'), join(root, 'restore-fingerprints'), join(root, 'restore-metadata.json'));
        try {
            restore.scanner.restoreFiles(paths);
            await until(() => restore.scanner.snapshot().scans.every(scan => scan.state === 'complete'), 'exact workspace restore');
            assert.deepEqual(restore.scanner.snapshot().shots.map(shot => shot.filePath).sort(), paths.sort());
        } finally { await restore.close(); }
        // Eject drains only the selected active thumbnail; ongoing discovery keeps adding other clips.
        const thumbnails = new SourceRegistry(join(root, 'eject-thumbs'), join(root, 'eject-fingerprints'), join(root, 'eject-metadata.json'));
        const thumbnailQueue = new IngestQueue(thumbnails.scanner, async () => null);
        let releaseLate;
        try {
            const extraction = thumbnails.scanner.thumbnailQueue.extract.bind(thumbnails.scanner.thumbnailQueue);
            let thumbnailHeld = false;
            thumbnails.scanner.thumbnailQueue.extract = async (...args) => {
                if (args[0] === join(media, 'a.mp4') && !thumbnailHeld) { thumbnailHeld = true; await gate(args[2]).promise; }
                return extraction(...args);
            };
            await thumbnails.add(input);
            await until(() => thumbnailHeld, 'selected thumbnail active');
            const preparing = thumbnails.scanner.snapshot().shots.find(shot => shot.filename === 'a.mp4');
            await thumbnailQueue.eject([preparing.id]);
            await until(() => thumbnails.scanner.snapshot().shots.length === 2 && thumbnails.scanner.snapshot().shots.every(shot => shot.thumbnailStatus === 'ready'), 'other thumbnails finish after Eject');
            assert.equal(thumbnails.scanner.snapshot().shots.some(shot => shot.id === preparing.id), false);
            const identify = thumbnails.scanner.fingerprints.identify.bind(thumbnails.scanner.fingerprints);
            let fingerprintHeld = false;
            const late = new Promise(resolve => { releaseLate = resolve; });
            thumbnails.scanner.fingerprints.identify = async (...args) => {
                if (args[0] === join(media, 'b.mp4')) { fingerprintHeld = true; await late; }
                return identify(...args);
            };
            const request = await thumbnails.add(input);
            await until(() => fingerprintHeld, 'late discovery held');
            await thumbnailQueue.eject([b.id]);
            const planDuringScan = thumbnails.scanner.restorePlan();
            assert.ok(planDuringScan.excludedIds.includes(b.id), 'Cache handoff retains Eject exclusions for pending discovery');
            releaseLate();
            await until(() => thumbnails.scanner.snapshot().scans.find(scan => scan.sourceId === request.id)?.state === 'complete', 'late discovery completes');
            assert.equal(thumbnails.scanner.snapshot().shots.some(shot => shot.id === b.id), false, 'Late scan callback cannot reintroduce an ejected clip');
            const pendingRestore = new SourceRegistry(join(root, 'pending-thumbs'), join(root, 'pending-fingerprints'), join(root, 'pending-metadata.json'));
            try {
                pendingRestore.scanner.restoreWorkspace(planDuringScan);
                await until(() => pendingRestore.scanner.snapshot().scans.every(scan => scan.state === 'complete'), 'restore pending discovery');
                assert.equal(pendingRestore.scanner.snapshot().shots.some(shot => shot.id === b.id), false, 'Pending discovery after Cache clear respects Eject exclusions');
                assert.equal(pendingRestore.scanner.snapshot().shots.length, 2);
            } finally { await pendingRestore.close(); }
            thumbnails.scanner.fingerprints.identify = identify;
            await thumbnails.add(input);
            await until(() => thumbnails.scanner.snapshot().shots.some(shot => shot.id === b.id), 'explicit re-add after Eject');
        } finally { releaseLate?.(); await thumbnailQueue.close(); await thumbnails.close(); }
        const server = createServer('fixture-token');
        try {
            const route = '/api/workspace/eject';
            assert.equal((await server.inject({ method: 'POST', url: route, payload: { shotIds: [a.id] } })).statusCode, 401);
            assert.equal((await server.inject({ method: 'POST', url: route, headers: { authorization: 'Bearer fixture-token' }, payload: { shotIds: ['../../arbitrary-file'] } })).statusCode, 400);
        } finally { await server.close(); }
        console.log('PASS: queued/active Eject confirmation and isolated cancellation, discovery during Commit, independent proxy work, synced asset/cache/draft preservation, directory outage/recovery, publication races, exact workspace restoration, and authenticated identifier validation.');
    } finally {
        releasePublication?.();
        await queue?.close(); await proxies?.close(); await manager?.close();
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
