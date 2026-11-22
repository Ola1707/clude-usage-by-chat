const vscode = require("vscode");
const { projectDir, findSessionByTitle, sessionTotals, activeUsage, activeSessions, activeSessionFiles, fetchServerUsage, addCalibrationReading, excludeWindow, sameWindow,
  fetchPlan, PLAN_LIMITS5H, PLAN_NAMES, processSnapshot, processTree, processUsage } = require("./usage");

// The chat tab's title is the session's ai-title. Keep the last chat seen, so
// focusing a non-chat tab (or the sidebar chat, which is not a tab) keeps the value.
let lastChatFile;
function focusedChatFile() {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (tab && folder && /claudeVSCodePanel$/.test(tab.input?.viewType || "")) {
    // match the title among the open chats first, so older chats do not compete; all chats only as a fallback
    const dir = projectDir(folder.uri.fsPath);
    lastChatFile = findSessionByTitle(tab.label, dir, activeSessionFiles([folder.uri.fsPath])) ||
      findSessionByTitle(tab.label, dir) || lastChatFile;
  }
  return lastChatFile;
}

// TEMP debug: what the extension sees, for diagnosing the chat tab match
function debugDump(o) {
  try {
    const f = require("path").join(require("os").tmpdir(), "claude-usage-debug.json");
    const prev = (() => { try { return JSON.parse(require("fs").readFileSync(f, "utf8")); } catch { return {}; } })();
    require("fs").writeFileSync(f, JSON.stringify({ ...prev, ...o, at: new Date().toISOString() }, null, 1));
  } catch { /* ignore */ }
}

// The usage endpoint rate-limits (429). Fetch at most every 5 minutes (20 after an error), keep the last good value.
// The cache is a file, so all VS Code windows share it and only one of them calls the API.
// (globalState would not do: a window does not see another window's updates until it reloads.)
const CACHE_FILE = require("path").join(require("os").tmpdir(), "claude-usage-server.json");
const readCache = () => { try { return JSON.parse(require("fs").readFileSync(CACHE_FILE, "utf8")); } catch { return {}; } };
const writeCache = (c) => { try { require("fs").writeFileSync(CACHE_FILE, JSON.stringify(c)); } catch { /* ignore */ } };

// Start of the server's current 5h window (ms epoch), from the last server value: chats that began before it
// count only their messages since. Window already reset (stale value): the new one began at the old resetsAt
// or later. No server value yet: the last 5h.
function windowStart5h(now = Date.now()) {
  const resetsAt = Date.parse(readCache().value?.fiveHour?.resetsAt);
  if (!(resetsAt > 0)) return now - 5 * 3600 * 1000;
  return resetsAt <= now ? resetsAt : resetsAt - 5 * 3600 * 1000;
}

// force (the refresh buttons) skips the wait, but still not more than once every 30 seconds.
// The window that fetches also updates the calibration in the file (c.calib), so all windows show the same estimate.
let calibratedAt;
async function cachedServerUsage(onFetched, force = false) {
  let c = readCache();
  const wait = force ? 30 * 1000 : c.error ? 20 * 60 * 1000 : 5 * 60 * 1000;
  if (Date.now() - (c.attemptAt || 0) >= wait) {
    c = { ...c, attemptAt: Date.now() }; // claim the attempt first, so another window does not fetch too
    writeCache(c);
    try {
      const value = await fetchServerUsage();
      const { error, ...rest } = c;
      c = { ...rest, value, valueAt: Date.now(), calib: addCalibrationReading(c.calib, value.fiveHour) };
      // the plan rarely changes: ask at most hourly (and on a forced fetch, e.g. right after an upgrade)
      if (force || !c.plan || Date.now() - (c.planAt || 0) >= 3600 * 1000) {
        try { c.plan = (await fetchPlan()) || c.plan; c.planAt = Date.now(); } catch { /* keep the last plan */ }
      }
    }
    catch (err) { c = { ...c, error: String(err && err.message || err) }; }
    writeCache(c);
  }
  if (!c.value || (force && c.error)) throw new Error(c.error || "no server value yet");
  if (calibratedAt !== c.valueAt) { calibratedAt = c.valueAt; onFetched(c.calib); } // once per fetch, in each window
  return c.value;
}

