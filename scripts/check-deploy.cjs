// Fault-injected deployment into temporary Applications folders only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const child = require('node:child_process');
const { join, basename, dirname } = require('node:path');
const root = fs.mkdtempSync(join(require('node:os').tmpdir(), 'owmo-deploy-check-'));
const name = 'Shot Manager.app', source = join(root, 'build', name), applications = join(root, 'Applications'), target = join(applications, name);
const originalExec = child.execFileSync, originalRename = fs.renameSync;
let runningPath, invalidSignature = false, failPromotion = false;
try {
    fs.mkdirSync(join(source, 'Contents'), { recursive: true }); fs.mkdirSync(applications);
    fs.writeFileSync(join(source, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.owmo.shot-manager</string></dict></plist>');
    fs.writeFileSync(join(source, 'Contents/version'), 'new');
    child.execFileSync = (command, args, options) => {
        if (command === '/bin/ps') return runningPath ? `${runningPath}/Contents/MacOS/Shot Manager` : '';
        if (command === '/usr/bin/ditto') { fs.cpSync(args[0], args[1], { recursive: true }); return; }
        if (command === '/usr/bin/codesign') { if (invalidSignature) throw new Error('Invalid signature'); return; }
        return originalExec(command, args, options);
    };
    fs.renameSync = (from, to) => {
        if (failPromotion && basename(from) === name && dirname(from).startsWith(join(applications, '.owmo-deploy-')) && to === target) {
            failPromotion = false; throw new Error('Synthetic replacement failure');
        }
        return originalRename(from, to);
    };
    const { deployMac } = require('./deploy-mac.cjs');
    assert.throws(() => deployMac(join(root, 'missing.app'), applications), /Run npm run package first/);
    deployMac(source, applications);
    assert.equal(fs.readFileSync(join(target, 'Contents/version'), 'utf8'), 'new');
    fs.writeFileSync(join(target, 'Contents/version'), 'old');
    for (const path of [target, join(applications, 'OWMO Shot Manager.app')]) {
        runningPath = path;
        assert.throws(() => deployMac(source, applications), /Quit Shot Manager/);
    }
    runningPath = undefined;
    invalidSignature = true; assert.throws(() => deployMac(source, applications), /Invalid signature/); invalidSignature = false;
    assert.equal(fs.readFileSync(join(target, 'Contents/version'), 'utf8'), 'old');
    failPromotion = true; assert.throws(() => deployMac(source, applications), /replacement failure/);
    assert.equal(fs.readFileSync(join(target, 'Contents/version'), 'utf8'), 'old', 'Failed promotion restores the previous app');
    deployMac(source, applications);
    assert.equal(fs.readFileSync(join(target, 'Contents/version'), 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(applications), [name], 'No staging or backup files remain');
    fs.writeFileSync(join(target, 'Contents/Info.plist'), fs.readFileSync(join(source, 'Contents/Info.plist'), 'utf8').replace('com.owmo.shot-manager', 'com.other.app'));
    assert.throws(() => deployMac(source, applications), /unrelated application/);
    assert.equal(fs.readFileSync(join(source, 'Contents/version'), 'utf8'), 'new', 'Build stays untouched');
    console.log('PASS: install/replacement, missing build, running app, signature rejection, rollback, unrelated-app protection, and temporary-file cleanup.');
} finally {
    child.execFileSync = originalExec; fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
}
