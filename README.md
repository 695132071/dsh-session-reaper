# dsh-session-reaper

DSH 的「删除会话」只能归档——文件一个字节都不删。这个插件补上真正的永久删除。

## 功能

- **右键「删除会话（永久）」**：删掉会话日志目录、投影缓存、工作区账本记录、搜索索引条目
- **侧边栏底部「会话清理」面板**：看每个会话多大、按工作区分组、批量勾选删除、清理孤儿和孤立缓存
- 全部使用 DSH 原生组件（Modal / Button / Tooltip / Toast），跟随深浅色主题

## 安装

```powershell
dsh plugin --profile desktop add https://codeload.github.com/695132071/dsh-session-reaper/tar.gz/refs/heads/main
```

`desktop` 换成你自己的 profile 名。装完**完整退出 DSH 再启动**（桌面版连托盘一起退）。

要求 DSH ≥ 0.2.1-rc.2。

## 使用

- **单个删除**：侧边栏会话右键 → 删除会话（永久）
- **批量 / 看占用**：点侧边栏底部的清理图标，勾选后删除

删除不进回收站，不可恢复。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-session-reaper
```

## 一个正常现象

删完之后侧边栏那一行还会留着，点开也能看到历史——因为文件和账本已经删了，但前端内存里还挂着那个会话。**重启 DSH 后它就消失**。

这是 DSH 前端没有「移除单个会话」接口导致的，不是删除失败。
