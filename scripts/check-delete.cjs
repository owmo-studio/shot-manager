// Destructive-operation checks use only isolated, synthetic local fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(require('node:os').tmpdir(), 'owmo-delete-')));
    let scanner, queue, catalogue, release;
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, ['server/catalogue.ts','server/scanner.ts','server/ingestion.ts','server/library.ts','shared/shots.ts']
            .map(file => `export * from ${JSON.stringify(resolve(file))};`).join('\n'));
        const bundle = await (await import('vite')).build({configFile:false,logLevel:'silent',build:{ssr:true,write:false,rollupOptions:{input:entry,output:{format:'cjs'}}}});
        const loaded = new (require('node:module'))(__filename, module); loaded.paths=module.paths;
        loaded._compile(bundle.output.find(item=>item.type==='chunk'&&item.isEntry).code,__filename);
        const { LibraryCatalogue, ShotScanner, IngestQueue, inspectLibrary, emptyVideoMetadata } = loaded.exports;
        const library=join(root,'library'), cache=join(root,'cache'); await fs.mkdir(library); await fs.mkdir(cache);
        const ids=['a','b','c','d'].map(letter=>letter.repeat(64));
        const metadata=id=>({id,fingerprint:{value:id,algorithm:'sha256',scheme:'sampled-sha256-v2',fileSize:4,sampleBytes:262144,sampledBytes:4},originalFilename:`Original-${id[0]}.MP4`,bytes:4,
            recordedAt:'2026-11-01T10:00:00Z',dateSource:'camera',dateEvidence:'fixture',dateConfidence:'declared',durationSeconds:1,metadata:emptyVideoMetadata(),warnings:[],
            identity:'Example',project:null,scene:'Scene',group:'',camera:'',rating:null,notes:'Original metadata',tags:[],ingestion:{completedAt:'2026-11-01T11:00:00Z',transfer:'rsync'}});
        const create = async id => {
            for(const [role,contents] of Object.entries({'metadata.json':JSON.stringify(metadata(id)),'source.mp4':'data','proxy.mov':'proxy','thumb.jpg':Buffer.from([255,216,255,217]),'transcript.txt':'derived','encode.partial':'partial'}))
                await fs.writeFile(join(library,`${id}.${role}`),contents);
        };
        for (const id of ids) await create(id);
        await fs.mkdir(join(library,'.recycle'));
        await fs.writeFile(join(library,'.recycle',`${ids[0]}.source.mp4`),'recycled');
        const source=join(root,'source.mp4'), exported=join(root,'export.mp4');
        await fs.writeFile(source,'original source');await fs.writeFile(exported,'previous export');
        let offline=false, changedMount=false;
        const inspect=async()=>{if(offline)throw new Error('Library unavailable');const location=await inspectLibrary(library);return {...location,mount:location.mount+(changedMount?'-changed':'')};};
        scanner=new ShotScanner(join(cache,'thumbnails'),undefined,join(cache,'metadata.json'));
        queue=new IngestQueue(scanner,async()=>library,inspect);
        catalogue=new LibraryCatalogue(scanner,async()=>library,inspect,queue,join(cache,'catalogue.json'),join(cache,'library-thumbnails'));
        scanner.organization.onChange=()=>catalogue.changed();
        await queue.status();await catalogue.refresh();
        await assert.rejects(catalogue.previewDelete(['../bad']),/Invalid Delete/);
        const executeDelete=(review, selected=review.clips.map(clip=>clip.id))=>catalogue.deleteClips(review.token, selected);
        let review=await catalogue.previewDelete([ids[0]]);
        assert.equal(review.clips[0].filename,'Original-a.MP4');
        assert.ok(await fs.stat(join(library,`${ids[0]}.source.mp4`)),'Review is read-only');
        await fs.writeFile(join(library,`${ids[0]}.new-derived.json`),'new remote file');
        await assert.rejects(executeDelete(review),/files changed/);
        assert.ok(await fs.stat(join(library,`${ids[0]}.source.mp4`)),'Stale review cannot partially delete');
        review=await catalogue.previewDelete([ids[0]]);changedMount=true;
        await assert.rejects(executeDelete(review),/mounted volume changed/);changedMount=false;
        assert.ok(await fs.stat(join(library,`${ids[0]}.source.mp4`)));
        review=await catalogue.previewDelete([ids[0]]);offline=true;
        await assert.rejects(executeDelete(review),/unavailable/);offline=false;
        const link=join(library,`${ids[0]}.linked.txt`);await fs.symlink(source,link);
        await assert.rejects(catalogue.previewDelete([ids[0]]),/regular file/);await fs.unlink(link);
        review=await catalogue.previewDelete([ids[0]]);
        await fs.symlink(source,link);
        await assert.rejects(executeDelete(review),/regular file/);await fs.unlink(link);
        const folder=join(library,`${ids[0]}.derived.folder`);await fs.mkdir(folder);
        await assert.rejects(catalogue.previewDelete([ids[0]]),/regular file/);await fs.rmdir(folder);
        review=await catalogue.previewDelete([ids[0]]);
        queue.enqueueLibrary([{id:ids[0],filename:'Held Export',kind:'sync',execute:signal=>new Promise((resolve,reject)=>{
            release=resolve;signal.addEventListener('abort',()=>reject(new Error('Stopped fixture Export')),{once:true});
        })}]);
        await assert.rejects(executeDelete(review),/Stop work/);
        await assert.rejects(catalogue.previewDelete([ids[0]]),/Stop work/);
        await queue.stop();
        await catalogue.update([ids[0]],{field:'notes',operation:'set',value:'Pending local edit'});
        // A cache write failure is caught before remote deletion starts.
        review=await catalogue.previewDelete([ids[0]]);
        catalogue.assertWritable=async()=>{throw new Error('Synthetic Cache unavailable');};
        await assert.rejects(executeDelete(review),/Cache unavailable/);catalogue.assertWritable=undefined;
        assert.ok(await fs.stat(join(library,`${ids[0]}.source.mp4`)));
        review=await catalogue.previewDelete([ids[0],ids[1]]);
        await assert.rejects(executeDelete(review,[]),/Invalid reviewed/);
        await assert.rejects(executeDelete(review,[ids[2]]),/Invalid reviewed/);
        const excludedDraft=(await scanner.organization.draftsFor([metadata(ids[1]).fingerprint]));
        const subset=await executeDelete(review,[ids[0]]);
        assert.deepEqual(subset,{deleted:[ids[0]],errors:[]});
        assert.ok(await fs.stat(join(library,`${ids[1]}.source.mp4`)),'Excluded clips keep their files');
        assert.deepEqual(await scanner.organization.draftsFor([metadata(ids[1]).fingerprint]),excludedDraft,'Excluded clips keep their local metadata');
        review=await catalogue.previewDelete([ids[1]]);
        const remainder=await executeDelete(review);
        const result={deleted:[...subset.deleted,...remainder.deleted],errors:[...subset.errors,...remainder.errors]};
        assert.deepEqual(result,{deleted:ids.slice(0,2),errors:[]});
        assert.equal((await fs.readdir(library)).some(name=>ids.slice(0,2).some(id=>name.startsWith(`${id}.`))),false,'All associated roles, additional files, and partials are removed');
        assert.deepEqual((await catalogue.snapshot()).shots.map(shot=>shot.id),ids.slice(2));
        assert.deepEqual(JSON.parse(await fs.readFile(join(cache,'catalogue.json'),'utf8')).entries.map(entry=>entry.metadata.id),ids.slice(2));
        const drafts=JSON.parse(await fs.readFile(join(cache,'metadata.json'),'utf8')).drafts;
        assert.ok(Object.keys(drafts).every(key=>!ids.slice(0,2).some(id=>key.endsWith(id))),'Shared drafts, thumbnail references, and receipts are cleared');
        assert.ok((await scanner.organization.vocabulary()).identity.includes('Example'),'Saved options remain');
        assert.equal(scanner.libraryProxy(ids[0]),false,'Import presence is invalidated immediately');
        await assert.rejects(executeDelete(review),/Review Delete/,'Confirmation cannot be replayed');
        await catalogue.refresh();assert.equal((await catalogue.snapshot()).shots.length,2,'Refresh cannot resurrect deleted catalogue rows');
        // Failure partway through a clip leaves its metadata/catalogue for a retry,
        // while another selected clip can finish and have local data removed.
        const remove=catalogue.removeAsset;let failed=false;
        catalogue.removeAsset=async path=>{
            if(path.endsWith(`${ids[2]}.proxy.mov`)&&!failed){failed=true;throw new Error('Synthetic deletion denied');}
            return remove(path);
        };
        review=await catalogue.previewDelete(ids.slice(2));
        const partial=await executeDelete(review);catalogue.removeAsset=remove;
        assert.deepEqual(partial.deleted,[ids[3]]);assert.equal(partial.errors[0].id,ids[2]);assert.match(partial.errors[0].message,/deletion denied/);
        assert.ok(await fs.stat(join(library,`${ids[2]}.metadata.json`)),'Metadata publication marker is deleted last');
        assert.equal((await catalogue.snapshot()).shots[0].mediaReadiness.state,'unavailable');
        review=await catalogue.previewDelete([ids[2]]);assert.deepEqual((await executeDelete(review)).errors,[]);
        assert.equal((await catalogue.snapshot()).shots.length,0);
        assert.equal(await fs.readFile(source,'utf8'),'original source');assert.equal(await fs.readFile(exported,'utf8'),'previous export');
        assert.equal(await fs.readFile(join(library,'.recycle',`${ids[0]}.source.mp4`),'utf8'),'recycled','NAS recycle folders stay untouched');
        // A failed local save remains recoverable from the cached row, even after
        // all remote files are gone; a fresh confirmation completes that cleanup.
        await create(ids[0]);await catalogue.refresh();
        const forget=scanner.organization.forget.bind(scanner.organization);
        scanner.organization.forget=async()=>{throw new Error('Synthetic local save failure');};
        review=await catalogue.previewDelete([ids[0]]);
        const localFailure=await executeDelete(review);scanner.organization.forget=forget;
        assert.equal(localFailure.deleted.length,0);assert.match(localFailure.errors[0].message,/local metadata could not be cleared/);
        assert.equal((await catalogue.snapshot()).shots.length,1);
        assert.equal((await fs.readdir(library)).some(name=>name.startsWith(ids[0]+'.')),false);
        review=await catalogue.previewDelete([ids[0]]);await executeDelete(review);

        // Matching Import clips keep their original files, but no stale attributes
        // or synced receipt survives deleting that clip from the Library.
        const video=join(root,'original.mp4');
        await require('node:util').promisify(require('node:child_process').execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-t','0.2','-c:v','libx264','-pix_fmt','yuv420p',video]);
        const originalBytes=await fs.readFile(video);
        scanner.discover({id:'original',path:root},[video]);
        for(let i=0;i<600&&!scanner.snapshot().shots.some(shot=>shot.thumbnailStatus==='ready');i++)await sleep(15);
        const imported=scanner.snapshot().shots[0];assert.equal(imported.thumbnailStatus,'ready');
        await scanner.updateOrganization([imported.id],{field:'notes',operation:'set',value:'Imported note'});
        const commit=await queue.preview([imported.id]);await queue.submit(commit.token,[imported.id]);
        for(let i=0;i<600&&(await queue.status()).active;i++)await sleep(15);
        assert.equal(scanner.snapshot().shots[0].ingestState,'synced');
        await catalogue.refresh();review=await catalogue.previewDelete([imported.id]);
        assert.deepEqual((await executeDelete(review)).errors,[]);
        const remaining=scanner.snapshot().shots[0];
        assert.equal(remaining.organization.notes,'');assert.equal(remaining.ingestion,undefined);assert.equal(remaining.ingestState,undefined);
        assert.equal(remaining.available,true);assert.deepEqual(await fs.readFile(video),originalBytes);
        await catalogue.close();
        const restarted=new LibraryCatalogue(scanner,async()=>library,inspect,queue,join(cache,'catalogue.json'));
        assert.equal((await restarted.snapshot()).shots.length,0,'Deletion survives app restart');await restarted.close();
        console.log('PASS: reviewed multi-clip deletion, derived/partial assets, metadata cleanup, stale/locked/offline/mount/symlink/folder guards, partial failures/retry, and source/Export/recycle preservation.');
    } finally { release?.();await queue?.close();await catalogue?.close();await scanner?.close();await fs.rm(root,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
