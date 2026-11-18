// Real Electron/preload/backend integration with an isolated profile and dummy Library.
const fs = require("node:fs");
const { join } = require("node:path");
if (!process.versions.electron) {
    const { spawnSync } = require("node:child_process");
    const root = fs.realpathSync(fs.mkdtempSync(join(require("node:os").tmpdir(), "owmo-ingest-ui-")));
    try {
        fs.mkdirSync(join(root, "profile"));
        fs.mkdirSync(join(root, "profile", "Cache", "Cache_Data"), { recursive: true });
        fs.mkdirSync(join(root, "profile", "Cache", "No_Vary_Search"));
        fs.mkdirSync(join(root, "profile", "Cache", "proxies"));
        fs.writeFileSync(join(root, "profile", "Cache", "proxies", `${"f".repeat(64)}.proxy.mov`), "existing managed Cache");
        fs.writeFileSync(join(root, "profile", "Cache", "Cache_Data", "chromium-marker"), "Electron cache");
        fs.mkdirSync(join(root, "library"));
        fs.mkdirSync(join(root, "source"));
        fs.mkdirSync(join(root, "destination"));
        fs.writeFileSync(
            join(root, "profile", "configuration.json"),
            JSON.stringify({ version: 1, libraryPath: null }),
        );
        for (const color of ["blue", "red"]) {
            const video = spawnSync("ffmpeg", [
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                `color=c=${color}:s=160x90:r=10`,
                "-t",
                "0.3",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                join(root, "source", `${color}.mp4`),
            ]);
            if (video.status !== 0) throw new Error("Could not generate synthetic video");
        }
        const env = { ...process.env, OWMO_INGEST_UI_ROOT: root };
        delete env.ELECTRON_RUN_AS_NODE;
        const result = spawnSync(require("electron"), [__filename], { env, stdio: "inherit", timeout: 90000 });
        if (result.error) console.error(result.error);
        if (result.status !== 0 || !fs.existsSync(join(root, "validated"))) process.exitCode = 1;
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
} else {
    const assert = require("node:assert/strict");
    const electron = require("electron");
    const { app } = electron;
    const root = process.env.OWMO_INGEST_UI_ROOT;
    if (!root) throw new Error("Missing isolated profile");
    app.setPath("userData", join(root, "profile"));
    let window,
        backend,
        statusOverride,
        shotsOverride,
        ingestReads = 0,
        catalogueRefreshes = 0,
        rendererLoads = 0,
        browsedPath;
    const originalFetch = global.fetch;
    let holdLibraryThumbnail = false, libraryThumbnailHeld = false, releaseLibraryThumbnail;
    let holdCatalogueRefresh = false, releaseCatalogueRefresh;
    global.fetch = async (url, options) => {
        if (String(url).endsWith("/api/ingestion") && (!options?.method || options.method === "GET")) ingestReads++;
        if (String(url).endsWith('/api/library/refresh') && options?.method === 'POST') {
            catalogueRefreshes++;
            if (holdCatalogueRefresh) {
                holdCatalogueRefresh = false;
                await new Promise(resolve => { releaseCatalogueRefresh = resolve; });
            }
        }
        const result = await originalFetch(url, options);
        if (holdLibraryThumbnail && /\/api\/library\/[a-f0-9]{64}\/thumbnail$/.test(String(url))) {
            holdLibraryThumbnail = false; libraryThumbnailHeld = true;
            await new Promise(resolve => { releaseLibraryThumbnail = resolve; });
        }
        if (shotsOverride && String(url).endsWith("/api/shots"))
            return new Response(JSON.stringify(shotsOverride), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        if (
            statusOverride &&
            ["/api/work/stop", "/api/work/refresh"].some((path) => String(url).endsWith(path))
        ) {
            const all = String(url).endsWith("/api/work/stop"),
                refresh = String(url).endsWith("/api/work/refresh");
            statusOverride = {
                ...statusOverride,
                revision: statusOverride.revision + 1,
                active: false,
                current: undefined,
                exportCurrent: undefined,
                tasks: { completed: 0, total: 0, percent: 0, proxiesRemaining: 0, transfersRemaining: 0 },
                work: {
                    paused: all,
                    busy: !all && !refresh,
                    encoding: !all && !refresh,
                    queued: 0,
                    scratchPath: join(root, "scratch"),
                },
            };
            backend.emit("message", { type: "ingestion:changed", status: statusOverride });
        }
        return result;
    };
    const originalLoad = require("node:module")._load;
    const fork = electron.utilityProcess.fork.bind(electron.utilityProcess);
    const wrapped = {
        ...electron,
        BrowserWindow: class extends electron.BrowserWindow {
            constructor(options) {
                super({
                    ...options,
                    show: false,
                    webPreferences: { ...options.webPreferences, backgroundThrottling: false },
                });
                window = this;
                this.webContents.on("did-finish-load", () => { rendererLoads++; });
            }
        },
        utilityProcess: {
            ...electron.utilityProcess,
            fork(...args) {
                backend = fork(...args);
                return backend;
            },
        },
        shell: {
            ...electron.shell,
            openPath: async (path) => {
                browsedPath = path;
                return "";
            },
        },
    };
    require("node:module")._load = function (request, parent, isMain) {
        return request === "electron" ? wrapped : originalLoad.call(this, request, parent, isMain);
    };
    const timer = setTimeout(() => {
        console.error("Ingest UI fixture timed out");
        backend?.kill();
        app.exit(1);
    }, 55000);
    require("../out/main/index.cjs");
    app.whenReady().then(async () => {
        const js = async (code) => {
            try { return await window.webContents.executeJavaScript(code); }
            catch (error) { console.error('Renderer check failed:', code); throw error; }
        };
        const until = async (condition, message) => {
            for (let i = 0; i < 500; i++) {
                if (await condition()) return;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error(message);
        };
        const click = (text) =>
            js(
                `Array.from((document.querySelector('dialog[open]') ?? document).querySelectorAll('button')).find(button => (button.textContent.trim() === ${JSON.stringify(text)} || button.getAttribute('aria-label') === ${JSON.stringify(text)})).click()`,
            );
        const fillAttribute = (label,value) => js(`(()=>{const el=document.querySelector('[aria-label="${label}"]');const select=el.tagName==='SELECT';Object.getOwnPropertyDescriptor(select?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(select?'change':'input',{bubbles:true}));})()`);
        try {
            await until(() => window && !window.webContents.isLoading(), "Renderer not loaded");
            await until(
                () => js(`window.desktop.getBackendStatus().then(status=>status.state==='connected')`),
                "Backend not connected",
            );
            await until(
                () =>
                    js(
                        `document.querySelector('[aria-label="Application status"]')?.textContent==='Library Not Configured' && !!document.querySelector('[data-application-level="error"]')`,
                    ),
                "Missing configuration did not show red app status",
            );
            assert.equal(
                await js(
                    `Array.from(document.querySelectorAll('button[aria-label="Add clips"]')).length===1 && Array.from(document.querySelectorAll('button[aria-label="Add clips"]')).every(button=>button.disabled)`,
                ),
                true,
                "Critical status disables the empty-workspace Add button",
            );
            assert.equal(
                await js(
                    `document.querySelector('section[aria-label="Shot cards"] h2')?.textContent==='Library Not Configured'`,
                ),
                true,
                "Empty workspace reflects the critical status",
            );
            await assert.rejects(
                js(`window.desktop.chooseClips()`),
                /Library Not Configured/,
                "Source IPC rejects a critical status",
            );
            // Exercise the real source IPC without exposing renderer paths: chooseClips uses the native picker.
            wrapped.dialog = {
                ...electron.dialog,
                showOpenDialog: async (_owner, options) => ({
                    canceled: false,
                    filePaths: [join(root, options.title === "Set Library Location" ? "library" : options.title === 'Choose Export Destination' ? 'destination' : "source")],
                }),
            };
            const openConfiguration = () => js(`document.querySelector('[aria-label="Configuration"]').click()`);
            const chooseLibrary = async () => {
                await click("Set Library Location");
                await until(
                    () =>
                        js(
                            `document.querySelector('[aria-label="Configured Library location"]').textContent===${JSON.stringify(join(root, "library"))}`,
                        ),
                    "Library choice not staged",
                );
                assert.equal(
                    await js(`document.querySelector('[aria-label="Save configuration"]').disabled`),
                    false,
                    "Library choice enables Save",
                );
                assert.equal(
                    (await js("window.desktop.getConfiguration()")).libraryPath,
                    null,
                    "Library is unchanged until Save",
                );
                assert.equal(
                    await js(`document.querySelector('[aria-label="Library location"]').textContent`),
                    "Library Not Configured",
                    "Header shows committed location",
                );
            };
            await openConfiguration();
            await until(() => js(`document.querySelector('[aria-label="Cache summary"]')?.textContent.includes(' used') && document.querySelector('[aria-label="Cache summary"]')?.textContent.includes('Proxies:')`), 'Cache Summary did not load');
            assert.ok(await js(`document.querySelector('#cache-summary-title + p + p')?.textContent.includes('90 days')`), 'Cache retention note missing');
            if(process.env.SHOT_MANAGER_UX_SCREENSHOTS) { await new Promise(resolve=>setTimeout(resolve,150)); await fs.promises.writeFile('/tmp/owmo-ux-configuration.png',(await window.webContents.capturePage()).toPNG()); }
            assert.equal(
                await js(`!!document.querySelector('button[aria-label="Configured Cache location"]')`),
                false,
                "Cache chooser is absent",
            );
            assert.equal(
                await js(
                    `(() => { const clear=Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent==='Clear Cache').getBoundingClientRect(); const browse=Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent==='Browse Cache').getBoundingClientRect(); return browse.left>clear.right && browse.left-clear.right<24; })()`,
                ),
                true,
                "Browse Cache sits beside Clear Cache",
            );
            await click("Browse Cache");
            await until(
                () => browsedPath === join(root, "profile", "Shot Manager Cache"),
                "Browse Cache did not open managed folder",
            );
            assert.equal(
                fs.existsSync(join(root, "profile", "Shot Manager Cache")),
                true,
                "The dedicated Cache folder was created",
            );
            assert.equal(fs.readFileSync(join(root, "profile", "Cache", "proxies", `${"f".repeat(64)}.proxy.mov`), "utf8"), "existing managed Cache");
            assert.equal(fs.readFileSync(join(root, "profile", "Cache", "Cache_Data", "chromium-marker"), "utf8"), "Electron cache");
            await chooseLibrary();
            await click("Cancel");
            await openConfiguration();
            await until(
                () => js(`!!document.querySelector('[aria-label="Save configuration"]')`),
                "Configuration did not reopen",
            );
            assert.equal(
                await js(`document.querySelector('[aria-label="Save configuration"]').disabled`),
                true,
                "Cancel discards pending locations",
            );
            await chooseLibrary();
            await js(
                `document.querySelector('dialog[open]').dispatchEvent(new Event('cancel',{bubbles:true,cancelable:true}))`,
            );
            await openConfiguration();
            await chooseLibrary();
            await click("Save");
            await until(() => js(`!document.querySelector('dialog[open]')`), "Location Save did not complete");
            const configured = await js("window.desktop.getConfiguration()");
            assert.equal(configured.libraryPath, join(root, "library"));
            assert.ok(configured.libraryMount, "Save records the Library mounted volume");
            await until(
                () =>
                    js(
                        `document.querySelector('[aria-label="Application status"]')?.textContent==='Ready' && !!document.querySelector('[data-application-level="ready"]')`,
                    ),
                "Saving valid locations did not show green Ready",
            );
            // Native-backed File -> renderer drop -> preload -> main -> backend.
            await js(`(() => { const input=document.createElement('input'); input.type='file'; input.id='fixture-file-drop'; input.hidden=true; document.body.append(input); })()`);
            window.webContents.debugger.attach('1.3');
            try {
                const {root:documentRoot}=await window.webContents.debugger.sendCommand('DOM.getDocument');
                const {nodeId}=await window.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:documentRoot.nodeId,selector:'#fixture-file-drop'});
                await window.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[join(root,'source','blue.mp4')]});
            } finally { window.webContents.debugger.detach(); }
            await js(`(() => { const input=document.getElementById('fixture-file-drop'); const data=new DataTransfer(); data.items.add(input.files[0]); document.querySelector('main > section').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data})); input.remove(); })()`);
            await until(()=>js(`document.querySelectorAll('[data-shot-card]').length===1&&window.desktop.getShots().then(value=>value.scans.every(scan=>scan.state==='complete'))`),'Dropped video file was not added individually');
            assert.equal((await js('window.desktop.getShots()')).shots[0].filename,'blue.mp4','File drop excludes sibling red.mp4');
            await js(`Array.from(document.querySelectorAll('nav button')).find(button=>button.textContent==='Library').click()`);
            await until(()=>js(`document.querySelector('nav button[aria-current="page"]')?.textContent==='Library'`),'Library tab did not open');
            await js(`(() => { const input=document.createElement('input'); input.type='file'; input.id='fixture-library-file-drop'; input.hidden=true; document.body.append(input); })()`);
            window.webContents.debugger.attach('1.3');
            try {
                const {root:documentRoot}=await window.webContents.debugger.sendCommand('DOM.getDocument');
                const {nodeId}=await window.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:documentRoot.nodeId,selector:'#fixture-library-file-drop'});
                await window.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[join(root,'source','red.mp4')]});
            } finally { window.webContents.debugger.detach(); }
            await js(`(() => { const input=document.getElementById('fixture-library-file-drop'); const data=new DataTransfer(); data.items.add(input.files[0]); document.querySelector('main > section').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data})); input.remove(); })()`);
            await until(()=>js(`document.querySelector('nav button[aria-current="page"]')?.textContent==='Import' && document.querySelectorAll('[data-shot-card]').length===2 && window.desktop.getShots().then(value=>value.scans.every(scan=>scan.state==='complete'))`),'Library drop did not switch to Import and add the file');
            await js("window.desktop.chooseClips()");
            await until(
                () =>
                    js(
                        `document.querySelectorAll('[data-shot-card]').length===2 && Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Commit'&&!button.disabled)`,
                    ),
                "Clips did not become eligible",
            );
            assert.equal(await js(`!!document.querySelector('ul[aria-label="Import sources"]') || Array.from(document.querySelectorAll('aside h2')).some(item=>['Sources','Devices'].includes(item.textContent))`), false, 'Source list and Devices heading are removed');
            const cardIds = await js(`Array.from(document.querySelectorAll('button[aria-label^="Inspect "]')).map(button=>button.id)`);
            const selectCard = (index, additive = false) => js(`document.getElementById(${JSON.stringify(cardIds[index])}).dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:${additive}}))`);
            const commitDisabled = () => js(`Array.from(document.querySelectorAll('footer button')).find(button=>button.textContent==='Commit').disabled`);
            await selectCard(0);
            assert.deepEqual(await js(`Array.from(document.querySelectorAll('[data-clip-grouping] .attribute-label')).map(el=>el.textContent)`),['Group','Camera','Quality']);
            assert.equal(await js(`(()=>{const g=document.querySelector('[aria-label="Group"]').getBoundingClientRect(),c=document.querySelector('[aria-label="Camera"]').getBoundingClientRect(),r=document.querySelector('[aria-label="Quality"]').getBoundingClientRect();return Math.abs(g.width-2*c.width)<3&&Math.abs(c.width-r.width)<2&&g.top===c.top&&c.top===r.top;})()`),true,'Grouping fields share the requested 50/25/25 row');
            assert.equal(await js(`document.querySelector('[aria-label="Notes"]').rows`),2,'Notes leaves room for grouping');
            await fillAttribute('Group','TH01-T02');await fillAttribute('Camera','A');await fillAttribute('Quality','preferred');
            await js('window.desktop.flushOrganizationText()');
            await until(()=>js(`window.desktop.getShots().then(c=>c.shots.find(s=>s.id===${JSON.stringify(cardIds[0].replace('shot-',''))}).organization.rating==='preferred')`),'Import grouping saves');
            await fillAttribute('Quality','low');
            await until(()=>js(`window.desktop.getShots().then(c=>c.shots.find(s=>s.id===${JSON.stringify(cardIds[0].replace('shot-',''))}).organization.rating==='low')`),'Low Quality saves through Electron IPC and backend');
            const importGrouping=await js(`window.desktop.getShots().then(c=>c.shots.find(s=>s.id===${JSON.stringify(cardIds[0].replace('shot-',''))}).organization)`);
            assert.equal(importGrouping.group,'TH01-T02');assert.equal(importGrouping.camera,'A');
            await js(`window.desktop.updateOrganization([${JSON.stringify(cardIds[0].replace('shot-',''))}],{field:'all',operation:'clear',value:''})`);
            await until(()=>js(`document.querySelector('[aria-label="Group"]').value===''&&document.querySelector('[aria-label="Camera"]').value===''&&document.querySelector('[aria-label="Quality"]').value===''`),'Clear resets grouping controls');
            assert.equal(await js(`Array.from(document.querySelectorAll('#clip-inspector header button, #clip-inspector header input')).map(el=>el.getAttribute('aria-label')).join(',')`),'Set current frame as thumbnail,Skip selected clips,Eject selected clip','Import icon button order');
            await until(() => js(`document.querySelector('footer').textContent.includes('1 clip selected')`), 'Footer identifies selected Commit scope');
            await click('Commit');
            await until(() => js(`document.querySelectorAll('dialog [data-review-included]').length===1`), 'Only selected clip enters review');
            await click('Cancel');
            await js(`document.querySelector('input[aria-label="Skip selected clips"]').click()`);
            await until(commitDisabled, 'Skipped-only selection disables Commit without falling back');
            await selectCard(1, true);
            await until(() => js(`document.querySelector('footer').textContent.includes('2 clips selected (1 skipped)')`), 'Mixed selection excludes skipped clip');
            await click('Commit');
            await until(() => js(`document.querySelectorAll('dialog [data-review-included]').length===1`), 'Skipped selected clip excluded from review');
            await click('Cancel');
            await js(`document.querySelector('input[aria-label="Skip selected clips"]').click()`);
            await until(() => js(`document.querySelector('[aria-label="Clip selection summary"]').textContent.trim()==='2 clips selected'`), 'Unskipping restores selected eligibility');
            await click('Commit');
            await until(() => js(`document.querySelectorAll('dialog [data-review-included]').length===2`), 'Bulk selection reviews eligible selected clips');
            await click('Cancel');
            await selectCard(0); await selectCard(0);
            await until(() => js(`document.querySelector('footer').textContent.includes('2 clips total')`), 'No selection restores all-workspace Commit scope');
            await fillAttribute('Search clips','blue.mp4');
            await until(()=>js(`document.querySelectorAll('[data-shot-card]').length===1 && document.querySelector('[aria-label="Clip selection summary"]').textContent.trim()==='1 clip total'`),'Search scopes Commit to visible clips');
            await click('Commit');
            await until(()=>js(`document.querySelectorAll('dialog [data-review-included]').length===1`),'Commit review excludes hidden clips without a selection');
            await click('Cancel');await fillAttribute('Search clips','');
            await until(()=>js(`document.querySelectorAll('[data-shot-card]').length===2`),'Clear Filters restores Commit scope');
            const idleReads = ingestReads;
            await new Promise((resolve) => setTimeout(resolve, 1200));
            assert.equal(ingestReads, idleReads, "Idle footer does not poll ingestion status");
            await click("Commit");
            await until(
                () => js(`document.querySelector('dialog[open]')?.textContent.includes('Ready to Commit?')`),
                "Review did not open",
            );
            assert.equal(await js(`Array.from(document.querySelectorAll('dialog span')).some(tag=>tag.textContent.trim()==='Proxy')`), false, "Commit review shows no Proxy tag");
            assert.equal(await js(`(() => { const tags=Array.from(document.querySelectorAll('dialog span')).filter(tag=>tag.textContent.trim()==='New'); return tags.length===2 && tags.every(tag=>tag.classList.contains('text-blue-300')); })()`), true, "New tags are blue without a plus");
            assert.equal(await js(`document.querySelectorAll('dialog button[aria-label^="Remove "]').length`), 2);
            assert.equal(await js(`(() => { const style=getComputedStyle(document.querySelector('dialog button[aria-label^="Remove "]')); return style.borderTopWidth==='0px' && style.fontSize==='24px'; })()`), true, "Review removal control is large and borderless");
            await js(`document.querySelector('dialog button[aria-label^="Remove "]').click()`);
            assert.equal(await js(`document.querySelectorAll('dialog [data-review-included]').length`), 2, "Excluded row remains visible");
            assert.equal(await js(`document.querySelectorAll('dialog [data-review-included="false"]').length`), 1, "Excluded row is marked as dimmed");
            assert.equal(await js(`document.querySelector('dialog button[aria-label^="Restore "]').textContent.trim()`), "−", "Excluded row offers a dash to restore it");
            assert.equal(await js(`document.querySelector('dialog p').textContent.includes('1 clip')`), true, "Excluded row leaves the submission count");
            await js(`document.querySelector('dialog button[aria-label^="Restore "]').click()`);
            assert.equal(await js(`document.querySelectorAll('dialog [data-review-included="true"]').length`), 2, "Excluded row can be restored");
            await js(`document.querySelector('dialog button[aria-label^="Remove "]').click()`);
            await fs.promises.writeFile(
                "/tmp/owmo-ingest-review.png",
                (await window.webContents.capturePage()).toPNG(),
            );
            await click("Commit");
            await until(async () => !(await js('window.desktop.getIngestStatus()')).active &&
                (await js('window.desktop.getShots()')).shots.length === 1, 'Successful Commit removes its Import card');
            const publishedId = fs.readdirSync(join(root, 'library')).find(name => name.endsWith('.metadata.json')).split('.')[0];
            const beforeLibraryEdit = Object.fromEntries(['source.mp4', 'thumb.jpg', 'proxy.mov'].map(role => [role, fs.readFileSync(join(root, 'library', `${publishedId}.${role}`))]));
            await js(`document.querySelector('[aria-label^="Filter clips by device:"]').click()`);
            await click('Library');
            await until(() => js(`document.querySelectorAll('[data-shot-card]').length===1 && !document.querySelector('[data-shot-status="synced"]')`), 'Library shows the committed clip with neutral styling');
            assert.equal(await js(`document.querySelector('[aria-label^="Filter clips by device:"]').getAttribute('aria-pressed')`),'false','Library starts with its own filters');
            await js(`document.querySelector('[aria-label^="Filter clips by device:"]').click()`);
            await js(`document.getElementById('shot-${publishedId}').click()`);
            await until(()=>js(`!!document.querySelector('video') && document.querySelector('[aria-label="Notes"]')?.value===''`),'Library inspector and playback');
            assert.equal(await js(`document.querySelector('video').getAttribute('src')`),`shot-media://local/library/${publishedId}/original`);
            await new Promise(resolve=>setTimeout(resolve,150));
            await fs.promises.writeFile('/tmp/owmo-library-view.png',(await window.webContents.capturePage()).toPNG());
            await until(()=>js(`!!document.querySelector('[data-shot-image]')`),'Library thumbnail is visible before refresh');
            await js(`window.libraryImageBeforeRefresh=document.querySelector('[data-shot-image]'); window.libraryGridTop=document.querySelector('[data-shot-card]').getBoundingClientRect().top;`);
            holdLibraryThumbnail = true;
            await js('window.desktop.refreshCatalogue()');
            await until(()=>libraryThumbnailHeld,'Refreshed thumbnail request is held');
            assert.equal(await js(`document.querySelector('[data-shot-image]')===window.libraryImageBeforeRefresh`),true,'Refresh keeps the existing image visible while its replacement loads');
            assert.equal(await js(`document.querySelector('[data-shot-card]').getBoundingClientRect().top===window.libraryGridTop`),true,'Refreshing does not shift the grid');
            releaseLibraryThumbnail();
            await until(()=>js(`!!document.querySelector('[aria-label="Set current frame as thumbnail"]:not(:disabled)') && document.querySelector('video').readyState>=2`),'Library Thumb button becomes ready');
            const committedLibraryThumb=fs.readFileSync(join(root,'library',`${publishedId}.thumb.jpg`));
            const committedLibraryJSON=fs.readFileSync(join(root,'library',`${publishedId}.metadata.json`));
            await click('Set current frame as thumbnail');
            await until(()=>js(`document.getElementById('shot-${publishedId}').getAttribute('data-shot-status')==='changes-pending'`),'Library Thumb makes the card yellow');
            const pendingLibraryThumb=await js(`window.desktop.getLibraryThumbnail('${publishedId}')`);
            assert.notEqual(pendingLibraryThumb,'data:image/jpeg;base64,'+committedLibraryThumb.toString('base64'));
            assert.deepEqual(fs.readFileSync(join(root,'library',`${publishedId}.thumb.jpg`)),committedLibraryThumb,'Thumb stays local until Commit');
            assert.deepEqual(fs.readFileSync(join(root,'library',`${publishedId}.metadata.json`)),committedLibraryJSON);
            await click('Commit');await until(()=>js(`!!document.querySelector('dialog[open] [data-review-mode="replace"]')`),'Thumbnail Update enters Commit review');
            assert.equal(await js(`document.querySelectorAll('dialog details').length`),0,'Commit review omits per-file destinations');
            await click('Cancel');await click('Revert');await js(`document.querySelector('[aria-label="Confirm revert clip attributes"]').click()`);
            await until(()=>js(`!document.querySelector('dialog[open]') && !document.querySelector('[data-shot-status="changes-pending"]')`),'Revert clears the thumbnail draft');
            assert.equal(await js(`window.desktop.getLibraryThumbnail('${publishedId}')`),'data:image/jpeg;base64,'+committedLibraryThumb.toString('base64'));
            await until(()=>js(`!!document.querySelector('[aria-label="Set current frame as thumbnail"]:not(:disabled)')`),'Thumb is ready again after Revert');
            await click('Set current frame as thumbnail');await until(()=>js(`!!document.querySelector('[data-shot-status="changes-pending"]')`),'Second thumbnail edit');
            const acceptedThumbnail=await js(`window.desktop.getLibraryThumbnail('${publishedId}')`);
            await click('Commit');await until(()=>js(`document.querySelector('dialog[open]')?.textContent.includes('Ready to Commit?')`),'Thumbnail Commit confirmation');await click('Commit');
            await until(async()=>!(await js('window.desktop.getIngestStatus()')).active && fs.readFileSync(join(root,'library',`${publishedId}.thumb.jpg`)).equals(Buffer.from(acceptedThumbnail.split(',')[1],'base64')),'Library thumbnail transfer finishes');
            for(const role of ['source.mp4','proxy.mov']) assert.deepEqual(fs.readFileSync(join(root,'library',`${publishedId}.${role}`)),beforeLibraryEdit[role],'Thumbnail Commit preserves source and proxy');
            // Restore the fixture thumbnail for the remaining metadata-only regression checks.
            await js(`(async()=>{await window.desktop.setLibraryThumbnail('${publishedId}',${JSON.stringify('data:image/jpeg;base64,'+committedLibraryThumb.toString('base64'))}); const r=await window.desktop.reviewLibraryCommit(['${publishedId}']); await window.desktop.startLibraryCommit(r.token,['${publishedId}']);})()`);
            await until(async()=>!(await js('window.desktop.getIngestStatus()')).active,'Restore fixture thumbnail');
            assert.equal(await js(`!!document.querySelector('[aria-label="Skip selected clips"]') || !!document.querySelector('[aria-label^="Eject "]')`),false,'Library omits Skip and Eject');
            await js(`window.desktop.updateLibraryOrganization(['${publishedId}'],{field:'notes',operation:'set',value:'Library draft'})`);
            await fillAttribute('Group','Studio/Intro-T02');await fillAttribute('Camera','B');await fillAttribute('Quality','low');await js('window.desktop.flushOrganizationText()');
            await until(()=>js(`window.desktop.getLibrary().then(c=>c.shots.find(s=>s.id==='${publishedId}').organization.rating==='low')`),'Low Quality saves in Library');
            await until(()=>js(`document.querySelector('[data-shot-status="changes-pending"]') && document.querySelector('[aria-label="Notes"]').value==='Library draft'`),'Library edits show yellow');
            await click('Revert');await js(`document.querySelector('[aria-label="Confirm revert clip attributes"]').click()`);
            await until(()=>js(`!document.querySelector('dialog[open]') && !document.querySelector('[data-shot-status="changes-pending"]') && document.querySelector('[aria-label="Notes"]').value===''`),'Library Revert restores committed metadata');
            await until(()=>js(`document.querySelector('[aria-label="Group"]').value===''&&document.querySelector('[aria-label="Camera"]').value===''&&document.querySelector('[aria-label="Quality"]').value===''`),'Library Revert restores blank grouping fields');
            await js(`window.desktop.updateLibraryOrganization(['${publishedId}'],{field:'notes',operation:'set',value:'Library committed edit'})`);
            await until(()=>js(`!!document.querySelector('[data-shot-status="changes-pending"]')`),'Library update ready');
            await fillAttribute('Search clips', 'Library committed edit');
            await js(`window.desktop.updateLibraryOrganization(['${publishedId}'],{field:'notes',operation:'set',value:'Library committed update'})`);
            await until(()=>js(`document.querySelector('[aria-label="Notes"]')?.value==='Library committed update' && !!document.getElementById('shot-${publishedId}')`),'Library draft edit stays visible and selected');
            await click('Commit');await until(()=>js(`document.querySelector('dialog[open]')?.textContent.includes('Ready to Commit?')`),'Library Commit review');
            assert.equal(await js(`document.querySelectorAll('dialog details').length`),0,'Library review omits per-file destinations');
            await click('Commit');
            await until(async()=>!(await js('window.desktop.getIngestStatus()')).active && fs.readFileSync(join(root,'library',`${publishedId}.metadata.json`),'utf8').includes('Library committed update'),'Library metadata Commit');
            await until(()=>js(`!document.getElementById('shot-${publishedId}')`),'Successful Commit rechecks the Library clip against Search');
            await fillAttribute('Search clips', '');
            await until(()=>js(`!!document.getElementById('shot-${publishedId}')`),'Clearing Search brings back the committed clip');
            await js(`document.getElementById('shot-${publishedId}').click()`);
            for(const [role,bytes] of Object.entries(beforeLibraryEdit)) assert.deepEqual(fs.readFileSync(join(root,'library',`${publishedId}.${role}`)),bytes,'Metadata Commit preserves media assets');
            // Restore empty Notes for the remaining Import regression checks.
            await js(`(async()=>{ await window.desktop.updateLibraryOrganization(['${publishedId}'],{field:'notes',operation:'set',value:''}); const r=await window.desktop.reviewLibraryCommit(['${publishedId}']); await window.desktop.startLibraryCommit(r.token,['${publishedId}']); })()`);
            await until(async()=>!(await js('window.desktop.getIngestStatus()')).active,'Library reset Commit');
            await until(()=>js(`!document.querySelector('[data-shot-status="changes-pending"]')`),'Reset Library draft settles');
            assert.equal(await js(`Array.from(document.querySelectorAll('#clip-inspector header button')).map(el=>el.getAttribute('aria-label')).join(',')`),'Set current frame as thumbnail,Export,Delete','Library icon button order');
            assert.equal(await js(`document.querySelector('#clip-inspector button[aria-label="Delete"]').disabled`),false,'Delete is enabled for editable Library clips');
            await click('Export');
            await until(()=>js(`document.querySelectorAll('[data-sync-included]').length===1 && document.querySelector('dialog[open]')?.textContent.includes(${JSON.stringify(join(root,'destination'))})`),'Export reviews selected Library clip and native-picked destination');
            assert.equal(await js(`document.querySelector('dialog[open]').textContent.includes('Direct Copy')`),false,'No redundant Export format note');
            assert.equal(await js(`(()=>{const row=document.querySelector('[data-sync-included]'),tag=row.querySelector('span'),name=row.querySelector('p');return tag.getBoundingClientRect().right<name.getBoundingClientRect().left && Math.abs(tag.getBoundingClientRect().top-name.getBoundingClientRect().top)<3;})()`),true,'New/Update tag sits left of filename');
            await js(`document.querySelector('dialog button[aria-label^="Remove "]').click()`);
            assert.equal(await js(`!!document.querySelector('[data-sync-included="false"]') && Array.from(document.querySelectorAll('dialog button')).find(el=>el.textContent.trim()==='Export').disabled`),true,'Exclusion retains the row and disables empty submission');
            assert.equal(await js(`document.querySelector('dialog button[aria-label^="Restore "]').textContent.trim()`),'−');
            await js(`document.querySelector('dialog button[aria-label^="Restore "]').click()`);
            await click('Cancel');assert.equal(fs.readdirSync(join(root,'destination')).length,0,'Cancel never exports');
            await click('Export');
            await until(()=>js(`!!document.querySelector('dialog [data-sync-included]') && Array.from(document.querySelectorAll('dialog button')).find(el=>el.textContent.trim()==='Export')?.disabled===false`),'Export plan ready');
            await fs.promises.writeFile('/tmp/owmo-sync-review.png',(await window.webContents.capturePage()).toPNG());
            await click('Export');
            await until(async()=>!(await js('window.desktop.getIngestStatus()')).active && fs.existsSync(join(root,'destination','_metadata.csv')),'Resolve Export completes');
            const exportedMetadata=JSON.parse(fs.readFileSync(join(root,'library',`${publishedId}.metadata.json`),'utf8'));
            const exportBase=require('node:path').parse(exportedMetadata.originalFilename).name+'__'+publishedId.slice(0,8);
            assert.deepEqual(fs.readdirSync(join(root,'destination')).sort(),['_metadata.csv','Proxy',`${exportBase}.mp4`].sort());
            for(const [name,role] of [[`${exportBase}.mp4`,'source.mp4'],[`Proxy/${exportBase}.mov`,'proxy.mov']]) assert.deepEqual(fs.readFileSync(join(root,'destination',name)),fs.readFileSync(join(root,'library',`${publishedId}.${role}`)));
            assert.ok(!fs.existsSync(join(root,'destination','Metadata')),'Export does not create a Metadata folder');
            const manifest=fs.readFileSync(join(root,'destination','_metadata.csv'),'utf8');
            assert.ok(manifest.startsWith('File Name,Clip Directory,Clip Name,'));
            assert.ok(manifest.includes(`\r\n${exportBase}.mp4,`),'CSV matches exported media filename');
            await js(`window.desktop.updateLibraryOrganization(['${publishedId}'],{field:'scene',operation:'set',value:'Pending Export test'})`);
            await click('Export');
            await until(()=>js(`document.querySelector('dialog[open]')?.textContent.includes('Commit or Revert changes before Export.')`),'Export explains pending edits');
            assert.equal(await js(`Array.from(document.querySelectorAll('dialog button')).find(el=>el.textContent.trim()==='Export').disabled`),true,'Dirty clip blocks Export until excluded');
            await click('Cancel');await js(`window.desktop.updateLibraryOrganization(['${publishedId}'],{field:'scene',operation:'set',value:''})`);
            // A second temporary catalogue row exercises the actual multi-selection inspector.
            const syncSecondId='f'.repeat(64), syncSecondJSON=JSON.parse(fs.readFileSync(join(root,'library',`${publishedId}.metadata.json`),'utf8'));
            syncSecondJSON.id=syncSecondId; syncSecondJSON.fingerprint.value=syncSecondId; syncSecondJSON.originalFilename='Second Library Fixture.mp4';
            fs.writeFileSync(join(root,'library',`${syncSecondId}.metadata.json`),JSON.stringify(syncSecondJSON));
            for(const role of ['source.mp4','proxy.mov','thumb.jpg']) fs.copyFileSync(join(root,'library',`${publishedId}.${role}`),join(root,'library',`${syncSecondId}.${role}`));
            await js('window.desktop.refreshCatalogue()');
            await until(()=>js(`!!document.getElementById('shot-${syncSecondId}')`),'Second temporary Library row appears');
            await js(`document.getElementById('shot-${syncSecondId}').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`);
            await until(()=>js(`document.querySelector('#clip-inspector h2')?.textContent==='2 Selected Clips'`),'Library multi-selection inspector');
            await click('Export');
            await until(()=>js(`document.querySelectorAll('dialog [data-sync-included]').length===2 && Array.from(document.querySelectorAll('dialog button')).find(el=>el.textContent.trim()==='Export')?.disabled===false`),'Export includes the full explicit multi-selection');
            await click('Cancel');
            for(const role of ['source.mp4','proxy.mov','thumb.jpg','metadata.json']) fs.unlinkSync(join(root,'library',`${syncSecondId}.${role}`));
            await js('window.desktop.refreshCatalogue()');
            await until(()=>js(`document.querySelectorAll('[data-shot-card]').length===1`),'Temporary Library row removed');
            await click('Import');
            assert.equal(await js(`document.querySelector('[aria-label^="Filter clips by device:"]').disabled`),true,'Import disables the sole device option');
            await js(`document.querySelector('[aria-label="Clear filters"]').click()`);
            await click('Library');
            assert.equal(await js(`document.querySelector('[aria-label^="Filter clips by device:"]').disabled`),true,'Library disables the sole device option');
            await click('Import');
            await js('window.desktop.chooseClips()');
            await until(()=>js(`!!document.querySelector('[data-shot-status="synced"]')`),'Re-adding a committed clip shows blue in Import');
            assert.equal(
                fs.readdirSync(join(root, "library")).filter((name) => name.endsWith(".metadata.json")).length,
                1,
                "X excludes clip from submission",
            );
            assert.equal(
                await js(
                    `window.desktop.getShots().then(collection=>collection.shots.filter(shot=>shot.organization.skipped).length)`,
                ),
                0,
                "Review removal preserves Skip",
            );
            let ingested = await js(
                `window.desktop.getShots().then(collection=>collection.shots.find(shot=>shot.ingestState==='synced'))`,
            );
            await js(`document.querySelector('[data-shot-status="synced"]').click()`);
            await until(async()=>!(await commitDisabled()),'Selected synced clip can open Commit review');
            await click('Commit');
            await until(()=>js(`document.querySelectorAll('[data-review-included]').length===1 && !!document.querySelector('[data-review-mode="synced"]')`),'Selected synced clip reviews only its own workspace removal');
            await click('Cancel');
            assert.equal(await js(`!!document.getElementById('shot-${ingested.id}')`),true,'Cancel preserves the selected synced clip');
            const selectedSyncedMedia=fs.readdirSync(join(root,'library')).map(name=>[name,fs.readFileSync(join(root,'library',name))]);
            const selectedSyncedTransfers=(await js('window.desktop.getIngestStatus()')).total;
            await click('Commit');
            await until(()=>js(`!!document.querySelector('[data-review-mode="synced"]')`),'Selected synced review reopens');
            await click('Commit');
            await until(()=>js(`!document.querySelector('dialog[open]') && !document.getElementById('shot-${ingested.id}')`),'Selected Synced confirmation removes that workspace card');
            const selectedSyncedStatus=await js('window.desktop.getIngestStatus()');
            assert.equal(selectedSyncedStatus.active,false);assert.equal(selectedSyncedStatus.total,selectedSyncedTransfers,'Synced confirmation adds no transfers');
            assert.equal(await js(`document.querySelectorAll('[data-shot-card]').length`),1,'Unselected new clip stays in Import');
            for(const [name,bytes] of selectedSyncedMedia)assert.deepEqual(fs.readFileSync(join(root,'library',name)),bytes,'Selected Synced removal leaves Library files unchanged');
            await js('window.desktop.chooseClips()');
            await until(()=>js(`!!document.getElementById('shot-${ingested.id}')`),'Rediscovery restores the removed synced clip');
            const retained = await js(`window.desktop.cancelClips([${JSON.stringify(ingested.id)}])`);
            assert.ok(retained.shots.some(shot=>shot.id===ingested.id&&shot.ingestState==='synced'), 'Cancel IPC leaves completed clips and receipts in the workspace');
            await click('Commit');
            await until(()=>js(`!!document.querySelector('[data-review-mode="synced"]') && !!document.getElementById('shot-${ingested.id}')`),'Unselected Commit reviews synced cards without removing them');
            assert.equal(await js(`document.querySelector('[data-review-mode="synced"] span').textContent==='Synced' && document.querySelector('[data-review-mode="synced"] span').classList.contains('text-blue-300')`),true,'Synced tag is blue');
            await js(`document.querySelector('[data-review-mode="synced"] button').click()`);
            assert.equal(await js(`document.querySelector('[data-review-mode="synced"]').getAttribute('data-review-included')`),'false');
            await click('Cancel');
            assert.equal(await js(`!!document.getElementById('shot-${ingested.id}')`),true,'Cancelling review preserves synced clips');
            const newId=await js(`window.desktop.getShots().then(c=>c.shots.find(s=>s.id!==${JSON.stringify(ingested.id)}).id)`);
            await js(`window.desktop.ejectClips(['${newId}'])`);
            await until(()=>js(`document.querySelectorAll('[data-shot-card]').length===1 && Array.from(document.querySelectorAll('footer button')).find(button=>button.textContent==='Commit')?.disabled===false`),'Commit remains available when only synced rows need review');
            await click('Commit');
            await until(()=>js(`document.querySelectorAll('[data-review-included]').length===1 && !!document.querySelector('[data-review-mode="synced"]')`),'Only-synced workspace opens a removal review');
            await click('Cancel');
            await js('window.desktop.chooseClips()');
            await until(()=>js(`document.querySelectorAll('[data-shot-card]').length===2 && !!document.getElementById('shot-${newId}')?.querySelector('[data-shot-image]')`),'Restore the excluded new fixture clip');
            await js(`document.getElementById('shot-${newId}').click()`);await click('Commit');
            await until(()=>js(`document.querySelectorAll('[data-review-included]').length===1`),'Selected-only review targets selected new clip');
            assert.equal(await js(`!!document.querySelector('[data-review-mode="synced"]')`),false,'Selected-only Commit excludes all synced cards');
            await click('Cancel');await js(`document.getElementById('shot-${newId}').click()`);
            await click('Commit');await until(()=>js(`!!document.querySelector('[data-review-mode="synced"]')`),'Review blue card for confirmation');
            await js(`document.querySelector('[data-review-mode="new"] button').click()`);
            await click('Commit');
            await until(()=>js(`!document.querySelector('dialog[open]')&&!document.getElementById('shot-${ingested.id}')`),'Confirming the included Synced row removes only that card');
            assert.equal(await js(`!!document.getElementById('shot-${newId}')`),true,'Excluded new clip remains');
            assert.equal((await js('window.desktop.getIngestStatus()')).active,false,'Synced-only confirmation queues no transfers');
            await js('window.desktop.chooseClips()');
            await until(()=>js(`!!document.querySelector('[data-shot-status="synced"]')`),'Explicit discovery can restore a blue card with its receipt intact');
            await window.loadFile(join(__dirname, "../out/renderer/index.html"));
            await until(
                () => js(`!!document.querySelector('[data-shot-status="synced"]')`),
                "Synced badge lost on renderer reload",
            );
            // A missing configured folder is a critical Library issue, not a raw filesystem failure.
            fs.renameSync(join(root, "library"), join(root, "library-offline"));
            await js(`document.querySelector('header button[aria-label="Refresh assets"]').click()`);
            await until(
                () => js(`document.querySelector('dialog[open] h2')?.textContent==='Library unavailable'`),
                "Missing Library did not show a focused refresh error",
            );
            assert.equal(await js(`document.querySelector('dialog[open]').textContent.includes('configured Library folder is missing')`), true);
            await until(
                () => js(`document.querySelector('[data-application-level="error"]')?.textContent==='Library Unavailable'`),
                "Missing Library did not show red app status",
            );
            await click("Dismiss");
            fs.renameSync(join(root, "library-offline"), join(root, "library"));
            await js(`document.querySelector('header button[aria-label="Refresh assets"]').click()`);
            await until(
                () => js(`document.querySelector('[data-application-level="ready"]')?.textContent==='Ready'`),
                "Restored Library did not recover app status",
            );
            // Externally deleted dummy Library files must become New on an explicit refresh.
            for (const suffix of ["source.mp4", "thumb.jpg", "metadata.json"])
                fs.unlinkSync(join(root, "library", `${ingested.id}.${suffix}`));
            await js(`document.querySelector('header button[aria-label="Refresh assets"]').click()`);
            await until(
                () =>
                    js(
                        `!document.querySelector('#shot-${ingested.id}[data-shot-status="synced"]') && Array.from(document.querySelectorAll('footer button')).some(button=>button.textContent==='Commit'&&!button.disabled)`,
                    ),
                "Deleted shot was still synced",
            );
            await click("Commit");
            await until(
                () => js(`document.querySelector('dialog[open]')?.textContent.includes('Ready to Commit?')`),
                "Fresh review missing",
            );
            assert.equal(
                await js(`document.querySelector('dialog').textContent.includes('↻ Update')`),
                false,
                "Deleted clips are New",
            );
            await click("Cancel");
            await js(
                `(async () => { const review = await window.desktop.reviewIngest([${JSON.stringify(ingested.id)}]); return window.desktop.startIngest(review.token,[${JSON.stringify(ingested.id)}]); })()`,
            );
            await until(async()=>!(await js('window.desktop.getIngestStatus()')).active &&
                !(await js('window.desktop.getShots()')).shots.some(shot=>shot.id===ingested.id),'Fresh Commit removes its card');
            await js('window.desktop.chooseClips()');
            await until(
                () => js(`!!document.querySelector('[data-shot-status="synced"]')`),
                "Fresh re-ingestion failed",
            );
            await js(
                `window.desktop.updateOrganization([${JSON.stringify(ingested.id)}],{field:'notes',operation:'set',value:'Updated after ingestion'})`,
            );
            await until(
                () =>
                    js(
                        `document.getElementById('shot-${ingested.id}')?.getAttribute('data-shot-status')==='changes-pending'`,
                    ),
                "Metadata edit did not show the pending-update card style",
            );
            const committedThumbnail = 'data:image/jpeg;base64,'+fs.readFileSync(join(root,'library',`${ingested.id}.thumb.jpg`)).toString('base64');
            const replacementThumbnail = await js(`window.desktop.getShots().then(collection=>window.desktop.getShotThumbnail(collection.shots.find(shot=>shot.id!==${JSON.stringify(ingested.id)}).id))`);
            assert.notEqual(replacementThumbnail,committedThumbnail);
            await js(`window.desktop.setShotThumbnail(${JSON.stringify(ingested.id)},${JSON.stringify(replacementThumbnail)})`);
            await js(`document.getElementById('shot-${ingested.id}').click()`);
            await until(
                () =>
                    js(
                        `document.querySelector('[aria-label="Notes"]')?.value==='Updated after ingestion' && !document.querySelector('[aria-label="Revert pending clip attributes"]').disabled`,
                    ),
                "Revert was not available beside Clear",
            );
            assert.ok(
                await js(
                    `document.querySelector('[aria-label="Revert pending clip attributes"]').getBoundingClientRect().left > document.querySelector('[aria-label="Clear selected clip information"]').getBoundingClientRect().right`,
                ),
                "Revert sits to the right of Clear",
            );
            await click("Revert");
            await until(
                () => js(`!!document.querySelector('#revert-organization-title')`),
                "Revert confirmation missing",
            );
            if(process.env.SHOT_MANAGER_UX_SCREENSHOTS) { await new Promise(resolve=>setTimeout(resolve,150)); await fs.promises.writeFile('/tmp/owmo-ux-revert.png',(await window.webContents.capturePage()).toPNG()); }
            await click("Cancel");
            assert.equal(
                await js(`document.querySelector('[aria-label="Notes"]').value`),
                "Updated after ingestion",
                "Cancel preserves local edits",
            );
            assert.equal(await js(`window.desktop.getShotThumbnail(${JSON.stringify(ingested.id)})`),replacementThumbnail,'Cancel preserves the local thumbnail');
            await js(
                `(() => { const notes = document.querySelector('[aria-label="Notes"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(notes, 'Typing immediately before Revert'); notes.dispatchEvent(new Event('input', { bubbles: true })); })()`,
            );
            await click("Revert");
            await js(`document.querySelector('[aria-label="Confirm revert clip attributes"]').click()`);
            await until(
                () =>
                    js(
                        `!document.querySelector('dialog[open]') && document.querySelector('[aria-label="Notes"]').value==='' && document.getElementById('shot-${ingested.id}').getAttribute('data-shot-status')==='synced'`,
                    ),
                "Revert did not restore Notes and Synced immediately",
            );
            assert.equal(await js(`window.desktop.getShotThumbnail(${JSON.stringify(ingested.id)})`),committedThumbnail,'Revert restores the Library thumbnail through real IPC');
            await until(()=>js(`document.getElementById('shot-${ingested.id}').querySelector('[data-shot-image]')?.src===${JSON.stringify(committedThumbnail)}`),'Reverted thumbnail did not refresh in the card');
            await new Promise((resolve) => setTimeout(resolve, 700));
            assert.equal(
                await js(
                    `window.desktop.getShots().then(collection => collection.shots.find(shot => shot.id === ${JSON.stringify(ingested.id)}).organization.notes)`,
                ),
                "",
                "Debounced Notes save cannot overwrite reverted attributes",
            );
            assert.equal(
                await js(`document.querySelector('[aria-label="Revert pending clip attributes"]').disabled`),
                true,
                "Synced clip has nothing to revert",
            );
            await js(
                `window.desktop.updateOrganization([${JSON.stringify(ingested.id)}],{field:'notes',operation:'set',value:'Updated after ingestion'})`,
            );
            await until(
                () =>
                    js(
                        `document.getElementById('shot-${ingested.id}').getAttribute('data-shot-status')==='changes-pending'`,
                    ),
                "Second metadata update did not become pending",
            );
            await click("Commit");
            await until(
                () => js(`document.querySelector('dialog[open]')?.textContent.includes('↻ Update')`),
                "Replacement not labeled",
            );
            assert.equal(await js(`document.querySelector('dialog').textContent.includes('existing Library clip')`), false, 'Update tag provides the replacement context without extra copy');
            await click("Cancel");
            // Existing Library assets must indicate an update even without a local receipt.
            const unprocessed = await js(
                `window.desktop.getShots().then(collection=>collection.shots.find(shot=>shot.id!==${JSON.stringify(ingested.id)}))`,
            );
            assert.equal(unprocessed.ingestion, undefined);
            assert.equal(
                await js(
                    `document.getElementById('shot-${unprocessed.id}').getAttribute('data-shot-status')==='changes-pending'`,
                ),
                false,
                "New clip remains neutral",
            );
            await fs.promises.copyFile(
                join(root, "source", unprocessed.filename),
                join(root, "library", `${unprocessed.id}.source.mp4`),
            );
            await fs.promises.copyFile(
                join(root, "library", `${ingested.id}.thumb.jpg`),
                join(root, "library", `${unprocessed.id}.thumb.jpg`),
            );
            await fs.promises.writeFile(join(root, "library", `${unprocessed.id}.metadata.json`), "{}");
            await js(`document.querySelector('header button[aria-label="Refresh assets"]').click()`);
            await until(
                () =>
                    js(
                        `document.getElementById('shot-${unprocessed.id}')?.classList.contains('ingest-card-needs-sync') && document.getElementById('shot-${unprocessed.id}').getAttribute('data-shot-status')==='changes-pending'`,
                    ),
                "Existing clip without receipt was displayed as New",
            );
            await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
            await until(() => js(`!document.querySelector('[data-shot-card] > button[aria-pressed="true"]')`), 'Clear selection before all-workspace review');
            await click("Commit");
            await until(
                () => js(`document.querySelectorAll('dialog button[aria-label^="Remove "]').length===2`),
                "Both updates must appear in review",
            );
            assert.equal(
                await js(`document.querySelector('dialog').textContent.includes('New')`),
                false,
                "Update cards agree with review",
            );
            await click("Cancel");
            // Deterministic active progress fixture, with the real Stop IPC and confirmation UI.
            const cardCollection = await js("window.desktop.getShots()");
            shotsOverride = {
                ...cardCollection,
                revision: cardCollection.revision + 1000,
                shots: cardCollection.shots.map((shot, index) => ({
                    ...shot,
                    editable: false,
                    ingestState: index === 0 ? "processing" : "queued",
                    transferPercent: index === 0 ? 42 : undefined,
                    proxyState: index === 0 ? "ready" : "encoding",
                    proxyLocation: index === 0 ? "library" : undefined,
                    proxyPercent: index === 0 ? undefined : 38,
                    mediaReadiness: {state:index===0?'committed':'preparing'},
                })),
            };
            backend.emit("message", {
                type: "shots:changed",
                change: { revision: shotsOverride.revision, vocabularyRevision: shotsOverride.revision },
            });
            await until(
                () =>
                    js(
                        `!!document.querySelector('[data-shot-activity="transfer"]') && !!document.querySelector('[data-proxy-state="encoding"]')`,
                    ),
                "Transfer activity or proxy readiness dot missing",
            );
            assert.equal(
                await js(`getComputedStyle(document.querySelector('[data-proxy-state="encoding"]')).opacity`),
                "1",
                "Proxy readiness indicator stays undimmed",
            );
            assert.equal(await js(`document.querySelector('[data-proxy-location="library"]').classList.contains('border-t-blue-400')`), true, "Active Commit indicator is blue");
            assert.equal(await js(`(() => {
                const dot = document.querySelector('[data-proxy-state="encoding"]');
                const previews = Array.from(document.querySelectorAll('[data-shot-working="true"]'));
                return dot.classList.contains('border-t-yellow-300') &&
                    Array.from(document.querySelectorAll('[data-readiness-working]')).length === 2 &&
                    dot.getBoundingClientRect().width === 12 && getComputedStyle(dot).animationName === 'spin' && previews.length === 2 &&
                    previews.every(el => getComputedStyle(el, '::after').animationName === 'shot-work-pulse') &&
                    !document.querySelector('[data-transfer-spinner], [data-proxy-spinner]');
            })()`), true, "Encoding and transfers use small corner spinners and thumbnail pulses without central spinners");
            assert.equal(
                await js(`document.querySelector('[data-shot-status="processing"] [data-shot-progress]').value`),
                42,
                "Transfer progress is shown on its thumbnail",
            );
            assert.equal(await js(`document.querySelector('[data-shot-status="processing"] [data-shot-progress]').dataset.workType`), "commit", "Commit uses the blue progress style");
            assert.equal(await js(`(() => { const preview=document.querySelector('[data-shot-status="queued"] [data-shot-preview]'); const style=getComputedStyle(preview); return style.opacity==='0.45'&&style.filter.includes('grayscale(0.8)'); })()`), true, 'Queued proxy encoding retains locked thumbnail styling');
            assert.equal(
                await js(
                    `document.querySelector('[data-proxy-state="encoding"]').parentElement.querySelector('[data-shot-progress]').value`,
                ),
                38,
                "Encoding progress is shown on its thumbnail",
            );
            assert.equal(await js(`document.querySelector('[data-proxy-state="encoding"]').parentElement.querySelector('[data-shot-progress]').dataset.workType`), "proxy", "Encoding uses the yellow progress style");
            assert.equal(await js(`document.querySelector('[data-shot-progress]').getBoundingClientRect().height`), 6, "Thumbnail progress bar is easier to see");
            assert.equal(
                await js(`getComputedStyle(document.querySelector('[data-shot-progress]')).height`),
                "6px",
                "Card progress uses the larger height",
            );
            shotsOverride = { ...shotsOverride, revision: shotsOverride.revision + 1, shots: shotsOverride.shots.map((shot, index) => ({
                ...shot, proxyState: index === 0 ? "missing" : "ready", proxyLocation: index === 0 ? undefined : "cache", mediaReadiness:{state:index===0?"preparing":"ready"},
            })) };
            backend.emit("message", { type: "shots:changed", change: { revision: shotsOverride.revision, vocabularyRevision: shotsOverride.revision } });
            await until(() => js(`!!document.querySelector('[data-proxy-location="cache"]')`), "Local proxy indicator missing");
            assert.equal(await js(`document.querySelector('[data-proxy-location="cache"]').classList.contains('bg-yellow-400')`), true, "Local proxy is yellow");
            assert.equal(await js(`(() => { const indicator=document.querySelector('[data-shot-status="processing"] [data-proxy-state]'); return indicator.dataset.readinessWorking==='true' && getComputedStyle(indicator).animationName==='spin'; })()`), true, "Active work displays a small readiness spinner");
            const currentStatus = await js("window.desktop.getIngestStatus()");
            statusOverride = {
                revision: currentStatus.revision + 1000,
                completed: 1,
                active: true,
                stopping: false,
                position: 1,
                total: 3,
                tasks: { completed: 2, total: 5, percent: 48, proxiesRemaining: 1, transfersRemaining: 2 },
                work: {paused:false,busy:true,encoding:true,queued:1,scratchPath:null,current:{id:ingested.id,percent:61}},
                errors: [],
                libraryPath: join(root, "library"),
                current: { id: ingested.id, filename: ingested.filename, phase: "transferring", percent: 42, kind:'commit' },
            };
            backend.emit("message", { type: "ingestion:changed", status: statusOverride });
            await until(
                () =>
                    js(
                        `document.querySelector('[data-ingest-progress]')?.getAttribute('aria-label')==='1 proxy, 2 commits, 0 exports'`,
                    ),
                "Active footer summary missing",
            );
            assert.equal(
                await js(`document.querySelector('footer progress')`),
                null,
                "Footer uses task counts without an aggregate progress bar",
            );
            assert.equal(await js(`document.querySelector('[aria-label="Proxy progress"]').getAttribute('aria-valuenow')`),'61','Proxy bar shows the active encode');
            assert.equal(await js(`document.querySelector('[aria-label="Commit progress"]').getAttribute('aria-valuenow')`),'42','Commit bar shows the active clip');
            const commitOnlyStatus = statusOverride;
            statusOverride = { ...statusOverride, revision: statusOverride.revision + 1, exportCurrent:{...statusOverride.current,id:'e'.repeat(64),kind:'sync',percent:73}, tasks: { ...statusOverride.tasks, syncsRemaining: 2, sync: { completed: 1, total: 3, percent: 47 } } };
            backend.emit('message', { type: 'ingestion:changed', status: statusOverride });
            await until(()=>js(`document.querySelector('[data-work-progress]')?.getAttribute('aria-label')==='1 proxy, 2 commits, 2 exports' && document.querySelector('[aria-label="Export progress"]')?.getAttribute('aria-valuenow')==='73'`),'Export progress coexists with proxy/Commit counts');
            assert.equal(await js(`document.querySelector('[aria-label="Commit progress"]').getAttribute('aria-valuenow')`),'42','Commit and Export report separate simultaneous percentages');
            assert.equal(await js(`document.querySelector('[aria-label="Proxy progress"]').getAttribute('aria-valuenow')`),'61','Encoding remains independent of both transfers');
            statusOverride = { ...statusOverride, revision: statusOverride.revision + 1, tasks: { ...statusOverride.tasks, proxiesRemaining: 0, transfersRemaining: 0 } };
            backend.emit('message', { type: 'ingestion:changed', status: statusOverride });
            await until(()=>js(`document.querySelector('[data-work-progress]')?.getAttribute('aria-label')==='0 proxies, 0 commits, 2 exports'`),'Export-only work stays visible');
            statusOverride = { ...commitOnlyStatus, revision: statusOverride.revision + 1 };
            backend.emit('message', { type: 'ingestion:changed', status: statusOverride });
            await until(()=>js(`document.querySelector('[data-work-kind="commit"]').getAttribute('data-active')==='true' && document.querySelector('[aria-label="Commit progress"]')?.getAttribute('aria-valuenow')==='42' && document.querySelector('[data-work-progress]')?.getAttribute('aria-label')==='1 proxy, 2 commits, 0 exports'`),'Commit progress stays independent after Export work finishes');
            const sharedQueueReads=ingestReads;
            await click('Library');
            await until(()=>js(`document.querySelector('[data-work-progress]')?.getAttribute('aria-label')==='1 proxy, 2 commits, 0 exports' && document.querySelector('[aria-label="Proxy progress"]')?.getAttribute('aria-valuenow')==='61'`),'Library keeps shared queue progress');
            await click('Import');
            await until(()=>js(`document.querySelector('[aria-label="Commit progress"]')?.getAttribute('aria-valuenow')==='42'`),'Import keeps shared transfer progress');
            assert.equal(ingestReads,sharedQueueReads,'Switching tabs never reloads queue status');
            const originalQueuedShots = shotsOverride.shots;
            shotsOverride = { ...shotsOverride, revision: shotsOverride.revision + 1, shots: [...originalQueuedShots, {
                ...cardCollection.shots[0], id: 'f'.repeat(64), filename: 'Append candidate.mp4',
                editable: true, available: true, hasThumbnail: true, thumbnailStatus: 'ready', ingestState: undefined,
                organization: { ...cardCollection.shots[0].organization, skipped: false },
            }] };
            backend.emit("message", { type: "shots:changed", change: { revision: shotsOverride.revision, vocabularyRevision: shotsOverride.revision } });
            await until(() => js(`Array.from(document.querySelectorAll('footer button')).some(button=>button.textContent==='Commit'&&!button.disabled)`), 'Commit stays enabled for new candidates during an active transfer');
            shotsOverride = { ...shotsOverride, revision: shotsOverride.revision + 1, shots: originalQueuedShots };
            backend.emit("message", { type: "shots:changed", change: { revision: shotsOverride.revision, vocabularyRevision: shotsOverride.revision } });
            await until(() => js(`Array.from(document.querySelectorAll('footer button')).some(button=>button.textContent==='Commit'&&button.disabled)`), 'Commit disables when only queued clips remain');
            const activeReads = ingestReads;
            backend.emit("message", {
                type: "ingestion:changed",
                status: {
                    ...statusOverride,
                    revision: currentStatus.revision,
                    current: { ...statusOverride.current, percent: 1 },
                },
            });
            await new Promise((resolve) => setTimeout(resolve, 1200));
            assert.equal(ingestReads, activeReads, "Progress notifications do not poll ingestion status");
            assert.equal(
                await js(`document.querySelector('[data-ingest-progress]').getAttribute('aria-label')`),
                "1 proxy, 2 commits, 0 exports",
                "Stale snapshots cannot regress the sync summary",
            );
            const checkProgressLayout = async (label) => {
                const metrics = await js(`(() => {
                    const footer = document.querySelector('footer').getBoundingClientRect();
                    const panel = document.querySelector('[data-ingest-progress]').getBoundingClientRect();
                    const actions = Array.from(document.querySelectorAll('footer button')).find(button=>button.textContent==='Commit').getBoundingClientRect();
                    return { offset: Math.abs((panel.left + panel.right) / 2 - (footer.left + footer.right) / 2), height: footer.height, panelRight: panel.right, actionsLeft: actions.left };
                })()`);
                assert.ok(metrics.offset < 2, `${label}: progress is centered in the window`);
                assert.ok(metrics.height <= 56, `${label}: summary keeps the footer compact`);
                assert.ok(metrics.panelRight < metrics.actionsLeft, `${label}: progress does not overlap controls`);
            };
            await checkProgressLayout("wide");
            await fs.promises.writeFile(
                "/tmp/owmo-ingest-progress-wide.png",
                (await window.webContents.capturePage()).toPNG(),
            );
            window.setSize(1100, 800);
            await until(() => js("window.innerWidth === 1100"), "Narrow layout did not settle");
            await checkProgressLayout("narrow");
            await fs.promises.writeFile(
                "/tmp/owmo-ingest-progress-narrow.png",
                (await window.webContents.capturePage()).toPNG(),
            );
            assert.ok(
                await js(`!!document.querySelector('header [aria-label="Stop processing"]')`),
                "Footer offers Stop during transfers",
            );
            assert.equal(await js(`!!document.querySelector('[data-work-progress] button')`),false,'Work control is in the toolbar, not the footer');
            await js(`document.querySelector('header [aria-label="Stop processing"]').click()`);
            await until(
                () =>
                    js(
                        `document.querySelector('dialog[open] #ingest-dialog-title')?.textContent==='Stop Processing?'`,
                    ),
                "Stop-all confirmation missing",
            );
            await click("Cancel");
            assert.equal(await js(`document.querySelector('dialog[open]')===null && !!document.querySelector('header [aria-label="Stop processing"]')`), true, 'Cancel preserves active work');
            await js(`document.querySelector('header [aria-label="Stop processing"]').click()`);
            await click("Stop");
            await until(
                () =>
                    js(
                        `!document.querySelector('dialog[open]') && !!document.querySelector('header [aria-label="Refresh assets"]')`,
                    ),
                "Footer did not return to Refresh after stopping",
            );
            assert.equal(
                await js(`document.querySelector('[data-work-progress]')?.getAttribute('aria-label')`),
                '0 proxies, 0 commits, 0 exports',
                "Idle footer retains all three task sections",
            );
            statusOverride={...statusOverride,revision:statusOverride.revision+1,work:{...statusOverride.work,busy:true,encoding:false,queued:0}};
            backend.emit('message',{type:'ingestion:changed',status:statusOverride});
            await until(()=>js(`!!document.querySelector('header [aria-label="Refresh assets"]') && !document.querySelector('header [aria-label="Stop processing"]')`),'Thumbnail-only activity cannot be stopped from the footer');
            await js(`document.querySelector('header [aria-label="Refresh assets"]').click()`);
            await until(
                () => js(`!document.querySelector('header [aria-label="Refresh assets"]').disabled`),
                "Refresh did not finish",
            );
            assert.equal(
                await js(`window.desktop.getIngestStatus().then(status => status.active)`),
                false,
                "Refresh never resubmits sync work",
            );
            shotsOverride = undefined;
            statusOverride = undefined;
            // Clear Cache keeps the configured Library and never touches its assets or sources.
            const libraryBeforeClear = fs.readdirSync(join(root, "library"));
            const proxyDirectory = join(root, "profile", "Shot Manager Cache", "proxies");
            const retainedProxy = join(proxyDirectory, "f".repeat(64) + ".proxy.mov");
            fs.writeFileSync(retainedProxy, "synthetic cached proxy");
            assert.ok(
                fs.existsSync(join(root, "profile", "Shot Manager Cache", "metadata.json")),
                "Local metadata is in the managed Cache",
            );
            assert.ok(
                !fs.existsSync(join(root, "profile", "organization.json")),
                "No new draft metadata is hidden in app data",
            );
            await openConfiguration();
            await click("Clear Cache");
            await until(
                () => js(`!!document.querySelector('[aria-label="Confirm clear cache"]')`),
                "Clear Cache confirmation missing",
            );
            await js(`document.querySelector('[aria-label="Keep proxies"]').click()`);
            await js(`document.querySelector('[aria-label="Keep library catalogue"]').click()`);
            const beforeSelectiveClear = rendererLoads;
            const beforeStartupRefresh = catalogueRefreshes;
            holdCatalogueRefresh = true;
            await js(`document.querySelector('[aria-label="Confirm clear cache"]').click()`);
            await until(() => rendererLoads > beforeSelectiveClear, "Selective Clear Cache did not reload the renderer");
            await until(
                () =>
                    js(
                        `!document.querySelector('dialog[open]') && window.desktop.getConfiguration().then(value=>value.libraryPath===${JSON.stringify(join(root, "library"))})`,
                    ),
                "Clear Cache did not restore workspace",
            );
            await until(() => releaseCatalogueRefresh, "Startup did not refresh the Library from Import");
            const cachedLibrary = await js('window.desktop.getLibrary()');
            assert.ok(cachedLibrary.shots.some(shot => shot.proxyState === 'ready' && shot.mediaReadiness.state === 'unchecked'));
            await click('Library');
            await until(() => js(`document.querySelector('section[aria-label="Shot cards"] h2')?.textContent==='Refreshing Library…' && !document.querySelector('[data-shot-card]')`), 'Startup should hide unchecked cached cards');
            releaseCatalogueRefresh();
            await until(() => js(`!!document.querySelector('[data-media-readiness="committed"][data-proxy-location="library"]')`), 'Startup Library scan should show verified readiness');
            await click('Import');
            await click('Library');
            await until(() => js(`!!document.querySelector('[data-media-readiness="committed"][data-proxy-location="library"]')`), 'Tab switch should reuse the verified catalogue');
            assert.equal(catalogueRefreshes, beforeStartupRefresh + 1, 'Tab switches should not request another catalogue refresh');
            await click('Import');
            assert.equal(
                fs.readFileSync(retainedProxy, "utf8"),
                "synthetic cached proxy",
                "Keep proxies preserves cached proxies",
            );
            assert.deepEqual(
                fs.readdirSync(join(root, "library")),
                libraryBeforeClear,
                "Clear Cache preserves Library assets",
            );
            assert.equal(fs.readdirSync(join(root, "source")).length, 2, "Clear Cache preserves original clips");
            await openConfiguration();
            await click("Clear Cache");
            await until(
                () => js(`!!document.querySelector('[aria-label="Confirm clear cache"]')`),
                "Second Clear Cache confirmation missing",
            );
            const beforeFullClear = rendererLoads;
            await js(`document.querySelector('[aria-label="Confirm clear cache"]').click()`);
            await until(() => rendererLoads > beforeFullClear, "Full Clear Cache did not reload the renderer");
            await until(() => js(`!document.querySelector('dialog[open]')`), "Second Clear Cache did not finish");
            assert.ok(!fs.existsSync(retainedProxy), "Default Clear Cache deletes proxies");
            assert.deepEqual(fs.readdirSync(join(root, "library")), libraryBeforeClear);
            await until(
                () => js(`window.desktop.getShots().then(value=>value.scans.every(scan=>scan.state==='complete'))`),
                "Restored sources did not finish scanning after Clear Cache",
            );
            await js(`window.desktop.getShots().then(value=>window.desktop.ejectClips(value.shots.map(shot=>shot.id)))`);
            await openConfiguration();
            await click("Clear Cache");
            await until(() => js(`!!document.querySelector('[aria-label="Confirm clear cache"]')`), "Empty-workspace Clear Cache confirmation missing");
            if(process.env.SHOT_MANAGER_UX_SCREENSHOTS) { await new Promise(resolve=>setTimeout(resolve,150)); await fs.promises.writeFile('/tmp/owmo-ux-cache.png',(await window.webContents.capturePage()).toPNG()); }
            const beforeEmptyClear = rendererLoads;
            await js(`document.querySelector('[aria-label="Confirm clear cache"]').click()`);
            await until(() => rendererLoads > beforeEmptyClear, "Empty-workspace Clear Cache did not reload the renderer");
            await until(() => js(`!document.querySelector('dialog[open]') && !!document.querySelector('[data-application-level="ready"]')`), "Empty-workspace Clear Cache did not finish");
            await js("window.desktop.chooseClips()");
            await until(
                () => js(`document.querySelectorAll('[data-shot-status]').length===2 && window.desktop.getShots().then(value=>value.scans.every(scan=>scan.state==='complete'))`),
                "Re-added source stayed Queued after removing sources and clearing Cache",
            );
            const ejectShot = await js(`window.desktop.getShots().then(value=>value.shots[0])`);
            assert.equal(await js(`document.querySelectorAll('[data-shot-card] button[aria-label^="Eject "], [data-shot-card] button[aria-label^="Stop "]').length`),0,'Thumbnail actions are inspection only');
            await js(`document.getElementById('shot-${ejectShot.id}').click()`);
            await until(()=>js(`!!document.querySelector('#clip-inspector button[aria-label="Eject selected clip"]:not(:disabled)')`),'Inspector Eject is ready');
            await js(`document.querySelector('#clip-inspector button[aria-label="Eject selected clip"]').click()`);
            await until(()=>js(`!!document.querySelector('#eject-title')`),'Inspector Eject confirmation missing');
            assert.equal(await js(`document.querySelectorAll('[data-shot-card]').length`),2,'Card remains before Eject confirmation');
            await js(`document.querySelector('button[aria-label="Confirm eject clips"]').click()`);
            await until(() => js(`document.querySelectorAll('[data-shot-card]').length===1`), 'Inspector Eject did not remove one clip');
            assert.equal(fs.readdirSync(join(root,'source')).length,2,'Eject preserves original media');
            assert.deepEqual(fs.readdirSync(join(root,'library')),libraryBeforeClear,'Eject preserves Library assets');
            const draftsAfterEject=JSON.parse(fs.readFileSync(join(root,'profile','Shot Manager Cache','metadata.json'),'utf8'));
            assert.ok(Object.values(draftsAfterEject.drafts).some(record=>record.clip?.path===ejectShot.filePath),'Eject preserves cached metadata');
            // Cache clearing must restore exact workspace membership, not rescan ejected siblings.
            const loadsBeforeEjectedClear=rendererLoads;
            await openConfiguration(); await click("Clear Cache");
            await until(()=>js(`!!document.querySelector('[aria-label="Confirm clear cache"]')`),'Eject Cache confirmation missing');
            await js(`document.querySelector('[aria-label="Keep metadata"]').click()`);
            await js(`document.querySelector('[aria-label="Confirm clear cache"]').click()`);
            await until(()=>rendererLoads>loadsBeforeEjectedClear,'Cache clear after Eject did not reload');
            await until(()=>js(`document.querySelectorAll('[data-shot-card]').length===1`),'Cache clear reintroduced an ejected clip');
            await js(`window.desktop.chooseClips()`);
            await until(()=>js(`document.querySelectorAll('[data-shot-card]').length===2`),'Explicit re-add did not restore the ejected clip');
            const selectedButtons = await js(`Array.from(document.querySelectorAll('[data-shot-card] > button[aria-label^="Inspect "]')).map(button=>button.id)`);
            await js(`document.getElementById(${JSON.stringify(selectedButtons[0])}).click()`);
            await js(`document.getElementById(${JSON.stringify(selectedButtons[1])}).dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`);
            await until(()=>js(`!!document.querySelector('button[aria-label="Eject selected clips"]:not(:disabled)')`),'Bulk Eject action missing');
            await js(`document.querySelector('button[aria-label="Eject selected clips"]').click()`);
            await until(()=>js(`!!document.querySelector('#eject-title')`),'Bulk Eject confirmation missing');
            await js(`document.querySelector('button[aria-label="Confirm eject clips"]').click()`);
            await until(()=>js(`document.querySelectorAll('[data-shot-card]').length===0`),'Bulk Eject did not clear selected cards');
            // Delete uses real IPC/backend operations against this temporary Library only.
            // Repair the deliberately malformed second JSON used earlier, giving
            // the deletion check two valid, independently selected Library rows.
            const deleteFixture=JSON.parse(fs.readFileSync(join(root,'library',`${publishedId}.metadata.json`),'utf8'));
            fs.writeFileSync(join(root,'library',`${unprocessed.id}.metadata.json`),JSON.stringify({...deleteFixture,
                id:unprocessed.id,fingerprint:unprocessed.fingerprint,originalFilename:unprocessed.filename,bytes:unprocessed.bytes,metadata:unprocessed.metadata}));
            fs.copyFileSync(join(root,'library',`${publishedId}.proxy.mov`),join(root,'library',`${unprocessed.id}.proxy.mov`));
            await click('Library');
            await js('window.desktop.refreshCatalogue()');
            await until(()=>js(`document.querySelectorAll('[data-shot-card]').length===2`),'Library clips available for Delete');
            const deleteIds=await js(`window.desktop.getLibrary().then(value=>value.shots.map(shot=>shot.id))`);
            const originalCount=fs.readdirSync(join(root,'source')).length;
            await js(`document.getElementById('shot-${deleteIds[0]}').click()`);
            await until(()=>js(`!!document.querySelector('#clip-inspector button[aria-label="Delete"]:not(:disabled)')`),'Delete action is ready');
            await click('Delete');
            await until(()=>js(`!!document.querySelector('#delete-title') && !!document.querySelector('[aria-label="Confirm delete clips"]:not(:disabled)')`),'Delete confirmation reviews selected clip');
            assert.equal(await js(`document.querySelector('[aria-label="Affected clips"]').children.length`),1,'Delete lists the selected clip');
            await click('Cancel');
            assert.ok(fs.existsSync(join(root,'library',`${deleteIds[0]}.metadata.json`)),'Cancelling Delete keeps Library files');
            await js(`document.getElementById('shot-${deleteIds[1]}').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`);
            await until(()=>js(`!!document.querySelector('.multi-clip-inspector button[aria-label="Delete"]:not(:disabled)')`),'Multi-selection Delete is ready');
            await click('Delete');
            await until(()=>js(`!!document.querySelector('[aria-label="Confirm delete clips"]:not(:disabled)')`),'Bulk Delete confirmation ready');
            assert.equal(await js(`document.querySelector('[aria-label="Affected clips"]').children.length`),deleteIds.length,'Delete lists every selected clip');
            assert.equal(await js(`Array.from(document.querySelectorAll('[data-delete-included] span')).every(tag=>tag.textContent==='Delete'&&tag.classList.contains('text-red-300'))`),true,'Delete rows have red action tags');
            await js(`Array.from(document.querySelectorAll('[data-delete-included] button')).forEach(button=>button.click())`);
            assert.equal(await js(`document.querySelector('[aria-label="Confirm delete clips"]').disabled`),true,'Excluding every row disables Delete');
            assert.equal(await js(`document.querySelectorAll('[data-delete-included="false"]').length`),2,'Excluded rows stay visible');
            await js(`document.querySelector('[aria-label="Affected clips"] button').click()`);
            assert.equal(await js(`document.querySelector('[aria-label="Confirm delete clips"]').disabled`),false,'Restoring a row enables Delete');
            const deletedFirst=await js(`document.querySelector('[data-delete-included="true"] p').textContent`);
            await js(`document.querySelector('[aria-label="Confirm delete clips"]').click()`);
            await until(()=>js(`!document.querySelector('dialog[open]') && document.querySelectorAll('[data-shot-card]').length===1`),'Delete submits only included clips');
            const kept=await js(`window.desktop.getLibrary().then(value=>value.shots[0])`);
            assert.notEqual(kept.filename,deletedFirst);
            assert.ok(fs.existsSync(join(root,'library',kept.relativePath)),'Excluded clip retains Library files');
            assert.ok(Object.keys(JSON.parse(fs.readFileSync(join(root,'profile','Shot Manager Cache','metadata.json'),'utf8')).drafts).some(key=>key.endsWith(kept.id)),'Excluded clip retains local metadata');
            await click('Delete');
            await until(()=>js(`!!document.querySelector('[aria-label="Confirm delete clips"]:not(:disabled)')`),'Remaining clip can be reviewed again');
            await js(`document.querySelector('[aria-label="Confirm delete clips"]').click()`);
            await until(()=>js(`!document.querySelector('dialog[open]') && document.querySelectorAll('[data-shot-card]').length===0`),'Confirmed Delete removes Library cards');
            for(const id of deleteIds) assert.ok(!fs.readdirSync(join(root,'library')).some(name=>name.startsWith(id+'.')),'Delete removes associated Library assets');
            const remainingDrafts=JSON.parse(fs.readFileSync(join(root,'profile','Shot Manager Cache','metadata.json'),'utf8')).drafts;
            assert.ok(deleteIds.every(id=>Object.keys(remainingDrafts).some(key=>key.endsWith(id))),'Delete preserves selected local records');
            assert.ok(deleteIds.every(id=>{
                const key=Object.keys(remainingDrafts).find(value=>value.endsWith(id));
                const record=remainingDrafts[key];
                return record.libraryBaseline===undefined && record.ingestion===undefined;
            }),'Delete clears selected remote references');
            assert.equal(fs.readdirSync(join(root,'source')).length,originalCount,'Delete preserves original source files');
            await fs.promises.writeFile(join(root, "validated"), "passed");
            clearTimeout(timer);
            console.log(
                "PASS: native Resolve Export layout/JSON/CSV, destination/review/exclusion, pending-edit protection and multi-selection, inspector button order and confirmed multi-clip Delete, Library Thumb capture/Commit/Revert, media preservation, browsing/playback, independent filters, shared Commit, Import retirement/rediscovery, Cache/configuration, ingestion, notifications and unified Stop.",
            );
            app.quit();
        } catch (error) {
            releaseLibraryThumbnail?.();
            releaseCatalogueRefresh?.();
            console.error(error);
            clearTimeout(timer);
            backend?.kill();
            app.exit(1);
        }
    });
}
