/* DevStart AI — panel controller
 *
 * Runs in two places:
 *   1. Chrome side panel.
 *   2. A floating iframe injected on GitHub repository pages (?embed=1).
 *
 * Backend contract (FastAPI, default https://devstart-ai.onrender.com):
 *   GET  /health        -> any 2xx means reachable
 *   POST /api/chat      -> { "reply": "...", "mode"?: "insights" }
 *        body: { message: string, mode: string, history: [{ role, content }] }
 *        `mode` (or `stage`) is optional; when present it moves the process
 *        rail automatically. Valid values match MODES below.
 *
 * The top rail is read-only: it exists so the user can see which part of the
 * workflow the assistant is working on. The assistant moves it, not the user.
 */

const API_BASE_DEFAULT = "https://devstart-ai.onrender.com";
const REQUEST_TIMEOUT = 35000;

const MODES = {
  understand: {
    label: "Map",
    title: "Map the repository",
    desc: "See how the project is structured, where the entry points are, and which files matter first.",
    placeholder: "Ask what this repository does…",
    prompts: [
      "What does this project do?",
      "How is the code organized?",
      "Where should I start reading?"
    ]
  },
  onboard: {
    label: "Explore",
    title: "Explore the setup",
    desc: "Walk through dependencies, environment variables, and the first run.",
    placeholder: "Ask how to run this project…",
    prompts: [
      "How do I set this up?",
      "Which dependencies do I need?",
      "What environment variables are required?"
    ]
  },
  analyze: {
    label: "Inspect",
    title: "Inspect the code",
    desc: "Trace risky paths and surface bugs with reasoning tied to specific files.",
    placeholder: "Ask what looks risky…",
    prompts: [
      "Scan for likely bugs",
      "Find code smells",
      "What should I refactor first?"
    ]
  },
  suggest: {
    label: "Insights",
    title: "Shape improvements",
    desc: "Turn findings into concrete, reviewable changes with a clear rationale.",
    placeholder: "Ask for an improvement…",
    prompts: [
      "Suggest a refactor",
      "Simplify this function",
      "How can I improve readability?"
    ]
  },
  pr: {
    label: "Branches",
    title: "Review and ship",
    desc: "Check the diff, group the risk, then prepare a pull request for your approval.",
    placeholder: "Ask about the diff or a pull request…",
    prompts: [
      "Review the current changes",
      "What risks are in this diff?",
      "Draft a pull request"
    ]
  }
};

const MODE_ORDER = Object.keys(MODES);

/* What the developer asks decides which stage the assistant moves into. */
const MODE_SIGNALS = {
  understand: [
    [/\b(what|how) (does|is|do)\b/, 2],
    [/\bmap\b/, 2],
    [/\bstructure\b/, 2],
    [/\borgani[sz]/, 2],
    [/\boverview\b/, 2],
    [/\barchitecture\b/, 2],
    [/\bentry points?\b/, 2],
    [/\bstart reading\b/, 2],
    [/\bexplain\b/, 1],
    [/\brepo(sitory)?\b/, 1]
  ],
  onboard: [
    [/\b(getting started|onboard(ing)?|explore)\b/, 3],
    [/\b(set ?up|install|dependenc|environment|env var|configure)\b/, 2],
    [/\bhow do i (run|start|install|set)\b/, 3],
    [/\brun\b/, 1]
  ],
  analyze: [
    [/\b(bug|bugs|risk|risky|scan|inspect|analy[sz]e|smell|security|vulnerab|issue|lint)\b/, 2],
    [/\bwhat.*(wrong|risky|broken)\b/, 3],
    [/\btests?\b/, 1]
  ],
  suggest: [
    [/\b(insights?|suggest|improve|refactor|simplif|readab|optimi[sz]e|fix|clean|rewrite)\b/, 2],
    [/\bhow can i improve\b/, 3]
  ],
  pr: [
    [/\bpull request\b/, 4],
    [/\b(open|create|draft|make) (a )?pr\b/, 4],
    [/\breview (the )?(changes|diff|pr)\b/, 3],
    [/\b(branch|branches|commit|merge|ship)\b/, 2],
    [/\bdiff\b/, 1]
  ]
};

function inferMode(text) {
  const lower = text.toLowerCase();
  let best = null;
  let bestScore = 0;
  let bestIndex = -1;

  for (const mode of MODE_ORDER) {
    let score = 0;
    for (const [pattern, weight] of MODE_SIGNALS[mode]) {
      if (pattern.test(lower)) score += weight;
    }
    const index = MODE_ORDER.indexOf(mode);
    if (score > bestScore || (score === bestScore && score > 0 && index > bestIndex)) {
      best = mode;
      bestScore = score;
      bestIndex = index;
    }
  }

  return best;
}

const state = {
  mode: "understand",
  view: "dashboard",
  history: [],
  busy: false,
  listening: false,
  usingBackend: false,
  apiBase: API_BASE_DEFAULT,
  embedded: new URLSearchParams(location.search).get("embed") === "1",
  analysis: {
    status: "idle",
    repoName: "",
    phase: "understand",
    vulnerabilities: { critical: 0, high: 0, medium: 0, low: 0 },
    prDraft: null,
    recommendations: []
  },
  repo: {
    fullName: "",
    owner: "",
    name: "",
    avatarUrl: "",
    visibility: "Repo",
    branch: "main",
    stars: "—",
    forks: "—",
    issues: "—"
  }
};

/* ---------- Elements ---------- */

const $ = (id) => document.getElementById(id);

