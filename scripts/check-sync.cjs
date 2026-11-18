// Synthetic flat Libraries and disposable destinations only; never user settings.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const execute = require('node:util').promisify(require('node:child_process').execFile);
const parseCSV = async path => JSON.parse((await execute('python3',['-c','import csv,json,sys; print(json.dumps(list(csv.DictReader(open(sys.argv[1], newline="", encoding="utf-8")))))',path])).stdout);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test) { for (let i = 0; i < 500; i++) { if (await test()) return; await sleep(10); } throw new Error('Export timed out'); }
(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(require('node:os').tmpdir(), 'owmo-sync-')));
    let queue, catalogue, scanner;
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, ['server/sync.ts', 'server/catalogue.ts', 'server/scanner.ts', 'server/ingestion.ts', 'server/library.ts', 'shared/shots.ts', 'server/rsync.ts','server/resolveExport.ts','server/exportFiles.ts','shared/library.ts','server/fingerprints.ts'].map(file => `export * from ${JSON.stringify(resolve(file))};`).join('\n'));
        const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'cjs' } } } });
        const loaded = new (require('node:module'))(__filename, module); loaded.paths = module.paths;
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { LibrarySync, LibraryCatalogue, ShotScanner, IngestQueue, inspectLibrary, emptyVideoMetadata, rsyncFile, resolveFormatter, validateLibraryMetadata, exportPath, VideoFingerprintStore, readExportOwner } = loaded.exports;
        const library = join(root, 'library'), cache = join(root, 'cache'), destination = join(root, 'destination');
        for (const path of [library, cache, destination]) await fs.mkdir(path);
        const fingerprints = new VideoFingerprintStore();
        const fixtureSources = await Promise.all(['aaaa', 'bbbb'].map(async (content, index) => {
            const path = join(root, `source-${index}.mp4`); await fs.writeFile(path, content);
            return { path, fingerprint: await fingerprints.identify(path, new AbortController().signal) };
        }));
        const ids = fixtureSources.map(source => source.fingerprint.value);
        for (const id of ids) {
            const metadata = { id, fingerprint: fixtureSources[ids.indexOf(id)].fingerprint, originalFilename: `Camera-${id[0]}.MP4`, bytes: 4,
                recordedAt: '2026-11-01T10:00:00Z', dateSource: 'camera', dateEvidence: 'fixture', dateConfidence: 'declared', durationSeconds: 1,
                metadata: emptyVideoMetadata(), warnings: [], identity: null, project: null, scene: '', notes: '', tags: [], ingestion: { completedAt: '2026-11-01T11:00:00Z', transfer: 'rsync' } };
            await fs.writeFile(join(library, `${id}.metadata.json`), JSON.stringify(metadata));
            await fs.copyFile(fixtureSources[ids.indexOf(id)].path, join(library, `${id}.source.mp4`));
            await fs.writeFile(join(library, `${id}.proxy.mov`), `proxy-${id[0]}`);
            await fs.writeFile(join(library, `${id}.thumb.jpg`), Buffer.from([255, 216, 255, 217]));
        }
        const outputName=id=>`Camera-${id[0]}__${id.slice(0,8)}`;
        const metadataFile=join(destination,'_metadata.csv');
        const original = new Map(await Promise.all((await fs.readdir(library)).map(async name => [name, await fs.readFile(join(library, name))])));
        const inspect = () => inspectLibrary(library);
        scanner = new ShotScanner(join(cache, 'thumbnails'), undefined, join(cache, 'metadata.json'));
        queue = new IngestQueue(scanner, async () => library, inspect);
        await queue.status();
        catalogue = new LibraryCatalogue(scanner, async () => library, inspect, queue, join(cache, 'catalogue.json'), join(cache, 'library', 'thumbnails'));
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
        assert.deepEqual((await queue.status()).tasks.sync, { completed: 1, total: 1, percent: 100 }, 'Completed Export progress is retained until the next work session');
        assert.deepEqual((await fs.readdir(destination)).sort(), [`${outputName(ids[0])}.mp4`, '_metadata.csv', 'Proxy'].sort(), 'Source is directly in the chosen folder');
        assert.deepEqual(await fs.readFile(join(destination,`${outputName(ids[0])}.mp4`)),original.get(`${ids[0]}.source.mp4`));
        assert.deepEqual(await fs.readFile(join(destination,'Proxy',`${outputName(ids[0])}.mov`)),original.get(`${ids[0]}.proxy.mov`));
        assert.equal(await fs.stat(join(destination,'Metadata')).catch(()=>null),null,'No metadata subfolder is created');
        let rows=await parseCSV(metadataFile);
        assert.equal(rows.length,1);assert.equal(rows[0]['File Name'],`${outputName(ids[0])}.mp4`);assert.equal(rows[0]['Clip Directory'],destination);
        for(const field of ['Description','Scene','Camera #','Good Take','Comments','Keywords','Identity','Quality']) assert.equal(rows[0][field],'','Optional metadata stays blank');
        const firstManifest=await fs.readFile(metadataFile);
        r = await review([ids[0]]); assert.equal(r.clips[0].mode, 'replace');
        const destinationFile = join(destination, `${outputName(ids[0])}.mp4`);
        const before = await fs.stat(destinationFile);
        await sync.submit(r.token, [ids[0]]); await idle();
        assert.equal((await fs.stat(destinationFile)).ino, before.ino, 'rsync quick check avoids recopying');
        assert.deepEqual((await fs.readdir(destination)).filter(name=>name.endsWith('.csv')),['_metadata.csv'],'Repeated exports keep one CSV');
        assert.deepEqual(await fs.readFile(metadataFile),firstManifest,'Re-export updates the same row without duplicates');
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
        await assert.rejects(sync.submit(r.token, [ids[0]]), /Review Export again/);
        let started; const active = new Promise(resolve => { started = resolve; }); gate = true; entered = started;
        await submit([ids[0]]); await active;
        let status = await queue.status(); assert.equal(status.tasks.syncsRemaining, 1); assert.equal(status.tasks.transfersRemaining, 0);
        assert.deepEqual(status.tasks.sync, { completed: 0, total: 1, percent: 0 });
        let view = await catalogue.snapshot(); assert.equal(view.shots.find(s => s.id === ids[0]).workKind, 'sync'); assert.equal(view.shots.find(s => s.id === ids[0]).editable, false);
        await submit([ids[1]]); assert.equal((await queue.status()).tasks.syncsRemaining, 2, 'Append preserves running Export');
        assert.equal((await queue.status()).tasks.sync.total, 2, 'Appending grows Export progress without counting Commits');
        await queue.cancel([ids[0]]); gate = undefined; await idle();
        assert.equal(aborts, 1); assert.equal((await catalogue.snapshot()).shots.find(s => s.id === ids[0]).editable, true);
        assert.ok(await fs.stat(join(destination, `${outputName(ids[1])}.mp4`)), 'Unrelated appended clip completes');
        const metadataBeforeStop=await fs.readFile(metadataFile);
        let globalStarted; const globalActive = new Promise(resolve => { globalStarted = resolve; }); gate = true; entered = globalStarted;
        await submit(ids); await globalActive; await queue.stop(); gate = undefined; await idle();
        assert.equal(aborts, 2, 'Toolbar Stop aborts the active Export');
        assert.deepEqual(await fs.readFile(metadataFile),metadataBeforeStop,'Cancelled exports leave the CSV unchanged');
        assert.ok((await catalogue.snapshot()).shots.every(s => s.editable), 'Toolbar Stop unlocks queued and active exports');
        const rowsBeforeFailure=await parseCSV(metadataFile);
        r = await review(ids); fail = true; await sync.submit(r.token, ids); await idle();
        rows=await parseCSV(metadataFile);
        assert.equal(rows.length,rowsBeforeFailure.length,'Re-exports preserve previously exported filenames without duplicates');
        assert.ok(rows.some(row=>row['File Name']===`${outputName(ids[1])}.mp4`),'Appended exports add their rows');
        assert.deepEqual(rows.find(row=>row['File Name']===r.clips[0].outputFilename),rowsBeforeFailure.find(row=>row['File Name']===r.clips[0].outputFilename),'A failed re-export keeps its previously completed row');
        status = await queue.status(); assert.equal(status.errors.at(-1).kind, 'sync'); assert.match(status.errors.at(-1).message, /Synthetic transfer failure/);
        assert.ok((await catalogue.snapshot()).shots.every(s => s.editable && !s.ingestState), 'Failures unlock; exports do not create Commit state');
        // Subfolder replacement and symlinks must not redirect writes.
        r = await review([ids[0]]);
        await fs.rename(join(destination,'Proxy'),join(destination,'Proxy-saved'));await fs.mkdir(join(destination,'Proxy'));
        await assert.rejects(sync.submit(r.token,[ids[0]]),/Export folder changed/);
        await fs.rmdir(join(destination,'Proxy'));await fs.rename(join(destination,'Proxy-saved'),join(destination,'Proxy'));
        const outside=join(root,'outside');await fs.mkdir(outside);
        const savedCSV=join(root,'saved.csv');await fs.rename(metadataFile,savedCSV);
        const outsideCSV=join(outside,'external.csv');await fs.copyFile(savedCSV,outsideCSV);
        const outsideBytes=await fs.readFile(outsideCSV);
        await fs.symlink(outsideCSV,metadataFile);await assert.rejects(review([ids[0]]),/regular file/);
        await fs.unlink(metadataFile);await fs.link(outsideCSV,metadataFile);await assert.rejects(review([ids[0]]),/linked file/);
        await fs.unlink(metadataFile);await fs.rename(savedCSV,metadataFile);
        assert.deepEqual(await fs.readFile(outsideCSV),outsideBytes,'CSV aliases cannot modify outside files');
        const validCSV=await fs.readFile(metadataFile);
        for(const invalid of ['not our columns\nanything\n',validCSV.toString().split('\r\n')[0]+'\r\n"unterminated']) {
            await fs.writeFile(metadataFile,invalid);await assert.rejects(review([ids[0]]),/CSV is invalid/);
            assert.equal(await fs.readFile(metadataFile,'utf8'),invalid,'Malformed CSV is preserved');
        }
        await fs.writeFile(metadataFile,validCSV);
        await fs.unlink(outsideCSV);
        // Files from an older export layout are left untouched and are no longer inputs.
        await fs.mkdir(join(destination,'Metadata'));
        const legacyCSV=join(destination,'Metadata','old.csv');await fs.writeFile(legacyCSV,'old dated CSV');
        const legacyPath=join(destination,'Metadata',`${outputName(ids[0])}.metadata.json`);
        await fs.writeFile(legacyPath,'{broken');
        r=await review([ids[0]]);assert.equal(r.clips[0].issue,undefined);
        await fs.mkdir(join(destination,'Manifest'));await fs.writeFile(join(destination,'Manifest','old.csv'),'old');
        await sync.submit(r.token,[ids[0]]);await idle();
        assert.equal(await fs.readFile(legacyPath,'utf8'),'{broken');
        assert.deepEqual(await fs.readdir(join(destination,'Manifest')),['old.csv']);
        assert.equal(await fs.readFile(legacyCSV,'utf8'),'old dated CSV');
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
        const csvFixture=join(root,'format.csv'),csvText=resolveFormatter.manifest([formatted],destination);
        assert.ok(csvText.startsWith('File Name,Clip Directory,Clip Name,'),'Resolve matching headers are plain text');
        assert.ok(csvText.split('\r\n')[1].startsWith(formatted.source+','),'Resolve matching filenames are not unnecessarily quoted');
        await fs.writeFile(csvFixture,csvText);
        const csvHeaders=csvText.split('\r\n')[0].split(',');
        assert.deepEqual(csvHeaders.slice(-5),['Identity','Project','Group','Camera','Quality'],'Custom headers match the user-facing Resolve fields');
        const csvRow=(await parseCSV(csvFixture))[0];assert.equal(csvRow.Description,full.scene);assert.equal(csvRow.Scene,full.group);assert.equal(csvRow['Camera #'],'A');assert.equal(csvRow['Good Take'],'1');assert.equal(csvRow.Comments,full.notes);assert.equal(csvRow.Identity,full.identity);assert.equal(csvRow.Project,full.project);assert.equal(csvRow.Group,full.group);assert.equal(csvRow.Camera,full.camera);assert.equal(csvRow.Quality,full.rating);assert.ok(csvRow['Clip Name'].includes('OWMO'));
        const other=resolveFormatter.clip(validateLibraryMetadata(JSON.parse(original.get(`${ids[1]}.metadata.json`)),ids[1]),'mp4',8);
        const combined=resolveFormatter.manifest([other],destination,csvText);
        await fs.writeFile(csvFixture,combined);const cumulative=await parseCSV(csvFixture);
        assert.equal(cumulative.length,2);assert.deepEqual(cumulative[0],csvRow,'Unrelated quoted/multiline rows survive merging');
        const updated={...formatted,fields:{...formatted.fields,Comments:'Updated, "quoted"\nnotes',Quality:''}};
        await fs.writeFile(csvFixture,resolveFormatter.manifest([updated],destination,combined));
        const changedRows=await parseCSV(csvFixture);assert.equal(changedRows.length,2);
        assert.equal(changedRows[0].Comments,updated.fields.Comments);assert.equal(changedRows[0].Quality,'','Blank fields clear previous values');
        assert.deepEqual(changedRows[1],cumulative[1],'Updating a filename keeps other rows');
        full.rating='usable';assert.equal(resolveFormatter.clip(full,'mov',8).fields['Good Take'],'0');
        full.originalFilename='bad/name:with?characters.MOV';assert.ok(!/[<>:"/\\|?*]/.test(resolveFormatter.clip(full,'mov',8).source));
        full.originalFilename='é'.repeat(300)+'.MOV';assert.ok(Buffer.byteLength(resolveFormatter.clip(full,'mov',64).source)<=255);assert.ok(Buffer.byteLength(resolveFormatter.clip(full,'mp4',64).proxy.split('/')[1])<=255);
        assert.throws(()=>exportPath(destination,'../outside'));assert.throws(()=>exportPath(destination,'/absolute'));
        // Existing media identifies its owner without an app metadata sidecar.
        await fs.writeFile(destinationFile, 'another clip');r=await review([ids[0]]);
        assert.equal(r.clips[0].outputFilename,`Camera-${ids[0][0]}__${ids[0].slice(0,12)}.mp4`);
        await sync.submit(r.token,[ids[0]]);await idle();r=await review([ids[0]]);
        assert.equal(r.clips[0].outputFilename,`Camera-${ids[0][0]}__${ids[0].slice(0,12)}.mp4`,'Expanded names are reused');
        assert.equal(await fs.readFile(destinationFile,'utf8'),'another clip','A different owner is not overwritten');
        const largeSource=join(root,'large-source.mp4');await fs.writeFile(largeSource,Buffer.alloc(2*1024*1024,37));
        const largeFingerprint=await fingerprints.identify(largeSource,new AbortController().signal);
        assert.equal(await readExportOwner(largeSource),largeFingerprint.value,'Export ownership uses the same sampled fingerprint for large files');
        r = await review([ids[0]]); await fs.rename(destination, `${destination}-offline`); await fs.mkdir(destination);
        await assert.rejects(sync.submit(r.token, [ids[0]]), /destination changed/);
        assert.deepEqual(await fs.readdir(destination), [], 'Changed destination root is never written');
        for (const [name, bytes] of original) assert.deepEqual(await fs.readFile(join(library, name)), bytes, 'Library remains unchanged');
        assert.equal(scanner.snapshot().shots.length, 0, 'Export never adds Import workspace clips');
        console.log('PASS: Resolve source/proxy naming/layout, optional and escaped CSV metadata, cumulative root CSV upserts with successful clips only, stable collision handling, folder/file guards, exclusions, stale reviews, queue append/cancel/Stop/failure, quick-check reuse, and unchanged Library assets.');
    } finally {
        await queue?.close(); await catalogue?.close(); await scanner?.close(); await fs.rm(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
