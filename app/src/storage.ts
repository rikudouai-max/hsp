import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileOpener } from '@capawesome-team/capacitor-file-opener';

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
      openOfflinePdf: (fileId: string, fileName: string) => Promise<{ success: boolean; path?: string; error?: string }>;
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

// Convert base64 data to Blob in chunks to prevent stack overflow on large PDFs
function base64ToBlob(base64Data: string, mimeType: string = 'application/pdf'): Blob {
  const binaryString = atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

// Download directly from Google Drive uc?export=download and store in Electron internal directory or IndexedDB
export async function downloadAndSaveFile(fileId: string, fileName: string, customUrl?: string): Promise<boolean> {
  if (window.electronAPI) {
    console.log(`[Storage] Triggering Electron download for ${fileName} (${fileId})`);
    const res = await window.electronAPI.downloadPdf(fileId, fileName);
    if (!res.success) {
      throw new Error(res.error || 'فشل التحميل من Google Drive');
    }
    return true;
  }

  // Resolve direct URL
  const directUrl = customUrl && customUrl.startsWith('http')
    ? (customUrl.includes('drive.google.com/uc?') ? customUrl : `https://drive.google.com/uc?export=download&id=${fileId}`)
    : `https://drive.google.com/uc?export=download&id=${fileId}`;

  // Native Android / iOS via CapacitorHttp (bypasses WebView CORS completely)
  if (Capacitor.isNativePlatform()) {
    console.log(`[Storage] Native Android detected. Using CapacitorHttp to bypass CORS for ${fileName} (${fileId})`);
    try {
      const response = await CapacitorHttp.get({
        url: directUrl,
        responseType: 'blob',
        readTimeout: 60000,
        connectTimeout: 30000
      });

      if (response.status !== 200) {
        throw new Error(`فشل التحميل من الخادم رمز الحالة: ${response.status}`);
      }

      let pdfBlob: Blob;
      if (typeof response.data === 'string') {
        // Native Capacitor returns blob as base64 string
        pdfBlob = base64ToBlob(response.data, 'application/pdf');
      } else if (response.data instanceof Blob) {
        pdfBlob = response.data;
      } else {
        pdfBlob = new Blob([response.data], { type: 'application/pdf' });
      }

      await saveFileLocally(fileId, fileName, 'application/pdf', pdfBlob);
      console.log(`[Storage] Successfully saved ${fileName} via CapacitorHttp (${pdfBlob.size} bytes)`);
      return true;
    } catch (nativeErr: any) {
      console.error('[Storage] CapacitorHttp failed, attempting fallback fetch:', nativeErr);
      // Fallback to fetch if CapacitorHttp encounters any issue
    }
  }

  // Web / Browser / Fallback via IndexedDB
  console.log(`[Storage] Triggering Web/IndexedDB download for ${fileName} (${fileId})`);
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

export async function getStoredFile(id: string): Promise<StoredFile | null> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

// Convert Blob to base64 string
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // remove data:*/*;base64, prefix
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Open PDF in user's preferred native reader application:
 * - Desktop (Electron): shell.openPath() on temporary decrypted PDF
 * - Android (Capacitor): write to cache/documents directory & open with FileOpener
 * - Web fallback: open blob in new tab / native viewer
 */
export async function openFileWithNativeViewer(fileId: string, fileName: string): Promise<{ success: boolean; error?: string }> {
  // 1. Electron Desktop (.exe)
  if (window.electronAPI && window.electronAPI.openOfflinePdf) {
    try {
      console.log(`[Storage] Opening ${fileName} with Electron native viewer`);
      const res = await window.electronAPI.openOfflinePdf(fileId, fileName);
      if (res.success) return { success: true };
      return { success: false, error: res.error || 'تعذر فتح الملف في قارئ PDF الافتراضي' };
    } catch (e: any) {
      console.error('[Storage] Electron openOfflinePdf failed:', e);
      return { success: false, error: e.message || 'خطأ أثناء فتح الملف في ويندوز' };
    }
  }

  // 2. Android Native (.apk)
  if (Capacitor.isNativePlatform()) {
    try {
      console.log(`[Storage] Opening ${fileName} on Android via FileOpener`);
      const stored = await getStoredFile(fileId);
      if (!stored || !stored.blob) {
        return { success: false, error: 'الملف غير موجود في التخزين المحلي' };
      }

      // Safe filename with .pdf extension
      const safeName = (fileName || `${fileId}.pdf`).replace(/[/\\?%*:|"<>]/g, '_');
      const cleanFileName = safeName.endsWith('.pdf') ? safeName : `${safeName}.pdf`;

      // Convert stored blob to base64 for Filesystem
      const base64Data = await blobToBase64(stored.blob);

      // Write to app Cache directory
      const writeResult = await Filesystem.writeFile({
        path: cleanFileName,
        data: base64Data,
        directory: Directory.Cache,
        recursive: true
      });

      console.log(`[Storage] Written file to cache: ${writeResult.uri}`);

      // Open with native PDF reader app (Google Drive PDF Viewer, Adobe, etc.)
      await FileOpener.openFile({
        path: writeResult.uri,
        mimeType: 'application/pdf'
      });

      return { success: true };
    } catch (e: any) {
      console.error('[Storage] Android FileOpener error:', e);
      return { success: false, error: e.message || 'تعذر فتح الملف باستخدام قارئ PDF في هاتفك' };
    }
  }

  // 3. Web Browser Fallback
  try {
    const stored = await getStoredFile(fileId);
    if (stored && stored.blob) {
      const blobUrl = URL.createObjectURL(stored.blob);
      window.open(blobUrl, '_blank');
      return { success: true };
    }
    return { success: false, error: 'الملف غير موجود في التخزين المؤقت' };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// Read offline PDF as pure Uint8Array (preserving raw binary integrity, no string conversion)
export async function readOfflinePdfBinary(id: string): Promise<ReadPdfResult> {
  // 1. Electron IPC read
  if (window.electronAPI) {
    try {
      console.log(`[Storage] Reading offline PDF via Electron IPC for id: ${id}`);
      const res = await window.electronAPI.readOfflinePdf(id);
      if (res.success && res.data) {
        const rawBytes = res.data;
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
