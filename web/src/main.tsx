import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type RenderMode = "auto" | "structured" | "screenshot";
type TaskStatus =
  | "queued" | "loading" | "stabilizing" | "extracting" | "rendering"
  | "needs_review" | "completed" | "failed" | "cancelled";

interface Task {
  id: string;
  inputUrl: string;
  resolvedUrl: string | null;
  title: string | null;
  publishedDate: string | null;
  source: string | null;
  requestedMode: RenderMode;
  actualMode: Exclude<RenderMode, "auto"> | null;
  status: TaskStatus;
  filename: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

interface Settings {
  outputDirectory: string;
  standardMarginMm: number;
  screenshotDpi: number;
}

interface Health {
  edgeAvailable: boolean;
  edgePath: string | null;
}

interface ParsedInput {
  urls: string[];
  duplicates: number;
  invalid: string[];
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "等待处理",
  loading: "加载网页",
  stabilizing: "加载图文",
  extracting: "识别信息",
  rendering: "生成 PDF",
  needs_review: "需要确认",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

const COLLAPSED_TASK_LIMIT = 3;
const ATTENTION_TASK_STATUSES = new Set<TaskStatus>([
  "queued", "loading", "stabilizing", "extracting", "rendering", "needs_review"
]);

function App(): React.ReactElement {
  const [rawUrls, setRawUrls] = useState("");
  const [batchName, setBatchName] = useState("");
  const [mode, setMode] = useState<RenderMode>("auto");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [outputDirectory, setOutputDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const parsed = useMemo(() => parseUrlLines(rawUrls), [rawUrls]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const initialize = async (): Promise<void> => {
      try {
        await api("/api/session");
        const healthResult = await api<Health>("/api/health");
        if (active) setHealth(healthResult);
        const refresh = async (): Promise<void> => {
          const result = await api<{ tasks: Task[]; settings: Settings }>("/api/tasks");
          if (!active) return;
          setTasks(result.tasks);
          setSettings(result.settings);
          setOutputDirectory((current) => current || result.settings.outputDirectory);
        };
        await refresh();
        timer = window.setInterval(() => void refresh().catch(() => undefined), 1500);
      } catch (error) {
        if (active) setMessage(errorMessage(error));
      }
    };
    void initialize();
    return () => {
      active = false;
      if (timer) window.clearInterval(timer);
    };
  }, []);

  const summary = useMemo(() => ({
    active: tasks.filter((task) => ["queued", "loading", "stabilizing", "extracting", "rendering"].includes(task.status)).length,
    review: tasks.filter((task) => task.status === "needs_review").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length
  }), [tasks]);

  const collapsedTasks = useMemo(() => {
    if (tasks.length <= COLLAPSED_TASK_LIMIT) return tasks;
    const attentionTasks = tasks.filter((task) => ATTENTION_TASK_STATUSES.has(task.status));
    const historyTasks = tasks.filter((task) => !ATTENTION_TASK_STATUSES.has(task.status));
    return [...attentionTasks, ...historyTasks].slice(0, COLLAPSED_TASK_LIMIT);
  }, [tasks]);
  const visibleTasks = historyExpanded ? tasks : collapsedTasks;
  const hiddenTaskCount = tasks.length - visibleTasks.length;

  const submitBatch = async (): Promise<void> => {
    if (parsed.urls.length === 0) {
      setMessage("请至少输入一个有效网址。");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ accepted: number; rejected: Array<{ reason: string }> }>("/api/batches", {
        method: "POST",
        body: JSON.stringify({
          name: batchName || undefined,
          mode,
          items: parsed.urls.map((url) => ({ url }))
        })
      });
      setRawUrls("");
      setBatchName("");
      setMessage(`已加入 ${result.accepted} 个任务${result.rejected.length ? `，另有 ${result.rejected.length} 个未导入` : ""}。`);
      await refreshTasks(setTasks, setSettings);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const selectDirectory = async (): Promise<void> => {
    try {
      const result = await api<{ cancelled: boolean; settings: Settings }>("/api/settings/select-output-directory", {
        method: "POST",
        body: "{}"
      });
      setSettings(result.settings);
      setOutputDirectory(result.settings.outputDirectory);
      if (!result.cancelled) setMessage("PDF 保存目录已更新。");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const setMargin = async (marginMm: 5 | 8): Promise<void> => {
    try {
      const result = await api<Settings>("/api/settings/margin", {
        method: "PATCH",
        body: JSON.stringify({ marginMm })
      });
      setSettings(result);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const openExtensionDirectory = async (): Promise<void> => {
    try {
      await api("/api/open-extension", { method: "POST", body: "{}" });
      setMessage("已打开离线扩展目录。仅在普通采集失败时，按“安装说明”加载扩展。");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const shutdown = async (): Promise<void> => {
    if (!window.confirm("确定退出宣传记录助手吗？正在处理的任务会在下次启动后继续。")) return;
    try {
      await api("/api/shutdown", { method: "POST", body: "{}" });
      document.body.innerHTML = '<main class="shutdown-screen"><h1>宣传记录助手已退出</h1><p>现在可以关闭此浏览器页面。</p></main>';
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  return (
    <div className="app-shell">
      <header className="hero">
        <img className="hero-mark" src="/app-icon.svg" alt="宣传记录助手图标" />
        <div>
          <p className="eyebrow">本地宣传材料归档</p>
          <h1>宣传记录助手</h1>
          <p className="hero-copy">粘贴新闻网址，保留媒体品牌、正文和图片，自动生成规范命名的 A4 PDF。</p>
        </div>
        <div className="hero-actions">
          <div className={`edge-state ${health?.edgeAvailable ? "ready" : "warning"}`}>
            <span className="state-dot" />
            {health?.edgeAvailable ? "本地渲染就绪" : "未检测到系统渲染引擎"}
          </div>
          <button className="text-button" onClick={() => void shutdown()}>退出程序</button>
        </div>
      </header>

      <main>
        {message && <div className="notice" role="status">{message}<button onClick={() => setMessage(null)}>×</button></div>}

        <section className="panel create-panel">
          <div className="section-heading">
            <div><span className="step">01</span><h2>添加文章网址</h2></div>
            <span className="muted">每行一个，最多 500 条</span>
          </div>
          <textarea
            value={rawUrls}
            onChange={(event) => setRawUrls(event.target.value)}
            placeholder={"https://news.example.com/article-1\nhttps://mp.weixin.qq.com/s/..."}
            rows={7}
          />
          <div className="parse-summary">
            <span><strong>{parsed.urls.length}</strong> 个有效网址</span>
            {parsed.duplicates > 0 && <span>{parsed.duplicates} 个重复</span>}
            {parsed.invalid.length > 0 && <span className="danger">{parsed.invalid.length} 个格式错误</span>}
          </div>
          <div className="form-grid">
            <label>
              <span>批次名称（可选）</span>
              <input value={batchName} onChange={(event) => setBatchName(event.target.value)} placeholder="例如：2026 年 8 月宣传材料" />
            </label>
            <label>
              <span>生成模式</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as RenderMode)}>
                <option value="auto">原网页高保真（推荐）</option>
                <option value="screenshot">原网页截图 PDF</option>
                <option value="structured">可搜索文字 PDF（备用）</option>
              </select>
            </label>
          </div>
          <button className="primary-button" disabled={busy || parsed.urls.length === 0 || !health?.edgeAvailable} onClick={() => void submitBatch()}>
            {busy ? "正在加入…" : `加入处理队列${parsed.urls.length ? `（${parsed.urls.length}）` : ""}`}
          </button>
        </section>

        <section className="panel settings-panel">
          <div className="section-heading">
            <div><span className="step">02</span><h2>输出设置</h2></div>
            <div className="heading-actions">
              <button className="text-button" onClick={() => void openExtensionDirectory()}>离线扩展目录</button>
              <button className="text-button" onClick={() => void api("/api/open-output", { method: "POST" })}>打开输出目录</button>
            </div>
          </div>
          <div className="directory-row">
            <input value={outputDirectory} readOnly aria-label="PDF 保存目录" />
            <button className="secondary-button" onClick={() => void selectDirectory()}>选择文件夹…</button>
          </div>
          <div className="margin-choice">
            <span>页面边距</span>
            <button className={settings?.standardMarginMm === 8 ? "selected" : ""} onClick={() => void setMargin(8)}>8 mm 标准</button>
            <button className={settings?.standardMarginMm === 5 ? "selected" : ""} onClick={() => void setMargin(5)}>5 mm 紧凑</button>
            <small>截图模式：{settings?.screenshotDpi ?? 300} DPI</small>
          </div>
        </section>

        <section className="tasks-section">
          <div className="section-heading task-heading">
            <div><span className="step">03</span><h2>处理记录</h2></div>
            <div className="task-heading-tools">
              <div className="summary-cards">
                <span>处理中 <b>{summary.active}</b></span>
                <span>待确认 <b>{summary.review}</b></span>
                <span>已完成 <b>{summary.completed}</b></span>
                <span>失败 <b>{summary.failed}</b></span>
              </div>
              {tasks.length > COLLAPSED_TASK_LIMIT && (
                <button
                  className="history-toggle"
                  type="button"
                  aria-expanded={historyExpanded}
                  aria-controls="task-history"
                  onClick={() => setHistoryExpanded((expanded) => !expanded)}
                >
                  {historyExpanded ? "收起记录" : `展开全部（${tasks.length}）`}
                </button>
              )}
            </div>
          </div>
          {tasks.length === 0 ? (
            <div className="empty-state"><span>尚无任务</span><p>上方粘贴网址后，处理记录会显示在这里。</p></div>
          ) : (
            <>
              <div className="task-list" id="task-history">
                {visibleTasks.map((task) => <TaskCard key={task.id} task={task} onChanged={() => refreshTasks(setTasks, setSettings)} />)}
              </div>
              {tasks.length > COLLAPSED_TASK_LIMIT && (
                <div className="history-footer">
                  <span>{historyExpanded ? `已显示全部 ${tasks.length} 条记录` : `已收起 ${hiddenTaskCount} 条较早记录`}</span>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setHistoryExpanded((expanded) => !expanded)}
                  >
                    {historyExpanded ? "收起记录" : "展开全部"}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </main>

      <footer className="site-footer" aria-label="作者信息">
        <span>作者：周楚涵</span>
        <span className="footer-separator" aria-hidden="true">·</span>
        <a href="mailto:2801572048@qq.com">2801572048@qq.com</a>
      </footer>
    </div>
  );
}

function TaskCard({ task, onChanged }: { task: Task; onChanged: () => Promise<void> }): React.ReactElement {
  const [title, setTitle] = useState(task.title ?? "");
  const [date, setDate] = useState(task.publishedDate ?? "");
  const [mode, setMode] = useState<RenderMode>(task.requestedMode);
  const isActive = ["loading", "stabilizing", "extracting", "rendering"].includes(task.status);

  useEffect(() => {
    setTitle(task.title ?? "");
    setDate(task.publishedDate ?? "");
  }, [task.title, task.publishedDate]);

  const action = async (url: string, options: RequestInit): Promise<void> => {
    await api(url, options);
    await onChanged();
  };

  return (
    <article className={`task-card status-${task.status}`}>
      <div className="task-topline">
        <span className={`status-pill ${isActive ? "working" : ""}`}><i />{STATUS_LABELS[task.status]}</span>
        <span className="task-mode">{task.actualMode === "screenshot" ? "截图 PDF" : task.actualMode === "structured" ? "结构化 PDF" : "自动模式"}</span>
      </div>
      <h3>{task.title || "正在识别文章标题…"}</h3>
      <a className="source-url" href={task.resolvedUrl || task.inputUrl} target="_blank" rel="noreferrer">{task.inputUrl}</a>
      <div className="task-meta">
        <span>{task.source || "来源待识别"}</span>
        <span>{task.publishedDate || "日期待识别"}</span>
      </div>

      {isActive && <div className="progress-track"><span /></div>}
      {task.errorMessage && <p className="task-error">{task.errorMessage}</p>}

      {task.status === "needs_review" && (
        <div className="review-grid">
          <label><span>原标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label><span>发布日期</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label><span>模式</span><select value={mode} onChange={(event) => setMode(event.target.value as RenderMode)}>
            <option value="auto">原网页高保真</option><option value="screenshot">原网页截图</option><option value="structured">可搜索文字（备用）</option>
          </select></label>
          <button className="primary-button small" onClick={() => void action(`/api/tasks/${task.id}/confirm`, {
            method: "PATCH", body: JSON.stringify({ title, date, mode })
          })}>确认并生成</button>
        </div>
      )}

      <div className="task-actions">
        {task.status === "completed" && <a className="secondary-button" href={`/api/tasks/${task.id}/pdf`} target="_blank" rel="noreferrer">查看 PDF</a>}
        {task.status === "failed" && <>
          <button className="secondary-button" onClick={() => void action(`/api/tasks/${task.id}/retry`, { method: "POST" })}>重新处理</button>
          <button className="text-button" onClick={() => void openExtensionDirectory()}>使用浏览器扩展</button>
        </>}
        {task.status === "queued" && <button className="text-button danger-text" onClick={() => void action(`/api/tasks/${task.id}/cancel`, { method: "POST" })}>取消</button>}
        {task.filename && <span className="filename">{task.filename}</span>}
      </div>
    </article>
  );
}

function parseUrlLines(value: string): ParsedInput {
  const urls: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const originalLine of value.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line) continue;
    const match = line.match(/https?:\/\/[^\s<>\]]+/i);
    const candidate = (match?.[0] ?? line).replace(/[),，。；;]+$/g, "");
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      url.hash = "";
      const normalized = url.toString();
      if (seen.has(normalized)) duplicates += 1;
      else {
        seen.add(normalized);
        urls.push(normalized);
      }
    } catch {
      invalid.push(line);
    }
  }
  return { urls, duplicates, invalid };
}

async function refreshTasks(
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>,
  setSettings: React.Dispatch<React.SetStateAction<Settings | null>>
): Promise<void> {
  const result = await api<{ tasks: Task[]; settings: Settings }>("/api/tasks");
  setTasks(result.tasks);
  setSettings(result.settings);
}

async function api<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(payload.error || `请求失败（${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