const els = {
  stageRail: $("stageRail"),
  stageProgress: $("stageProgress"),
  stageCard: $("stageCard"),
  modeTitle: $("modeTitle"),
  modeDesc: $("modeDesc"),
  brandMark: $("brandMark"),
  chatView: $("chatView"),
  dashboardPage: $("dashboardPage"),
  prPage: $("prPage"),
  dashboardBtn: $("dashboardBtn"),
  bottomDashboardBtn: $("bottomDashboardBtn"),
  bottomPrBtn: $("bottomPrBtn"),
  prStatus: $("prStatus"),
  autoPrTitle: $("autoPrTitle"),
  autoPrSummary: $("autoPrSummary"),
  autoPrFiles: $("autoPrFiles"),
  autoPrIssues: $("autoPrIssues"),
  autoPrWhy: $("autoPrWhy"),
  autoPrChanges: $("autoPrChanges"),
  autoPrFileList: $("autoPrFileList"),
  cancelPrBtn: $("cancelPrBtn"),
  approvePrBtn: $("approvePrBtn"),
  backToChatBtn: $("backToChatBtn"),
  dashNewChatBtn: $("dashNewChatBtn"),
  dashStageList: $("dashStageList"),
  composerArea: $("composerArea"),
  dashRepo: $("dashRepo"),
  dashRepoImage: $("dashRepoImage"),
  dashVisibility: $("dashVisibility"),
  dashBranch: $("dashBranch"),
  dashStars: $("dashStars"),
  dashForks: $("dashForks"),
  dashIssues: $("dashIssues"),
  dashStage: $("dashStage"),
  dashFill: $("dashFill"),
  prReadyWidget: $("prReadyWidget"),
  dashAnalysisStatus: $("dashAnalysisStatus"),
  analysisRing: $("analysisRing"),
  analysisProgress: $("analysisProgress"),
  analysisFiles: $("analysisFiles"),
  analysisLastScan: $("analysisLastScan"),
  vulnerabilityTotal: $("vulnerabilityTotal"),
  criticalCount: $("criticalCount"),
  highCount: $("highCount"),
  mediumCount: $("mediumCount"),
  lowCount: $("lowCount"),
  runAnalysisBtn: $("runAnalysisBtn"),
  thread: $("thread"),
  prompts: $("prompts"),
  composer: $("composer"),
  input: $("input"),
  sendBtn: $("sendBtn"),
  micBtn: $("micBtn"),
  settingsBtn: $("settingsBtn"),
  minimizeBtn: $("minimizeBtn"),
  closeBtn: $("closeBtn"),
  scanCompleteToast: $("scanCompleteToast"),
  dismissScanToast: $("dismissScanToast"),
  settingsDialog: $("settingsDialog"),
  settingsForm: $("settingsForm"),
  apiInput: $("apiInput"),
  testBtn: $("testBtn"),
  testResult: $("testResult"),
  closeSettings: $("closeSettings"),
  micState: $("micState"),
  micPermissionBtn: $("micPermissionBtn"),
  hint: document.querySelector(".hint")
};

/* ---------- Embed bridge ---------- */

function postToParent(type, payload = {}) {
  if (!state.embedded) return;
  try {
    window.parent.postMessage({ source: "devstart-panel", type, ...payload }, "*");
  } catch {
    /* parent may be gone */
  }
}

if (state.embedded) {
  if (els.minimizeBtn) els.minimizeBtn.hidden = false;
  if (els.closeBtn) els.closeBtn.hidden = false;

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.source !== "devstart-content") return;

    if (data.type === "REPO_CONTEXT" && data.repo) {
      setRepoContext(data.repo);
      restoreCachedRepoContext(data.repo);
    }
  });
}

/* ---------- Storage ---------- */

const hasChromeStorage =
  typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

function storageGet(key, fallback) {
  return new Promise((resolve) => {
    try {
      if (hasChromeStorage) {
        chrome.storage.local.get([key], (result) => {
          resolve(result && result[key] !== undefined ? result[key] : fallback);
        });
        return;
      }
      const raw = localStorage.getItem(key);
      resolve(raw === null ? fallback : JSON.parse(raw));
    } catch {
      resolve(fallback);
    }
  });
}

function storageSet(key, value) {
  try {
    if (hasChromeStorage) {
      chrome.storage.local.set({ [key]: value });
      return;
    }
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — ignore */
  }
}

/* ---------- Helpers ---------- */

function normalizeBase(url) {
  return String(url || API_BASE_DEFAULT)
    .trim()
    .replace(/\/+$/, "");
}

function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

function scrollThread() {
  els.thread.scrollTop = els.thread.scrollHeight;
}

function setActivity(next) {
  els.brandMark.dataset.state = next;
}

function setStatus(kind) {
  const label =
    kind === "online"
      ? "Connected"
      : kind === "offline"
        ? "Preview mode"
        : "Checking…";
  if (els.dashAnalysisStatus && state.analysis.status === "idle") {
    els.dashAnalysisStatus.textContent = label;
  }
}

const hintMarkup = els.hint ? els.hint.innerHTML : "";
let hintTimer = null;

