// Port of the usage logic in usage.py. No vscode dependency, so it can be tested alone.
const fs = require("fs");
const os = require("os");
const path = require("path");

// API prices in $/MTok: [input, output, cache read]. The limits follow cost, not tokens, so a fixed
// weight set drifts with the model mix and cache TTL of each window. Cache read is 0.1x input unless
// the model's price list says otherwise.
const PRICES = {
  "claude-fable-5-2": [8, 40, 0.2],
  "claude-fable-5-1": [10, 50, 0.25],
  "claude-fable-5": [10, 50],
  "claude-mythos-5-2": [8, 40, 0.2],
  "claude-mythos-5-1": [10, 50, 0.25],
  "claude-mythos-5": [10, 50],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-opus-4-5": [5, 25],
  "claude-sonnet-5-5": [2, 10, 0.1],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-sonnet-4-5": [3, 15],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
};
// a model not in the list costs as the newest of its family; anything else as Opus 5.5
const FAMILY = { fable: "claude-fable-5-2", mythos: "claude-mythos-5-2", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
// models that cost more when the prompt (input + cache reads + cache writes) is over `over` tokens
const LONG_PROMPT = { "claude-haiku-5-5": { over: 100000, factor: 5 } };
// fast mode (usage.speed "fast") costs 2x on every model that has it (Opus 5.5, Opus 5, Opus 4.8, Fable 5.2, Mythos 5.2)
const FAST = 2;
const UNIT = 4; // usage is counted in Opus 5.5 input tokens
// cache writes, as a multiple of the model's input price
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const HOUR = 3600 * 1000;

/** Price list id of a model id like "claude-opus-4-8[1m]" or "us.anthropic.claude-…". */
function modelId(model = "") {
  // "claude-opus-5" must not match "claude-opus-5-5", but "claude-haiku-4-5" matches "claude-haiku-4-5-20251001"
  return Object.keys(PRICES).find((k) => new RegExp(`${k}(?!-\\d{1,2}\\b)`).test(model))
    || FAMILY[Object.keys(FAMILY).find((f) => model.includes(f))] || "claude-opus-5-5";
}

/** [input, output, cache read] in Opus 5.5 input tokens, for a model id (see modelId). */
function weights(model = "") {
  const [input, output, cacheRead = input / 10] = PRICES[modelId(model)];
  return { input: input / UNIT, output: output / UNIT, cacheRead: cacheRead / UNIT };
}

/** Cost of one message's usage, in Opus 5.5 input tokens. */
function weigh(u, model) {
  const w = weights(model);
  const write = u.cache_creation_input_tokens || 0;
  const write1h = Math.min(write, (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0);
  const cost = (u.input_tokens || 0) * w.input
    + (u.output_tokens || 0) * w.output
    + ((write - write1h) * CACHE_WRITE_5M + write1h * CACHE_WRITE_1H) * w.input
    + (u.cache_read_input_tokens || 0) * w.cacheRead;
  const long = LONG_PROMPT[modelId(model)];
  const prompt = (u.input_tokens || 0) + write + (u.cache_read_input_tokens || 0);
  return cost * (long && prompt > long.over ? long.factor : 1) * (u.speed === "fast" ? FAST : 1);
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
      total += weigh(m.usage, m.model);
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

/** Whether two resetsAt values are the same 5h window (resetsAt jitters by sub-seconds between calls). */
function sameWindow(a, b) {
  const minute = (t) => Math.round(Date.parse(t) / 60000);
  return !!a && !!b && minute(a) === minute(b);
}

/**
 * Calibration readings for the current 5h window, updated with one server reading:
 * { resetsAt, lastPercent, samples: [{ used, percent }], limit }.
 * The server percent is a whole number and the reading lags, so a single reading can be off by 5-10%.
 * A sample is taken only when the percent goes up since the previous reading (then "17" is close to 17.0,
 * not anywhere up to 17.99), and the limit is a least-squares fit over all samples of the window, so it
 * settles instead of jumping. A new window starts over without a limit: the last window's may be from
 * another plan, or include usage from claude.ai. Samples below `minPercent` are too rough.
 * A window marked `excluded` (see excludeWindow) takes no samples.
 */
function addCalibrationReading(calib, fiveHour, root, minPercent = 10) {
  if (!fiveHour || !fiveHour.resetsAt || !(fiveHour.percent >= 0)) return calib;
  const same = calib && sameWindow(calib.resetsAt, fiveHour.resetsAt);
  const next = same ? { ...calib, samples: [...calib.samples] } : { resetsAt: fiveHour.resetsAt, samples: [] };
  const p = fiveHour.percent;
  if (same && !calib.excluded && p > calib.lastPercent && p >= minPercent) {
    const used = usageSince(Date.parse(fiveHour.resetsAt) - 5 * HOUR, root);
    if (used > 0) {
      next.samples.push({ used, percent: p });
      // used = limit * percent / 100, fitted through the origin
      const sum = (f) => next.samples.reduce((a, s) => a + f(s), 0);
      next.limit = (100 * sum((s) => s.used * s.percent)) / sum((s) => s.percent * s.percent);
    }
  }
  next.lastPercent = p;
  return next;
}

/**
 * The calibration with the window of `fiveHour` marked as excluded: Claude was used elsewhere in it (claude.ai,
 * another computer), which the local logs do not have, so its estimate would be wrong. The next window starts over.
 */
function excludeWindow(calib, fiveHour) {
  const same = calib && sameWindow(calib.resetsAt, fiveHour.resetsAt);
  return { resetsAt: fiveHour.resetsAt, lastPercent: same ? calib.lastPercent : fiveHour.percent, samples: [], excluded: true };
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

/**
 * Weighted tokens of one session file incl. its subagents (like `usage.py <file>`), in one read:
 * `total` of the whole chat, and `recent` from messages newer than `since` (ms epoch), so a chat that
 * began before the 5h window counts only its part in the window.
 */
function sessionTotals(main, since = 0) {
  const files = [main, ...jsonlFiles(path.join(main.slice(0, -".jsonl".length), "subagents"))];
  const seen = new Set();
  let total = 0, recent = 0;
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
      const w = weigh(m.usage, m.model);
      total += w;
      if (Date.parse(e.timestamp) >= since) recent += w;
    }
  }
  return { total, recent };
}

/** Weighted tokens of one session file incl. its subagents, from messages newer than `since` (all by default). */
function sessionUsage(main, since = 0) {
  return sessionTotals(main, since).recent;
}

/**
 * The chats whose process is still running, from ~/.claude/sessions/<pid>.json: [{ pid, file }], file being
 * the session's .jsonl (it may not exist yet). With `cwds`, only chats started in one of those folders (or below).
 */
function activeSessions(
  cwds,
  sessionsDir = path.join(os.homedir(), ".claude", "sessions"),
  projectsRoot = path.join(os.homedir(), ".claude", "projects")
) {
  let names;
  try { names = fs.readdirSync(sessionsDir); } catch { return []; }
  const sessions = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, n), "utf8"));
      if (cwds && !cwds.some((c) => s.cwd === c || s.cwd.startsWith(c + path.sep))) continue;
      process.kill(s.pid, 0); // throws if the process is gone (EPERM means it exists)
      sessions.push({ pid: s.pid, file: path.join(projectDir(s.cwd, projectsRoot), `${s.sessionId}.jsonl`) });
    } catch (e) { if (e.code === "EPERM") continue; }
  }
  return sessions;
}

