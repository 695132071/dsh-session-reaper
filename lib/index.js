/**
 * dsh-session-reaper — 服务端。
 *
 * 目标：把「归档 = 只隐藏不删」变成「删除 = 真的没了」。
 *
 * 一次删除固定走五步，顺序不能换：
 *   1. archiveSession            停活 + 进归档集（活跃会话在这里被拦下）
 *   2. entity.detachSession      从工作区账本 sessionIds 摘除
 *   3. registry.unarchiveSession 把第 1 步加进 archivedSessionIds 的 id 摘掉
 *   4. 删会话目录                 sessions/<workspace>/<sessionId>/
 *   5. 删投影缓存                 storages/session_projcache/sessions/<sessionId>.json
 *
 * 第 2、3 步都走官方 API，不直接改 workspace.json —— 外部改写会被内存态覆盖。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

const name = "dsh-session-reaper";
const inject = ["webServer", "workspaceRegistry"];
const ROUTE = "/session-reaper/api";
const CONFIG = {
  /** 单个请求体上限，防御性上限；正常请求只有几十字节。 */
  maxBody: 1024 * 1024,
};

const execFileAsync = promisify(execFile);

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** 自报版本，用来确认运行中的进程到底加载了哪一份代码。 */
function readOwnVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
}

function sessionsRoot() {
  return path.join(dshHome(), "sessions");
}

function projCacheDir() {
  return path.join(dshHome(), "storages", "session_projcache", "sessions");
}

async function safeReaddir(dir) {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

async function exists(target) {
  try {
    await fsp.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* 并发删除时忽略 */
        }
      }
    }
  }
  return total;
}

/**
 * DSH 的 `session.v4.jsonl.zstd` 不是单个 zstd 帧，而是**多帧容器**：
 * 第一帧只装 header 记录，之后每批事件一帧（见 dsh-session-persistence-jsonl
 * 的 `encodeFirst` → `Buffer.concat([headerFrame, eventFrame])`）。
 *
 * 关键：`zlib.zstdDecompressSync` 只解第一帧。在 Electron 版 Node 里实测，
 * 对 186 KB 的会话它只返回 210 字节（就那一行 header），流式 API 也一样。
 * 所以必须自己切帧边界，逐帧解压——算法照抄 DSH 的 `scanZstdFrames`。
 */
const ZSTD_MAGIC = 4247762216; // 0xFD2FB528，按小端读