function showHint(message) {
  if (!els.hint) return;
  clearTimeout(hintTimer);
  els.hint.textContent = message;
  hintTimer = setTimeout(() => {
    els.hint.innerHTML = hintMarkup;
  }, 3200);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function formatInline(text) {
  return escapeHtml(text).replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

/* ---------- Repository dashboard ---------- */

function formatCount(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") {
    const text = value.trim();
    return text && text !== "—" ? text : "—";
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number >= 1000000) return `${(number / 1000000).toFixed(1).replace(/\.0$/, "")}m`;
  if (number >= 1000) return `${(number / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(number);
}

function renderProgress() {
  const processMode = getProcessMode();
  const index = MODE_ORDER.indexOf(processMode);
  els.dashStage.textContent = `${MODES[processMode].label} · step ${index + 1} of ${MODE_ORDER.length}`;
  els.dashFill.style.width = `${((index + 1) / MODE_ORDER.length) * 100}%`;
  renderDashStageList(index);
  renderAnalysis();
  if (els.prReadyWidget) {
    els.prReadyWidget.hidden = !(state.analysis.phase === "pr" && state.analysis.status === "complete");
  }
}

function getProcessMode() {
  const analysisIsActive =
    state.analysis.repoName &&
    state.analysis.status !== "idle" &&
    MODES[state.analysis.phase];
  return analysisIsActive ? state.analysis.phase : state.mode;
}

function showScanCompleteToast() {
  if (!els.scanCompleteToast) return;
  els.scanCompleteToast.hidden = false;
}

function renderAnalysis() {
  const isRunning = state.analysis.status === "running";
  const isComplete = state.analysis.status === "complete";
  const counts = state.analysis.vulnerabilities || { critical: 0, high: 0, medium: 0, low: 0 };
  const cCrit = Number(counts.critical) || 0;
  const cHigh = Number(counts.high) || 0;
  const cMed = Number(counts.medium) || 0;
  const cLow = Number(counts.low) || 0;
  const totalIssues = cCrit + cHigh + cMed + cLow;

  const penalty = cCrit * 25 + cHigh * 15 + cMed * 8 + cLow * 4;
  const healthScore = Math.max(10, 100 - penalty);
  const progress = isRunning ? 35 : isComplete ? healthScore : 0;

  const status = isRunning
    ? "Analyzing repository"
    : isComplete
      ? totalIssues > 0
        ? `${totalIssues} issue${totalIssues === 1 ? "" : "s"} found`
        : "Analysis complete"
      : "Ready to scan";

  if (els.dashAnalysisStatus) els.dashAnalysisStatus.textContent = status;
  if (els.analysisProgress) els.analysisProgress.textContent = `${progress}%`;
  if (els.analysisRing) {
    els.analysisRing.style.setProperty("--analysis-progress", `${progress * 3.6}deg`);
    els.analysisRing.setAttribute(
      "aria-label",
      isRunning
        ? "Analysis is in progress"
        : isComplete
          ? `Analysis complete: ${progress}% code health (${totalIssues} issues)`
          : "Analysis has not started"
    );
  }

  if (els.vulnerabilityTotal) els.vulnerabilityTotal.textContent = String(totalIssues);
  if (els.criticalCount) els.criticalCount.textContent = String(cCrit);
  if (els.highCount) els.highCount.textContent = String(cHigh);
  if (els.mediumCount) els.mediumCount.textContent = String(cMed);
  if (els.lowCount) els.lowCount.textContent = String(cLow);

  if (els.analysisFiles) {
    els.analysisFiles.textContent = isRunning
      ? "Inspecting repository"
      : isComplete
        ? totalIssues > 0
          ? `${totalIssues} issue${totalIssues === 1 ? "" : "s"} detected in repository`
          : "Repository inspection finished"
        : "No scan run";
  }
  if (els.analysisLastScan) {
    els.analysisLastScan.textContent = isRunning
      ? "Tracing bugs, risky paths, and security issues."
      : isComplete
        ? totalIssues > 0
          ? `Code health score: ${healthScore}% — review findings in Chat or Auto Pull Request.`
          : "Code health score: 100% — no vulnerabilities detected."
        : "Analysis starts automatically when a repository is detected.";
  }
}

function extractAiInsightsFromHistory() {
  const aiReplies = (state.history || [])
    .filter((turn) => turn && turn.role === "assistant" && typeof turn.content === "string")
    .map((turn) => turn.content);
  const fullText = aiReplies.join("\n");

  const fileRegex = /`([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]{1,8})`/g;
  const mentionedFiles = [];
  let match;
  while ((match = fileRegex.exec(fullText)) !== null) {
    const candidate = match[1];
    if (!mentionedFiles.includes(candidate) && !candidate.startsWith("http")) {
      mentionedFiles.push(candidate);
    }
  }

  const latestReply = aiReplies[aiReplies.length - 1] || aiReplies[0] || "";
  const sentences = latestReply
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && s.length < 180);

  return {
    files: mentionedFiles.slice(0, 6),
    changes: sentences.slice(0, 4)
  };
}

async function requestAnalysis() {
  if (state.busy || !state.repo.fullName) return;

  if (!state.usingBackend) {
    await checkBackend();
  }

  state.analysis.status = "running";
  state.analysis.phase = "understand";
  renderProgress();
  state.analysis.phase = "onboard";
  renderProgress();
  renderAnalysis();
  setMode("analyze", { silent: true });
  state.analysis.phase = "analyze";
  renderProgress();
  await sendMessage(
    `Analyze the ${state.repo.fullName} repository automatically. Find bugs, vulnerabilities, and risky paths, and tie every finding to a file.`
  );

  state.analysis.phase = "suggest";
  renderProgress();
  await sendMessage(
    `Generate automatic insights from the ${state.repo.fullName} inspection. Prioritize the most important fixes, explain why they matter, and suggest concrete next steps tied to the findings.`
  );

  state.analysis.phase = "pr";
  state.analysis.status = "complete";
  const vulns = state.analysis.vulnerabilities || {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0
  };
  const backendDraft = state.analysis.prDraft || {};
  const aiInsights = extractAiInsightsFromHistory();
  const hasRealBackendChanges =
    Array.isArray(backendDraft.changes) &&
    backendDraft.changes.length &&
    !(
      backendDraft.changes.length === 1 &&
      backendDraft.changes[0] === "Repository inspection findings were reviewed automatically"
    );

  const prDraft = {
    repo: state.repo.fullName,
    title: backendDraft.title || `Harden ${state.repo.fullName}`,
    summary:
      backendDraft.summary ||
      `Automatic inspection found improvement opportunities in ${state.repo.fullName}.`,
    why:
      backendDraft.why ||
      "Groups the highest-priority findings into one reviewable change before they reach production.",
    scope:
      backendDraft.scope ||
      "Security fixes, validation improvements, and targeted refactors.",
    vulnerabilities: vulns,
    files: aiInsights.files,
    changes: hasRealBackendChanges
      ? backendDraft.changes
      : aiInsights.changes.length
        ? aiInsights.changes
        : [
            `Inspected ${state.repo.fullName} source files for security and validation issues`,
            "Grouped highest-priority findings into a single reviewable pull request"
          ]
  };
  state.analysis.prDraft = prDraft;
  renderProgress();
  showScanCompleteToast();
  storageSet(`prDraft:${state.repo.fullName}`, prDraft);
  storageSet(`scanComplete:${state.repo.fullName}`, true);
  postToParent("PR_DRAFT_READY", prDraft);
}

function renderDashStageList(activeIndex = MODE_ORDER.indexOf(state.mode)) {
  if (!els.dashStageList) return;
  els.dashStageList.innerHTML = "";

  // Show the stage that just finished and the one in progress. At the very
  // start there is nothing finished yet, so show the current and the next stage.
  const firstShown = Math.max(0, Math.min(activeIndex - 1, MODE_ORDER.length - 2));

  MODE_ORDER.forEach((mode, index) => {
    if (index < firstShown || index > firstShown + 1) return;
    const row = document.createElement("div");
    row.className = "dash-stage";
    row.dataset.state = index === activeIndex ? "active" : index < activeIndex ? "done" : "idle";

    const dot = document.createElement("span");
    dot.className = "dash-stage-dot";
    dot.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.className = "dash-stage-name";
    name.textContent = MODES[mode].label;

    const meta = document.createElement("span");
    meta.className = "dash-stage-meta";
    meta.textContent =
      index < activeIndex ? "done" : index === activeIndex ? "in progress" : `step ${index + 1}`;

    row.append(dot, name, meta);
    els.dashStageList.appendChild(row);
  });
}

// A failed avatar load should fall back to the gradient tile, not a broken-image glyph
if (els.dashRepoImage) {
  els.dashRepoImage.addEventListener("error", () => {
    els.dashRepoImage.hidden = true;
  });
}

function renderDashboard() {
  const repo = state.repo;
  els.dashRepo.textContent = repo.fullName || "Current repository";
  if (els.dashRepoImage) {
    const avatarUrl = repo.avatarUrl || (repo.owner ? `https://github.com/${encodeURIComponent(repo.owner)}.png?size=160` : "");
    if (avatarUrl) {
      els.dashRepoImage.src = avatarUrl;
    } else {
      els.dashRepoImage.removeAttribute("src");
    }
    els.dashRepoImage.hidden = !avatarUrl;
  }
  els.dashVisibility.textContent = repo.visibility || "Repo";
  els.dashBranch.textContent = repo.branch || "main";
  els.dashStars.textContent = formatCount(repo.stars);
  els.dashForks.textContent = formatCount(repo.forks);
  els.dashIssues.textContent = formatCount(repo.issues);
  renderProgress();
}

