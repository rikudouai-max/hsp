const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  downloadPdf: (fileId, fileName) => ipcRenderer.invoke('download-pdf', { fileId, fileName }),
  getDownloadedList: () => ipcRenderer.invoke('get-downloaded-list'),
  readOfflinePdf: (fileId) => ipcRenderer.invoke('read-offline-pdf', { fileId }),
  openOfflinePdf: (fileId, fileName) => ipcRenderer.invoke('open-offline-pdf', { fileId, fileName }),
  getDownloadedPdfData: (fileId) => ipcRenderer.invoke('read-offline-pdf', { fileId }),
  deleteDownloadedPdf: (fileId) => ipcRenderer.invoke('delete-downloaded-pdf', { fileId }),
  getStorageStats: () => ipcRenderer.invoke('get-storage-stats')
});
