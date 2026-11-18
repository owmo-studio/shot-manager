import { app, Menu } from 'electron';

export function installApplicationMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: app.getName(), submenu: [
                { role: 'about' }, { type: 'separator' },
                { role: 'services' }, { type: 'separator' },
                { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
                { id: 'quit-shot-manager', role: 'quit', label: 'Quit Shot Manager', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
            ],
        },
        { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
}
