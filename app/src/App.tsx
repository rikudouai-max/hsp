import React, { useState, useEffect, useMemo, useTransition } from 'react';
import type { FolderNode, FileItem } from './types';
import fallbackCourses from './coursesData.json';
import {
  downloadAndSaveFile,
  openFileWithNativeViewer,
  getAllStoredFileIds,
  deleteStoredFile,
  getTotalStorageUsed,
  formatBytes
} from './storage';

// Local storage keys
const KEY_COURSES_CACHE = 'hsp_courses_cache_v2';
const KEY_FAVORITES = 'hsp_favorites';
const KEY_FOLDER_PATH = 'hsp_folder_path_v2';

// Remote GitHub raw URL for auto-updating courses catalog
const REMOTE_COURSES_URL = 'https://raw.githubusercontent.com/rikudouai-max/hsp/main/app/public/data/courses.json';

// Helper to count total files in a folder tree
function countFiles(folder: FolderNode): number {
  let count = folder.files?.length || 0;
  if (folder.subfolders) {
    for (const sub of folder.subfolders) {
      count += countFiles(sub);
    }
  }
  return count;
}

// Helper to recursively collect all files in a folder
function collectAllFiles(folders: FolderNode[], parentPath: string = ''): FileItem[] {
  const result: FileItem[] = [];
  for (const f of folders) {
    const currentPath = parentPath ? `${parentPath} • ${f.name}` : f.name;
    if (f.files) {
      for (const file of f.files) {
        result.push({
          id: file.id,
          fileName: file.title,
          chapter: file.chapter || null,
          subjectName: currentPath,
          fileUrl: file.url,
          viewUrl: file.viewUrl
        });
      }
    }
    if (f.subfolders && f.subfolders.length > 0) {
      result.push(...collectAllFiles(f.subfolders, currentPath));
    }
  }
  return result;
}