// 5h limit calibrated from the server's 5h percent: { limit, percent, resetsAt, at, samples } in globalState.
// It changes only when the server's 5h percent goes up (see addCalibrationReading in usage.js).
function calibrate(state, calib) {
  const last = calib && calib.samples[calib.samples.length - 1];
  if (!last) return; // no new sample in this window yet: keep the stored estimate
  const prev = state.get("limit5h");
  if (prev && prev.limit === calib.limit) return;
  state.update("limit5h", { limit: calib.limit, percent: last.percent, resetsAt: calib.resetsAt, at: Date.now(), samples: calib.samples.length });
}

/**
 * The stored calibration if it was fitted in the server's current 5h window, else undefined: an earlier
 * window's limit may be from another plan (an upgrade makes it many times too small) or include claude.ai usage.
 */
function currentCalibration(state) {
  const cal = state.get("limit5h");
  return cal && !excludedWindow() && sameWindow(cal.resetsAt, readCache().value?.fiveHour?.resetsAt) ? cal : undefined;
}

/** Whether the user hid the cost estimate until the current 5h window resets (Claude used elsewhere in it). */
function excludedWindow() {
  const c = readCache();
  return !!(c.calib?.excluded && sameWindow(c.calib.resetsAt, c.value?.fiveHour?.resetsAt));
}

/** The claudeUsage.limit5h setting, or (0, the default) the starting limit of the account's plan; and where it came from. */
function configuredLimit5h() {
  const setting = vscode.workspace.getConfiguration("claudeUsage").get("limit5h", 0);
  if (setting > 0) return { limit: setting, source: "setting" };
  const plan = readCache().plan;
  return plan ? { limit: PLAN_LIMITS5H[plan], source: `${PLAN_NAMES[plan]} plan` }
    : { limit: PLAN_LIMITS5H.pro, source: "plan unknown yet, Pro assumed" };
}

/** Calibrated 5h limit of the current window (if claudeUsage.autoCalibrate), else configuredLimit5h. */
function limit5h(state) {
  const config = vscode.workspace.getConfiguration("claudeUsage");
  return (config.get("autoCalibrate", false) && currentCalibration(state)?.limit) || configuredLimit5h().limit;
}

// Estimated cost of a token vs what the status bar assumes: the limit5h setting / the calibrated limit.
// ×1.14 means the real limit is smaller, so a chat really costs 14% more than the status bar says. Rename the label here.
const COST_LABEL = "cost est";
const OTHER_USAGE_WARNING = "**Usage anywhere other than this computer (another machine, claude.ai on the web, mobile) " +
  "is not in the local logs, so the calculation will be off.**";

/** Status bar color for the cost ratio: above 1 = we use more than we think. */
function costColor(cost) {
  return cost > 1.3 ? "charts.red" : cost > 1.2 ? "charts.orange" : cost > 1.05 ? "charts.yellow" : cost < 0.7 ? "charts.green" : undefined;
}

