// Hybrid Storage Engine: Native Electron app.getPath('userData') / downloads, with IndexedDB fallback
const DB_NAME = 'HSP_OFFLINE_DB';
const DB_VERSION = 1;
const STORE_NAME = 'downloaded_files';

export interface StoredFile {
  id: string;
  name: string;
  blob: Blob;
  size: number;
  mimeType: string;
  downloadedAt: number;
}

declare global {
  interface Window {
    electronAPI?: {
      downloadPdf: (fileId: string, fileName: string) => Promise<{ success: boolean; size?: number; path?: string; error?: string }>;
      getDownloadedList: () => Promise<string[]>;
      getDownloadedPdfData: (fileId: string) => Promise<{ success: boolean; base64?: string; size?: number; error?: string }>;
      deleteDownloadedPdf: (fileId: string) => Promise<{ success: boolean; error?: string }>;
      getStorageStats: () => Promise<{ totalBytes: number; count: number }>;
    };
  }
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Download directly from Google Drive uc?export=download and store in Electron internal directory
export async function downloadAndSaveFile(fileId: string, fileName: string): Promise<boolean> {
  if (window.electronAPI) {
    const res = await window.electronAPI.downloadPdf(fileId, fileName);
    if (!res.success) {
      throw new Error(res.error || 'Download failed');
    }
    return true;
  }

  // Web / Browser fallback via IndexedDB
  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const res = await fetch(directUrl);
  if (!res.ok) throw new Error('Download failed: ' + res.status);
  const blob = await res.blob();
  await saveFileLocally(fileId, fileName, 'application/pdf', blob);
  return true;
}

export async function saveFileLocally(id: string, name: string, mimeType: string, blob: Blob): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const data: StoredFile = {
      id,
      name,
      blob,
      size: blob.size,
      mimeType,
      downloadedAt: Date.now()
    };
    const req = store.put(data);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getStoredFileBlobUrl(id: string): Promise<string | null> {
  // 1. Check Electron native storage first
  if (window.electronAPI) {
    const res = await window.electronAPI.getDownloadedPdfData(id);
    if (res.success && res.base64) {
      const byteCharacters = atob(res.base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'application/pdf' });
      return URL.createObjectURL(blob);
    }
  }

  // 2. Fallback to IndexedDB
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => {
      const file: StoredFile | undefined = req.result;
      if (file && file.blob) {
        resolve(URL.createObjectURL(file.blob));
      } else {
        resolve(null);
      }
    };
    req.onerror = () => resolve(null);
  });
}

export async function getAllStoredFileIds(): Promise<Set<string>> {
  if (window.electronAPI) {
    const list = await window.electronAPI.getDownloadedList();
    return new Set(list);
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      const keys = req.result as string[];
      resolve(new Set(keys));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteStoredFile(id: string): Promise<void> {
  if (window.electronAPI) {
    await window.electronAPI.deleteDownloadedPdf(id);
    return;
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getTotalStorageUsed(): Promise<{ totalBytes: number; count: number }> {
  if (window.electronAPI) {
    return await window.electronAPI.getStorageStats();
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const items: StoredFile[] = req.result;
      const totalBytes = items.reduce((sum, item) => sum + (item.size || 0), 0);
      resolve({ totalBytes, count: items.length });
    };
    req.onerror = () => reject(req.error);
  });
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 بايت';
  const k = 1024;
  const sizes = ['بايت', 'كيلوبايت', 'ميجابايت', 'جيجابايت'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
