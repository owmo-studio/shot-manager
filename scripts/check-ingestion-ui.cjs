// Real Electron/preload/backend integration with an isolated profile and dummy Library.
const fs = require('node:fs');
const { join } = require('node:path');
if (!process.versions.electron) {
    const { spawnSync } = require('node:child_process');
    const root = fs.mkdtempSync(join(require('node:os').tmpdir(), 'owmo-ingest-ui-'));
    try {
        fs.mkdirSync(join(root, 'profile'));
        fs.mkdirSync(join(root, 'library'));
        fs.mkdirSync(join(root, 'source'));
        fs.writeFileSync(join(root, 'profile', 'configuration.json'), JSON.stringify({ version: 1, libraryPath: fs.realpathSync(join(root, 'library')) }));
        for (const color of ['blue', 'red']) {
            const video = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=10`, '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, 'source', `${color}.mp4`)]);
            if (video.status !== 0) throw new Error('Could not generate synthetic video');
        }
        const env = { ...process.env, OWMO_INGEST_UI_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
        const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 30000 });
        if (result.error) console.error(result.error);
        if (result.status !== 0 || !fs.existsSync(join(root, 'validated'))) process.exitCode = 1;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
    const assert = require('node:assert/strict');
    const electron = require('electron');
    const { app } = electron;
    const root = process.env.OWMO_INGEST_UI_ROOT;
    if (!root) throw new Error('Missing isolated profile');
    app.setPath('userData', join(root, 'profile'));
    let window, backend, statusOverride, ingestReads = 0;
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
        if (String(url).endsWith('/api/ingestion') && (!options?.method || options.method === 'GET')) ingestReads++;
        const result = await originalFetch(url, options);
        if (statusOverride && String(url).endsWith('/api/ingestion/stop')) {
            statusOverride = { ...statusOverride, revision: statusOverride.revision + 1, active: false, current: undefined };
            backend.emit('message', { type: 'ingestion:changed', status: statusOverride });
        }
        return result;
    };
    const originalLoad = require('node:module')._load;
    const fork = electron.utilityProcess.fork.bind(electron.utilityProcess);
    const wrapped = { ...electron,
        BrowserWindow: class extends electron.BrowserWindow { constructor(options) { super({ ...options, show: false }); window = this; } },
        utilityProcess: { ...electron.utilityProcess, fork(...args) { backend = fork(...args); return backend; } },
    };
    require('node:module')._load = function(request, parent, isMain) { return request === 'electron' ? wrapped : originalLoad.call(this, request, parent, isMain); };
    const timer = setTimeout(() => { console.error('Ingest UI fixture timed out'); backend?.kill(); app.exit(1); }, 25000);
    require('../out/main/index.cjs');
    app.whenReady().then(async () => {
        const js = code => window.webContents.executeJavaScript(code);
        const until = async (condition, message) => { for (let i = 0; i < 500; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(message); };
        const click = text => js(`Array.from((document.querySelector('dialog[open]') ?? document).querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`);
        try {
            await until(() => window && !window.webContents.isLoading(), 'Renderer not loaded');
            await until(() => js(`window.desktop.getBackendStatus().then(status=>status.state==='connected')`), 'Backend not connected');
            // Exercise the real source IPC without exposing renderer paths: chooseSource uses the native picker.
            wrapped.dialog = { ...electron.dialog, showOpenDialog: async (_owner, options) => ({ canceled: false, filePaths: [join(root, options.title === 'Set Library Location' ? 'library' : 'source')] }) };
            await js('window.desktop.chooseLibrary()');
            await js('window.desktop.chooseSource()');
            await until(() => js(`document.querySelectorAll('[data-shot-card]').length===2 && Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Process'&&!button.disabled)`), 'Clips did not become eligible');
            const idleReads = ingestReads;
            await new Promise(resolve => setTimeout(resolve, 1200));
            assert.equal(ingestReads, idleReads, 'Idle footer does not poll ingestion status');
            await click('Process');
            await until(() => js(`document.querySelector('dialog[open]')?.textContent.includes('Ready to Process?')`), 'Review did not open');
            assert.equal(await js(`document.querySelectorAll('dialog button[aria-label^="Remove "]').length`), 2);
            await js(`document.querySelector('dialog button[aria-label^="Remove "]').click()`);
            assert.equal(await js(`document.querySelectorAll('dialog button[aria-label^="Remove "]').length`), 1);
            await fs.promises.writeFile('/tmp/owmo-ingest-review.png', (await window.webContents.capturePage()).toPNG());
            await click('Process');
            await until(() => js(`!document.querySelector('dialog[open]') && !!document.querySelector('[data-shot-status="synced"]')`), 'Ingestion did not complete');
            assert.equal(fs.readdirSync(join(root, 'library')).filter(name => name.endsWith('.metadata.json')).length, 1, 'X excludes clip from submission');
            assert.equal(await js(`window.desktop.getShots().then(collection=>collection.shots.filter(shot=>shot.organization.skipped).length)`), 0, 'Review removal preserves Skip');
            let ingested = await js(`window.desktop.getShots().then(collection=>collection.shots.find(shot=>shot.ingestState==='synced'))`);
            await window.loadFile(join(__dirname, '../out/renderer/index.html'));
            await until(() => js(`!!document.querySelector('[data-shot-status="synced"]')`), 'Synced badge lost on renderer reload');
            // Externally deleted dummy Library files must become New on an explicit refresh.
            for (const suffix of ['source.mp4', 'thumb.jpg', 'metadata.json']) fs.unlinkSync(join(root, 'library', `${ingested.id}.${suffix}`));
            await js(`document.querySelector('header button[aria-label="Refresh Library"]').click()`);
            await until(() => js(`!document.querySelector('[data-shot-status="synced"]') && Array.from(document.querySelectorAll('footer button')).some(button=>button.textContent==='Process'&&!button.disabled)`), 'Deleted shot was still synced');
            await click('Process');
            await until(() => js(`document.querySelector('dialog[open]')?.textContent.includes('Ready to Process?')`), 'Fresh review missing');
            assert.equal(await js(`document.querySelector('dialog').textContent.includes('↻ Update')`), false, 'Deleted clips are New');
            await click('Cancel');
            await js(`(async () => { const review = await window.desktop.reviewIngest([${JSON.stringify(ingested.id)}]); return window.desktop.startIngest(review.token,[${JSON.stringify(ingested.id)}]); })()`);
            await until(() => js(`!!document.querySelector('[data-shot-status="synced"]')`), 'Fresh re-ingestion failed');
            await js(`window.desktop.updateOrganization([${JSON.stringify(ingested.id)}],{field:'notes',operation:'set',value:'Updated after ingestion'})`);
            await until(() => js(`!!document.getElementById('shot-${ingested.id}')?.querySelector('[data-shot-status="changes-pending"] svg')`), 'Metadata edit did not show the pending-update pencil icon');
            await click('Process');
            await until(() => js(`document.querySelector('dialog[open]')?.textContent.includes('↻ Update')`), 'Replacement not labeled');
            assert.ok(await js(`document.querySelector('dialog').textContent.includes('Additional assets are preserved')`));
            await click('Cancel');
            // Existing Library assets must indicate an update even without a local receipt.
            const unprocessed = await js(`window.desktop.getShots().then(collection=>collection.shots.find(shot=>shot.id!==${JSON.stringify(ingested.id)}))`);
            assert.equal(unprocessed.ingestion, undefined);
            assert.equal(await js(`!!document.getElementById('shot-${unprocessed.id}').querySelector('[data-shot-status="changes-pending"]')`), false, 'New clip remains neutral');
            await fs.promises.copyFile(join(root, 'source', unprocessed.filename), join(root, 'library', `${unprocessed.id}.source.mp4`));
            await fs.promises.copyFile(join(root, 'library', `${ingested.id}.thumb.jpg`), join(root, 'library', `${unprocessed.id}.thumb.jpg`));
            await fs.promises.writeFile(join(root, 'library', `${unprocessed.id}.metadata.json`), '{}');
            await js(`document.querySelector('header button[aria-label="Refresh Library"]').click()`);
            await until(() => js(`document.getElementById('shot-${unprocessed.id}')?.classList.contains('ingest-card-needs-sync') && !!document.getElementById('shot-${unprocessed.id}').querySelector('[data-shot-status="changes-pending"]')`), 'Existing clip without receipt was displayed as New');
            await click('Process');
            await until(() => js(`document.querySelectorAll('dialog button[aria-label^="Remove "]').length===2`), 'Both updates must appear in review');
            assert.equal(await js(`document.querySelector('dialog').textContent.includes('+ New')`), false, 'Update cards agree with review');
            await click('Cancel');
            // Deterministic active progress fixture, with the real Stop IPC and confirmation UI.
            const currentStatus = await js('window.desktop.getIngestStatus()');
            statusOverride = { revision: currentStatus.revision + 1, active: true, stopping: false, position: 1, total: 3, errors: [], libraryPath: join(root, 'library'), current: { id: ingested.id, filename: ingested.filename, phase: 'transferring', percent: 42 } };
            backend.emit('message', { type: 'ingestion:changed', status: statusOverride });
            await until(() => js(`document.querySelector('[data-ingest-progress]')?.getAttribute('aria-label')==='1 / 3 clips processing'`), 'Active footer summary missing');
            assert.equal(await js(`document.querySelector('footer progress').value`), 42);
            const activeReads = ingestReads;
            backend.emit('message', { type: 'ingestion:changed', status: { ...statusOverride, revision: currentStatus.revision, current: { ...statusOverride.current, percent: 1 } } });
            await new Promise(resolve => setTimeout(resolve, 1200));
            assert.equal(ingestReads, activeReads, 'Progress notifications do not poll ingestion status');
            assert.equal(await js(`document.querySelector('footer progress').value`), 42, 'Stale snapshots cannot regress progress');
            const checkProgressLayout = async label => {
                const metrics = await js(`(() => {
                    const footer = document.querySelector('footer').getBoundingClientRect();
                    const panel = document.querySelector('[data-ingest-progress]').getBoundingClientRect();
                    const bar = document.querySelector('footer progress').getBoundingClientRect();
                    const actions = Array.from(document.querySelectorAll('footer button')).find(button=>button.textContent==='Process').getBoundingClientRect();
                    return { offset: Math.abs((panel.left + panel.right) / 2 - (footer.left + footer.right) / 2), width: bar.width, height: bar.height, panelRight: panel.right, actionsLeft: actions.left };
                })()`);
                assert.ok(metrics.offset < 2, `${label}: progress is centered in the window`);
                assert.ok(metrics.width >= 180 && metrics.height >= 10, `${label}: progress is prominent`);
                assert.ok(metrics.panelRight < metrics.actionsLeft, `${label}: progress does not overlap controls`);
            };
            await checkProgressLayout('wide');
            await fs.promises.writeFile('/tmp/owmo-ingest-progress-wide.png', (await window.webContents.capturePage()).toPNG());
            window.setSize(1100, 800);
            await until(() => js('window.innerWidth === 1100'), 'Narrow layout did not settle');
            await checkProgressLayout('narrow');
            await fs.promises.writeFile('/tmp/owmo-ingest-progress-narrow.png', (await window.webContents.capturePage()).toPNG());
            await js(`document.querySelector('[data-ingest-progress] button[aria-label="Stop Queue"]').click()`);
            await until(() => js(`document.querySelector('dialog[open]')?.textContent.includes('Completed clips remain synced')`), 'Stop confirmation missing');
            await new Promise(resolve => setTimeout(resolve, 1200));
            await fs.promises.writeFile('/tmp/owmo-stop-queue.png', (await window.webContents.capturePage()).toPNG());
            await click('Cancel');
            assert.equal(await js(`document.querySelector('dialog[open]')===null`), true);
            await js(`document.querySelector('[data-ingest-progress] button[aria-label="Stop Queue"]').click()`);
            await js(`Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent==='Stop').click()`);
            await until(() => js(`!document.querySelector('dialog[open]') && !document.querySelector('[data-ingest-progress]')`), 'Footer did not return to idle');
            await fs.promises.writeFile(join(root, 'validated'), 'passed');
            clearTimeout(timer);
            console.log('PASS: real Electron review, X exclusion, ingestion, persisted sync badge, renderer reload, deleted-Library refresh/New review, replacement review, centered prominent progress at wide/narrow sizes, notifications without polling, stale-update protection, and Stop confirmation.');
            app.quit();
        } catch (error) { console.error(error); clearTimeout(timer); backend?.kill(); app.exit(1); }
    });
}
