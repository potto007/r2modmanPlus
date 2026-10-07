import { BrowserWindow, ipcMain, shell, clipboard, safeStorage } from 'electron';

export function hookElectronIpc(browserWindow: BrowserWindow) {
    ipcMain.on('electron:shell:openExternal', (event, url) => {
        shell.openExternal(url)
    });

    ipcMain.on('electron:shell:selectFile', (event, filePath) => {
        shell.showItemInFolder(filePath)
    });

    ipcMain.on('electron:shell:openPath', (event, filePath) => {
        shell.openPath(filePath)
    });

    ipcMain.on('electron:clipboard:copyText', (event, text) => {
        clipboard.writeText(text);
        event.returnValue = true;
    });

    ipcMain.handle('electron:getEnvironmentVariables', (event) => {
        return JSON.stringify(process.env);
    })

    ipcMain.handle('electron:safeStorage:isAvailable', () => {
        return safeStorage.isEncryptionAvailable();
    });

    ipcMain.handle('electron:safeStorage:encryptString', (event, value: string) => {
        return safeStorage.encryptString(value).toString('base64');
    });

    ipcMain.handle('electron:safeStorage:decryptString', (event, value: string) => {
        return safeStorage.decryptString(Buffer.from(value, 'base64'));
    });
}
