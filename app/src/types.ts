export interface FileItem {
  id: string;
  semester: string;
  semesterId: string;
  subjectName: string;
  subjectId: string;
  chapter: string | null;
  fileName: string;
  fileType: string;
  fileUrl: string;
  viewUrl: string;
}

export interface SubjectNode {
  id: string;
  name: string;
  files: FileItem[];
}

export interface SemesterNode {
  id: string;
  name: string;
  subjects: SubjectNode[];
}

export type DownloadStatus = 'idle' | 'downloading' | 'downloaded' | 'error';
