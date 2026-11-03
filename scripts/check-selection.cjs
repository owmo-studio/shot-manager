// Synthetic renderer integration check. No source cards, media, or NAS access.
if (!process.versions.electron) {
    const { spawnSync } = require('node:child_process');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit' });
    if (result.error) console.error(result.error);
    process.exit(result.status ?? 1);
} else {
    const { app, BrowserWindow, ipcMain, protocol } = require('electron');
    const assert = require('node:assert/strict');
    const { mkdtemp, writeFile, rm } = require('node:fs/promises');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    protocol.registerSchemesAsPrivileged([{ scheme: 'shot-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);
    let root, window;
    app.on('window-all-closed', () => {});
    const timer = setTimeout(() => { console.error('Selection check timed out'); app.exit(1); }, 30000);
    app.whenReady().then(async () => {
        try {
            root = await mkdtemp(join(tmpdir(), 'shot-selection-check-'));
            let sources = ['A', 'B'].map((id) => ({ id, name: `Source ${id}`, path: `/synthetic/${id}`, type: 'folder', cameraModels: [], available: true }));
            const metadata = {
                device: { model: 'ILME-FX30', manufacturer: 'Sony', software: null, evidence: null },
                codec: { name: 'h264', profile: null, bitDepth: 8, chroma: '4:2:0' },
                color: { label: 'Rec.709', primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv', evidence: null, confidence: 'declared', conflicts: [] },
                resolution: { width: 256, height: 144, displayWidth: 256, displayHeight: 144, rotation: 0 },
                frameRate: { nominal: 30, average: 30, rational: '30/1', mode: 'constant', evidence: null },
            };
            let collection = { revision: 1, scans: sources.map((source) => ({ sourceId: source.id, state: 'complete', clipCount: 3, warnings: [] })), shots: Array.from({ length: 6 }, (_, i) => ({
                id: String(i + 1).padStart(64, '0'), sourceId: i < 3 ? 'A' : 'B', filename: `Clip ${i + 1}.mp4`, relativePath: `${i + 1}.mp4`,
                timestamp: `2026-11-0${i < 3 ? 1 : 2}T12:00:0${i}Z`, dateSource: 'embedded', dateEvidence: '', dateConfidence: 'declared',
                metadata, cameraModel: 'ILME-FX30', bytes: 100, durationSeconds: 3, hasThumbnail: false, warnings: [], available: true, editable: true,
            })) };
            ipcMain.handle('fixture:sources', () => sources);
            ipcMain.handle('fixture:shots', () => collection);
            ipcMain.handle('fixture:remove', (_, id) => { sources = sources.filter((source) => source.id !== id); collection = { ...collection, revision: collection.revision + 1, shots: collection.shots.filter((shot) => shot.sourceId !== id) }; });
            await writeFile(join(root, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('desktop',{
                getBackendStatus:async()=>({state:'connected',health:{status:'ok'}}),getSources:()=>ipcRenderer.invoke('fixture:sources'),getShots:()=>ipcRenderer.invoke('fixture:shots'),
                onShotsChanged:listener=>{const fn=(_,value)=>listener(value);ipcRenderer.on('shots:changed',fn);return()=>ipcRenderer.removeListener('shots:changed',fn)},
                getShotThumbnail:async()=>null,getShotDetails:async()=>({file:{filename:'fixture',path:'/synthetic/fixture',bytes:100},embeddedMetadata:[],errors:[]}),
                removeSource:id=>ipcRenderer.invoke('fixture:remove',id)
            });`);
            protocol.handle('shot-media', () => new Response(null, { status: 404 }));
            window = new BrowserWindow({ show: false, width: 1800, height: 1080, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(root, 'preload.cjs') } });
            await window.loadFile(join(__dirname, '../out/renderer/index.html'));
            const js = async (code) => {
                try { return await window.webContents.executeJavaScript(code); }
                catch (error) { console.error('Failed renderer check:', code); throw error; }
            };
            const wait = async (code) => {
                for (let i = 0; i < 250; i++) { if (await js(code)) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
                throw new Error(`UI did not settle: ${code}`);
            };
            const click = async (label, modifiers = {}) => {
                await js(`document.querySelector('button[aria-label=${JSON.stringify(label)}],input[aria-label=${JSON.stringify(label)}]').dispatchEvent(new MouseEvent('click',{bubbles:true,...${JSON.stringify(modifiers)}}))`);
                await new Promise((resolve) => setTimeout(resolve, 15));
            };
            const inspect = (n, modifiers) => click(`Inspect Clip ${n}.mp4`, modifiers);
            const arrow = async (key) => {
                window.webContents.sendInputEvent({type:'keyDown',keyCode:key});
                window.webContents.sendInputEvent({type:'keyUp',keyCode:key});
                await new Promise((resolve) => setTimeout(resolve, 30));
            };
            const selected = () => js(`Array.from(document.querySelectorAll('button[aria-label^="Inspect "][aria-pressed="true"]')).map(b=>Number(b.getAttribute('aria-label').match(/Clip (\u005cd+)/)[1])).sort((a,b)=>a-b)`);
            const skipped = () => js(`Array.from(document.querySelectorAll('button[aria-label^="Inspect "][data-skipped="true"]')).map(b=>Number(b.getAttribute('aria-label').match(/Clip (\u005cd+)/)[1])).sort((a,b)=>a-b)`);
            async function check(n) {
                const previous = await selected();
                if (previous.length !== 1 || previous[0] !== n) await inspect(n);
                await click('Skip selected clips');
                await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
                for (let i = 0; i < previous.length; i++) await inspect(previous[i], i ? {metaKey:true} : {});
            }
            const push = async (shots) => { collection = { ...collection, revision: collection.revision + 1, shots }; window.webContents.send('shots:changed', collection); await new Promise((resolve) => setTimeout(resolve, 30)); };
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "]').length===6`);
            assert.ok(await js(`document.querySelector('footer').textContent.includes('6 clips to ingest · 0 skipped')`));
            assert.equal(await js(`document.querySelectorAll('[data-shot-card] button').length`), 6);
            assert.equal(await js(`document.querySelectorAll('button[aria-label^="Skip Clip "]').length`), 0);
            window.webContents.focus();
            await js(`document.querySelector('button[aria-label="Inspect Clip 1.mp4"]').focus()`);
            for (const modifiers of [[], ['shift']]) {
                window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers});
                window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers});
                await new Promise((resolve) => setTimeout(resolve, 15));
                assert.equal(await js(`document.activeElement.getAttribute('aria-label')`), 'Inspect Clip 1.mp4');
            }
            assert.equal(await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))`), false);
            await js(`document.activeElement.blur()`);
            await inspect(1); assert.deepEqual(await selected(), [1]);
            await inspect(1); assert.deepEqual(await selected(), []);
            await inspect(1);
            await arrow('Left'); assert.deepEqual(await selected(), [2]);
            await arrow('Right'); assert.deepEqual(await selected(), [1]);
            await arrow('Right'); assert.deepEqual(await selected(), [1]);
            await inspect(6); await arrow('Left'); assert.deepEqual(await selected(), [6]);
            await inspect(1);
            await js(`document.querySelector('button[aria-label="Inspect Clip 1.mp4"]').focus()`);
            window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
            window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "][aria-pressed="true"]').length===0`);
            assert.equal(await js(`document.activeElement?.getAttribute('aria-label')==='Inspect Clip 1.mp4'`), false);
            await inspect(1);
            assert.equal(await js(`!!document.querySelector('#clip-inspector header input[aria-label="Skip selected clips"]')`), true);
            assert.equal(await js(`document.querySelector('#clip-inspector header input[aria-label="Skip selected clips"]').closest('label').textContent.trim()`), 'Skip');
            assert.equal(await js(`document.querySelector('#clip-inspector header input[aria-label="Skip selected clips"]').closest('label').offsetHeight`), 28);
            await inspect(2, { metaKey: true }); assert.deepEqual(await selected(), [1, 2]);
            assert.equal(await js(`document.querySelector('#clip-inspector h2').textContent`), '2 Selected Clips');
            assert.equal(await js(`document.querySelector('#clip-inspector video')`), null);
            assert.deepEqual(await js(`Array.from(document.querySelectorAll('ul[aria-label="Selected clips"] li')).map(item=>item.textContent)`), ['Clip 2.mp4', 'Clip 1.mp4']);
            assert.equal(await js(`document.querySelector('ul[aria-label="Selected clips"] li').title`), '/synthetic/A/2.mp4');
            assert.equal(await js(`Array.from(document.querySelectorAll('#clip-inspector button')).some(b=>b.textContent==='Clear selection')`), false);
            await inspect(1, { ctrlKey: true }); assert.deepEqual(await selected(), [2]);
            await inspect(3, { metaKey: true });
            await arrow('Left'); assert.deepEqual(await selected(), [4]);
            await inspect(2); await inspect(3, {metaKey:true}); await check(1); await check(2);
            assert.deepEqual(await selected(), [2, 3]); assert.deepEqual(await skipped(), [1, 2]);
            await wait(`getComputedStyle(document.querySelector('button[aria-label="Inspect Clip 1.mp4"] [data-shot-thumbnail]')).opacity==='0.45'`);
            assert.equal(await js(`getComputedStyle(document.querySelector('button[aria-label="Inspect Clip 1.mp4"]')).opacity`), '1');
            assert.equal(await js(`document.querySelector('button[aria-label="Inspect Clip 1.mp4"]').disabled`), false);
            assert.equal(await js(`document.querySelectorAll('button[aria-label^="Skip Clip "]').length`), 0);
            assert.ok(await js(`document.querySelector('footer').textContent.includes('4 clips to ingest · 2 skipped')`));

            assert.equal(await js(`document.querySelector('input[aria-label="Skip selected clips"]').indeterminate`), true);
            if (process.env.SHOT_MANAGER_SELECTION_SCREENSHOT) {
                await new Promise((resolve) => setTimeout(resolve, 350));
                await writeFile(process.env.SHOT_MANAGER_SELECTION_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
            }
            await click('Skip selected clips'); assert.deepEqual(await skipped(), [1]);
            await js(`document.querySelector('input[aria-label="Skip selected clips"]').focus()`);
            await arrow('Left'); assert.deepEqual(await selected(), [2, 3]);
            await js(`document.activeElement.blur()`);
            await click('Skip selected clips'); assert.deepEqual(await skipped(), [1, 2, 3]);
            await click('Skip selected clips'); assert.deepEqual(await skipped(), [1]);
            await js(`document.querySelector('main > section').click()`);
            assert.deepEqual(await selected(), []); assert.deepEqual(await skipped(), [1]);
            await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "][aria-pressed="true"]').length===0`); assert.deepEqual(await skipped(), [1]);
            await inspect(2); await arrow('Right'); assert.deepEqual(await selected(), [1]); assert.deepEqual(await skipped(), [1]);
            await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
            await inspect(2); await inspect(5, { shiftKey: true }); assert.deepEqual(await selected(), [2, 3, 4, 5]);
            await inspect(6, { shiftKey: true, metaKey: true }); assert.deepEqual(await selected(), [2, 3, 4, 5, 6]);
            await inspect(6); assert.deepEqual(await selected(), [6]);
            await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "][aria-pressed="true"]').length===0`); assert.deepEqual(await skipped(), [1]);
            await inspect(1); await click('Filter clips from Source B');
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "]').length===3`); assert.deepEqual(await selected(), []);
            assert.ok(await js(`document.querySelector('footer').textContent.includes('1 skipped')`));
            await inspect(5); await arrow('Right'); assert.deepEqual(await selected(), [4]);
            await arrow('Right'); assert.deepEqual(await selected(), [4]);
            await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
            await click('Filter clips from Source B'); await wait(`document.querySelectorAll('button[aria-label^="Inspect "]').length===6`); assert.deepEqual(await skipped(), [1]);
            await push(collection.shots.map((shot) => shot.filename==='Clip 2.mp4' ? {...shot,editable:false} : shot));
            await inspect(3); await arrow('Right'); assert.deepEqual(await selected(), [1]);
            await push(collection.shots.map((shot) => ({...shot,editable:true})));
            await click('Reverse order'); await inspect(5);
            await arrow('Left'); assert.deepEqual(await selected(), [4]);
            await arrow('Right'); assert.deepEqual(await selected(), [5]);
            await inspect(2, { shiftKey: true }); assert.deepEqual(await selected(), [2, 3, 4, 5]);
            await inspect(1); await push(collection.shots.map((shot) => shot.filename === 'Clip 1.mp4' ? { ...shot, available: false, editable: false } : shot));
            assert.equal(await js(`document.querySelector('button[aria-label="Inspect Clip 1.mp4"]').disabled`), true);
            assert.equal(await js(`document.querySelector('input[aria-label="Skip selected clips"]').disabled`), true); assert.deepEqual(await skipped(), [1]);
            await push(collection.shots.map((shot) => ({ ...shot, available: true, editable: true })));
            await push(collection.shots.map((shot) => shot.filename === 'Clip 1.mp4' ? { ...shot, editable: false } : shot));
            assert.equal(await js(`document.querySelector('button[aria-label="Inspect Clip 1.mp4"]').disabled`), true);
            await push(collection.shots.map((shot) => ({ ...shot, editable: true }))); assert.deepEqual(await skipped(), [1]);
            await push(collection.shots.filter((shot) => shot.filename !== 'Clip 1.mp4'));
            await wait(`document.querySelector('footer').textContent.includes('0 skipped')`); assert.deepEqual(await selected(), []);
            await inspect(2); await check(2); await click('Remove Source A from sources');
            await wait(`!!document.querySelector('[role="alertdialog"]')`);
            await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
            assert.deepEqual(await selected(), [2]);
            await js(`Array.from(document.querySelectorAll('[role="alertdialog"] button')).find(b=>b.textContent==='Proceed').click()`);
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "]').length===3`);
            await wait(`document.querySelector('footer').textContent.includes('0 skipped')`); assert.deepEqual(await selected(), []);
            assert.equal(await js(`Array.from(document.querySelectorAll('footer button')).find(b=>b.textContent==='Review & Ingest').disabled`), true);
            console.log('PASS: Left/Right navigation across dates and reversed/filtered order, boundaries, locked-clip skipping, multi-selection navigation, control-focus guards, editing/skip selections, modifiers/ranges, bulk skip, background deselection, blocked Tab, Escape, removals, and disabled processing.');
            window.destroy(); await rm(root, { recursive: true, force: true }); clearTimeout(timer); app.exit(0);
        } catch (error) {
            console.error(error); window?.destroy(); if (root) await rm(root, { recursive: true, force: true }); clearTimeout(timer); app.exit(1);
        }
    });
}
