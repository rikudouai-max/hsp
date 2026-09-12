const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

// DRM Encryption key & algorithm (AES-256-CBC)
// Key derived deterministically for internal vault protection
const VAULT_SECRET = crypto.createHash('sha256').update('HSP_VAULT_DRM_PROTECTION_KEY_2026').digest();

// Local encrypted vault storage directory inside userData
function getVaultDir() {
  const dir = path.join(app.getPath('userData'), 'vault');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function encryptBuffer(buffer) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', VAULT_SECRET, iv);
  const encrypted = Buffer.concat([iv, cipher.update(buffer), cipher.final()]);
  return encrypted;
}

function decryptBuffer(encryptedBuffer) {
  const iv = encryptedBuffer.subarray(0, 16);
  const data = encryptedBuffer.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', VAULT_SECRET, iv);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted;
}

// Download file following redirects (Google Drive uc?export=download uses 302 redirects)
function downloadDirectFromDrive(fileId, targetPath) {
  const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
  
  return new Promise((resolve, reject) => {
    function executeFetch(currentUrl, maxRedirects = 5) {
      if (maxRedirects <= 0) {
        return reject(new Error('Too many redirects'));
      }

      https.get(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return executeFetch(res.headers.location, maxRedirects - 1);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP status ${res.statusCode}`));
        }

        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));

        res.on('end', () => {
          try {
            const rawBuffer = Buffer.concat(chunks);
            // Encrypt binary data before writing to disk
            const encryptedData = encryptBuffer(rawBuffer);
            fs.writeFileSync(targetPath, encryptedData);
            resolve(targetPath);
          } catch (e) {
            reject(e);
          }
        });

        res.on('error', (err) => {
          fs.unlink(targetPath, () => {});
          reject(err);
        });
      }).on('error', (err) => {
        fs.unlink(targetPath, () => {});
        reject(err);
      });
    }

    executeFetch(url);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1050,
    height: 820,
    minWidth: 420,
    minHeight: 600,
    title: 'مختص في حفظ الصحة',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      devTools: false // Disable DevTools in production
    }
  });

  // Strictly block right click context menu in the Electron window
  win.webContents.on('context-menu', (e) => {
    e.preventDefault();
  });

  // Prevent opening external applications for files
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Only allow opening legitimate external web links in browser, strictly deny local file shell execution
    if (url.startsWith('https://drive.google.com') || url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'dist', 'index.html'));
}

// IPC Handlers for encrypted downloading and reading files locally
ipcMain.handle('download-pdf', async (event, { fileId, fileName }) => {
  try {
    const vaultDir = getVaultDir();
    const filePath = path.join(vaultDir, `${fileId}.enc`);
    await downloadDirectFromDrive(fileId, filePath);
    const stat = fs.statSync(filePath);
    return { success: true, size: stat.size, path: filePath };
  } catch (err) {
    console.error('Download error in main process:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-downloaded-list', async () => {
  try {
    const vaultDir = getVaultDir();
    const files = fs.readdirSync(vaultDir);
    const list = files
      .filter(f => f.endsWith('.enc'))
      .map(f => f.replace(/\.enc$/, ''));
    return list;
  } catch (e) {
    return [];
  }
});

// Solid IPC handler that reads the encrypted file, decrypts it into a raw Buffer,
// and sends it to the renderer as a pure binary Uint8Array / Buffer without string corruption.
ipcMain.handle('read-offline-pdf', async (event, { fileId }) => {
  try {
    console.log(`[IPC] Reading encrypted offline PDF for fileId: ${fileId}`);
    const filePath = path.join(getVaultDir(), `${fileId}.enc`);
    if (!fs.existsSync(filePath)) {
      console.error(`[IPC] File not found at ${filePath}`);
      return { success: false, error: 'الملف غير موجود في مجلد التخزين المحلي المحمي' };
    }

    const encryptedBuffer = fs.readFileSync(filePath);
    console.log(`[IPC] Read encrypted size: ${encryptedBuffer.length} bytes`);
    
    const decryptedBuffer = decryptBuffer(encryptedBuffer);
    console.log(`[IPC] Successfully decrypted into binary buffer: ${decryptedBuffer.length} bytes`);

    // Verify PDF header magic bytes '%PDF'
    const header = decryptedBuffer.subarray(0, 5).toString('ascii');
    console.log(`[IPC] PDF Header magic bytes: ${header}`);
    if (!header.startsWith('%PDF')) {
      console.warn(`[IPC] Warning: file may not be a standard PDF header: ${header}`);
    }

    // Returning raw Uint8Array preserves exact binary integrity across Electron IPC
    return { 
      success: true, 
      data: new Uint8Array(decryptedBuffer), 
      size: decryptedBuffer.length 
    };
  } catch (err) {
    console.error('[IPC] Error decrypting offline PDF:', err);
    return { success: false, error: err.message || 'فشل فك تشفير الملف في الذاكرة' };
  }
});

// Legacy backward-compatible handler
ipcMain.handle('get-downloaded-pdf-data', async (event, { fileId }) => {
  try {
    const filePath = path.join(getVaultDir(), `${fileId}.enc`);
    if (fs.existsSync(filePath)) {
      const encryptedBuffer = fs.readFileSync(filePath);
      const decryptedBuffer = decryptBuffer(encryptedBuffer);
      return { success: true, data: new Uint8Array(decryptedBuffer), size: decryptedBuffer.length };
    }
    return { success: false, error: 'File not found in encrypted vault' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-downloaded-pdf', async (event, { fileId }) => {
  try {
    const filePath = path.join(getVaultDir(), `${fileId}.enc`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-storage-stats', async () => {
  try {
    const vaultDir = getVaultDir();
    const files = fs.readdirSync(vaultDir).filter(f => f.endsWith('.enc'));
    let totalBytes = 0;
    files.forEach(f => {
      try {
        const s = fs.statSync(path.join(vaultDir, f));
        totalBytes += s.size;
      } catch (e) {}
    });
    return { totalBytes, count: files.length };
  } catch (e) {
    return { totalBytes: 0, count: 0 };
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
