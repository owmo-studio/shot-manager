// Workspace ownership and path selection using synthetic media in temporary folders only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const execute = require('node:util').promisify(require('node:child_process').execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) {
    for (let attempt = 0; attempt < 500; attempt++) { if (await test()) return; await sleep(20); }
    throw new Error(`Timed out: ${label}`);
}
(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'owmo-workspace-')));
    let scanner, releaseThumbnail, releaseFingerprint;
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, `export * from ${JSON.stringify(resolve('server/scanner.ts'))};`);
        const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: {
            ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'cjs' } },
        } });
        const loaded = new (require('node:module'))(__filename, module); loaded.paths = module.paths;
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { ShotScanner } = loaded.exports;
        const first = join(root, 'first'), second = join(root, 'second'), third = join(root, 'third');
        await Promise.all([first, second, third].map(path => fs.mkdir(path)));
        const video = join(first, 'original.mp4');
        await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
        const bytes = await fs.readFile(video);
        const copy = join(second, 'copy.mp4'), alternative = join(third, 'alternative.mp4');
        await Promise.all([copy, alternative].map(path => fs.writeFile(path, bytes)));
        const source = (id, path) => ({ id, path, name: id, type: 'folder', available: true, cameraModels: [] });
        const a = source('first', first), b = source('second', second), c = source('third', third);
        scanner = new ShotScanner(join(root, 'thumbs'), join(root, 'fingerprints'), join(root, 'metadata.json'));
        const scan = async item => {
            scanner.discover(item);
            await until(() => scanner.snapshot().scans.find(scan => scan.sourceId === item.id)?.state === 'complete', `scan ${item.id}`);
        };
        // Hold thumbnail extraction beyond discovery so deleting the scan cannot own/cancel it.
        const extract = scanner.thumbnailQueue.extract.bind(scanner.thumbnailQueue);
        let thumbnailHeld = false;
        const thumbnailGate = new Promise(resolve => { releaseThumbnail = resolve; });
        scanner.thumbnailQueue.extract = async (...args) => {
            if (!thumbnailHeld) { thumbnailHeld = true; await thumbnailGate; }
            return extract(...args);
        };
        await scan(a);
        await until(() => thumbnailHeld, 'thumbnail worker held');
        const id = scanner.snapshot().shots[0].id;
        assert.equal(scanner.snapshot().shots[0].filePath, video);
        scanner.cancelScan(a.id);
        assert.equal(scanner.snapshot().scans.length, 0);
        assert.equal(scanner.snapshot().shots.length, 1, 'Discarding discovery preserves workspace membership');
        releaseThumbnail();
        await until(() => scanner.snapshot().shots[0].thumbnailStatus === 'ready', 'clip-owned thumbnail completes after discovery is discarded');
        const opened = await scanner.openVideo(id); await opened.file.close();
        await scanner.updateOrganization([id], { field: 'notes', operation: 'set', value: 'Keep this draft' });
        await scanner.updateOrganization([id], { field: 'tags', operation: 'add', value: 'workspace' });
        const originalThumbnail = await scanner.thumbnail(id);
        await scanner.setThumbnail(id, originalThumbnail);
        const capture = await scanner.captureIngest(id);
        const receipt = { libraryPath: join(root, 'dummy-library'), signature: capture.signature, ingestedAt: new Date().toISOString() };
        await scanner.markIngested(id, receipt);
        const beforeRediscovery = scanner.snapshot().shots[0];
        await scan(a); await scan(b); await scan(source('overlapping', root));
        assert.equal(scanner.snapshot().shots.length, 1, 'Repeated and overlapping scans deduplicate by fingerprint');
        assert.deepEqual(scanner.snapshot().shots[0], beforeRediscovery, 'A healthy active location and its state remain unchanged');
        assert.equal((await scanner.captureIngest(id)).path, video);
        const persisted = JSON.parse(await fs.readFile(join(root, 'metadata.json'), 'utf8'));
        assert.equal(Object.values(persisted.drafts)[0].clip.path, video, 'Draft reference follows the chosen active path');
        assert.ok(scanner.snapshot().scans.every(scan => scan.clipCount >= 1), 'Scan counts still report discoveries, including duplicates');
        await scanner.checkDirectories();
        const offline = join(root, 'first-offline');
        await fs.rename(first, offline); await scanner.checkDirectories();
        assert.equal(scanner.snapshot().shots[0].available, false);
        assert.equal(scanner.snapshot().shots[0].editable, true, 'Unavailable clips retain metadata editing');
        await fs.rename(offline, first); await scanner.checkDirectories();
        assert.equal(scanner.snapshot().shots[0].available, true, 'Restored directories revalidate existing clips');
        await fs.rename(first, offline); await scanner.checkDirectories();
        await scan(b);
        await until(() => scanner.snapshot().shots[0].thumbnailStatus === 'ready', 'replacement thumbnail ready');
        assert.equal(scanner.snapshot().shots[0].filePath, copy, 'A fingerprinted matching copy replaces an unavailable active location');
        assert.equal(scanner.snapshot().shots[0].organization.notes, 'Keep this draft');
        assert.deepEqual(scanner.snapshot().shots[0].ingestion, receipt);
        assert.equal(scanner.snapshot().shots[0].hasCustomThumbnail, true);
        assert.equal(await scanner.thumbnail(id), originalThumbnail, 'Custom thumbnails survive path replacement');
        assert.equal((await scanner.captureIngest(id)).path, copy);
        // Discovery cannot switch a path after a Commit has accepted it, even if it vanishes.
        scanner.lockIngest([id]);
        await fs.rename(copy, copy + '.offline');
        await scan(c);
        assert.equal(scanner.snapshot().shots[0].filePath, copy, 'Queued Commit retains its captured active path');
        await assert.rejects(scanner.validateIngest(id, copy, scanner.clips.get(id).result.fileIdentity), /no longer accessible/);
        scanner.unlockIngest([id]);
        await scan(c);
        await until(() => scanner.snapshot().shots[0].thumbnailStatus === 'ready', 'unlocked replacement ready');
        assert.equal(scanner.snapshot().shots[0].filePath, alternative);
        // Routine directory polling does not inspect all child files; access checks do.
        await scanner.checkDirectories();
        await fs.rename(alternative, alternative + '.offline'); await scanner.checkDirectories();
        assert.equal(scanner.snapshot().shots[0].available, true, 'An unchanged directory does not trigger periodic file inspection');
        const missing = await scanner.details(id);
        assert.ok(missing.errors.length);
        assert.equal(scanner.snapshot().shots[0].available, false, 'Individual file access flags a missing clip');
        await fs.rename(alternative + '.offline', alternative);
        assert.equal((await scanner.details(id)).errors.length, 0);
        assert.equal(scanner.snapshot().shots[0].available, true);
        // Keep the old unavailable fingerprint distinct when a path now contains different media.
        await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10', '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', alternative]);
        await scan(c);
        assert.equal(scanner.snapshot().shots.length, 2);
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === id).available, false);
        assert.ok(scanner.snapshot().shots.find(shot => shot.id !== id).available);
        scanner.remove(c.id); await scanner.checkDirectories();
        assert.equal(scanner.snapshot().shots.length, 0, 'Legacy Remove explicitly removes matching workspace members');
        assert.equal(scanner.directoryStates.size, 0, 'No directories remain monitored after their final member is removed');
        // Late discovery results must not restore removed clips.
        const identify = scanner.fingerprints.identify.bind(scanner.fingerprints);
        let fingerprintHeld = false;
        const fingerprintGate = new Promise(resolve => { releaseFingerprint = resolve; });
        scanner.fingerprints.identify = async (...args) => { fingerprintHeld = true; await fingerprintGate; return identify(...args); };
        scanner.discover(c);
        await until(() => fingerprintHeld, 'fingerprint held');
        scanner.remove(c.id); releaseFingerprint();
        await scanner.pending;
        assert.equal(scanner.snapshot().shots.length, 0, 'A cancelled scan cannot reintroduce a removed record');
        assert.deepEqual(await fs.readFile(join(offline, 'original.mp4')), bytes, 'Original synthetic footage was preserved');
        console.log('PASS: independent clip/thumbnail lifetime, duplicate/overlapping discovery, stable active paths, unavailable-path replacement, queued-path protection, directory recovery, per-file validation, draft/receipt/custom-thumbnail preservation, and stale-scan cancellation.');
    } finally {
        releaseThumbnail?.(); releaseFingerprint?.();
        await scanner?.close();
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
