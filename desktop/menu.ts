import { app, dialog, Menu, shell } from 'electron';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export function installApplicationMenu(lutDirectory: string, openOrphanCleanup: () => void) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: app.getName(), submenu: [
                { role: 'about' }, { type: 'separator' },
                { label: 'Open Resources Folder…', click: async () => {
                    try {
                        await mkdir(lutDirectory, { recursive: true });
                        const error = await shell.openPath(dirname(lutDirectory));
                        if (error) throw new Error(error);
                    } catch (error) { dialog.showErrorBox('Could not open resources folder', String(error)); }
                } },
                { id: 'clean-orphaned-data', label: 'Clean Orphaned Data...', click: openOrphanCleanup },
                { role: 'services' }, { type: 'separator' },
                { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
                { id: 'quit-shot-manager', role: 'quit', label: 'Quit Shot Manager', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
            ],
        },
        { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
}
