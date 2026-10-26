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

## Done

- Active chats usage: still-running chats (live process in `~/.claude/sessions`) whose `cwd` is this window's workspace folder (or below) summed, as % of the 5h limit, with their count (`chats: N% (count)`). Limitation: two VS Code windows on the same folder count each other's chats (session files do not say which window a chat belongs to).
- Current chat usage (see above)
- 5h limit calibration: on each server fetch, limit = local weighted usage since the window start (`resetsAt` − 5h) / server 5h percent. Only from 10% up; each fetch (every 10 min) replaces the stored value. Stored in `globalState` and shown in the tooltip; used instead of the `limit5h` setting only with `claudeUsage.autoCalibrate` (off by default until verified after a reset). Usage from other machines or claude.ai is not in the local logs, so it makes the limit look smaller. The weekly limit is not calibrated (not used).
- Calibration status bar: `est: ×N` is the estimate / `limit5h` setting (checked by eye); the `update 5h limit` button (asks for confirmation in a modal first) (command `claudeUsage.setLimitFromCalibration`) writes the estimate into the `limit5h` user setting.
- Server fetch every 10 min (20 after an error), to avoid 429s.

## Known limitations

- First open: when the extension is opened the first time, it may take a few seconds before the chat usage shows correctly (the chat value is not working well at first). To debug later.
- Two open chats with the same title: the extension cannot tell which tab is focused and picks the most recently modified one, so the `chat: N%` value may be the other chat's.
- A new chat is counted only after its first prompt (its session file does not exist before that).
