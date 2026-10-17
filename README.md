# @local/dsh-qoder-subagent

把 **Qoder CN 自带的 CLI**（`qoderclicn`，藏在 `resources\app.asar.unpacked\node_modules\@qoder-ai\qoder-cn-agent-sdk\dist\_worker\` 里）
当成 DSH 的**免费子代理**用。默认模型 `Qwen3.8-Flash`（实测 `billable: false`、`credits: 0`、`usd: 0`）。

## 工具

| 工具 | 用途 |
|---|---|
| `freesub_run` | 派一个子代理。`wait_ms=0` 立刻返回句柄；**结束后自动注入完成通知**；`wait_ms>0` 同步等结果 |
| `freesub_result` | 取结果（取回后该条通知自动消失） |
| `freesub_send` | 复用会话上下文继续说一句（Qoder 侧 `--resume <session-id>`） |
| `freesub_list` | 谁在跑、谁跑完了、`pending_notifications` 有几条未取回 |
| `freesub_interrupt` | 掐掉（杀进程树），被掐同样产生通知 |
| `freesub_models` | 免费模型表 + 实际发现到的 Qoder 路径 |

设计约束：**逐次选模型**（`model` 是调用参数）、**逐次传权限**（`permission: readonly / edit / full`）、
**零提示词注入**（发出去的就是 `task` 原文，另存 `runs/<id>/prompt.txt` 可逐字核对）、**逐 run 留痕**。

## 运行留痕（`runs/<agent_id>/`）

| 文件 | 内容 |
|---|---|
| `prompt.txt` | 实际发出的原文 |
| `events.jsonl` | Qoder 的原始事件流；**结束时若无 `result` 事件，插件会补写一条 `synthesized: true` 的终止记录** |
| `stderr.log` | 子进程 stderr（失败排查用） |
| `meta.json` | 终态、`stage`、`errorStage`、`cwd`/`cwdRequested`、`eventCount`、`lastEventAt`、`collected`、`noticeCount`、`discovery` 等 |

## v0.2.0 修的四条（对应 2026-10-16 两份报障单）

1. **完成即注入**：注册 `systemPrompt.context({ name: 'freesub-completions' })`，每次组装提示词时把
   "已结束但未取回"的子代理报给**发起它的那个会话**（`scope.id` 对 `owner`）。同一会话最多重复注入 5 次；
   `freesub_result` 取回后立即停止。→ 不再需要人肉轮询。
2. **失败也注入**：`discovery` / `spawn` / `child-exit` / `timeout` / `killed` 全部算终态，同样进通知。
3. **cwd 不存在不再谎报 ENOENT**：`spawn` 前校验 `cwd` 与可执行文件，错误里带
   `stage` / `code` / `path` / `spawnargs` / 实际 `cwd`；返回体带 `startup_failed: true` 与 `detail`。
   （根因：`child_process.spawn` 在 `cwd` 不存在时抛的就是 `spawn <cmd> ENOENT`，看起来像程序缺失。）
4. **事件流必有收尾 + meta 可判活**：见上表。

### 离线验收（不经过宿主，可直接复跑）

装好后从一个会话里跑一条普通任务即可验收这三件事：正常任务返回 `status=done`；
`cwd` 不存在时返回 `status=error` 且 `error_stage=spawn`（不会谎报成 ENOENT）；
完成通知在取回之后从 `pending_notifications` 里消失。

## 生效方式（重要）

**改插件源码不会热重载**（base bundle 的 `hmr` 默认只监听配置，不监听模块；且宿主按目录缓存已加载的模块）。
所以本文件改动后需要**重启该实例**。重启后页面访问 token 会变，用新 token 重新打开页面。

## 已知问题

- **默认 `cwd` 是插件进程的工作目录**（通常是实例目录），不是会话工作区。需要特定目录时请显式传 `cwd`。
- **不要用 profile 补丁层覆盖运行中 bundle 的行配置**：实测在 `profiles/web/cordis.patch.yml` 里按 `id` 覆盖
  `dsh-compact` 这类**已安装 bundle** 的行不生效（组合产物 `cordis.yml` 里根本没有那一行）。
  本插件同理——目前没有可调配置，只有一个 `stateDir`/`maxConcurrent` 的 patch 默认值。
- Qoder 安装目录里存在多份 `Qoder CN.exe`（根目录 / `.qoder-versions\*`），存在版本漂移；
  `freesub_models` 会回报实际使用的那一份路径，报错时请以它为准。

## 版本

- `0.1.0`（`index-v010.js`，备份留档）：完成通知缺失、cwd 不存在谎报 ENOENT。
- `0.2.0`（`index-v020.js`，当前入口）：见上。
