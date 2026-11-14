// Synthetic flat Libraries and disposable destinations only; never user settings.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const execute = require('node:util').promisify(require('node:child_process').execFile);
const parseCSV = async path => JSON.parse((await execute('python3',['-c','import csv,json,sys; print(json.dumps(list(csv.DictReader(open(sys.argv[1], newline="", encoding="utf-8")))))',path])).stdout);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test) { for (let i = 0; i < 500; i++) { if (await test()) return; await sleep(10); } throw new Error('Sync timed out'); }
(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(require('node:os').tmpdir(), 'owmo-sync-')));
    let queue, catalogue, scanner;
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, ['server/sync.ts', 'server/catalogue.ts', 'server/scanner.ts', 'server/ingestion.ts', 'server/library.ts', 'shared/shots.ts', 'server/rsync.ts','server/resolveExport.ts','server/exportFiles.ts','shared/library.ts'].map(file => `export * from ${JSON.stringify(resolve(file))};`).join('\n'));
        const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'cjs' } } } });
        const loaded = new (require('node:module'))(__filename, module); loaded.paths = module.paths;
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { LibrarySync, LibraryCatalogue, ShotScanner, IngestQueue, inspectLibrary, emptyVideoMetadata, rsyncFile, resolveFormatter, validateLibraryMetadata, exportPath } = loaded.exports;
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
        const outputName=id=>`Camera-${id[0]}__${id.slice(0,8)}`;
        const manifestNames=()=>fs.readdir(join(destination,'Manifest'));
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
        assert.deepEqual((await fs.readdir(destination)).sort(), [`${outputName(ids[0])}.mp4`, 'Manifest', 'Metadata', 'Proxy'].sort(), 'Source is directly in the chosen folder');
        assert.deepEqual(await fs.readFile(join(destination,`${outputName(ids[0])}.mp4`)),original.get(`${ids[0]}.source.mp4`));
        assert.deepEqual(await fs.readFile(join(destination,'Proxy',`${outputName(ids[0])}.mov`)),original.get(`${ids[0]}.proxy.mov`));
        const exportedMetadata=JSON.parse(await fs.readFile(join(destination,'Metadata',`${outputName(ids[0])}.metadata.json`)));
        assert.equal(exportedMetadata.originalFilename,'Camera-a.MP4');assert.equal(exportedMetadata.group,'');assert.equal(exportedMetadata.rating,null);
        let manifests=await manifestNames();assert.equal(manifests.length,1);
        let rows=await parseCSV(join(destination,'Manifest',manifests[0]));
        assert.equal(rows.length,1);assert.equal(rows[0]['File Name'],`${outputName(ids[0])}.mp4`);assert.equal(rows[0]['Clip Directory'],destination);
        for(const field of ['Description','Scene','Camera #','Good Take','Comments','Keywords','OWMO Identity','OWMO Rating']) assert.equal(rows[0][field],'','Optional metadata stays blank');
        const firstManifest=await fs.readFile(join(destination,'Manifest',manifests[0]));
        r = await review([ids[0]]); assert.equal(r.clips[0].mode, 'replace');
        const destinationFile = join(destination, `${outputName(ids[0])}.mp4`);
        const before = await fs.stat(destinationFile);
        await sync.submit(r.token, [ids[0]]); await idle();
        assert.equal((await fs.stat(destinationFile)).ino, before.ino, 'rsync quick check avoids recopying');
        assert.equal((await manifestNames()).length,2,'Each export gets its own manifest');
        assert.deepEqual(await fs.readFile(join(destination,'Manifest',manifests[0])),firstManifest,'Later exports preserve earlier CSVs');
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
        assert.ok(await fs.stat(join(destination, `${outputName(ids[1])}.mp4`)), 'Unrelated appended clip completes');
        const manifestsBeforeStop=await manifestNames();
        let globalStarted; const globalActive = new Promise(resolve => { globalStarted = resolve; }); gate = true; entered = globalStarted;
        await submit(ids); await globalActive; await queue.stop(); gate = undefined; await idle();
        assert.equal(aborts, 2, 'Toolbar Stop aborts the active Sync');
        assert.deepEqual(await manifestNames(),manifestsBeforeStop,'Cancelled batches publish no CSV');
        assert.ok((await catalogue.snapshot()).shots.every(s => s.editable), 'Toolbar Stop unlocks queued and active exports');
        const manifestsBeforeFailure=new Set(await manifestNames());
        r = await review(ids); fail = true; await sync.submit(r.token, ids); await idle();
        const failureManifest=(await manifestNames()).find(name=>!manifestsBeforeFailure.has(name));
        rows=await parseCSV(join(destination,'Manifest',failureManifest));
        assert.deepEqual(rows.map(row=>row['File Name']),[`${outputName(ids[1])}.mp4`],'Failed clips never appear in the export CSV');
        status = await queue.status(); assert.equal(status.errors.at(-1).kind, 'sync'); assert.match(status.errors.at(-1).message, /Synthetic transfer failure/);
        assert.ok((await catalogue.snapshot()).shots.every(s => s.editable && !s.ingestState), 'Failures unlock; exports do not create Commit state');
        // Subfolder replacement, symlinks, and malformed snapshots must not redirect writes.
        r = await review([ids[0]]);
        await fs.rename(join(destination,'Proxy'),join(destination,'Proxy-saved'));await fs.mkdir(join(destination,'Proxy'));
        await assert.rejects(sync.submit(r.token,[ids[0]]),/Export folder changed/);
        await fs.rmdir(join(destination,'Proxy'));await fs.rename(join(destination,'Proxy-saved'),join(destination,'Proxy'));
        const outside=join(root,'outside');await fs.mkdir(outside);
        await fs.rename(join(destination,'Metadata'),join(destination,'Metadata-saved'));await fs.symlink(outside,join(destination,'Metadata'));
        await assert.rejects(review([ids[0]]),/real directories/);
        assert.deepEqual(await fs.readdir(outside),[]);await fs.unlink(join(destination,'Metadata'));await fs.rename(join(destination,'Metadata-saved'),join(destination,'Metadata'));
        const snapshotPath=join(destination,'Metadata',`${outputName(ids[0])}.metadata.json`), savedSnapshot=await fs.readFile(snapshotPath);
        await fs.writeFile(snapshotPath,'{broken');r=await review([ids[0]]);assert.match(r.clips[0].issue,/unreadable/);
        assert.equal(await fs.readFile(snapshotPath,'utf8'),'{broken');await fs.writeFile(snapshotPath,savedSnapshot);
        // A subfolder redirected during rsync must also block subsequent publication.
        let redirectedStarted; const redirectedActive=new Promise(resolve=>{redirectedStarted=resolve;});gate=true;entered=redirectedStarted;
        await submit([ids[0]]);await redirectedActive;
        await fs.rename(join(destination,'Proxy'),join(destination,'Proxy-saved'));await fs.symlink(outside,join(destination,'Proxy'));
        gate();await idle();
        assert.match((await queue.status()).errors.at(-1).message,/real directories/);
        assert.deepEqual(await fs.readdir(outside),[],'Transfer never follows a newly redirected export directory');
        await fs.unlink(join(destination,'Proxy'));await fs.rename(join(destination,'Proxy-saved'),join(destination,'Proxy'));
        // Formatting preserves multiline/quoted values and source format, including blank fields.
        const full=validateLibraryMetadata(JSON.parse(original.get(`${ids[0]}.metadata.json`)),ids[0]);
        Object.assign(full,{identity:'OWMO',project:'Studio, \"Tour\"',scene:'Synthesizer pan',group:'TH01-T02',camera:'A',rating:'preferred',notes:'First line\nSecond \"quoted\" line',tags:['b-roll','synth']});
        const formatted=resolveFormatter.clip(full,'mov',8);assert.equal(formatted.source,`${outputName(ids[0])}.mov`);
        const csvFixture=join(root,'format.csv');await fs.writeFile(csvFixture,resolveFormatter.manifest([formatted],destination));
        const csvRow=(await parseCSV(csvFixture))[0];assert.equal(csvRow.Description,full.scene);assert.equal(csvRow.Scene,full.group);assert.equal(csvRow['Camera #'],'A');assert.equal(csvRow['Good Take'],'1');assert.equal(csvRow.Comments,full.notes);assert.equal(csvRow['OWMO Project'],full.project);assert.ok(csvRow['Clip Name'].includes('OWMO'));
        full.rating='usable';assert.equal(resolveFormatter.clip(full,'mov',8).fields['Good Take'],'0');
        full.originalFilename='bad/name:with?characters.MOV';assert.ok(!/[<>:"/\\|?*]/.test(resolveFormatter.clip(full,'mov',8).source));
        full.originalFilename='é'.repeat(300)+'.MOV';assert.ok(Buffer.byteLength(resolveFormatter.clip(full,'mov',64).metadata.path.split('/')[1])<=255);
        assert.throws(()=>exportPath(destination,'../outside'));assert.throws(()=>exportPath(destination,'/absolute'));
        // A known owner with the same short prefix extends only the new name.
        const foreign={...JSON.parse(savedSnapshot),id:'a'.repeat(8)+'c'.repeat(56)};foreign.fingerprint={...foreign.fingerprint,value:foreign.id};
        await fs.writeFile(snapshotPath,JSON.stringify(foreign));r=await review([ids[0]]);
        assert.equal(r.clips[0].outputFilename,`Camera-a__${ids[0].slice(0,12)}.mp4`);
        await sync.submit(r.token,[ids[0]]);await idle();r=await review([ids[0]]);assert.equal(r.clips[0].outputFilename,`Camera-a__${ids[0].slice(0,12)}.mp4`,'Expanded names are reused');
        await fs.writeFile(snapshotPath,savedSnapshot);
        r = await review([ids[0]]); await fs.rename(destination, `${destination}-offline`); await fs.mkdir(destination);
        await assert.rejects(sync.submit(r.token, [ids[0]]), /destination changed/);
        assert.deepEqual(await fs.readdir(destination), [], 'Changed destination root is never written');
        for (const [name, bytes] of original) assert.deepEqual(await fs.readFile(join(library, name)), bytes, 'Library remains unchanged');
        assert.equal(scanner.snapshot().shots.length, 0, 'Export never adds Import workspace clips');
        console.log('PASS: Resolve source/proxy naming/layout, optional and escaped CSV metadata, per-batch manifests with successful clips only, stable collision handling, folder/file guards, exclusions, stale reviews, queue append/cancel/Stop/failure, quick-check reuse, and unchanged Library assets.');
    } finally {
        await queue?.close(); await catalogue?.close(); await scanner?.close(); await fs.rm(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
