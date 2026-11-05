// Real Electron/main/backend lifecycle, isolated user data and hidden test window.
const fs = require('node:fs');
const { join } = require('node:path');
if (!process.versions.electron) {
    const root = fs.mkdtempSync(join(require('node:os').tmpdir(), 'shot-quit-check-'));
    try {
        const env = { ...process.env, SHOT_MANAGER_QUIT_TEST_ROOT: root };
        delete env.ELECTRON_RUN_AS_NODE;
        const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 15000 });
        if (result.error) console.error(result.error);
        process.exitCode = result.status ?? 1;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
    const assert = require('node:assert/strict');
    const electron = require('electron');
    const { app, Menu } = electron;
    const root = process.env.SHOT_MANAGER_QUIT_TEST_ROOT;
    if (!root) throw new Error('Missing isolated test directory');
    const profile = join(root, 'profile'); fs.mkdirSync(profile);
    app.setPath('userData', profile);
    let window, backend, backendURL, token, accepted = 0, noteRequests = 0, requested = false, observedQuit = false;
    const timer = setTimeout(() => { console.error('Command+Q did not finish gracefully'); backend?.kill(); app.exit(1); }, 8000);
    let activeReads = 0, shutdownRequested = false, lateFetches = 0, failedFetches = 0;
    let vocabularyHandler, vocabularyArgs;
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
        if (shutdownRequested) lateFetches++;
        const vocabulary = String(url).endsWith('/api/organization/vocabulary');
        if (vocabulary) activeReads++;
        try {
        if (vocabulary) await new Promise(resolve => setTimeout(resolve, 150));
        if (String(url).endsWith('/api/organization') && options?.method === 'PATCH') { noteRequests++; await new Promise(resolve => setTimeout(resolve, 100)); }
        return await originalFetch(url, options);
        } catch(error) { failedFetches++; throw error; }
        finally { if(vocabulary) activeReads--; }
    };
    const originalLoad = require('node:module')._load;
    const fork = electron.utilityProcess.fork.bind(electron.utilityProcess);
    const handle = electron.ipcMain.handle.bind(electron.ipcMain);
    const wrapped = {
        ...electron,
        BrowserWindow: class extends electron.BrowserWindow {
            constructor(options) { super({ ...options, show: false }); window = this; }
        },
        utilityProcess: { ...electron.utilityProcess, fork(path, args, options) {
            token = options.env.SHOT_MANAGER_TOKEN;
            backend = fork(path, args, options);
            const post = backend.postMessage.bind(backend);
            backend.postMessage = message => {
                if (message === 'shutdown') {
                    assert.ok(window.isDestroyed(), 'Renderer stops before backend shutdown');
                    assert.equal(activeReads, 0, 'Accepted vocabulary reads finish before backend shutdown');
                    shutdownRequested = true;
                    // Simulate an IPC call arriving after the renderer started closing.
                    void Promise.resolve(vocabularyHandler(...vocabularyArgs)).catch(error => { console.error(error); app.exit(1); });
                }
                return post(message);
            };
            backend.on('message', message => { if (message?.type === 'ready') backendURL = message.url; });
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
            assert.ok(requested && observedQuit && shutdownRequested);
            assert.equal(lateFetches,0,'No renderer fetch reaches a closing backend');
            assert.equal(failedFetches,0,'Normal quit causes no refused backend requests');
            const saved = JSON.parse(fs.readFileSync(join(profile, 'organization.json'), 'utf8'));
            assert.equal(Object.values(saved.drafts)[0].data.notes, 'last accepted edit');
            assert.equal(noteRequests, 2, 'Each typing burst writes once, including a pending burst flushed by Command+Q');
            clearTimeout(timer);
            console.log('PASS: Command+Q stops renderer polling, drains accepted reads and pending saves, rejects late work, and quits real Electron/backend cleanly.');
        } catch (error) { console.error(error); app.exit(1); }
    });
    require('../out/main/index.cjs');
    app.whenReady().then(async () => {
        try {
            const wait = async condition => { for (let i = 0; i < 150; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Quit fixture did not settle'); };
            await wait(() => backendURL && window && !window.webContents.isLoading());
            assert.equal(Menu.getApplicationMenu().getMenuItemById('quit-shot-manager').accelerator, 'CommandOrControl+Q');
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
            assert.equal(noteRequests, 0, 'Notes do not save on every accepted keystroke');
            await window.webContents.executeJavaScript('window.desktop.flushNotes()');
            assert.equal(noteRequests, 1, 'Leaving the field flushes one coalesced save');
            await window.webContents.executeJavaScript(`window.desktop.updateOrganization([${JSON.stringify(shot.id)}],{field:'notes',operation:'set',value:'last'}).catch(()=>{});window.desktop.updateOrganization([${JSON.stringify(shot.id)}],{field:'notes',operation:'set',value:'last accepted edit'}).catch(()=>{});void 0`);
            await wait(() => accepted === 4);
            await window.webContents.executeJavaScript(`setInterval(()=>window.desktop.getTagVocabulary().catch(()=>{}),10);void 0`);
            await wait(()=>activeReads>0);
            window.webContents.focus();
            requested = true;
            window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Q', modifiers: ['meta'] });
            if (!window.isDestroyed()) window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Q', modifiers: ['meta'] });
        } catch (error) { console.error(error); backend?.kill(); app.exit(1); }
    });
}
