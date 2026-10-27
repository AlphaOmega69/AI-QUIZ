// AI Quiz Pro — Electron desktop wrapper (Windows / macOS / Linux)
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

function createWindow() {
    const win = new BrowserWindow({
        width: 480,
        height: 820,
        minWidth: 380,
        minHeight: 640,
        backgroundColor: '#00131a',
        icon: path.join(__dirname, '..', 'icons', 'icon-512.png'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    Menu.setApplicationMenu(null); // clean, app-like window — no default file/edit menu bar
    win.loadFile(path.join(__dirname, '..', 'AI_QUIZ.html'));
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
