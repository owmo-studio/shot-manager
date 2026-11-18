// Synthetic renderer integration check. No source cards, media, or NAS access.
if (!process.versions.electron) {
    const { spawnSync } = require("node:child_process");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require("electron"), [__filename], { env, stdio: "inherit" });
    if (result.error) console.error(result.error);
    process.exit(result.status ?? 1);
} else {
    const { app, BrowserWindow, ipcMain, protocol } = require("electron");
    const assert = require("node:assert/strict");
    const { mkdtemp, writeFile, rm } = require("node:fs/promises");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    protocol.registerSchemesAsPrivileged([
        {
            scheme: "shot-media",
            privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
        },
    ]);
    let root, window;
    app.on("window-all-closed", () => {});
    const timer = setTimeout(() => {
        console.error("Selection check timed out");
        app.exit(1);
    }, 30000);
    app.whenReady().then(async () => {
        try {
            root = await mkdtemp(join(tmpdir(), "shot-selection-check-"));
            let sources = ["A", "B"].map((id) => ({
                id,
                name: `Source ${id}`,
                path: `/synthetic/${id}`,
                type: "folder",
                cameraModels: [],
                available: true,
            }));
            const metadata = {
                device: { model: "ILME-FX30", manufacturer: "Sony", software: null, evidence: null },
                codec: { name: "h264", profile: null, bitDepth: 8, chroma: "4:2:0" },
                color: {
                    label: "Rec.709",
                    primaries: "bt709",
                    transfer: "bt709",
                    matrix: "bt709",
                    range: "tv",
                    evidence: null,
                    confidence: "declared",
                    conflicts: [],
                },
                resolution: { width: 256, height: 144, displayWidth: 256, displayHeight: 144, rotation: 0 },
                frameRate: { nominal: 30, average: 30, rational: "30/1", mode: "constant", evidence: null },
            };
            let collection = {
                revision: 1,
                scans: sources.map((source) => ({
                    discoveryId: source.id,
                    state: "complete",
                    clipCount: 3,
                    warnings: [],
                })),
                shots: Array.from({ length: 6 }, (_, i) => ({
                    id: String(i + 1).padStart(64, "0"),
                    filename: `Clip ${i + 1}.mp4`,
                    relativePath: `${i + 1}.mp4`,
                    filePath: `/synthetic/${i < 3 ? 'A' : 'B'}/${i + 1}.mp4`,
                    timestamp: `2026-11-0${i < 3 ? 1 : 2}T12:00:0${i}Z`,
                    dateSource: "embedded",
                    dateEvidence: "",
                    dateConfidence: "declared",
                    metadata: i < 3 ? metadata : { ...metadata, device: { ...metadata.device, model: "ZV-E10M2" } },
                    cameraModel: "ILME-FX30",
                    bytes: 100,
                    durationSeconds: 3,
                    hasThumbnail: false,
                    warnings: [],
                    available: true,
                    editable: true,
                    fingerprint: {
                        algorithm: "sha256",
                        scheme: "sampled-sha256-v2",
                        value: String(i + 1).padStart(64, "0"),
                        fileSize: 100,
                        sampleBytes: 262144,
                        sampledBytes: 100,
                    },
                    organization: { identity: null, project: null, scene: "", tags: [], notes: "", skipped: false },
                })),
            };
            ipcMain.handle("fixture:sources", () => sources);
            ipcMain.handle("fixture:shots", () => collection);
            const vocabulary = {
                identity: ["cmsh", "owmo"],
                project: ["crystal-brigade"],
                tags: [
                    "music",
                    "music/edm",
                    "music/rock",
                    "studio",
                    ...Array.from({ length: 20 }, (_, i) => `topic-${String(i).padStart(2, "0")}`),
                ],
            };
            let failOrganizationSave = false;
            let optionSaves = 0;
            let failOptionsSave = false;
            const previewOptions = (removals) => ({
                reviewToken: "a".repeat(64),
                clips: collection.shots.flatMap((shot) => {
                    const data = shot.organization;
                    const removed = {
                        identity: data.identity && removals.identity.includes(data.identity) ? [data.identity] : [],
                        project: data.project && removals.project.includes(data.project) ? [data.project] : [],
                        tags: data.tags.filter((value) => removals.tags.includes(value)),
                    };
                    return Object.values(removed).some((values) => values.length)
                        ? [
                              {
                                  key: shot.id,
                                  name: shot.filename,
                                  path: "/synthetic/" + shot.filename,
                                  status: "active",
                                  removals: removed,
                              },
                          ]
                        : [];
                }),
            });
            ipcMain.handle("fixture:preview-options", (_, removals) => previewOptions(removals));
            ipcMain.handle("fixture:save-options", (_, removals) => {
                if (failOptionsSave) {
                    failOptionsSave = false;
                    throw new Error("Synthetic option save failure");
                }
                optionSaves++;
                collection = {
                    ...collection,
                    revision: collection.revision + 1,
                    shots: collection.shots.map((shot) => ({
                        ...shot,
                        organization: {
                            ...shot.organization,
                            identity: removals.identity.includes(shot.organization.identity)
                                ? null
                                : shot.organization.identity,
                            project: removals.project.includes(shot.organization.project)
                                ? null
                                : shot.organization.project,
                            tags: shot.organization.tags.filter((value) => !removals.tags.includes(value)),
                        },
                    })),
                };
                window.webContents.send("shots:changed", {
                    revision: collection.revision,
                    vocabularyRevision: collection.revision,
                });
                for (const field of ["identity", "project", "tags"])
                    vocabulary[field] = vocabulary[field].filter((value) => !removals[field].includes(value));
                return { vocabulary, collection };
            });
            const currentVocabulary = () => ({
                ...vocabulary,
                tags: [...new Set(collection.shots.flatMap((shot) => shot.organization.tags))].sort(),
            });
            ipcMain.handle("fixture:vocabulary", () => currentVocabulary());
            let failedEdit;
            const organize = (_, ids, action) => {
                if (failOrganizationSave) {
                    failOrganizationSave = false;
                    failedEdit = { ids, action };
                    throw new Error("Synthetic save failure");
                }
                if (["identity", "project"].includes(action.field))
                    action = {
                        ...action,
                        value:
                            vocabulary[action.field].find(
                                (value) => value.toLowerCase() === action.value.toLowerCase(),
                            ) ?? action.value,
                    };
                collection = {
                    ...collection,
                    revision: collection.revision + 1,
                    shots: collection.shots.map((shot) => {
                        if (!ids.includes(shot.id)) return shot;
                        if (!shot.editable) throw new Error("Locked");
                        const data = structuredClone(shot.organization);
                        if (action.field === "skip") data.skipped = action.value === "true";
                        else if (action.field === "all")
                            Object.assign(data, { identity: null, project: null, scene: "", group: '', camera: '', rating: null, tags: [], notes: "" });
                        else if (action.field === 'rating') data.rating = action.value || null;
                        else if (action.field === "notes" || action.field === "scene" || action.field === 'group' || action.field === 'camera')
                            data[action.field] = action.value;
                        else if (action.field === "identity" || action.field === "project") {
                            if (action.operation === "add") data[action.field] = action.value;
                            else if (data[action.field] === action.value) data[action.field] = null;
                        } else
                            data[action.field] =
                                action.operation === "add"
                                    ? [...new Set([...data[action.field], action.value])]
                                    : data[action.field].filter((tag) => tag !== action.value);
                        return { ...shot, organization: data };
                    }),
                };
                if (
                    action.field !== "notes" &&
                    action.operation === "add" &&
                    !vocabulary[action.field].includes(action.value)
                )
                    vocabulary[action.field].push(action.value);
                return { collection, vocabulary: currentVocabulary() };
            };
            ipcMain.handle("fixture:organization", organize);
            ipcMain.handle("fixture:retry-saves", () => {
                if (failedEdit) {
                    const { ids, action } = failedEdit;
                    failedEdit = undefined;
                    return organize(null, ids, action);
                }
            });
            let configuration = { version: 1, libraryPath: null };
            let cache = { bytes: 2048, files: 2 };
            let cancelLibrary = true;
            ipcMain.handle("fixture:configuration", () => configuration);
            ipcMain.handle("fixture:choose-library", () =>
                cancelLibrary ? null : { token: "library-choice", path: "/synthetic/library" },
            );
            ipcMain.handle("fixture:save-locations", () => ({
                configuration: (configuration = { ...configuration, libraryPath: "/synthetic/library" }),
            }));
            let resetCalls = 0;
            let failReset = false;
            const localSummary = () => ({
                ...cache,
                options: vocabulary.identity.length + vocabulary.project.length + vocabulary.tags.length,
                identities: vocabulary.identity.length,
                projects: vocabulary.project.length,
                tags: vocabulary.tags.length,
                records: 6,
                fingerprints: 6,
                sources: sources.length,
                clips: collection.shots.length,
            });
            ipcMain.handle("fixture:local-summary", localSummary);
            let lastClearSelection;
            ipcMain.handle("fixture:local-clear", (_, selection) => {
                if (failReset) {
                    failReset = false;
                    throw new Error("Synthetic reset failure");
                }
                resetCalls++;
                lastClearSelection = selection;
                cache = { bytes: 0, files: 0 };
                return { collection, configuration, workspaceReset: true };
            });
            ipcMain.handle("fixture:cache", () => cache);
            ipcMain.handle("fixture:clear-cache", () => (cache = { bytes: 0, files: 0 }));
            const ejectedSelections = [];
            ipcMain.handle("fixture:cancel", (_, ids) => {
                collection={...collection,revision:collection.revision+1,shots:collection.shots.map(shot=>ids.includes(shot.id)&&['queued','processing'].includes(shot.ingestState)?{...shot,editable:true,ingestState:undefined}:shot)};
                return collection;
            });
            ipcMain.handle("fixture:eject", (_, ids) => {
                const targets=collection.shots.filter(shot=>ids.includes(shot.id));
                if(targets.some(shot=>['queued','processing'].includes(shot.ingestState))) throw new Error('Stop queued clips first');
                ejectedSelections.push([...ids]);
                collection={...collection,revision:collection.revision+1,shots:collection.shots.filter(shot=>!ids.includes(shot.id))};
                return collection;
            });
            await writeFile(
                join(root, "preload.cjs"),
                `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('desktop',{
                flushOrganizationText:async()=>{},getSaveStatus:async()=>({pending:0,failed:0}),onSaveStatusChanged:()=>()=>{},retryOrganizationSaves:()=>ipcRenderer.invoke('fixture:retry-saves'),
                getConfiguration:()=>ipcRenderer.invoke('fixture:configuration'),chooseLibrary:()=>ipcRenderer.invoke('fixture:choose-library'),saveConfigurationLocations:changes=>ipcRenderer.invoke('fixture:save-locations',changes),
                getCacheSummary:()=>ipcRenderer.invoke('fixture:cache'),clearCache:()=>ipcRenderer.invoke('fixture:clear-cache'),
                getLocalDataSummary:()=>ipcRenderer.invoke('fixture:local-summary'),clearLocalData:selection=>ipcRenderer.invoke('fixture:local-clear',selection),browseCache:async()=>{},getCacheInventory:async()=>({metadata:{files:1,bytes:200},thumbnails:{files:2,bytes:2048},fingerprints:{files:6,bytes:600},proxies:{files:1,bytes:4096},total:{files:10,bytes:6944}}),
                previewConfigurationOptions:removals=>ipcRenderer.invoke('fixture:preview-options',removals),saveConfigurationOptions:(removals,reviewToken)=>ipcRenderer.invoke('fixture:save-options',removals,reviewToken),getTagVocabulary:()=>ipcRenderer.invoke('fixture:vocabulary'),updateOrganization:(ids,action)=>ipcRenderer.invoke('fixture:organization',ids,action),
                getBackendStatus:async()=>({state:'connected',health:{status:'ok'}}),getShots:()=>ipcRenderer.invoke('fixture:shots'),
                onShotsChanged:listener=>{const fn=(_,value)=>listener(value);ipcRenderer.on('shots:changed',fn);return()=>ipcRenderer.removeListener('shots:changed',fn)},
                getShotThumbnail:async()=>null,getShotDetails:async()=>({file:{filename:'fixture',path:'/synthetic/fixture',bytes:100},embeddedMetadata:[],errors:[]}),
                cancelClips:ids=>ipcRenderer.invoke('fixture:cancel',ids),
                ejectClips:ids=>ipcRenderer.invoke('fixture:eject',ids)
            });`,
            );
            protocol.handle("shot-media", () => new Response(null, { status: 404 }));
            window = new BrowserWindow({
                show: false,
                width: 1800,
                height: 1080,
                webPreferences: {
                    sandbox: true,
                    contextIsolation: true,
                    nodeIntegration: false,
                    preload: join(root, "preload.cjs"),
                },
            });
            await window.loadFile(join(__dirname, "../out/renderer/index.html"));
            const js = async (code) => {
                try {
                    return await window.webContents.executeJavaScript(code);
                } catch (error) {
                    console.error("Failed renderer check:", code);
                    throw error;
                }
            };
            const wait = async (code) => {
                for (let i = 0; i < 250; i++) {
                    if (await js(code)) return;
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                throw new Error(`UI did not settle: ${code}`);
            };
            const click = async (label, modifiers = {}) => {
                await js(
                    `document.querySelector('button[aria-label=${JSON.stringify(label)}],input[aria-label=${JSON.stringify(label)}]').dispatchEvent(new MouseEvent('click',{bubbles:true,...${JSON.stringify(modifiers)}}))`,
                );
                await new Promise((resolve) => setTimeout(resolve, 15));
            };
            const inspect = (n, modifiers) => click(`Inspect Clip ${n}.mp4`, modifiers);
            const arrow = async (key) => {
                window.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
                window.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
                await new Promise((resolve) => setTimeout(resolve, 30));
            };
            const selected = () =>
                js(
                    `Array.from(document.querySelectorAll('button[aria-label^="Inspect "][aria-pressed="true"]')).map(b=>Number(b.getAttribute('aria-label').match(/Clip (\u005cd+)/)[1])).sort((a,b)=>a-b)`,
                );
            const skipped = () =>
                js(
                    `Array.from(document.querySelectorAll('button[aria-label^="Inspect "][data-skipped="true"]')).map(b=>Number(b.getAttribute('aria-label').match(/Clip (\u005cd+)/)[1])).sort((a,b)=>a-b)`,
                );
            async function check(n) {
                const previous = await selected();
                if (previous.length !== 1 || previous[0] !== n) await inspect(n);
                await click("Skip selected clips");
                await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
                for (let i = 0; i < previous.length; i++) await inspect(previous[i], i ? { metaKey: true } : {});
            }
            const push = async (shots) => {
                collection = { ...collection, revision: collection.revision + 1, shots };
                window.webContents.send("shots:changed", {
                    revision: collection.revision,
                    vocabularyRevision: collection.revision,
                });
                await new Promise((resolve) => setTimeout(resolve, 280));
            };
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "]').length===6`);
            const originals = structuredClone(collection.shots);
            assert.equal(await js(`!!document.querySelector('aside [aria-label="Total clips"]')`), false, 'Sidebar has no redundant total');
            assert.equal(await js(`document.querySelector('[aria-label="Clear filters"]').hasAttribute('aria-pressed')`),false,'Clear is a neutral action');
            assert.equal(await js(`document.querySelector('[aria-label="Clear filters"]').disabled`),true,'Clear is disabled without any filters');
            assert.equal(await js(`!!document.querySelector('aside [aria-label="Add clips"]')`),false,'Sidebar has no Add button');
            await click("Filter clips by device: Sony ZV-E10 II");
            assert.equal(await js(`document.querySelector('[aria-label="Clear filters"]').disabled`),false,'A selected filter enables Clear');
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "]').length===3`);
            assert.equal(await js(`document.querySelector('[aria-label="Clear filters"]').hasAttribute('aria-pressed')`),false,'Clear stays neutral with a device selected');
            assert.equal(await js(`!!document.querySelector('[aria-label="Inspect Clip 1.mp4"]')`),false,"Filtering uses per-clip metadata, independent of discovery folder");
            await click("Filter clips by device: Sony FX30");
            assert.equal(await js(`document.querySelector('[aria-label="Clear filters"]').hasAttribute('aria-pressed')`),false,'Clear stays neutral with multiple device filters');
            await click("Clear filters");
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "]').length===6`);
            assert.equal(await js(`document.querySelector('[aria-label="Clear filters"]').hasAttribute('aria-pressed')`),false);
            assert.equal(await js(`document.querySelectorAll('[aria-label^="Filter clips by device:"][aria-pressed="true"]').length`),0,'All clears every device filter');
            await js(`(() => { const input=document.querySelector('[aria-label="Search clips"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Clip 1'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
            await wait(`document.querySelectorAll('[data-shot-card]').length===1`);
            assert.ok(await js(`!!document.querySelector('[aria-label="Inspect Clip 1.mp4"]')`),'Sidebar search narrows the grid');
            assert.equal(await js(`document.querySelector('[aria-label="Clip selection summary"]').textContent.trim()`),'1 clip total','Commit summary follows search results');
            assert.equal(await js(`document.querySelectorAll('[aria-label^="Filter clips by device:"]').length`),2,'Search leaves hierarchical device options unchanged');
            assert.equal(await js(`document.querySelector('[aria-label="Clear filters"]').disabled`),true,'Search alone does not enable Clear Filters');
            await click('Filter clips by device: Sony FX30');
            await click('Clear filters');
            assert.equal(await js(`document.querySelector('[aria-label="Search clips"]').value`),'Clip 1','Clearing filters preserves Search');
            await js(`(() => { const input=document.querySelector('[aria-label="Search clips"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,''); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
            await wait(`document.querySelectorAll('[data-shot-card]').length===6 && document.querySelector('[aria-label="Search clips"]').value===''`);
            await push(originals.map((shot, index) => ({ ...shot, organization: { ...shot.organization,
                identity: index < 2 ? null : 'Example', project: index < 3 ? 'Tour' : 'Build', tags: index < 3 ? ['studio'] : ['outside'],
            } })));
            await js(`(() => { const select=document.querySelector('[aria-label="Filter by Identity"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,Array.from(select.options).find(o=>o.textContent.startsWith('Unassigned')).value); select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
            await wait(`document.querySelectorAll('[data-shot-card]').length===2`);
            const reapplyDisabled = () => js(`document.querySelector('[aria-label="Refresh search and filters"]').disabled`);
            assert.equal(await reapplyDisabled(), true, 'A fresh query dims Reapply');
            await inspect(1);
            await push(collection.shots.map((shot, index) => index === 0
                ? { ...shot, organization: { ...shot.organization, identity: 'Example' } } : shot));
            assert.deepEqual(await selected(), [1], 'An edited clip stays selected in the Unassigned worklist');
            assert.equal(await js(`document.querySelectorAll('[data-shot-card]').length`), 2);
            assert.equal(await reapplyDisabled(), false, 'An Identity edit enables Reapply');
            await click('Refresh search and filters');
            await wait(`document.querySelectorAll('[data-shot-card]').length===1 && !document.querySelector('[aria-label="Inspect Clip 1.mp4"]')`);
            assert.equal(await reapplyDisabled(), true, 'Reapply dims again after rerunning the query');
            assert.equal(collection.shots[0].organization.identity, 'Example', 'Reapply keeps the local edit');
            await click('Clear filters');
            await click('Choose filter project');
            await click('Filter by project: Tour');
            await wait(`document.querySelectorAll('[data-shot-card]').length===3 && !!document.querySelector('[aria-label="Remove project filter Tour"]')`);
            await js(`(() => { const input=document.querySelector('[aria-label="Find filter project"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Never create this'); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
            assert.equal(await js(`document.querySelectorAll('[aria-label="Selected filter project"] > li').length`),1,'Typing an unknown option creates no filter or metadata');
            await click('Choose filter project');
            await click('Remove project filter Tour');
            await wait(`document.querySelectorAll('[data-shot-card]').length===6`);
            await click('Choose filter tags');await click('Filter by tags: studio');
            await wait(`document.querySelectorAll('[data-shot-card]').length===3 && !!document.querySelector('[aria-label="Remove tags filter studio"]')`);
            await click('Choose filter project');await click('Filter by project: Build');
            await js(`(() => { const select=document.querySelector('[aria-label="Filter by Identity"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,Array.from(select.options).find(o=>o.textContent.startsWith('Unassigned')).value); select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
            await wait(`document.querySelector('[aria-label="Choose filter tags"]').disabled && document.querySelector('[aria-label="Choose filter project"]').disabled`);
            assert.equal(await js(`document.querySelector('[aria-label="Remove tags filter studio"]').disabled`),false,'An incompatible selection can still be cleared');
            await click('Remove tags filter studio');
            await click('Clear filters');await push(originals);
            // The backend chooses a matching copy; the renderer receives one updated record.
            const relocated = { ...structuredClone(originals[0]), filename: "Copied Clip.mp4", filePath: "/synthetic/B/copy.mp4" };
            await push([relocated, ...originals.slice(1)]);
            await wait(`!!document.querySelector('[aria-label="Inspect Copied Clip.mp4"]')`);
            assert.equal(
                await js(`document.querySelectorAll('button[aria-label^="Inspect "]').length`),
                6,
                "Changing a clip's active file location keeps one workspace card",
            );
            await push(
                originals.map((shot, index) =>
                    index === 0
                        ? { ...shot, organization: { ...shot.organization, notes: "Original clip note" } }
                        : shot,
                ),
            );
            await inspect(1);
            await wait(`document.querySelector('[aria-label="Notes"]').value==='Original clip note'`);
            await push(
                collection.shots.map((shot, index) =>
                    index === 0 ? { ...shot, filename: "Renamed.mp4", relativePath: "renamed.mp4" } : shot,
                ),
            );
            await wait(
                `document.querySelector('[aria-label="Inspect Renamed.mp4"]')?.getAttribute('aria-pressed')==='true'`,
            );
            assert.equal(
                await js(`document.querySelector('[aria-label="Notes"]').value`),
                "Original clip note",
                "Renaming keeps the selected fingerprint and notes",
            );
            const samePathReplacement = {
                ...collection.shots[0],
                id: "f".repeat(64),
                fingerprint: { ...collection.shots[0].fingerprint, value: "f".repeat(64) },
                organization: { identity: null, project: null, scene: "", tags: [], notes: "", skipped: false },
            };
            await push([samePathReplacement, ...collection.shots.slice(1)]);
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "][aria-pressed="true"]').length===0`);
            await click("Inspect Renamed.mp4");
            await wait(`document.querySelector('[aria-label="Notes"]').value===''`);
            assert.equal(
                await js(`document.querySelector('[aria-label="Notes"]').value`),
                "",
                "New content at the same path cannot inherit selected notes",
            );
            await push(originals);
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "]').length===6`);
            await wait(
                `document.querySelector('[aria-label="Library location"]').textContent.includes('Library Not Configured')`,
            );
            await click("Configuration");
            await wait(`!!document.querySelector('dialog[open] [aria-label="Identity options"]')`);
            await wait(`!!document.querySelector('[aria-label="Delete Identity option cmsh"]')`);
            assert.deepEqual(await js(`Array.from(document.querySelectorAll('dialog h3')).map(e=>e.textContent)`), [
                "Identity",
                "Project",
                "Cache Summary",
            ]);
            assert.equal(
                await js(`getComputedStyle(document.querySelector('[aria-label="Identity options"]')).height`),
                "192px",
            );
            assert.ok(
                await js(
                    `document.querySelector('[aria-label="Configured Library location"]').getBoundingClientRect().left > Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Set Library Location').getBoundingClientRect().right`,
                ),
            );
            await click("Delete Identity option cmsh");
            assert.ok(vocabulary.identity.includes("cmsh"), "Deletion is staged until Save");
            await js(
                `Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Cancel').click()`,
            );
            await wait(`!document.querySelector('dialog[open]')`);
            await click("Configuration");
            await wait(`!!document.querySelector('[aria-label="Delete Identity option cmsh"]')`);
            await click("Delete Identity option cmsh");
            await click("Delete Project option crystal-brigade");
            const organizationBeforeSave = collection.shots.map((shot) => structuredClone(shot.organization));
            failOptionsSave = true;
            await click("Save configuration");
            await wait(`document.querySelector('dialog [role="alert"]')?.textContent.includes('Could not save')`);
            assert.equal(
                await js(`!!document.querySelector('[aria-label="Delete Identity option cmsh"]')`),
                false,
                "Failure retains staged deletions",
            );
            await click("Save configuration");
            await wait(`!document.querySelector('dialog[open]')`);
            assert.equal(optionSaves, 1);
            assert.ok(!vocabulary.identity.includes("cmsh"));
            assert.ok(!vocabulary.project.includes("crystal-brigade"));
            assert.ok(vocabulary.tags.includes("topic-00"));
            assert.deepEqual(
                collection.shots.map((shot) => shot.organization),
                organizationBeforeSave,
                "Configuration never changes clip information",
            );
            await click("Configuration");
            await wait(`!!document.querySelector('[aria-label="Delete Identity option owmo"]')`);
            collection = {
                ...collection,
                revision: collection.revision + 1,
                shots: collection.shots.map((shot, index) =>
                    index < 2
                        ? {
                              ...shot,
                              organization: {
                                  ...shot.organization,
                                  identity: "owmo",
                                  tags: ["music", "studio"],
                                  notes: "Keep notes",
                              },
                          }
                        : shot,
                ),
            };
            const affectedBefore = structuredClone(collection.shots.map((shot) => shot.organization));
            await click("Delete Identity option owmo");
            await click("Save configuration");
            await wait(
                `document.querySelector('[role="alertdialog"]')?.textContent.includes('saved options and 2 clip drafts')`,
            );
            assert.equal(
                await js(`document.querySelectorAll('[aria-label="Clips affected by removal"] tbody tr').length`),
                2,
            );
            assert.ok(
                await js(
                    `document.querySelector('[aria-label="Clips affected by removal"]').textContent.includes('Identity: owmo')`,
                ),
            );
            assert.equal(await js(`document.querySelectorAll('[aria-label="Active clip"]').length`), 2);
            assert.equal(
                await js(`document.querySelector('#remove-options-title').textContent`),
                "Remove Saved Values?",
            );
            assert.ok(
                await js(
                    `(()=>{const cols=document.querySelectorAll('[aria-label="Clips affected by removal"] th');return cols[1].textContent==='Metadata to Remove'&&Math.abs(cols[0].getBoundingClientRect().width-cols[1].getBoundingClientRect().width)<1})()`,
                ),
            );
            await js(`document.querySelector('[role="alertdialog"] button').click()`);
            await wait(`!document.querySelector('[role="alertdialog"]')`);
            assert.deepEqual(
                collection.shots.map((shot) => shot.organization),
                affectedBefore,
                "Cancel preserves all assignments",
            );
            await wait(`!!document.querySelector('[aria-label="Delete Identity option owmo"]')`);
            assert.equal(
                await js(`document.querySelector('[aria-label="Save configuration"]').disabled`),
                true,
                "Cancel restores the list and clears staged changes",
            );
            await click("Delete Identity option owmo");
            await click("Save configuration");
            await wait(`!!document.querySelector('[aria-label="Clips affected by removal"]')`);
            if (process.env.SHOT_MANAGER_OPTIONS_SCREENSHOT)
                await writeFile(
                    process.env.SHOT_MANAGER_OPTIONS_SCREENSHOT,
                    (await window.webContents.capturePage()).toPNG(),
                );
            await click("Confirm remove saved values");
            await wait(`!document.querySelector('dialog[open]')`);
            assert.equal(collection.shots[0].organization.identity, null);
            assert.deepEqual(collection.shots[0].organization.tags, ["music", "studio"]);
            assert.equal(collection.shots[0].organization.notes, "Keep notes");
            assert.ok(!vocabulary.identity.includes("owmo"));
            await click("Configuration");
            await wait(`!!document.querySelector('[aria-label="Identity options"]')`);
            assert.equal(await js(`!!document.querySelector('[aria-label="Tags options"]')`), false);
            await wait(`document.querySelector('[aria-label="Cache summary"]')?.textContent.includes('6.8 KB used')`);
            assert.ok(await js(`document.querySelector('[aria-label="Cache summary"]').textContent.includes('Proxies: 4.0 KB')`));
            assert.ok(await js(`document.querySelector('#cache-summary-title + p + p').textContent.includes('90 days')`));
            if (process.env.SHOT_MANAGER_CONFIGURATION_SCREENSHOT) {
                await new Promise((resolve) => setTimeout(resolve, 150));
                await writeFile(
                    process.env.SHOT_MANAGER_CONFIGURATION_SCREENSHOT,
                    (await window.webContents.capturePage()).toPNG(),
                );
            }
            await js(
                `Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Set Library Location').click()`,
            );
            await wait(`!Array.from(document.querySelectorAll('dialog button')).some(b=>b.textContent==='Choosing…')`);
            assert.equal(configuration.libraryPath, null, "Cancel preserves configuration");
            cancelLibrary = false;
            await js(
                `Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Set Library Location').click()`,
            );
            await wait(
                `document.querySelector('[aria-label="Configured Library location"]').textContent==='/synthetic/library'`,
            );
            assert.equal(configuration.libraryPath, null, "Picker only stages the location");
            assert.equal(await js(`document.querySelector('[aria-label="Save configuration"]').disabled`), false);
            await click("Save configuration");
            await wait(`!document.querySelector('dialog[open]')`);
            await click("Configuration");
            await wait(`!!document.querySelector('dialog[open]')`);
            assert.equal(
                await js(`document.querySelector('[aria-label="Local Data usage"]')===null`),
                true,
                "No usage status beside Clear Cache",
            );
            await js(
                `Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Clear Cache').click()`,
            );
            await wait(`!!document.querySelector('[aria-label="Confirm clear cache"]')`);
            await js(`document.querySelector('[role="alertdialog"] button').click()`);
            await wait(`!document.querySelector('[role="alertdialog"]')`);
            assert.equal(resetCalls, 0, "Cancel preserves local records");
            await js(
                `Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Clear Cache').click()`,
            );
            await wait(`!!document.querySelector('[aria-label="Confirm clear cache"]')`);
            await js(
                `document.querySelector('[role="alertdialog"]').dispatchEvent(new Event('cancel',{bubbles:true,cancelable:true}))`,
            );
            await wait(`!document.querySelector('[role="alertdialog"]') && !!document.querySelector('dialog[open]')`);
            await js(
                `Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Clear Cache').click()`,
            );
            await wait(`!!document.querySelector('[aria-label="Confirm clear cache"]')`);
            await js(`document.querySelector('[aria-label="Keep proxies"]').click()`);
            failReset = true;
            await click("Confirm clear cache");
            await wait(`!!document.querySelector('[role="alertdialog"] [role="alert"]')`);
            await click("Confirm clear cache");
            await wait(`!document.querySelector('dialog[open]')`);
            assert.equal(resetCalls, 1);
            assert.deepEqual(lastClearSelection, {
                catalogue: true,
                metadata: true,
                thumbnails: true,
                fingerprints: true,
                proxies: false,
            });
            assert.equal(configuration.libraryPath, "/synthetic/library", "Clear Cache preserves Library setting");
            assert.equal(sources.length, 2, "Clear Cache preserves sources");
            await wait(`document.querySelector('[aria-label="Library location"]')?.textContent==='/synthetic/library'`);
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "]').length===6`);
            assert.equal(await js(`document.querySelector('button[aria-label="Reverse order"]')`), null);
            assert.equal(await js(`document.querySelector('main > section header')`), null);
            assert.ok(
                await js(`document.querySelector('footer').textContent.includes('6 clips total')`),
            );
            assert.equal(await js(`document.querySelectorAll('[data-shot-card] button[aria-label^="Inspect "]').length`), 6);
            assert.equal(await js(`document.querySelectorAll('button[aria-label^="Skip Clip "]').length`), 0);
            window.webContents.focus();
            await js(`document.querySelector('button[aria-label="Inspect Clip 1.mp4"]').focus()`);
            for (const modifiers of [[], ["shift"]]) {
                window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers });
                window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers });
                await new Promise((resolve) => setTimeout(resolve, 15));
                assert.equal(await js(`document.activeElement.getAttribute('aria-label')`), "Inspect Clip 1.mp4");
            }
            assert.equal(
                await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))`),
                false,
            );
            await js(`document.activeElement.blur()`);
            await inspect(1);
            assert.deepEqual(await selected(), [1]);
            await inspect(1);
            assert.deepEqual(await selected(), []);
            await inspect(1);
            await arrow("Left");
            assert.deepEqual(await selected(), [2]);
            await arrow("Right");
            assert.deepEqual(await selected(), [1]);
            await arrow("Right");
            assert.deepEqual(await selected(), [1]);
            await inspect(6);
            await arrow("Left");
            assert.deepEqual(await selected(), [6]);
            await inspect(5);
            await arrow("Down");
            assert.deepEqual(await selected(), [2]);
            await arrow("Up");
            assert.deepEqual(await selected(), [5]);
            await arrow("Up");
            assert.deepEqual(await selected(), [5]);
            window.setSize(1400, 1080);
            await wait(
                `document.querySelector('button[aria-label="Inspect Clip 4.mp4"]').getBoundingClientRect().top>document.querySelector('button[aria-label="Inspect Clip 5.mp4"]').getBoundingClientRect().top+8`,
            );
            await arrow("Down");
            assert.deepEqual(await selected(), [4]);
            await arrow("Up");
            assert.deepEqual(await selected(), [6]);
            window.setSize(1400, 560);
            await wait(`document.querySelector('[data-shot-scroll]').clientHeight<500`);
            await inspect(4);
            await arrow("Down");
            assert.deepEqual(await selected(), [3]);
            assert.ok(
                await js(
                    `(()=>{const viewport=document.querySelector('[data-shot-scroll]').getBoundingClientRect(),card=document.querySelector('button[aria-label="Inspect Clip 3.mp4"]').getBoundingClientRect();return card.top>=viewport.top+19&&card.bottom<=viewport.bottom-19})()`,
                ),
            );
            await arrow("Up");
            assert.deepEqual(await selected(), [4]);
            await arrow("Up");
            assert.deepEqual(await selected(), [6]);
            assert.ok(
                await js(
                    `(()=>{const card=document.querySelector('button[aria-label="Inspect Clip 6.mp4"]'),heading=card.closest('[data-shot-day]').querySelector('h3').getBoundingClientRect(),viewport=document.querySelector('[data-shot-scroll]').getBoundingClientRect();return heading.top>=viewport.top+19&&card.getBoundingClientRect().bottom<=viewport.bottom-19})()`,
                ),
            );
            await js(
                `(()=>{const viewport=document.querySelector('[data-shot-scroll]');viewport.scrollTop=viewport.scrollHeight})()`,
            );
            assert.ok(
                await js(
                    `(()=>{const viewport=document.querySelector('[data-shot-scroll]'),cards=document.querySelectorAll('[data-shot-card] > button'),last=cards[cards.length-1].getBoundingClientRect();return viewport.scrollHeight>viewport.clientHeight&&viewport.getBoundingClientRect().bottom-last.bottom>=39})()`,
                ),
                "Last card should have visible bottom padding when fully scrolled",
            );
            window.setSize(1800, 1080);
            await wait(
                `Math.abs(document.querySelector('button[aria-label="Inspect Clip 4.mp4"]').getBoundingClientRect().top-document.querySelector('button[aria-label="Inspect Clip 5.mp4"]').getBoundingClientRect().top)<8`,
            );
            await inspect(1);
            await js(`document.querySelector('button[aria-label="Inspect Clip 1.mp4"]').focus()`);
            window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
            window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "][aria-pressed="true"]').length===0`);
            assert.equal(await js(`document.activeElement?.getAttribute('aria-label')==='Inspect Clip 1.mp4'`), false);
            await inspect(1);
            assert.equal(
                await js(`!!document.querySelector('#clip-inspector header input[aria-label="Skip selected clips"]')`),
                true,
            );
            assert.equal(
                await js(
                    `document.querySelector('#clip-inspector header input[aria-label="Skip selected clips"]').closest('label').textContent.trim()`,
                ),
                "",
            );
            assert.equal(
                await js(
                    `document.querySelector('#clip-inspector header input[aria-label="Skip selected clips"]').closest('label').offsetHeight`,
                ),
                28,
            );
            await inspect(2, { metaKey: true });
            assert.deepEqual(await selected(), [1, 2]);
            assert.equal(await js(`document.querySelector('#clip-inspector h2').textContent`), "2 Selected Clips");
            assert.equal(await js(`document.querySelector('#clip-inspector video')`), null);
            assert.deepEqual(
                await js(
                    `Array.from(document.querySelectorAll('ul[aria-label="Selected clips"] li')).map(item=>item.textContent)`,
                ),
                ["Clip 2.mp4", "Clip 1.mp4"],
            );
            assert.equal(
                await js(`document.querySelector('ul[aria-label="Selected clips"] li').title`),
                "/synthetic/A/2.mp4",
            );
            assert.equal(
                await js(
                    `Array.from(document.querySelectorAll('#clip-inspector button')).some(b=>b.textContent==='Clear selection')`,
                ),
                false,
            );
            await inspect(1, { ctrlKey: true });
            assert.deepEqual(await selected(), [2]);
            await inspect(3, { metaKey: true });
            await arrow("Left");
            assert.deepEqual(await selected(), [4]);
            await inspect(2);
            await inspect(3, { metaKey: true });
            await check(1);
            await check(2);
            assert.deepEqual(await selected(), [2, 3]);
            assert.deepEqual(await skipped(), [1, 2]);
            await wait(
                `getComputedStyle(document.querySelector('button[aria-label="Inspect Clip 1.mp4"] [data-shot-preview]')).opacity==='0.15'`,
            );
            assert.equal(
                await js(`getComputedStyle(document.querySelector('button[aria-label="Inspect Clip 1.mp4"]')).opacity`),
                "1",
            );
            assert.equal(await js(`document.querySelector('button[aria-label="Inspect Clip 1.mp4"]').disabled`), false);
            assert.equal(await js(`document.querySelectorAll('button[aria-label^="Skip Clip "]').length`), 0);
            assert.ok(
                await js(`document.querySelector('footer').textContent.includes('2 clips selected (1 skipped)')`),
            );

            assert.equal(
                await js(`document.querySelector('input[aria-label="Skip selected clips"]').indeterminate`),
                true,
            );
            if (process.env.SHOT_MANAGER_SELECTION_SCREENSHOT) {
                await new Promise((resolve) => setTimeout(resolve, 350));
                await writeFile(
                    process.env.SHOT_MANAGER_SELECTION_SCREENSHOT,
                    (await window.webContents.capturePage()).toPNG(),
                );
            }
            await click("Skip selected clips");
            assert.deepEqual(await skipped(), [1]);
            await js(`document.querySelector('input[aria-label="Skip selected clips"]').focus()`);
            await arrow("Left");
            assert.deepEqual(await selected(), [2, 3]);
            await arrow("Down");
            assert.deepEqual(await selected(), [2, 3]);
            await js(`document.activeElement.blur()`);
            await click("Skip selected clips");
            assert.deepEqual(await skipped(), [1, 2, 3]);
            await click("Skip selected clips");
            assert.deepEqual(await skipped(), [1]);
            await js(`document.querySelector('main > section').click()`);
            assert.deepEqual(await selected(), []);
            assert.deepEqual(await skipped(), [1]);
            await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "][aria-pressed="true"]').length===0`);
            assert.deepEqual(await skipped(), [1]);
            await inspect(2);
            await arrow("Right");
            assert.deepEqual(await selected(), [1]);
            assert.deepEqual(await skipped(), [1]);
            await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
            await inspect(2);
            await inspect(5, { shiftKey: true });
            assert.deepEqual(await selected(), [2, 3, 4, 5]);
            await inspect(6, { shiftKey: true, metaKey: true });
            assert.deepEqual(await selected(), [2, 3, 4, 5, 6]);
            await inspect(6);
            assert.deepEqual(await selected(), [6]);
            await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "][aria-pressed="true"]').length===0`);
            assert.deepEqual(await skipped(), [1]);
            await inspect(1);
            await click("Filter clips by device: Sony ZV-E10 II");
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "]').length===3`);
            assert.deepEqual(await selected(), []);
            assert.equal(await js(`document.querySelector('[aria-label="Clip selection summary"]').textContent.trim()`),'3 clips total','Commit excludes hidden selections and hidden skipped clips');
            await inspect(5);
            await arrow("Down");
            assert.deepEqual(await selected(), [5]);
            await arrow("Right");
            assert.deepEqual(await selected(), [4]);
            await arrow("Right");
            assert.deepEqual(await selected(), [4]);
            await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
            await click("Filter clips by device: Sony ZV-E10 II");
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "]').length===6`);
            assert.deepEqual(await skipped(), [1]);
            await push(
                collection.shots.map((shot) => (shot.filename === "Clip 2.mp4" ? { ...shot, editable: false } : shot)),
            );
            await inspect(3);
            await arrow("Right");
            assert.deepEqual(await selected(), [1]);
            await inspect(5);
            await arrow("Down");
            assert.deepEqual(await selected(), [3]);
            await push(collection.shots.map((shot) => ({ ...shot, editable: true })));
            await inspect(5);
            await arrow("Left");
            assert.deepEqual(await selected(), [6]);
            await arrow("Right");
            assert.deepEqual(await selected(), [5]);
            await arrow("Down");
            assert.deepEqual(await selected(), [2]);
            await arrow("Up");
            assert.deepEqual(await selected(), [5]);
            await inspect(2, { shiftKey: true });
            assert.deepEqual(await selected(), [2, 3, 4, 5]);
            await inspect(1);
            await push(
                collection.shots.map((shot) =>
                    shot.filename === "Clip 1.mp4" ? { ...shot, available: false, editable: true } : shot,
                ),
            );
            assert.equal(await js(`document.querySelector('button[aria-label="Inspect Clip 1.mp4"]').disabled`), false);
            assert.equal(await js(`document.querySelector('input[aria-label="Skip selected clips"]').disabled`), false);
            assert.deepEqual(await skipped(), [1]);
            assert.ok(
                await js(
                    `Array.from(document.querySelectorAll('#clip-inspector [role="status"]')).some(el=>el.textContent.trim()==='source unavailable')`,
                ),
            );
            assert.equal(
                await js(`document.querySelector('button[aria-label="Set current frame as thumbnail"]').disabled`),
                true,
            );
            await inspect(1);
            await inspect(1);
            assert.deepEqual(await selected(), [1]);
            await click("Skip selected clips");
            assert.deepEqual(await skipped(), []);
            await click("Skip selected clips");
            assert.deepEqual(await skipped(), [1]);
            await arrow("Left");
            assert.deepEqual(await selected(), [2]);
            await arrow("Right");
            assert.deepEqual(await selected(), [1]);
            await push(collection.shots.map((shot) => ({ ...shot, available: true, editable: true })));
            await push(
                collection.shots.map((shot) => (shot.filename === "Clip 1.mp4" ? { ...shot, editable: false } : shot)),
            );
            assert.equal(await js(`document.querySelector('button[aria-label="Inspect Clip 1.mp4"]').disabled`), false, 'Locked metadata does not block selecting a clip for Eject');
            await push(collection.shots.map((shot) => ({ ...shot, editable: true })));
            assert.deepEqual(await skipped(), [1]);
            await push(collection.shots.filter((shot) => shot.filename !== "Clip 1.mp4"));
            await wait(`document.querySelector('[aria-label="Clip selection summary"]').textContent.trim()==='5 clips total'`);
            assert.deepEqual(await selected(), []);
            await inspect(2);
            await check(2);
            await inspect(3, {metaKey:true});
            await click("Eject selected clips");
            await wait(`!!document.querySelector('#eject-title')`);
            assert.equal(collection.shots.length,5,'Eject makes no changes before confirmation');
            assert.equal(await js(`document.querySelector('dialog p').textContent`),'Remove these clips from the workspace.');
            assert.equal(await js(`document.querySelectorAll('dialog ul[aria-label="Affected clips"] li').length`),2);
            await js(`document.querySelector('dialog[open]').dispatchEvent(new Event('cancel',{bubbles:true,cancelable:true}))`);
            await wait(`!document.querySelector('#eject-title')`);
            assert.deepEqual(await selected(),[2,3],'Dismissed Eject preserves selection');
            await click("Eject selected clips");
            await wait(`!!document.querySelector('#eject-title')`);
            await click("Confirm eject clips");
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "]').length===3`);
            await wait(`document.querySelector('[aria-label="Clip selection summary"]').textContent.trim()==='3 clips total'`);
            assert.deepEqual(await selected(), []);
            assert.equal(
                await js(
                    `Array.from(document.querySelectorAll('footer button')).find(b=>b.textContent==='Commit').disabled`,
                ),
                true,
            );
            Object.assign(vocabulary, {
                identity: ["cmsh", "owmo"],
                project: ["crystal-brigade"],
                tags: [
                    "music",
                    "music/edm",
                    "music/rock",
                    "studio",
                    ...Array.from({ length: 20 }, (_, i) => `topic-${String(i).padStart(2, "0")}`),
                ],
            });
            await push(
                collection.shots.map((shot) =>
                    shot.filename === "Clip 6.mp4"
                        ? { ...shot, organization: { ...shot.organization, tags: [...vocabulary.tags] } }
                        : shot,
                ),
            );
            const fill = async (label, value) => {
                const field = ["Project", "Identity"].includes(label) ? label : null;
                if (field && !(await js(`!!document.querySelector('input[aria-label=${JSON.stringify(label)}]')`)))
                    await click(`${field} selection`);
                await js(
                    `(()=>{const input=document.querySelector('[aria-label=${JSON.stringify(label)}]');input.focus();const prototype=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
                );
                await new Promise((resolve) => setTimeout(resolve, 10));
            };
            const tag = async (label, value, key = " ") => {
                if (label !== "Tags" && key === " ") key = "Enter";
                await fill(label, value);
                await js(
                    `document.querySelector('[aria-label=${JSON.stringify(label)}]').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}))`,
                );
                await wait(
                    `!Array.from(document.querySelectorAll('#clip-inspector [role="status"]')).some(node=>node.textContent==='Saving…')`,
                );
            };
            await inspect(4);
            await wait(`!document.querySelector('button[aria-label="Project selection"]').disabled`);
            assert.deepEqual(
                await js(
                    `Array.from(document.querySelectorAll('#clip-inspector [data-attribute-field]')).map(node=>node.dataset.attributeField)`,
                ),
                ["identity", "project", "scene", "group", "camera", "rating", "notes", "tags"],
            );
            await fill("Scene", "Walking home, before sunset.");
            await wait(
                `!Array.from(document.querySelectorAll('#clip-inspector [role="status"]')).some(node=>node.textContent==='Saving…')`,
            );
            assert.equal(
                collection.shots.find((shot) => shot.filename === "Clip 4.mp4").organization.scene,
                "Walking home, before sunset.",
            );
            assert.equal(await js(`document.querySelector('[aria-label="Scene"]').maxLength`), 80);
            await fill("Scene", "bad/path");
            assert.equal(
                await js(`document.querySelector('[aria-label="Scene"]').value`),
                "Walking home, before sunset.",
                "Unsupported filename characters are rejected without changing the saved Scene",
            );
            assert.equal(
                await js(`document.querySelector('[aria-label="Scene"]').getAttribute('aria-invalid')`),
                "true",
            );
            await fill("Scene", "Walking home, before sunset.");
            await js(`document.querySelector('[aria-label="Notes"]').focus()`);
            const checkAttributeFit = async () => {
                const fit = await js(
                    `(()=>{const panel=document.querySelector('#clip-inspector-content');const bounds=panel.getBoundingClientRect();return {panelHeight:panel.clientHeight,scrollHeight:panel.scrollHeight,fields:['Scene','Notes','Tags','Clear selected clip information'].map(label=>{const element=document.querySelector('[aria-label="'+label+'"]');const rect=element.getBoundingClientRect();return {label,top:rect.top,bottom:rect.bottom,visible:rect.top>=bounds.top&&rect.bottom<=bounds.bottom};})};})()`,
                );
                assert.ok(
                    fit.fields.every((field) => field.visible) && fit.scrollHeight <= fit.panelHeight + 1,
                    `All attributes fit at the default window size: ${JSON.stringify(fit)}`,
                );
                if (process.env.SHOT_MANAGER_SCENE_SCREENSHOT)
                    await writeFile(
                        process.env.SHOT_MANAGER_SCENE_SCREENSHOT,
                        (await window.webContents.capturePage()).toPNG(),
                    );
            };
            await checkAttributeFit();

            const initialPreview = await js(`(() => { const image=document.querySelector('#clip-inspector .preview-image').getBoundingClientRect(); return {width:image.width,height:image.height}; })()`);
            await js(`document.querySelector('[aria-label="Resize clip inspector"]').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))`);
            await wait(`document.querySelector('#clip-inspector .preview-image').getBoundingClientRect().height>${initialPreview.height + 100}`);
            assert.ok(await js(`document.querySelector('#clip-inspector .preview-image').getBoundingClientRect().width>${initialPreview.width + 100}`), "Expanding the inspector enlarges the video image in both dimensions");
            await js(`document.querySelector('[aria-label="Resize clip inspector"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}))`);
            await wait(`Math.abs(document.querySelector('#clip-inspector .preview-image').getBoundingClientRect().width-${initialPreview.width})<1`);
            await js(`document.querySelector('#clip-inspector-content').scrollTop=0`);
            await checkAttributeFit();

            await click("Project selection");
            await wait(`!!document.querySelector('[role="listbox"][aria-label="Project suggestions"]')`);
            assert.ok(
                await js(
                    `document.querySelector('[role="listbox"][aria-label="Project suggestions"]').textContent.includes('crystal-brigade')`,
                ),
            );
            if (process.env.SHOT_MANAGER_DROPDOWN_SCREENSHOT)
                await writeFile(
                    process.env.SHOT_MANAGER_DROPDOWN_SCREENSHOT,
                    (await window.webContents.capturePage()).toPNG(),
                );
            assert.ok(
                await js(`document.querySelector('[role="tab"][aria-selected="true"]').textContent==='Attributes'`),
            );
            await fill("Project", "Alpha Project");
            assert.equal(await js(`document.querySelector('input[aria-label="Project"]').value`), "Alpha Project");
            await js(
                `document.querySelector('input[aria-label="Project"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`,
            );
            await wait(`!!document.querySelector('[data-field="project"][data-tag="Alpha Project"]')`);
            assert.equal(await js(`document.querySelector('[data-tag="Alpha Project"]').getAttribute('style')`), null);
            failOrganizationSave = true;
            await tag("Project", "retry-me");
            await wait(`!!document.querySelector('[aria-label="Retry organization save"]')`);
            assert.equal(await js(`document.querySelector('[data-tag="retry-me"]')`), null);
            await click("Retry organization save");
            await wait(`!!document.querySelector('[data-tag="retry-me"]')`);
            await click("Clear Project");
            await wait(`!document.querySelector('[data-tag="retry-me"]')`);
            await tag("Project", "Alpha Project");
            await tag("Identity", "OWMO");
            await tag("Identity", "CMSH");
            assert.equal(collection.shots.find((shot) => shot.filename === "Clip 4.mp4").organization.identity, "cmsh");
            await fill("Tags", "topic-1");
            await js(
                `document.querySelector('[aria-label="Tags"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))`,
            );
            const highlighted = await js(
                `document.getElementById(document.querySelector('[aria-label="Tags"]').getAttribute('aria-activedescendant')).textContent.trim()`,
            );
            assert.equal(highlighted, "topic-11");
            await js(
                `document.querySelector('[aria-label="Tags"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`,
            );
            await wait(`!!document.querySelector('[data-field="tags"][data-tag="topic-11"]')`);
            assert.ok(
                !collection.shots.find((shot) => shot.filename === "Clip 4.mp4").organization.tags.includes("topic-1"),
                "Enter adds the highlighted suggestion rather than the typed prefix",
            );
            await click("Remove tag topic-11");
            await tag("Tags", "music/r", "Tab");
            await wait(`!!document.querySelector('[data-field="tags"][data-tag="music/rock"]')`);
            assert.equal(await js(`document.activeElement.getAttribute('aria-label')`), "Tags");
            await tag("Tags", "backspace-test");
            const tagKey = async (key, repeat = false) =>
                js(
                    `document.querySelector('[aria-label="Tags"]').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},repeat:${repeat},bubbles:true,cancelable:true}))`,
                );
            await tagKey("Backspace");
            await wait(
                `document.querySelector('[data-tag="backspace-test"]')?.getAttribute('data-tag-selected')==='true'`,
            );
            assert.ok(
                collection.shots
                    .find((shot) => shot.filename === "Clip 4.mp4")
                    .organization.tags.includes("backspace-test"),
                "First Backspace selects without removing",
            );
            await tagKey("Backspace", true);
            assert.ok(
                collection.shots
                    .find((shot) => shot.filename === "Clip 4.mp4")
                    .organization.tags.includes("backspace-test"),
                "Holding Backspace cannot skip the second deliberate press",
            );
            await tagKey("Escape");
            assert.equal(
                await js(`document.querySelectorAll('[data-tag-selected="true"]').length`),
                0,
                "Escape clears tag selection",
            );
            assert.equal(await js(`document.activeElement.getAttribute('aria-label')`), "Tags");
            await tagKey("Backspace");
            await click("Tags");
            assert.equal(
                await js(`document.querySelectorAll('[data-tag-selected="true"]').length`),
                0,
                "Clicking the field restores typing",
            );
            await tagKey("Backspace");
            await fill("Tags", "typing");
            assert.equal(
                await js(`document.querySelectorAll('[data-tag-selected="true"]').length`),
                0,
                "Typing cancels tag selection",
            );
            await tagKey("Backspace");
            assert.ok(
                collection.shots
                    .find((shot) => shot.filename === "Clip 4.mp4")
                    .organization.tags.includes("backspace-test"),
                "Backspace in nonempty text does not remove a tag",
            );
            await fill("Tags", "");
            await tagKey("Backspace");
            await tagKey("Backspace");
            await wait(`!document.querySelector('[data-tag="backspace-test"]')`);
            assert.ok(
                !collection.shots
                    .find((shot) => shot.filename === "Clip 4.mp4")
                    .organization.tags.includes("backspace-test"),
                "Second Backspace saves removal",
            );

            await tag("Tags", "music//bad", "Enter");
            assert.ok(
                await js(
                    `Array.from(document.querySelectorAll('[role="alert"]')).some(node=>node.textContent.includes('64 lowercase'))`,
                ),
            );
            await fill("Tags", "");
            await fill("Notes", "Review the final take");
            await wait(
                `document.querySelector('[aria-label="Notes"]').value==='Review the final take'&&!Array.from(document.querySelectorAll('[role="status"]')).some(node=>node.textContent==='Saving…')`,
            );
            assert.equal(
                collection.shots.find((shot) => shot.filename === "Clip 4.mp4").organization.notes,
                "Review the final take",
            );
            assert.equal(await js(`document.querySelector('[aria-label="Notes"]').rows`), 2);
            await fill("Notes", "First line\nSecond line\nThird line\nFourth line");
            await wait(
                `!Array.from(document.querySelectorAll('#clip-inspector [role="status"]')).some(node=>node.textContent==='Saving…')`,
            );
            assert.equal(
                collection.shots.find((shot) => shot.filename === "Clip 4.mp4").organization.notes,
                "First line\nSecond line\nThird line\nFourth line",
                "Notes preserves multiple lines",
            );
            await fill("Notes", "Review the final take");

            await inspect(5);
            await tag("Project", "beta");
            await inspect(4, { metaKey: true });
            await wait(`document.querySelectorAll('[data-field="project"][data-shared="false"]').length===2`);

            assert.ok(await js(`document.querySelector('[data-tag="Alpha Project"]').textContent.includes('1/2')`));
            await tag("Project", "shared");
            await wait(`!!document.querySelector('[data-tag="shared"][data-shared="true"]')`);
            assert.deepEqual(
                collection.shots.find((shot) => shot.filename === "Clip 4.mp4").organization.project,
                "shared",
            );
            assert.deepEqual(
                collection.shots.find((shot) => shot.filename === "Clip 5.mp4").organization.project,
                "shared",
            );
            assert.equal(await js(`document.querySelector('[data-tag="Alpha Project"]')`), null);
            assert.ok(vocabulary.project.includes("Alpha Project"));
            await tag("Identity", "owmo");
            assert.ok(
                collection.shots
                    .filter((shot) => ["Clip 4.mp4", "Clip 5.mp4"].includes(shot.filename))
                    .every((shot) => shot.organization.identity === "owmo"),
            );
            await tag("Tags", "studio");
            await wait(`!!document.querySelector('[data-tag="studio"][data-shared="true"]')`);
            await fill("Tags", "");
            assert.equal(
                await js(`!!document.querySelector('[aria-label="Tag suggestions"]')`),
                false,
                "Empty focused tag input has no dropdown",
            );
            await fill("Tags", "t");
            await wait(`!!document.querySelector('[aria-label="Tag suggestions"]')`);
            assert.ok(
                await js(
                    `Array.from(document.querySelectorAll('[aria-label="Tag suggestions"] [role="option"]')).every(node=>node.textContent.startsWith('topic-')||node.textContent.startsWith('Add'))`,
                ),
                "First character filters suggestions",
            );
            assert.ok(
                await js(
                    `(()=>{const list=document.querySelector('[aria-label="Tag suggestions"]');return list.scrollHeight>list.clientHeight&&getComputedStyle(list).overflowY==='auto'})()`,
                ),
            );
            await js(
                `Array.from(document.querySelectorAll('[aria-label="Tag suggestions"] button')).find(b=>b.textContent.includes('topic-19')).click()`,
            );
            await wait(`!!document.querySelector('[data-tag="topic-19"]')`);
            assert.equal(
                await js(`!!document.querySelector('[aria-label="Tag suggestions"]')`),
                false,
                "Adding a tag closes suggestions",
            );
            await tag("Tags", "z-last");
            await tag("Tags", "a-after");
            assert.deepEqual(
                await js(
                    `Array.from(document.querySelectorAll('[data-field="tags"]')).map(node=>node.dataset.tag).filter(tag=>['z-last','a-after'].includes(tag))`,
                ),
                ["z-last", "a-after"],
                "Tags retain insertion order rather than sorting",
            );
            if (process.env.SHOT_MANAGER_ORGANIZATION_SCREENSHOT) {
                await writeFile(
                    process.env.SHOT_MANAGER_ORGANIZATION_SCREENSHOT,
                    (await window.webContents.capturePage()).toPNG(),
                );
            }
            await checkAttributeFit();
            await click("Remove tag music/rock");
            await wait(`!document.querySelector('[data-tag="music/rock"]')`);
            assert.ok(vocabulary.tags.includes("music/rock"));
            await fill("Scene", "Friends arriving at the studio.");
            await js(`document.activeElement?.blur()`);
            await push(collection.shots.map(shot=>['Clip 4.mp4','Clip 5.mp4'].includes(shot.filename)?{...shot,organization:{...shot.organization,group:shot.filename==='Clip 4.mp4'?'TH01':'TH02',camera:shot.filename==='Clip 4.mp4'?'A':'B',rating:shot.filename==='Clip 4.mp4'?'preferred':'usable'}}:shot));
            await wait(`document.querySelector('[aria-label="Group"]').placeholder==='Mixed'&&document.querySelector('[aria-label="Camera"]').placeholder==='Mixed'&&document.querySelector('[aria-label="Quality"]').value==='mixed'`);
            await fill('Group','TH01-T02');await fill('Camera','B');
            await js(`(()=>{const el=document.querySelector('[aria-label="Quality"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,'usable');el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
            await fill("Notes", "Shared notes");
            await wait(
                `!Array.from(document.querySelectorAll('[role="status"]')).some(node=>node.textContent==='Saving…')`,
            );
            assert.ok(
                collection.shots
                    .filter((shot) => ["Clip 4.mp4", "Clip 5.mp4"].includes(shot.filename))
                    .every((shot) => shot.organization.notes === "Shared notes"),
            );
            assert.ok(collection.shots.filter(shot=>['Clip 4.mp4','Clip 5.mp4'].includes(shot.filename)).every(shot=>shot.organization.group==='TH01-T02'&&shot.organization.camera==='B'&&shot.organization.rating==='usable'),'Grouping edits apply to the full selection');
            await js(
                `window.desktop.updateOrganization(${JSON.stringify(collection.shots.filter((shot) => ["Clip 4.mp4", "Clip 5.mp4"].includes(shot.filename)).map((shot) => shot.id))},{field:'skip',operation:'set',value:'true'})`,
            );
            await new Promise((resolve) => {
                window.webContents.once("did-finish-load", resolve);
                window.webContents.reload();
            });
            await wait(`document.querySelectorAll('button[aria-label^="Inspect "]').length===3`);
            await inspect(4);
            await wait(`!!document.querySelector('[data-tag="shared"]')`);
            assert.equal(await js(`document.querySelector('[aria-label="Notes"]').value`), "Shared notes");
            assert.equal(
                await js(`document.querySelector('[aria-label="Scene"]').value`),
                "Friends arriving at the studio.",
                "Scene restores after selection changes and renderer reload",
            );
            assert.deepEqual(await skipped(), [4, 5], "Saved Skip restores after renderer reload");
            assert.equal(await js(`(() => { const card=document.querySelector('button[aria-label="Inspect Clip 4.mp4"]'); return card.classList.contains('bg-black/40') && card.querySelector('[data-shot-preview]').classList.contains('opacity-15') && card.getAttribute('data-editable')==='true'; })()`), true, "Skipped cards are very dark and remain editable");
            assert.equal(await js(`!!document.querySelector('[data-skipped="true"] [data-media-readiness]')`), false, 'Skipped clips hide the readiness indicator');
            failOrganizationSave = true;
            await click("Skip selected clips");
            await wait(`document.querySelector('#source-error-title')?.textContent==='Skip could not be saved'`);
            assert.deepEqual(await skipped(), [4, 5], "A failed Skip save preserves the stored and displayed choices");
            await js(
                `Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent==='Dismiss').click()`,
            );
            await wait(`!document.querySelector('#source-error-title')`);

            const beforeClipClear = structuredClone(
                collection.shots.find((shot) => shot.filename === "Clip 4.mp4").organization,
            );
            await click("Clear selected clip information");
            await wait(`!!document.querySelector('#clear-organization-title')`);
            await js(
                `Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent==='Cancel').click()`,
            );
            await wait(`!document.querySelector('#clear-organization-title')`);
            assert.deepEqual(
                collection.shots.find((shot) => shot.filename === "Clip 4.mp4").organization,
                beforeClipClear,
            );
            await inspect(5, { metaKey: true });
            assert.ok(
                await js(
                    `(()=>{const button=document.querySelector('[aria-label="Clear selected clip information"]'),viewport=document.querySelector('#clip-inspector-content'),bounds=button.getBoundingClientRect(),panel=viewport.getBoundingClientRect();return !!button.closest('[role="tabpanel"]')&&!button.closest('header')&&Math.abs(bounds.left-(panel.left+16))<25&&Math.abs(bounds.bottom-(panel.bottom-16))<3})()`,
                ),
                "Clear stays at the bottom left of the Attributes panel",
            );
            await click("Clear selected clip information");
            await wait(
                `document.querySelector('#clear-organization-description').textContent.includes('2 selected clips')`,
            );
            assert.equal(
                await js(`document.querySelector('#clear-organization-description').textContent.trim()`),
                "Clear all assigned attributes for 2 selected clips.",
            );
            assert.equal(
                await js(
                    `document.querySelector('#clear-organization-description').nextElementSibling?.textContent.includes('thumbnail')??false`,
                ),
                false,
            );
            if (process.env.SHOT_MANAGER_CLEAR_SCREENSHOT) {
                await new Promise(resolve=>setTimeout(resolve,150));
                await writeFile(
                    process.env.SHOT_MANAGER_CLEAR_SCREENSHOT,
                    (await window.webContents.capturePage()).toPNG(),
                );
            }
            await click("Confirm clear clip information");
            await wait(`!document.querySelector('#clear-organization-title')`);
            await wait(
                `document.querySelectorAll('#clip-inspector [data-tag]').length===0&&document.querySelector('[aria-label="Notes"]').value===''`,
            );
            assert.equal(await js(`document.querySelectorAll('[data-shot-card]').length`), 3);
            assert.deepEqual(await selected(), [4, 5]);
            assert.ok(vocabulary.tags.includes("studio"), "Clip Clear preserves available options");
            for (const shot of collection.shots.filter((shot) => ["Clip 4.mp4", "Clip 5.mp4"].includes(shot.filename)))
                assert.deepEqual(shot.organization, {
                    identity: null,
                    project: null,
                    scene: "",
                    group: '',
                    camera: '',
                    rating: null,
                    tags: [],
                    notes: "",
                    skipped: true,
                });
            assert.equal(await js(`document.querySelectorAll('[data-shot-card] button[aria-label^="Eject "], [data-shot-card] button[aria-label^="Stop "]').length`),0,'Eject and Stop are inspector-only actions');
            // Stop leaves cards selected and editable; Eject is a separate control.
            const readyCards=structuredClone(collection.shots);
            await push(collection.shots.map(shot=>({...shot,editable:false,ingestState:shot.filename==='Clip 4.mp4'?'queued':'processing'})));
            await inspect(4); await inspect(5,{metaKey:true});
            assert.ok(await js(`document.querySelector('[aria-label="Eject selected clips"]').disabled`),'Eject is disabled while selected clips are committing');
            assert.equal(await js(`Array.from(document.querySelectorAll('[aria-pressed="true"].ingest-card-busy')).every(card=>getComputedStyle(card).boxShadow.includes('2px'))`),true,'Queued and active selection has a clear outline');
            await click("Stop selected clips");
            await wait(`!!document.querySelector('#stop-title')`);
            assert.equal(await js(`document.querySelector('#stop-title').textContent`),'Stop Commit?');
            assert.equal(await js(`document.querySelectorAll('dialog ul[aria-label="Affected clips"] li').length`),2);
            assert.ok(collection.shots.filter(shot=>['Clip 4.mp4','Clip 5.mp4'].includes(shot.filename)).every(shot=>!shot.editable),'Stop awaits confirmation');
            await js(`Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent==='Cancel').click()`);
            await wait(`!document.querySelector('#stop-title')`);
            await click("Stop selected clips");
            await wait(`!!document.querySelector('#stop-title')`);
            await click("Confirm stop clips");
            await wait(`!!document.querySelector('button[aria-label="Eject selected clips"]:enabled')`);
            assert.equal(collection.shots.length,3,'Cancel preserves workspace membership');
            assert.deepEqual(await selected(),[4,5],'Cancel preserves selection');
            assert.ok(collection.shots.filter(shot=>['Clip 4.mp4','Clip 5.mp4'].includes(shot.filename)).every(shot=>shot.editable));
            await inspect(6);
            await click("Stop selected clip");
            await wait(`!!document.querySelector('#stop-title')`);
            await click("Confirm stop clips");
            await wait(`!!document.querySelector('button[aria-label="Eject selected clip"]')`);
            assert.equal(collection.shots.length,3,'Inspector Stop also preserves membership');
            await push(collection.shots.map(shot=>shot.filename==='Clip 6.mp4'?{...shot,editable:false,ingestState:'queued'}:shot));
            await inspect(4); await inspect(5,{metaKey:true}); await inspect(6,{metaKey:true});
            await click("Stop selected clip");
            await wait(`!!document.querySelector('#stop-title')`);
            assert.equal(await js(`document.querySelectorAll('dialog ul[aria-label="Affected clips"] li').length`),1,'Mixed Stop lists only the queued clip');
            // Completion during review cannot turn Stop into Eject.
            await push(collection.shots.map(shot=>({...shot,editable:true,ingestState:undefined})));
            await click("Confirm stop clips");
            await wait(`!!document.querySelector('button[aria-label="Eject selected clips"]')`);
            assert.equal(collection.shots.length,3,'Mixed selection Cancel never ejects already editable clips');
            assert.deepEqual(await selected(),[4,5,6]);
            await inspect(6);
            await wait(`!!document.querySelector('button[aria-label="Eject selected clip"]')`);
            await click("Eject selected clip");
            await wait(`!!document.querySelector('#eject-title')`);
            await js(`Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent==='Cancel').click()`);
            assert.equal(collection.shots.length,3,'Cancel button preserves the card');
            await wait(`!document.querySelector('#eject-title')`);
            await wait(`!!document.querySelector('button[aria-label="Eject selected clip"]')`);
            await click("Eject selected clip");
            await wait(`!!document.querySelector('#eject-title')`);
            await click("Confirm eject clips");
            await wait(`document.querySelectorAll('[data-shot-card]').length===2`);
            await push(readyCards);
            collection={...collection,directories:[{path:'/synthetic/B',clipIds:collection.shots.map(shot=>shot.id),available:false,outage:1}]};
            await push(collection.shots.map(shot=>({...shot,available:false,editable:true})));
            await wait(`!!document.querySelector('#unavailable-directory-title')`);
            assert.equal(await js(`document.querySelectorAll('dialog[open]').length`),1,'One consolidated directory warning');
            assert.ok(await js(`document.querySelector('dialog[open]').textContent.includes('3 clips are affected')`));
            await js(`Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent==='Dismiss').click()`);
            await push(collection.shots);
            assert.equal(await js(`!!document.querySelector('#unavailable-directory-title')`),false,'Polling the same outage does not repeat its warning');
            collection={...collection,directories:collection.directories.map(directory=>({...directory,available:true}))};
            await push(collection.shots.map(shot=>({...shot,available:true})));
            collection={...collection,directories:collection.directories.map(directory=>({...directory,available:false,outage:2}))};
            await push(collection.shots.map(shot=>({...shot,available:false})));
            await wait(`!!document.querySelector('#unavailable-directory-title')`);
            await js(`Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent==='Eject affected clips').click()`);
            await wait(`!!document.querySelector('#eject-title')`);
            await click("Confirm eject clips");
            await wait(`document.querySelectorAll('[data-shot-card]').length===0`);
            assert.equal(ejectedSelections.at(-1).length,3,'Eject affected clips removes exactly the directory members');
            console.log(
                "PASS: four-arrow navigation, responsive Up/Down rows and partial rows, date/filter/sort boundaries, locked-clip skipping, multi-selection, input guards, editing/skip selections, bulk skip, background deselection, blocked Tab, Escape, inspector-only single/bulk Eject, two-stage Cancel/Eject, directory outage warnings, and disabled processing.",
            );
            window.destroy();
            await rm(root, { recursive: true, force: true });
            clearTimeout(timer);
            app.exit(0);
        } catch (error) {
            console.error(error);
            window?.destroy();
            if (root) await rm(root, { recursive: true, force: true });
            clearTimeout(timer);
            app.exit(1);
        }
    });
}
