# dsh-session-reaper

DSH 的「删除会话」一直是假的：右键里的**归档**只是往 `workspace.json` 的 `archivedSessionIds` 数组塞一个 id，会话全文、投影缓存、索引条目一个字节都不动。真删只能手动翻目录。

这个插件补上真删，并且把市场上同类插件普遍漏掉的坑一起处理了。

## 能力

### P0 · 核心

| 能力 | 实现 |
|---|---|
| 右键菜单项 | 注册到公开插槽 `sidebar.workspaces.session.menu.item`，order 500，排在「复制 Session ID」之后 |
| 永久删除 | `fs.rm` 递归删，不进回收站，不留 trash 目录 |
| 四处清理 | ① `sessions/<workspace>/<sid>/` ② `storages/session_projcache/sessions/<sid>.json` ③ `workspace.json` 的 `sessionIds` ④ 搜索索引（重启自动重建） |
| 孤儿扫描 | 按「能否被 DSH 收养」判定，不按「当前记没记账」判定（见下） |

### 孤儿判定（v0.1.5 重写）

DSH 启动时 `bootstrap(headers)` 会按 session header 的 `cwd` 给**未记账的会话**
新建工作区收养（`dsh-workspace/lib/index.js` 的收养分支）。所以“不在账本里”
完全可能是暂时的——删掉工作区后、下次重启前，它的会话正好处于这个状态。

旧判定（`不在 sessionIds 里 = 孤儿`）会把这类会话当垃圾，点“全部清理”就是真删。

新判定：

| 条件 | 归类 | 删除入口 |
|---|---|---|
| 在某个工作区账本里 | 正常 | 单行删除 |
| 未记账，但 header 能读出 cwd | **待收养** | 仅单行删除，不进“全部清理” |
| 未记账，且 header 读不出 / 无 cwd | **真孤儿** | 可以“全部清理” |

`bootstrap()` 是启动期方法（会重建 `workspaceIds` 顺序、批量写表），没有幂等保证，
插件不能在运行期调用，所以“待收养”只能等下一次启动归位——这正是不该删它的原因。

另外覆盖一类纯垃圾：`session_projcache/*.json` 里没有对应会话目录的孤立缓存，
独立入口清理，零风险。

### P1 · 防翻车

| 能力 | 实现 |
|---|---|
| 运行中保护 | 默认调 `archiveSession(sid)` 不带 `stopActivity`，活跃会话会被官方直接拒绝（`SESSION_ACTIVE`），二次确认后才 `force` 停活 |
| 二次确认 | 单删 / 批删 / 孤儿清理三处都有 `confirm`，文案列清会删什么 |
| 软链接安全 | `lstat` 判断，junction / symlink 只 `unlink` 链接本身，绝不顺着链接删目标（`nodeLinker: hoisted` 下必须有） |
| 子会话可见 | 读 zstd 头拿 `delegationDepth`，`> 0` 标记为子会话；父会话删掉后它们由孤儿扫描兜底 |

### P2 · 管理面板

| 能力 | 实现 |
|---|---|
| 磁盘占用 | 每个会话字节数 + 工作区小计 + 全局总计 |
| 按工作区分组 | 按 `workspacePath`（回退 `cwd`）分组显示 |
| 批量删除 | 逐行勾选 / 全选，`deleteMany` 串行执行并回报失败项 |

### 明确不做

- **回收站 / 撤销窗口**——需求本身是「不考虑恢复」，加撤销等于把否掉的机制偷偷加回来
- **多 profile 支持**——插槽按 surface 挂载，跨 profile 收益接近零
- **搜索筛选**——个位数会话不需要

## 删除顺序（不能换）

```
1. registry.archiveSession(sid [, { stopActivity }])   停活 + 进归档集
2. workspace.detachSession(sid)                        从 sessionIds 摘除
3. registry.unarchiveSession(sid)                      把第 1 步写进 archivedSessionIds 的 id 摘掉
4. rm -rf sessions/<ws>/<sid>/                          删会话目录
5. rm storages/session_projcache/sessions/<sid>.json    删投影缓存
```

第 2、3 步走的是官方 API，**不直接改 `workspace.json`**。外部改写会被 registry 的内存态在下次任何操作时覆盖回去，删掉的记录原地复活——这是同类插件最常见的翻车点。

第 1 步必须在删文件之前：文件没了，`sessionKnown()` 就查不到，归档无从下手。

## 架构

```
lib/index.js   cordis 插件，inject ["webServer", "workspaceRegistry"]
               POST /session-reaper/api
               methods: ping | stats | delete | deleteMany | orphans
lib/client.js  浏览器 bundle（window.__ModuleLoader__.load 格式）
               只 require("react")，零第三方依赖
```

客户端不做任何文件操作，全部走后端 RPC。

## 安装

```powershell
dsh plugin --profile <profile> add file:<绝对路径>/dsh-session-reaper-0.1.1.tgz
```

`dsh plugin add` 读到包里的 `dsh.bundle.patch` 会自动把 `dsh-session-reaper`
追加进 profile 的 `dsh.profile.bundles`，不需要 postinstall（这点和 dsh-purge 不同，
它的 postinstall 在 pnpm 11 下会被 `ERR_PNPM_IGNORED_BUILDS` 拦掉）。

