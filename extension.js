const vscode = require("vscode");
const { projectDir, findSessionByTitle, sessionUsage, activeUsage, activeSessionFiles, fetchServerUsage, estimateLimit5h } = require("./usage");

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

// The usage endpoint rate-limits (429). Fetch at most every 10 minutes (20 after an error), keep the last good value.
let server, serverAt = 0, serverError;
async function cachedServerUsage(onFetched) {
  const wait = serverError ? 20 * 60 * 1000 : 10 * 60 * 1000;
  if (Date.now() - serverAt >= wait) {
    serverAt = Date.now();
    try { server = await fetchServerUsage(); serverError = undefined; onFetched(server); }
    catch (err) { serverError = err; }
  }
  if (!server) throw serverError;
  return server;
}

// 5h limit calibrated from the server's 5h percent: { limit, percent, resetsAt, at } in globalState.
// Each server fetch (every 10 min) stores its own estimate, so it can be watched as it moves.
function calibrate(state, fiveHour) {
  const limit = estimateLimit5h(fiveHour);
  if (!limit) return;
  state.update("limit5h", { limit, percent: fiveHour.percent, resetsAt: fiveHour.resetsAt, at: Date.now() });
}

/** Calibrated 5h limit (if claudeUsage.autoCalibrate), else the claudeUsage.limit5h setting. */
function limit5h(state) {
  const config = vscode.workspace.getConfiguration("claudeUsage");
  return (config.get("autoCalibrate", false) && state.get("limit5h")?.limit) || config.get("limit5h", 7500000);
}

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  item.tooltip = "Claude usage (5h and weekly)";
  item.show();
  // the focused chat in its own item, so only its text gets colored
  const chatItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
  chatItem.tooltip = "Focused chat, as % of the 5h limit";
  chatItem.show();
  // calibrated estimate vs the limit5h setting: ×2.00 means the real limit is twice the setting
  const calItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
  calItem.show();
  // button: write the calibrated estimate into the limit5h setting
  const setItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -3);
  setItem.text = "$(sync) update 5h limit";
  setItem.tooltip = "Update claudeUsage.limit5h to the calibrated estimate (asks for confirmation first)";
  setItem.command = "claudeUsage.setLimitFromCalibration";
  setItem.show();

  const refreshCal = () => {
    const cal = context.globalState.get("limit5h");
    const setting = vscode.workspace.getConfiguration("claudeUsage").get("limit5h", 7500000);
    if (!cal) {
      calItem.text = "est: ?";
      calItem.tooltip = "No calibrated estimate yet (needs the server 5h percent at 10% or more)";
      return;
    }
    calItem.text = `est: ×${(cal.limit / setting).toFixed(2)}`;
    calItem.tooltip = `Estimated 5h limit: ${Math.round(cal.limit).toLocaleString()}\n` +
      `Setting: ${setting.toLocaleString()}\n` +
      `From the server at ${Math.round(cal.percent)}%, ${new Date(cal.at || Date.now()).toLocaleTimeString()} ` +
      `(window resets ${new Date(cal.resetsAt).toLocaleTimeString()})`;
  };

  // the focused chat is local only (no server call), so it has its own, faster timer
  const refreshChat = () => {
    // chat in the focused editor tab, as % of the 5h limit (like `usage.py <file>`)
    // always shown: "?" means no chat tab matched (see the tooltip for what the active tab reports)
    let chat = "chat: ?", color;
    try {
      const file = focusedChatFile();
      if (file) {
        const percent = (sessionUsage(file) / limit5h(context.globalState)) * 100;
        chat = `chat: ${percent.toFixed(1)}%`;
        color = percent > 20 ? "charts.red" : percent > 10 ? "charts.orange" : percent > 5 ? "charts.yellow" : "charts.green";
      }
    } catch { /* keep "?" */ }
    chatItem.text = chat;
    chatItem.color = color && new vscode.ThemeColor(color);
    return chat;
  };

  const refresh = async () => {
    const chat = refreshChat();
    let chats = "";
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const tabInfo = `\nActive tab: "${tab?.label}" (${tab?.input?.viewType || tab?.input?.constructor?.name || "none"})`;
    debugDump({ tabs: vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => ({ label: t.label, active: t.isActive, groupActive: g.isActive, viewType: t.input?.viewType, kind: t.input?.constructor?.name }))), chat });
    // still-running chats of this window's workspace summed, as % of the 5h limit, with their count
    // (no folder open: leave the chats part out rather than show every window's chats)
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders) throw new Error("no workspace folder");
      const { count, total } = activeUsage(folders.map((f) => f.uri.fsPath));
      chats = ` | chats: ${((total / limit5h(context.globalState)) * 100).toFixed(1)}% (${count})`;
    } catch { /* leave the chats part out */ }
    try {
      const { fiveHour, weekly } = await cachedServerUsage((s) => calibrate(context.globalState, s.fiveHour));
      refreshCal();
      const cal = context.globalState.get("limit5h");
      const auto = vscode.workspace.getConfiguration("claudeUsage").get("autoCalibrate", false);
      const calInfo = cal && `${Math.round(cal.limit).toLocaleString()} (calibrated at ${Math.round(cal.percent)}%)`;
      const limitInfo = auto && cal
        ? `5h limit: ${calInfo}`
        : `5h limit: ${limit5h(context.globalState).toLocaleString()} (setting)` +
          (cal ? `\nCalibrated estimate, not used: ${calInfo}` : "");
      item.text = `🦄 5h: ${Math.round(fiveHour.percent)}% | week: ${Math.round(weekly.percent)}%${chats}`;
      item.tooltip = `Claude usage\n5h resets ${new Date(fiveHour.resetsAt).toLocaleTimeString()}\nWeek resets ${new Date(weekly.resetsAt).toLocaleString()}\n${limitInfo}${tabInfo}`;
    } catch (err) {
      // server unavailable: show "?" rather than a wrong number, with the error on hover
      debugDump({ serverError: String(err && (err.stack || err)), cause: String(err && err.cause) });
      item.text = `$(warning) 5h: ? | week: ?${chats}`;
      item.tooltip = `Claude usage unavailable: ${err && err.message}${tabInfo}`;
    }
  };

  let timer, chatTimer;
  const schedule = () => {
    clearInterval(timer);
    clearInterval(chatTimer);
    const config = vscode.workspace.getConfiguration("claudeUsage");
    timer = setInterval(refresh, Math.max(5, config.get("refreshSeconds", 60)) * 1000);
    chatTimer = setInterval(refreshChat, Math.max(1, config.get("chatRefreshSeconds", 5)) * 1000);
  };

  refresh();
  schedule();
  refreshCal();
  context.subscriptions.push(
    item,
    chatItem,
    calItem,
    setItem,
    vscode.commands.registerCommand("claudeUsage.setLimitFromCalibration", async () => {
      const cal = context.globalState.get("limit5h");
      if (!cal) return vscode.window.showWarningMessage("No calibrated 5h estimate yet (needs the server 5h percent at 10% or more).");
      const limit = Math.round(cal.limit);
      const current = vscode.workspace.getConfiguration("claudeUsage").get("limit5h");
      const choice = await vscode.window.showInformationMessage(
        "Update the 5h limit?",
        {
          modal: true,
          detail:
            `This changes your user setting "claudeUsage.limit5h" (the token budget used to turn 5h usage into a percentage).\n\n` +
            `Current: ${current != null ? Number(current).toLocaleString() : "not set"}\n` +
            `New: ${limit.toLocaleString()} (estimated from the server's ${Math.round(cal.percent)}% reading)\n\n` +
            `Usage from other machines or claude.ai is not in the local logs, so the estimate can be too low.`,
        },
        "Update"
      );
      if (choice !== "Update") return;
      await vscode.workspace.getConfiguration("claudeUsage").update("limit5h", limit, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`claudeUsage.limit5h set to ${limit.toLocaleString()} (calibrated at ${Math.round(cal.percent)}%).`);
    }),
    { dispose: () => { clearInterval(timer); clearInterval(chatTimer); } },
    vscode.window.tabGroups.onDidChangeTabs(() => refresh()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeUsage")) { refreshCal(); refresh(); schedule(); }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
