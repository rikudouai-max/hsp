export interface CourseFile {
  id: string;
  title: string;
  chapter?: string | null;
  url: string;
  viewUrl?: string;
}

export interface FolderNode {
  id: string;
  name: string;
  subfolders?: FolderNode[];
  files?: CourseFile[];
}

// Backward compatibility alias & helpers
export interface FileItem {
  id: string;
  semester?: string;
  semesterId?: string;
  subjectName?: string;
  subjectId?: string;
  chapter?: string | null;
  fileName: string;
  fileType?: string;
  fileUrl: string;
  viewUrl?: string;
}

export type DownloadStatus = 'idle' | 'downloading' | 'downloaded' | 'error';