/** Session files of the still-running chats (see activeSessions) that have a log yet. */
function activeSessionFiles(...args) {
  return activeSessions(...args).map((s) => s.file).filter((f) => fs.existsSync(f));
}

/** Summed weighted tokens since `since` of the active chats (see activeSessionFiles), and how many there are. */
function activeUsage(cwds, since, ...dirs) {
  const files = activeSessionFiles(cwds, ...dirs);
  return { count: files.length, total: files.reduce((sum, f) => sum + sessionUsage(f, since), 0) };
}

/** `ps -axo pid=,ppid=,pcpu=,rss=` output as a Map pid -> { ppid, cpu (% of one core), mem (bytes) }. */
function parsePs(text) {
  const procs = new Map();
  for (const line of text.split("\n")) {
    const [pid, ppid, cpu, rss] = line.trim().split(/\s+/).map(Number);
    if (pid > 0) procs.set(pid, { ppid, cpu, mem: rss * 1024 });
  }
  return procs;
}

/** A snapshot of all processes (see parsePs). macOS and Linux only. */
function processSnapshot() {
  return new Promise((resolve, reject) => require("child_process").execFile("ps", ["-axo", "pid=,ppid=,pcpu=,rss="],
    { maxBuffer: 16 * 1024 * 1024 }, (err, out) => err ? reject(err) : resolve(parsePs(out))));
}