function isMissingRepoValue(value) {
  return value === null || value === undefined || value === "" || value === "—";
}

function repoStorageKey(fullName) {
  return fullName ? `repoContext:${fullName}` : "";
}

let enrichedRepo = "";
let enrichRetryTimer = null;

async function enrichRepoFromApi(fullName) {
  if (!fullName || !fullName.includes("/") || enrichedRepo === fullName) return;
  enrichedRepo = fullName;

  const [owner, name] = fullName.split("/");

  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      { headers: { Accept: "application/vnd.github+json" } },
      5000
    );
    if (!res.ok) {
      enrichedRepo = "";
      if (!enrichRetryTimer) {
        enrichRetryTimer = setTimeout(() => {
          enrichRetryTimer = null;
          enrichRepoFromApi(fullName);
        }, 1500);
      }
      return;
    }

    const data = await res.json();
    setRepoContext({
      fullName: data.full_name || fullName,
      avatarUrl: data.owner && data.owner.avatar_url ? data.owner.avatar_url : "",
      visibility: data.private ? "Private" : "Public",
      branch: data.default_branch || state.repo.branch || "main",
      stars: Number.isFinite(data.stargazers_count) ? data.stargazers_count : state.repo.stars,
      forks: Number.isFinite(data.forks_count) ? data.forks_count : state.repo.forks,
      issues: Number.isFinite(data.open_issues_count) ? data.open_issues_count : state.repo.issues
    });
  } catch {
    enrichedRepo = "";
    if (!enrichRetryTimer) {
      enrichRetryTimer = setTimeout(() => {
        enrichRetryTimer = null;
        enrichRepoFromApi(fullName);
      }, 1500);
    }
  }
}

function setRepoContext(repo = {}) {
  const sameRepo = !repo.fullName || !state.repo.fullName || repo.fullName === state.repo.fullName;
  const nextRepo = { ...state.repo };

  Object.entries(repo).forEach(([key, value]) => {
    if (sameRepo && isMissingRepoValue(value) && !isMissingRepoValue(nextRepo[key])) return;
    nextRepo[key] = value;
  });

  state.repo = nextRepo;
  renderDashboard();
  if (state.repo.fullName) storageSet(repoStorageKey(state.repo.fullName), state.repo);

  if (state.repo.fullName && state.analysis.repoName !== state.repo.fullName) {
    state.analysis.repoName = state.repo.fullName;
    requestAnalysis();
  }

  const missingStats = ["stars", "forks", "issues"].some((key) =>
    isMissingRepoValue(state.repo[key])
  );
  if (missingStats) enrichRepoFromApi(state.repo.fullName);
}

async function restoreCachedRepoContext(repo) {
  if (!repo || !repo.fullName) return;
  const cached = await storageGet(repoStorageKey(repo.fullName), null);
  if (
    cached &&
    cached.fullName === repo.fullName &&
    (!state.repo.fullName || state.repo.fullName === repo.fullName)
  ) {
    setRepoContext(cached);
  }
}

async function loadRepoFromActiveTab() {
  if (state.embedded || !isExtensionPage() || !chrome.tabs || !chrome.tabs.query) {
    renderDashboard();
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url) {
      renderDashboard();
      return;
    }

    const url = new URL(tab.url);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
      renderDashboard();
      return;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      renderDashboard();
      return;
    }

    const [owner, name] = parts;
    setRepoContext({ fullName: `${owner}/${name}`, owner, name });
  } catch {
    renderDashboard();
  }
}

/* ---------- View switching ---------- */

