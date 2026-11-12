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
        const result = spawnSync(require("electron"), [__filename], { env, stdio: "inherit", timeout: 60000 });
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
        rendererLoads = 0,
        browsedPath;
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
        if (String(url).endsWith("/api/ingestion") && (!options?.method || options.method === "GET")) ingestReads++;
        const result = await originalFetch(url, options);
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
        const js = (code) => window.webContents.executeJavaScript(code);
        const until = async (condition, message) => {
            for (let i = 0; i < 500; i++) {
                if (await condition()) return;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error(message);
        };
        const click = (text) =>
            js(
                `Array.from((document.querySelector('dialog[open]') ?? document).querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`,
            );
        try {
            await until(() => window && !window.webContents.isLoading(), "Renderer not loaded");
            await until(
                () => js(`window.desktop.getBackendStatus().then(status=>status.state==='connected')`),
                "Backend not connected",
            );
            await until(
                () =>
                    js(
                        `document.querySelector('[aria-label="Application status"]')?.textContent==='Library Not Set' && !!document.querySelector('[data-application-level="error"]')`,
                    ),
                "Missing configuration did not show red app status",
            );
            assert.equal(
                await js(
                    `Array.from(document.querySelectorAll('button[aria-label="Add clips"]')).length===2 && Array.from(document.querySelectorAll('button[aria-label="Add clips"]')).every(button=>button.disabled)`,
                ),
                true,
                "Critical status disables both Add Source buttons",
            );
            assert.equal(
                await js(
                    `document.querySelector('section[aria-label="Shot cards"] h2')?.textContent==='Library Not Set'`,
                ),
                true,
                "Empty workspace reflects the critical status",
            );
            await assert.rejects(
                js(`window.desktop.chooseSource()`),
                /Library Not Set/,
                "Source IPC rejects a critical status",
            );
            // Exercise the real source IPC without exposing renderer paths: chooseSource uses the native picker.
            wrapped.dialog = {
                ...electron.dialog,
                showOpenDialog: async (_owner, options) => ({
                    canceled: false,
                    filePaths: [join(root, options.title === "Set Library Location" ? "library" : "source")],
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
                    "library needs to be set",
                    "Header shows committed location",
                );
            };
            await openConfiguration();
            await until(() => js(`document.querySelector('[aria-label="Cache summary"]')?.textContent.includes('Metadata:') && document.querySelector('[aria-label="Cache summary"]')?.textContent.includes('Proxies:')`), 'Cache Summary did not load');
            assert.ok(await js(`document.querySelector('#cache-summary-title + p + p')?.textContent.includes('90 days')`), 'Cache retention note missing');
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
            await js("window.desktop.chooseSource()");
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
            await until(() => js(`document.querySelector('footer').textContent.includes('1 selected clip to commit')`), 'Footer identifies selected Commit scope');
            await click('Commit');
            await until(() => js(`document.querySelectorAll('dialog [data-review-included]').length===1`), 'Only selected clip enters review');
            await click('Cancel');
            await js(`document.querySelector('input[aria-label="Skip selected clips"]').click()`);
            await until(commitDisabled, 'Skipped-only selection disables Commit without falling back');
            await selectCard(1, true);
            await until(() => js(`document.querySelector('footer').textContent.includes('1 selected clip to commit')`), 'Mixed selection excludes skipped clip');
            await click('Commit');
            await until(() => js(`document.querySelectorAll('dialog [data-review-included]').length===1`), 'Skipped selected clip excluded from review');
            await click('Cancel');
            await js(`document.querySelector('input[aria-label="Skip selected clips"]').click()`);
            await until(() => js(`document.querySelector('footer').textContent.includes('2 selected clips to commit')`), 'Unskipping restores selected eligibility');
            await click('Commit');
            await until(() => js(`document.querySelectorAll('dialog [data-review-included]').length===2`), 'Bulk selection reviews eligible selected clips');
            await click('Cancel');
            await selectCard(0); await selectCard(0);
            await until(() => js(`document.querySelector('footer').textContent.includes('2 clips to commit')&&!document.querySelector('footer').textContent.includes('selected clips to commit')`), 'No selection restores all-workspace Commit scope');
            const idleReads = ingestReads;
            await new Promise((resolve) => setTimeout(resolve, 1200));
            assert.equal(ingestReads, idleReads, "Idle footer does not poll ingestion status");
            await click("Commit");
            await until(
                () => js(`document.querySelector('dialog[open]')?.textContent.includes('Ready to Commit?')`),
                "Review did not open",
            );
            assert.equal(await js(`Array.from(document.querySelectorAll('dialog [data-review-proxy-ready]')).every(tag=>tag.textContent.trim()==='Proxy' && tag.classList.contains('text-blue-300'))`), true, "Only available proxies get neutral blue tags");
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
            await until(
                () =>
                    js(
                        `!document.querySelector('dialog[open]') && !!document.querySelector('[data-shot-status="synced"]')`,
                    ),
                "Ingestion did not complete",
            );
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
            await until(commitDisabled, 'Synced-only selection cannot Commit unrelated eligible clips');
            assert.ok(await js(`document.querySelector('footer').textContent.includes('0 selected clips to commit')`));
            await js(`document.querySelector('[data-shot-status="synced"]').click()`);
            const retained = await js(`window.desktop.cancelClips([${JSON.stringify(ingested.id)}])`);
            assert.ok(retained.shots.some(shot=>shot.id===ingested.id&&shot.ingestState==='synced'), 'Cancel IPC leaves completed clips and receipts in the workspace');
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
                        `!document.querySelector('[data-shot-status="synced"]') && Array.from(document.querySelectorAll('footer button')).some(button=>button.textContent==='Commit'&&!button.disabled)`,
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
            await click("Cancel");
            assert.equal(
                await js(`document.querySelector('[aria-label="Notes"]').value`),
                "Updated after ingestion",
                "Cancel preserves local edits",
            );
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
            assert.ok(
                await js(`document.querySelector('dialog').textContent.includes('Additional assets are preserved')`),
            );
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
                })),
            };
            backend.emit("message", {
                type: "shots:changed",
                change: { revision: shotsOverride.revision, vocabularyRevision: shotsOverride.revision },
            });
            await until(
                () =>
                    js(
                        `!!document.querySelector('[data-transfer-spinner]') && !!document.querySelector('[data-proxy-state="encoding"]')`,
                    ),
                "Transfer spinner or proxy readiness dot missing",
            );
            assert.equal(
                await js(`getComputedStyle(document.querySelector('[data-proxy-state="encoding"]')).opacity`),
                "1",
                "Proxy readiness indicator stays undimmed",
            );
            assert.equal(await js(`document.querySelector('[data-proxy-location="library"]').classList.contains('bg-emerald-400') && document.querySelector('[data-proxy-spinner] > span > span').classList.contains('border-t-yellow-300')`), true, "Library proxy is green and central encoding wheel is yellow");
            assert.equal(
                await js(`(() => { const dot=document.querySelector('[data-proxy-state="encoding"]'); const proxy=document.querySelector('[data-proxy-spinner] > span'); const transfer=document.querySelector('[data-transfer-spinner] > span'); return dot.classList.contains('border-white/65') && !dot.querySelector('svg') && proxy.getBoundingClientRect().width===transfer.getBoundingClientRect().width && proxy.getBoundingClientRect().width===48; })()`),
                true,
                "Encoding shows a hollow corner dot and the same large central spinner as transfers",
            );
            assert.equal(
                await js(`document.querySelector('[data-shot-status="processing"] [data-shot-progress]').value`),
                42,
                "Transfer progress is shown on its thumbnail",
            );
            assert.equal(await js(`document.querySelector('[data-shot-status="processing"] [data-shot-progress]').dataset.workType`), "sync", "Transfer uses the green progress style");
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
                ...shot, proxyState: index === 0 ? "missing" : "ready", proxyLocation: index === 0 ? undefined : "cache",
            })) };
            backend.emit("message", { type: "shots:changed", change: { revision: shotsOverride.revision, vocabularyRevision: shotsOverride.revision } });
            await until(() => js(`!!document.querySelector('[data-proxy-location="cache"]')`), "Local proxy indicator missing");
            assert.equal(await js(`document.querySelector('[data-proxy-location="cache"]').classList.contains('bg-yellow-400')`), true, "Local proxy is yellow");
            assert.equal(await js(`document.querySelector('[data-shot-status="processing"] [data-proxy-state]').classList.contains('border-white/65')`), true, "Unknown proxy displays an empty white circle");
            const currentStatus = await js("window.desktop.getIngestStatus()");
            statusOverride = {
                revision: currentStatus.revision + 1000,
                completed: 1,
                active: true,
                stopping: false,
                position: 1,
                total: 3,
                tasks: { completed: 2, total: 5, percent: 48, proxiesRemaining: 1, transfersRemaining: 2 },
                errors: [],
                libraryPath: join(root, "library"),
                current: { id: ingested.id, filename: ingested.filename, phase: "transferring", percent: 42 },
            };
            backend.emit("message", { type: "ingestion:changed", status: statusOverride });
            await until(
                () =>
                    js(
                        `document.querySelector('[data-ingest-progress]')?.getAttribute('aria-label')==='3 tasks remaining'`,
                    ),
                "Active footer summary missing",
            );
            assert.equal(
                await js(`document.querySelector('footer progress').value`),
                48,
                "Footer shows combined proxy and transfer progress",
            );
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
                "3 tasks remaining",
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
                await js(`!!document.querySelector('header [aria-label="Stop all work"]')`),
                "Toolbar shows Stop during transfers",
            );
            assert.equal(await js(`document.querySelector('[data-work-progress] button')`), null, 'No footer cancellation button remains');
            await js(`document.querySelector('header [aria-label="Stop all work"]').click()`);
            await until(
                () =>
                    js(
                        `document.querySelector('dialog[open] #ingest-dialog-title')?.textContent==='Stop all work?'`,
                    ),
                "Stop-all confirmation missing",
            );
            await click("Cancel");
            assert.equal(await js(`document.querySelector('dialog[open]')===null && !!document.querySelector('header [aria-label="Stop all work"]')`), true, 'Cancel preserves active work');
            await js(`document.querySelector('header [aria-label="Stop all work"]').click()`);
            await click("Stop");
            await until(
                () =>
                    js(
                        `!document.querySelector('dialog[open]') && !!document.querySelector('header [aria-label="Refresh assets"]')`,
                    ),
                "Toolbar did not return to Refresh after stopping",
            );
            assert.equal(
                await js(`document.querySelector('[data-ingest-progress]')`),
                null,
                "No standalone X or Resume remains in idle footer",
            );
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
            const beforeSelectiveClear = rendererLoads;
            await js(`document.querySelector('[aria-label="Confirm clear cache"]').click()`);
            await until(() => rendererLoads > beforeSelectiveClear, "Selective Clear Cache did not reload the renderer");
            await until(
                () =>
                    js(
                        `!document.querySelector('dialog[open]') && window.desktop.getConfiguration().then(value=>value.libraryPath===${JSON.stringify(join(root, "library"))})`,
                    ),
                "Clear Cache did not restore workspace",
            );
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
            const beforeEmptyClear = rendererLoads;
            await js(`document.querySelector('[aria-label="Confirm clear cache"]').click()`);
            await until(() => rendererLoads > beforeEmptyClear, "Empty-workspace Clear Cache did not reload the renderer");
            await until(() => js(`!document.querySelector('dialog[open]') && !!document.querySelector('[data-application-level="ready"]')`), "Empty-workspace Clear Cache did not finish");
            await js("window.desktop.chooseSource()");
            await until(
                () => js(`document.querySelectorAll('[data-shot-status]').length===2 && window.desktop.getShots().then(value=>value.scans.every(scan=>scan.state==='complete'))`),
                "Re-added source stayed Queued after removing sources and clearing Cache",
            );
            const ejectShot = await js(`window.desktop.getShots().then(value=>value.shots[0])`);
            await js(`document.querySelector('button[aria-label="Eject ${ejectShot.filename}"]').click()`);
            await until(() => js(`document.querySelectorAll('[data-shot-card]').length===1`), 'Card Eject did not remove one clip');
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
            await js(`window.desktop.chooseSource()`);
            await until(()=>js(`document.querySelectorAll('[data-shot-card]').length===2`),'Explicit re-add did not restore the ejected clip');
            const selectedButtons = await js(`Array.from(document.querySelectorAll('[data-shot-card] > button[aria-label^="Inspect "]')).map(button=>button.id)`);
            await js(`document.getElementById(${JSON.stringify(selectedButtons[0])}).click()`);
            await js(`document.getElementById(${JSON.stringify(selectedButtons[1])}).dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`);
            await until(()=>js(`!!document.querySelector('button[aria-label="Eject selected clips"]:not(:disabled)')`),'Bulk Eject action missing');
            await js(`document.querySelector('button[aria-label="Eject selected clips"]').click()`);
            await until(()=>js(`document.querySelectorAll('[data-shot-card]').length===0`),'Bulk Eject did not clear selected cards');
            await fs.promises.writeFile(join(root, "validated"), "passed");
            clearTimeout(timer);
            console.log(
                "PASS: managed Cache and Browse Cache, staged Library Save/Cancel/Escape, selective Clear Cache with media preservation, real Electron review, X exclusion, ingestion, persisted sync badge, renderer reload, deleted-Library refresh/New review, replacement review, proxy readiness and compact centered sync summary at wide/narrow sizes, notifications without polling, stale-update protection, and unified toolbar Refresh–Stop control.",
            );
            app.quit();
        } catch (error) {
            console.error(error);
            clearTimeout(timer);
            backend?.kill();
            app.exit(1);
        }
    });
}
