const { execFileSync } = require('node:child_process');
const { lstatSync, mkdtempSync, renameSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');

const name = 'Shot Manager.app';
const previousName = 'OWMO Shot Manager.app';
function validateBundle(path) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) throw new Error(`Application not found: ${path}. Run npm run package first.`);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a real application bundle: ${path}`);
    const id = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(path, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    if (id !== 'com.owmo.shot-manager') throw new Error(`Refusing to replace an unrelated application: ${path}`);
}
function assertStopped(target) {
    const commands = execFileSync('/bin/ps', ['-axo', 'args='], { encoding: 'utf8' });
    const previous = join(target, '..', previousName);
    if ([target, previous].some(path => commands.includes(`${path}/Contents/`))) {
        throw new Error('Quit Shot Manager, then run npm run deploy again.');
    }
}

function deployMac(source, applications = '/Applications') {
    if (process.platform !== 'darwin') throw new Error('Deploy the Mac application on macOS.');
    source = resolve(source);
    const target = join(resolve(applications), name);
    if (source === target) throw new Error('The build and installation locations must be different.');
    validateBundle(source);
    if (lstatSync(target, { throwIfNoEntry: false })) validateBundle(target);
    assertStopped(target);
    const temporary = mkdtempSync(join(applications, '.owmo-deploy-'));
    const staged = join(temporary, name), backup = join(temporary, 'previous.app');
    let backedUp = false, installed = false;
    try {
        execFileSync('/usr/bin/ditto', [source, staged]);
        validateBundle(staged);
        execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
        assertStopped(target);
        if (lstatSync(target, { throwIfNoEntry: false })) {
            validateBundle(target); renameSync(target, backup); backedUp = true;
        }
        try { renameSync(staged, target); installed = true; }
        catch (error) { if (backedUp) { renameSync(backup, target); backedUp = false; } throw error; }
        console.log(`Installed: ${target}`);
        return target;
    } finally {
        // Keep the previous app recoverable if restoring it itself failed.
        if (!backedUp || installed) rmSync(temporary, { recursive: true, force: true });
        else console.error(`Previous application preserved at: ${backup}`);
    }
}

module.exports = { deployMac };
if (require.main === module) {
    try { deployMac(join(__dirname, '..', 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', name)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
