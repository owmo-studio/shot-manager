// Appendable Commits: synthetic originals and temporary local Library only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const execute = require('node:util').promisify(require('node:child_process').execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) { for (let i = 0; i < 750; i++) { if (await test()) return; await sleep(20); } throw new Error(`Timed out: ${label}`); }
(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'owmo-append-')));
    let manager, queue, release, releaseCapture, releaseExport;
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, ['server/workspace.ts', 'server/ingestion.ts', 'server/library.ts', 'server/rsync.ts']
            .map(path => `export * from ${JSON.stringify(resolve(path))};`).join('\n'));
        const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: {
            ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'cjs' } },
        } });
        const loaded = new (require('node:module'))(__filename, module); loaded.paths = module.paths;
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { WorkspaceManager, IngestQueue, inspectLibrary, rsyncFile } = loaded.exports;
        const input = join(root, 'input'), library = join(root, 'library');
        await fs.mkdir(input); await fs.mkdir(library);
        for (const [name, color] of [['a', 'blue'], ['b', 'red'], ['c', 'green'], ['d', 'yellow']])
            await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=10`, '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(input, `${name}.mp4`)]);
        const originals = await Promise.all((await fs.readdir(input)).map(async name => [name, await fs.readFile(join(input, name))]));
        manager = new WorkspaceManager(join(root, 'thumbs'), join(root, 'fingerprints'), join(root, 'metadata.json'));
        const scanner = manager.scanner;
        let hold = true, entered = false;
        queue = new IngestQueue(scanner, async () => library, inspectLibrary, async (...args) => {
            if (hold && args[0] === join(input, 'a.mp4')) {
                hold = false; entered = true;
                await new Promise((resolve, reject) => {
                    const abort = () => reject(new Error('Stopped fixture transfer'));
                    args[2].addEventListener('abort', abort, { once: true });
                    release = () => { args[2].removeEventListener('abort', abort); resolve(); };
                });
            }
            await rsyncFile(...args);
        });
        scanner.onChange = () => queue.backgroundChanged();
        await queue.status(); await manager.add(input);
        await until(() => scanner.snapshot().shots.length === 4 && scanner.snapshot().shots.every(shot => shot.thumbnailStatus === 'ready'), 'discovery');
        const { 'a.mp4': a, 'b.mp4': b, 'c.mp4': c, 'd.mp4': d } = Object.fromEntries(scanner.snapshot().shots.map(shot => [shot.filename, shot]));
        let plan = await queue.preview([a.id]); await queue.submit(plan.token, [a.id]);
        await until(() => entered, 'held transfer');
        const firstTotal = (await queue.status()).tasks.total;
        plan = await queue.preview([a.id, b.id]);
        assert.deepEqual(plan.clips.map(clip => clip.id), [b.id], 'Already queued clips excluded from review');
        await scanner.updateOrganization([b.id], { field: 'notes', operation: 'set', value: 'Changed after review' });
        await assert.rejects(queue.submit(plan.token, [b.id]), /changed since review/);
        assert.equal((await queue.status()).current.id, a.id, 'Rejected append preserves active transfer');
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === b.id).editable, true);
        plan = await queue.preview([b.id]);
        await fs.writeFile(join(library, `${b.id}.source.mp4`), 'new conflict after review');
        await assert.rejects(queue.submit(plan.token, [b.id]), /changed after review/);
        assert.equal((await queue.status()).current.id, a.id, 'New conflict rejects only the append');
        await fs.unlink(join(library, `${b.id}.source.mp4`));
        plan = await queue.preview([b.id, c.id]); await queue.submit(plan.token, [b.id, c.id]);
        let status = await queue.status();
        assert.equal(status.current.id, a.id); assert.equal(status.total, 3);
        assert.equal(status.tasks.total, firstTotal + 2, 'Append retains existing progress task identities');
        await assert.rejects(queue.submit(plan.token, [b.id]), /expired/);
        await assert.rejects(queue.eject([c.id]), error => error.code === 'CLIP_COMMIT_ACTIVE');
        await queue.cancel([c.id]);
        assert.ok(scanner.snapshot().shots.find(shot => shot.id === c.id)?.editable, 'Cancel keeps the clip editable in the workspace');
        await scanner.updateOrganization([c.id], { field: 'notes', operation: 'set', value: 'Edit after cancellation' });
        const requeue = await queue.preview([c.id]); await queue.submit(requeue.token, [c.id]);
        await queue.cancel([c.id]);
        assert.equal(scanner.snapshot().shots.find(shot => shot.id === c.id)?.organization.notes, 'Edit after cancellation');
        assert.equal((await queue.status()).current.id, a.id);
        assert.equal((await queue.status()).tasks.transfersRemaining, 2);
        // The previous worker may drain while the next reviewed submission is being validated.
        plan = await queue.preview([d.id]);
        const capture = scanner.captureIngest.bind(scanner);
        let captured = false;
        scanner.captureIngest = async id => {
            const result = await capture(id);
            if (id === d.id) { captured = true; await new Promise(resolve => { releaseCapture = resolve; }); }
            return result;
        };
        const appending = queue.submit(plan.token, [d.id]);
        await until(() => captured, 'append validation held');
        release();
        await until(() => scanner.snapshot().shots.find(shot => shot.id === b.id)?.ingestState === 'synced', 'previous entries drain');
        assert.equal((await queue.status()).active, true, 'Queue stays alive for an accepted submission being validated');
        releaseCapture(); await appending; scanner.captureIngest = capture;
        await until(async () => !(await queue.status()).active, 'appended transfer completes');
        status = await queue.status(); assert.equal(status.completed, 3); assert.equal(status.tasks.percent, 100);
        assert.equal(status.tasks.transfersRemaining, 0); assert.deepEqual(status.errors, []);
        for (const shot of [a, b, d]) assert.ok(await fs.stat(join(library, `${shot.id}.metadata.json`)));
        assert.equal(await fs.stat(join(library, `${c.id}.metadata.json`)).catch(() => null), null);
        // Stop during an append invalidates the new review and cannot restart transfers.
        await scanner.updateOrganization([a.id, b.id], { field: 'scene', operation: 'set', value: 'Second pass' });
        assert.equal(scanner.snapshot().shots.find(shot=>shot.id===d.id)?.ingestState,'synced','Completed clips remain until another Commit begins');
        await queue.refreshLibrary();
        assert.ok(scanner.snapshot().shots.some(shot=>shot.id===d.id),'Refresh does not retire synced clips');
        const retainedReceipt=await scanner.organization.ingestion(d.fingerprint);
        hold = true; entered = false;
        plan = await queue.preview([a.id]);
        assert.ok(scanner.snapshot().shots.some(shot=>shot.id===d.id),'Selected-only Commit leaves green clips alone');
        assert.ok(!plan.clips.some(clip=>clip.id===d.id));
        plan = await queue.preview([a.id,d.id],true);
        assert.equal(plan.clips.find(clip=>clip.id===d.id).mode,'synced','Unselected scope can review green clips as workspace removals');
        assert.ok(scanner.snapshot().shots.some(shot=>shot.id===d.id),'Review alone never removes a green clip');
        await queue.submit(plan.token, [a.id]);
        await until(() => entered, 'second held transfer');
        assert.ok(scanner.snapshot().shots.some(shot=>shot.id===d.id),'Excluding a synced row preserves it after confirmation');
        const removal=await queue.preview([d.id],true);
        await scanner.updateOrganization([d.id],{field:'rating',operation:'set',value:'preferred'});
        await assert.rejects(queue.submit(removal.token,[d.id]),/changed after review/,'New edits invalidate removal');
        assert.ok(scanner.snapshot().shots.some(shot=>shot.id===d.id));
        await scanner.updateOrganization([d.id],{field:'rating',operation:'set',value:''});
        const metadataBeforeRemoval=await fs.readFile(join(library,`${d.id}.metadata.json`));
        const removalOnly=await queue.preview([d.id],true), workBeforeRemoval=await queue.status();
        await queue.submit(removalOnly.token,[d.id]);
        assert.ok(!scanner.snapshot().shots.some(shot=>shot.id===d.id),'Included green clips leave only after confirmation');
        assert.equal((await queue.status()).current.id,a.id,'Removal does not interrupt an existing transfer');
        assert.equal((await queue.status()).total,workBeforeRemoval.total,'Workspace removals add no transfer tasks');
        assert.ok(scanner.snapshot().shots.some(shot=>shot.id===b.id)&&scanner.snapshot().shots.some(shot=>shot.id===c.id),'Changed and new clips remain');
        assert.deepEqual(await scanner.organization.ingestion(d.fingerprint),retainedReceipt,'Retirement preserves the receipt');
        assert.deepEqual(await fs.readFile(join(library,`${d.id}.metadata.json`)),metadataBeforeRemoval,'Retirement never writes Library assets');
        plan = await queue.preview([b.id]); captured = false;
        scanner.captureIngest = async id => { const result = await capture(id); captured = true; await new Promise(resolve => { releaseCapture = resolve; }); return result; };
        const cancelledAppend = queue.submit(plan.token, [b.id]);
        await until(() => captured, 'Cancel during append validation');
        const cancelling = queue.cancel([b.id]); releaseCapture(); await cancelledAppend; await cancelling;
        assert.equal((await queue.status()).current.id, a.id, 'Cancelling validation leaves unrelated transfer active');
        assert.ok(scanner.snapshot().shots.find(shot => shot.id === b.id)?.editable);
        scanner.captureIngest = capture;
        plan = await queue.preview([b.id]); captured = false;
        scanner.captureIngest = async id => { const result = await capture(id); captured = true; await new Promise(resolve => { releaseCapture = resolve; }); return result; };
        const stoppedAppend = queue.submit(plan.token, [b.id]);
        const rejection = assert.rejects(stoppedAppend, /aborted/);
        await until(() => captured, 'Stop append validation');
        const stopping = queue.stop(); releaseCapture(); await rejection; await stopping;
        scanner.captureIngest = capture;
        assert.equal((await queue.status()).active, false);
        assert.ok(scanner.snapshot().shots.every(shot => shot.editable));
        const metadata = JSON.parse(await fs.readFile(join(library, `${b.id}.metadata.json`), 'utf8'));
        assert.equal(metadata.scene, '', 'Stopped append does not publish its updated metadata');
        // Commit and Export have independent serial workers and shared clip locks.
        const commits = [], exports = [];
        queue.onChange = next => {
            if (next.current && commits.at(-1) !== next.current.id) commits.push(next.current.id);
            if (next.exportCurrent && exports.at(-1) !== next.exportCurrent.id) exports.push(next.exportCurrent.id);
        };
        hold = true; entered = false; releaseExport = undefined;
        plan = await queue.preview([a.id,b.id]); await queue.submit(plan.token,[a.id,b.id]);
        await until(()=>entered,'active Commit');
        const metadataId='1'.repeat(64), exportId='2'.repeat(64), secondExportId='3'.repeat(64);
        let metadataRan=false;
        queue.enqueueLibrary([{id:metadataId,filename:'Metadata fixture',kind:'metadata',execute:async()=>{metadataRan=true;}}]);
        const heldExport = {id:exportId,filename:'First export fixture',kind:'sync',execute:async(signal,progress)=>{
            progress(37);
            await new Promise((resolve,reject)=>{
                const abort=()=>reject(new Error('Stopped fixture Export'));
                signal.addEventListener('abort',abort,{once:true});
                releaseExport=()=>{signal.removeEventListener('abort',abort);resolve();};
            });
        }};
        queue.enqueueLibrary([heldExport]);
        queue.enqueueLibrary([{id:secondExportId,filename:'Second export fixture',kind:'sync',execute:async()=>{}}]);
        await until(()=>!!releaseExport,'Export starts while Commit is held');
        await until(()=>metadataRan,'Metadata-only work runs independently of the held media Commit');
        status=await queue.status();
        assert.equal(status.current.id,a.id);assert.equal(status.exportCurrent.id,exportId);
        assert.equal(status.exportCurrent.percent,37);
        assert.equal(status.exportCurrent.percent,scanner.transferPercent(exportId),'Export footer and card progress match independently');
        assert.equal(status.tasks.transfersRemaining,2);assert.equal(status.tasks.syncsRemaining,2);
        assert.deepEqual(exports,[exportId],'Only one Export executes at a time');
        assert.throws(()=>queue.enqueueLibrary([{...heldExport,id:a.id}]),/already queued/,'A fingerprint cannot Commit and Export together');
        release();
        await until(async()=>!(await queue.status()).current,'Commit lane drains while Export is still held');
        status=await queue.status();
        assert.equal(status.active,true);assert.equal(status.exportCurrent.id,exportId);
        assert.equal(status.tasks.transfersRemaining,0);assert.equal(status.tasks.syncsRemaining,2);
        assert.equal(scanner.canEditLibrary([exportId]),false,'Draining Commit cannot unlock an active Export');
        assert.deepEqual(commits,[a.id,b.id],'The Commit progress lane contains media transfers only');
        releaseExport(); await until(async()=>!(await queue.status()).active,'both lanes drain');
        assert.deepEqual(exports,[exportId,secondExportId],'Exports retain their own acceptance order');

        // Per-clip cancellation affects one lane; emergency Stop settles both lanes
        // and clears queued work without starting it afterward.
        hold=true;entered=false;releaseExport=undefined;
        await scanner.updateOrganization([a.id,b.id],{field:'notes',operation:'set',value:'Concurrent cancellation'});
        plan=await queue.preview([a.id,b.id]);await queue.submit(plan.token,[a.id,b.id]);
        await until(()=>entered,'Commit held for cancellation');
        queue.enqueueLibrary([heldExport]);await until(()=>!!releaseExport,'Export held for cancellation');
        await queue.cancel([a.id]);
        assert.equal((await queue.status()).exportCurrent.id,exportId,'Per-clip Stop leaves the other lane active');
        await until(async()=>!(await queue.status()).current,'uncancelled Commit completes');
        hold=true;entered=false;
        plan=await queue.preview([a.id]);await queue.submit(plan.token,[a.id]);
        await until(()=>entered,'Commit restarted beside Export');
        let queuedExportRan=false;
        queue.enqueueLibrary([{id:secondExportId,filename:'Cancelled queued Export',kind:'sync',execute:async()=>{queuedExportRan=true;}}]);
        await queue.stop();
        status=await queue.status();
        assert.equal(status.active,false);assert.equal(status.current,undefined);assert.equal(status.exportCurrent,undefined);
        assert.equal(status.tasks.transfersRemaining,0);assert.equal(status.tasks.syncsRemaining,0);
        assert.equal(queuedExportRan,false);assert.equal(scanner.canEditLibrary([a.id,exportId,secondExportId]),true);
        assert.deepEqual(status.errors,[]);
        for (const [name, bytes] of originals) assert.deepEqual(await fs.readFile(join(input, name)), bytes);
        console.log('PASS: active Commit append, immutable reviews/conflicts, duplicate exclusion, stable progress totals, per-clip Eject, worker drain during validation, parallel Commit/Export lanes, independent progress, cancellation/Stop races, and original preservation.');
    } finally {
        release?.(); releaseCapture?.(); releaseExport?.(); await queue?.close(); await manager?.close();
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
