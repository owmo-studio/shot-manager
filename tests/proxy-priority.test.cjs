// Commit-priority preemption with temporary synthetic originals and local Libraries only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const execute = require('node:util').promisify(require('node:child_process').execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, message) { for (let i=0;i<750;i++) { if(await test()) return; await sleep(20); } throw new Error(`Timed out: ${message}`); }
(async()=>{
    const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'shot-manager-proxy-priority-')));
    try {
        const entry=join(root,'entry.ts');
        await fs.writeFile(entry,['server/workspace.ts','server/proxies.ts','server/ingestion.ts','server/library.ts'].map(file=>`export * from ${JSON.stringify(resolve(file))};`).join('\n'));
        const bundle=await(await import('vite')).build({configFile:false,logLevel:'silent',build:{ssr:true,write:false,rollupOptions:{input:entry,output:{format:'cjs'}}}});
        const loaded=new(require('node:module'))(__filename,module);loaded.paths=module.paths;
        loaded._compile(bundle.output.find(item=>item.type==='chunk'&&item.isEntry).code,__filename);
        const {WorkspaceManager,ProxyQueue,IngestQueue,inspectLibrary}=loaded.exports;
        const source=join(root,'source');await fs.mkdir(source);
        for(const color of ['blue','red','green']) await execute('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=${color}:s=160x90:r=10`,'-t','0.2','-c:v','libx264','-pix_fmt','yuv420p',join(source,`${color}.mp4`)]);
        const originals=await Promise.all((await fs.readdir(source)).map(async name=>[name,await fs.readFile(join(source,name))]));
        for(const scenario of [{percent:0,stop:true},{percent:19},{percent:20},{percent:85},{percent:19,finishing:true},{percent:19,existingProxy:true}]) {
            const location=join(root,`case-${scenario.percent}-${scenario.stop?'stop':scenario.existingProxy?'ready':scenario.finishing?'finishing':'encode'}`);
            const library=join(location,'library'),scratch=join(location,'scratch');
            await fs.mkdir(library,{recursive:true});await fs.mkdir(scratch);
            const config={version:1,libraryPath:library,libraryMount:(await inspectLibrary(library)).mount,scratchPath:scratch,scratchMount:(await inspectLibrary(scratch)).mount};
            const workspace=new WorkspaceManager(join(location,'thumbs'),join(location,'fingerprints'),join(location,'drafts.json'));
            const scanner=workspace.scanner;const started=[];let active=0,maxActive=0;
            const proxies=new ProxyQueue(scanner,async()=>config,async(_input,output,shot,signal,progress)=>{
                active++;maxActive=Math.max(maxActive,active);
                try {
                    await fs.writeFile(output,'partial fixture proxy');
                    let release;
                    const gate=new Promise((resolve,reject)=>{
                        const abort=()=>reject(new Error('Fixture encode interrupted'));
                        release=()=>{signal.removeEventListener('abort',abort);resolve();};
                        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
                    });
                    progress(started.length===0?scenario.percent:0);
                    started.push({id:shot.id,signal,output,progress,release});
                    await gate;await fs.writeFile(output,'complete fixture proxy');
                } finally {active--;}
            });
            const queue=new IngestQueue(scanner,async()=>library,inspectLibrary,undefined,proxies);
            scanner.onChange=()=>{proxies.schedule();queue.backgroundChanged();};
            let releaseFinishing;
            try {
                await queue.status();await workspace.add(source);
                await until(()=>started.length===1,'background encode');
                const first=started[0];
                if(scenario.finishing){
                    const validate=scanner.validateIngest.bind(scanner);let held=false;
                    scanner.validateIngest=async(...args)=>{
                        if(args[0]===first.id&&!held){held=true;await new Promise(resolve=>{releaseFinishing=resolve;});}
                        return validate(...args);
                    };
                    first.release();await until(()=>held,'completed encode finalizing');
                }
                const [target,another]=scanner.snapshot().shots.filter(shot=>shot.id!==first.id);
                if(scenario.existingProxy)await fs.writeFile(join(library,`${target.id}.proxy.mov`),'existing fixture proxy');
                let review=await queue.preview([target.id]);await queue.submit(review.token,[target.id]);
                if(scenario.stop){
                    assert.equal(first.signal.aborted,true,'Below-20 background work is interrupted immediately');
                    await queue.stop();await sleep(120);
                    assert.equal(started.length,1,'Stop prevents a late priority start');
                    assert.equal(proxies.status().paused,true);assert.equal((await queue.status()).active,false);
                } else if(scenario.existingProxy){
                    await until(async()=>!(await queue.status()).active,'ready proxy Commit');
                    assert.equal(first.signal.aborted,false,'An existing Library proxy does not interrupt useful background encoding');
                    assert.equal(started.length,1);
                } else {
                    if(scenario.percent>=20||scenario.finishing){
                        await sleep(120);assert.equal(first.signal.aborted,false,`${scenario.percent}% encode must finish first`);
                        assert.equal(started.length,1);first.release();releaseFinishing?.();
                    }
                    await until(()=>started.some(item=>item.id===target.id),'submitted proxy starts');
                    const priority=started.find(item=>item.id===target.id);
                    if(scenario.percent<20&&!scenario.finishing){
                        assert.equal(first.signal.aborted,true);
                        assert.equal(await fs.stat(first.output).catch(()=>null),null,'Interrupted partial output is cleaned before switching');
                        first.progress(90);
                        assert.notEqual(scanner.snapshot().shots.find(shot=>shot.id===first.id).proxyPercent,90,'Late progress from an aborted encode is ignored');
                        assert.equal((await queue.status()).tasks.proxiesRemaining,3,'Interrupted work remains queued');
                        review=await queue.preview([another.id]);await queue.submit(review.token,[another.id]);
                        await sleep(80);assert.equal(priority.signal.aborted,false,'Already-submitted encodes are never preempted');
                    }
                    priority.release();
                    await until(()=>scanner.snapshot().shots.find(shot=>shot.id===target.id).ingestState==='synced','priority clip committed');
                    if(scenario.percent<20&&!scenario.finishing){
                        await until(()=>started.some(item=>item.id===another.id),'appended priority proxy');
                        started.find(item=>item.id===another.id).release();
                        await until(()=>started.filter(item=>item.id===first.id).length===2,'interrupted background encode restarts');
                        assert.equal(scanner.snapshot().shots.find(shot=>shot.id===first.id).proxyPercent,0,'Restart begins at zero');
                        started.filter(item=>item.id===first.id)[1].release();
                        await until(()=>scanner.snapshot().shots.find(shot=>shot.id===first.id).proxyState==='ready','background completes');
                    }
                    await until(async()=>!(await queue.status()).active,'queue completes');
                }
                assert.equal(maxActive,1,'Only one encoder runs at a time');
                assert.deepEqual((await queue.status()).errors,[],'Preemption is not reported as failure');
            } finally {releaseFinishing?.();await queue.close();await proxies.close();await workspace.close();}
        }
        for(const [name,bytes]of originals)assert.deepEqual(await fs.readFile(join(source,name)),bytes);
        console.log('PASS: strict below-20% preemption, priority ordering, restart/partial cleanup, existing-proxy reuse, single encoder, late progress suppression and Stop races.');
    } finally {await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