function setView(view) {
  const next = view === "dashboard" || view === "pr" ? view : "chat";
  state.view = next;

  const isDashboard = next === "dashboard";
  const isPr = next === "pr";

  if (els.chatView) els.chatView.hidden = isDashboard || isPr;
  if (els.dashboardPage) els.dashboardPage.hidden = !isDashboard;
  if (els.prPage) els.prPage.hidden = !isPr;
  if (els.composerArea) els.composerArea.hidden = isDashboard || isPr;
  // The composer is hidden on the dashboard, so its height reads as 0 there; re-measure once it is visible
  if (!isDashboard && !isPr) autoResize();

  if (els.dashboardBtn) {
    els.dashboardBtn.classList.toggle("is-active", isDashboard);
    els.dashboardBtn.setAttribute("aria-pressed", String(isDashboard));
    els.dashboardBtn.title = isDashboard ? "Back to chat" : "Dashboard";
    els.dashboardBtn.setAttribute(
      "aria-label",
      isDashboard ? "Back to chat" : "Open dashboard"
    );
  }

  [els.bottomDashboardBtn, els.bottomPrBtn].forEach((button) => {
    if (!button) return;
    const active = (button === els.bottomDashboardBtn && isDashboard) ||
      (button === els.bottomPrBtn && isPr);
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  if (isDashboard) {
    renderDashboard();
    if (els.dashboardPage) els.dashboardPage.scrollTop = 0;
    if (!state.embedded) loadRepoFromActiveTab();
  }
  if (isPr) {
    const repo = state.repo.fullName || "this repository";
    const draft = state.analysis.prDraft || {};
    const recs = state.analysis.recommendations || [];
    const aiInsights = extractAiInsightsFromHistory();
    const counts = state.analysis.vulnerabilities || { critical: 0, high: 0, medium: 0, low: 0 };
    const totalIssues =
      (Number(counts.critical) || 0) +
      (Number(counts.high) || 0) +
      (Number(counts.medium) || 0) +
      (Number(counts.low) || 0);

    if (els.autoPrTitle) els.autoPrTitle.textContent = draft.title || `Harden ${repo}`;
    if (els.autoPrSummary)
      els.autoPrSummary.textContent =
        draft.summary || `Automatic inspection findings grouped into one reviewable change for ${repo}.`;
    if (els.autoPrWhy && draft.why) els.autoPrWhy.textContent = draft.why;

    if (els.autoPrChanges) {
      els.autoPrChanges.innerHTML = "";
      const hasRealDraftChanges =
        Array.isArray(draft.changes) &&
        draft.changes.length &&
        !(
          draft.changes.length === 1 &&
          draft.changes[0] === "Repository inspection findings were reviewed automatically"
        );
      const changeItems = hasRealDraftChanges
        ? draft.changes
        : recs.length
          ? recs.slice(0, 5).map((r) => `${r.title} in ${r.file} (line ${r.line})`)
          : aiInsights.changes.length
            ? aiInsights.changes
            : [
                `Inspect ${repo} source files and entry points`,
                totalIssues > 0
                  ? `Address ${totalIssues} detected security/validation issue(s) in ${repo}`
                  : `No critical vulnerabilities found in ${repo}`
              ];

      changeItems.forEach((changeText) => {
        const li = document.createElement("li");
        li.textContent = changeText;
        els.autoPrChanges.appendChild(li);
      });
    }

    const recFiles = recs.map((r) => r.file).filter(Boolean);
    const draftFiles = Array.isArray(draft.files) ? draft.files : [];
    const uniqueFiles = Array.from(
      new Set([...recFiles, ...draftFiles, ...aiInsights.files].filter(Boolean))
    );
    if (els.autoPrFiles) els.autoPrFiles.textContent = String(uniqueFiles.length || (totalIssues > 0 ? 1 : 0));
    if (els.autoPrIssues) els.autoPrIssues.textContent = String(totalIssues);

    if (els.autoPrFileList) {
      els.autoPrFileList.innerHTML = "";
      const fileEntries = uniqueFiles.length
        ? uniqueFiles.map((file) => ["Modified", file, "file-modified"])
        : [
            ["Inspected", repo, "file-modified"]
          ];
      fileEntries.forEach(([action, file, className]) => {
        const item = document.createElement("li");
        const badge = document.createElement("span");
        badge.className = `file-change ${className}`;
        badge.textContent = action;
        const path = document.createElement("code");
        path.textContent = file;
        item.append(badge, path);
        els.autoPrFileList.appendChild(item);
      });
    }
  }
}

/* ---------- Messages ---------- */

function removeEmpty() {
  const empty = els.thread.querySelector(".empty");
  if (empty) empty.remove();
}

function renderEmpty() {
  els.thread.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "empty";

  const strong = document.createElement("strong");
  strong.textContent = "Ready when you are";

  const span = document.createElement("span");
  span.textContent = "Ask about the repository open in this tab, or pick a prompt below.";

  wrap.append(strong, span);
  els.thread.appendChild(wrap);
}

function createAvatar() {
  const avatar = document.createElement("span");
  avatar.className = "ai-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.5 4.1L17.6 8.6 13.5 10.1 12 14.2 10.5 10.1 6.4 8.6 10.5 7.1 12 3Z"/><path d="M18.5 14.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z"/></svg>';
  return avatar;
}

function addMessage(role, text) {
  removeEmpty();
  const row = document.createElement("div");
  row.className = "msg-row " + role;

  if (role === "ai") row.appendChild(createAvatar());

  const el = document.createElement("div");
  el.className = "msg " + role;
  if (role === "ai") {
    el.innerHTML = formatInline(text);
  } else {
    el.textContent = text;
  }

  row.appendChild(el);
  els.thread.appendChild(row);
  scrollThread();
  return el;
}

function addDivider(label) {
  const el = document.createElement("div");
  el.className = "thread-divider";
  el.textContent = label;
  els.thread.appendChild(el);
  scrollThread();
}

function addTyping() {
  removeEmpty();
  const el = document.createElement("div");
  el.className = "typing";
  el.setAttribute("role", "status");
  el.setAttribute("aria-label", "DevStart AI is thinking");
  const bar = document.createElement("span");
  bar.className = "typing-bar";
  el.appendChild(bar);
  els.thread.appendChild(el);
  scrollThread();
  return el;
}

function addError(retryText) {
  removeEmpty();
  const row = document.createElement("div");
  row.className = "msg-row ai";
  row.appendChild(createAvatar());

  const el = document.createElement("div");
  el.className = "msg error";
  el.textContent = "Couldn't reach the backend. Check the URL in settings and try again.";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "retry-btn";
  btn.textContent = "Retry";
  btn.addEventListener("click", () => {
    if (state.busy) return;
    row.remove();
    requestReply(retryText);
  });

  el.appendChild(document.createElement("br"));
  el.appendChild(btn);
  row.appendChild(el);
  els.thread.appendChild(row);
  scrollThread();
}

/* ---------- Reply pipeline ---------- */

async function getReply(text) {
  if (!state.usingBackend) {
    await checkBackend();
  }
  if (state.usingBackend) {
    try {
      return await callBackend(text);
    } catch {
      state.usingBackend = false;
      setStatus("offline");
    }
  }
  return mockReply(text);
}

async function callBackend(message) {
  const res = await fetchWithTimeout(`${state.apiBase}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      mode: state.mode,
      history: state.history.slice(-8),
      repo: state.repo.fullName || undefined
    })
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  const reply = data.reply ?? data.message ?? data.content ?? data.answer;
  if (!reply || typeof reply !== "string") throw new Error("Empty reply");

  if (data.vulnerabilities && typeof data.vulnerabilities === "object") {
    state.analysis.vulnerabilities = {
      critical: Number(data.vulnerabilities.critical) || 0,
      high: Number(data.vulnerabilities.high) || 0,
      medium: Number(data.vulnerabilities.medium) || 0,
      low: Number(data.vulnerabilities.low) || 0
    };
  }
  if (data.pr_draft && typeof data.pr_draft === "object") {
    state.analysis.prDraft = data.pr_draft;
  }
  if (Array.isArray(data.recommendations)) {
    state.analysis.recommendations = data.recommendations;
  }
  renderAnalysis();

  const stage = typeof data.mode === "string" ? data.mode : data.stage;
  return { reply, mode: MODES[stage] ? stage : null };
}

function mockReply(text) {
  const lower = text.toLowerCase();
  const mode = state.mode;

  const answers = [];

  if (lower.includes("bug") || lower.includes("risk") || lower.includes("scan")) {
    answers.push(
      "I'd start with the request handlers and anything that trusts user input. I can walk file by file and flag the patterns that usually become bugs, with the reasoning for each."
    );
  }
  if (
    lower.includes("setup") ||
    lower.includes("set up") ||
    lower.includes("set this up") ||
    lower.includes("run") ||
    lower.includes("install") ||
    lower.includes("depend")
  ) {
    answers.push(
      "The usual path is: create a virtual environment, install the backend requirements, add the environment variables, then start FastAPI with uvicorn. I can turn that into a checklist for this repo."
    );
  }
  if (lower.includes("structure") || lower.includes("organiz") || lower.includes("start reading") || lower.includes("what does")) {
    answers.push(
      "This project splits into a `Chrome extension`, a `FastAPI backend`, and `Firebase` configuration. I'd read the extension panel first, then the API routes, then the shared config."
    );
  }
  if (lower.includes("refactor") || lower.includes("improve") || lower.includes("readab") || lower.includes("simplif")) {
    answers.push(
      "A good first pass is to isolate the panel state and API calls into small modules, then keep the DOM layer thin. That makes each piece testable without changing behavior."
    );
  }
  if (/\bpull request\b|\bpr\b|\bdiff\b/.test(lower)) {
    answers.push(
      "I'll group the diff by risk, call out anything that changes behavior, and draft a PR summary you can approve. Nothing is pushed until you confirm."
    );
  }

  if (!answers.length) {
    answers.push(
      "Got it. I'll look at the repository context and come back with a focused answer, including the files involved and a suggested next step."
    );
  }

  const base = answers[Math.floor(Math.random() * answers.length)];
  const suffix =
    mode === "pr"
      ? " Review remains read-only until you approve."
      : mode === "analyze"
        ? " I'll keep findings tied to specific files."
        : "";

  const next = inferMode(text) || mode;

  return new Promise((resolve) => {
    setTimeout(() => resolve({ reply: base + suffix, mode: next }), 620 + Math.random() * 480);
  });
}

async function requestReply(text) {
  if (state.busy) return;

  state.busy = true;
  els.sendBtn.disabled = true;
  if (!state.listening) setActivity("thinking");

  const typing = addTyping();

  try {
    const result = await getReply(text);
    typing.remove();

    if (result.mode && result.mode !== state.mode) {
      setMode(result.mode, { auto: true });
    }

    addMessage("ai", result.reply);
    state.history.push({ role: "assistant", content: result.reply });
  } catch {
    typing.remove();
    addError(text);
  } finally {
    state.busy = false;
    if (!state.listening) setActivity("idle");
    syncSend();
  }
}

async function sendMessage(raw) {
  const text = (raw ?? els.input.value).trim();
  if (!text || state.busy) return;

  if (raw === undefined) {
    els.input.value = "";
    autoResize();
  }

  addMessage("user", text);
  state.history.push({ role: "user", content: text });

  const intent = inferMode(text);
  if (intent && intent !== state.mode) {
    setMode(intent, { auto: true });
  }

  syncSend();
  await requestReply(text);
}

/* ---------- Read-only process rail ---------- */

let flashTimer = null;

function flashMode(mode) {
  const step = document.querySelector(`.stage-step[data-mode="${mode}"]`);
  if (!step) return;

  document.querySelectorAll(".stage-step.is-auto").forEach((el) => {
    el.classList.remove("is-auto");
  });

  step.classList.add("is-auto");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => step.classList.remove("is-auto"), 900);
}

function setMode(mode, options = {}) {
  if (!MODES[mode]) return;

  const previous = state.mode;
  state.mode = mode;
  const activeIndex = MODE_ORDER.indexOf(mode);

  document.querySelectorAll(".stage-step").forEach((step) => {
    const index = MODE_ORDER.indexOf(step.dataset.mode);
    const isActive = step.dataset.mode === mode;
    step.classList.toggle("is-active", isActive);
    step.classList.toggle("is-complete", index < activeIndex);
    if (isActive) {
      step.setAttribute("aria-current", "step");
    } else {
      step.removeAttribute("aria-current");
    }
  });

  const info = MODES[mode];

  if (els.stageRail) {
    els.stageRail.setAttribute(
      "aria-label",
      options.auto ? `AI process — now at ${info.label}` : "AI process — read only"
    );
  }

  const ratio = activeIndex / (MODE_ORDER.length - 1);
  els.stageRail.style.setProperty("--flow", String(ratio));
  renderProgress();

  els.modeTitle.textContent = info.title;
  els.modeDesc.textContent = info.desc;
  els.input.placeholder = info.placeholder;
  renderPrompts();

  els.stageCard.classList.remove("is-swapping");
  // restart the swap animation
  void els.stageCard.offsetWidth;
  els.stageCard.classList.add("is-swapping");

  if (!options.silent && previous !== mode && state.history.length > 0) {
    addDivider(info.label);
  }

  if (options.auto) flashMode(mode);

  setActivity("idle");
  storageSet("mode", mode);
}

function renderPrompts() {
  els.prompts.innerHTML = "";
  MODES[state.mode].prompts.forEach((text) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "prompt";
    btn.textContent = text;
    btn.addEventListener("click", () => {
      els.input.value = "";
      sendMessage(text);
    });
    els.prompts.appendChild(btn);
  });
}

/* ---------- Composer ---------- */

function autoResize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 110) + "px";
}

function syncSend() {
  els.sendBtn.disabled = state.busy || els.input.value.trim().length === 0;
}

/* ---------- Backend status ---------- */

async function checkBackend() {
  setStatus("checking");
  try {
    const res = await fetchWithTimeout(`${state.apiBase}/health`, {}, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.usingBackend = true;
  } catch {
    if (state.apiBase !== API_BASE_DEFAULT) {
      try {
        const fallbackRes = await fetchWithTimeout(`${API_BASE_DEFAULT}/health`, {}, 15000);
        if (fallbackRes.ok) {
          state.apiBase = API_BASE_DEFAULT;
          storageSet("apiBase", API_BASE_DEFAULT);
          state.usingBackend = true;
          setStatus("online");
          return;
        }
      } catch {
        /* fallback also offline */
      }
    }
    state.usingBackend = false;
  }
  setStatus(state.usingBackend ? "online" : "offline");
}

/* ---------- Voice input ---------- */

let recognition = null;
let micGrantedThisSession = false;

function isExtensionPage() {
  return (
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    typeof chrome.runtime.getURL === "function" &&
    location.protocol === "chrome-extension:"
  );
}

async function queryMicPermission() {
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const status = await navigator.permissions.query({ name: "microphone" });
      return status.state;
    }
  } catch {
    /* permissions API may not expose microphone */
  }
  return "unknown";
}

function updateMicSettings(stateName) {
  const map = {
    granted: "Allowed",
    prompt: "Not allowed yet",
    denied: "Blocked in browser settings",
    unknown: "Not checked",
    session: "Allowed for this session"
  };
  const label = map[stateName] || map.unknown;

  if (els.micState) {
    els.micState.textContent = label;
    els.micState.dataset.state = stateName;
  }

  if (els.micPermissionBtn) {
    els.micPermissionBtn.disabled =
      stateName === "granted" || stateName === "session";
  }
}

function openMicPermissionPage() {
  if (!isExtensionPage()) {
    showHint("Open the panel from the extension to enable the microphone.");
    return;
  }
  const url = chrome.runtime.getURL("assets/mic-permission.html");
  if (chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, "_blank");
  }
}

function getRecognition() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const rec = new SpeechRecognition();
  rec.lang = "en-US";
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.addEventListener("start", () => {
    state.listening = true;
    els.micBtn.classList.add("is-listening");
    els.micBtn.setAttribute("aria-label", "Stop voice input");
    setActivity("listening");
    els.input.placeholder = "Listening…";
  });

  rec.addEventListener("result", (event) => {
    let transcript = "";
    let isFinal = false;
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      transcript += event.results[i][0].transcript;
      if (event.results[i].isFinal) isFinal = true;
    }
    els.input.value = transcript;
    autoResize();
    syncSend();
    if (isFinal && transcript.trim()) {
      rec.stop();
      sendMessage(transcript.trim());
    }
  });

  rec.addEventListener("error", (event) => {
    const reason = event.error;

    if (reason === "not-allowed" || reason === "service-not-allowed") {
      micGrantedThisSession = false;
      updateMicSettings("denied");
      showHint("Microphone is blocked. Open settings to allow it.");
    } else if (reason === "audio-capture") {
      showHint("No microphone was found. Check your input device.");
    } else if (reason === "network") {
      showHint("Speech recognition needs a network connection.");
    } else if (reason === "no-speech") {
      showHint("Didn't catch that. Tap the mic and try again.");
    } else if (reason !== "aborted") {
      showHint("Voice input stopped. Try again.");
    }
  });

  rec.addEventListener("end", () => {
    state.listening = false;
    els.micBtn.classList.remove("is-listening");
    els.micBtn.setAttribute("aria-label", "Start voice input");
    els.input.placeholder = MODES[state.mode].placeholder;
    if (!state.busy) setActivity("idle");
  });

  return rec;
}

function startListening() {
  if (!recognition) recognition = getRecognition();

  if (!recognition) {
    showHint("Voice input isn't available in this browser.");
    return;
  }

  try {
    recognition.start();
  } catch {
    showHint("Voice input is already starting.");
  }
}

async function toggleListening() {
  if (state.listening) {
    if (recognition) recognition.stop();
    return;
  }

  if (micGrantedThisSession) {
    startListening();
    return;
  }

  // A side panel or embedded iframe cannot always raise the microphone prompt,
  // so check first and route the user through a full extension page.
  const permission = await queryMicPermission();

  if (permission === "denied") {
    updateMicSettings("denied");
    showHint("Microphone is blocked. Enable it in the browser site settings.");
    return;
  }

  if (permission === "granted") {
    micGrantedThisSession = true;
    updateMicSettings("granted");
    startListening();
    return;
  }

  if (isExtensionPage()) {
    updateMicSettings("prompt");
    openMicPermissionPage();
    showHint("Allow the microphone in the tab that just opened.");
    return;
  }

  startListening();
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "MIC_PERMISSION_GRANTED") {
      micGrantedThisSession = true;
      updateMicSettings("session");
      showHint("Microphone ready. Speak your question.");
      startListening();
    }
  });
}

/* ---------- Settings ---------- */

function openSettings() {
  els.apiInput.value = state.apiBase;
  els.testResult.textContent = "";
  els.testResult.className = "test-result";

  if (micGrantedThisSession) {
    updateMicSettings("session");
  } else {
    queryMicPermission().then(updateMicSettings);
  }

  if (typeof els.settingsDialog.showModal === "function") {
    els.settingsDialog.showModal();
  } else {
    els.settingsDialog.setAttribute("open", "");
  }
  setTimeout(() => els.apiInput.focus(), 30);
}

function closeSettings() {
  if (typeof els.settingsDialog.close === "function") {
    els.settingsDialog.close();
  } else {
    els.settingsDialog.removeAttribute("open");
  }
}

async function testConnectionFromSheet() {
  const url = normalizeBase(els.apiInput.value);
  els.testResult.className = "test-result";
  els.testResult.textContent = "Testing…";

  try {
    const res = await fetchWithTimeout(`${url}/health`, {}, 4000);
    if (res.ok) {
      els.testResult.className = "test-result is-ok";
      els.testResult.textContent = "Connected. The backend is reachable.";
    } else {
      els.testResult.className = "test-result is-fail";
      els.testResult.textContent = `Server responded with HTTP ${res.status}.`;
    }
  } catch {
    els.testResult.className = "test-result is-fail";
    els.testResult.textContent = "Could not reach that URL.";
  }
}

async function saveSettings(event) {
  event.preventDefault();
  state.apiBase = normalizeBase(els.apiInput.value);
  storageSet("apiBase", state.apiBase);
  closeSettings();
  await checkBackend();
}

/* ---------- Events ---------- */

els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});

els.input.addEventListener("input", () => {
  autoResize();
  syncSend();
});

els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

els.micBtn.addEventListener("click", toggleListening);
els.micPermissionBtn?.addEventListener("click", () => {
  openMicPermissionPage();
});

function newChat() {
  if (state.busy) {
    showHint("Wait for the current reply to finish.");
    return;
  }
  state.history = [];
  renderEmpty();
  els.input.value = "";
  autoResize();
  syncSend();
  setActivity("idle");
}

els.settingsBtn.addEventListener("click", openSettings);
els.closeSettings.addEventListener("click", closeSettings);
els.settingsForm.addEventListener("submit", saveSettings);
els.testBtn.addEventListener("click", testConnectionFromSheet);

els.dashboardBtn?.addEventListener("click", () => {
  const next = state.view === "dashboard" ? "chat" : "dashboard";
  setView(next);
  if (next === "chat") els.input.focus({ preventScroll: true });
});

els.backToChatBtn?.addEventListener("click", () => {
  setView("chat");
  els.input.focus({ preventScroll: true });
});

els.dashNewChatBtn?.addEventListener("click", () => {
  newChat();
  setView("chat");
  els.input.focus({ preventScroll: true });
});

els.bottomDashboardBtn?.addEventListener("click", () => setView("dashboard"));
els.bottomPrBtn?.addEventListener("click", () => setView("pr"));
els.cancelPrBtn?.addEventListener("click", () => {
  if (els.prStatus) els.prStatus.textContent = "Cancelled";
});
els.approvePrBtn?.addEventListener("click", () => {
  if (els.prStatus) els.prStatus.textContent = "Approved for review";
  if (els.approvePrBtn) {
    els.approvePrBtn.disabled = true;
    els.approvePrBtn.textContent = "Pull request approved";
  }
});

els.runAnalysisBtn?.addEventListener("click", requestAnalysis);



els.minimizeBtn?.addEventListener("click", () => postToParent("MINIMIZE"));
els.closeBtn?.addEventListener("click", () => postToParent("CLOSE"));

els.settingsDialog.addEventListener("click", (event) => {
  if (event.target === els.settingsDialog) closeSettings();
});

els.dismissScanToast?.addEventListener("click", () => {
  if (els.scanCompleteToast) els.scanCompleteToast.hidden = true;
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    els.input.focus();
  }

  if (event.key === "Escape" && state.embedded && !els.settingsDialog.open) {
    postToParent("CLOSE");
  }
});

/* ---------- Init ---------- */

async function init() {
  const savedBase = await storageGet("apiBase", API_BASE_DEFAULT);
  const savedMode = await storageGet("mode", "understand");

  state.apiBase = normalizeBase(savedBase);
  state.mode = MODES[savedMode] ? savedMode : "understand";

  setMode(state.mode, { silent: true });
  renderEmpty();
  renderDashboard();
  setView("dashboard");
  syncSend();
  autoResize();
  await checkBackend();

  if (state.embedded) {
    postToParent("PANEL_READY");
  } else {
    loadRepoFromActiveTab();
  }

  const permission = await queryMicPermission();
  if (permission === "granted") {
    micGrantedThisSession = true;
    updateMicSettings("granted");
  } else {
    updateMicSettings(permission);
  }
}

init();
