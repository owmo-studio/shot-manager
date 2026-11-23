// Real rsync and synthetic video fixtures only. Never consult application settings or NAS paths.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { execFile } = require('node:child_process');
const execute = require('node:util').promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, description) {
    for (let i = 0; i < 600; i++) { if (await test()) return; await wait(20); }
    throw new Error(`Timed out: ${description}`);
}

process.exitCode = 1; // An unresolved fixture promise must never produce a passing exit.
(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'owmo-ingest-check-')));
    let scanner, queue, server, releaseRefresh, releasePreparation;
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, ['server/ingestion.ts', 'server/scanner.ts', 'server/library.ts', 'server/rsync.ts', 'server/app.ts', 'server/workspace.ts'].map(path => `export * from ${JSON.stringify(join(__dirname, '..', path))};`).join('\n'));
        const { build } = await import('vite');
        const bundle = await build({ configFile: false, logLevel: 'silent', build: { ssr: true, write: false,
            rollupOptions: { input: entry, external: ['fastify'], output: { format: 'cjs' } } } });
        const Module = require('node:module');
        const loaded = new Module(__filename, module); loaded.paths = module.paths;
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { ShotScanner, IngestQueue, inspectLibrary, rsyncFile, createServer } = loaded.exports;
        const source = join(root, 'source'), library = join(root, 'library'), other = join(root, 'other');
        await Promise.all([source, library, other].map(path => fs.mkdir(path)));
        for (const [index, color] of ['blue', 'red', 'green'].entries()) {
            await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=10`, '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(source, `clip-${index}.MP4`)]);
        }
        const originals = await Promise.all((await fs.readdir(source)).map(async name => [name, await fs.readFile(join(source, name))]));
        const organization = join(root, 'organization.json');
        scanner = new ShotScanner(join(root, 'thumbs'), join(root, 'fingerprints'), organization);
        scanner.discover({ id: 'test-source', path: source, name: 'Synthetic', type: 'folder', cameraModels: [], available: true });
        await until(() => scanner.snapshot().shots.length === 3 && scanner.snapshot().shots.every(shot => shot.thumbnailStatus === 'ready'), 'synthetic scan/thumbnails');
        const shots = scanner.snapshot().shots;
        const [a, b, c] = shots;
        const ids = shots.map(shot => shot.id);
        let configured = library, mountChanged = false, fail = false, gate = false;
        let entered = false, release;
        const inspect = async (...args) => {
            const location = await inspectLibrary(...args);
            return mountChanged ? { ...location, identity: 'replaced-volume' } : location;
        };
        const transfer = async (from, to, signal, progress, force) => {
            if (gate) {
                entered = true;
                await new Promise((resolve, reject) => {
                    release = resolve;
                    signal.addEventListener('abort', () => reject(new Error('Stopped fixture')), { once: true });
                });
            }
            if (fail) throw new Error('Synthetic transfer failure');
            await rsyncFile(from, to, signal, progress, force);
        };
        queue = new IngestQueue(scanner, async () => configured, inspect, transfer);
        const changes = [];
        const prematureCompletion = [];
        queue.onChange = status => {
            changes.push(status);
            if (status.current?.percent === 100 && !scanner.snapshot().shots.find(shot => shot.id === status.current.id)?.ingestion) {
                prematureCompletion.push(status);
            }
        };
        const finish = () => until(async () => !(await queue.status()).active, 'queue completion');
        await queue.refreshLibrary();
        const idleEvents = changes.length;
        await wait(350);
        assert.equal(changes.length, idleEvents, 'Idle queue emits no periodic notifications');
        const review = await queue.preview(ids);
        assert.equal(review.clips.length, 3);
        assert.ok(review.clips.every(clip => clip.mode === 'new' && clip.files.length === 3));
        assert.ok(review.clips.every(clip => clip.files[0].to.endsWith('.source.mp4')));
        assert.equal((await fs.readdir(library)).length, 0, 'Review does not write Library files');
        gate = true;
        await queue.submit(review.token, [a.id, b.id]); // X removal leaves c out of queue.
        await until(() => entered, 'first active transfer');
        assert.equal(scanner.snapshot().shots.filter(shot => !shot.editable).length, 2);
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === c.id).organization.skipped, false);
        await assert.rejects(scanner.updateOrganization([a.id], { field: 'notes', operation: 'set', value: 'locked' }), /locked/);
        await assert.rejects(scanner.setThumbnail(a.id, 'data:image/jpeg;base64,/9j/2Q=='), /queued/);
        await assert.rejects(scanner.clearCache(), error => error.statusCode === 409);
        await assert.rejects(scanner.clearLocalData(), error => error.statusCode === 409);
        await assert.rejects(queue.revert([a.id]), /Selected clips are locked/);
        assert.throws(() => scanner.previewOptions({ identity: [], project: [], tags: [] }), /Wait for scanning/);
        gate = false; release();
        await finish();
        assert.equal((await queue.status()).errors.length, 0);
        assert.deepEqual(prematureCompletion, [], '100% is not reported before the successful processing receipt is saved');
        assert.ok(changes.some(status => status.current?.percent === 100), 'Successful completion reports 100%');
        assert.ok(changes.some(status => status.current?.phase === 'metadata' && status.current.percent === 99), 'Progress stays below 100% while metadata publication is pending');
        assert.ok(changes.some(status => status.active && status.current?.phase === 'transferring'));
        assert.ok(changes.some(status => status.active && status.current?.phase === 'metadata'));
        assert.equal(changes.at(-1).active, false, 'Completion is notified immediately');
        assert.ok(changes.every((status, index) => !index || status.revision > changes[index - 1].revision), 'Notifications have increasing revisions');
        const jsonPath = join(library, `${a.id}.metadata.json`);
        const json = JSON.parse(await fs.readFile(jsonPath));
        for (const [key, value] of Object.entries({ identity: null, project: null, scene: '', notes: '', tags: [], group: '', camera: '', rating: null })) assert.deepEqual(json[key], value);
        assert.equal(json.originalFilename, a.filename);
        assert.equal(json.id, a.id);
        assert.equal(json.ingestion.transfer, 'rsync');
        assert.deepEqual(await fs.readFile(join(library, `${a.id}.source.mp4`)), await fs.readFile(join(source, a.filename)));
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'synced');
        assert.ok(!await fs.stat(join(library, `${c.id}.metadata.json`)).catch(() => null));
        assert.ok((await scanner.snapshot()).shots.every(shot => shot.editable));
        // Revert restores selected Library attributes and thumbnails as one local batch.
        const revertReceipt = scanner.snapshot().shots.find(shot => shot.id === a.id).ingestion;
        const libraryJSON = await fs.readFile(jsonPath);
        const aThumbPath = join(library, `${a.id}.thumb.jpg`), bThumbPath = join(library, `${b.id}.thumb.jpg`);
        const aLibraryThumb = await fs.readFile(aThumbPath), bLibraryThumb = await fs.readFile(bThumbPath);
        const alternateThumb = await scanner.thumbnail(c.id);
        await scanner.setThumbnail(a.id, alternateThumb);
        const changedThumbnailRevision = scanner.snapshot().shots.find(shot=>shot.id===a.id).thumbnailRevision;
        for (const action of [
            { field: 'identity', operation: 'add', value: 'Changed Identity' },
            { field: 'project', operation: 'add', value: 'Changed Project' },
            { field: 'scene', operation: 'set', value: 'Changed scene' },
            { field: 'notes', operation: 'set', value: 'Changed notes' },
            { field: 'tags', operation: 'add', value: 'changed' },
            { field: 'skip', operation: 'set', value: 'true' },
        ]) await scanner.updateOrganization([a.id], action);
        await queue.revert([a.id]);
        let reverted = scanner.snapshot().shots.find(shot => shot.id === a.id);
        assert.deepEqual(reverted.organization, { identity: null, project: null, scene: '', notes: '', tags: [], group: '', camera: '', rating: null, skipped: true });
        assert.deepEqual(reverted.ingestion, revertReceipt, 'Revert preserves the successful processing record');
        assert.equal(reverted.ingestState, 'synced', 'Restoring Library attributes restores Synced');
        assert.deepEqual(Buffer.from((await scanner.thumbnail(a.id)).split(',')[1],'base64'), aLibraryThumb, 'Revert restores the exact committed thumbnail');
        assert.ok(reverted.thumbnailRevision > changedThumbnailRevision, 'Restored thumbnails invalidate renderer caches');
        assert.deepEqual(await fs.readFile(aThumbPath),aLibraryThumb,'Revert never writes the Library thumbnail');
        assert.deepEqual(await fs.readFile(jsonPath), libraryJSON, 'Revert never writes Library metadata');
        await scanner.updateOrganization([a.id], { field: 'skip', operation: 'set', value: 'false' });

        await scanner.updateOrganization([a.id], { field: 'notes', operation: 'set', value: 'Keep if restore fails' });
        await scanner.setThumbnail(a.id,alternateThumb);
        const localThumbBeforeFailure = await scanner.thumbnail(a.id);
        await fs.writeFile(bThumbPath,'invalid JPEG');
        await assert.rejects(queue.revert([a.id,b.id]),/thumbnail is invalid/);
        assert.equal(await scanner.thumbnail(a.id),localThumbBeforeFailure,'Invalid thumbnail rejects the entire batch');
        assert.equal(scanner.snapshot().shots.find(shot=>shot.id===a.id).organization.notes,'Keep if restore fails');
        await fs.unlink(bThumbPath);
        await assert.rejects(queue.revert([a.id,b.id]),/thumbnail is missing/);
        await fs.symlink(aThumbPath,bThumbPath);
        await assert.rejects(queue.revert([a.id,b.id]),/not a regular file/);
        await fs.unlink(bThumbPath); await fs.writeFile(bThumbPath,bLibraryThumb);
        const draftsBeforeFailure = await fs.readFile(organization);
        const save = scanner.organization.save.bind(scanner.organization);
        scanner.organization.save = async()=>{throw new Error('Synthetic Revert save failure');};
        try { await assert.rejects(queue.revert([a.id,b.id]),/Synthetic Revert save failure/); }
        finally { scanner.organization.save=save; }
        assert.equal(await scanner.thumbnail(a.id),localThumbBeforeFailure,'Draft-save failure rolls thumbnails back');
        assert.deepEqual(await fs.readFile(organization),draftsBeforeFailure,'Failed Revert preserves persisted drafts and receipts');
        const stage = scanner.thumbnailQueue.stageRevertImages.bind(scanner.thumbnailQueue);
        scanner.thumbnailQueue.stageRevertImages=async(...args)=>{
            const batch=await stage(...args);
            return {...batch,commit:async valid=>{let checked=0;return batch.commit(()=>++checked===1&&valid());}};
        };
        try { await assert.rejects(queue.revert([a.id,b.id]),/Selected clips changed/); }
        finally { scanner.thumbnailQueue.stageRevertImages=stage; }
        assert.equal(await scanner.thumbnail(a.id),localThumbBeforeFailure,'Partially published thumbnail batch rolls back');
        assert.deepEqual(await fs.readFile(organization),draftsBeforeFailure);
        assert.equal((await fs.readdir(join(root,'thumbs'))).filter(name=>name.endsWith('.tmp')).length,0,'Success and rollback clean staging files');
        const bJSONPath = join(library, `${b.id}.metadata.json`);
        const bJSON = await fs.readFile(bJSONPath);
        await fs.writeFile(bJSONPath, '{broken');
        await assert.rejects(queue.revert([a.id, b.id]), /invalid JSON/);
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).organization.notes, 'Keep if restore fails', 'Bulk revert is all-or-nothing');
        await fs.writeFile(bJSONPath, JSON.stringify({ ...JSON.parse(bJSON), id: a.id }));
        await assert.rejects(queue.revert([b.id]), /does not match/);
        await fs.writeFile(bJSONPath, JSON.stringify({ ...JSON.parse(bJSON), tags: 'invalid' }));
        await assert.rejects(queue.revert([b.id]), /Invalid Library attributes/);
        await fs.unlink(bJSONPath);
        await assert.rejects(queue.revert([b.id]), /metadata is missing/);
        await fs.symlink(jsonPath, bJSONPath);
        await assert.rejects(queue.revert([b.id]), /not a regular file/);
        await fs.unlink(bJSONPath);
        await fs.writeFile(bJSONPath, bJSON);
        const externalAttributes = { identity: 'Library Identity', project: 'Library Project', scene: 'Library scene', group:'TH01-T02',camera:'B',rating:'usable',notes: 'Library notes', tags: ['library/value'] };
        await fs.writeFile(bJSONPath, JSON.stringify({ ...JSON.parse(bJSON), ...externalAttributes }));
        const restoredExternal = await queue.revert([b.id]);
        assert.deepEqual(scanner.snapshot().shots.find(shot => shot.id === b.id).organization, { ...externalAttributes, skipped: false }, 'Revert restores current Library values, including nonempty attributes');
        assert.ok(restoredExternal.vocabulary.identity.includes('Library Identity') && restoredExternal.vocabulary.project.includes('Library Project'), 'Restored Identity and Project remain available as options');
        await fs.writeFile(bJSONPath, bJSON);
        await assert.rejects(queue.revert(['../arbitrary']), /no longer available|Invalid clip ID/);
        await assert.rejects(scanner.revertOrganization([a.id], async () => {
            await scanner.updateOrganization([a.id], { field: 'notes', operation: 'set', value: 'Newer local edit' });
            return [json];
        }), /Selected clips changed/);
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).organization.notes, 'Newer local edit', 'Revert does not overwrite concurrent local edits');
        await queue.revert([a.id, b.id]);
        assert.ok(scanner.snapshot().shots.filter(shot => [a.id, b.id].includes(shot.id)).every(shot => shot.ingestState === 'synced'), 'Bulk revert restores both clips');
        const sourceBefore = await fs.stat(join(library, `${a.id}.source.mp4`));
        await fs.writeFile(join(library, `${a.id}.proxy.mov`), 'leave proxy untouched');
        await scanner.updateOrganization([a.id], { field: 'notes', operation: 'set', value: 'Later notes' });
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'changes-pending');
        await scanner.updateOrganization([a.id], { field: 'notes', operation: 'set', value: '' });
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'synced', 'Reverting restores synced');
        await scanner.updateOrganization([a.id], { field: 'skip', operation: 'set', value: 'true' });
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'synced', 'Skip does not alter receipt');
        await scanner.updateOrganization([a.id], { field: 'skip', operation: 'set', value: 'false' });
        await scanner.updateOrganization([a.id], { field: 'notes', operation: 'set', value: 'Later notes' });
        const extended = JSON.parse(await fs.readFile(jsonPath));
        extended.otherTool = { labels: ['keep'] };
        extended.metadata.device.serial = 'external';
        await fs.writeFile(jsonPath, JSON.stringify(extended));
        const replacement = await queue.preview([a.id]);
        assert.equal(replacement.clips[0].mode, 'replace');
        await queue.submit(replacement.token, [a.id]); await finish();
        assert.equal((await fs.stat(join(library, `${a.id}.source.mp4`))).ino, sourceBefore.ino, 'Unchanged source is not recopied');
        const replaced = JSON.parse(await fs.readFile(jsonPath));
        assert.equal(replaced.notes, 'Later notes');
        assert.deepEqual(replaced.otherTool, extended.otherTool);
        assert.deepEqual(replaced.metadata, extended.metadata);
        assert.equal(await fs.readFile(join(library, `${a.id}.proxy.mov`), 'utf8'), 'leave proxy untouched');

        // Stale reviews and newly arrived conflicts require another review.
        let plan = await queue.preview([c.id]);
        await scanner.updateOrganization([c.id], { field: 'scene', operation: 'set', value: 'Changed after review' });
        await assert.rejects(queue.submit(plan.token, [c.id]), /changed since review/);
        assert.ok(scanner.snapshot().shots.every(shot => shot.editable));
        plan = await queue.preview([c.id]);
        await fs.writeFile(join(library, `${c.id}.metadata.json`), 'unexpected existing data');
        await assert.rejects(queue.submit(plan.token, [c.id]), /changed after review/);
        assert.equal(await fs.readFile(join(library, `${c.id}.metadata.json`), 'utf8'), 'unexpected existing data');
        await fs.unlink(join(library, `${c.id}.metadata.json`));
        plan = await queue.preview([c.id]);
        mountChanged = true;
        await assert.rejects(queue.submit(plan.token, [c.id]), /mounted volume changed/);
        mountChanged = false;
        assert.ok(!await fs.stat(join(library, `${c.id}.source.mp4`)).catch(() => null));
        await fs.symlink(join(source, c.filename), join(library, `${c.id}.source.mp4`));
        await assert.rejects(queue.preview([c.id]), /not a regular file/);
        await fs.unlink(join(library, `${c.id}.source.mp4`));
        await fs.writeFile(join(library, `${c.id}.source.mov`), 'conflicting role');
        await assert.rejects(queue.preview([c.id]), /different extension/);
        await fs.unlink(join(library, `${c.id}.source.mov`));
        await assert.rejects(inspectLibrary(source, [source]), /different folders/);
        await assert.rejects(inspectLibrary(join('/Volumes', `owmo-absent-${process.pid}`)), /not mounted/);

        // A renderer can see and stop a queue even while submission validation is still running.
        plan = await queue.preview([c.id]);
        const capture = scanner.captureIngest.bind(scanner);
        let preparingEntered = false;
        scanner.captureIngest = async id => {
            const result = await capture(id);
            preparingEntered = true;
            await new Promise(resolve => { releasePreparation = resolve; });
            return result;
        };
        const submitting = queue.submit(plan.token, [c.id]);
        const rejectedSubmission = assert.rejects(submitting, /aborted/);
        await until(() => preparingEntered, 'submission preparation');
        assert.equal((await queue.status()).active, true, 'Preparing queue is visible after renderer reload');
        const stoppingPreparation = queue.stop();
        releasePreparation();
        await rejectedSubmission; await stoppingPreparation;
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === c.id).editable, true);
        scanner.captureIngest = capture;
        assert.equal((await queue.status()).active, false);
        assert.ok(!await fs.stat(join(library, `${c.id}.source.mp4`)).catch(() => null));

        // Stop preserves completed receipts and pending replacement edits; all queued locks clear.
        await scanner.updateOrganization([a.id], { field: 'notes', operation: 'set', value: 'Pending cancelled replacement' });
        plan = await queue.preview([a.id, c.id]);
        entered = false; gate = true;
        await queue.submit(plan.token, [a.id, c.id]);
        await until(() => entered, 'cancellable transfer');
        await queue.stop(); gate = false;
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === c.id).editable, true, 'Stopped clip is unlocked');
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'changes-pending');
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === b.id).ingestState, 'synced');
        assert.equal(JSON.parse(await fs.readFile(jsonPath)).notes, 'Later notes', 'Cancelled replacement preserves old JSON');
        assert.equal((await queue.status()).errors.length, 0, 'Cancellation is not failure');
        assert.ok(scanner.snapshot().shots.every(shot => shot.editable));

        // Failed entries are removed/unlocked, error retained until dismissed, next clip proceeds.
        plan = await queue.preview([c.id, a.id]);
        let first = true;
        const failedQueue = new IngestQueue(scanner, async () => library, inspect, async (...args) => {
            if (first) { first = false; throw new Error('Synthetic disk full'); }
            return rsyncFile(...args);
        });
        plan = await failedQueue.preview([c.id, a.id]);
        await failedQueue.submit(plan.token, [c.id, a.id]);
        await until(async () => !(await failedQueue.status()).active, 'failure and continuation');
        let failedStatus = await failedQueue.status();
        assert.equal(failedStatus.errors.length, 1);
        assert.match(failedStatus.errors[0].message, /disk full/);
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'synced', 'Next item still completes');
        assert.ok(!await fs.stat(join(library, `${c.id}.metadata.json`)).catch(() => null), 'Failed transfer publishes no JSON');
        failedQueue.dismissError(failedStatus.errors[0].eventId);
        assert.equal((await failedQueue.status()).errors.length, 0);
        await failedQueue.close();

        // A disappeared/replaced destination after the video copy cannot redirect later writes.
        const disconnected = join(root, 'disconnected-library'), retained = join(root, 'retained-library');
        await fs.mkdir(disconnected);
        let displaced = false;
        const disconnectQueue = new IngestQueue(scanner, async () => disconnected, inspectLibrary, async (...args) => {
            await rsyncFile(...args);
            if (!displaced) { displaced = true; await fs.rename(disconnected, retained); await fs.mkdir(disconnected); }
        });
        plan = await disconnectQueue.preview([c.id]);
        await disconnectQueue.submit(plan.token, [c.id]);
        await until(async () => !(await disconnectQueue.status()).active, 'destination replacement detection');
        assert.match((await disconnectQueue.status()).errors[0].message, /mounted volume changed/);
        assert.deepEqual(await fs.readdir(disconnected), [], 'No subsequent writes fall through to replacement directory');
        assert.ok(!await fs.stat(join(retained, `${c.id}.metadata.json`)).catch(() => null));
        await disconnectQueue.close();
        await queue.refreshLibrary();

        // A changed custom thumbnail invalidates sync; unchanged custom image does not.
        const custom = await scanner.thumbnail(b.id);
        await scanner.setThumbnail(a.id, custom);
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'changes-pending');
        plan = await queue.preview([a.id]); await queue.submit(plan.token, [a.id]); await finish();
        await scanner.setThumbnail(a.id, custom);
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'synced');

        // Deleting Library assets invalidates the badge, but an offline Library is never "new".
        const storedNames = [`${a.id}.source.mp4`, `${a.id}.thumb.jpg`, `${a.id}.metadata.json`];
        const savedAssets = await Promise.all(storedNames.map(name => fs.readFile(join(library, name))));
        await fs.unlink(join(library, storedNames[0]));
        await queue.refreshLibrary();
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'changes-pending', 'Remaining Library assets need an update, not a New card');
        await fs.writeFile(join(library, storedNames[0]), savedAssets[0]);
        await queue.refreshLibrary();
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'synced');
        await Promise.all(storedNames.map(name => fs.unlink(join(library, name))));
        await queue.refreshLibrary();
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, undefined, 'Deleted shot becomes eligible again');
        plan = await queue.preview([a.id]);
        assert.equal(plan.clips[0].mode, 'new', 'Deleted shot is reviewed as New despite its saved receipt');
        // Hold transfer, then hold a refresh after its listing but before it is applied.
        // The Commit must remain Synced when that older refresh finally returns.
        entered = false; gate = true;
        await queue.submit(plan.token, [a.id]);
        await until(() => entered, 'transfer before concurrent presence refresh');
        const inspectBeforeRefresh = queue.inspect;
        let refreshChecks = 0, refreshHeld = false;
        queue.inspect = async (...args) => {
            const location = await inspectBeforeRefresh(...args);
            if (++refreshChecks === 2) {
                refreshHeld = true;
                await new Promise(resolve => { releaseRefresh = resolve; });
            }
            return location;
        };
        const refreshing = queue.refreshLibrary();
        await until(() => refreshHeld, 'Library refresh after listing');
        gate = false; release(); await finish();
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'unverified', 'In-flight presence is explicitly unverified');
        releaseRefresh(); await refreshing;
        queue.inspect = inspectBeforeRefresh;
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'synced', 'Slow refresh preserves a newer completed Commit');
        const presentReceipt = scanner.snapshot().shots.find(shot => shot.id === a.id).ingestion;
        const offlineQueue = new IngestQueue(scanner, async () => library, async () => { throw new Error('Synthetic offline Library'); });
        await offlineQueue.status();
        await until(async () => (await offlineQueue.status()).libraryScan?.state === 'unavailable', 'offline Library');
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'unverified');
        assert.deepEqual(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestion, presentReceipt, 'Unavailability preserves receipts');
        await assert.rejects(offlineQueue.revert([a.id]), /Synthetic offline Library/);
        await offlineQueue.close();
        await queue.refreshLibrary();

        await fs.writeFile(join(library, `${a.id}.source.mp4.partial`), 'unfinished');
        await fs.writeFile(join(library, `${c.id}.source.partial`), 'unfinished');
        await queue.refreshLibrary();
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'synced', 'Partial files are not extra source assets');
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === c.id).ingestState, undefined, 'Temporary files alone do not make a clip an update');
        assert.equal((await queue.preview([c.id])).clips[0].mode, 'new', 'Partial files do not create completed shots or conflicts');
        await fs.unlink(join(library, `${a.id}.source.mp4.partial`));
        await fs.unlink(join(library, `${c.id}.source.partial`));

        // Actual rsync process cancellation, not just our injected gate.
        const large = join(root, 'large.bin'), cancelled = join(library, 'cancelled-test.bin');
        await fs.writeFile(large, Buffer.alloc(1024 * 1024));
        const abort = new AbortController();
        const transferring = rsyncFile(large, cancelled, abort.signal, () => {});
        abort.abort();
        await assert.rejects(transferring, /stopped/);

        // Reloading sources restores receipts; changing Library makes clips eligible.
        await queue.close(); await scanner.close();
        scanner = new ShotScanner(join(root, 'thumbs'), join(root, 'fingerprints'), organization);
        scanner.setIngestLibrary(library);
        scanner.discover({ id: 'reloaded', path: source, name: 'Synthetic', type: 'folder', cameraModels: [], available: true });
        await until(() => scanner.snapshot().shots.length === 3 && scanner.snapshot().shots.every(shot => shot.thumbnailStatus === 'ready'), 'reload scan');
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'unverified', 'A receipt alone is not a presence check');
        const restartedQueue = new IngestQueue(scanner, async () => library);
        await restartedQueue.status();
        await until(async () => (await restartedQueue.status()).libraryScan?.state === 'ready', 'startup Library scan');
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, 'synced');
        await restartedQueue.close();
        // An existing Library shot is still an Update when local receipts are absent.
        const freshScanner = new ShotScanner(join(root, 'fresh-thumbs'), join(root, 'fresh-fingerprints'), join(root, 'fresh-drafts.json'));
        const noReceiptQueue = new IngestQueue(freshScanner, async () => library);
        try {
            freshScanner.discover({ id: 'fresh-source', path: source, name: 'Synthetic', type: 'folder', cameraModels: [], available: true });
            await until(() => freshScanner.snapshot().shots.length === 3 && freshScanner.snapshot().shots.every(shot => shot.thumbnailStatus === 'ready'), 'scan without local receipts');
            await noReceiptQueue.refreshLibrary();
            const existing = freshScanner.snapshot().shots.find(shot => shot.id === a.id);
            assert.equal(existing.ingestion, undefined, 'Fixture has no local receipt');
            assert.equal(existing.ingestState, 'changes-pending', 'Existing Library shot needs syncing without a receipt');
            assert.equal(freshScanner.snapshot().shots.find(shot => shot.id === c.id).ingestState, undefined, 'A genuinely new clip stays neutral');
            assert.equal((await noReceiptQueue.preview([a.id])).clips[0].mode, 'replace', 'Card status agrees with Update review');
        } finally { await noReceiptQueue.close(); await freshScanner.close(); }
        scanner.setIngestLibrary(other);
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === a.id).ingestState, undefined);
        const removedB = [`${b.id}.source.mp4`, `${b.id}.thumb.jpg`, `${b.id}.metadata.json`];
        await Promise.all(removedB.map(name => fs.unlink(join(library, name))));
        const startupQueue = new IngestQueue(scanner, async () => library);
        await startupQueue.status();
        await until(async () => (await startupQueue.status()).libraryScan?.state === 'ready', 'deleted asset startup check');
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === b.id).ingestState, undefined, 'Startup detects Library deletion');
        assert.equal((await startupQueue.preview([b.id])).clips[0].mode, 'new');
        await startupQueue.close();
        const freshQueue = new IngestQueue(scanner, async () => other);
        assert.equal((await freshQueue.status()).active, false, 'Queues do not persist');
        await freshQueue.close();

        // Authenticated API takes IDs, never renderer-supplied destinations.
        const configuration = join(root, 'configuration.json');
        await fs.writeFile(configuration, JSON.stringify({ version: 1, libraryPath: library, libraryMount: (await inspectLibrary(library)).mount }));
        server = createServer('test-token', undefined, join(root, 'api-thumbs'), join(root, 'api-fps'), join(root, 'api-drafts.json'), configuration);
        assert.equal((await server.inject({ method: 'GET', url: '/api/ingestion' })).statusCode, 401);
        assert.equal((await server.inject({ method: 'GET', url: '/api/library' })).statusCode, 401);
        assert.equal((await server.inject({ method: 'POST', url: '/api/library/review', headers: { authorization: 'Bearer test-token' }, payload: { shotIds: ['../../arbitrary'] } })).statusCode, 400, 'Library review accepts IDs, never paths');
        assert.equal((await server.inject({ method: 'POST', url: '/api/organization/revert', payload: { shotIds: [a.id] } })).statusCode, 401);
        assert.equal((await server.inject({ method: 'POST', url: '/api/organization/revert', headers: { authorization: 'Bearer test-token' }, payload: { shotIds: ['../../arbitrary'] } })).statusCode, 400, 'Revert accepts clip IDs, never paths');
        assert.equal((await server.inject({ method: 'POST', url: '/api/ingestion/review', headers: { authorization: 'Bearer test-token' }, payload: { shotIds: [a.id], path: source } })).statusCode, 409);
        assert.equal((await server.inject({ method: 'GET', url: '/api/ingestion', headers: { authorization: 'Bearer test-token' } })).json().active, false);
        await server.close(); server = null;
        for (const [name, contents] of originals) assert.deepEqual(await fs.readFile(join(source, name)), contents, 'Original synthetic footage untouched');
        console.log('PASS: rsync ingestion, empty attributes, review/removal/replacement, locks, quick-check reuse, cancellation, failures, stale conflicts/mount changes, source reload, receipts, Library deletion/startup/offline checks, concurrent refresh/publication, and API access checks.');
    } finally {
        releasePreparation?.();
        releaseRefresh?.();
        await queue?.close(); await scanner?.close(); await server?.close();
        await fs.rm(root, { recursive: true, force: true });
    }
})().then(() => { process.exitCode = 0; }).catch(error => { console.error(error); process.exitCode = 1; });