装完必须**完整退出并重启 DSH**，插件在启动时加载。

## 使用

- 侧边栏会话 → 右键 → **删除会话（永久）**
- 侧边栏底部 **⌫** → 清理面板：占用 / 孤儿 / 批量

## 测试

```powershell
node --test test/
```

7 个用例，全部在临时 `DSH_HOME` 上跑，不碰真实数据：活跃拦截、五步顺序、账本隔离、
孤儿判定、统计、软链接不追删、损坏 zstd 容错、空 id 拒绝。

## 主题适配

所有颜色只走 DSH 的设计 token，不写死任何绝对色。已验证这些 token 在主题包里
都有**深浅两套**定义：

| token | 用在 | 定义数 |
|---|---|---|
| `--dsw-alias-bg-layer-2` | 面板背景 | 2（light / dark） |
| `--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-caption` | 文字 | 2 |
| `--dsw-alias-state-error-primary` | 危险操作文字 | 2 |
| `--dsw-alias-interactive-bg-hover-danger` | 危险操作 hover | 2 |
| `--dsw-alias-bg-mask-2` | 遮罩 | 2 |
| `--dsw-alias-border-l4` | 边框 | 2 |
| `--dsw-elevation-panel` | 面板阴影 | 1（不分主题） |
| `--dsw-radius-panel` / `--dsw-radius-md` | 圆角 | 1（不分主题） |

唯一保留的绝对色是遮罩的最后 fallback `rgba(0,0,0,0.45)`——遮罩本来就是黑色半透明，
深浅主题通用。

> 反例（0.1.1 的 bug）：用了不存在的 `--dsw-alias-bg-primary`，fallback 写 `#fff`。
> 深色主题下背景白、文字却是浅色 → 白底浅字，几乎看不清。v0.1.2 已修。

## 组件来源

全部使用 DSH 自己的 primitives，不出现任何浏览器原生物（无 `window.confirm` /
`window.alert` / `title` 属性）：

| 用途 | 组件 |
|---|---|
| 右键菜单项 | `MenuItemButton`（原生图标位 / 菜单内边距 / 选中态） |
| 清理面板 | `Modal`（open / onClose / title / description / footer） |
| 删除确认框 | `Modal` + `Button`，与 workspace 的归档确认框同构 |
| 所有按钮 | `Button`（variant: `primary` / `outline` / `ghost`） |
| 悬浮提示 | `Tooltip`（label / side / delayMs / portal） |
| 图标 | `IconTrashOutlineRegular` |

关键前提：`@deepseek-ai/dsh-client-ui-primitives` 在磁盘上没有独立包目录，但它是
**web-frontend 通过模块注册表注入的全局模块**：

```js
// dsh-web-frontend/dist/assets/index-*.js
"@deepseek-ai/dsh-client-ui-primitives": TU
```

所以第三方 bundle 里 `require` 一定成功，不需要靠 try/catch 降级（代码里仍保留
兜底，但正常路径走原生组件）。

确认框的渲染位置在 `shell.overlay`（不是菜单内部）——菜单关闭后组件会卸载，
确认框必须挂在常驻的 overlay 上，这点和 DSH 自己的 `SessionArchiveConfirmDialog`
做法一致。

### 空白会话判定（v0.2.1）

DSH 的会话文件不是单个 zstd 帧，而是**多帧容器**：第一帧只装 header 记录，之后每批
事件一帧（见 `dsh-session-persistence-jsonl` 的 `Buffer.concat([headerFrame, eventFrame])`）。

**坑**：`zlib.zstdDecompressSync` 只解第一帧。在 Electron 版 Node 里实测，对一个
186 KB 的会话它只返回 **210 字节**（就那一行 header），`createZstdDecompress` 流式
API 同样只给 210 字节。所以「解压整个文件再数 `turn/start`」的写法会把**所有会话都
误判成空白会话**——v0.1.6 犯过这个 bug，实测 5 个会话全标错。

**修法**：照抄 DSH 自己的 `scanZstdFrames`（结构扫描帧边界，不解压），再逐帧
`zstdDecompressSync(subarray(start, end))`，见到第一个 `turn/start` 就停。

```js
const ZSTD_MAGIC = 4247762216; // 0xFD2FB528
// 每帧：magic(4) + descriptor(1) + 可选 window/dict/contentSize + blocks + 可选 checksum(4)
```

实测：`blank=false`，`frames` 10~1150，单会话 0~2 ms。

空白会话 = 一条 `turn/start` 都没有，也就是只有 header 那一帧。DSH 侧边栏的规则是
`session.blank && id !== current → 不显示`，于是出现「磁盘 6 个、侧边栏 5 个」。

## 已知边界


- `workspace.json` 里的搜索索引由 `dsh-session-query-sqlite` 维护，删目录后
  **重启**才重建；不重启时搜索面板可能短暂显示旧结果。
- 删掉当前正在查看的会话后，客户端会 `location.reload()`，未发送的输入会丢。
- 会话头部是 zstd 压缩，`delegationDepth` 靠解压第一行拿到；头部损坏时按
  `depth: null` 处理，不影响删除。
