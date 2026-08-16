export type RenderMode = "auto" | "structured" | "screenshot";

export type TaskStatus =
  | "queued"
  | "loading"
  | "stabilizing"
  | "extracting"
  | "rendering"
  | "needs_review"
  | "completed"
  | "failed"
  | "cancelled";

export interface ImportItem {
  url: string;
  title?: string;
  date?: string;
  mode?: RenderMode;
}

export interface TaskRecord {
  id: string;
  batchId: string;
  inputUrl: string;
  resolvedUrl: string | null;
  title: string | null;
  publishedDate: string | null;
  source: string | null;
  author: string | null;
  requestedMode: RenderMode;
  actualMode: Exclude<RenderMode, "auto"> | null;
  status: TaskStatus;
  outputPath: string | null;
  filename: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BatchRecord {
  id: string;
  name: string;
  total: number;
  createdAt: string;
}

export interface AppSettings {
  outputDirectory: string;
  standardMarginMm: number;
  screenshotDpi: number;
}

export interface TaskListResponse {
  tasks: TaskRecord[];
  settings: AppSettings;
}

export interface ExtractedMetadata {
  title: string | null;
  publishedDate: string | null;
  source: string | null;
  author: string | null;
  resolvedUrl: string;
}