function activate(context) {
  // 5h and weekly (from the server); click to fetch them now
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  item.command = "claudeUsage.refreshServer";
  item.show();
  // still-running chats of this workspace
  const chatsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -0.5);
  chatsItem.tooltip = "Still-running chats of this workspace in the current 5h window, as % of the 5h limit (count)";
  chatsItem.show();
  // the focused chat in its own item, so only its text gets colored
  const chatItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
  chatItem.tooltip = "Focused chat in the current 5h window, as % of the 5h limit";
  chatItem.show();
  // CPU and memory of the still-running chats' processes, and of the focused chat's process
  const procItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1.5);
  procItem.show();
  // cost estimate (see COST_LABEL) with its update icon in the same item, so they sit together;
  // click: fetch the server now, then a menu: write the estimate into the limit5h setting, or hide the item
  const calItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
  calItem.command = "claudeUsage.setLimitFromCalibration";
  calItem.show();
  // gear icon, last: opens this extension's settings
  const settingsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2.5);
  settingsItem.text = "$(gear)";
  settingsItem.tooltip = "Claude usage settings";
  settingsItem.command = "claudeUsage.openSettings";
  settingsItem.show();

  const refreshCal = () => {
    // hidden for good (setting), or until the 5h reset (Claude used elsewhere in this window)
    if (!vscode.workspace.getConfiguration("claudeUsage").get("showCostEstimate", true) || excludedWindow()) {
      calItem.hide();
      return;
    }
    calItem.show();
    const cal = currentCalibration(context.globalState);
    const { limit: setting, source } = configuredLimit5h();
    if (!cal) {
      const old = context.globalState.get("limit5h");
      calItem.text = `${COST_LABEL}: ? $(sync)`;
      calItem.color = undefined;
      calItem.tooltip = new vscode.MarkdownString(
        "No estimate for this 5h window yet (needs the server 5h percent at 10% or more)" +
        (old ? `  \nAn earlier window's estimate (${Math.round(old.limit).toLocaleString()}) is not used: ` +
          "the plan or usage elsewhere may have changed since." : "") + "\n\n" + OTHER_USAGE_WARNING);
      return;
    }
    const cost = setting / cal.limit;
    const color = costColor(cost);
    calItem.text = `${COST_LABEL}: ×${cost.toFixed(2)} $(sync)`;
    calItem.color = color && new vscode.ThemeColor(color);
    const advice = cost > 1.05
      ? `Your usage costs **×${cost.toFixed(2)}** what the status bar assumes: you use more than it says. ` +
        "**Update the 5h limit** (click here).\n\n"
      : cost < 0.7
        ? `Your usage costs **×${cost.toFixed(2)}** what the status bar assumes: you have more room than it says.\n\n`
        : "";
    calItem.tooltip = new vscode.MarkdownString(advice +
      `Estimated 5h limit: ${Math.round(cal.limit).toLocaleString()}  \n` +
      `Status bar uses: ${setting.toLocaleString()} (${source})  \n` +
      `Fitted from ${cal.samples || 1} server reading(s), last at ${Math.round(cal.percent)}%, ${new Date(cal.at || Date.now()).toLocaleTimeString()} ` +
      `(window resets ${new Date(cal.resetsAt).toLocaleTimeString()})\n\n` + OTHER_USAGE_WARNING, true);
  };

  // the focused chat is local only (no server call), so it has its own, faster timer
  const refreshChat = () => {
    // chat in the focused editor tab, as % of the 5h limit (like `usage.py <file>`)
    // always shown: "?" means no chat tab matched (see the tooltip for what the active tab reports)
    let chat = "chat: ?", color;
    try {
      const file = focusedChatFile();
      if (file) {
        const limit = limit5h(context.globalState);
        const { total, recent } = sessionTotals(file, windowStart5h());
        const percent = (recent / limit) * 100;
        chat = `chat: ${percent.toFixed(1)}%`;
        // the whole chat too, as it may have begun in an earlier window
        chatItem.tooltip = `Focused chat in the current 5h window, as % of the 5h limit\n` +
          `Whole chat: ${((total / limit) * 100).toFixed(1)}%`;
        color = percent > 20 ? "charts.red" : percent > 10 ? "charts.orange" : percent > 5 ? "charts.yellow" : "charts.green";
      }
    } catch { /* keep "?" */ }
    chatItem.text = chat;
    chatItem.color = color && new vscode.ThemeColor(color);
    return chat;
  };

  // CPU (% of one core, like Activity Monitor) and memory from `ps`. Subagents run inside the chat's process;
  // its child processes (shell commands, MCP servers) are counted in the "with children" numbers.
  const mb = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}GB` : `${Math.round(bytes / 1024 ** 2)}MB`;
  const refreshProc = async () => {
    try {
      const config = vscode.workspace.getConfiguration("claudeUsage");
      const show = config.get("processStats", "cpu+memory");
      if (show === "off") throw new Error("hidden");
      const children = config.get("processIncludeChildren", true);
      const fmt = ({ cpu, mem }) => [show !== "memory" && `${Math.round(cpu)}%`, show !== "cpu" && mb(mem)].filter(Boolean).join(" ");
      const folders = vscode.workspace.workspaceFolders;
      if (!folders) throw new Error("no workspace folder");
      const sessions = activeSessions(folders.map((f) => f.uri.fsPath));
      const procs = await processSnapshot();
      const pids = (ps) => children ? processTree(procs, ps) : ps;
      const all = processUsage(procs, pids(sessions.map((s) => s.pid)));
      const focused = sessions.find((s) => s.file === lastChatFile);
      const self = focused && processUsage(procs, [focused.pid]);
      const tree = focused && processUsage(procs, processTree(procs, [focused.pid]));
      const what = show === "cpu" ? "CPU (% of one core)" : show === "memory" ? "Memory" : "CPU (% of one core) and memory";
      procItem.text = `$(pulse) chats: ${fmt(all)} chat: ${focused ? fmt(children ? tree : self) : "?"}`;
      procItem.tooltip = `${what}${children ? ", with child processes" : ", chat processes only"}\n` +
        `Still-running chats of this workspace (${sessions.length}): ${fmt(all)}\n` +
        (focused ? `Focused chat process (pid ${focused.pid}): ${fmt(self)}\nFocused chat with its child processes: ${fmt(tree)}`
          : "Focused chat: no running process found") +
        "\nSubagents run inside the chat's process; child processes are shell commands and MCP servers." +
        "\nConfigure with the claudeUsage.process* settings.";
      procItem.show();
    } catch { procItem.hide(); }
  };

  const refresh = async (force = false) => {
    const chat = refreshChat();
    refreshProc();
    let chats = "";
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const tabInfo = `\nActive tab: "${tab?.label}" (${tab?.input?.viewType || tab?.input?.constructor?.name || "none"})`;
    debugDump({ tabs: vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => ({ label: t.label, active: t.isActive, groupActive: g.isActive, viewType: t.input?.viewType, kind: t.input?.constructor?.name }))), chat });
    // still-running chats of this window's workspace summed, as % of the 5h limit, with their count
    // (no folder open: leave the chats part out rather than show every window's chats)
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders) throw new Error("no workspace folder");
      const { count, total } = activeUsage(folders.map((f) => f.uri.fsPath), windowStart5h());
      chats = `chats: ${((total / limit5h(context.globalState)) * 100).toFixed(1)}% (${count})`;
    } catch { /* leave the chats part out */ }
    chatsItem.text = chats;
    chats ? chatsItem.show() : chatsItem.hide();
    try {
      const { fiveHour, weekly } = await cachedServerUsage((calib) => calibrate(context.globalState, calib), force);
      refreshCal();
      const cal = context.globalState.get("limit5h");
      const auto = vscode.workspace.getConfiguration("claudeUsage").get("autoCalibrate", false);
      const calInfo = cal && `${Math.round(cal.limit).toLocaleString()} (calibrated at ${Math.round(cal.percent)}%)`;
      const limitInfo = auto && cal
        ? `5h limit: ${calInfo}`
        : `5h limit: ${limit5h(context.globalState).toLocaleString()} (${configuredLimit5h().source})` +
          (cal ? `\nCalibrated estimate, not used: ${calInfo}` : "");
      item.text = `🦄 5h: ${Math.round(fiveHour.percent)}% week: ${Math.round(weekly.percent)}% $(sync)`;
      item.tooltip = `Claude usage (click to fetch from the server now)\n5h resets ${new Date(fiveHour.resetsAt).toLocaleTimeString()}\nWeek resets ${new Date(weekly.resetsAt).toLocaleString()}\n${limitInfo}${tabInfo}`;
    } catch (err) {
      // server unavailable: show "?" rather than a wrong number, with the error on hover
      debugDump({ serverError: String(err && (err.stack || err)), cause: String(err && err.cause) });
      item.text = "$(warning) 5h: ? week: ? $(sync)";
      item.tooltip = `Claude usage unavailable: ${err && err.message}${tabInfo}`;
    }
  };

  let timer, chatTimer, procTimer;
  const schedule = () => {
    clearInterval(timer);
    clearInterval(chatTimer);
    clearInterval(procTimer);
    const config = vscode.workspace.getConfiguration("claudeUsage");
    timer = setInterval(refresh, Math.max(5, config.get("refreshSeconds", 60)) * 1000);
    chatTimer = setInterval(refreshChat, Math.max(1, config.get("chatRefreshSeconds", 5)) * 1000);
    procTimer = setInterval(refreshProc, Math.max(1, config.get("processRefreshSeconds", 5)) * 1000);
  };

  refresh();
  schedule();
  refreshCal();
  context.subscriptions.push(
    item,
    settingsItem,
    chatsItem,
    chatItem,
    procItem,
    calItem,
    vscode.commands.registerCommand("claudeUsage.refreshServer", () => refresh(true)),
    // the Settings UI filtered to this extension's settings
    vscode.commands.registerCommand("claudeUsage.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`)),
    vscode.commands.registerCommand("claudeUsage.setLimitFromCalibration", async () => {
      // recalibrate from a fresh server value first; on failure (e.g. 429) fall back to the last estimate
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Fetching Claude usage" },
          () => cachedServerUsage((calib) => calibrate(context.globalState, calib), true));
      } catch (err) {
        vscode.window.showWarningMessage(`Could not fetch the server usage (${err && err.message}); using the last estimate.`);
      }
      refresh();
      const cal = currentCalibration(context.globalState);
      const limit = cal && Math.round(cal.limit);
      const current = configuredLimit5h();
      const items = [
        cal && limit !== current.limit
          ? { id: "update", label: `$(check) Update the 5h limit to ${limit.toLocaleString()}`,
            description: `now ${current.limit.toLocaleString()} (${current.source})`,
            detail: `Estimated from the server's ${Math.round(cal.percent)}% reading. Saved in the claudeUsage.limit5h user setting.` }
          : { id: "none", label: cal ? `$(check) The 5h limit is already ${limit.toLocaleString()}` : "$(info) No estimate for this 5h window yet",
            detail: cal ? undefined : "Needs the server 5h percent at 10% or more." },
        { id: "window", label: "$(eye-closed) Hide until the 5h reset",
          detail: "I used Claude elsewhere in this window (claude.ai, another computer): its estimate would be wrong, so it is not calculated either." },
        { id: "forever", label: "$(close) Hide for good", detail: "Show it again with the claudeUsage.showCostEstimate setting." },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: "Claude usage: cost estimate" });
      if (!pick) return;
      if (pick.id === "update") {
        await vscode.workspace.getConfiguration("claudeUsage").update("limit5h", limit, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`claudeUsage.limit5h set to ${limit.toLocaleString()} (calibrated at ${Math.round(cal.percent)}%).`);
      } else if (pick.id === "window") {
        // in the shared cache file, so all VS Code windows hide it, and the next window starts over
        const c = readCache();
        if (!c.value?.fiveHour?.resetsAt) return vscode.window.showWarningMessage("No server 5h window yet; try again in a moment.");
        writeCache({ ...c, calib: excludeWindow(c.calib, c.value.fiveHour) });
        refreshCal();
        refresh();
        vscode.window.showInformationMessage(`Cost estimate hidden until the 5h reset at ${new Date(c.value.fiveHour.resetsAt).toLocaleTimeString()}.`);
      } else if (pick.id === "forever") {
        await vscode.workspace.getConfiguration("claudeUsage").update("showCostEstimate", false, vscode.ConfigurationTarget.Global);
      }
    }),
    { dispose: () => { clearInterval(timer); clearInterval(chatTimer); clearInterval(procTimer); } },
    vscode.window.tabGroups.onDidChangeTabs(() => refresh()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeUsage")) { refreshCal(); refresh(); schedule(); }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
