const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  downloadPdf: (fileId, fileName) => ipcRenderer.invoke('download-pdf', { fileId, fileName }),
  getDownloadedList: () => ipcRenderer.invoke('get-downloaded-list'),
  getDownloadedPdfData: (fileId) => ipcRenderer.invoke('get-downloaded-pdf-data', { fileId }),
  deleteDownloadedPdf: (fileId) => ipcRenderer.invoke('delete-downloaded-pdf', { fileId }),
  getStorageStats: () => ipcRenderer.invoke('get-storage-stats')
});