/** 扫描完整帧的 [start, end)。遇到不完整/非法结构就停在已识别处。 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return frames;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return frames;
    offset += 4;
    if (offset === buffer.length) return frames;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) return frames; // 保留位非零 = 结构损坏
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeader = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeader) return frames;
    offset += remainingHeader;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return frames; // 保留块类型
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

/** 解一帧；失败返回 null，绝不因为一帧坏掉就放弃整个会话。 */
function decodeFrame(buffer, frame) {
  try {
    return zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 读会话头 + 判断是否空白会话。
 *
 * 空白会话 = 一条 `turn/start` 都没有。点「新会话」但没发消息时，DSH 只写了
 * header 那一帧，没有事件帧。DSH 侧边栏对空白会话有过滤：只有「当前选中」的
 * 那一个才显示（`session.blank && id !== current` 直接返回 false），
 * 于是磁盘上有、侧边栏看不见——这正是「文件夹里 6 个、侧边栏 5 个」的成因。
 *
 * 解压失败按「非空白」处理：宁可少标，不可误标。
 */
function readSessionMeta(dir) {
  const fp = path.join(dir, "session.v4.jsonl.zstd");
  try {
    const buf = fs.readFileSync(fp);
    if (typeof zlib.zstdDecompressSync !== "function") {
      return { header: null, blank: false, turns: 0, frames: 0, lineCount: 0 };
    }
    const frames = scanZstdFrames(buf);
    // 没有可识别的帧结构（旧格式/单帧/损坏）：整体解一次兜底
    if (frames.length === 0) {
      const whole = buf.length === 0 ? null : decodeFrame(buf, { start: 0, end: buf.length });
      if (whole === null) return { header: null, blank: false, turns: 0, frames: 0, lineCount: 0 };
      return parseRecords(whole, 1);
    }
    let header = null;
    let turns = 0;
    let lineCount = 0;
    let decoded = 0;
    const titles = [];
    for (const frame of frames) {
      const plain = decodeFrame(buf, frame);
      if (plain === null) continue;
      decoded += 1;
      for (const line of plain.split("\n")) {
        if (line.length < 2) continue;
        lineCount += 1;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof record !== "object" || record === null) continue;
        if (header === null && record.type === "session") {
          header = record;
          continue;
        }
        if (record.type === "turn/start") {
          turns += 1;
          continue;
        }
        // 标题会随生成和用户重命名多次写入，取最后一条才准。
        if (record.type === "session/title") {
          const value = record.data && record.data.title;
          if (typeof value === "string" && value.trim() !== "") titles.push(value.trim());
        }
      }
    }
    return {
      header,
      title: titles.length > 0 ? titles[titles.length - 1] : null,
      blank: turns === 0,
      turns,
      frames: frames.length,
      decoded,
      lineCount,
    };
  } catch {
    return { header: null, title: null, blank: false, turns: 0, frames: 0, lineCount: 0 };
  }
}

/** 解析一整段 JSONL 文本。 */
function parseRecords(raw, frames) {
  let header = null;
  let turns = 0;
  let lineCount = 0;
  const titles = [];
  for (const line of raw.split("\n")) {
    if (line.length < 2) continue;
    lineCount += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    if (header === null && record.type === "session") {
      header = record;
      continue;
    }
    if (record.type === "turn/start") {
      turns += 1;
      continue;
    }
    if (record.type === "session/title") {
      const value = record.data && record.data.title;
      if (typeof value === "string" && value.trim() !== "") titles.push(value.trim());
    }
  }
  return {
    header,
    title: titles.length > 0 ? titles[titles.length - 1] : null,
    blank: turns === 0,
    turns,
    frames,
    lineCount,
  };
}

/** 流式解压：底层走 ZSTD_decompressStream，可连续解多帧（sync 版只解第一帧）。 */
function inflateAll(buf) {
  return new Promise((resolve, reject) => {
    if (typeof zlib.createZstdDecompress !== "function") {
      reject(new Error("createZstdDecompress 不可用"));
      return;
    }
    const chunks = [];
    const stream = zlib.createZstdDecompress();
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
    stream.end(buf);
  });
}

/** 只要头。保留给外部调用与测试。 */
function readHeader(dir) {
  return readSessionMeta(dir).header;
}

/**
 * 删除一个路径。软链接 / junction 只摘链接本身，绝不顺着链接删目标目录
 * —— profile 用 nodeLinker: hoisted，路径里可能混着链接。
 */
async function removeTarget(target) {
  const st = await fsp.lstat(target).catch(() => null);
  if (st === null) return "missing";
  if (st.isSymbolicLink()) {
    await fsp.unlink(target);
    return "link";
  }
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 });
  return st.isDirectory() ? "dir" : "file";
}

/**
 * 列会话目录。
 *
 * `adoptable` 是孤儿判定的核心：DSH 启动时 `bootstrap(headers)` 会按 header
 * 的 `cwd` 给未记账的会话新建工作区（见 dsh-workspace/lib/index.js 的收养分支）。
 * 所以「header 能读出 cwd」的会话迟早会被收回去，不算垃圾——不能当孤儿删。
 */
async function listSessions() {
  const root = sessionsRoot();
  const out = [];
  for (const wsName of await safeReaddir(root)) {
    const wsPath = path.join(root, wsName);
    const wsStat = await fsp.stat(wsPath).catch(() => null);
    if (wsStat === null || !wsStat.isDirectory()) continue;
    for (const sessionId of await safeReaddir(wsPath)) {
      const dir = path.join(wsPath, sessionId);
      const st = await fsp.stat(dir).catch(() => null);
      if (st === null || !st.isDirectory()) continue;
      const meta = readSessionMeta(dir);
      const header = meta.header;
      out.push({
        sessionId,
        workspaceDir: wsName,
        dir,
        bytes: await dirSize(dir),
        mtime: st.mtimeMs,
        depth: header?.delegationDepth ?? null,
        cwd: header?.cwd ?? null,
        createdAt: header?.createdAt ?? null,
        preset: header?.agentPreset ?? null,
        hasHeader: header !== null,
        adoptable: header !== null && typeof header.cwd === "string" && header.cwd.trim() !== "",
        blank: meta.blank,
        turns: meta.turns,
        title: meta.title,
        frames: meta.frames ?? 0,
        lineCount: meta.lineCount,
      });
    }
  }
  return out;
}

