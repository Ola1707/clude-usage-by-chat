const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { weigh, usage5h, usage7d, estimateLimit5h, sessionUsage, findSessionByTitle, projectDir, activeUsage } = require("../usage");

assert.strictEqual(
  weigh({ input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 4, cache_read_input_tokens: 100 }),
  10 + 10 + 5 + 10
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
fs.mkdirSync(path.join(root, "proj", "sess", "subagents"), { recursive: true });
const now = Date.parse("2026-10-26T12:00:00Z");
const msg = (id, hoursAgo, out) => JSON.stringify({
  type: "assistant",
  timestamp: new Date(now - hoursAgo * 3600e3).toISOString(),
  message: { id, usage: { output_tokens: out } },
});
fs.writeFileSync(path.join(root, "proj", "a.jsonl"),
  [msg("m1", 1, 100), msg("m1", 1, 100), msg("old", 6, 999), "garbage"].join("\n"));
fs.writeFileSync(path.join(root, "proj", "sess", "subagents", "s.jsonl"), msg("m2", 4.9, 10));

// m1 once (500) + subagent m2 (50); the 6h-old message is excluded
assert.strictEqual(usage5h(now, root), 550);

// 5h limit from the server percent: window ends in 2h, so it began 3h ago -> only m1 (500) counts
const fiveHour = (percent) => ({ percent, resetsAt: new Date(now + 2 * 3600e3).toISOString() });
assert.strictEqual(estimateLimit5h(fiveHour(20), root), 2500);
assert.strictEqual(estimateLimit5h(fiveHour(5), root), undefined); // too small to trust
assert.strictEqual(estimateLimit5h(undefined, root), undefined);

// weekly window: 6h-old message now counts, 8-day-old one does not
fs.writeFileSync(path.join(root, "proj", "b.jsonl"), msg("w1", 8 * 24, 1000));
assert.strictEqual(usage7d(now, root), 500 + 50 + 4995);
// sess.jsonl: its own message (100) + its subagent m2 (50)
const sess = path.join(root, "proj", "sess.jsonl");
fs.writeFileSync(sess, [msg("s1", 1, 20), JSON.stringify({ type: "ai-title", aiTitle: "Old" }),
  JSON.stringify({ type: "ai-title", aiTitle: "My chat" })].join("\n"));
assert.strictEqual(sessionUsage(sess), 100 + 50);

// tab title -> session file (last ai-title wins)
assert.strictEqual(findSessionByTitle("My chat", path.join(root, "proj")), sess);
assert.strictEqual(findSessionByTitle("Old", path.join(root, "proj")), undefined);
assert.strictEqual(findSessionByTitle("My chat", path.join(root, "nothing")), undefined);
// same title twice: newest file wins, or the one among `only`
const dup = path.join(root, "proj", "dup.jsonl");
fs.writeFileSync(dup, JSON.stringify({ type: "ai-title", aiTitle: "My chat" }));
fs.utimesSync(sess, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
assert.strictEqual(findSessionByTitle("My chat", path.join(root, "proj")), dup);
assert.strictEqual(findSessionByTitle("My chat", path.join(root, "proj"), [sess]), sess);
fs.unlinkSync(dup);

assert.strictEqual(projectDir("/Users/me/Repos/my.app", "/r"), "/r/-Users-me-Repos-my-app");

// active chats: only those started in the given folders (or below); this test's pid is alive
const sessions = path.join(root, "sessions");
fs.mkdirSync(sessions);
const live = (name, cwd) => {
  fs.writeFileSync(path.join(sessions, `${name}.json`), JSON.stringify({ pid: process.pid, sessionId: name, cwd }));
  fs.mkdirSync(projectDir(cwd, root), { recursive: true });
  fs.writeFileSync(path.join(projectDir(cwd, root), `${name}.jsonl`), msg(name, 1, 10));
};
live("here", "/w/app");
live("sub", "/w/app/pkg");
live("other", "/w/other");
live("prefix", "/w/app2");
assert.deepStrictEqual(activeUsage(["/w/app"], sessions, root), { count: 2, total: 100 });
assert.deepStrictEqual(activeUsage(undefined, sessions, root), { count: 4, total: 200 });
console.log("ok");
