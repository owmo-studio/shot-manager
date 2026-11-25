// The native menu, renderer, preload, and backend use a temporary profile and Library.
const fs = require('node:fs');
const { join } = require('node:path');
const fingerprint = 'e'.repeat(64);
const sourceName = `${fingerprint}.source.mp4`;
const thumbnailName = `${fingerprint}.thumb.jpg`;

if (!process.versions.electron) {
    const root = fs.realpathSync(fs.mkdtempSync(join(require('node:os').tmpdir(), 'shot-manager-orphan-ui-')));
    try {
        fs.mkdirSync(join(root, 'profile'));
        fs.mkdirSync(join(root, 'library'));
        for (const name of [sourceName, thumbnailName]) fs.writeFileSync(join(root, 'library', name), 'abandoned fixture');
        const env = { ...process.env, SHOT_MANAGER_ORPHAN_TEST_ROOT: root };
        delete env.ELECTRON_RUN_AS_NODE;
        const run = require('node:child_process').spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 30000 });
        if (run.error) console.error(run.error);
        if (run.status !== 0 || !fs.existsSync(join(root, 'validated'))) process.exitCode = 1;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
    const assert = require('node:assert/strict');
    const electron = require('electron');
    const { app, Menu } = electron;
    const root = process.env.SHOT_MANAGER_ORPHAN_TEST_ROOT;
    if (!root) throw new Error('Missing isolated test directory');
    const library = join(root, 'library');
    app.setPath('userData', join(root, 'profile'));

    let window;
    const wrapped = {
        ...electron,
        BrowserWindow: class extends electron.BrowserWindow {
            constructor(options) {
                super({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
                window = this;
            }
        },
        dialog: { ...electron.dialog, showOpenDialog: async () => ({ canceled: false, filePaths: [library] }) },
    };
    const moduleLoader = require('node:module');
    const load = moduleLoader._load;
    moduleLoader._load = function (request, parent, isMain) {
        return request === 'electron' ? wrapped : load.call(this, request, parent, isMain);
    };
    require('../../out/main/index.cjs');

    app.whenReady().then(async () => {
        const js = code => window.webContents.executeJavaScript(code);
        const until = async (condition, message) => {
            for (let i = 0; i < 300; i++) {
                if (await condition()) return;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error(message);
        };
        const click = label => js(`Array.from(document.querySelectorAll('dialog[open] button')).find(button =>
            button.textContent.trim() === ${JSON.stringify(label)} || button.getAttribute('aria-label') === ${JSON.stringify(label)}).click()`);
        await until(() => window && !window.webContents.isLoading(), 'Renderer did not load');
        await until(() => js(`window.desktop.getBackendStatus().then(status => status.state === 'connected')`), 'Backend did not connect');
        await js(`window.desktop.chooseLibrary().then(choice => window.desktop.saveConfigurationLocations({ library: choice.token }))`);
        const menuItem = Menu.getApplicationMenu().getMenuItemById('clean-orphaned-data');
        assert.equal(menuItem.label, 'Clean Orphaned Data');
        const rowCount = () => js(`document.querySelectorAll('[aria-label="Orphaned files"] li').length`);
        const openReview = async () => {
            menuItem.click(menuItem, window);
            await until(async () => await rowCount() === 2, 'Cleanup did not list each file');
        };

        await openReview();
        await click('Cancel');
        assert.ok([sourceName, thumbnailName].every(name => fs.existsSync(join(library, name))), 'Cancel preserves all files');
        await openReview();
        await click(`Keep ${thumbnailName}`);
        assert.equal(await rowCount(), 1);
        await click('Confirm');
        await until(() => js(`document.querySelector('dialog[open] [role="status"]')?.textContent === '1 file deleted.'`), 'Cleanup did not finish');
        assert.equal(fs.existsSync(join(library, sourceName)), false);
        assert.equal(fs.readFileSync(join(library, thumbnailName), 'utf8'), 'abandoned fixture');
        await click('Close');
        fs.writeFileSync(join(root, 'validated'), '');
        console.log('PASS: native orphan cleanup review, cancel, row exclusion, and confirmed deletion.');
        app.quit();
    }).catch(error => { console.error(error); app.exit(1); });
}
