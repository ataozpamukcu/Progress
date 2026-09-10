const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = 8787;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const STATE_FILE = path.join(DATA_DIR, "progress-state.json");
const BACKUP_FILE = path.join(DATA_DIR, "progress-state.backup.json");
const DEFAULT_STATE = {
  tasks: {},
  notes: {},
  dailyLog: {},
  deadlines: {},
  timeline: {
    energyByDate: {},
    effectiveDates: {},
    skipped: {},
    moveCounts: {},
    reopenedModules: {},
  },
  updatedAt: 0,
};

const STATIC_ROUTES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/study-plan": "study-plan.html",
  "/study-plan.html": "study-plan.html",
  "/past-papers": "past-papers.html",
  "/past-papers.html": "past-papers.html",
  "/completed": "completed.html",
  "/completed.html": "completed.html",
  "/styles.css": "styles.css",
  "/timeline-data.js": "timeline-data.js",
  "/study-plan-data.js": "study-plan-data.js",
  "/app.js": "app.js",
  "/README.md": "README.md",
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function normalizeTaskMap(taskMap) {
  const normalized = {};

  if (!taskMap || typeof taskMap !== "object") {
    return normalized;
  }

  Object.entries(taskMap).forEach(([taskId, value]) => {
    if (value) {
      normalized[taskId] = true;
    }
  });

  return normalized;
}

function normalizeNotesMap(notes) {
  const normalized = {};

  if (!notes || typeof notes !== "object") {
    return normalized;
  }

  Object.entries(notes).forEach(([courseId, note]) => {
    if (typeof note === "string") {
      normalized[courseId] = note;
    }
  });

  return normalized;
}

function normalizeDeadlineMap(deadlines) {
  const normalized = {};

  if (!deadlines || typeof deadlines !== "object") {
    return normalized;
  }

  Object.entries(deadlines).forEach(([deadlineId, value]) => {
    if (value) {
      normalized[deadlineId] = true;
    }
  });

  return normalized;
}

function normalizeStringMap(values) {
  const normalized = {};

  if (!values || typeof values !== "object") {
    return normalized;
  }

  Object.entries(values).forEach(([key, value]) => {
    if (typeof value === "string" && value) {
      normalized[key] = value;
    }
  });

  return normalized;
}

function normalizeBooleanMap(values) {
  const normalized = {};

  if (!values || typeof values !== "object") {
    return normalized;
  }

  Object.entries(values).forEach(([key, value]) => {
    if (value) {
      normalized[key] = true;
    }
  });

  return normalized;
}

function normalizeNumberMap(values) {
  const normalized = {};

  if (!values || typeof values !== "object") {
    return normalized;
  }

  Object.entries(values).forEach(([key, value]) => {
    const numberValue = Number(value);

    if (Number.isFinite(numberValue) && numberValue > 0) {
      normalized[key] = numberValue;
    }
  });

  return normalized;
}

function normalizeTimelineState(timeline) {
  return {
    energyByDate: normalizeStringMap(timeline?.energyByDate),
    effectiveDates: normalizeStringMap(timeline?.effectiveDates),
    skipped: normalizeBooleanMap(timeline?.skipped),
    moveCounts: normalizeNumberMap(timeline?.moveCounts),
    reopenedModules: normalizeBooleanMap(timeline?.reopenedModules),
  };
}

function normalizeCompletedTasks(completedTasks) {
  if (!Array.isArray(completedTasks)) {
    return [];
  }

  return completedTasks
    .map((completion) => ({
      taskId:
        typeof completion?.taskId === "string" ? completion.taskId : "",
      label: typeof completion?.label === "string" ? completion.label : "",
      timestamp: Number(completion?.timestamp) || 0,
      timeLabel:
        typeof completion?.timeLabel === "string" ? completion.timeLabel : "",
    }))
    .filter((completion) => completion.taskId || completion.label);
}

function hasDailyEntry(entry) {
  return Boolean(
    entry?.done?.trim() ||
      entry?.reminder?.trim() ||
      entry?.completedTasks?.length
  );
}

function normalizeDailyEntryData(entry) {
  return {
    done: typeof entry?.done === "string" ? entry.done : "",
    reminder: typeof entry?.reminder === "string" ? entry.reminder : "",
    completedTasks: normalizeCompletedTasks(entry?.completedTasks),
  };
}

function normalizeDailyLog(dailyLog) {
  const normalized = {};

  if (!dailyLog || typeof dailyLog !== "object") {
    return normalized;
  }

  Object.entries(dailyLog).forEach(([dateKey, entry]) => {
    const normalizedEntry = normalizeDailyEntryData(entry);

    if (hasDailyEntry(normalizedEntry)) {
      normalized[dateKey] = normalizedEntry;
    }
  });

  return normalized;
}

function normalizeState(candidate) {
  return {
    tasks: normalizeTaskMap(candidate?.tasks),
    notes: normalizeNotesMap(candidate?.notes),
    dailyLog: normalizeDailyLog(candidate?.dailyLog),
    deadlines: normalizeDeadlineMap(candidate?.deadlines),
    timeline: normalizeTimelineState(candidate?.timeline),
    updatedAt: Number(candidate?.updatedAt) || Date.now(),
  };
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload, null, 2), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

async function ensureDataDir() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
}

async function readStateFile() {
  try {
    const raw = await fs.promises.readFile(STATE_FILE, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ...DEFAULT_STATE };
    }

    throw error;
  }
}

async function writeStateFile(nextState) {
  await ensureDataDir();

  try {
    const current = await fs.promises.readFile(STATE_FILE, "utf8");
    await fs.promises.writeFile(BACKUP_FILE, current, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const normalized = normalizeState(nextState);
  const tempFile = `${STATE_FILE}.tmp`;

  await fs.promises.writeFile(
    tempFile,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8"
  );
  await fs.promises.rename(tempFile, STATE_FILE);

  return normalized;
}

async function readRequestBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function serveStaticFile(res, pathname) {
  const fileName = STATIC_ROUTES[pathname];

  if (!fileName) {
    send(res, 404, "Not found", {
      "Content-Type": "text/plain; charset=utf-8",
    });
    return;
  }

  const filePath = path.join(ROOT_DIR, fileName);
  const extension = path.extname(filePath);
  const contentType =
    CONTENT_TYPES[extension] || "application/octet-stream";

  try {
    const file = await fs.promises.readFile(filePath);
    send(res, 200, file, {
      "Content-Type": contentType,
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=60",
    });
  } catch (error) {
    send(res, 500, "Failed to read file", {
      "Content-Type": "text/plain; charset=utf-8",
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    send(res, 204, "", {
      "Cache-Control": "no-store",
    });
    return;
  }

  if (url.pathname === "/api/state") {
    if (req.method === "GET") {
      try {
        const state = await readStateFile();
        sendJson(res, 200, { state });
      } catch (error) {
        sendJson(res, 500, { error: "Failed to read saved state." });
      }
      return;
    }

    if (req.method === "POST") {
      try {
        const body = await readRequestBody(req);
        const payload = body ? JSON.parse(body) : {};
        const nextState = await writeStateFile(payload?.state ?? payload);
        sendJson(res, 200, { ok: true, state: nextState });
      } catch (error) {
        sendJson(res, 400, { error: "Failed to write saved state." });
      }
      return;
    }

    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed", {
      "Content-Type": "text/plain; charset=utf-8",
    });
    return;
  }

  await serveStaticFile(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Progress tracker running at http://${HOST}:${PORT}`);
  console.log(`Saved state file: ${STATE_FILE}`);
});
