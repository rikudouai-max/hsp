// Hybrid Storage Engine: Native Electron app.getPath('userData') / vault, with IndexedDB fallback
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

export interface ReadPdfResult {
  success: boolean;
  uint8Array?: Uint8Array;
  blobUrl?: string;
  error?: string;
}

declare global {
  interface Window {
    electronAPI?: {
      downloadPdf: (fileId: string, fileName: string) => Promise<{ success: boolean; size?: number; path?: string; error?: string }>;
      getDownloadedList: () => Promise<string[]>;
      readOfflinePdf: (fileId: string) => Promise<{ success: boolean; data?: Uint8Array; size?: number; error?: string }>;
      getDownloadedPdfData: (fileId: string) => Promise<{ success: boolean; data?: Uint8Array; size?: number; error?: string }>;
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
    console.log(`[Storage] Triggering Electron download for ${fileName} (${fileId})`);
    const res = await window.electronAPI.downloadPdf(fileId, fileName);
    if (!res.success) {
      throw new Error(res.error || 'فشل التحميل من Google Drive');
    }
    return true;
  }

  // Web / Browser fallback via IndexedDB
  console.log(`[Storage] Triggering Web/IndexedDB download for ${fileName} (${fileId})`);
  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const res = await fetch(directUrl);
  if (!res.ok) throw new Error(`فشل التنزيل رمز الحالة: ${res.status}`);
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

// Read offline PDF as pure Uint8Array (preserving raw binary integrity, no string conversion)
export async function readOfflinePdfBinary(id: string): Promise<ReadPdfResult> {
  // 1. Electron IPC read
  if (window.electronAPI) {
    try {
      console.log(`[Storage] Reading offline PDF via Electron IPC for id: ${id}`);
      const res = await window.electronAPI.readOfflinePdf(id);
      if (res.success && res.data) {
        // res.data is a raw Uint8Array from the decrypted buffer
        const rawBytes = res.data;
        console.log(`[Storage] Successfully received binary Uint8Array: ${rawBytes.byteLength} bytes`);
        const blob = new Blob([rawBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
        const blobUrl = URL.createObjectURL(blob);
        return { success: true, uint8Array: rawBytes, blobUrl };
      }
      return { success: false, error: res.error || 'فشل قراءة الملف المشفر محلياً' };
    } catch (e: any) {
      console.error('[Storage] Electron readOfflinePdf failed:', e);
      return { success: false, error: e.message || 'خطأ أثناء قراءة الملف من الذاكرة' };
    }
  }

  // 2. IndexedDB fallback
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = async () => {
        const file: StoredFile | undefined = req.result;
        if (file && file.blob) {
          const arrayBuf = await file.blob.arrayBuffer();
          const uint8 = new Uint8Array(arrayBuf);
          const blobUrl = URL.createObjectURL(file.blob);
          resolve({ success: true, uint8Array: uint8, blobUrl });
        } else {
          resolve({ success: false, error: 'الملف غير موجود في التخزين المؤقت' });
        }
      };
      req.onerror = () => resolve({ success: false, error: 'خطأ في قاعدة بيانات التخزين المؤقت' });
    });
  } catch (e: any) {
    return { success: false, error: e.message };
  }
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
