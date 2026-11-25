// Run shipped code/assets with an isolated profile and dummy footage only.
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const version = require('../package.json').version;
if (!process.versions.electron) {
    const root = fs.realpathSync(fs.mkdtempSync(join(require('node:os').tmpdir(), 'shot-manager-package-check-')));
    const bundle = resolve(process.argv[2] || `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Shot Manager.app`);
    try {
        for (const name of ['existing-profile','library','source']) fs.mkdirSync(join(root,name));
        // An existing installation can reuse its profile through a directory symlink.
        fs.symlinkSync('existing-profile', join(root, 'profile'));
        execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-t','0.3','-c:v','libx264','-pix_fmt','yuv420p',join(root,'source','sample.mp4')]);
        const env={...process.env,SHOT_MANAGER_PACKAGE_CHECK_ROOT:root,SHOT_MANAGER_PACKAGE_CHECK_BUNDLE:bundle,PATH:'/usr/bin:/bin:/usr/sbin:/sbin'};
        delete env.ELECTRON_RUN_AS_NODE; env.ELECTRON_RENDERER_URL='about:blank';
        const result=spawnSync(require('electron'),[__filename],{env,stdio:'inherit',timeout:35000});
        if(result.error)console.error(result.error);
        if(result.status!==0 || !fs.existsSync(join(root,'validated')))process.exitCode=1;
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
} else {
    const assert=require('node:assert/strict');
    const electron=require('electron'),{app}=electron;
    const root=process.env.SHOT_MANAGER_PACKAGE_CHECK_ROOT;
    if(!root)throw new Error('Missing isolated test profile');
    const resources=join(process.env.SHOT_MANAGER_PACKAGE_CHECK_BUNDLE,'Contents','Resources');
    const archive=join(resources,'app.asar');
    app.setPath('userData',join(root,'profile'));
    app.getAppPath=()=>archive;
    Object.defineProperty(app,'isPackaged',{value:true});
    Object.defineProperty(process,'resourcesPath',{value:resources});
    const userResources = join(root, 'profile', 'Resources');
    let window, backend, openedFolder;
    const originalLoad=require('node:module')._load;
    const fork=electron.utilityProcess.fork.bind(electron.utilityProcess);
    const wrapped={...electron,
        BrowserWindow:class extends electron.BrowserWindow {
            constructor(options){super({...options,show:false,webPreferences:{...options.webPreferences,backgroundThrottling:false}});window=this;}
        },
        utilityProcess:{...electron.utilityProcess,fork(path,args,options){
            assert.ok(options.env.PATH.split(':').includes('/opt/homebrew/bin'));
            assert.equal(options.env.SHOT_MANAGER_LUT_DIRECTORY,join(userResources,'LUT'));
            backend=fork(path,args,options);return backend;
        }},
        shell:{...electron.shell,openPath:async folder=>{openedFolder=folder;return '';}},
        dialog:{...electron.dialog,showOpenDialog:async(_window,options)=>({canceled:false,filePaths:[join(root,options.title==='Set Library Location'?'library':'source')]})},
    };
    require('node:module')._load=function(request,parent,isMain){return request==='electron'?wrapped:originalLoad.call(this,request,parent,isMain);};
    const timer=setTimeout(()=>{console.error('Packaged launch timed out');backend?.kill();app.exit(1);},30000);
    require(join(archive,'out/main/index.cjs'));
    app.whenReady().then(async()=>{
        const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const until=async(test,label)=>{for(let i=0;i<750;i++){if(await test())return;await sleep(20);}throw new Error(label);};
        const js=code=>window.webContents.executeJavaScript(code,true).catch(error=>{console.error('Failed renderer check:',code);throw error;});
        try {
            const plist = join(resources, '..', 'Info.plist');
            assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { encoding: 'utf8' }).trim(), 'org.shotmanager.desktop');
            for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
                assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim(), 'Shot Manager');
            }
            assert.equal(app.getName(), 'Shot Manager');
            assert.equal(app.getPath('userData'), join(root, 'profile'));
            assert.equal(JSON.parse(fs.readFileSync(join(archive,'package.json'),'utf8')).version,version);
            assert.equal(JSON.parse(fs.readFileSync(join(archive,'package.json'),'utf8')).name,'shot-manager','Packaged manifest uses the Shot Manager package name');
            assert.equal(fs.readFileSync(join(archive, 'LICENSE'), 'utf8'), fs.readFileSync(join(__dirname, '..', 'LICENSE'), 'utf8'));
            await until(()=>window&&!window.webContents.isLoadingMainFrame(),'Renderer did not load');
            assert.equal(require('node:url').fileURLToPath(window.webContents.getURL()), join(archive,'out/renderer/index.html'), 'Packaged app uses its own renderer');
            await until(()=>js(`!!window.desktop && window.desktop.getBackendStatus().then(s=>s.state==='connected')`),'Bundled backend did not start');
            const appMenu = electron.Menu.getApplicationMenu().getMenuItemById('advanced').submenu;
            appMenu.items.find(item => item.label === 'Open Resources Folder…').click();
            await until(() => openedFolder === userResources, 'Resources menu did not open the profile Resources folder');
            assert.deepEqual(fs.readdirSync(join(userResources, 'LUT')), []);
            assert.equal((await js('window.desktop.getConfiguration()')).libraryPath,null,'Never load real configuration');
            await until(()=>js(`document.querySelector('section[aria-label="Shot cards"] h2')?.textContent==='Library Not Configured'`),'Import must use the unconfigured Library wording');
            await js(`Array.from(document.querySelectorAll('header button')).find(button=>button.textContent==='Library').click()`);
            await until(()=>js(`document.querySelector('section[aria-label="Shot cards"] h2')?.textContent==='Library Not Configured'`),'Library must show its unconfigured placeholder');
            assert.equal(await js(`!!document.querySelector('section[aria-label="Shot cards"] [aria-label="Add clips"]')`),false,'Library placeholder has no add button');
            await js(`(async()=>{const choice=await window.desktop.chooseLibrary();await window.desktop.saveConfigurationLocations({library:choice.token});})()`);
            await until(()=>js(`!!document.querySelector('[data-application-level="ready"]')`),'Ready status missing');
            assert.equal(await js(`document.title==='Shot Manager' && document.querySelector('header h1')?.textContent==='Shot Manager'`), true);
            await js('window.desktop.refreshCatalogue()');
            await until(()=>js(`document.querySelector('section[aria-label="Shot cards"] h2')?.textContent==='Library Empty'`),'Configured empty Library must show its empty placeholder');
            assert.equal(await js(`!!document.querySelector('section[aria-label="Shot cards"] [aria-label="Add clips"]')`),false,'Empty Library has no add button');
            await js(`Array.from(document.querySelectorAll('header button')).find(button=>button.textContent==='Import').click()`);
            await js(`document.querySelector('[aria-label="Configuration"]').click()`);
            await until(()=>js(`!!document.querySelector('dialog[open] #configuration-title')`),'Configuration did not open');
            assert.equal(await js(`document.querySelector('#configuration-title + [aria-label="Application version"]')?.textContent`), version);
            await until(()=>js(`document.querySelector('[aria-label="Clear Library location"]')?.textContent.trim()==='Clear'`), 'Configured Library location did not load');
            await js(`document.querySelector('[aria-label="Clear Library location"]').click()`);
            assert.equal(await js(`document.querySelector('[aria-label="Configured Library location"]')?.textContent.trim()`), 'Clears on Save');
            assert.equal((await js('window.desktop.getConfiguration()')).libraryPath, join(root, 'library'));
            assert.equal(await js(`Array.from(document.querySelectorAll('dialog[open] h2, dialog[open] p, dialog[open] span')).every(el=>getComputedStyle(el).userSelect==='none')`),true,'Dialog labels and paths cannot be selected');
            const heading=await js(`(()=>{window.getSelection().removeAllRanges();const r=document.getElementById('configuration-title').getBoundingClientRect();return {x:Math.round(r.left+2),end:Math.round(r.right-2),y:Math.round(r.top+r.height/2)};})()`);
            window.webContents.sendInputEvent({type:'mouseDown',x:heading.x,y:heading.y,button:'left',clickCount:1});
            window.webContents.sendInputEvent({type:'mouseMove',x:heading.end,y:heading.y,modifiers:['leftButtonDown']});
            window.webContents.sendInputEvent({type:'mouseUp',x:heading.end,y:heading.y,button:'left',clickCount:1});
            await sleep(50);
            assert.equal(await js(`window.getSelection().toString()`),'','Dragging Configuration text must not highlight it');
            await js(`document.querySelector('dialog[open]').dispatchEvent(new Event('cancel',{cancelable:true}))`);
            await js('window.desktop.chooseClips()');
            await until(()=>js(`window.desktop.getShots().then(s=>s.shots.length===1&&s.shots[0].thumbnailStatus==='ready'&&s.shots[0].proxyState==='ready')`),'Finder PATH must support inspection, thumbnails, and proxy encoding');
            await until(()=>js(`!!document.querySelector('[data-shot-card] > button')`),'Import card did not render');
            await js(`document.querySelector('[data-shot-card] > button').click()`);
            await until(()=>js(`!!document.querySelector('input[aria-label="Scene"]:not(:disabled)')`),'Editable Scene field missing');
            assert.equal(await js(`getComputedStyle(document.querySelector('input[aria-label="Scene"]')).userSelect`),'text','Editable text fields still allow selection');
            assert.equal(fs.existsSync(join(archive,'out/resources/luts')),false,'Development LUT output must never leak into the archive');
            assert.equal(fs.existsSync(join(resources,'luts')),false,'Packages must exclude camera LUTs');
            // Run an actual Library repair through the menu and both confirmation dialogs.
            const id = await js('window.desktop.getShots().then(s => s.shots[0].id)');
            await js(`window.desktop.reviewIngest(['${id}']).then(r => window.desktop.startIngest(r.token, ['${id}']))`);
            await until(() => js('window.desktop.getLibrary().then(s => s.shots.length === 1)'), 'Import Commit did not publish');
            await js(`Array.from(document.querySelectorAll('header button')).find(b => b.textContent === 'Library').click()`);
            await until(() => js(`!!document.querySelector('[data-shot-card] > button')`), 'Library card missing');
            const target = join(root, 'library', id + '.proxy.mov');
            fs.writeFileSync(target, 'old proxy');
            const original = join(root, 'library', id + '.source.mp4'), before = fs.statSync(original);
            const menu = appMenu.getMenuItemById('reencode-proxies');
            await js(`document.querySelector('[data-shot-card] > button').click()`);
            await until(() => menu.enabled, 'Explicit selection did not enable Re-Encode');
            menu.click(menu, window);
            const button = label => `Array.from(document.querySelectorAll('dialog[open] button')).find(b => b.textContent.trim() === '${label}')`;
            await until(() => js(`!!(${button('Re-Encode')})`), 'Re-encode review missing');
            await js(`(${button('Cancel')}).click()`);
            assert.equal(fs.readFileSync(target, 'utf8'), 'old proxy');
            await until(() => menu.enabled, 'Re-encode menu did not reopen');
            menu.click(menu, window);
            await until(() => js(`!!(${button('Re-Encode')})`), 'Re-encode confirmation missing');
            await js(`(${button('×')}).click()`);
            assert.equal(await js(`(${button('Re-Encode')}).disabled`), true, 'Cannot confirm an empty review');
            assert.equal(await js(`document.querySelector('dialog [data-review-included="false"] button').getAttribute('aria-pressed')`), 'true');
            assert.equal(await js(`document.querySelector('dialog p').textContent`), '0 clips');
            await js(`(${button('−')}).click()`);
            assert.equal(await js(`document.querySelector('dialog p').textContent`), '1 clip');
            assert.equal(await js(`(${button('Re-Encode')}).disabled`), false);
            await js(`(${button('Re-Encode')}).click()`);
            await until(() => js('window.desktop.getLibrary().then(s => s.shots[0]?.pendingProxy && s.shots[0]?.editable)'), 'No staged proxy');
            assert.equal(fs.readFileSync(target, 'utf8'), 'old proxy');
            const commitButton = `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Commit' && !b.disabled)`;
            await until(() => js(`!!(${commitButton})`), 'A staged replacement did not enable Commit');
            await js(`(${commitButton}).click()`);
            await until(() => js(`document.querySelector('dialog[open]')?.textContent.includes('Replace Library proxy')`), 'Commit did not review the proxy');
            await js(`(${button('Commit')}).click()`);
            await until(() => js('window.desktop.getLibrary().then(s => s.shots[0]?.editable && !s.shots[0]?.pendingProxy)'), 'Proxy Commit failed');
            assert.equal(execFileSync('ffprobe', ['-v','error','-select_streams','v:0','-show_entries','stream=codec_name','-of','csv=p=0',target],
                { encoding: 'utf8', env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin' } }).trim(), 'prores');
            assert.equal(fs.statSync(original).ino, before.ino);
            assert.equal(fs.statSync(original).mtimeMs, before.mtimeMs);
            fs.writeFileSync(join(root,'validated'),'passed');
            console.log('PASS: shipped Shot Manager bundle and title, Configuration version and Clear action, optional local LUT support, Finder PATH, and isolated media processing.');
            clearTimeout(timer);app.quit();
        }catch(error){console.error(error);clearTimeout(timer);backend?.kill();app.exit(1);}
    });
}