export default function App() {
  // Dynamic Folder Tree
  const [coursesTree, setCoursesTree] = useState<FolderNode[]>(() => {
    try {
      const cached = localStorage.getItem(KEY_COURSES_CACHE);
      if (cached) return JSON.parse(cached);
    } catch (e) {
      console.error('Error reading cached courses:', e);
    }
    return fallbackCourses as FolderNode[];
  });

  // Dynamic Navigation Path (Stack of opened folder IDs)
  const [folderPath, setFolderPath] = useState<string[]>(() => {
    try {
      const savedPath = localStorage.getItem(KEY_FOLDER_PATH);
      return savedPath ? JSON.parse(savedPath) : [];
    } catch {
      return [];
    }
  });

  // Tab Navigation state
  const [currentTab, setCurrentTab] = useState<'folders' | 'favorites' | 'storage'>('folders');

  // Online / Offline Status
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [, startTransition] = useTransition();

  // Downloaded file IDs cache (IndexedDB)
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  // Downloading file IDs in progress
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());

  // Favorites
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(KEY_FAVORITES);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Storage stats
  const [storageStats, setStorageStats] = useState<{ totalBytes: number; count: number }>({ totalBytes: 0, count: 0 });

  // Toast Notification
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev));
    }, 3500);
  };

  // Flattened all files for search and storage view
  const allFiles = useMemo(() => {
    return collectAllFiles(coursesTree);
  }, [coursesTree]);

  // Favorite file items
  const favoriteFiles = useMemo(() => {
    return allFiles.filter((f) => favorites.includes(f.id));
  }, [favorites, allFiles]);

  // Network listener & auto sync
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      showToast('عاد الاتصال بالإنترنت. جاري مزامنة المجلدات...');
      fetchRemoteCourses();
    };
    const handleOffline = () => {
      setIsOnline(false);
      showToast('أنت الآن غير متصل بالإنترنت. يعمل التطبيق بكامل طاقته أوفلاين.');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Fetch remote courses.json and update cache
  const fetchRemoteCourses = async () => {
    try {
      // Try local deployed asset first (immediate update), fallback to GitHub raw
      let fetched = false;
      try {
        const localRes = await fetch('/data/courses.json?t=' + Date.now());
        if (localRes.ok) {
          const data: FolderNode[] = await localRes.json();
          if (Array.isArray(data) && data.length > 0) {
            setCoursesTree(data);
            localStorage.setItem(KEY_COURSES_CACHE, JSON.stringify(data));
            fetched = true;
          }
        }
      } catch (err) {
        console.log('Local courses.json fetch error, trying GitHub raw:', err);
      }

      if (!fetched && navigator.onLine) {
        const remoteRes = await fetch(REMOTE_COURSES_URL + '?t=' + Date.now());
        if (remoteRes.ok) {
          const data: FolderNode[] = await remoteRes.json();
          if (Array.isArray(data) && data.length > 0) {
            setCoursesTree(data);
            localStorage.setItem(KEY_COURSES_CACHE, JSON.stringify(data));
            showToast('✓ تم تحديث هيكل المجلدات بنجاح من الخادم');
          }
        }
      }
    } catch (err) {
      console.log('Courses sync failed (using local cache):', err);
    }
  };

  // Initial load
  useEffect(() => {
    fetchRemoteCourses();
    refreshLocalDb();
  }, []);

  // Save current folder path
  useEffect(() => {
    localStorage.setItem(KEY_FOLDER_PATH, JSON.stringify(folderPath));
  }, [folderPath]);

  // Refresh IndexedDB state
  const refreshLocalDb = async () => {
    try {
      const ids = await getAllStoredFileIds();
      setDownloadedIds(ids);
      const stats = await getTotalStorageUsed();
      setStorageStats(stats);
    } catch (e) {
      console.error('Failed to refresh IndexedDB', e);
    }
  };

  // Toggle favorite
  const toggleFavorite = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      localStorage.setItem(KEY_FAVORITES, JSON.stringify(next));
      return next;
    });
  };

  // Download a single file
  const downloadFile = async (file: { id: string; title: string; url?: string }, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (downloadedIds.has(file.id)) {
      showToast('الملف تم تحميله بالفعل وهو متوفر أوفلاين.');
      return;
    }

    if (!navigator.onLine) {
      showToast('لا يمكن التحميل الآن لأنك غير متصل بالإنترنت.');
      return;
    }

    setDownloadingIds((prev) => new Set(prev).add(file.id));

    try {
      showToast('جاري بدء تحميل ' + file.title + '...');
      await downloadAndSaveFile(file.id, file.title, file.url);
      await refreshLocalDb();
      showToast('✓ تم تحميل وتخزين ' + file.title + ' داخل التطبيق بنجاح');
    } catch (err: any) {
      console.error('Download error:', err);
      showToast('تعذر تحميل الملف: ' + (err.message || 'خطأ في الاتصال'));
    } finally {
      setDownloadingIds((prev) => {
        const next = new Set(prev);
        next.delete(file.id);
        return next;
      });
    }
  };

  // Download all files in a folder recursively
  const downloadEntireFolder = async (folder: FolderNode) => {
    if (!navigator.onLine) {
      showToast('لا يمكن تحميل المجلد في وضع أوفلاين.');
      return;
    }

    const folderFiles = collectAllFiles([folder]);
    const unDownloaded = folderFiles.filter((f) => !downloadedIds.has(f.id));

    if (unDownloaded.length === 0) {
      showToast('جميع ملفات هذا المجلد محملة بالفعل.');
      return;
    }

    showToast(`جاري تحميل ${unDownloaded.length} ملف...`);

    for (const file of unDownloaded) {
      await downloadFile({ id: file.id, title: file.fileName, url: file.fileUrl });
    }
    showToast('✓ اكتمل تحميل ملفات المجلد بنجاح!');
  };

  // Delete local copy
  const removeLocalCopy = async (fileId: string, fileName: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      await deleteStoredFile(fileId);
      await refreshLocalDb();
      showToast(`تم حذف النسخة المحلية لـ ${fileName}`);
    } catch (err) {
      console.error('Delete error:', err);
    }
  };

  // Open file handler (فتح الملف عبر قارئ الـ PDF الافتراضي للنظام)
  const handleOpenFile = async (file: { id: string; title: string; url?: string; viewUrl?: string }) => {
    console.log('[App] Opening file:', file.title, 'id:', file.id);

    // 1. If file is downloaded locally, open in native external reader
    if (downloadedIds.has(file.id)) {
      showToast('جاري فتح ' + file.title + ' في قارئ الـ PDF...');
      const res = await openFileWithNativeViewer(file.id, file.title);
      if (!res.success) {
        showToast('⚠️ ' + (res.error || 'تعذر فتح الملف'));
      }
      return;
    }

    // 2. If not stored locally and device is offline:
    if (!navigator.onLine) {
      console.warn('[App] File not downloaded and device is offline');
      showToast('هذا الملف غير متوفر أوفلاين. اتصل بالإنترنت لتحميله.');
      return;
    }

    // 3. If online, auto-download for fast native opening or fallback to viewUrl
    try {
      showToast('جاري تحضير الملف وفتحه في قارئ الـ PDF...');
      setDownloadingIds((prev) => new Set(prev).add(file.id));
      await downloadAndSaveFile(file.id, file.title, file.url);
      await refreshLocalDb();
      setDownloadingIds((prev) => {
        const next = new Set(prev);
        next.delete(file.id);
        return next;
      });
      const res = await openFileWithNativeViewer(file.id, file.title);
      if (!res.success) {
        window.open(file.viewUrl || file.url, '_blank');
      }
    } catch (err: any) {
      console.error('[App] Online open error, falling back to browser tab:', err);
      window.open(file.viewUrl || file.url, '_blank');
    }
  };

  // Resolve current active folder and breadcrumb chain
  const { currentFolder, breadcrumbChain } = useMemo(() => {
    const chain: FolderNode[] = [];
    let currentList: FolderNode[] = coursesTree;
    let curr: FolderNode | null = null;

    for (const stepId of folderPath) {
      const found = currentList.find((f) => f.id === stepId);
      if (found) {
        chain.push(found);
        curr = found;
        currentList = found.subfolders || [];
      } else {
        break;
      }
    }

    return { currentFolder: curr, breadcrumbChain: chain };
  }, [coursesTree, folderPath]);

  // Navigate to folder
  const openFolder = (folderId: string) => {
    setFolderPath((prev) => [...prev, folderId]);
    setSearchQuery('');
  };

  // Navigate to specific index in breadcrumb chain
  const navigateToBreadcrumb = (index: number) => {
    if (index < 0) {
      setFolderPath([]);
    } else {
      setFolderPath((prev) => prev.slice(0, index + 1));
    }
    setSearchQuery('');
  };

  // Filtered search results across all folders & files
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;

    const matchedFolders: { folder: FolderNode; path: string }[] = [];
    const matchedFiles: FileItem[] = [];

    function searchRecursively(folders: FolderNode[], pathStr: string = '') {
      for (const f of folders) {
        const fullPath = pathStr ? `${pathStr} > ${f.name}` : f.name;
        if (f.name.toLowerCase().includes(q)) {
          matchedFolders.push({ folder: f, path: fullPath });
        }
        if (f.files) {
          for (const file of f.files) {
            if (
              file.title.toLowerCase().includes(q) ||
              (file.chapter && file.chapter.toLowerCase().includes(q)) ||
              f.name.toLowerCase().includes(q)
            ) {
              matchedFiles.push({
                id: file.id,
                fileName: file.title,
                chapter: file.chapter || null,
                subjectName: fullPath,
                fileUrl: file.url,
                viewUrl: file.viewUrl
              });
            }
          }
        }
        if (f.subfolders && f.subfolders.length > 0) {
          searchRecursively(f.subfolders, fullPath);
        }
      }
    }

    searchRecursively(coursesTree);

    return {
      folders: matchedFolders,
      files: matchedFiles
    };
  }, [searchQuery, coursesTree]);

  return (
    <>
      {/* App Header */}
      <header className="app-header">
        <div className="header-top">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: '1.4rem' }}>🏥</span>
            <span className="header-title" onClick={() => { setFolderPath([]); setCurrentTab('folders'); setSearchQuery(''); }} style={{ cursor: 'pointer' }}>
              مختص في حفظ الصحة
            </span>
          </div>
          <div className="header-status">
            {isOnline ? (
              <span className="status-badge status-online">
                <span>●</span> متصل
              </span>
            ) : (
              <span className="status-badge status-offline">
                <span>○</span> أوفلاين
              </span>
            )}
          </div>
        </div>

        {/* Dynamic Breadcrumb Navigation */}
        <div className="breadcrumb-bar">
          <span
            className={`breadcrumb-item ${folderPath.length === 0 && currentTab === 'folders' && !searchQuery ? 'active' : ''}`}
            onClick={() => { setFolderPath([]); setCurrentTab('folders'); setSearchQuery(''); }}
          >
            🏠 الرئيسية
          </span>

          {currentTab === 'favorites' && (
            <>
              <span className="breadcrumb-sep">/</span>
              <span className="breadcrumb-item active">⭐ المفضلة</span>
            </>
          )}

          {currentTab === 'storage' && (
            <>
              <span className="breadcrumb-sep">/</span>
              <span className="breadcrumb-item active">💾 التخزين المحلي</span>
            </>
          )}

          {currentTab === 'folders' &&
            breadcrumbChain.map((f, idx) => {
              const isLast = idx === breadcrumbChain.length - 1;
              return (
                <React.Fragment key={f.id}>
                  <span className="breadcrumb-sep">/</span>
                  <span
                    className={`breadcrumb-item ${isLast ? 'active' : ''}`}
                    onClick={() => navigateToBreadcrumb(idx)}
                  >
                    {f.name}
                  </span>
                </React.Fragment>
              );
            })}
        </div>
      </header>

      {/* Global Toast Alert */}
      {toast && <div className="toast-msg">{toast}</div>}

      {/* Search Bar */}
      <div className="search-container">
        <div className="search-input-wrap">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            className="search-input"
            placeholder="ابحث في جميع المجلدات والملفات والمحاضرات..."
            value={searchQuery}
            onChange={(e) => startTransition(() => setSearchQuery(e.target.value))}
          />
          {searchQuery && (
            <button className="search-clear" onClick={() => setSearchQuery('')}>
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Main Dynamic View */}
      <main style={{ flex: 1 }}>
        {/* Search Results */}
        {searchResults ? (
          <div style={{ padding: '0 16px' }}>
            <div className="section-header" style={{ padding: '0 0 12px' }}>
              <span className="section-title">نتائج البحث عن "{searchQuery}"</span>
            </div>

            {/* Matched Folders */}
            {searchResults.folders.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: '0.9rem', color: '#94a3b8', marginBottom: 8 }}>المجلدات:</h3>
                <div className="cards-grid" style={{ padding: 0 }}>
                  {searchResults.folders.map(({ folder, path }) => (
                    <div
                      key={folder.id}
                      className="card"
                      onClick={() => {
                        setFolderPath([folder.id]);
                        setCurrentTab('folders');
                        setSearchQuery('');
                      }}
                    >
                      <div className="card-content">
                        <div className="card-icon">📂</div>
                        <div className="card-info">
                          <div className="card-title">{folder.name}</div>
                          <div className="card-desc">{path}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Matched Files */}
            {searchResults.files.length > 0 && (
              <div>
                <h3 style={{ fontSize: '0.9rem', color: '#94a3b8', marginBottom: 8 }}>الملفات ({searchResults.files.length}):</h3>
                {searchResults.files.map((file) => renderFileItem(file))}
              </div>
            )}

            {searchResults.folders.length === 0 && searchResults.files.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#94a3b8' }}>
                لا توجد نتائج مطابقة لبحثك
              </div>
            )}
          </div>
        ) : currentTab === 'folders' ? (
          /* Dynamic Folder / File Browser */
          <div>
            {currentFolder ? (
              /* Inside a Folder */
              <div style={{ padding: '0 16px' }}>
                <div className="section-header" style={{ padding: '0 0 12px' }}>
                  <div>
                    <span className="section-title">{currentFolder.name}</span>
                    <p style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 2 }}>
                      {(currentFolder.subfolders?.length || 0)} مجلد فرعي • {(currentFolder.files?.length || 0)} ملف
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(currentFolder.files?.length || 0) > 0 && (
                      <button
                        className="btn btn-primary"
                        onClick={() => downloadEntireFolder(currentFolder)}
                        title="تحميل جميع ملفات المجلد للاستخدام أوفلاين"
                      >
                        📥 تحميل الكل
                      </button>
                    )}
                    <button
                      className="btn btn-outline"
                      onClick={() => navigateToBreadcrumb(breadcrumbChain.length - 2)}
                    >
                      رجوع ↩
                    </button>
                  </div>
                </div>

                {/* Subfolders list if any */}
                {currentFolder.subfolders && currentFolder.subfolders.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div className="cards-grid" style={{ padding: 0 }}>
                      {currentFolder.subfolders.map((sub) => {
                        const count = countFiles(sub);
                        return (
                          <div key={sub.id} className="card" onClick={() => openFolder(sub.id)}>
                            <div className="card-content">
                              <div className="card-icon">📁</div>
                              <div className="card-info">
                                <div className="card-title">{sub.name}</div>
                                <div className="card-desc">
                                  {(sub.subfolders?.length || 0) > 0 ? `${sub.subfolders?.length} مجلد فرعي • ` : ''}
                                  {count} ملف متوفر
                                </div>
                              </div>
                            </div>
                            <div className="card-footer">
                              <span style={{ color: '#38bdf8' }}>فتح المجلد ↤</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Files list */}
                <div>
                  {(!currentFolder.files || currentFolder.files.length === 0) &&
                  (!currentFolder.subfolders || currentFolder.subfolders.length === 0) ? (
                    <div style={{ textAlign: 'center', padding: '40px 0', color: '#94a3b8' }}>
                      المجلد فارغ حالياً
                    </div>
                  ) : (
                    currentFolder.files?.map((f) =>
                      renderFileItem({
                        id: f.id,
                        fileName: f.title,
                        chapter: f.chapter,
                        subjectName: currentFolder.name,
                        fileUrl: f.url,
                        viewUrl: f.viewUrl
                      })
                    )
                  )}
                </div>
              </div>
            ) : (
              /* Root Folders List */
              <div>
                <div className="section-header">
                  <span className="section-title">المحتوى الدراسي والمجلدات</span>
                  <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>{coursesTree.length} أقسام رئيسية</span>
                </div>

                <div className="cards-grid">
                  {coursesTree.map((folder) => {
                    const totalFilesInFolder = countFiles(folder);
                    return (
                      <div key={folder.id} className="card" onClick={() => openFolder(folder.id)}>
                        <div className="card-content">
                          <div className="card-icon">🎓</div>
                          <div className="card-info">
                            <div className="card-title">{folder.name}</div>
                            <div className="card-desc">
                              {(folder.subfolders?.length || 0) > 0 ? `${folder.subfolders?.length} مادة ومجلد • ` : ''}
                              {totalFilesInFolder} ملف ومحاضرة
                            </div>
                          </div>
                        </div>
                        <div className="card-footer">
                          <span style={{ color: '#38bdf8' }}>تصفح المحتويات ↤</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : currentTab === 'favorites' ? (
          /* Favorites View */
          <div style={{ padding: '0 16px' }}>
            <div className="section-header" style={{ padding: '0 0 12px' }}>
              <span className="section-title">⭐ الملفات المفضلة ({favoriteFiles.length})</span>
            </div>
            {favoriteFiles.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '50px 0', color: '#94a3b8' }}>
                <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>⭐</div>
                <p>لم تقم بإضافة أي ملفات إلى المفضلة بعد.</p>
                <p style={{ fontSize: '0.85rem', marginTop: 4 }}>اضغط على رمز النجمة بجانب أي ملف لإضافته هنا.</p>
              </div>
            ) : (
              favoriteFiles.map((file) => renderFileItem(file))
            )}
          </div>
        ) : currentTab === 'storage' ? (
          /* Storage Manager View */
          <div>
            <div className="section-header">
              <span className="section-title">💾 إدارة التخزين المحلي</span>
            </div>

            <div className="storage-card">
              <h3 style={{ fontSize: '1rem', color: '#f8fafc', marginBottom: 4 }}>المساحة المستخدمة حالياً</h3>
              <p style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                الملفات المحملة تعمل بالكامل بدون اتصال بالإنترنت وتُفتح في قارئ الـ PDF الخاص بجهازك.
              </p>

              <div className="storage-bar-bg">
                <div
                  className="storage-bar-fill"
                  style={{
                    width: `${Math.min(100, Math.max(5, (storageStats.totalBytes / (50 * 1024 * 1024)) * 100))}%`
                  }}
                ></div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', fontWeight: 600 }}>
                <span>المساحة المستهلكة: {formatBytes(storageStats.totalBytes)}</span>
                <span>عدد الملفات: {storageStats.count}</span>
              </div>
            </div>

            <div style={{ padding: '0 16px' }}>
              <h3 style={{ fontSize: '0.95rem', color: '#e2e8f0', marginBottom: 10 }}>
                الملفات المتوفرة أوفلاين:
              </h3>

              {allFiles
                .filter((f) => downloadedIds.has(f.id))
                .map((file) => (
                  <div key={file.id} className="file-item">
                    <div className="file-header">
                      <div className="file-icon-wrap">PDF</div>
                      <div className="file-details">
                        <div className="file-title">{file.fileName}</div>
                        <div className="file-subpath">{file.subjectName}</div>
                      </div>
                    </div>
                    <div className="file-actions">
                      <button className="btn btn-primary" onClick={() => handleOpenFile({ id: file.id, title: file.fileName, url: file.fileUrl })}>
                        📖 قراءة
                      </button>
                      <button
                        className="btn btn-danger"
                        onClick={(e) => removeLocalCopy(file.id, file.fileName, e)}
                      >
                        🗑️ حذف النسخة المحلية
                      </button>
                    </div>
                  </div>
                ))}

              {storageStats.count === 0 && (
                <div style={{ textAlign: 'center', padding: '40px 0', color: '#94a3b8' }}>
                  لا توجد ملفات محملة أوفلاين حالياً.
                </div>
              )}
            </div>
          </div>
        ) : null}
      </main>

      {/* Bottom Navigation Bar */}
      <nav className="bottom-nav">
        <button
          className={`nav-tab ${currentTab === 'folders' ? 'active' : ''}`}
          onClick={() => {
            setCurrentTab('folders');
            setSearchQuery('');
          }}
        >
          <span className="nav-tab-icon">📂</span>
          <span>المجلدات</span>
        </button>

        <button
          className={`nav-tab ${currentTab === 'favorites' ? 'active' : ''}`}
          onClick={() => {
            setCurrentTab('favorites');
            setSearchQuery('');
          }}
        >
          <span className="nav-tab-icon">⭐</span>
          <span>المفضلة ({favorites.length})</span>
        </button>

        <button
          className={`nav-tab ${currentTab === 'storage' ? 'active' : ''}`}
          onClick={() => {
            setCurrentTab('storage');
            setSearchQuery('');
          }}
        >
          <span className="nav-tab-icon">💾</span>
          <span>التخزين ({storageStats.count})</span>
        </button>
      </nav>

      {/* Professional Copyright Footer */}
      <footer className="app-footer">
        <p className="footer-copyright">
          جميع الحقوق محفوظة | حميدوش عبدالتواب - مختص في حفظ الصحة
        </p>
      </footer>
    </>
  );

  // Helper render for single file item
  function renderFileItem(file: FileItem) {
    const isDownloaded = downloadedIds.has(file.id);
    const isDownloading = downloadingIds.has(file.id);
    const isFav = favorites.includes(file.id);

    return (
      <div key={file.id} className="file-item">
        <div className="file-header">
          <div className="file-icon-wrap">PDF</div>
          <div className="file-details">
            <div className="file-title">{file.fileName}</div>
            <div className="file-subpath">
              {file.subjectName}
              {file.chapter ? ` • ${file.chapter}` : ''}
            </div>
            <div className="file-badge-row">
              {isDownloading ? (
                <span className="badge-downloading">⬇️ جاري التحميل...</span>
              ) : isDownloaded ? (
                <span className="badge-offline">✓ متوفر أوفلاين</span>
              ) : (
                <span className="badge-online">☁️ أونلاين</span>
              )}
            </div>
          </div>
          <button
            className={`btn-fav ${isFav ? 'active' : ''}`}
            onClick={(e) => toggleFavorite(file.id, e)}
            title={isFav ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'}
          >
            {isFav ? '★' : '☆'}
          </button>
        </div>

        <div className="file-actions">
          <button
            className="btn btn-primary"
            onClick={() => handleOpenFile({ id: file.id, title: file.fileName, url: file.fileUrl, viewUrl: file.viewUrl })}
          >
            📖 قراءة
          </button>

          {isDownloading ? (
            <button className="btn btn-outline" disabled>
              ⏳ جاري التحميل...
            </button>
          ) : isDownloaded ? (
            <button
              className="btn btn-danger"
              onClick={(e) => removeLocalCopy(file.id, file.fileName, e)}
            >
              🗑️ حذف النسخة المحلية
            </button>
          ) : (
            <button
              className="btn btn-outline"
              onClick={(e) => downloadFile({ id: file.id, title: file.fileName, url: file.fileUrl }, e)}
            >
              ⬇️ تحميل أوفلاين
            </button>
          )}
        </div>
      </div>
    );
  }
}
