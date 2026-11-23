const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { join, dirname, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { build, Platform, Arch } = require('electron-builder');

(async () => {
    if (process.platform !== 'darwin') throw new Error('Build the Mac application on macOS.');
    const root = resolve(__dirname, '..');
    const iconPath = join(root, 'resources/icon/AppIcon.icns');
    if (!existsSync(iconPath)) {
        const temporary = mkdtempSync(join(tmpdir(), 'owmo-icon-'));
        try {
            const iconset = join(temporary, 'AppIcon.iconset'); mkdirSync(iconset);
            for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
                execFileSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), join(root, 'resources/icon/logo.png'),
                    '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
            }
            execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', iconPath]);
        } finally { rmSync(temporary, { recursive: true, force: true }); }
    }
    const output = await build({
        targets: Platform.MAC.createTarget('dir', Arch[process.arch]), publish: 'never',
        config: {
            appId: 'com.owmo.shot-manager', productName: 'Shot Manager', extends: null,
            directories: { output: 'release', buildResources: 'resources/icon' },
            electronDist: join(dirname(require.resolve('electron')), 'dist'),
            files: ['out/main/**/*', 'out/preload/**/*', 'out/renderer/**/*', 'package.json'],
            extraResources: process.argv.includes('--with-luts') ? [{ from: 'resources/luts', to: 'luts', filter: ['apple-log-rec709.cube', 'sony-s709.cube'] }] : [],
            npmRebuild: false,
            mac: { category: 'public.app-category.video', icon: 'resources/icon/AppIcon.icns', identity: '-', hardenedRuntime: false, notarize: false },
        },
    });
    console.log(`Application: ${join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Shot Manager.app')}`);
    for (const path of output) console.log(path);
})().catch(error => { console.error(error); process.exitCode = 1; });
