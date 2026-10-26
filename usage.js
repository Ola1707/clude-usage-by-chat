// Port of the usage logic in usage.py. No vscode dependency, so it can be tested alone.
const fs = require("fs");
const os = require("os");
const path = require("path");

const WEIGHTS = {
  input_tokens: 1,
  output_tokens: 5,
  cache_creation_input_tokens: 1.25,
  cache_read_input_tokens: 0.1,
};
const HOUR = 3600 * 1000;

function weigh(u) {
  let sum = 0;
  for (const k in WEIGHTS) sum += (u[k] || 0) * WEIGHTS[k];
  return sum;
}

function* jsonlFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

/** Weighted tokens of all assistant messages (incl. subagents) newer than `since` (ms epoch). */
function usageSince(since, root = path.join(os.homedir(), ".claude", "projects")) {
  const seen = new Set(); // same message in a resumed session: count once
  let total = 0;
  for (const file of jsonlFiles(root)) {
    try { if (fs.statSync(file).mtimeMs < since) continue; } catch { continue; }
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const m = e.message;
      if (e.type !== "assistant" || !m || !m.usage) continue;
      if (!(Date.parse(e.timestamp) >= since)) continue;
      const id = m.id || e.uuid;
      if (seen.has(id)) continue;
      seen.add(id);
      total += weigh(m.usage);
    }
  }
  return total;
}

function usage5h(now = Date.now(), root) {
  return usageSince(now - 5 * HOUR, root);
}

function usage7d(now = Date.now(), root) {
  return usageSince(now - 7 * 24 * HOUR, root);
}

/**
 * 5h limit in weighted tokens, from the server's 5h percent and our own usage since that window
 * began (it ends at `resetsAt`, so it began 5h before). Undefined below `minPercent`: a small
 * percent gives a poor estimate.
 */
function estimateLimit5h(fiveHour, root, minPercent = 10) {
  if (!fiveHour || !(fiveHour.percent >= minPercent) || !fiveHour.resetsAt) return;
  const used = usageSince(Date.parse(fiveHour.resetsAt) - 5 * HOUR, root);
  return used > 0 ? used / (fiveHour.percent / 100) : undefined;
}

/** ~/.claude/projects/<dir> for a workspace folder: path with / and . replaced by -. */
function projectDir(cwd, root = path.join(os.homedir(), ".claude", "projects")) {
  return path.join(root, cwd.replace(/[/\\.]/g, "-"));
}

/**
 * Session file whose (last) ai-title equals `title`, or undefined. Titles are what the chat tab shows.
 * Looks only at `only` (session files) when given, else at every session file in `dir`. When several
 * match (same title), the most recently modified wins; an exact match beats a "…"-truncated prefix match.
 */
function findSessionByTitle(title, dir, only) {
  let files = only;
  if (!files) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    files = names.filter((n) => n.endsWith(".jsonl")).map((n) => path.join(dir, n));
  }
  const newest = (a, b) => (!a || fs.statSync(b).mtimeMs > fs.statSync(a).mtimeMs ? b : a);
  let exact, prefix;
  for (const file of files) {
    let last;
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.includes('"ai-title"')) continue;
        try { const e = JSON.parse(line); if (e.type === "ai-title") last = e.aiTitle; } catch { /* skip */ }
      }
    } catch { continue; }
    if (last === title) exact = newest(exact, file);
    // tab labels are truncated with "…"
    else if (last && title.endsWith("…") && last.startsWith(title.slice(0, -1))) prefix = newest(prefix, file);
  }
  return exact || prefix;
}

/** Weighted tokens of one session file incl. its subagents (like `usage.py <file>`). */
function sessionUsage(main) {
  const files = [main, ...jsonlFiles(path.join(main.slice(0, -".jsonl".length), "subagents"))];
  const seen = new Set();
  let total = 0;
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const m = e.message;
      if (e.type !== "assistant" || !m || !m.usage) continue;
      const id = m.id || e.uuid;
      if (seen.has(id)) continue;
      seen.add(id);
      total += weigh(m.usage);
    }
  }
  return total;
}

/**
 * Session files of the chats whose process is still running, from ~/.claude/sessions/<pid>.json.
 * With `cwds`, only chats started in one of those folders (or below); without, all of them.
 */
function activeSessionFiles(
  cwds,
  sessionsDir = path.join(os.homedir(), ".claude", "sessions"),
  projectsRoot = path.join(os.homedir(), ".claude", "projects")
) {
  let names;
  try { names = fs.readdirSync(sessionsDir); } catch { return []; }
  const files = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, n), "utf8"));
      if (cwds && !cwds.some((c) => s.cwd === c || s.cwd.startsWith(c + path.sep))) continue;
      process.kill(s.pid, 0); // throws if the process is gone (EPERM means it exists)
      const file = path.join(projectDir(s.cwd, projectsRoot), `${s.sessionId}.jsonl`);
      if (fs.existsSync(file)) files.push(file);
    } catch (e) { if (e.code === "EPERM") continue; }
  }
  return files;
}

/** Summed weighted tokens of the active chats (see activeSessionFiles), and how many there are. */
function activeUsage(...args) {
  const files = activeSessionFiles(...args);
  return { count: files.length, total: files.reduce((sum, f) => sum + sessionUsage(f), 0) };
}

/** Claude Code's OAuth token: macOS keychain, else ~/.claude/.credentials.json. */
function oauthToken() {
  let raw;
  if (process.platform === "darwin") {
    raw = require("child_process").execFileSync(
      "security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8" });
  } else {
    raw = fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8");
  }
  return JSON.parse(raw).claudeAiOauth.accessToken;
}

/** Server-side numbers (same as Claude Code's /usage). Undocumented endpoint, may change. */
async function fetchServerUsage() {
  const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${oauthToken()}`, "anthropic-beta": "oauth-2025-04-20" },
  });
  if (!r.ok) throw new Error(`usage endpoint returned ${r.status}`);
  const j = await r.json();
  return {
    fiveHour: j.five_hour && { percent: j.five_hour.utilization, resetsAt: j.five_hour.resets_at },
    weekly: j.seven_day && { percent: j.seven_day.utilization, resetsAt: j.seven_day.resets_at },
  };
}

module.exports = { WEIGHTS, weigh, usageSince, usage5h, usage7d, estimateLimit5h, projectDir, findSessionByTitle, sessionUsage, activeSessionFiles, activeUsage, fetchServerUsage };
