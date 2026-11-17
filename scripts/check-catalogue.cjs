// Temporary, synthetic Library assets only. Never load the user's application settings.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) {
    for (let i = 0; i < 600; i++) { if (await test()) return; await sleep(15); }
    throw new Error(`Timed out: ${label}`);
}
(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(require('node:os').tmpdir(), 'owmo-catalogue-')));
    let scanner, queue, catalogue;
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, ['server/catalogue.ts','server/scanner.ts','server/ingestion.ts','server/library.ts','shared/shots.ts','server/cacheFiles.ts']
            .map(file => `export * from ${JSON.stringify(resolve(file))};`).join('\n'));
        const bundle = await (await import('vite')).build({ configFile:false,logLevel:'silent',build:{ssr:true,write:false,
            rollupOptions:{input:entry,output:{format:'cjs'}}}});
        const loaded = new (require('node:module'))(__filename,module); loaded.paths=module.paths;
        loaded._compile(bundle.output.find(item=>item.type==='chunk'&&item.isEntry).code,__filename);
        const { LibraryCatalogue, ShotScanner, IngestQueue, inspectLibrary, emptyVideoMetadata, clearSelectedCache, cacheInventory }=loaded.exports;
        const library=join(root,'library'), cache=join(root,'cache'); await fs.mkdir(library); await fs.mkdir(cache);
        const id='a'.repeat(64), second='b'.repeat(64);
        const metadata=key=>({id:key,fingerprint:{value:key,algorithm:'sha256',scheme:'sampled-sha256-v2',fileSize:4,sampleBytes:262144,sampledBytes:4},
            originalFilename:`Original-${key[0]}.MP4`,bytes:4,recordedAt:'2026-11-01T10:00:00Z',dateSource:'camera',dateEvidence:'fixture',dateConfidence:'declared',
            durationSeconds:1,metadata:emptyVideoMetadata(),warnings:[],identity:null,project:'Example',scene:'Library scene',notes:'Remote note',tags:['sample'],
            ingestion:{completedAt:'2026-11-01T11:00:00Z',transfer:'rsync'},anotherTool:{keep:true}});
        for(const key of [id,second]){
            await fs.writeFile(join(library,`${key}.metadata.json`),JSON.stringify(metadata(key)));
            await fs.writeFile(join(library,`${key}.source.mp4`),'data');
            await fs.writeFile(join(library,`${key}.thumb.jpg`),Buffer.from([255,216,255,217]));
            await fs.writeFile(join(library,`${key}.proxy.mov`),'proxy');
        }
        const catalogFile=join(cache,'catalogue.json'), draftFile=join(cache,'metadata.json');
        let offline=false;
        const inspect=async()=>{if(offline)throw new Error('Synthetic offline Library');return inspectLibrary(library);};
        scanner=new ShotScanner(join(cache,"thumbnails"),undefined,draftFile);
        queue=new IngestQueue(scanner,async()=>library,inspect);
        catalogue=new LibraryCatalogue(scanner,async()=>library,inspect,queue,catalogFile,join(cache,'library-thumbnails'));
        scanner.organization.onChange=()=>catalogue.changed();queue.onChange=()=>catalogue.changed();
        let view=await catalogue.refresh();
        assert.equal(view.error,undefined); assert.equal(view.shots.length,2);
        assert.ok(view.shots.every(shot=>!shot.ingestState&&shot.editable),'Library cards have neutral base state');
        assert.ok(view.shots.every(shot=>shot.mediaReadiness.state==='committed'),'Complete verified Library assets are committed despite neutral cards');
        assert.equal(scanner.snapshot().shots.length,0,'Cataloguing never discovers media into Import or queues proxies');
        assert.equal(view.shots[0].organization.notes,'Remote note');
        assert.equal(view.shots[0].libraryBaseline.notes,'Remote note','Library cards expose the published attribute baseline');
        const originalSource=await fs.readFile(join(library,`${id}.source.mp4`));
        const originalProxy=await fs.readFile(join(library,`${id}.proxy.mov`));
        const originalThumb=await fs.readFile(join(library,`${id}.thumb.jpg`));
        const thumb=Buffer.from([255,216,1,2,3,255,217]);
        const thumbURL='data:image/jpeg;base64,'+thumb.toString('base64');
        const originalURL='data:image/jpeg;base64,'+originalThumb.toString('base64');
        await catalogue.setThumbnail(id,thumbURL);
        assert.equal((await catalogue.snapshot()).shots.find(shot=>shot.id===id).ingestState,'changes-pending');
        assert.equal((await catalogue.snapshot()).shots.find(shot=>shot.id===id).mediaReadiness.state,'ready','A local thumbnail change needs Commit even when the Library proxy exists');
        assert.equal(await catalogue.thumbnail(id),thumbURL,'Library previews its local thumbnail draft');
        assert.deepEqual(await fs.readFile(join(library,`${id}.thumb.jpg`)),originalThumb,'Thumb does not write remotely before Commit');
        await catalogue.refresh();assert.equal(await catalogue.thumbnail(id),thumbURL,'Refresh preserves the thumbnail draft');
        let thumbReview=await catalogue.preview([id]);assert.equal(thumbReview.clips[0].files.length,2);
        await catalogue.setThumbnail(id,'data:image/jpeg;base64,'+Buffer.from([255,216,4,5,255,217]).toString('base64'));
        await assert.rejects(catalogue.submit(thumbReview.token,[id]),/changed/,'Changed thumbnails invalidate the review');
        await catalogue.revert([id]);assert.equal(await catalogue.thumbnail(id),originalURL);
        await catalogue.setThumbnail(id,thumbURL);
        const restoreDrafts=scanner.organization.restore.bind(scanner.organization);
        const beforeRevertFailure=await fs.readFile(draftFile);
        scanner.organization.restore=async()=>{throw new Error('Synthetic Revert draft save failure');};
        try { await assert.rejects(catalogue.revert([id,second]),/Synthetic Revert/); }
        finally { scanner.organization.restore=restoreDrafts; }
        assert.equal(await catalogue.thumbnail(id),thumbURL,'Failed batch Revert preserves the pending thumbnail');
        assert.deepEqual(await fs.readFile(draftFile),beforeRevertFailure,'Failed Revert preserves attributes and thumbnail choices');
        await catalogue.revert([id]);
        const markThumbnail=scanner.organization.setThumbnailDraft.bind(scanner.organization);
        scanner.organization.setThumbnailDraft=async()=>{throw new Error('Synthetic thumbnail draft save failure');};
        try { await assert.rejects(catalogue.setThumbnail(id,thumbURL),/Synthetic thumbnail/); }
        finally { scanner.organization.setThumbnailDraft=markThumbnail; }
        assert.deepEqual(await scanner.cachedThumbnail(id,metadata(id).metadata),originalThumb,'Failed draft saves roll the custom image back');
        await catalogue.setThumbnail(id,thumbURL);
        const transfer=catalogue.transfer;catalogue.transfer=async()=>{throw new Error('Synthetic thumbnail transfer failure');};
        thumbReview=await catalogue.preview([id]);await catalogue.submit(thumbReview.token,[id]);
        await until(async()=>!(await queue.status()).active,'failed thumbnail Commit');
        assert.equal((await catalogue.snapshot()).shots.find(shot=>shot.id===id).ingestState,'changes-pending');
        assert.deepEqual(await fs.readFile(join(library,`${id}.thumb.jpg`)),originalThumb);
        for(const error of (await queue.status()).errors) queue.dismissError(error.eventId);
        const metadataBeforeThumb=await fs.readFile(join(library,`${id}.metadata.json`));
        let thumbnailTransfers=0;
        catalogue.transfer=async(...args)=>{
            assert.equal((await catalogue.snapshot()).shots.find(shot=>shot.id===id).mediaReadiness.state,'ready','Commit locks do not overwrite pending readiness');
            thumbnailTransfers++;assert.ok(args[1].endsWith('.thumb.jpg'),'Library never transfers the source or proxy');
            assert.deepEqual(await fs.readFile(join(library,`${id}.metadata.json`)),metadataBeforeThumb,'JSON stays unpublished until the thumbnail transfer succeeds');
            return transfer(...args);
        };
        thumbReview=await catalogue.preview([id]);await catalogue.submit(thumbReview.token,[id]);
        await until(async()=>!(await queue.status()).active,'thumbnail Commit');
        assert.equal(thumbnailTransfers,1);assert.deepEqual((await queue.status()).errors,[]);
        assert.deepEqual(await fs.readFile(join(library,`${id}.thumb.jpg`)),thumb);
        assert.equal((await catalogue.snapshot()).shots.find(shot=>shot.id===id).ingestState,undefined);
        assert.equal((await catalogue.snapshot()).shots.find(shot=>shot.id===id).mediaReadiness.state,'committed','Thumbnail publication restores committed readiness');
        assert.deepEqual(await fs.readFile(join(library,`${id}.source.mp4`)),originalSource);
        assert.deepEqual(await fs.readFile(join(library,`${id}.proxy.mov`)),originalProxy);
        catalogue.transfer=transfer;
        await catalogue.setThumbnail(id,originalURL);thumbReview=await catalogue.preview([id]);await catalogue.submit(thumbReview.token,[id]);
        await until(async()=>!(await queue.status()).active,'restore original fixture thumbnail');
        await catalogue.update([id],{field:'notes',operation:'set',value:'Local edit'});
        view=await catalogue.snapshot();assert.equal(view.shots.find(shot=>shot.id===id).ingestState,'changes-pending');
        assert.equal(view.shots.find(shot=>shot.id===id).organization.notes,'Local edit');
        assert.equal(view.shots.find(shot=>shot.id===id).libraryBaseline.notes,'Remote note','Local edits do not replace the published baseline');
        const remote={...metadata(id),notes:'Changed remotely',scene:'New remote scene'};
        await fs.writeFile(join(library,`${id}.metadata.json`),JSON.stringify(remote));
        view=await catalogue.refresh();
        assert.equal(view.shots.find(shot=>shot.id===id).organization.notes,'Local edit','Refresh preserves the local draft');
        assert.equal(JSON.parse(await fs.readFile(catalogFile)).entries.find(e=>e.metadata.id===id).metadata.notes,'Changed remotely','Catalogue contains latest remote metadata separately');
        await catalogue.revert([id]);view=await catalogue.snapshot();
        assert.equal(view.shots.find(shot=>shot.id===id).organization.notes,'Changed remotely');
        assert.equal(view.shots.find(shot=>shot.id===id).ingestState,undefined);
        await catalogue.update([id],{field:'notes',operation:'set',value:'Committed edit'});
        for(const [field,value] of [['group','TH01-T02'],['camera','B'],['rating','preferred']]) await catalogue.update([id],{field,operation:'set',value});
        let review=await catalogue.preview([id,second]);assert.equal(review.clips.length,1,'Only changed Library clips are eligible');
        assert.equal(review.clips[0].files.length,1,'Metadata Commit has no media transfers');
        await catalogue.submit(review.token,[id]);
        await until(async()=>!(await queue.status()).active,'metadata Commit');
        assert.deepEqual((await queue.status()).errors,[]);
        let stored=JSON.parse(await fs.readFile(join(library,`${id}.metadata.json`)));
        assert.equal(stored.notes,'Committed edit');assert.deepEqual(stored.anotherTool,{keep:true});
        assert.equal(stored.group,'TH01-T02');assert.equal(stored.camera,'B');assert.equal(stored.rating,'preferred');
        await catalogue.update([id],{field:'rating',operation:'set',value:'usable'});await catalogue.revert([id]);
        assert.equal((await catalogue.snapshot()).shots.find(shot=>shot.id===id).organization.rating,'preferred','Revert restores grouping attributes');
        assert.deepEqual(stored.metadata,remote.metadata,'Technical metadata remains unchanged');
        assert.deepEqual(await fs.readFile(join(library,`${id}.source.mp4`)),originalSource);
        assert.deepEqual(await fs.readFile(join(library,`${id}.proxy.mov`)),originalProxy);
        assert.deepEqual(await fs.readFile(join(library,`${id}.thumb.jpg`)),originalThumb);
        assert.equal((await catalogue.snapshot()).shots.find(shot=>shot.id===id).ingestState,undefined);
        assert.ok(!(await fs.readdir(library)).some(name=>name.endsWith('.partial')));
        // Clean drafts follow remote updates; edits on top of them remain local.
        stored.notes='Another remote update';await fs.writeFile(join(library,`${id}.metadata.json`),JSON.stringify(stored));
        await catalogue.refresh();assert.equal((await catalogue.snapshot()).shots.find(shot=>shot.id===id).organization.notes,stored.notes);
        await catalogue.thumbnail(id);
        const thumbs=join(cache,'library-thumbnails'), unsafe=join(root,'unrelated');await fs.mkdir(unsafe);
        await fs.rename(thumbs,thumbs+'-saved');await fs.symlink(unsafe,thumbs);
        await assert.rejects(catalogue.thumbnail(id),/regular folder/);
        assert.deepEqual(await fs.readdir(unsafe),[],'A symlink Cache folder is never written through');
        await fs.unlink(thumbs);await fs.rename(thumbs+'-saved',thumbs);
        offline=true;view=await catalogue.refresh();assert.match(view.error,/offline/);assert.equal(view.shots.length,2,'Offline is never an empty Library');
        assert.ok(view.shots.every(shot=>shot.mediaReadiness.state==='unavailable'),'Cached asset flags do not report committed while offline');
        assert.ok((await catalogue.thumbnail(id)).startsWith('data:image/jpeg;'),'Previously viewed thumbnails work offline');
        await catalogue.update([id],{field:'notes',operation:'set',value:'Offline edit'});
        await assert.rejects(catalogue.preview([id]),/offline/);
        offline=false;await catalogue.refresh();assert.equal((await catalogue.snapshot()).shots.find(shot=>shot.id===id).organization.notes,'Offline edit');
        // Returning edits to the committed value also clears the dirty bit for later refreshes.
        await catalogue.update([id],{field:'notes',operation:'set',value:stored.notes});
        assert.equal((await catalogue.snapshot()).shots.find(shot=>shot.id===id).ingestState,undefined);
        stored.notes='Clean refresh after reverted typing';await fs.writeFile(join(library,`${id}.metadata.json`),JSON.stringify(stored));
        await catalogue.refresh();assert.equal((await catalogue.snapshot()).shots.find(shot=>shot.id===id).organization.notes,stored.notes);
        // A replaced/symlink metadata path cannot be used by Revert or Commit.
        const metadataPath=join(library,`${id}.metadata.json`), backup=join(root,'metadata-backup.json');
        await fs.rename(metadataPath,backup);await fs.symlink(backup,metadataPath);
        await assert.rejects(catalogue.revert([id]),/regular file/);
        await fs.unlink(metadataPath);await fs.rename(backup,metadataPath);
        // Invalid remote records preserve the cached row and report an issue.
        const retained=await fs.readFile(join(library,`${id}.metadata.json`));
        await fs.writeFile(join(library,`${id}.metadata.json`),'{broken');
        view=await catalogue.refresh();assert.equal(view.shots.length,2);assert.equal(view.warnings.length,1);
        assert.equal(view.shots.find(shot=>shot.id===id).mediaReadiness.state,'unavailable','Unreadable remote metadata cannot reuse a committed indicator');
        await assert.rejects(catalogue.revert([id]),/invalid|could not/i);
        await fs.writeFile(join(library,`${id}.metadata.json`),retained);
        await catalogue.revert([id]);
        await catalogue.update([id],{field:'notes',operation:'set',value:'Stale review'});
        review=await catalogue.preview([id]);await catalogue.update([id],{field:'notes',operation:'set',value:'Newer edit'});
        await assert.rejects(catalogue.submit(review.token,[id]),/changed/);
        await assert.rejects(catalogue.update([id],{field:'skip',operation:'set',value:'true'}),/Import/);
        await assert.rejects(catalogue.details('../escape'),/Refresh/);
        review=await catalogue.preview([id]);await queue.stop();
        await assert.rejects(catalogue.submit(review.token,[id]),/stopped/,'Stop invalidates an open metadata review');
        // Global Stop cancels active and queued Library metadata jobs without discarding edits.
        await catalogue.update([second],{field:'notes',operation:'set',value:'Queued local edit'});
        review=await catalogue.preview([id,second]);
        const commit=catalogue.commit.bind(catalogue);let entered=false;
        catalogue.commit=async(capture,location,signal)=>{
            entered=true;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Fixture stopped')),{once:true}));
            return commit(capture,location,signal);
        };
        const beforeStop=await fs.readFile(join(library,`${id}.metadata.json`));
        await catalogue.submit(review.token,[id,second]);await until(()=>entered,'active Library metadata job');
        await queue.stop();catalogue.commit=commit;
        assert.equal((await queue.status()).active,false);
        assert.deepEqual(await fs.readFile(join(library,`${id}.metadata.json`)),beforeStop);
        assert.ok((await catalogue.snapshot()).shots.every(shot=>shot.editable&&shot.ingestState==='changes-pending'));
        await catalogue.setThumbnail(id,thumbURL);
        // Local restart keeps both the catalogue and independently stored edits.
        await catalogue.close();await queue.close();await scanner.close();
        scanner=new ShotScanner(join(cache,"thumbnails"),undefined,draftFile);queue=new IngestQueue(scanner,async()=>library,inspect);
        catalogue=new LibraryCatalogue(scanner,async()=>library,inspect,queue,catalogFile,join(cache,'library-thumbnails'));
        view=await catalogue.snapshot();assert.equal(view.shots.find(shot=>shot.id===id).organization.notes,'Newer edit');
        assert.ok(view.shots.every(shot=>shot.mediaReadiness.state==='unchecked'),'Cached rows start unchecked after restart');
        assert.equal(await catalogue.thumbnail(id),thumbURL,'Thumbnail drafts survive restart');
        assert.equal(view.shots.find(shot=>shot.id===id).ingestState,'changes-pending');
        // Keeping only the catalogue still permits offline editing after pending drafts are cleared.
        const alternate=join(root,'catalogue-only');await fs.mkdir(alternate);
        const alternateCatalogue=join(alternate,'catalogue.json');await fs.copyFile(catalogFile,alternateCatalogue);
        const alternateScanner=new ShotScanner(undefined,undefined,join(alternate,'metadata.json'));
        const alternateQueue=new IngestQueue(alternateScanner,async()=>library,inspect);
        const catalogueOnly=new LibraryCatalogue(alternateScanner,async()=>library,inspect,alternateQueue,alternateCatalogue);
        try {
            offline=true;
            assert.equal((await catalogueOnly.snapshot()).shots.length,2);
            await catalogueOnly.update([id],{field:'notes',operation:'set',value:'Edited using retained catalogue'});
            assert.equal((await catalogueOnly.snapshot()).shots.find(shot=>shot.id===id).organization.notes,'Edited using retained catalogue');
        } finally { offline=false;await catalogueOnly.close();await alternateQueue.close();await alternateScanner.close(); }
        const drafts=await fs.readFile(draftFile);
        assert.ok((await cacheInventory(cache)).catalogue.bytes>0);
        await clearSelectedCache(cache,{catalogue:true,metadata:false,thumbnails:false,fingerprints:false,proxies:false},library);
        assert.equal(await fs.stat(catalogFile).catch(()=>null),null);assert.deepEqual(await fs.readFile(draftFile),drafts,'Clearing catalogue retains pending edits');
        await catalogue.close();await fs.writeFile(catalogFile,'{corrupt');
        const corrupt=new LibraryCatalogue(scanner,async()=>library,inspect,queue,catalogFile);
        await assert.rejects(corrupt.snapshot(),/preserved/);assert.equal(await fs.readFile(catalogFile,'utf8'),'{corrupt');
        console.log('PASS: local thumbnail persistence, stale-review/transfer/save failures, thumbnail Commit/Revert and JSON-last publication, catalogue refresh, neutral Library cards, shared persistent drafts, clean/dirty remote changes, metadata-only queued Commit, Revert, offline browsing/thumbnails, malformed-record preservation, stale review, restart, and independent cache clearing.');
    }finally{await catalogue?.close();await queue?.close();await scanner?.close();await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
