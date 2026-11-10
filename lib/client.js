/**
 * dsh-session-reaper — 前端。
 *
 * 挂三处：
 *   1. sidebar.workspaces.session.menu.item  右键「删除会话（永久）」
 *   2. sidebar.footer.action                 侧栏底部「会话清理」按钮
 *   3. shell.overlay                         清理面板 + 删除确认框
 *
 * 删除一律走后端 /session-reaper/api，前端不做任何文件操作。
 *
 * UI 全部使用 DSH 自己的组件与 token：
 *   MenuItemButton / Modal / Button / Tooltip / IconTrashOutlineRegular
 * 不使用 window.confirm / window.alert / title 属性这些浏览器原生物。
 * 颜色只走 --dsw-* token，深浅主题自动跟随。
 */
window.__ModuleLoader__.load({
  id: "dsh-session-reaper",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    // ---------------------------------------------------------- primitives
    // DSH 把 primitives 作为全局模块注入（web-frontend 的模块注册表里就有），
    // 这里的 require 一定成功；万一上游改了，退回 null 走降级渲染。
    let primitives = null;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives") || null;
    } catch (error) {
      primitives = null;
    }

    const MenuItemButton = primitives ? primitives.MenuItemButton : null;
    const Modal = primitives ? primitives.Modal : null;
    const Button = primitives ? primitives.Button : null;
    const Tooltip = primitives ? primitives.Tooltip : null;
    const Toast = primitives ? primitives.Toast : null;
    const TrashIcon = primitives ? primitives.IconTrashOutlineRegular : null;
    const BrowseIcon = primitives ? primitives.IconBrowseOutlineRegular : null;

    const API = "/session-reaper/api";
    const PANEL_ID = "dsh-session-reaper-panel";
    const STYLE_ID = "dsh-session-reaper-style";

    /**
     * Modal 的宽度只能通过 className 覆盖（DSH 自己也是给 Modal 传 CSS module
     * class 来控制宽度）。这里注一段极小的样式：外层面板 + 内层 [role=dialog]
     * 都写一遍，className 无论落在哪一层都能命中。
     */
    function ensureReaperStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID)) return;
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = [
        ".dsh-reaper-wide,.dsh-reaper-wide[role=dialog]{",
        "width:min(920px,94vw)!important;max-width:min(920px,94vw)!important;}",
        ".dsh-reaper-wide [role=dialog]{",
        "width:min(920px,94vw)!important;max-width:min(920px,94vw)!important;}",
        ".dsh-reaper-confirm,.dsh-reaper-confirm[role=dialog]{",
        "width:min(560px,92vw)!important;max-width:min(560px,92vw)!important;}",
        ".dsh-reaper-confirm [role=dialog]{",
        "width:min(560px,92vw)!important;max-width:min(560px,92vw)!important;}",
        "/* 会话 id 单行显示，不再折成三行 */",
        ".dsh-reaper-id{",
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
        "font-variant-numeric:tabular-nums;letter-spacing:-0.1px;}",
        "/* 孤儿提示条：文案不换行，按钮不被挤成两行 */",
        ".dsh-reaper-orphanbar{flex-wrap:nowrap;}",
        ".dsh-reaper-orphanbar>button{flex:none;white-space:nowrap;}",
      ].join("");
      document.head.appendChild(el);
    }

    // ---------------------------------------------------------------- rpc
    async function api(method, args) {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, args: args || {} }),
      });
      let data;
      try {
        data = await res.json();
      } catch (error) {
        throw new Error(`后端无响应（HTTP ${res.status}）`);
      }
      if (!data.ok) {
        const failure = new Error(data.error || "请求失败");
        failure.code = data.code || "ERROR";
        throw failure;
      }
      return data.result;
    }

    /**
     * 删除确认框的内容模板。侧边栏右键和面板里必须用同一套，
     * 否则同一个动作在两处说的话不一样（之前就是这样）。
     *
     * 四类都要列出来：删的不只是会话目录，账本记录和搜索索引同样会被清。
     * 只写「全部落盘数据」太笼统，用户看不出会话以外的副作用。
     */
    function buildDeletePrompt(label) {
      return {
        title: "永久删除会话",
        description: `会话「${label}」 及其全部落盘数据将被永久删除。`,
        items: [
          "会话日志",
          "投影缓存",
          "工作区账本中的记录（含归档 / 置顶标记）",
          "搜索索引条目（重启后自动重建）",
        ],
      };
    }


    // ------------------------------------------------------------- format
    function fmtBytes(n) {
      if (!n || n < 1024) return `${n || 0} B`;
      const units = ["KB", "MB", "GB", "TB"];
      let value = n / 1024;
      let i = 0;
      while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i += 1;
      }
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
    }

    function shortId(id) {
      const text = String(id || "");
      return text.length > 26 ? `${text.slice(0, 12)}…${text.slice(-6)}` : text;
    }

    function baseName(p) {
      if (!p) return "";
      const parts = String(p).split(/[\\/]/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : String(p);
    }

    /**
     * 工作区显示名。DSH 的规则是 `title === "default-workspace"` 时换成当前语言的
     * 「默认工作区」（见 ui-workspace 的 workspaceDisplayTitle），这里照抄。
     */
    function displayWorkspaceTitle(title) {
      return title === "default-workspace" ? "默认工作区" : title;
    }

    function groupTitle(path, titleByPath) {
      if (!path) return "未登记";
      return displayWorkspaceTitle(titleByPath.get(path) || baseName(path));
    }

    /** 操作结果提示：用 DSH 的 Toast 浮层，不再是表格里的行内文字。 */
    let toastState = null;
    const toastListeners = new Set();
    let toastSeq = 0;

    function pushToast(text) {
      toastSeq += 1;
      toastState = { id: toastSeq, text };
      for (const listener of toastListeners) listener();
    }

    function clearToast() {
      toastState = null;
      for (const listener of toastListeners) listener();
    }

    function useToastState() {
      const [value, setValue] = react.useState(toastState);
      react.useEffect(() => {
        const listener = () => setValue(toastState);
        toastListeners.add(listener);
        return () => {
          toastListeners.delete(listener);
        };
      }, []);
      return value;
    }

    function trashIcon(size) {
      return TrashIcon ? h(TrashIcon, { size: size || 14 }) : "\u232b";
    }

    /**
     * 给操作按钮套一层 DSH 的 Tooltip。中间垫一个 span：Tooltip 靠 ref 定位，
     * 而 Button 是函数组件不保证转发 ref，垫 span 更稳。
     */
    function withTip(label, node) {
      if (!Tooltip) return node;
      return h(
        Tooltip,
        { label, side: "top", delayMs: 400, portal: true },
        h("span", { style: { display: "inline-flex", alignItems: "center" } }, node),
      );
    }

    // --------------------------------------------------------------- 面板开关
    let panelOpen = false;
    const panelListeners = new Set();

    function setPanelOpen(next) {
      if (panelOpen === next) return;
      panelOpen = next;
      for (const listener of panelListeners) listener();
    }

    function usePanelOpen() {
      const [open, setOpen] = react.useState(panelOpen);
      react.useEffect(() => {
        const listener = () => setOpen(panelOpen);
        panelListeners.add(listener);
        return () => {
          panelListeners.delete(listener);
        };
      }, []);
      return open;
    }

    // ------------------------------------------------------- 确认请求队列
    // 菜单项只负责"发起请求"，真正渲染 Modal 的是 shell.overlay 里的
    // ConfirmHost —— 和 DSH 自己 ArchiveConfirmDialog 的做法一致。
    let pendingRequest = null;
    const requestListeners = new Set();

    function setPendingRequest(next) {
      pendingRequest = next;
      for (const listener of requestListeners) listener();
    }

    function usePendingRequest() {
      const [value, setValue] = react.useState(pendingRequest);
      react.useEffect(() => {
        const listener = () => setValue(pendingRequest);
        requestListeners.add(listener);
        return () => {
          requestListeners.delete(listener);
        };
      }, []);
      return value;
    }

    /** 发起一次删除确认。返回 Promise<boolean>，确认后 resolve true。 */
    function requestDelete(payload) {
      return new Promise((resolve) => {
        setPendingRequest({ ...payload, settle: resolve });
      });
    }

    function showError(title, message) {
      // 错误也用同一个 Modal 宿主，避免 window.alert 这种浏览器原生弹窗。
      requestDelete({ kind: "error", title, description: message, items: [] });
    }

    // ------------------------------------------------------------- 菜单项
    function DeleteSessionMenuItem(props) {
      const sessionId = props.sessionId;
      const displayTitle = props.displayTitle || props.sessionId;
      const useMenuOpenState = props.useMenuOpenState;
      const menuState = typeof useMenuOpenState === "function" ? useMenuOpenState() : null;
      const setMenuOpen = menuState && typeof menuState[1] === "function" ? menuState[1] : null;

      const onSelect = async () => {
        if (setMenuOpen) setMenuOpen(false);
        const confirmed = await requestDelete({
          kind: "single",
          sessionId,
          ...buildDeletePrompt(displayTitle),
        });
        if (!confirmed) return;
        try {
          await api("delete", { sessionId });
          // 不整页刷新：会话的文件和账本已经删了，但那个会话的 live 实例还在内存里，
          // 侧边栏会暂时把它归到「未分组」并且仍能打开（历史从内存读），页面刷新后消失。
          pushToast("已永久删除，重启 DSH 后清空未分组工作区");
        } catch (error) {
          if (error.code === "SESSION_ACTIVE") {
            const force = await requestDelete({
              kind: "active",
              sessionId,
              title: "会话正在运行",
              description: "它还有未结束的工作。停止并永久删除吗？未保存的进行中内容会丢失。",
              items: [`会话：${displayTitle}`],
            });
            if (!force) return;
            try {
              await api("delete", { sessionId, force: true });
              pushToast("已停止并永久删除，重启 DSH 后清空未分组工作区");
            } catch (inner) {
              showError("删除失败", inner.message);
            }
            return;
          }
          showError("删除失败", error.message);
        }
      };

      if (MenuItemButton) {
        return h(
          MenuItemButton,
          { onSelect, icon: trashIcon(14) },
          "删除会话（永久）",
        );
      }
      return h(
        "button",
        {
          type: "button",
          onClick: onSelect,
          style: {
            display: "flex",
            alignItems: "center",
            gap: "8px",
            width: "100%",
            minHeight: "32px",
            border: "none",
            background: "transparent",
            color: "var(--dsw-alias-state-error-primary)",
            padding: "0 10px",
            borderRadius: "var(--dsw-radius-md)",
            cursor: "pointer",
            font: "inherit",
            fontSize: "14px",
            textAlign: "left",
          },
        },
        trashIcon(14),
        h("span", null, "删除会话（永久）"),
      );
    }

    // ------------------------------------------------------------ 侧栏按钮
    function ReaperTrigger(props) {
      const wide = props && props.wide;
      const trigger = Button
        ? h(
            Button,
            { variant: "ghost", onClick: () => setPanelOpen(!panelOpen) },
            wide
              ? [trashIcon(14), h("span", { key: "label", style: { marginLeft: "6px" } }, "会话清理")]
              : trashIcon(16),
          )
        : h(
            "button",
            {
              type: "button",
              onClick: () => setPanelOpen(!panelOpen),
              style: {
                display: "flex",
                alignItems: "center",
                gap: "6px",
                width: wide ? "100%" : "auto",
                border: "none",
                background: "transparent",
                color: "var(--dsw-alias-label-secondary)",
                cursor: "pointer",
                padding: "6px 8px",
                borderRadius: "var(--dsw-radius-md)",
                font: "inherit",
                fontSize: "13px",
              },
            },
            trashIcon(14),
            wide ? h("span", null, "会话清理") : null,
          );

      if (Tooltip) {
        return h(
          Tooltip,
          { label: "会话清理：占用 / 孤儿 / 批量删除", side: "top", delayMs: 400, portal: true },
          trigger,
        );
      }
      return trigger;
    }

    // ------------------------------------------------------------------ 样式
    const S = {
      kv: {
        margin: "0 0 12px",
        padding: "0 0 0 18px",
        color: "var(--dsw-alias-label-secondary)",
        fontSize: "13px",
        lineHeight: 1.7,
      },
      error: {
        margin: "12px 0 0",
        color: "var(--dsw-alias-state-error-primary)",
        fontSize: "12px",
      },
      meta: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
      row: { display: "flex", alignItems: "center", gap: "10px" },
      head: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        marginBottom: "10px",
      },
      orphanBar: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
        marginBottom: "10px",
        padding: "8px 10px",
        borderRadius: "var(--dsw-radius-md)",
        border: "1px solid var(--dsw-alias-state-error-primary)",
        background: "var(--dsw-alias-interactive-bg-hover-danger)",
      },
      /** 待收养：只读提示，故意不用危险色，也不给删除按钮。 */
      pendingBar: {
        marginBottom: "10px",
        padding: "8px 10px",
        borderRadius: "var(--dsw-radius-md)",
        border: "1px solid var(--dsw-alias-border-l4)",
        background: "var(--dsw-alias-fill-l1, transparent)",
      },
      table: { width: "100%", borderCollapse: "collapse" },
      th: {
        textAlign: "left",
        fontSize: "11px",
        fontWeight: 600,
        color: "var(--dsw-alias-label-caption)",
        padding: "6px",
        borderBottom: "1px solid var(--dsw-alias-border-l4)",
        textAlign: "center",
        whiteSpace: "nowrap",
      },
      td: {
        padding: "6px",
        borderBottom: "1px solid var(--dsw-alias-border-l4)",
        verticalAlign: "middle",
        color: "var(--dsw-alias-label-primary)",
        fontSize: "13px",
        textAlign: "center",
      },
      group: {
        marginTop: "16px",
        fontSize: "12px",
        fontWeight: 600,
        color: "var(--dsw-alias-label-secondary)",
      },
      tag: {
        display: "inline-block",
        padding: "0 6px",
        borderRadius: "999px",
        fontSize: "11px",
        lineHeight: "16px",
        marginLeft: "6px",
        border: "1px solid currentColor",
        opacity: 0.85,
      },
      scroll: { maxHeight: "46vh", overflow: "auto" },
    };

    /**
     * 六种状态各用一种颜色，互不重复：
     *   正常 绿 / 空会话 灰 / 孤儿 红 / 待收养 橙 / 已归档 淡蓝 / 置顶 蓝
     */
    const TAG_COLOR = {
      normal: "var(--dsw-alias-state-success-primary)",
      blank: "var(--dsw-alias-state-idle-primary)",
      orphan: "var(--dsw-alias-state-error-primary)",
      pending: "var(--dsw-alias-state-warn-primary)",
      archived: "var(--dsw-alias-state-business-tertiary)",
      pinned: "var(--dsw-alias-state-business-primary)",
    };

    function Tag({ children, color }) {
      return h(
        "span",
        { style: { ...S.tag, color: color || "var(--dsw-alias-label-tertiary)" } },
        children,
      );
    }

    /**
     * 状态列。六种状态全部用 Tag，颜色各不相同（见 TAG_COLOR）：
     * 正常 / 空会话 / 孤儿 / 待收养 / 已归档 / 置顶。
     * 一行的多个状态可以叠加（例如「已归档」+「空会话」）。
     */
    function TdStatusTags({ row }) {
      const tags = [];
      if (row.orphan) tags.push(h(Tag, { key: "orphan", color: TAG_COLOR.orphan }, "孤儿"));
      else if (row.pendingAdoption) {
        tags.push(h(Tag, { key: "pending", color: TAG_COLOR.pending }, "待收养"));
      }
      if (row.blank) tags.push(h(Tag, { key: "blank", color: TAG_COLOR.blank }, "空会话"));
      if (row.archived) tags.push(h(Tag, { key: "archived", color: TAG_COLOR.archived }, "已归档"));
      if (row.pinned) tags.push(h(Tag, { key: "pinned", color: TAG_COLOR.pinned }, "置顶"));
      if (tags.length === 0) {
        tags.push(h(Tag, { key: "normal", color: TAG_COLOR.normal }, "正常"));
      }
      return tags;
    }

    // ------------------------------------------------------------ 确认框
    function DeleteConfirmHost() {
      const request = usePendingRequest();
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);

      if (!request) return null;

      const isError = request.kind === "error";

      const settle = (value) => {
        const done = request.settle;
        setPendingRequest(null);
        setBusy(false);
        setError(null);
        if (typeof done === "function") done(value);
      };

      const body = isError
        ? []
        : [
            request.items && request.items.length > 0
              ? h(
                  "ul",
                  { key: "items", style: S.kv },
                  request.items.map((item, index) => h("li", { key: index }, item)),
                )
              : null,
            error ? h("div", { key: "err", role: "alert", style: S.error }, error) : null,
          ].filter(Boolean);

      const footer = isError
        ? [h(Button, { key: "ack", variant: "primary", onClick: () => settle(false) }, "知道了")]
        : [
            // 主操作放左边、取消放右边（按使用方要求，与 Modal 默认顺序相反）
            h(
              Button,
              { key: "ok", variant: "primary", disabled: busy, onClick: () => settle(true) },
              busy ? "处理中…" : request.kind === "active" ? "停止并删除" : "永久删除",
            ),
            h(
              Button,
              { key: "cancel", variant: "outline", disabled: busy, onClick: () => settle(false) },
              "取消",
            ),
          ];

      if (!Modal) return null;
      return h(
        Modal,
        {
          open: true,
          onClose: () => settle(false),
          closeLabel: "关闭",
          title: request.title,
          description: request.description,
          className: "dsh-reaper-confirm",
          footer,
        },
        body,
      );
    }

    // ------------------------------------------------------------ 清理面板
    function ReaperPanel() {
      const open = usePanelOpen();
      const [data, setData] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [selected, setSelected] = react.useState(() => ({}));

      /** 操作结果走 DSH 的 Toast 浮层，不再占用面板内的行。 */
      const showNote = pushToast;

      const refresh = async () => {
        setBusy(true);
        try {
          setData(await api("stats", {}));
          setError(null);
        } catch (caught) {
          setError(`读取失败：${caught.message}`);
        } finally {
          setBusy(false);
        }
      };

      react.useEffect(() => {
        if (open) {
          refresh();
        } else {
          // 关闭时清空选中。之前 selected 留在组件状态里，关掉再开还是勾着的。
          setSelected({});
          setError(null);
        }
      }, [open]);

      if (!open || !Modal) return null;

      const sessions = data ? data.sessions : [];
      const totals = data
        ? data.totals
        : {
            count: 0,
            bytes: 0,
            orphanCount: 0,
            orphanBytes: 0,
            pendingCount: 0,
            pendingBytes: 0,
            cacheCount: 0,
            cacheBytes: 0,
          };
      const selectedIds = Object.keys(selected).filter((id) => selected[id]);

      const toggle = (id) => setSelected((prev) => ({ ...prev, [id]: !prev[id] }));

      /**
       * 按组全选。之前这里的实现是全局的：任何一个组的表头都调用同一个
       * toggleAll，勾一个组等于勾了全部会话——截图里「已选 5 个」就是这么来的。
       */
      const toggleGroup = (rows) => {
        const allSelected = rows.every((row) => selected[row.sessionId]);
        setSelected((prev) => {
          const next = { ...prev };
          for (const row of rows) {
            if (allSelected) delete next[row.sessionId];
            else next[row.sessionId] = true;
          }
          return next;
        });
      };

      const revealSessionDir = async (row) => {
        try {
          await api("reveal", { sessionId: row.sessionId });
        } catch (caught) {
          pushToast(`打开目录失败：${caught.message}`);
        }
      };

      const revealRootDir = async () => {
        try {
          await api("revealRoot", {});
        } catch (caught) {
          pushToast(`打开 sessions 目录失败：${caught.message}`);
        }
      };

      const deleteOne = async (session) => {
        const confirmed = await requestDelete({
          kind: "single",
          sessionId: session.sessionId,
          ...buildDeletePrompt(session.title || shortId(session.sessionId)),
        });
        if (!confirmed) return;
        setBusy(true);
        try {
          await api("delete", { sessionId: session.sessionId });
          // 只重拉面板数据，不整页刷新。侧边栏那一行要等页面刷新才消失。
          await refresh();
          pushToast("已永久删除，重启 DSH 后清空未分组工作区");
        } catch (caught) {
          if (caught.code === "SESSION_ACTIVE") {
            const force = await requestDelete({
              kind: "active",
              sessionId: session.sessionId,
              title: "会话正在运行",
              description: "停止它的工作并永久删除吗？",
              items: [`会话：${shortId(session.sessionId)}`],
            });
            if (!force) {
              setBusy(false);
              return;
            }
            try {
              await api("delete", { sessionId: session.sessionId, force: true });
              await refresh();
              pushToast("已停止并永久删除，重启 DSH 后清空未分组工作区");
            } catch (inner) {
              setError(`删除失败：${inner.message}`);
            }
          } else {
            setError(`删除失败：${caught.message}`);
          }
        } finally {
          setBusy(false);
        }
      };

      const deleteSelected = async () => {
        if (selectedIds.length === 0) return;
        const confirmed = await requestDelete({
          kind: "bulk",
          title: `永久删除 ${selectedIds.length} 个会话`,
          description: "选中会话连同日志、缓存、账本记录一并删除，不进回收站。",
          items: selectedIds.slice(0, 8).map((id) => shortId(id)).concat(
            selectedIds.length > 8 ? [`…以及另外 ${selectedIds.length - 8} 个`] : [],
          ),
        });
        if (!confirmed) return;
        setBusy(true);
        try {
          const result = await api("deleteMany", { sessionIds: selectedIds });
          setSelected({});
          await refresh();
          const failed = result.failed || [];
          if (failed.length > 0) {
            setError(`删除 ${result.done.length} 个；${failed.length} 个失败：${failed[0].message}`);
            return;
          }
          pushToast(`已永久删除 ${result.done.length} 个，重启 DSH 后清空未分组工作区`);
        } catch (caught) {
          setError(`批量删除失败：${caught.message}`);
        } finally {
          setBusy(false);
        }
      };

      const purgeOrphans = async () => {
        const confirmed = await requestDelete({
          kind: "orphan",
          title: `清理 ${totals.orphanCount} 个孤儿会话`,
          description: `共 ${fmtBytes(totals.orphanBytes)}。孤儿 = 日志头读不出 cwd 的会话目录，DSH 重启也不会收养。待收养的会话不在此列。`,
          items: (data ? data.orphans : []).slice(0, 8).map((row) => shortId(row.sessionId)),
        });
        if (!confirmed) return;
        setBusy(true);
        try {
          const result = await api("orphans", {});
          await refresh();
          pushToast(`已清理 ${result.filter((item) => !item.skipped).length} 个孤儿`);
        } catch (caught) {
          setError(`清理失败：${caught.message}`);
        } finally {
          setBusy(false);
        }
      };

      const purgeCaches = async () => {
        setBusy(true);
        try {
          const result = await api("caches", {});
          await refresh();
          showNote(`已清理 ${result.length} 条孤立缓存`);
        } catch (caught) {
          setError(`清理缓存失败：${caught.message}`);
        } finally {
          setBusy(false);
        }
      };

      // 分组顺序 + 组内顺序都要跟 DSH 侧边栏一致：
      //   组顺序 = registry.workspaceIds（data.workspaces 的顺序）
      //   组内顺序 = workspace.sessionIds（账本里的显示顺序，不是目录扫描顺序）
      const titleByPath = new Map();
      const order = [];
      const rankByPath = new Map();
      for (const workspace of data ? data.workspaces : []) {
        titleByPath.set(workspace.path, workspace.title);
        order.push(workspace.path);
        rankByPath.set(
          workspace.path,
          new Map(workspace.sessionIds.map((id, index) => [id, index])),
        );
      }
      const groups = new Map();
      for (const key of order) groups.set(key, []);
      const loose = [];
      for (const session of sessions) {
        const key = session.workspacePath;
        if (key !== null && groups.has(key)) groups.get(key).push(session);
        else loose.push(session);
      }
      for (const key of order) {
        const rows = groups.get(key);
        if (rows.length === 0) {
          groups.delete(key);
          continue;
        }
        const rank = rankByPath.get(key);
        if (rank !== undefined) {
          const tail = Number.MAX_SAFE_INTEGER;
          rows.sort((left, right) => {
            const a = rank.has(left.sessionId) ? rank.get(left.sessionId) : tail;
            const b = rank.has(right.sessionId) ? rank.get(right.sessionId) : tail;
            return a - b;
          });
        }
      }
      // 未登记的按最近修改时间倒序，跟 DSH 的 Ungrouped 一致
      loose.sort((left, right) => (right.mtime ?? 0) - (left.mtime ?? 0));
      if (loose.length > 0) groups.set("", loose);

      const body = [];

      // 顶部：sessions 根目录 + 打开按钮；统计信息弱化放在下一行。
      // marginTop:-20px 抵消 Modal 内 `_body_` 自带的 margin-top:20px ——
      // 那 20px 原本用来和 description 分隔，这里没有 description，留着就是一段空白。
      body.push(
        h(
          "div",
          {
            key: "root",
            style: {
              display: "flex",
              alignItems: "center",
              gap: "6px",
              marginTop: "-20px",
              marginBottom: "2px",
            },
          },
          h(
            "span",
            {
              style: {
                fontFamily: "var(--dsw-font-mono, monospace)",
                fontSize: "13px",
                wordBreak: "break-all",
                color: "var(--dsw-alias-label-primary)",
              },
            },
            data ? data.root || data.home : "读取中…",
          ),
          Button && BrowseIcon
            ? withTip(
                "在资源管理器中打开",
                h(
                  Button,
                  { variant: "ghost", onClick: revealRootDir },
                  h(BrowseIcon, { size: 14 }),
                ),
              )
            : null,
        ),
      );
      body.push(
        h(
          "div",
          { key: "summary", style: { ...S.meta, marginBottom: "10px" } },
          `${totals.count} 个会话 · 共 ${fmtBytes(totals.bytes)}`,
        ),
      );

      if (error) {
        body.push(h("div", { key: "err", role: "alert", style: S.error }, error));
      }

      if (totals.orphanCount > 0) {
        body.push(
          h(
            "div",
            { key: "orphans", className: "dsh-reaper-orphanbar", style: S.orphanBar },
            h(
              "span",
              null,
              h("strong", null, `${totals.orphanCount} 个孤儿会话`),
              h(
                "span",
                { style: S.meta },
                ` · ${fmtBytes(totals.orphanBytes)} · 日志头读不出 cwd，DSH 永远不会收养`,
              ),
            ),
            Button
              ? h(
                  Button,
                  { variant: "primary", disabled: busy, onClick: purgeOrphans },
                  "全部清理",
                )
              : null,
          ),
        );
      }

      if (totals.pendingCount > 0) {
        body.push(
          h(
            "div",
            { key: "pending", style: S.pendingBar },
            h(
              "span",
              null,
              h("strong", null, `${totals.pendingCount} 个会话待收养`),
              h(
                "span",
                { style: S.meta },
                ` · ${fmtBytes(totals.pendingBytes)} · 当前不在账本里，但 header 有 cwd，重启 DSH 会自动归位。不提供删除。`,
              ),
            ),
          ),
        );
      }

      if (totals.cacheCount > 0) {
        body.push(
          h(
            "div",
            { key: "caches", style: { ...S.row, marginBottom: "10px" } },
            h(
              "span",
              { style: S.meta },
              `${totals.cacheCount} 条孤立投影缓存 · ${fmtBytes(totals.cacheBytes)}`,
            ),
            Button
              ? h(
                  Button,
                  { variant: "outline", disabled: busy, onClick: purgeCaches },
                  "清理缓存",
                )
              : null,
          ),
        );
      }

      if (selectedIds.length > 0) {
        body.push(
          h(
            "div",
            { key: "bulk", style: { ...S.row, marginBottom: "10px" } },
            h("span", { style: S.meta }, `已选 ${selectedIds.length} 个`),
            Button
              ? h(
                  Button,
                  { variant: "primary", disabled: busy, onClick: deleteSelected },
                  "删除选中",
                )
              : null,
            Button
              ? h(
                  Button,
                  { variant: "outline", onClick: () => setSelected({}) },
                  "取消选择",
                )
              : null,
          ),
        );
      }

      const sections = [];
      for (const [groupKey, rows] of groups) {
        const groupBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
        const head = h(
          "thead",
          { key: "h" },
          h(
            "tr",
            null,
            h(
              "th",
              { style: { ...S.th, width: "28px" } },
              h("input", {
                type: "checkbox",
                checked: rows.every((row) => selected[row.sessionId]),
                onChange: () => toggleGroup(rows),
                style: { accentColor: "var(--dsw-alias-state-business-primary)" },
              }),
            ),
            h("th", { style: { ...S.th, textAlign: "left" } }, "会话"),
            h("th", { style: { ...S.th, width: "88px" } }, "大小"),
            h("th", { style: { ...S.th, width: "132px" } }, "状态"),
            h("th", { style: { ...S.th, width: "88px" } }, "操作"),
          ),
        );
        const tbody = rows.map((row) =>
          h(
            "tr",
            { key: row.sessionId },
            h(
              "td",
              { style: S.td },
              h("input", {
                type: "checkbox",
                checked: Boolean(selected[row.sessionId]),
                onChange: () => toggle(row.sessionId),
                style: { accentColor: "var(--dsw-alias-state-business-primary)" },
              }),
            ),
            h(
              "td",
              { style: { ...S.td, textAlign: "left" } },
              // 标题这一行是给人看的；ID 缩到下面一行给机器看。
              h(
                "div",
                {
                  style: {
                    fontWeight: row.title ? 500 : 400,
                    wordBreak: "break-word",
                    lineHeight: "18px",
                  },
                },
                row.title || shortId(row.sessionId),
              ),
              h(
                "div",
                {
                  className: "dsh-reaper-id",
                  style: { ...S.meta, fontFamily: "var(--dsw-font-mono, monospace)" },
                },
                shortId(row.sessionId),
                row.depth !== null && row.depth > 0 ? ` · 子会话 深度 ${row.depth}` : "",
              ),
            ),
            h("td", { style: S.td }, fmtBytes(row.bytes)),
            h(
              "td",
              { style: S.td },
              h(TdStatusTags, { row }),
            ),
            h(
              "td",
              { style: { ...S.td, width: "88px", whiteSpace: "nowrap" } },
              Button && BrowseIcon
                ? withTip(
                    "在资源管理器中打开",
                    h(
                      Button,
                      { variant: "ghost", onClick: () => revealSessionDir(row) },
                      h(BrowseIcon, { size: 14 }),
                    ),
                  )
                : null,
              Button
                ? withTip(
                    "永久删除此会话（不可恢复）",
                    h(
                      Button,
                      { variant: "ghost", disabled: busy, onClick: () => deleteOne(row) },
                      trashIcon(14),
                    ),
                  )
                : null,
            ),
          ),
        );
        sections.push(
          h(
            "div",
            { key: groupKey, style: S.group },
            h(
              "div",
              { style: S.row },
              h("span", null, groupTitle(groupKey, titleByPath)),
              h("span", { style: S.meta }, ` · ${rows.length} 个 · ${fmtBytes(groupBytes)}`),
            ),
            h("table", { style: S.table }, [head, h("tbody", { key: "b" }, tbody)]),
          ),
        );
      }

      if (sections.length === 0) {
        body.push(
          h("div", { key: "empty", style: S.meta }, busy ? "读取中…" : "没有会话"),
        );
      } else {
        body.push(h("div", { key: "list", style: S.scroll }, sections));
      }

      const footer = [
        h(
          Button,
          { key: "refresh", variant: "primary", disabled: busy, onClick: refresh },
          busy ? "读取中…" : "刷新",
        ),
        h(
          Button,
          { key: "close", variant: "ghost", onClick: () => setPanelOpen(false) },
          "关闭",
        ),
      ];

      return h(
        Modal,
        {
          open: true,
          onClose: () => setPanelOpen(false),
          closeLabel: "关闭",
          title: "会话清理",
          // 路径和统计都放进 children 自己排版（路径 + 按钮一行、统计弱化一行），
          // 不再用 description —— 它只能放纯文本，塞不进按钮。
          className: "dsh-reaper-wide",
          footer,
        },
        body,
      );
    }

    // ------------------------------------------------------------- overlay
    /** 操作结果浮层：DSH 原生 Toast，自带进出动画，播完自己消失。 */
    function ToastHost() {
      const toast = useToastState();
      if (!toast || !Toast) return null;
      return h(Toast, {
        key: `reaper-toast-${toast.id}`,
        text: toast.text,
        tone: "success",
        onDone: () => clearToast(),
      });
    }

    function ReaperOverlay() {
      return h(
        react.Fragment,
        null,
        h(ReaperPanel, null),
        h(DeleteConfirmHost, null),
        h(ToastHost, null),
      );
    }

    // ------------------------------------------------------------------ apply
    const injectClients = ["slots"];

    function apply(ctx) {
      ensureReaperStyle();

      ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
        yield ctx.slots.register(
          {
            name: "sidebar.workspaces.session.menu.item",
            id: "reaper-delete",
            order: 500,
          },
          DeleteSessionMenuItem,
        );
      });

      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: PANEL_ID,
            order: 6,
            label: "会话清理",
          },
          (props) => h(ReaperTrigger, { wide: props.wide }),
        ),
      );

      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: `${PANEL_ID}-overlay`,
            order: 12,
          },
          () => h(ReaperOverlay, null),
        ),
      );
    }

    exports.apply = apply;
    exports.inject = injectClients;
    return module.exports;
  },
});
