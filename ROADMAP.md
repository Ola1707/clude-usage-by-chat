# Roadmap

Goal: a status bar item in VS Code showing four usage values:
5h usage, weekly usage, active chats usage, current chat usage.

## Now

1. Show the 5h usage
2. Show the weekly usage
3. Show the usage percentage of the latest session (same as `python3 usage.py --last`)

## Next: current chat usage (the chat I am using)

Replaces the "latest session by date" logic from step 3. `updatedAt` in `~/.claude/sessions` is last activity, not focus, so it is not used.

1. The focused chat is the active editor tab (`vscode.window.tabGroups`) whose viewType ends with `claudeVSCodePanel`.
2. Its tab title is the session's last `ai-title` entry in `~/.claude/projects/<workspace path with / and . replaced by ->/*.jsonl`. Match them to find the session file.
3. Sum the weighted tokens of that file plus its subagents; show as a percentage of the 5h limit: `chat: N%`.
4. Focus on a non-chat tab (or the sidebar chat, which is not a tab) keeps the last chat seen.

Status: implemented and verified in VS Code. The title is matched among the open chats first (so older chats do not compete); if several open chats share a title, the most recently modified wins.

## Next: CPU and memory of the chats

One status bar item: `$(pulse) chats: CPU% MEM chat: CPU% MEM`, refreshed with the chat timer.

1. `chats`: the still-running chats of this workspace (`~/.claude/sessions/<pid>.json`) with all their child processes (shell commands, MCP servers), from `ps -axo pid,ppid,pcpu,rss`.
2. `chat`: the focused chat's own process. The tooltip also shows it with its child processes.
3. Subagents run inside the chat's process, so they have no process of their own. CPU is % of one core (like Activity Monitor). macOS and Linux only (`ps`); hidden elsewhere.

Status: implemented, not yet verified in VS Code.

## Next: publish to the VS Code Marketplace (for dummies)

The Marketplace is the store inside VS Code's Extensions panel. Publishing means: make an account, make a key, package the extension, upload it. Do the steps in order.

1. **Make a Microsoft account** (any outlook/hotmail/GitHub-linked one works) and sign in at https://dev.azure.com. This is only needed to create the access key; you do not use Azure for anything else.
2. **Create a Personal Access Token (PAT)**: in dev.azure.com click your avatar → *User settings* → *Personal access tokens* → *New Token*. Set *Organization* to **All accessible organizations**, *Scopes* → *Custom defined* → *Show all scopes* → tick **Marketplace → Manage**. Copy the token and store it somewhere safe (it is shown only once). Treat it as a password; never commit it.
3. **Create a publisher**: at https://marketplace.visualstudio.com/manage click *Create publisher*. Pick an ID (lowercase, no spaces, e.g. `olagerman`); it is permanent and is part of the extension's id (`<publisher>.claude-usage-by-chat`).
4. **Fix `package.json`** (the Marketplace rejects or looks bad without these):
   - `publisher`: change `local` to your publisher ID.
   - `repository`: `{ "type": "git", "url": "<your GitHub repo url>" }` (push the repo to GitHub first).
   - `license`: e.g. `"MIT"`, plus a `LICENSE` file in the repo root.
   - `icon`: a 128×128 PNG (e.g. `icon.png`).
   - `categories`: e.g. `["Other"]`; `keywords`: `["claude", "usage", "status bar"]`.
   - `engines.vscode`: keep as is unless a newer API is used.
