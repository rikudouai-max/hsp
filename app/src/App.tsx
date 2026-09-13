import React, { useState, useEffect, useMemo, useTransition } from 'react';
import type { SemesterNode, SubjectNode, FileItem } from './types';
import localTreeData from './treeData.json';
import localDataList from './dataList.json';
import {
  downloadAndSaveFile,
  openFileWithNativeViewer,
  getAllStoredFileIds,
  deleteStoredFile,
  getTotalStorageUsed,
  formatBytes
} from './storage';

// Local storage keys
const KEY_FAVORITES = 'hsp_favorites';
const KEY_LAST_LOCATION = 'hsp_last_location';

interface LastLocation {
  view: 'home' | 'semester' | 'subject' | 'favorites' | 'storage';
  semesterId?: string;
  subjectId?: string;
}

export default function App() {
  const [tree, setTree] = useState<SemesterNode[]>(localTreeData as SemesterNode[]);
  const [allFiles, setAllFiles] = useState<FileItem[]>(localDataList as FileItem[]);
  const [loading] = useState(false);

  // Online / Offline Status
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);

  // Location / Navigation state
  const [currentView, setCurrentView] = useState<'home' | 'semester' | 'subject' | 'favorites' | 'storage'>('home');
  const [selectedSemester, setSelectedSemester] = useState<SemesterNode | null>(null);
  const [selectedSubject, setSelectedSubject] = useState<SubjectNode | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [, startTransition] = useTransition();

  // Downloaded file IDs cache (IndexedDB)
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  // Downloading file IDs in progress
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());

  // Favorites (array of file IDs)
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

  // Listen to network status
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      showToast('عاد الاتصال بالإنترنت. جاري مزامنة البيانات...');
      syncMetadata();
    };
    const handleOffline = () => {
      setIsOnline(false);
      showToast('أنت الآن غير متصل بالإنترنت. التطبيق يعمل في الوضع أوفلاين.');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Load tree and data on startup
  const syncMetadata = async () => {
    try {
      const res = await fetch('/tree.json?t=' + Date.now());
      if (res.ok) {
        const data: SemesterNode[] = await res.json();
        setTree(data);
        // Flatten files
        const list: FileItem[] = [];
        data.forEach((s) => s.subjects.forEach((sub) => list.push(...sub.files)));
        setAllFiles(list);
      }
    } catch (err) {
      console.log('Metadata fetch error (offline):', err);
    }
  };

  useEffect(() => {
    const loadInitialData = async () => {
      const data = localTreeData as SemesterNode[];
      // Restore last location from bundled data
      try {
        const rawLoc = localStorage.getItem(KEY_LAST_LOCATION);
        if (rawLoc) {
          const loc: LastLocation = JSON.parse(rawLoc);
          if (loc.view === 'favorites') {
            setCurrentView('favorites');
          } else if (loc.view === 'storage') {
            setCurrentView('storage');
          } else if (loc.view === 'semester' && loc.semesterId) {
            const foundSem = data.find((s) => s.id === loc.semesterId);
            if (foundSem) {
              setSelectedSemester(foundSem);
              setCurrentView('semester');
            }
          } else if (loc.view === 'subject' && loc.semesterId && loc.subjectId) {
            const foundSem = data.find((s) => s.id === loc.semesterId);
            if (foundSem) {
              const foundSub = foundSem.subjects.find((sub) => sub.id === loc.subjectId);
              if (foundSub) {
                setSelectedSemester(foundSem);
                setSelectedSubject(foundSub);
                setCurrentView('subject');
              }
            }
          }
        }
      } catch (e) {
        console.error('Failed to restore location', e);
      }
    };

    loadInitialData();
    refreshLocalDb();
  }, []);

  // Save last location whenever it changes
  useEffect(() => {
    const loc: LastLocation = {
      view: currentView,
      semesterId: selectedSemester?.id,
      subjectId: selectedSubject?.id
    };
    localStorage.setItem(KEY_LAST_LOCATION, JSON.stringify(loc));
  }, [currentView, selectedSemester, selectedSubject]);

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
  const downloadFile = async (file: FileItem, e?: React.MouseEvent) => {
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
      showToast('جاري بدء تحميل ' + file.fileName + '...');
      await downloadAndSaveFile(file.id, file.fileName);
      await refreshLocalDb();
      showToast('✓ تم تحميل وتخزين ' + file.fileName + ' داخل التطبيق بنجاح');
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

  // Download entire subject
  const downloadEntireSubject = async (subject: SubjectNode) => {
    if (!navigator.onLine) {
      showToast('لا يمكن تحميل المادة كاملة في وضع أوفلاين.');
      return;
    }

    const unDownloaded = subject.files.filter((f) => !downloadedIds.has(f.id));
    if (unDownloaded.length === 0) {
      showToast('جميع ملفات هذه المادة محملة بالفعل.');
      return;
    }

    showToast(`جاري تحميل ${unDownloaded.length} ملف للمادة...`);

    for (const file of unDownloaded) {
      await downloadFile(file);
    }
    showToast('✓ اكتمل تحميل ملفات المادة بنجاح!');
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

  // Open file handler (فتح الملف عبر قارئ الـ PDF الافتراضي للنظام بدون اتصال أو عبر الإنترنت)
  const handleOpenFile = async (file: FileItem) => {
    console.log('[App] Attempting to open file:', file.fileName, 'id:', file.id);

    // 1. If file is downloaded locally, open directly in native external reader
    if (downloadedIds.has(file.id)) {
      showToast('جاري فتح ' + file.fileName + ' في تطبيق قراءة الـ PDF...');
      const res = await openFileWithNativeViewer(file.id, file.fileName);
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
      await downloadAndSaveFile(file.id, file.fileName);
      await refreshLocalDb();
      setDownloadingIds((prev) => {
        const next = new Set(prev);
        next.delete(file.id);
        return next;
      });
      const res = await openFileWithNativeViewer(file.id, file.fileName);
      if (!res.success) {
        window.open(file.viewUrl, '_blank');
      }
    } catch (err: any) {
      console.error('[App] Online open error, falling back to browser tab:', err);
      window.open(file.viewUrl, '_blank');
    }
  };

  // Navigation helpers
  const goToHome = () => {
    setCurrentView('home');
    setSelectedSemester(null);
    setSelectedSubject(null);
    setSearchQuery('');
  };

  const goToSemester = (sem: SemesterNode) => {
    setSelectedSemester(sem);
    setSelectedSubject(null);
    setCurrentView('semester');
    setSearchQuery('');
  };

  const goToSubject = (sub: SubjectNode) => {
    setSelectedSubject(sub);
    setCurrentView('subject');
    setSearchQuery('');
  };

  // Filtered search results
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;

    const matchedSemesters = tree.filter((s) => s.name.toLowerCase().includes(q));
    const matchedSubjects: { semester: SemesterNode; subject: SubjectNode }[] = [];
    const matchedFiles: FileItem[] = [];

    tree.forEach((sem) => {
      sem.subjects.forEach((sub) => {
        if (sub.name.toLowerCase().includes(q)) {
          matchedSubjects.push({ semester: sem, subject: sub });
        }
        sub.files.forEach((f) => {
          if (
            f.fileName.toLowerCase().includes(q) ||
            (f.chapter && f.chapter.toLowerCase().includes(q)) ||
            f.subjectName.toLowerCase().includes(q)
          ) {
            matchedFiles.push(f);
          }
        });
      });
    });

    return {
      semesters: matchedSemesters,
      subjects: matchedSubjects,
      files: matchedFiles
    };
  }, [searchQuery, tree]);

  // Favorite file items
  const favoriteFiles = useMemo(() => {
    return allFiles.filter((f) => favorites.includes(f.id));
  }, [favorites, allFiles]);

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '80vh', gap: 16 }}>
        <div style={{ fontSize: '2rem' }}>⏳</div>
        <p style={{ color: '#94a3b8', fontSize: '1.1rem' }}>جاري تحميل محتوى تخصص حفظ الصحة...</p>
      </div>
    );
  }

  return (
    <>
      {/* App Header */}
      <header className="app-header">
        <div className="header-top">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: '1.4rem' }}>🏥</span>
            <span className="header-title" onClick={goToHome} style={{ cursor: 'pointer' }}>
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

        {/* Breadcrumb Navigation */}
        <div className="breadcrumb-bar">
          <span className={`breadcrumb-item ${currentView === 'home' && !searchQuery ? 'active' : ''}`} onClick={goToHome}>
            🏠 الرئيسية
          </span>

          {currentView === 'favorites' && (
            <>
              <span className="breadcrumb-sep">/</span>
              <span className="breadcrumb-item active">⭐ المفضلة</span>
            </>
          )}

          {currentView === 'storage' && (
            <>
              <span className="breadcrumb-sep">/</span>
              <span className="breadcrumb-item active">💾 التخزين المحلي</span>
            </>
          )}

          {selectedSemester && currentView !== 'favorites' && currentView !== 'storage' && (
            <>
              <span className="breadcrumb-sep">/</span>
              <span
                className={`breadcrumb-item ${currentView === 'semester' ? 'active' : ''}`}
                onClick={() => goToSemester(selectedSemester)}
              >
                {selectedSemester.name}
              </span>
            </>
          )}

          {selectedSubject && currentView === 'subject' && (
            <>
              <span className="breadcrumb-sep">/</span>
              <span className="breadcrumb-item active">{selectedSubject.name}</span>
            </>
          )}
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
            placeholder="ابحث عن سداسي، مادة، أو ملف..."
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

      {/* Main View Area */}
      <main style={{ flex: 1 }}>
        {/* Search Results Display */}
        {searchResults ? (
          <div style={{ padding: '0 16px' }}>
            <div className="section-header" style={{ padding: '0 0 12px' }}>
              <span className="section-title">نتائج البحث عن "{searchQuery}"</span>
            </div>

            {/* Matched Semesters */}
            {searchResults.semesters.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: '0.9rem', color: '#94a3b8', marginBottom: 8 }}>السداسيات:</h3>
                <div className="cards-grid" style={{ padding: 0 }}>
                  {searchResults.semesters.map((sem) => (
                    <div key={sem.id} className="card" onClick={() => goToSemester(sem)}>
                      <div className="card-content">
                        <div className="card-icon">📚</div>
                        <div className="card-info">
                          <div className="card-title">{sem.name}</div>
                          <div className="card-desc">{sem.subjects.length} مادة دراسية</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Matched Subjects */}
            {searchResults.subjects.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: '0.9rem', color: '#94a3b8', marginBottom: 8 }}>المواد:</h3>
                <div className="cards-grid" style={{ padding: 0 }}>
                  {searchResults.subjects.map(({ semester, subject }) => (
                    <div
                      key={subject.id}
                      className="card"
                      onClick={() => {
                        setSelectedSemester(semester);
                        goToSubject(subject);
                      }}
                    >
                      <div className="card-content">
                        <div className="card-icon">📂</div>
                        <div className="card-info">
                          <div className="card-title">{subject.name}</div>
                          <div className="card-desc">{semester.name} • {subject.files.length} ملف</div>
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

            {searchResults.semesters.length === 0 &&
              searchResults.subjects.length === 0 &&
              searchResults.files.length === 0 && (
                <div style={{ textAlign: 'center', padding: '40px 0', color: '#94a3b8' }}>
                  لا توجد نتائج مطابقة لبحثك
                </div>
              )}
          </div>
        ) : currentView === 'home' ? (
          /* Home Screen: Semesters List */
          <div>
            <div className="section-header">
              <span className="section-title">السداسيات الدراسية</span>
              <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>{tree.length} سداسيات</span>
            </div>

            <div className="cards-grid">
              {tree.map((sem) => {
                const totalFilesInSem = sem.subjects.reduce((sum, s) => sum + s.files.length, 0);
                return (
                  <div key={sem.id} className="card" onClick={() => goToSemester(sem)}>
                    <div className="card-content">
                      <div className="card-icon">🎓</div>
                      <div className="card-info">
                        <div className="card-title">{sem.name}</div>
                        <div className="card-desc">
                          {sem.subjects.length} مادة • {totalFilesInSem} ملف تعليمي
                        </div>
                      </div>
                    </div>
                    <div className="card-footer">
                      <span style={{ color: '#38bdf8' }}>استعراض المواد ↤</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : currentView === 'semester' && selectedSemester ? (
          /* Semester View: Subjects List */
          <div>
            <div className="section-header">
              <div>
                <span className="section-title">{selectedSemester.name}</span>
                <p style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 2 }}>اختر المادة لعرض ملفاتها</p>
              </div>
              <button className="btn btn-outline" onClick={goToHome}>
                السداسيات ↩
              </button>
            </div>

            <div className="cards-grid">
              {selectedSemester.subjects.map((subject) => {
                const isAllDownloaded =
                  subject.files.length > 0 && subject.files.every((f) => downloadedIds.has(f.id));

                return (
                  <div key={subject.id} className="card" onClick={() => goToSubject(subject)}>
                    <div className="card-content">
                      <div className="card-icon">📂</div>
                      <div className="card-info">
                        <div className="card-title">{subject.name}</div>
                        <div className="card-desc">{subject.files.length} ملف تعليمي</div>
                        {isAllDownloaded && (
                          <span className="badge-offline" style={{ display: 'inline-block', marginTop: 6 }}>
                            ✓ متوفرة أوفلاين بالكامل
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="card-footer">
                      <span style={{ color: '#38bdf8' }}>فتح المادة ↤</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : currentView === 'subject' && selectedSubject && selectedSemester ? (
          /* Subject View: Files List */
          <div style={{ padding: '0 16px' }}>
            <div className="section-header" style={{ padding: '0 0 12px' }}>
              <div>
                <span className="section-title">{selectedSubject.name}</span>
                <p style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 2 }}>
                  {selectedSemester.name} • {selectedSubject.files.length} ملف
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-primary"
                  onClick={() => downloadEntireSubject(selectedSubject)}
                  title="تحميل جميع ملفات المادة للاستخدام أوفلاين"
                >
                  📥 تحميل المادة كاملة
                </button>
                <button className="btn btn-outline" onClick={() => goToSemester(selectedSemester)}>
                  المواد ↩
                </button>
              </div>
            </div>

            {/* List of files in subject */}
            <div>
              {selectedSubject.files.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: '#94a3b8' }}>
                  لا توجد ملفات مرفوعة لهذه المادة حالياً
                </div>
              ) : (
                selectedSubject.files.map((file) => renderFileItem(file))
              )}
            </div>
          </div>
        ) : currentView === 'favorites' ? (
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
        ) : currentView === 'storage' ? (
          /* Storage Manager View */
          <div>
            <div className="section-header">
              <span className="section-title">💾 إدارة التخزين المحلي</span>
            </div>

            <div className="storage-card">
              <h3 style={{ fontSize: '1rem', color: '#f8fafc', marginBottom: 4 }}>المساحة المستخدمة حالياً</h3>
              <p style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                الملفات المخزنة في جهازك تعمل بالكامل دون اتصال بالإنترنت (Offline).
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
                        <div className="file-subpath">
                          {file.semester} • {file.subjectName}
                        </div>
                      </div>
                    </div>
                    <div className="file-actions">
                      <button className="btn btn-primary" onClick={() => handleOpenFile(file)}>
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
          className={`nav-tab ${currentView === 'home' || currentView === 'semester' || currentView === 'subject' ? 'active' : ''}`}
          onClick={goToHome}
        >
          <span className="nav-tab-icon">📚</span>
          <span>السداسيات</span>
        </button>

        <button
          className={`nav-tab ${currentView === 'favorites' ? 'active' : ''}`}
          onClick={() => {
            setCurrentView('favorites');
            setSearchQuery('');
          }}
        >
          <span className="nav-tab-icon">⭐</span>
          <span>المفضلة ({favorites.length})</span>
        </button>

        <button
          className={`nav-tab ${currentView === 'storage' ? 'active' : ''}`}
          onClick={() => {
            setCurrentView('storage');
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
          <button className="btn btn-primary" onClick={() => handleOpenFile(file)}>
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
            <button className="btn btn-outline" onClick={(e) => downloadFile(file, e)}>
              ⬇️ تحميل أوفلاين
            </button>
          )}
        </div>
      </div>
    );
  }
}
