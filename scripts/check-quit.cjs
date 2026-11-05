// Real Electron/main/backend lifecycle, isolated user data and hidden test window.
const fs = require('node:fs');
const { join } = require('node:path');
if (!process.versions.electron) {
    for (const mode of ['normal', 'close-button', 'failed-save', 'close-button-failed-save', 'discard-failed-save']) {
        const root = fs.mkdtempSync(join(require('node:os').tmpdir(), 'shot-quit-check-'));
        try {
            const env = { ...process.env, SHOT_MANAGER_QUIT_TEST_ROOT: root, SHOT_MANAGER_QUIT_TEST_MODE: mode };
            delete env.ELECTRON_RUN_AS_NODE;
            const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 20000 });
            if (result.error) console.error(result.error);
            if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
            if (!fs.existsSync(join(root,'validated'))) { console.error('Quit bypassed lifecycle validation'); process.exitCode=1; break; }
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
} else {
    const assert = require('node:assert/strict');
    const electron = require('electron');
    const { app, Menu } = electron;
    const root = process.env.SHOT_MANAGER_QUIT_TEST_ROOT;
    if (!root) throw new Error('Missing isolated test directory');
    const mode = process.env.SHOT_MANAGER_QUIT_TEST_MODE;
    const closeButton = mode.includes('close-button');
    const failureMode = mode.includes('failed-save');
    const discardMode = process.env.SHOT_MANAGER_QUIT_TEST_MODE === 'discard-failed-save';
    let allowWrites = !failureMode, prompts = 0, backendExited = false;
    const profile = join(root, 'profile'); fs.mkdirSync(profile);
    app.setPath('userData', profile);
    let window, backend, backendURL, token, accepted = 0, textRequests = 0, requested = false, observedQuit = false;
    const timer = setTimeout(() => { console.error('Command+Q did not finish gracefully'); backend?.kill(); app.exit(1); }, 15000);
    let activeReads = 0, shutdownRequested = false, lateFetches = 0, failedFetches = 0;
    let vocabularyHandler, vocabularyArgs;
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
        if (shutdownRequested) lateFetches++;
        const vocabulary = String(url).endsWith('/api/organization/vocabulary');
        if (vocabulary) activeReads++;
        try {
        if (vocabulary) await new Promise(resolve => setTimeout(resolve, 150));
        if (String(url).endsWith('/api/organization') && options?.method === 'PATCH') {
            textRequests++; await new Promise(resolve => setTimeout(resolve, 100));
            if (requested && !allowWrites) return new Response(JSON.stringify({message:'Synthetic disk failure'}), {status:503});
        }
        return await originalFetch(url, options);
        } catch(error) { failedFetches++; throw error; }
        finally { if(vocabulary) activeReads--; }
    };
    const originalLoad = require('node:module')._load;
    const fork = electron.utilityProcess.fork.bind(electron.utilityProcess);
    const handle = electron.ipcMain.handle.bind(electron.ipcMain);
    const wrapped = {
        ...electron,
        dialog: { ...electron.dialog, showMessageBox: async () => {
            prompts++;
            assert.ok(failureMode && !window.isDestroyed(), 'Failed saves keep the renderer available');
            return {response:discardMode ? 2 : 0};
        } },
        BrowserWindow: class extends electron.BrowserWindow {
            constructor(options) { super({ ...options, show: false }); window = this; }
        },
        utilityProcess: { ...electron.utilityProcess, fork(path, args, options) {
            token = options.env.SHOT_MANAGER_TOKEN;
            backend = fork(path, args, options);
            const post = backend.postMessage.bind(backend);
            backend.postMessage = message => {
                if (message === 'shutdown') {
                    assert.ok(!window.isDestroyed(), 'Closing window stays available until backend exit');
                    assert.equal(activeReads, 0, 'Accepted vocabulary reads finish before backend shutdown');
                    shutdownRequested = true;
                    // Simulate an IPC call arriving after the renderer started closing.
                    void Promise.resolve(vocabularyHandler(...vocabularyArgs)).catch(error => { console.error(error); app.exit(1); });
                    setTimeout(() => {
                        void (async () => {
                            assert.ok(!window.isDestroyed(), 'Delayed shutdown does not hide the closing window');
                            assert.ok(await window.webContents.executeJavaScript(`document.body.inert && document.body.textContent.includes('Stopping background work and closing')`), 'Both exit paths show shutdown progress and prevent further edits');
                            post(message);
                        })().catch(error => { console.error(error); app.exit(1); });
                    }, 250);
                    return;
                }
                return post(message);
            };
            backend.on('message', message => { if (message?.type === 'ready') backendURL = message.url; });
            backend.on('exit', () => {
                backendExited = true;
                assert.ok(!window.isDestroyed(), 'The backend exits before the window is destroyed');
            });
            return backend;
        } },
        ipcMain: { ...electron.ipcMain, handle(channel, handler) {
            if (channel === 'organization:vocabulary') vocabularyHandler = handler;
            handle(channel, (...args) => {
                if (channel === 'organization:vocabulary') vocabularyArgs = args;
                if (channel === 'organization:update') accepted++;
                return handler(...args);
            });
        } },
    };
    require('node:module')._load = function(request, parent, isMain) {
        return request === 'electron' ? wrapped : originalLoad.call(this, request, parent, isMain);
    };
    app.on('before-quit', () => { observedQuit = true; });
    app.on('will-quit', () => {
        try {
            assert.ok(requested && observedQuit && shutdownRequested && backendExited);
            assert.ok(window.isDestroyed(), 'Window closes after backend exit');
            assert.equal(lateFetches,0,'No renderer fetch reaches a closing backend');
            assert.equal(failedFetches,0,'Normal quit causes no refused backend requests');
            const saved = JSON.parse(fs.readFileSync(join(profile, 'organization.json'), 'utf8'));
            assert.equal(Object.values(saved.drafts)[0].data.notes, 'last accepted edit');
            assert.equal(Object.values(saved.drafts)[0].data.scene, discardMode ? 'Walking home.' : 'Final scene before closing.');
            assert.equal(textRequests, failureMode && !discardMode ? 4 : 3, 'Scene and Notes save independently, and pending Scene flushes on either exit path');
            if (failureMode) assert.equal(prompts, 1, 'Failed quit requires an explicit choice');
            clearTimeout(timer);
            fs.writeFileSync(join(root,'validated'),'passed');
            console.log(`PASS: ${mode} drains accepted work, reports delayed shutdown, preserves failed-save choices, and closes only after backend exit.`);
        } catch (error) { console.error(error); app.exit(1); }
    });
    require('../out/main/index.cjs');
    app.whenReady().then(async () => {
        try {
            const wait = async condition => { for (let i = 0; i < 150; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Quit fixture did not settle'); };
            await wait(() => backendURL && window && !window.webContents.isLoading());
            assert.equal(Menu.getApplicationMenu().getMenuItemById('quit-shot-manager').accelerator, 'CommandOrControl+Q');
            const ipcError = await window.webContents.executeJavaScript(`window.desktop.refreshSource('missing-source').then(()=>null,error=>({message:error.message,code:error.code,status:error.status,outcome:error.outcome}))`);
            assert.equal(ipcError.status,404,'HTTP status survives the real preload boundary');
            assert.equal(ipcError.outcome,'failed');
            assert.ok(ipcError.code && ipcError.message.includes('Source not found'));

            const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
            const source = join(root, 'dummy-source'); fs.mkdirSync(source); fs.writeFileSync(join(source, 'clip.mp4'), 'synthetic test video');
            await originalFetch(`${backendURL}/api/sources`, { method: 'POST', headers, body: JSON.stringify({ path: source }) });
            let shot;
            await wait(async () => {
                const collection = await (await originalFetch(`${backendURL}/api/shots`, { headers })).json();
                shot = collection.shots[0]; return !!shot?.organization;
            });
            await window.webContents.executeJavaScript(`window.desktop.updateOrganization([${JSON.stringify(shot.id)}],{field:'notes',operation:'set',value:'first edit'}).catch(()=>{});window.desktop.updateOrganization([${JSON.stringify(shot.id)}],{field:'notes',operation:'set',value:'last accepted edit'}).catch(()=>{});void 0`);
            await wait(() => accepted === 2);
            await new Promise(resolve => setTimeout(resolve, 40));
            assert.equal(textRequests, 0, 'Notes do not save on every accepted keystroke');
            await window.webContents.executeJavaScript(`window.desktop.updateOrganization([${JSON.stringify(shot.id)}],{field:'scene',operation:'set',value:'Walking'}).catch(()=>{});window.desktop.updateOrganization([${JSON.stringify(shot.id)}],{field:'scene',operation:'set',value:'Walking home.'}).catch(()=>{});void 0`);
            await wait(() => accepted === 4);
            await window.webContents.executeJavaScript('window.desktop.flushOrganizationText()');
            assert.equal(textRequests,2,'Switching from Notes to Scene does not coalesce away either field');
            await window.webContents.executeJavaScript(`window.desktop.updateOrganization([${JSON.stringify(shot.id)}],{field:'scene',operation:'set',value:'Final'}).catch(()=>{});window.desktop.updateOrganization([${JSON.stringify(shot.id)}],{field:'scene',operation:'set',value:'Final scene before closing.'}).catch(()=>{});void 0`);
            await wait(() => accepted === 6);
            await window.webContents.executeJavaScript(`setInterval(()=>window.desktop.getTagVocabulary().catch(()=>{}),10);void 0`);
            await wait(()=>activeReads>0);
            const requestExit = () => {
                if (closeButton) window.close();
                else {
                    window.webContents.focus();
                    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Q',modifiers:['meta']});
                    if (!window.isDestroyed()) window.webContents.sendInputEvent({type:'keyUp',keyCode:'Q',modifiers:['meta']});
                }
            };
            requested = true;
            requestExit();
            if (failureMode && !discardMode) {
                await wait(() => prompts === 1);
                await wait(async () => (await window.webContents.executeJavaScript('window.desktop.getSaveStatus()'))?.failed === 1);
                await window.loadFile(join(__dirname, '../out/renderer/index.html'));
                assert.equal((await window.webContents.executeJavaScript('window.desktop.getSaveStatus()')).failed, 1, 'Unsaved edits survive renderer reload');
                await wait(() => window.webContents.executeJavaScript(`!!document.querySelector('[aria-label="Retry unsaved changes"]')`));
                allowWrites = true;
                await wait(()=>window.webContents.executeJavaScript(`!!document.getElementById('shot-${shot.id}')`));
                await window.webContents.executeJavaScript(`document.getElementById('shot-${shot.id}').click()`);
                await wait(()=>window.webContents.executeJavaScript(`document.querySelector('[aria-label="Scene"]')?.value==='Walking home.'`));
                await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Retry unsaved changes"]').click()`);
                await wait(async()=>{const status=await window.webContents.executeJavaScript('window.desktop.getSaveStatus()');return !status.failed&&!status.pending;});
                await wait(()=>window.webContents.executeJavaScript(`document.querySelector('[aria-label="Scene"]')?.value==='Final scene before closing.'`));
                requestExit();
            }
        } catch (error) { console.error(error); backend?.kill(); app.exit(1); }
    });
}