/** 投影缓存里没有对应会话目录的孤立条目 —— 纯垃圾，删掉零风险。 */
async function listOrphanCaches() {
  const dir = projCacheDir();
  const sessionIds = new Set((await listSessions()).map((s) => s.sessionId));
  const out = [];
  for (const name of await safeReaddir(dir)) {
    if (!name.endsWith(".json")) continue;
    const sessionId = name.slice(0, -5);
    if (sessionIds.has(sessionId)) continue;
    const fp = path.join(dir, name);
    const st = await fsp.lstat(fp).catch(() => null);
    if (st === null) continue;
    out.push({ sessionId, path: fp, bytes: st.size, link: st.isSymbolicLink() });
  }
  return out;
}

/** 读取注册表：已记账的会话 id 集合 + 工作区视图。 */
function readRegistry(ctx) {
  const registry = ctx.workspaceRegistry;
  const accounted = new Map();
  const workspaces = [];
  for (const workspace of registry.list()) {
    // record 是原始账本；getter 会按 candidateMatches 过滤，这里要全量。
    const ids = workspace.record?.sessionIds ?? workspace.sessionIds ?? [];
    workspaces.push({
      id: workspace.id,
      path: workspace.path,
      title: workspace.title ?? path.basename(workspace.path ?? ""),
      sessionIds: [...ids],
    });
    for (const id of ids) accounted.set(id, workspace.path);
  }
  return {
    accounted,
    workspaces,
    archived: new Set(registry.archivedSessionIds ?? []),
    pinned: new Set(registry.pinnedSessionIds ?? []),
  };
}

async function buildStats(ctx) {
  const reg = readRegistry(ctx);
  const sessions = await listSessions();
  const rows = sessions.map((s) => {
    const accounted = reg.accounted.has(s.sessionId);
    // 未记账分两种：能被 DSH 收养的（等重启归位）和真的没人管的。
    const pendingAdoption = !accounted && s.adoptable;
    return {
      sessionId: s.sessionId,
      workspaceDir: s.workspaceDir,
      workspacePath: reg.accounted.get(s.sessionId) ?? null,
      bytes: s.bytes,
      mtime: s.mtime,
      depth: s.depth,
      cwd: s.cwd,
      createdAt: s.createdAt,
      preset: s.preset,
      blank: s.blank,
      turns: s.turns,
      title: s.title,
      frames: s.frames,
      lineCount: s.lineCount,
      accounted,
      pendingAdoption,
      orphan: !accounted && !s.adoptable,
      archived: reg.archived.has(s.sessionId),
      pinned: reg.pinned.has(s.sessionId),
      dir: s.dir,
    };
  });
  const orphans = rows.filter((r) => r.orphan);
  const pending = rows.filter((r) => r.pendingAdoption);
  const blanks = rows.filter((r) => r.blank);
  const caches = await listOrphanCaches();
  return {
    workspaces: reg.workspaces,
    sessions: rows,
    orphans,
    pending,
    orphanCaches: caches,
    totals: {
      count: rows.length,
      bytes: rows.reduce((sum, r) => sum + r.bytes, 0),
      orphanCount: orphans.length,
      orphanBytes: orphans.reduce((sum, r) => sum + r.bytes, 0),
      pendingCount: pending.length,
      pendingBytes: pending.reduce((sum, r) => sum + r.bytes, 0),
      blankCount: blanks.length,
      blankBytes: blanks.reduce((sum, r) => sum + r.bytes, 0),
      cacheCount: caches.length,
      cacheBytes: caches.reduce((sum, r) => sum + r.bytes, 0),
      archivedCount: rows.filter((r) => r.archived).length,
    },
    // 面板统计的是 sessions/ 下的东西，标题就该显示 sessions 目录，
    // 不是 DSH_HOME 本身（那里还有 profiles、storages、node_modules 等）。
    root: sessionsRoot(),
    home: dshHome(),
  };
}

function activeError(message) {
  const error = new Error("SESSION_ACTIVE");
  error.code = "SESSION_ACTIVE";
  error.detail = message;
  return error;
}