/** The pids of `pids` and all their descendants in a parsePs snapshot. */
function processTree(procs, pids) {
  const tree = new Set(pids.filter((p) => procs.has(p)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, p] of procs) if (!tree.has(pid) && tree.has(p.ppid)) { tree.add(pid); grew = true; }
  }
  return tree;
}

/** Summed CPU (% of one core) and memory (bytes) of some pids in a parsePs snapshot. */
function processUsage(procs, pids) {
  let cpu = 0, mem = 0;
  for (const pid of pids) { const p = procs.get(pid); if (p) { cpu += p.cpu; mem += p.mem; } }
  return { cpu, mem };
}

/** Claude Code's OAuth login (token, plan): macOS keychain, else ~/.claude/.credentials.json. */
function oauthCredentials() {
  let raw;
  if (process.platform === "darwin") {
    raw = require("child_process").execFileSync(
      "security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8" });
  } else {
    raw = fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8");
  }
  return JSON.parse(raw).claudeAiOauth;
}

const oauthToken = () => oauthCredentials().accessToken;

/** Starting 5h limit per plan, in weighted tokens, until calibrated. Max 20x is 4x Max 5x. */
const PLAN_LIMITS5H = { pro: 1000000, max_5x: 45000000, max_20x: 180000000 };
const PLAN_NAMES = { pro: "Pro", max_5x: "Max 5x", max_20x: "Max 20x" };

/** Plan key of PLAN_LIMITS5H from a rate limit tier ("default_claude_max_5x") or subscription type ("pro"). */
function planKey(tier = "", type = "") {
  if (/max_20x/.test(tier)) return "max_20x";
  if (/max/.test(tier) || type === "max") return "max_5x";
  if (tier || type === "pro") return "pro";
}

/**
 * The account's current plan (a PLAN_LIMITS5H key) from the profile endpoint (undocumented, may change).
 * Falls back to the plan saved at login, which is not updated after an upgrade until the next sign-in.
 */
async function fetchPlan() {
  try {
    const r = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: { Authorization: `Bearer ${oauthToken()}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!r.ok) throw new Error(`profile endpoint returned ${r.status}`);
    const j = await r.json();
    const plan = planKey(j.organization && j.organization.rate_limit_tier);
    if (plan) return plan;
  } catch { /* use the login's plan */ }
  const c = oauthCredentials();
  return planKey(c.rateLimitTier, c.subscriptionType);
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

module.exports = { PRICES, weights, weigh, usageSince, usage5h, usage7d, estimateLimit5h, sameWindow, addCalibrationReading, excludeWindow, projectDir, findSessionByTitle, sessionTotals, sessionUsage, activeSessions, activeSessionFiles, activeUsage, parsePs, processSnapshot, processTree, processUsage, fetchServerUsage, PLAN_LIMITS5H, PLAN_NAMES, planKey, fetchPlan };
