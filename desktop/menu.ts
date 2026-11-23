import { app, dialog, Menu, shell } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function installApplicationMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: app.getName(), submenu: [
                { role: 'about' }, { type: 'separator' },
                { label: 'Open LUT Folder…', click: async () => {
                    try {
                        const folder = join(app.getPath('userData'), 'LUTs');
                        await mkdir(folder, { recursive: true });
                        const error = await shell.openPath(folder);
                        if (error) throw new Error(error);
                    } catch (error) { dialog.showErrorBox('Could not open LUT folder', String(error)); }
                } },
                { role: 'services' }, { type: 'separator' },
                { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
                { id: 'quit-shot-manager', role: 'quit', label: 'Quit Shot Manager', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
            ],
        },
        { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
}