5. **Write a `README.md`** (it becomes the extension page): what it shows (`5h`, `week`, `chats`, `chat`), a screenshot of the status bar, the settings, and the limitations above. Also say plainly that it reads local files in `~/.claude` and calls Anthropic's usage API with Claude Code's own login token (see "How it works"), and that nothing is sent anywhere else. Add a `CHANGELOG.md` with `0.0.1`.
6. **Add a `.vscodeignore`** so the package holds only what is needed: ignore `usage.py`, `test/**`, `ROADMAP.md`, `CLAUDE.md`, `.git/**`. (`usage.py` is reference only.)
7. **Install the packager**: `npm install -g @vscode/vsce`.
8. **Try the package locally**: `vsce package` creates `claude-usage-by-chat-0.0.1.vsix`. Install it with *Extensions panel → … → Install from VSIX* and check it works in a normal window.
9. **Log in and publish**: `vsce login <publisher-id>` (paste the PAT), then `vsce publish`. After a few minutes the extension appears at `https://marketplace.visualstudio.com/items?itemName=<publisher>.claude-usage-by-chat`.
10. **Updates later**: bump `version` (or run `vsce publish patch|minor|major`), update `CHANGELOG.md`, run `vsce publish`.
11. **Optional, recommended**: also publish to Open VSX (https://open-vsx.org), which is what VSCodium, Cursor and some other editors use: create an account, a token, then `npx ovsx publish -p <token>`.

Before publishing, decide:
- The name `claude-usage-by-chat` must be free in your publisher; "Claude" in a name or icon may be questioned by Anthropic's trademark rules, so don't use their logo and say "unofficial" in the description.
- The undocumented usage API may change or break; say so in the README.

## Next: Windows support

I developed on macOS; the user will test on Windows later. Known risks to check, in order:

1. **Project folder name**: `projectDir()` in `usage.js` replaces `/`, `\` and `.` with `-`. On Windows, check what Claude Code really names the folder in `%USERPROFILE%\.claude\projects` for `C:\Users\me\repo` (likely `C--Users-me-repo`, so `:` probably must be replaced too). Fix and add a unit test with a Windows-style path.
2. **Workspace matching**: comparing session `cwd` with the workspace folder (`startsWith(c + path.sep)`) can fail on Windows because of drive-letter case (`c:` vs `C:`) and `/` vs `\`. Normalize both before comparing (case-insensitive on Windows).
3. **OAuth token**: only macOS uses the keychain; on Windows it reads `%USERPROFILE%\.claude\.credentials.json`. Check that this file exists there (if Claude Code stores it elsewhere, e.g. Credential Manager, add that).
4. **Process check**: `process.kill(pid, 0)` for "still running" chats works on Windows in Node, but verify that finished chats are not counted.
5. **Temp files**: `os.tmpdir()` cache and debug files are fine on Windows; check that two windows still share the cache.
6. **Chat tabs**: confirm the `claudeVSCodePanel` tab viewType and the `ai-title` matching are the same on Windows.
7. **Checklist for the Windows test**: install the `.vsix`, open a workspace, and confirm all four values (`5h`, `week`, `chats`, `chat`) show, `cost est: ×N $(sync)` works, and the status bar has no "?" after a few minutes.

## How to get the most accurate 5h limit

The calibration divides your local usage by the server's 5h percent, so it is only as good as the window it measures. For the best estimate:

1. **Stop working in the last 5 minutes before the 5h window resets** (the reset time is in the tooltip of `5h: N% week: N%`), so no chat runs across the reset.
2. **After the reset, do one big chat**, until the 5h usage is **more than 10%** (below 10% there is no estimate). The more the 5h percent climbs past 10% in this window, the more readings the estimate is fitted from and the steadier it gets.
3. **Click `cost est: ×N $(sync)`**. It fetches the server usage now, recalculates, and opens the confirmation window; click **Update**.

**After a plan change, recalibrate in the first window that reaches 10%**: the old `limit5h` is from the old plan.

**Usage anywhere other than this computer (another machine, claude.ai on the web, mobile) is not in the local logs, so the calculation will be off.** Don't use Claude anywhere else during steps 1–3.

## How it works

No secrets here, this is the whole mechanism:

- **Where the data comes from**: Claude Code writes every conversation as `.jsonl` files in `~/.claude/projects/<workspace path with / and . replaced by ->/`. Each assistant message records its token counts. Running chats are listed in `~/.claude/sessions/<pid>.json` (process id, `cwd`, session id).
- **Usage number**: a weighted token sum at each model's API price (`PRICES` in `usage.js`: Fable and Mythos 5 to 5.2, Opus 4.5 to 5.5, Sonnet 4.5 to 5.5, Haiku 4.5 and 5.5), in units of one Opus 5.5 input token ($4/MTok). Cache writes cost the model's input ×1.25 (5 min cache) or ×2 (1 h cache, which Claude Code mostly uses). A model not in the list costs as the newest of its family, so **add new models to `PRICES` when they come out**. The limits follow cost, so flat weights (as in `usage.py`) made the calibrated limit drift by up to ±20% between windows with a different model mix or cache TTL. The extension ports this to JavaScript (`usage.js`); it does not call Python.
- **5h and weekly**: summed from the local logs over the rolling window. The 5h/weekly *percent* is shown against a limit (`limit5h`, `limitWeekly` settings). Anthropic does not publish the limits, so the extension also asks the server.
- **Starting 5h limit by plan**: with `limit5h` at 0 (the default) the limit comes from the account's plan: Pro 10,000,000, Max 5x 45,000,000, Max 20x 180,000,000 (4× Max 5x, not measured). The plan is read hourly from Anthropic's profile endpoint (`organization.rate_limit_tier`, undocumented), falling back to the plan saved at login, which stays stale after an upgrade until you sign in again. A `limit5h` you set yourself wins.
- **Server check**: every 5 min it calls Anthropic's usage endpoint using the OAuth token Claude Code already saved (macOS keychain, or `~/.claude/.credentials.json`). The answer gives the real 5h percent and when the window resets (`resetsAt`). The result is cached in a temp file so several VS Code windows make only one request.
- **Calibration**: limit ≈ local weighted usage in the window ÷ server percent (only from 10%, since small percents are too rough). The server percent is a whole number and the check runs every 5 min, so one reading can be off by 5–10%. So a reading is kept only when the percent goes up since the previous check (then "17%" is close to 17.0), and the limit is a least-squares fit over all kept readings of the window: it settles instead of jumping. A new 5h window starts over with no estimate (`cost est: ?`, and the update button refuses) until it reaches 10% itself: an earlier window's estimate may be from another plan (after an upgrade it was 10× too small) or include claude.ai usage. The window that calls the server updates it in the shared cache file, so all VS Code windows show the same value. This is shown as `cost est: ×N` (the setting ÷ the estimate) and clicking it saves the estimate to the setting. It is never applied automatically: usage from other machines or claude.ai is not in the local logs and makes the limit look too small, and a limit set by hand must stay.
- **`chats: N% (count)`**: sums the chats whose process is alive and whose `cwd` is in this window's workspace, counting only their messages in the current 5h window.
- **`chat: N%`**: finds the focused chat tab in VS Code (`tabGroups`, viewType ends with `claudeVSCodePanel`), matches its title to the session's last `ai-title` entry, and sums that session file plus its subagents. Only messages in the current 5h window count (window start = the server's `resetsAt` − 5h; the last 5h before the first server answer), so a chat kept open across a reset starts again from 0. Its tooltip also shows the whole chat.
- **Privacy**: everything is read locally; the only network call is to Anthropic's usage API with your own token. Nothing goes to any third party.

## Done
- Cost estimate menu: clicking `cost est` fetches the server and offers: update the 5h limit to the estimate, **hide until the 5h reset** (Claude used elsewhere in this window: the window is marked excluded in the shared cache file, takes no calibration samples, and the item comes back in the next window), or **hide for good** (`claudeUsage.showCostEstimate` set to false; set it back to true to show it again).

- Active chats usage: still-running chats (live process in `~/.claude/sessions`) whose `cwd` is this window's workspace folder (or below) summed, as % of the 5h limit, with their count (`chats: N% (count)`). Limitation: two VS Code windows on the same folder count each other's chats (session files do not say which window a chat belongs to).
- Current chat usage (see above)
- 5h limit calibration: on each server fetch, limit = local weighted usage since the window start (`resetsAt` − 5h) / server 5h percent. Only from 10% up; a reading counts only when the server's 5h percent went up since the previous one, and the estimate is a fit over all such readings in the window (see "How it works"). Stored in `globalState` and shown in the tooltip; never used on its own (the automatic `autoCalibrate` option was removed: a limit set by hand must stay). It reaches `limit5h` only through `cost est` → Update. Usage from other machines or claude.ai is not in the local logs, so it makes the limit look smaller. The weekly limit is not calibrated (not used).
- Calibration status bar: `cost est: ×N $(sync)` is the `limit5h` setting ÷ the estimate (`×1.14`: the real limit is smaller, so your usage costs 14% more than the status bar says). Colors: above ×1.05 yellow, above ×1.20 orange, above ×1.30 red (the tooltip then asks to update the 5h limit), below ×0.70 green. Clicking it (command `claudeUsage.setLimitFromCalibration`) fetches the server now, recalibrates, and asks in a modal before writing the estimate, rounded to 2 significant figures (10,031,155 → 10,000,000; it is only good to 5–10%), into the `limit5h` user setting.
- `5h: N% week: N% $(sync)`: one section; clicking it fetches the server now (command `claudeUsage.refreshServer`; forced fetches at most every 30 s).
- Server fetch every 5 min (20 after an error; if the status bar shows "?" from 429s, raise it back to 10), to avoid 429s. Shared between VS Code windows through a cache file in the temp dir, so only one window calls the API; the others read the file.

## Known limitations

- First open: when the extension is opened the first time, it may take a few seconds before the chat usage shows correctly (the chat value is not working well at first). To debug later.
- Two open chats with the same title: the extension cannot tell which tab is focused and picks the most recently modified one, so the `chat: N%` value may be the other chat's.
- A new chat is counted only after its first prompt (its session file does not exist before that).
- Prices are the public API list prices, assumed to be what the subscription limits are measured in (not documented). Haiku 5.5's 5× price above 100K-token prompts and fast mode (`usage.speed: "fast"`, 2×) are covered. Not covered: web search/fetch requests.