/**
 * 永久删除一个会话。
 * @param force true 时先停掉正在跑的工作再删；false 时活跃会话直接拒绝。
 */
async function purgeOne(ctx, sessionId, force) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    const error = new Error("sessionId 不能为空");
    error.code = "BAD_REQUEST";
    throw error;
  }
  const registry = ctx.workspaceRegistry;

  // 1) 停活 + 归档。不 force 时，活跃会话会在这一步抛 WorkspaceActiveSessionError。
  try {
    if (force === true) {
      await registry.archiveSession(sessionId, { stopActivity: true });
    } else {
      await registry.archiveSession(sessionId);
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/active|busy|running|in use/i.test(message)) throw activeError(message);
    throw error;
  }

  // 2) 从工作区账本摘除
  let detached = 0;
  for (const workspace of registry.list()) {
    const ids = workspace.record?.sessionIds ?? workspace.sessionIds ?? [];
    if (!ids.includes(sessionId)) continue;
    await workspace.detachSession(sessionId);
    detached += 1;
  }

  // 3) 从归档集摘除（第 1 步刚写进去的那个 id）
  await registry.unarchiveSession(sessionId);

  // 4) + 5) 落盘
  const removed = { dirs: [], files: [], links: [] };
  for (const wsName of await safeReaddir(sessionsRoot())) {
    const candidate = path.join(sessionsRoot(), wsName, sessionId);
    if (!(await exists(candidate))) continue;
    const kind = await removeTarget(candidate);
    if (kind === "dir") removed.dirs.push(candidate);
    else if (kind === "link") removed.links.push(candidate);
  }
  const projCache = path.join(projCacheDir(), `${sessionId}.json`);
  if (await exists(projCache)) {
    const kind = await removeTarget(projCache);
    if (kind === "link") removed.links.push(projCache);
    else removed.files.push(projCache);
  }

  return { sessionId, detached, removed };
}

/**
 * 只删真孤儿：既不在账本里，**也**不可能被 DSH 收养的会话目录。
 * 能被收养的（header 有 cwd）一律跳过——删工作区后它们只是暂时"未分组"，
 * 重启会被 bootstrap 收回去，删了就真没了。
 */
async function purgeOrphans(ctx, only) {
  const reg = readRegistry(ctx);
  const wanted = Array.isArray(only) && only.length > 0 ? new Set(only) : null;
  const sessions = await listSessions();
  const results = [];
  for (const session of sessions) {
    if (wanted !== null && !wanted.has(session.sessionId)) continue;
    if (reg.accounted.has(session.sessionId)) {
      results.push({ sessionId: session.sessionId, skipped: "accounted" });
      continue;
    }
    if (session.adoptable) {
      results.push({ sessionId: session.sessionId, skipped: "adoptable" });
      continue;
    }
    const kind = await removeTarget(session.dir);
    const projCache = path.join(projCacheDir(), `${session.sessionId}.json`);
    if (await exists(projCache)) await removeTarget(projCache);
    results.push({ sessionId: session.sessionId, removed: kind, bytes: session.bytes });
  }
  return results;
}

/** 清理孤立投影缓存。这些条目对应的会话目录已经不存在，删掉零风险。 */
async function purgeCaches() {
  const caches = await listOrphanCaches();
  const results = [];
  for (const cache of caches) {
    const kind = await removeTarget(cache.path);
    results.push({ sessionId: cache.sessionId, removed: kind, bytes: cache.bytes });
  }
  return results;
}

/** 在系统文件管理器里打开一个目录。explorer 成功也可能返回非零退出码，故吞错。 */
async function openDirectory(target) {
  try {
    if (process.platform === "win32") {
      await execFileAsync("explorer.exe", [target]);
    } else if (process.platform === "darwin") {
      await execFileAsync("open", [target]);
    } else {
      await execFileAsync("xdg-open", [target]);
    }
  } catch {
    /* 已打开与否都无法确认，交给前端提示已请求 */
  }
  return { dir: target };
}

/** 打开 sessions 根目录本身（面板标题旁那个按钮）。 */
async function revealRoot() {
  const root = sessionsRoot();
  await mkdirSafe(root);
  return openDirectory(root);
}

async function mkdirSafe(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {
    /* 已存在或无权创建，后续打开会自己报错 */
  }
}

