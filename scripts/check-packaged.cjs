// Run shipped code/assets with an isolated profile and dummy footage only.
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const version = require('../package.json').version;
if (!process.versions.electron) {
    const root = fs.realpathSync(fs.mkdtempSync(join(require('node:os').tmpdir(), 'owmo-package-check-')));
    const bundle = resolve(process.argv[2] || `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/OWMO Shot Manager.app`);
    try {
        for (const name of ['profile','library','source']) fs.mkdirSync(join(root,name));
        execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-t','0.3','-c:v','libx264','-pix_fmt','yuv420p',join(root,'source','sample.mp4')]);
        const env={...process.env,OWMO_PACKAGE_CHECK_ROOT:root,OWMO_PACKAGE_CHECK_BUNDLE:bundle,PATH:'/usr/bin:/bin:/usr/sbin:/sbin'};
        delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
        const result=spawnSync(require('electron'),[__filename],{env,stdio:'inherit',timeout:35000});
        if(result.error)console.error(result.error);
        if(result.status!==0 || !fs.existsSync(join(root,'validated')))process.exitCode=1;
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
} else {
    const assert=require('node:assert/strict');
    const electron=require('electron'),{app}=electron;
    const root=process.env.OWMO_PACKAGE_CHECK_ROOT;
    if(!root)throw new Error('Missing isolated test profile');
    const resources=join(process.env.OWMO_PACKAGE_CHECK_BUNDLE,'Contents','Resources');
    const archive=join(resources,'app.asar');
    app.setPath('userData',join(root,'profile'));
    app.getAppPath=()=>archive;
    Object.defineProperty(app,'isPackaged',{value:true});
    Object.defineProperty(process,'resourcesPath',{value:resources});
    let window, backend;
    const originalLoad=require('node:module')._load;
    const fork=electron.utilityProcess.fork.bind(electron.utilityProcess);
    const wrapped={...electron,
        BrowserWindow:class extends electron.BrowserWindow {
            constructor(options){super({...options,show:false,webPreferences:{...options.webPreferences,backgroundThrottling:false}});window=this;}
        },
        utilityProcess:{...electron.utilityProcess,fork(path,args,options){
            assert.ok(options.env.PATH.split(':').includes('/opt/homebrew/bin'));
            assert.equal(options.env.SHOT_MANAGER_LUT_DIRECTORY,join(resources,'luts'));
            backend=fork(path,args,options);return backend;
        }},
        dialog:{...electron.dialog,showOpenDialog:async(_window,options)=>({canceled:false,filePaths:[join(root,options.title==='Set Library Location'?'library':'source')]})},
    };
    require('node:module')._load=function(request,parent,isMain){return request==='electron'?wrapped:originalLoad.call(this,request,parent,isMain);};
    const timer=setTimeout(()=>{console.error('Packaged launch timed out');backend?.kill();app.exit(1);},30000);
    require(join(archive,'out/main/index.cjs'));
    app.whenReady().then(async()=>{
        const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const until=async(test,label)=>{for(let i=0;i<750;i++){if(await test())return;await sleep(20);}throw new Error(label);};
        const js=code=>window.webContents.executeJavaScript(code,true);
        try {
            assert.equal(JSON.parse(fs.readFileSync(join(archive,'package.json'),'utf8')).version,version);
            assert.equal(JSON.parse(fs.readFileSync(join(archive,'package.json'),'utf8')).name,'owmo-shot-manager','Keep the existing app-data directory name');
            await until(()=>window&&!window.webContents.isLoadingMainFrame(),'Renderer did not load');
            await until(()=>js(`!!window.desktop && window.desktop.getBackendStatus().then(s=>s.state==='connected')`),'Bundled backend did not start');
            assert.equal((await js('window.desktop.getConfiguration()')).libraryPath,null,'Never load real configuration');
            await js(`(async()=>{const choice=await window.desktop.chooseLibrary();await window.desktop.saveConfigurationLocations({library:choice.token});})()`);
            await until(()=>js(`document.querySelector('[data-application-level="ready"]') && document.querySelector('header [aria-label="Application version"]')?.textContent==='${version}'`),'Ready/version missing');
            await js('window.desktop.chooseClips()');
            await until(()=>js(`window.desktop.getShots().then(s=>s.shots.length===1&&s.shots[0].thumbnailStatus==='ready'&&s.shots[0].proxyState==='ready')`),'Finder PATH must support inspection, thumbnails, and proxy encoding');
            for(const name of ['sony-s709.cube','apple-log-rec709.cube'])assert.ok(fs.statSync(join(resources,'luts',name)).size>1000,'Real LUT files live outside ASAR');
            fs.writeFileSync(join(root,'validated'),'passed');
            console.log('PASS: shipped renderer/preload/backend/dependencies, header version, external LUT assets, Finder PATH, thumbnail/proxy generation, and isolated app data.');
            clearTimeout(timer);app.quit();
        }catch(error){console.error(error);clearTimeout(timer);backend?.kill();app.exit(1);}
    });
}
