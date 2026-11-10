/**
 * dsh-session-reaper 删除逻辑测试。
 *
 * 全程在临时 DSH_HOME 上跑，不碰真实数据。
 * 验证点：活跃拦截 / 五步顺序 / 孤儿判定 / 软链接不追删。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import test from "node:test";

import { purgeOne, purgeOrphans, purgeCaches, buildStats, removeTarget, readSessionMeta } from "../lib/index.js";

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-"));
  process.env.DSH_HOME = home;
  return home;
}

function writeSession(home, workspaceDir, sessionId, header) {
  const dir = path.join(home, "sessions", workspaceDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  if (header !== null) {
    const line = `${JSON.stringify(header)}\n`;
    const packed = zlib.zstdCompressSync(Buffer.from(line, "utf8"));
    fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), packed);
  } else {
    fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), "not-zstd");
  }
  return dir;
}

function writeSessionLines(home, workspaceDir, sessionId, records) {
  const dir = path.join(home, "sessions", workspaceDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  fs.writeFileSync(
    path.join(dir, "session.v4.jsonl.zstd"),
    zlib.zstdCompressSync(Buffer.from(body, "utf8")),
  );
  return dir;
}

function writeProjCache(home, sessionId) {
  const dir = path.join(home, "storages", "session_projcache", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${sessionId}.json`);
  fs.writeFileSync(fp, JSON.stringify({ id: sessionId }));
  return fp;
}

function makeRegistry({ sessionIds = [], active = [] } = {}) {
  const calls = { archive: [], unarchive: [], detach: [] };
  const live = new Set(active);
  const archived = new Set();
  const workspace = {
    id: "ws-1",
    path: "D:\\fake-workspace",
    title: "fake",
    record: { sessionIds: [...sessionIds] },
    get sessionIds() {
      return this.record.sessionIds;
    },
    async detachSession(id) {
      calls.detach.push(id);
      this.record.sessionIds = this.record.sessionIds.filter((item) => item !== id);
    },
  };
  const registry = {
    list: () => [workspace],
    get archivedSessionIds() {
      return [...archived];
    },
    pinnedSessionIds: [],
    async archiveSession(id, options = {}) {
      calls.archive.push({ id, stopActivity: options.stopActivity === true });
      if (live.has(id) && options.stopActivity !== true) {
        throw new Error(`workspace session '${id}' is active`);
      }
      archived.add(id);
    },
    async unarchiveSession(id) {
      calls.unarchive.push(id);
      archived.delete(id);
    },
  };
  return { registry, calls, workspace };
}

const ctxOf = (registry) => ({ workspaceRegistry: registry });

test("活跃会话默认被拒绝，force 才停活", async () => {
  const home = makeHome();
  writeSession(home, "ws-a", "sess-live", { type: "session", id: "sess-live", delegationDepth: 0 });
  const { registry, calls } = makeRegistry({ sessionIds: ["sess-live"], active: ["sess-live"] });

  await assert.rejects(() => purgeOne(ctxOf(registry), "sess-live", false), (error) => error.code === "SESSION_ACTIVE");
  assert.equal(fs.existsSync(path.join(home, "sessions", "ws-a", "sess-live")), true, "被拒时不得删文件");

  await purgeOne(ctxOf(registry), "sess-live", true);
  assert.deepEqual(calls.archive.at(-1), { id: "sess-live", stopActivity: true });
  assert.equal(fs.existsSync(path.join(home, "sessions", "ws-a", "sess-live")), false);
});

test("五步全走：账本摘除 + 归档集摘除 + 目录与缓存删除", async () => {
  const home = makeHome();
  const dir = writeSession(home, "ws-a", "sess-1", { type: "session", id: "sess-1", delegationDepth: 0 });
  const cached = writeProjCache(home, "sess-1");
  const { registry, calls, workspace } = makeRegistry({ sessionIds: ["sess-1", "keep-me"] });

  const result = await purgeOne(ctxOf(registry), "sess-1", false);

  assert.equal(result.detached, 1);
  assert.deepEqual(calls.detach, ["sess-1"]);
  assert.deepEqual(calls.unarchive, ["sess-1"]);
  assert.deepEqual(workspace.record.sessionIds, ["keep-me"], "其他会话不得受影响");
  assert.equal(registry.archivedSessionIds.length, 0, "归档集必须清空，否则留幽灵 id");
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(cached), false);
});

test("孤儿扫描：记账中的跳过，能收养的也跳过，只删真孤儿", async () => {
  const home = makeHome();
  const kept = writeSession(home, "ws-a", "sess-kept", { type: "session", id: "sess-kept", delegationDepth: 0 });
  // 头部完好 → DSH 重启会按 cwd 收养，不能删
  const pending = writeSession(home, "ws-a", "sess-pending", {
    type: "session",
    id: "sess-pending",
    cwd: "D:\\fake-workspace",
    delegationDepth: 1,
  });
  // 头部损坏 → 永远不可能被收养，才是真孤儿
  const orphan = writeSession(home, "ws-a", "sess-orphan", null);
  const orphanCache = writeProjCache(home, "sess-orphan");
  const { registry } = makeRegistry({ sessionIds: ["sess-kept"] });

  const rows = await purgeOrphans(ctxOf(registry), null);

  assert.equal(fs.existsSync(kept), true, "记账中的会话不能被当孤儿删");
  assert.equal(fs.existsSync(pending), true, "能被收养的会话不能删，删工作区后它们只是暂时未分组");
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(orphanCache), false);
  assert.ok(rows.some((row) => row.sessionId === "sess-kept" && row.skipped === "accounted"));
  assert.ok(rows.some((row) => row.sessionId === "sess-pending" && row.skipped === "adoptable"));
});

test("统计区分真孤儿与待收养", async () => {
  const home = makeHome();
  writeSession(home, "ws-a", "sess-kept", { type: "session", id: "sess-kept", delegationDepth: 0 });
  writeSession(home, "ws-a", "sess-pending", {
    type: "session",
    id: "sess-pending",
    cwd: "D:\\fake-workspace",
    delegationDepth: 0,
  });
  writeSession(home, "ws-a", "sess-orphan", null);
  const { registry } = makeRegistry({ sessionIds: ["sess-kept"] });

  const stats = await buildStats(ctxOf(registry));
  assert.equal(stats.totals.count, 3);
  assert.equal(stats.totals.orphanCount, 1, "只有头部损坏的算孤儿");
  assert.equal(stats.totals.pendingCount, 1, "头部完好的算待收养");
  assert.ok(stats.totals.bytes > 0);
  assert.equal(stats.sessions.find((row) => row.sessionId === "sess-orphan").orphan, true);
  assert.equal(stats.sessions.find((row) => row.sessionId === "sess-pending").pendingAdoption, true);
  assert.equal(stats.sessions.find((row) => row.sessionId === "sess-pending").orphan, false);
});

test("孤立投影缓存：会话目录没了才算，删掉不留会话", async () => {
  const home = makeHome();
  writeSession(home, "ws-a", "sess-kept", { type: "session", id: "sess-kept", delegationDepth: 0 });
  const keptCache = writeProjCache(home, "sess-kept");
  const strayCache = writeProjCache(home, "sess-gone");
  const { registry } = makeRegistry({ sessionIds: ["sess-kept"] });

  const stats = await buildStats(ctxOf(registry));
  assert.equal(stats.totals.cacheCount, 1);

  const rows = await purgeCaches();
  assert.equal(rows.length, 1);
  assert.equal(fs.existsSync(strayCache), false);
  assert.equal(fs.existsSync(keptCache), true, "有会话目录的缓存不能删");
});

test("空白会话判定：没有 turn/start 就是空会话", () => {
  const home = makeHome();
  const blank = writeSessionLines(home, "ws-a", "sess-blank", [
    { type: "session", id: "sess-blank", cwd: "D:\\x", delegationDepth: 0 },
    { type: "permission/preset", seq: 0, time: 1, data: { preset: "workspace-write" } },
    { type: "sandbox/mode", seq: 1, time: 1, data: { mode: "workspace-write" } },
    { type: "approval/policy", seq: 2, time: 1, data: { policy: "ask" } },
  ]);
  const real = writeSessionLines(home, "ws-a", "sess-real", [
    { type: "session", id: "sess-real", cwd: "D:\\x", delegationDepth: 0 },
    { type: "turn/start", seq: 1, time: 2 },
    { type: "user/message", seq: 2, time: 3 },
    { type: "turn/start", seq: 3, time: 4 },
  ]);

  const blankMeta = readSessionMeta(blank);
  const realMeta = readSessionMeta(real);

  assert.equal(blankMeta.blank, true, "只有初始化事件的会话是空会话");
  assert.equal(blankMeta.turns, 0);
  assert.equal(blankMeta.header?.id, "sess-blank");

  assert.equal(realMeta.blank, false, "有 turn/start 就不是空会话");
  assert.equal(realMeta.turns, 2, "数到两个 turn/start");
  assert.equal(realMeta.header?.id, "sess-real");
});

test("统计把空会话单独计数", async () => {
  const home = makeHome();
  writeSessionLines(home, "ws-a", "sess-blank", [
    { type: "session", id: "sess-blank", cwd: "D:\\x", delegationDepth: 0 },
    { type: "permission/preset", seq: 0, time: 1, data: { preset: "workspace-write" } },
  ]);
  writeSessionLines(home, "ws-a", "sess-real", [
    { type: "session", id: "sess-real", cwd: "D:\\x", delegationDepth: 0 },
    { type: "turn/start", seq: 1, time: 2 },
  ]);
  const { registry } = makeRegistry({ sessionIds: ["sess-blank", "sess-real"] });

  const stats = await buildStats(ctxOf(registry));
  assert.equal(stats.totals.count, 2);
  assert.equal(stats.totals.blankCount, 1);
  assert.equal(stats.sessions.find((row) => row.sessionId === "sess-blank").blank, true);
  assert.equal(stats.sessions.find((row) => row.sessionId === "sess-real").turns, 1);
});

test("软链接只摘链接本身，不追删目标", async () => {
  const home = makeHome();
  const target = path.join(home, "real-target");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "important.txt"), "keep me");

  const link = path.join(home, "link-to-target");
  try {
    fs.symlinkSync(target, link, "junction");
  } catch {
    return; // 无权限建链接时跳过
  }

  const kind = await removeTarget(link);
  assert.equal(kind, "link");
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.existsSync(path.join(target, "important.txt")), true, "目标文件必须还在");
});

test("损坏的 zstd 不影响删除", async () => {
  const home = makeHome();
  const dir = writeSession(home, "ws-a", "sess-broken", null);
  const { registry } = makeRegistry({ sessionIds: ["sess-broken"] });
  await purgeOne(ctxOf(registry), "sess-broken", false);
  assert.equal(fs.existsSync(dir), false);
});

test("空 sessionId 被拒", async () => {
  const home = makeHome();
  const { registry } = makeRegistry({});
  await assert.rejects(() => purgeOne(ctxOf(registry), "", false), (error) => error.code === "BAD_REQUEST");
});