/** 在系统文件管理器里定位会话目录（Windows 用 /select 高亮那一项）。 */
async function revealSession(sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") {
    const error = new Error("sessionId 不能为空");
    error.code = "BAD_REQUEST";
    throw error;
  }
  let target = null;
  for (const wsName of await safeReaddir(sessionsRoot())) {
    const candidate = path.join(sessionsRoot(), wsName, sessionId);
    if (await exists(candidate)) {
      target = candidate;
      break;
    }
  }
  if (target === null) {
    const error = new Error("找不到该会话目录");
    error.code = "NOT_FOUND";
    throw error;
  }
  try {
    if (process.platform === "win32") {
      await execFileAsync("explorer.exe", [`/select,${target}`]);
    } else if (process.platform === "darwin") {
      await execFileAsync("open", ["-R", target]);
    } else {
      await execFileAsync("xdg-open", [path.dirname(target)]);
    }
  } catch {
    /* 已打开与否都无法确认，交给前端提示已请求 */
  }
  return { sessionId, dir: target };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > CONFIG.maxBody) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      if (body.trim() === "") return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

async function dispatch(ctx, method, args) {
  switch (method) {
    case "ping":
      return {
        ok: true,
        home: dshHome(),
        version: readOwnVersion(),
        zstd: typeof zlib.zstdDecompressSync === "function",
        node: process.versions.node,
      };
    case "stats":
      return buildStats(ctx);
    case "delete":
      return purgeOne(ctx, args.sessionId, args.force === true);
    case "deleteMany": {
      const ids = Array.isArray(args.sessionIds) ? args.sessionIds : [];
      const done = [];
      const failed = [];
      for (const id of ids) {
        try {
          done.push(await purgeOne(ctx, id, args.force === true));
        } catch (error) {
          failed.push({ sessionId: id, code: error?.code ?? "ERROR", message: String(error?.message ?? error) });
        }
      }
      return { done, failed };
    }
    case "orphans":
      return purgeOrphans(ctx, args.sessionIds);
    case "caches":
      return purgeCaches();
    case "reveal":
      return revealSession(String(args.sessionId || ""));
    case "revealRoot":
      return revealRoot();
    case "probe": {
      // 诊断：对比 sync 与流式解压同一个文件，确认运行时 zlib 的实际行为。
      const resolved = path.resolve(String(args.path || ""));
      if (!resolved.startsWith(path.resolve(sessionsRoot()))) {
        const error = new Error("只允许探测 sessions 目录内的文件");
        error.code = "BAD_REQUEST";
        throw error;
      }
      const buf = await fsp.readFile(resolved);
      const out = {
        compressed: buf.length,
        hasStream: typeof zlib.createZstdDecompress,
        fnSource: String(zlib.zstdDecompressSync).slice(0, 160),
        syncLen: -1,
        syncError: null,
        streamLen: -1,
        streamError: null,
      };
      try {
        out.syncLen = zlib.zstdDecompressSync(buf).length;
      } catch (error) {
        out.syncError = String(error?.message ?? error);
      }
      try {
        out.streamLen = (await inflateAll(buf)).length;
      } catch (error) {
        out.streamError = String(error?.message ?? error);
      }
      return out;
    }
    default: {
      const error = new Error(`未知方法: ${String(method)}`);
      error.code = "BAD_METHOD";
      throw error;
    }
  }
}

function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: ROUTE,
        handler: async (req, res) => {
          const send = (payload) => {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(payload));
          };
          if (req.method !== "POST") {
            res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, code: "METHOD_NOT_ALLOWED", error: "只接受 POST" }));
            return;
          }
          try {
            const body = await readJsonBody(req);
            const result = await dispatch(ctx, body.method, body.args ?? {});
            send({ ok: true, result });
          } catch (error) {
            send({
              ok: false,
              code: error?.code ?? "ERROR",
              error: String(error?.message ?? error),
              detail: error?.detail ?? null,
            });
          }
        },
      }),
    "dsh-session-reaper: /session-reaper/api routes",
  );
}

export {
  name,
  inject,
  apply,
  buildStats,
  purgeOne,
  purgeOrphans,
  purgeCaches,
  listOrphanCaches,
  readSessionMeta,
  removeTarget,
  readHeader,
};
