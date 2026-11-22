# Claude usage by chat

> **Moved to [Ola1707/claude-usage-by-chat](https://github.com/Ola1707/claude-usage-by-chat).** This repo is archived and no longer updated.

A VS Code extension that shows your Claude Code usage in the status bar: the 5-hour and weekly limits, and how much of the 5h limit each chat uses. Unofficial, not made by Anthropic.

```
🦄 5h: 42% week: 18% ⟳   chats: 30% (3)   chat: 12%   cost est: ×1.04 ⟳   ⚡ chats: 8% 410MB chat: 3% 180MB   ⚙
```

| Item | What it shows | Click |
|---|---|---|
| `5h: N% week: N%` | Your real 5h and weekly usage, from Anthropic's server. The tooltip shows when each one resets. | Fetches it from the server now. |
| `chats: N% (count)` | The chats still running in this workspace: their usage in the current 5h window, as % of the 5h limit. | |
| `chat: N%` | The chat tab you're in now, in the current 5h window. The tooltip also shows the whole chat. | |
| `cost est: ×N` | How far the `limit5h` setting is from the real limit (see [Cost estimate](#cost-estimate)). | Fetches the server and offers to update the limit or hide the item. |
| `chats: CPU% MEM chat: CPU% MEM` | CPU and memory of the running chats and of the focused chat (macOS and Linux). | |
| `⚙` | | Opens the settings. |

## Install

The extension isn't on the Marketplace yet. It has no dependencies, so you install it straight from the repo:

```sh
git clone https://github.com/Ola1707/clude-usage-by-chat.git ~/Repos/clude-usage-by-chat
ln -s ~/Repos/clude-usage-by-chat ~/.vscode/extensions/local.claude-usage-by-chat-0.0.1
```

Then reload VS Code (Command Palette → **Developer: Reload Window**). To update: `git -C ~/Repos/clude-usage-by-chat pull`, then reload.

You need Claude Code installed and signed in. The extension uses the login Claude Code already saved.

## Use it

- Open a Claude Code chat as an editor tab. `chat: N%` follows the tab you're in. The sidebar chat isn't a tab, so the last chat tab seen stays shown.
- A new chat shows up after its first prompt.
- `5h` and `week` come from the server every 5 minutes. Click them to fetch now.

## Cost estimate

The `chats` and `chat` percents are worked out locally against a 5h limit. Anthropic doesn't publish that limit, so the extension starts from your plan (Pro, Max 5x, Max 20x) and then checks itself against the server's 5h percent.

`cost est: ×1.14` means the real limit is smaller than the setting, so your chats really cost 14% more than shown. The colour turns yellow above ×1.05, orange above ×1.20 and red above ×1.30 (time to update). The estimate starts once the 5h usage passes 10%. Before that it shows `?`.

To update the limit, click `cost est` → **Update**. For the most accurate estimate:

1. Stop working in the last 5 minutes before the 5h window resets.
2. After the reset, work in one chat until the 5h usage is above 10%.
3. Click `cost est` → **Update**.

Recalibrate after changing plans. If you used Claude somewhere else in this window (claude.ai, your phone, another computer), choose **Hide until the 5h reset**. That usage isn't in the local logs and makes the estimate wrong.

## Settings

Command Palette → **Claude usage: Settings**, or click `⚙`.

| Setting | Default | What it does |
|---|---|---|
| `claudeUsage.limit5h` | `0` | The 5h limit in weighted tokens. `0` means by your plan (Pro 10,000,000). The extension never changes it on its own: edit it, or click `cost est` → **Update**. |
| `claudeUsage.showCostEstimate` | `true` | Show `cost est`. |
| `claudeUsage.refreshSeconds` | `60` | How often to recompute 5h, week and chats. |
| `claudeUsage.chatRefreshSeconds` | `5` | How often to recompute the focused chat. |
| `claudeUsage.processStats` | `cpu+memory` | The CPU/memory item: `cpu+memory`, `cpu`, `memory` or `off`. |
| `claudeUsage.processIncludeChildren` | `true` | Count a chat's shell commands and MCP servers in CPU/memory. |
| `claudeUsage.processRefreshSeconds` | `5` | How often to update CPU/memory. |

## How it works and privacy

- It reads Claude Code's own logs in `~/.claude/projects` and `~/.claude/sessions`. Usage is the sum of each message's tokens at that model's API price.
- Every 5 minutes it asks Anthropic's usage API for the real 5h and weekly percent, using the token Claude Code already saved (macOS keychain, or `~/.claude/.credentials.json`). Several VS Code windows share one request.
- That API call goes only to Anthropic. Nothing is sent anywhere else.
- The usage API isn't documented, so it may change or stop working.

## Limitations

- Tested on macOS. Windows isn't tested yet.
- Usage outside this computer (claude.ai, your phone, another computer) counts in `5h` and `week` but not in `chats` or `chat`.
- Two open chats with the same title: `chat` may show the other one.
- Two VS Code windows on the same folder count each other's chats in `chats`.
- Right after VS Code starts, `chat` can take a few seconds to show correctly.

## Develop

`npm test` runs the unit tests. [ROADMAP.md](ROADMAP.md) has the plan and the details of how it works.
