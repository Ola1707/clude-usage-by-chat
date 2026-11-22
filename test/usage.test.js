const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { weights, weigh, usage5h, usage7d, estimateLimit5h, sameWindow, addCalibrationReading, excludeWindow, planKey, sessionTotals, sessionUsage, findSessionByTitle, projectDir, activeUsage, activeSessions, parsePs, processTree, processUsage } = require("../usage");

assert.strictEqual(
  weigh({ input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 4, cache_read_input_tokens: 100 }),
  10 + 10 + 5 + 5
);
// 1h cache writes cost 2x input; Sonnet costs half of Opus, cache reads the same
const u = { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 4,
  cache_creation: { ephemeral_1h_input_tokens: 4 }, cache_read_input_tokens: 100 };
assert.strictEqual(weigh(u, "claude-opus-5-5"), 10 + 10 + 8 + 5);
assert.strictEqual(weigh(u, "claude-sonnet-5-5"), 5 + 5 + 4 + 2.5);
// model ids: exact version, platform prefix/[1m]/date suffix, unknown version -> newest of family
assert.strictEqual(weights("claude-opus-5").input, 1.25);
assert.strictEqual(weights("claude-opus-5-5[1m]").input, 1);
assert.strictEqual(weights("us.anthropic.claude-sonnet-4-6").input, 0.75);
assert.strictEqual(weights("claude-haiku-4-5-20251001").input, 0.25);
assert.strictEqual(weights("claude-haiku-5-5").cacheRead, 0.0025);
assert.strictEqual(weights("claude-opus-5-6").input, 1);
assert.strictEqual(weights("claude-sonnet-3-7").input, 0.5);
assert.strictEqual(weights("claude-fable-5-1").cacheRead, 0.0625);
// Fable 5.2 and the rest of the list; unknown Fable/Mythos -> 5.2
assert.deepStrictEqual(weights("claude-fable-5-2"), { input: 2, output: 10, cacheRead: 0.05 });
assert.strictEqual(weights("claude-fable-5").input, 2.5);
assert.strictEqual(weights("claude-fable-6").input, 2);
assert.strictEqual(weights("claude-mythos-preview").input, 2);
assert.strictEqual(weights("claude-mythos-5").cacheRead, 0.25);
assert.strictEqual(weights("claude-opus-4-5-20251101").input, 1.25);
assert.strictEqual(weights("claude-sonnet-4-5-20250929").input, 0.75);
// Haiku 5.5 costs 5x above a 100K-token prompt; fast mode 2x
assert.strictEqual(weigh({ output_tokens: 4 }, "claude-haiku-5-5"), 0.5);
assert.strictEqual(weigh({ output_tokens: 4, cache_read_input_tokens: 100001 }, "claude-haiku-5-5"),
  (0.5 + 100001 * 0.0025) * 5);
assert.strictEqual(weigh({ output_tokens: 1, speed: "fast" }, "claude-opus-5-5"), 10);

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

// calibration: no sample from the first reading (could be anywhere in 20.00-20.99), nor from an unchanged percent
let calib = addCalibrationReading(undefined, fiveHour(20), root);
assert.deepStrictEqual([calib.samples.length, calib.limit], [0, undefined]);
calib = addCalibrationReading(calib, fiveHour(20), root);
assert.strictEqual(calib.samples.length, 0);
// the percent went up: sample (500 used at 25%) -> 2000
calib = addCalibrationReading(calib, fiveHour(25), root);
assert.deepStrictEqual([calib.samples.length, calib.limit], [1, 2000]);
// a new window starts over without a limit (the last one may be from another plan)
calib = addCalibrationReading(calib, { percent: 0, resetsAt: new Date(now + 4 * 3600e3).toISOString() }, root);
assert.deepStrictEqual([calib.samples.length, calib.limit], [0, undefined]);
// same window despite sub-second jitter in resetsAt
assert.strictEqual(sameWindow("2026-10-29T12:30:00.143Z", "2026-10-29T12:30:00.300Z"), true);
assert.strictEqual(sameWindow("2026-10-29T12:30:00Z", "2026-10-29T07:30:00Z"), false);
assert.strictEqual(sameWindow(undefined, "2026-10-29T12:30:00Z"), false);
// a window marked as excluded (Claude used elsewhere) takes no samples; the next window starts over
let ex = excludeWindow(addCalibrationReading(undefined, fiveHour(20), root), fiveHour(20));
ex = addCalibrationReading(ex, fiveHour(30), root);
ex = addCalibrationReading(ex, fiveHour(40), root);
assert.deepStrictEqual([ex.excluded, ex.samples.length, ex.limit], [true, 0, undefined]);
ex = addCalibrationReading(ex, { percent: 1, resetsAt: new Date(now + 9 * 3600e3).toISOString() }, root);
assert.strictEqual(ex.excluded, undefined);

// plan from the profile's rate limit tier, or the login's subscription type
assert.strictEqual(planKey("default_claude_max_5x"), "max_5x");
assert.strictEqual(planKey("default_claude_max_20x"), "max_20x");
assert.strictEqual(planKey("default_claude_ai", "pro"), "pro");
assert.strictEqual(planKey("", "max"), "max_5x");
assert.strictEqual(planKey(undefined, undefined), undefined);

// weekly window: 6h-old message now counts, 8-day-old one does not
fs.writeFileSync(path.join(root, "proj", "b.jsonl"), msg("w1", 8 * 24, 1000));
assert.strictEqual(usage7d(now, root), 500 + 50 + 4995);
// sess.jsonl: its own message (100) + its subagent m2 (50)
const sess = path.join(root, "proj", "sess.jsonl");
fs.writeFileSync(sess, [msg("s1", 1, 20), JSON.stringify({ type: "ai-title", aiTitle: "Old" }),
  JSON.stringify({ type: "ai-title", aiTitle: "My chat" })].join("\n"));
assert.strictEqual(sessionUsage(sess), 100 + 50);
// chat begun before the 5h window (started 3h ago): only s1 (1h ago) counts, not subagent m2 (4.9h ago)
assert.deepStrictEqual(sessionTotals(sess, now - 3 * 3600e3), { total: 150, recent: 100 });

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
assert.deepStrictEqual(activeUsage(["/w/app"], 0, sessions, root), { count: 2, total: 100 });
assert.deepStrictEqual(activeUsage(undefined, 0, sessions, root), { count: 4, total: 200 });
assert.deepStrictEqual(activeSessions(["/w/app"], sessions, root).map((x) => x.pid), [process.pid, process.pid]);

// processes: a chat (10) with a child (11) and grandchild (12); 20 is unrelated
const procs = parsePs("   10     1  12.5  1024\n   11    10   2.0   512\n   12    11   0.5   512\n   20     1  50.0  4096\n");
assert.deepStrictEqual(procs.get(11), { ppid: 10, cpu: 2, mem: 512 * 1024 });
assert.deepStrictEqual([...processTree(procs, [10])].sort(), [10, 11, 12]);
assert.deepStrictEqual([...processTree(procs, [11, 99])].sort(), [11, 12]);
assert.deepStrictEqual(processUsage(procs, processTree(procs, [10])), { cpu: 15, mem: 2048 * 1024 });
assert.deepStrictEqual(processUsage(procs, [10]), { cpu: 12.5, mem: 1024 * 1024 });
console.log("ok");
