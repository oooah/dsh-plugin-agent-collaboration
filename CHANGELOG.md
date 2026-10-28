## Unreleased — 停止只作用于一个 run；bot 的审批必须真的能到达

- **修复：停止/超时不再误杀同房间同 bot 的另一个回合。** 执行器按 `(roomId, botId)` 取消 live
  agent，而同一对的第二个 run 只是在等这把互斥锁 —— 它自己的预算超时后取消的是**第一个 run 正在
  跑的请求**。实测：run A 卡在审批对话框上 19 分 49 秒，run B 排在后面，B 的 180s 预算耗尽时把 A
  的请求取消了，A 的审批变成 `cancelled`，两条 run 同一秒收口。现在 `cancel` 带上 runId，只对
  「当前真正持有本回合」的 run 生效（`stopReachesTurn`，已加测试）。
- **修复：排队等待不再计入执行预算。** `deadlineAt` 原本在认领时就写死，于是排队时间被当成执行
  时间：B 在一条请求都没发出的情况下以「已用 180s，预算 180s」失败。现在预算在回合**真正开始**
  时才起算（`SessionRunner.onTurnStart` → `RunExecutor.onTurnStarted`），排队本身另受总上限约束。
- **修复：bot 的审批对话框不再可能永远挂着。** bot 会话是隐藏的 `subagent` 会话，DSH 原生审批卡
  没有可渲染的界面；一旦 `memberRoomId()` 没命中（会话表缺失/被重写、旧 generation id），对话框
  会穿透到原生 UI 而无人可见。现在审批桥回落到解析自己生成的会话 id（`ac:<roomId>:<botId>`），
  并且无人应答的对话框在 `approvalTimeoutMs`（默认 120s）后**自动拒绝**并在房间里留一行说明。
- **修复：无人应答的审批不再让回合永久挂起（与谁接单无关）。** 审批桥只对自己接到的对话框
  计时；如果瀑布请求压根没有被 claim，宿主会等一个渲染不了隐藏会话的 answerer，而回合手里还开着
  一个工具调用 —— 0.3.5 的「活跃工具豁免」于是把无进展判定也一起停掉，死锁没有上限（实测：先是
  19 分 49 秒，后来又出现 8 分钟以上）。现在执行器直接读会话日志（`approval/asked` 且随后没有
  `approval/decided`），超过 `approvalTimeoutMs` 就以「审批等待 Ns 无人处理」终止本轮并给出可操作
  提示（`pendingApprovalSince`，已加测试）。
- 新增 `tests/stop-scope.test.ts`。全量测试 **542/549**；7 个失败全部是
  `tests/file-handoff.test.ts` 在 Windows 上**改动前即存在**的失败（未改动的 main 同样复现）。

## 0.3.5 — 长任务活跃豁免

- 运行中的工具调用（`tool-start`…`tool-end`）现在被识别为**真实进展**：工具在跑时不再触发
  「运行无进展，已停止」，过期 deadline 也会向后滚动（受总上限约束）。
- 适合长时间 shell/编译/下载/深挖任务；工具结束后恢复普通无进展判定。
- 实测：5 秒无进展 + 10 秒总预算下，真实 `sleep 20` 工具运行 25 秒后正常完成。
- 包版本：bundle **0.3.5**、core **0.3.4**；tools/UI 无代码变化，版本保持 0.3.2/0.3.9。
- 全量测试 **542/542**；core tsc/build 通过。

### 发布状态（2026-10-22）

- npm：core **0.3.4**、bundle **0.3.5**（latest）；tools 0.3.2 / ui 0.3.9 无变化
- GitHub Release：`v0.3.5`，同一 tarball（sha256 `c3a180c1…`）
- 市场 PR：awesome-dsh-plugin#8683 已更新到 v0.3.5，等待维护者合并
- desktop profile 已从 npm 安装 0.3.5；需重启 DSH 生效

## Unreleased — long-task active-tool exemption

- `tool/call` / `tool/result` now feed distinct `tool-start` / `tool-end` progress events.
- Run budget tracks in-flight tool calls: while at least one is active, the no-progress
  stop is suspended and an expired deadline is rolled forward (bounded by the overall cap).
  A silent shell/build/download therefore no longer looks like a dead provider stream.
- E2E in an isolated profile with a deliberately tiny policy (5s no-progress floor, 10s
  bootstrap): a real `sleep 20` tool completed in 25s instead of being killed; the 3s
  control run stopped before the tool started.
- Test: `activeToolExemptsNoProgress` boundary + full **542/542**; core tsc/build OK.
- 已发布：npm bundle **0.3.5** / core **0.3.4**；GitHub Release `v0.3.5`；市场 PR #8683 已更新。

## 0.3.4 — 论文驱动优化：稳定性、记忆、协作与 UI

本版把论文库扫描后的 P0/P1/P2 机制全部落地，并完成真实任务测试：

- **稳定性/完成质量**：finish_task 证据门、Prompt 契约 v4、上下文角色隔离 + 压缩安全 pin、
  workspace/身份/记忆隔离。
- **可观测/安全**：RunEvidence + 失败归因、审批–执行绑定、按段上下文成本、失败时灰色诊断；
  设置里的运行诊断已移除，改为失败时就地显示原因。
- **任务板/记忆**：任务板 schema + 角色写契约 + 乐观锁事务；记忆质量标签/三态/投毒治理；
  一张可编辑的「群经验卡」。
- **协作**：意图订阅 + 声誉观察、目标注意力、文件优先 handoff、结构化弃权、引用回复/线程、
  历史先验/难度预算、路由确定性短路。
- **UI**：成员只显示本群、显式添加/移除成员、群经验卡编辑、引用回复、contextSections 诊断移除。

包版本：bundle **0.3.4**、core **0.3.3**、tools **0.3.2**、ui **0.3.9**。
真实任务测试（隔离实例）：leader 文件证据门 passed、群经验卡自动生成、真实文件 handoff 成功；
全量测试 541/541。

### 发布状态（2026-10-22）

- npm：core **0.3.3**、tools **0.3.2**、ui **0.3.9**、bundle **0.3.4** 均已发布，bundle latest 已指向 0.3.4
- GitHub Release：`v0.3.4`，附带同一 tarball（sha256 404dfef8…）
- 插件市场：PR [awesome-dsh-plugin#8683](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8683) 已提交，等待维护者合并
- npm 依赖解析已验证：bundle 0.3.4 → core 0.3.3 / tools 0.3.2 / ui 0.3.9

## Unreleased — diagnose completed-but-empty turns

- 运行诊断补充一种情况：`status=completed` 且 `finishPath=empty`（用户收到空回复）也视为问题，
  在会话里写灰色「诊断：本轮没有产生任何回复（模型输出为空）…」；正常 completed/reply 不触发。
- internal 协调 turn 的空输出跳过，避免把内部编排噪声写进房间。
- `tests/run-diagnosis` 增加空完成/正常完成边界；全量 **541/541**。
## Unreleased — group settings: remove members

- 群成员行增加「移除」按钮；点击后行内二次确认「确认移除 / 取消」。
- 移除走现有安全 RPC `removeBots`（服务端会取消该成员运行、清理会话、必要时移交 leader/解散空群），
  而不是直接改 memberIds；成功后本地成员列表即时更新。
- 群聊至少保留一名成员：只剩一人时移除按钮禁用并提示。
- 新增 core `RemoveBotsRequest` 类型 + UI remote/descriptor；UI tsc/tsdown/wrap、check-build OK；
  全量 540/540；隔离实例实测移除「小钱」后 memberIds 6→5。
## Unreleased — group settings: current members + add-member picker

- 群聊设置的「成员」只列出**当前本群成员**（名称），不再把所有 Bot 都列成可勾选列表。
- 新增「添加成员」按钮：展开后只显示**不在本群的 Bot**，可单选/多选；「确认添加」立即调用
  updateRoom 把所选成员加入群聊，并在面板内即时更新成员列表；无需再点主保存。
- 主保存只负责群名/仅 @ 响应/暂停等设置；已加入成员不会因取消对话框回滚（添加是即时操作）。
- UI tsc/tsdown/wrap、check-build OK；全量 540/540；无 core/后端/Bot 改动。
## Unreleased — one editable group-experience card

- 将「群经验卡」从多张自动卡列表改为**一张可编辑卡**：设置里一个 textarea +「保存经验卡」。
- 后端 `RoomExperienceCard { text, updatedAt, source:'auto'|'user' }`：
  * 已验证完成的任务会自动用 active pattern 组成卡文本（source=auto）；
  * 用户保存后 source=user，后续自动提炼**不再覆盖**；清空文本会清除该卡并抑制旧 pattern fallback；
  * prompt 的 `[本群经验卡]` 优先使用这张卡，旧 `patternCards` 仅在无 experienceCard 时兼容回退。
- 新增 RPC `updateRoomExperience`（REMOTE_METHODS allowlist + UI remote + descriptor）；保存实时持久化，
  已实测 state 落 `{source:'user'}`。
- `HARNESS_REVISION=paper-batch8-2026-10-22`；`PROMPT_CONTRACT_VERSION` 保持 4（标题未变）。
- 测试：compose/render 单卡 2 例 + 全量 **540/540**；core/UI tsc、build、check-build OK。
- 未发布 npm / 未更新市场。
## Unreleased — rename to “群经验卡” + user management

- 群聊设置里的「群协作模式」更名为 **「群经验卡」**；prompt 注入标题同步为 `[本群经验卡]`。
  说明文案改为「完成群任务后从最终汇报提炼，只影响本群；只有已启用的卡会进入 Bot 上下文」。
- 新增卡片状态：verified finish → `active`；bypassed finish → `pending`。只有 active 进入 prompt，
  pending 显示「待确认」并需用户点「启用」；所有卡都可「删除」。
- 新增 RPC `deleteRoomPattern` / `confirmRoomPattern`（REMOTE_METHODS allowlist、UI remote、
  设置面板本地更新）；每个操作一次房间 state 更新。
- `PROMPT_CONTRACT_VERSION=4`（标题文案变更）、`HARNESS_REVISION=paper-batch7-2026-10-22`。
- 测试：group-patterns pending 过滤 + 全量 **538/538**；core/UI tsc、tsdown/wrap、check-build OK；
  隔离实例验证启用/删除会真实持久化。
- 未发布 npm / 未更新市场。
## Unreleased — failure diagnosis moves from settings into the conversation

- 群聊设置删除「运行诊断」整块（不再展示最近 run 状态/上下文分段占比）；设置里保留群协作模式、
  协作遵从度和成员列表。
- 新增 `run-diagnosis.ts`：仅在 run 真正出问题时生成一行灰色普通 notice，正文固定前缀「诊断：」，
  包含原因（模型侧/框架侧超时/无进展/工具/记忆/房间目标/未归因）+ 截断后的 error 摘要 +
  最大上下文段（如「记忆 911 字（10%）」）；不含建议复盘/审计/目标可能偏移等彩色标签词。
- settle 后由 `maybeDiagnoseRun` 写 notice：completed/interrupted/stopped/cancelled 不触发；
  每个 runId 只写一次；不 retry/不暂停/不改任务。原选择性审计 notice 调用移除（模块保留未用）。
- 新增 `tests/run-diagnosis.test.ts` 13 例；全量 **537/537**；core/UI tsc、build 通过。
## Unreleased — UI fix: member rows show only the bot name

- 群聊设置的成员列表不再渲染头像 emoji 与 Bot 描述，只保留复选框 + Bot 名称；成员选择/保存逻辑不变。
- UI tsc/tsdown/wrap 通过；无 core/后端/Bot 改动。
## Unreleased — P2 batch (all remaining P2 mechanisms)

只改插件源码/测试；不改 Bot。

### OP-18 意图订阅 + 声誉看门狗（active）
- `BotIdentity` / Create/Update 请求增加 `subscriptions?`（归一化 ≤20 条、每条 ≤40）。
- 路由新增 `subscription` 分支：direct/@all/@mention/管理指令优先，其次按订阅词命中（最多 2 个），
  再回落原 lexical/leader；无订阅时行为不变。
- `reputation.ts` 从房间任务板统计 bot 完成率；`ReputationWatchdog` 在 finish 成功/bypassed 后每房
  10 分钟最多一条「声誉观察…建议换人或补上下文」notice；不自动换人。

### OP-19 目标感知注意力（active）
- `goal-attention.ts` 按目标关键词/bigram 排序成员汇报；`group-task.integratePrompt` 只调整
  汇总 prompt 中 reports 顺序（失败报告仍在前、不丢），无 goal 时逐字不变。

### OP-22 文件优先 handoff（active）
- 新增安全 `planFileHandoff`/`copyHandoffFile`：源文件必须在发送方 workspace（realpath 前缀检查，
  防 `../`/symlink 逃逸）、普通文件非空 ≤32MB；目标 `<target>/handoffs/<UTC时间戳>-<安全名>`；
  只复制不移动。
- 新工具 `agent_community_handoff_file`（群聊）：按本房成员名字交接，成功后给目标发内部消息 +
  房间 notice；非事务（copy 成功、通知失败会保留副本）。

### OP-17 并行竞标策略（opt-in，未接线）
- `bidding.ts` 纯策略：仅 complex + ambiguity≥0.6 + ≥2 成员 + 显式预算才 eligible；
  bid score/tie/预算函数；默认不执行任何 run，需调用方显式开启。

### OP-20 身份/记忆 bundle（模块，未接线）
- `identity-bundle.ts` 白名单导出 bot 身份/记忆/skill/pattern，脱敏密钥与绝对路径；validate/
  import draft/mergeMemory；不含 bot/room/session id，不写文件/RPC。

### OP-21 配置准入（模块，未接线）
- `config-admission.ts` 9 条边界规则，一次收集 issues；未知 key warning；`admitConfigOrThrow`；
  未接入现有构造，避免历史配置变 outage。

### OP-23 过程评测
- `tests/process-eval.test.ts`：6 个多轮剧本（改需求/成员失败/权限试探/记忆冲突/交付返工/
  压缩），15 个断言含 S4 谎报成功、S14 重复交付/摘要回归；纯事件、无模型。

### 验证
- `node --test tests/*.test.ts`：**524/524**；core/UI typecheck 过滤宿主噪声 0 真实错误；
  四包构建 + check-build OK；隔离实例 run 记录
  `harnessRevision=paper-batch6-2026-10-22 / promptContract=3`，插件正常加载。
- 未发布 npm / 未更新市场；只同步 GitHub 源码。
## Unreleased — P2 adherence scorecard

- 新增 `adherence.ts`：从持久化任务板派生 `TaskAdherence`（assigned/done/failed/pending、
  coverage、verifiedFinish、bypassed、evidenceCount、0–100 score、issues）；只统计
  `status=done` 为完成（`reported` 仍是待验收），bypassed finish 扣分并列入 issues。
- `RoomTaskState.adherence` additive 字段；`toRoomTaskState` 每次保存时由板派生，不信任写入方自述。
- UI「群聊设置」新增只读「协作遵从度」：score、完成数/总数、证据门状态、未完成/未验证原因。
- `tests/adherence.test.ts` 4 例；全量 **428/428**；core/UI typecheck、构建/check-build OK。
- 未发布 npm / 未更新市场。
## Unreleased — UI display layer (patterns, threads, context cost, audit notices)

只改 UI 包；不改 core/后端/Bot。

- **群协作模式**：`RoomSettingsDialog` 只读展示 `room.patternCards`（task/做法/注意/证据/时间），
  空态「暂无」；数据来自 snapshot，不新增 RPC。
- **运行诊断**：设置对话框只读展示最近 ≤3 次 run 的 status/finishPath/faultSide/
  promptTokensEstimate，以及 `contextSections` 横向条（区段/字符数/占比）。
- **线程/引用回复**：user 与 bot 消息动作行新增「回复」；ComposerArea 显示「正在回复…」横幅；
  sendMessage 透传 `replyTo/threadId/taskId`；消息上方渲染引用条 + thread 徽标（一层，无嵌套）。
- **notice 样式**：dispatch 行按文本分类为「完成门 / 目标 / 审计」，加轻量标签与描边；
  普通 notice 不变，文字不改。
- `tests/thread-view.test.ts` 13 例（snippet/标签/notice 分类/context 排序）；全量 **424/424**；
  UI tsc（过滤宿主噪声）0 真实错误；tsdown + wrap、check-build OK。
- 未发布 npm / 未更新市场；只同步 GitHub 源码。
## Unreleased — P1 batch B (OP-10 routing cost, OP-11 priors/budget, OP-15 section cost, OP-16 selective audit)

P1 机制批次 B；只改插件源码/测试，不改 Bot。

### OP-10 · 路由/审稿降本
- 新增 `proposal-policy.ts`：短名单恰 2 人、含 source bot、另一候选 fit≥2、任务 simple 时
  **跳过 group-proposal 模型判断**，用确定性选人（reason「按能力匹配确定性选人，省去一次模型判断」）；
  其余模糊/低分/多人情况仍走原模型路径。
- `validateConsultDecision` 抽出统一校验（成员在短名单、leader 合法、≥2 人、去重/封顶），
  模型结果与确定性结果共用。

### OP-11 · 历史协作先验 + 难度预算
- 新增 `collaboration-priors.ts`：任务难度 simple/standard/complex；roster budget 2/3/4；
  从各房间 taskState.assignments 统计 bot done/failed 成功率（≥2 样本）；只在 fit score 近似时
  用成功率做 tie-break，不压过能力匹配。
- group-flow 用 `Math.min(MAX_PROPOSED_MEMBERS, rosterBudget(...))` 限制候选宽度；无历史/无先验
  时行为不变；用户显式 memberIds 不受影响。

### OP-15 · 按段成本归因
- 新增 `context-cost.ts`：按 prompt-contract 段名统计字符数/占比（code point，CJK/emoji 准确），
  `estimateTokens` 明确是 chars/1.5 粗略上界，不用于预算决策。
- `runs.composePrompt` 返回 `{prompt, sections}`，`buildPrompt` 保持字符串兼容；RunEvidence 增加
  `contextSections`/`promptTokensEstimate`（只存数字，不存正文）；snapshot-lite 白名单透传。
- 隔离实例实测：`role=8127 / memory=911 / history=226 / goal=62 / input=31` 字符，
  estimate≈6238；定位到 role 是当前最大上下文成本项。

### OP-16 · 选择性审计
- 新增 `handoff-audit.ts`：对 failed/unknown/harness/empty/tool 失败等按权重排序采样（同房/同类去重、
  limit 5），只输出 runId/roomId/reason 等封闭字段，绝不带 prompt/reasoning/tool 正文。
- settle 后仅终态 failed 或 faultSide=unknown 触发；同房 10 分钟最多一条可见 notice
  「建议复盘…仅提醒：不会自动重试，也不会自动修改代码」；不做 retry/暂停/改代码。

### 验证
- `node --test tests/*.test.ts`：**411/411**；core/UI typecheck 过滤宿主噪声 0 真实错误；
  四包构建 + check-build OK。
- prompt 字节未变，`PROMPT_CONTRACT_VERSION=3`/`HARNESS_REVISION=paper-batch5` 保持不变。
- 未发布 npm / 未更新市场；只同步 GitHub 源码。
## Unreleased — P1 batch A (OP-09 patterns, OP-12 abstention, OP-13 drift, OP-14 threads)

P1 机制批次 A；只改插件源码/测试，不改 Bot。

### OP-09 · 群记忆模式卡
- 新增 `group-patterns.ts`：从 finish report 确定性提炼「任务→做法/坑/证据」，不调模型；
  去重、每房 ≤20 卡、prompt 只渲染最近 3 条。
- finish_task 成功（passed/bypassed）后写 `room.patternCards`（房间隔离）；新增
  `roomPatternsBlock`，prompt contract v3 新增 `patterns` 段（constraints 后、memory 前）。

### OP-12 · 结构化弃权
- 新增 `abstention.ts` + `agent_community_abstain` 工具（所有房间）：reason 必填、缺项 ≤5、
  建议 owner；服务写可见 notice，**不写 memory/prompt、不结束任务**。

### OP-13 · Goal drift 看门狗
- 新增 `goal-drift.ts` 确定性检测（关键词覆盖 + 偏题短语）；active goal 房间在 completed run
  后写「目标可能偏移」notice（10 分钟节流），**只提醒、不自动暂停**。

### OP-14 · 群聊结构化交互
- BotMessage / SendRoomMessageRequest 新增 `replyTo/threadId/taskId`；sendMessage 校验 replyTo
  必须在本房间，thread/task 标签 >80 丢弃；消息与 ledger 重建路径透传。

### 版本与验证
- `PROMPT_CONTRACT_VERSION=3`（patterns 段）；`HARNESS_REVISION=paper-batch5-2026-10-22`。
- `node --test tests/*.test.ts`：**359/359**；typecheck/四包构建/check-build OK。
- 未发布 npm / 未更新市场；只同步 GitHub 源码。
## Unreleased — paper batch 4 (OP-07 task-board contract, OP-08 memory lifecycle)

论文第四批机制改进；只改插件源码/测试，不改 Bot。

### OP-07 · 任务板 schema + 角色写契约 + 事务
- 新增 `task-board.ts`：`TASK_BOARD_SCHEMA_VERSION=1`；`TaskBoardActor`（leader/member/system/user）；
  操作 assign/report/advance/finish/fail；`TaskBoardContext`（actor、actorBotId、memberIds、
  expectedVersion、now）。
- `validateTaskBoard` 校验结构、唯一 id、合法状态、finished 形状、版本兼容；`applyTaskBoardOperation`
  统一执行「schema → expectedVersion → finished → 角色/成员权限 → 状态机 → version+1/updatedAt →
  events」；`applyTaskBoardTransaction` 多操作全有或全无。
- 角色契约：assign/advance/finish/fail 仅 leader/system；report 仅本人或 leader/system；member
  不能改别人的行/改 owner；user 不能直写内部板；done/cancelled 终态，reported 不能回 working。
- `group-flow.ts` 四个写方法改为构造操作 → 事务 → 一次 `saveRoom`；`RoomTaskState` 增加
  `schemaVersion/version/updatedAt`（additive）；旧板按 v1 兼容，未来版本拒绝。
- 新增 `tests/task-board.test.ts`（25）。

### OP-08 · 记忆质量标签 + 三态更新 + 投毒治理
- `BotMemoryEntry` 增加 `source/status/outcome/confidence/updatedAt`（additive）。
- 新增 `memory-lifecycle.ts`：来源映射（user→run/active/positive；a2a/routine→probation；
  note→active 但永不晋升）、`isInjectable`（只有 active 进主 prompt）、`promotable`
  （task + runId + active + positive + source=run）、`decayForCorrections`（用户纠正后只衰减
  最近窗口内同任务家族的 active 条目）、`bumpMaintain`（预留，不接线）。
- 记忆文件格式扩展 `source/status/outcome/confidence`，旧行兼容（旧 run-backed task 仍按
  active/positive 读取，不破坏老装机晋升）；stable id 不变；probation/decayed 不注入主 prompt，
  但 `recall` 仍可检索并标注。
- `rememberTask` 写入前先做纠正衰减（有变化则 `writePartition` 重写并刷新 mirror），再追加带
  provenance 的新任务行，再走晋升 gate；`rememberForSession` 的 note 带 note metadata。
- 新增 `tests/memory-lifecycle.test.ts`（17）。

### 版本与验证
- `HARNESS_REVISION` 升为 `paper-batch4-2026-10-22`（`PROMPT_CONTRACT_VERSION` 仍为 2）。
- `node --test tests/*.test.ts`：**316/316**；core/UI typecheck（过滤宿主噪声）0 真实错误；
  四包构建 + check-build OK。
- 隔离实例实跑：run 证据/批次正常；记忆文件新行带
  `source=run status=active outcome=positive confidence=0.7`，旧行仍可解析。
- 未发布 npm / 未更新市场；只同步 GitHub 源码。
## Unreleased — paper batch 3 (OP-04 run evidence, OP-06 approval binding)

论文第三批机制改进；只改插件源码/测试，不改 Bot。

### OP-04 · 每个 run 的可度量证据与失败归因
- 新增 `RunEvidence`（可选字段，全部是计数/枚举，不存任何 prompt/reasoning/tool 正文）：
  `durationMs / promptChars / toolCalls / toolFailures / deliverableCount /
  contextWindowMessages / approvalRequests / usage / finishPath / faultSide`。
- `finishPath` 封闭词表：`finish_task / reply / empty / stopped / timeout / no-progress /
  failed / unknown`；`faultSide`：`model / harness / tool / memory / room-goal / user / unknown`。
- `run-evidence.ts` 提供确定性归因：timeout/no-progress/lease-lost→harness；用户停止→user；
  tool/sandbox/permission/approval→tool；memory/context/compact→memory；
  room/goal/leader/stall→room-goal；transport/network/5xx/rate-limit/provider→model；否则 unknown。
- executor 在成功/停止/异常/预算失败 settle 时传 evidence；service `finalizeRunEvidence` 合并
  duration、真正 finishPath（`pendingFinishReports` 命中 = `finish_task`）与 faultSide，落
  `BotRun.evidence`/`faultSide`；retry 策略未改。
- `snapshot-lite` 只保留白名单字段（无正文/无未知 key）；新增 21 个测试。

### OP-06 · 审批–执行绑定（pre-execute 捕获 + 审批后 guard）
- 宿主 `approval/request` 只有 toolName/callId、没有 args；参数在 `tools/pre-execute` 的
  `exec.arguments` 上。bridge 现在：
  1. `tools/pre-execute`（prepend/global）按 callId 捕获 member 工具调用的冻结 args（sha256，
     200 条上限 + TTL），无条件 `next()`；
  2. `approval/request` 用捕获构造 `ApprovalBinding`（toolName/argsHash/expiry=10min/once），
     ledger approval 行记录 `argsHash / binding / expiresAt`；
  3. `allowed-once` 先存 one-shot token 再 resolve；`ctx.tools.guard()`（审批后、执行前）校验
     callId/toolName/argsHash/过期，通过即消费，不匹配也消费并拒绝；**无 token 的正常调用不拦截**。
- `args-unavailable` 降级：捕获缺失时只校验 toolName/expiry，不误杀正常审批。
- 新增 23 个测试（hash 稳定性、TTL、四类拒绝、一次性消费、fake-host 端到端、无 guard 降级）。

### 版本与验证
- `HARNESS_REVISION` 升为 `paper-batch3-2026-10-22`（`PROMPT_CONTRACT_VERSION` 仍为 2）。
- `node --test tests/*.test.ts`：**274/274**；core/UI typecheck（过滤宿主噪声）0 真实错误；
  四包构建 + check-build OK。
- 隔离实例实跑：run.evidence 落 `durationMs/promptChars/toolCalls/toolFailures/
  deliverableCount/finishPath='reply'`，harness 批次为 `paper-batch3-2026-10-22`；普通 run 未被
  approval guard 误拦。
- 未发布 npm / 未更新市场；只同步 GitHub 源码。
## Unreleased — paper batch 2 (OP-02 finish gate, OP-03 context isolation/pin)

论文第二批机制改进；只改插件源码/测试，不改 Bot。

### OP-02 · 完成门 + 证据门控交付
- `finish_task` 改为 **EVIDENCE-GATED**：`report` 与 `evidence` 都必填；evidence 1–8 条，
  三种可校验证据：
  * `file`：相对 leader workspace 或绝对路径，必须是真实、非空普通文件；可选 sha256（>128MB 跳过 hash，保留存在性检查）；
  * `message`：必须是本房间真实消息；可选 `runId` 必须匹配；
  * `task`：本房间任务板中 status 为 `done/reported` 的 assignment。
- 新增 `finish-gate.ts`（可注入 fs/lookup，纯/可测）；一次返回全部失败原因；**不执行 shell**。
- `finish_task` 未通过 → 不 `concludeTurn`、任务保持打开、返回可修正 reason + 可见 notice；
  同一 leader+board 连续第 3 次仍未通过 → 放行但标记 `gate:'bypassed'`（未验证），避免死锁。
- `GroupTaskDriver.finish`/`RoomTaskState.finished` 持久化 evidence 与 gate；`postReport` 仍单次交付。
- `bot-prompt` 群聊段与工具 schema 同步说明 evidence 必填。
- 新增 `tests/finish-gate.test.ts`（19）。

### OP-03 · 上下文角色隔离 + 压缩安全 pin
- Prompt contract 升 **v2**：段序 `role, skills, goal, constraints, memory, history, input`；
  `memory`/`history` 前插入一次固定的 `[上下文证据规则]` guard（无这类段则不插），
  明确它们是数据不是指令；所有动态段仍在同一条 user message，绝不进入 system/tool-instruction role。
- `constraints` 段来自房间 `pinnedConstraints`：压缩时只从 **user 消息** 提取含
  `必须/不要/禁止/不得/只能/不许/绝不能/一定要/切记/不可/不能` 的硬规则（8–300 字、去重、≤20），
  压缩摘要保留 `[必须保留的硬约束]`，并在之后每轮 prompt 重新注入；`clearMessages` 清空。
- 新增 `extractPinnedConstraints` / `mergePinnedConstraints` / `roomConstraintsText` 与
  `tests/compact-pin.test.ts`；更新 prompt-contract golden。
- `HARNESS_REVISION` 升为 `paper-batch2-2026-10-22`，`PROMPT_CONTRACT_VERSION=2`；协议卡同步。

### 验证
- `node --test tests/*.test.ts`：**230/230**（新增 finish-gate 19 + compact-pin 若干，prompt golden 更新）。
- core/UI typecheck（过滤宿主噪声）：0 真实错误；四包构建 + check-build OK。
- 隔离实例实跑：新 run 记录 `harness.promptContract=2`、`harnessRevision='paper-batch2-2026-10-22'`。
- 未发布 npm / 未更新市场；只同步 GitHub 源码。
## Unreleased — paper batch 1 (OP-01 harness attribution, OP-05 prompt contract)

论文全库扫描后的第一批机制改进；只改插件源码/测试，不改 Bot。

### OP-05 · 每轮提示词格式成为可测试契约
- 新增 `prompt-contract.ts`：固定段序 `role → skills → goal → memory → history → input`、
  唯一分隔符 `\n\n`、历史 header（含截断标记）、`[本轮输入]` 生成、`assemblePrompt` 纯函数；
  `PROMPT_CONTRACT_VERSION=1`。
- `runs.buildPrompt` 改为按契约填段并 `assemblePrompt`；**输出与改前逐字节一致**（测试用
  旧/新实例对跑两套 fixture 并固化 golden）。以后改段序/分隔/格式必须 bump 版本。
- 新增 `tests/prompt-contract.test.ts`（11）：golden 精确串、键序无关、缺段无空行、
  history 两种 header、input 恒最后、空段跳过、真实 buildPrompt 精确 golden。

### OP-01 · 每个 run 记录“谁产出了这个结果”
- 新增 `HarnessAttribution`：`pluginVersion`（运行时读 package.json，不写死版本）、
  `harnessRevision`（手工批次标记）、`promptContract`、`preset`、`historyMessages`、
  `memoryPromptEntries`；`BotRun.harness?` 在 `claimRun` 时写一次，重试沿用。
- `snapshot-lite` 保留 harness 六字段（不泄漏 prompt/reasoning/tool 输出）。
- 新增 `tests/harness-attribution.test.ts`（10）：字段/冻结/默认、真实 package.json 读取、
  注入 loader、unknown 回退、snapshot 保留且不泄漏重字段。
- 新增 `tests/PROTOCOL.md`：协议卡模板（model-dependent?/fixtures/窗口预算/权限/失败判据/
  重复次数/归因/运行命令）+ 2 个示例；`tests/README.md` 更新完整测试清单与协议卡纪律。

### 验证
- `node --test tests/*.test.ts`：**197/197**（既有 176 + 新增 21）。
- core/UI typecheck（过滤宿主噪声）：0 真实错误；四包构建 + check-build OK。
- 隔离实例实跑一条 run：`harness={pluginVersion:'0.3.2', harnessRevision:'paper-batch1-2026-10-22',
  promptContract:1, preset:'bot', historyMessages:10, memoryPromptEntries:8}` 已持久化。
- 未发布 npm / 未更新市场；只同步 GitHub 源码。
## Unreleased — stability batch 9 (UI follow-up from the real-instance retest)

用户复测提出的两个界面问题：

### 1. 删除会话顶部的运行状态条
- 移除 `RunStatusStrip`（「运行中 · 已用 Xs · 预计截止 HH:mm 剩余 …」）及其纯函数/测试；
  `ConversationArea` 恢复为两行 grid（GoalStrip + transcript）。会话里仍保留停止按钮和
  已有的运行/失败提示，不再常驻一条计时条。

### 2. 侧栏 Bot 状态不再永远是绿色「空闲」
- 根因：`snapshot().bots` 直接返回持久化的 BotIdentity，presence 字段从未被写；UI 对
  `undefined` 一律按"空闲/绿点"渲染，所以正在跑的 Bot 也不变。
- 修复：`snapshot()` 用同一次快照里的 runs 派生 `presence`（running > queued > idle），
  Bot 在跑时侧栏显示「运行中」+ 进行中圆点，结束后恢复「空闲」。规则仍集中在
  `getBotPresence`，不会与 run 状态出现第二套判断。

### 验证
- `node --test tests/*.test.ts`：**176/176**（移除 run-status 15 个用例）。
- core/UI typecheck 过滤宿主噪声：0 真实错误；四包构建 + check-build OK。
- 隔离实例实跑：小董执行 `sleep 8` 期间侧栏显示「运行中」，8 秒后回到「空闲」；
  会话顶部无「运行中 · 已用/预计截止」条。
- 真实 profile 已安装；需要重启 DSH 后生效。未发布 npm / 未更新市场。

## Unreleased — stability batch 8 (fixes found by end-to-end testing)

两个在隔离实例 + Playwright 真机验收中发现的问题（不是推断，是复现后修掉）：

### 压缩摘要落在"最旧"而不是折叠边界，面板首屏看不到
- 隔离实例压缩 61 条消息后，`compacted: true`、`foldedSeqs` 正确，但面板首屏没有摘要：
  checkpoint 的 `createdAt` 被设成最旧被替换消息，`seedLedgerRoom` 按时间排序后它落在第 0 行，
  而面板只加载最新 50 行，必须点「加载更早」才看得到。
- 新增 `checkpointCreatedAt(older, tail)`：把 checkpoint 放在**第一条保留消息前 1ms**
  （折叠边界），既保持顺序又落在最新页；摘要可见性在隔离实例重测通过（`HAS_SUMMARY true`，
  不需要「加载更早」）。补充了边界/无 tail 的纯函数测试。

### 模型建群提案默认 leader 不是源 Bot
- 实测提案对话里 leader 仍是模型偏好的成员（如小刘），而方案要求默认固定源 Bot、只在弹窗里
  由用户改。新增 `defaultProposalLeader(members, sourceBotId)`：模型驱动的提案一律默认源 Bot；
  Bot/用户的**显式** `propose_group`/`confirmGroup` 选择仍然优先（不破坏自主权）。
- 隔离实例重测：同一 DM 的新提案 leader 单选默认「小董」（源 Bot），members 仍可编辑。
- 新增能力层测试；全量 `node --test tests/*.test.ts` = **191/191**。

### 本轮端到端验收（隔离 profile + Playwright）
- 问题1 切换：连续点 4 个 DM + 快速三连点，选中立即生效且 6s 轮询不拉回 ✅
- 问题2 回复可见：工具回合结束后最终回复直接在首屏 ✅
- 问题3 自动运行：目标提议显示「自动续跑：关」，空闲 12s 无自动 run；点授权后显示
  「自动续跑 1/3」+ notice + routine run；暂停生效、goal paused ✅
- 问题4 建群：提案弹窗出现 9 个 Bot 可勾选、建议成员默认选中、可改 leader；取消一个成员后
  confirm 得到 3 人新群且 leader 与选择一致 ✅
- 问题5 群回复：成员回答可见，短群任务无重复回答；leader 集成重复由 191 个单测覆盖 ✅
- 停止：长任务点「停止生成」后 2s 内停止按钮消失、run 变 cancelled ✅
- 运行状态：显示「运行中 · 已用 Xs · 预计截止 HH:mm 剩余 …」，群任务预计 31m（自适应，
  不是固定 10m）✅
- 快照：真实隔离数据下 snapshot RPC **663,595 B**（改动前全量约 6MB 级）✅
- 压缩：修复后摘要行在首屏可见；`foldedSeqs` 61 条、keepLast 6 条 ✅

### 说明
- 只改插件源码，不改任何 Bot；本轮只同步 GitHub 源码并安装到本机 profile，未发布 npm、未更新市场。
## Unreleased — stability batch 7 (S13 snapshot/persistence + S14 compaction)

P2 收尾：快照与状态写瘦身、退出不丢写、压缩折叠与摘要进面板。只改插件源码，不改任何 Bot。

### S13 · 快照瘦身 / 持久化合并写
- `snapshot()` 的 `messages` 改为白名单轻量摘要：`{id, roomId, sender, text(240 code points), createdAt,
  sequence, mentions?}`；`runs` 只保留 UI 实际读取的字段，丢弃 `prompt`/lease/assignment/sessionId。
  用真实 state.json 只读回放（540 条消息 / 374 run）：messages+runs 快照 **6,091,762 B → 358,960 B
  （约 5.9%，17×）**；最重单条 227,424 B → 502 B。schema/version 不变。
- 持久化：`enqueueWrite` 改为 250ms 合并窗（窗内多次 mutation 只写一次）；`flushNow` 清 timer
  后立即写当前 state；dispose 监听改为 async，先 `await flushNow()` 再销毁 executor/timer；
  state 用紧凑 JSON 序列化（实测 6.51MB → 6.20MB）。删除路径（clear/delete）仍 await flush。
- UI 清理：`useRoomActions` 的未使用 `snapshotMessages` prop 与对应传参删除。

### S14 · 压缩折叠修复 / 摘要进面板
- **foldedIds 恒空修复**：`compactRoom` 改用 `foldedMessageIds(older)`（= `older.map(id)`），
  不再用 `createdAt < summary.createdAt` 比较（summary 的时间戳故意取最旧被替换消息，两条件
  永远不可能同时成立）。12 条 / keepLast=4 的窗口现在 = 4 条 tail + 摘要，旧 8 条不进 prompt。
- **摘要进面板**：summary 消息无 runId，原重建路径会按"协调消息"隐藏；现在
  `maintenance.seedLedgerRoom` 为 `kind:'summary'` 生成 `summarySeedItem`，
  `ledger.seedRoom` 用 `actor:'summary'` 渲染为灰色 `dispatch` 分隔行；`compactRoom` 成功后
  `clearRoom` + `seedLedgerRoom` 重建该房 ledger，原消息保留（压缩可找回），重复 seed 按
  summary id 去重。
- 注释明确插件 fold 与宿主 session compaction 的职责分工（插件只折房间 prompt 窗口，
  摘要行进面板；宿主压缩 bot 自己的 session）。
- 新增 `tests/compact-fold.test.ts`（8）、`tests/snapshot-lite.test.ts`（8）。

### 验证
- `node --test tests/*.test.ts`：**188/188 通过**。
- UI/core typecheck（过滤宿主缺失 d.ts 噪声）：0 真实错误；四包 tsdown + check-build = OK。
- 本轮只同步 GitHub 源码；未安装/未重启、未发布 npm、未更新插件市场。

## Unreleased — stability batch 6 (S10 + S11 + S12)

P1 收尾：消息源/游标/上下文治理、自动运行与运行状态 UI、宿主工具面/提示词/leader 收敛。
只改插件源码，不改任何 Bot。

### S10 · 消息源 / 游标 / 上下文 / 记忆
- `LedgerEntry` 新增必填 `changeSeq`：`push` / `patch` / `settleRunEntries` / `seedRoom` 每次写都递增；
  `listLedger` 新增 `changedAfterChangeSeq`（返回 changeSeq ≥ 游标的最新一页）。这修复了"回复行
  sequence 很小、settle 时被 patch，但 sequence 游标永远送不到终稿"的问题。
- UI 轮询改取窗口内 **MAX changeSeq**（缺省回退 sequence），同时带旧游标兜底；`ledgerWindow.merge`
  先比 changeSeq 再退 rev，按 id 去重，无变化返回同引用；running 时仍 force 重载兜底。
- `seedRoom` 合并 live 行后按 `at`（sequence 兜底）排序，修正 seed 新序号 + live 旧序号造成的
  数组序/首屏分页错位。
- 新增 `context-window.ts`：`buildHistoryWindow` 排除本轮用户消息（id 或最后一条同 prompt 的
  user 消息），单条截断 + UTF-8 字节预算（12KB），返回 included/omitted/truncated；
  `runs.buildPrompt` 改用它，用户输入不再在「最近 N 条」与「本轮输入」出现两次。
- `memory-store.parseRoomMemory` 的 id 改为 `${at}#FNV1a(kind\0text)`：写满 12 条后裁剪不再
  平移幸存 id，`renderMemoryDelta` 不再每轮退化 baseline；旧文件零迁移。
- 新增 `tests/ledger-cursor.test.ts`（8）、`tests/context-window.test.ts`（7）、
  `tests/memory-delta.test.ts`（6）。

### S11 · 自动续跑 / 运行状态 UI
- `GoalStrip` 顶部新增「自动续跑：开/关」摘要（待确认 / 已暂停 / 未授权 / 已用 x/y 轮）与开关：
  开 → pause，关 → authorize(3 轮)；与原有 允许/暂停/继续 按钮共用 handler + busy 守卫。
- 新增 `runStatusView.ts` + `RunStatusStrip.tsx`：显示本房间最新 run 的运行中已用时间/预计截止、
  `运行超时已停止`、`无进展已停止`、`已停止`、`运行失败`；completed 隐藏；30s tick。
- `ConversationArea` 改为 `auto auto minmax(0,1fr)` 三行，transcript 滚动不变。
- 新增 `tests/run-status.test.ts`（15）。

### S12 · 宿主工具面 / 提示词 / leader 收敛
- `AGENT_TEAMS_TOOLS` 增加宿主 `team_task_create/list/get/update/delete`，并新增
  `team_task_` 前缀拒绝；拒绝理由指向房间的 assign_task / dispatch / message_member /
  finish_task，模型不能再误用另一块任务板。
- `bot-prompt.ts` 群聊段统一口径：回答即产出，已回复不再补总结；成员过程用 message_member
  向 leader 汇报（内部不发布），成员最终产出照常可见；最终交付由 leader finish_task 一次性
  汇总，不重复已发布内容。`group-task.integratePrompt` 同步。
- 新增 `room-leader.ts`：`resolveRoomLeader`（team.leader 是现存成员则用之，否则 memberIds[0]）
  + `isRoomLeader`；`index.leaderOfRoom` / `ensureRoomSession` / `messageMember`、
  `group-flow.leaderIdOf/leaderBoard/remove` 全部走同一函数，无 team 的手工群也能正常
  advanceRound/finish_task/remove_bot。`handoffLeadership` 仍按持久 team.leader 判断并注释分工。
- `a2aMinIntervalMs` 确认无读取，标 @deprecated（保留解析兼容）。
- 新增 `tests/room-leader.test.ts`（6）、`tests/agent-tools.test.ts`（6）。

### 验证
- `node --test tests/*.test.ts`：**172/172 通过**。
- UI/core typecheck（过滤宿主缺失 d.ts 噪声）：0 真实错误；四包 tsdown + check-build = OK。
- 本轮只同步 GitHub 源码；未安装/未重启、未发布 npm、未更新插件市场。

## Unreleased — stability batch 5 (S8 adaptive task-time allowance)

修复"运行超时必须按实际任务时间配置，不能写死"（P1）。只改插件源码，不改任何 Bot。

### 自适应超时 ATA
- 新增 `run-budget.ts`（纯函数，无主机依赖）：
  * `taskClassOf`：user-task / goal-continuation / schedule / member-report / a2a / task-board；
  * `percentile` / `median` + `deriveDeadlineBudget`：按 (bot,origin,taskClass) ≥5 样本取 p95×1.5；
    不足则 origin ≥5；再不足用全量；仍不足用配置的 bootstrap（15min 冷启动，不再是写死
    10min），最后 clamp 到 `max(floor 180s, 3×median) .. cap 7200s`，返回来源与样本数；
  * `noProgressLimitMs`：noProgressFactor×实测进展间隔 p95，clamp 2min–30min；
  * `shouldExtend` / `nextExtensionDeadline`：有进展最多延长 2 次、每次 +50% 基础预算，
    受 cap 约束；无进展或次数用尽 → timed-out；
  * 重试策略：仅 provider/tool/lease-lost 可重试，退避 `backoff × 2^attempt`。
- `BotRun` 新增 `deadlineAt`/`lastProgressAt`/`progressEvents`/`extensions`/`failureKind`/
  `timeoutOverrideMs`（后半为后续面板入口预留；本批已支持覆盖）。
- `RunExecutor`：claim 后按历史为每个 run 派生 deadline 并持久化；`SessionRunner.run` 新增
  `onProgress`（宿主 stream/tool 事件）节流更新 lastProgressAt；tick 每 250ms 检查：
  * 静默超过 no-progress 窗口 → cancel agent + settle `failed/no-progress`（不重试）；
  * 到 deadline 且有进展 → 延长并写 ledger「运行时限延长 N/2」；
  * 到 deadline 且无进展/延长用尽 → cancel + settle `failed/timeout`（不重试）。
- 租约/心跳接线：`runLeaseMs` 真正被 claim/heartbeat 读取（heartbeat=lease/4），不再是死配置。
- 重试：`SettleBotRunRequest.failureKind` 写入 run；按 `runRetryPolicy` 写
  `nextRetryAt=now+backoff×2^attempt`，`pickQueued` 只在到期后取；claim 后清空旧 attempt 的
  预算/失败字段。
- `Config` 新增 `runTimeoutPolicy` / `runRetryPolicy`；`runTimeoutMs` 标为 deprecated（不再有
  运行时 600000 截止值）。`onRunTimedOut` 写房间 notice；若超时的是 `[继续目标]` 续跑轮，
  自动把 goal 置 paused，不再自动续跑。
- 新增 `tests/run-budget.test.ts`（20 个纯函数用例，含"源码不得出现 600000"守卫、
  真实历史 [82,261,317,606,1516,1931,5052]s → 预算 7200s > 5052s 且 ≠600000）。

### 验证
- 只读回放真实 state.json（370 条 completed）：固定 600000 会误杀 14 条；ATA 派生预算
  180s（goal 续跑）–2897s（长任务），0 条被 600s 误杀。
- `node --test tests/*.test.ts`：**124/124 通过**（新增 run-budget 20）。
- UI/core typecheck（过滤宿主噪声）：0 真实错误；四包 tsdown + check-build = OK。
- 本轮只同步 GitHub 源码；未安装/未重启、未发布 npm、未更新插件市场。

## Unreleased — stability batch 4 (S7 group-member selection)

修复用户问题 4：单聊 Bot 拉群协作时选中的 Bot 与本任务不适配。只改插件源码，不改任何 Bot。

### 选人闭环
- 新增 `capability.ts`：从 Bot 的 description、systemPrompt 的标题/职责/产出/边界段、
  skillProfile 技能名生成确定性能力卡（domains/deliverables/skills/boundaries，上限 20 项），
  不调用模型。
- `rankCandidates`：对任务文本做中英混合词命中打分（技能 ×3、描述/领域 ×2、边界 ×0.5），
  同分按 bot 名稳定排序，返回命中词用于解释；`shortlistFor` 保证源 Bot 必在短名单（≤4）。
- `group-flow.consultModel` 只从短名单里选，prompt 要求"members 2–4、leader 必须∈members、
  优先适配分高者、一 bot 能完成就不建群"，roster 带适配分/命中/领域/技能。
- 强校验：成员 ⊆ 短名单且 2–4、leader ∈ 成员；不合法/模型失败 → 确定性 fallback
  （短名单前 2–3、source Bot 为 leader）。`collaborate:false` 视为明确不建群，不 fallback。
- 修复旧提案跨消息复用：pending 提案仅同 `sourceMessageId` 可复用；新消息不再拿到旧任务的
  taskText。
- `ConfirmGroupRequest` 加 `leaderId`；`confirm` 按 用户选择 → 提案 leader → 成员[0] 校验。
- UI：`GroupProposalDialog` 成员区改为全部 Bot 可勾选（建议成员默认选中、标「建议」），
  选中成员中单选 leader；确认按钮按 `validateProposalSelection`（≥2 人、leader∈成员）禁用并
  显示原因；确认传用户编辑后的 `memberIds`/`leaderId`。
- 新增发送后触发门槛 `shouldConsiderGroup`（协作词 / ≥2 产出物 / ≥60 字），明显单句问候不再
  每次触发一次选人模型调用；Bot 自己 `propose_group` 的路径不受影响。
- 新增 `tests/capability-proposal.test.ts`（13）与 `tests/proposal-edit.test.ts`（18）。

### 验证
- `node --test tests/*.test.ts`：**104/104 通过**（selection 9 + ledger-window 9 + room-goal 27 +
  publish-policy 13 + session-runner-abort 2 + group-task 13 + capability-proposal 13 +
  proposal-edit 18）。
- UI/core typecheck（过滤宿主缺失 d.ts 噪声）：0 真实错误；四包 tsdown + check-build = OK。
- 本轮只同步 GitHub 源码；未安装/未重启、未发布 npm、未更新插件市场。

## Unreleased — stability batch 3 (S5 stop/interrupt + group orchestration)

修复"停止生成后模型仍继续跑"以及群编排的停摆/死循环问题；只改插件源码，不改任何 Bot。

### S5-A · 停止/中断链路
- `SessionRunner.cancel(roomId,botId)` 调到 live agent 的 `agent.cancel`，这是唯一能打断在途模型
  请求的调用；`cancelRoom()` 供删房扫尾。
- `SessionRunner.run(..., signal?)` 增可选 AbortSignal：注册 listener（finally 移除）、在
  ensureSlot/每轮 repair/followup/whenIdle 后检查；已中断返回 `stopped:true`，不 repair、不再排队。
  `ensureSlot` 可被中断提前返回，不再等满 10 分钟。
- `RunExecutor`：`callModelViaSession` 把 run 的 AbortSignal 传进 runner；`interruptRun` 改为
  abort controller + 真正 cancel agent；`abortRoom`/dispose 路径同样 cancel，并对非 controlRun
  的 abort 补一次 interrupted settle 兜底；删除从不填充的死 `agents` map。
- 新增 `tests/session-runner-abort.test.ts`（2 个用例）。

### S5-B · 群编排死锁/轮次/新任务
- `GroupTaskDriver.forgetMember()`：移除运行中成员时清 `runningBotIds`/该成员汇报，running
  assignment 标 failed；确有清理且无人运行时唤醒 leader 集成（internal）。修复"移除成员后
  leader 永不集成、整组静默停摆"。
- 新增 `stop()`（写 finished、清 running/pending，之后不再集成）、`adoptRound()`（把
  `groupFlow.advanceRound` 的板值镜像回 driver，防止下一次保存回滚预算）、`isFinished()`。
- `sendMessage` 群消息 hook：新用户指令 `beginTask` + `beginRound`（每条指令一份轮次预算）；
  `afterRunSettled` 的 leader 回合接 `advanceRound`（maxRounds 生效）与 `onLeaderIdle`
  （连续 3 轮无进展 → notice + stop）。
- `removeBots` 在 cleanup 后逐 bot `forgetMember`；修复 `integratePrompt` 先清汇报再入队导致
  入队失败丢汇报的问题。
- 新增 `tests/group-task.test.ts`（13 个用例，fake accessor 覆盖集成/移除/stall/轮次）。

### 验证
- `node --test tests/*.test.ts`：**73/73 通过**（selection 9 + ledger-window 9 + room-goal 27 +
  publish-policy 13 + session-runner-abort 2 + group-task 13）。
- UI/core typecheck（过滤宿主缺失 d.ts 噪声）：0 真实错误；四包 tsdown + check-build = OK。
- 本轮只同步 GitHub 源码；未安装/未重启、未发布 npm、未更新插件市场。

## Unreleased — stability batch 2 (S3 auto-run authorization, S4 publish policy)

修复用户反馈的问题 3（Bot 单聊没收到消息却自己启动）与问题 5（群聊仍重复回答）；
只改插件源码，不改任何 Bot；自动运行默认关、成员回答继续可见（用户决策）。

### S3 · 自动运行授权闸门
- `RoomGoal` 新增 `proposed` 状态与 `authorization`（仅用户可写）。Bot 的
  `agent_community_goal set/resume` 只产生「目标建议」，用户确认并授权后才可能自动续跑；
  Bot 更新目标文本不得重置预算。
- 新增用户 RPC `authorizeRoomGoal` / `pauseRoomGoal` / `resumeRoomGoal` + 面板
  `GoalStrip`（目标建议 / 允许自动续跑 3 轮 / 暂停 / 继续）。授权时若房间空闲，立即
  起跑第 1 轮并计入预算；有运行中的回合则等其结算后续跑；暂停房间只授权不起跑。
- `afterRunSettled` 的续跑改为「用户授权 + 未达轮次上限 + 有工具进展」三重判定；
  达上限/无授权/授权过期 → 目标暂停并写可见 notice；没有授权的 goal 绝不 queue run。
- 房间 `paused` 现在挡住所有 run 创建来源（用户消息之外也挡定时/续跑/a2a/群派工）。
- 插件注入的 `bots:goal` 提示词同步新语义（Bot 不得声称"系统会自动排下一轮"）。
- 新增 `tests/room-goal.test.ts`（27 个纯函数用例，含"每轮更新文本仍只跑 3 轮"的事故回放）。

### S4 · 发布口径与去重（成员产出继续可见）
- 新增 `publish-policy.ts`：`visible` run 发布自身回答；`internal` run（leader 的集成/
  汇总回合）不发布正文；`finish_task` 的 report 作为该 run 的唯一交付，不再额外推一条
  无 runId 的 ledger 行。
- `settleRun` 统一交付：一次 run 最多一条消息；可见正文优先、无正文时用 report；
  按 runId 幂等；internal 交付补一条带 runId/用时的 bot-text，重启前后一致。
- `ledger-projection` 真正接上发布口径：internal run 的流式行、assistant/tool committed
  行都不渲染；`INTERNAL_RUN_ORIGINS` 从死常量变为实际使用的 fallback。
- `group-task`：leader 集成回合 `internal:true`，被 leader 指派的成员回合 `visible`
  （用户要求成员产出继续可见）；a2a / 用户 run 保持 visible。
- `routing`：角色关键词平票不再唤醒多个 bot；leader 在平票中则只唤醒 leader，否则取首个
  命中。显式 @all/集合词/写出多个名字/问候仍按原规则。
- 新增 `tests/publish-policy.test.ts`（13 个纯函数用例）。

### 验证
- `node --test tests/*.test.ts`：**58/58 通过**（selection 9 + ledger-window 9 +
  room-goal 27 + publish-policy 13）。
- UI/core typecheck（过滤宿主缺失 d.ts 噪声）：0 真实错误。
- 四包 `tsdown --no-dts` 构建通过；`node scripts/check-build.mjs --allow-dirty` = OK。
- 本轮只同步 GitHub 源码；未发布 npm、未更新插件市场（等用户通知）。

## Unreleased — stability batch 1 (S1 selection arbitration, S2 reply visibility)

修复用户反馈的两个稳定性问题；只改插件源码，不改任何 Bot。

### S1 · 点击其他 Bot 单聊后会话不切换（需多次点击）
- 轮询不再把"发起请求那一刻的 selectedId"当 `preferId` 回写；选择决策抽到纯函数
  `community/selection.ts`：无 `preferId` 时只修复"房间已消失"，有 `preferId` 时只有
  "请求晚于用户最后一次点击"才生效。
- `load()` 增加请求世代与用户选择时间戳；旧响应不再覆盖新快照/新选择/新错误。
- `onReload` 拆成"纯刷新"（无参数）：发送/改模型/权限/压缩/fork 后的刷新不再把选择拉回旧房间；
  fork 仍通过 `onOpenBotRoom` 落到新房间。
- 新增 `tests/selection.test.ts`（9 个用例，纯函数）。

### S2 · Bot 最终回复被隐藏，只有点"加载更早"才出现
- 面板首屏/结算后按"缺失回答的 run"用 `beforeSequence` 向前补读（最多 8 页），不再要求用户
  手动点「加载更早」；`ledgerWindow.ts` 抽出 merge/missing/backfill 纯函数。
- `ledger.ts` 的 `changedAfterSequence` / `afterSequence` 改为返回**最新一页**，重播/重编号超过
  limit 时最新 settle 回复也能送达。
- merge 按 id + `rev`，同 id 不再重复/回退；「加载更早」去重并统一按 `(at, sequence)` 排序。
- 回合有过程行但没有回答行时，显示"回复不在已加载历史中"提示（兜底）。
- 新增 `tests/ledger-window.test.ts`（9 个用例，纯函数）。

### 验证
- `node --test tests/*.test.ts`：18/18 通过。
- UI typecheck（过滤宿主缺失 d.ts 噪声 `TS2307/7016/7006`）：0 真实错误；core 改动文件
  `ledger.ts` 0 错误（core 其余错误是未安装 `@deepseek-ai/*` 的既有级联，与本次改动无关）。
- 本轮只同步 GitHub 源码；未发布 npm、未更新插件市场（等用户通知）。

## 0.3.3 — 未读角标：按未读回复计数，不再把多条折成 1

修复用户报告：**Bot 单聊 / 群聊里明明有很多条未读消息，未读角标却只显示 1 条**。

### 修复
- 未读计数从「同一 speaker + 同一 turn 折叠」改为 **「每次 Bot 运行（run）算一条未读」**。
  定时任务（`botSchedules`）连续运行产生的多条回复之间没有用户消息，过去被判成同一个 turn 折成 1；
  现在 4 次运行就显示 4（用户真实数据即此场景）。
- 保留过去两条防重复规则：同一回合里同一 Bot 的 `agent_community_post_message` 附加消息不重复计数
  （3 个 Bot 各答 1 条 + 1 条附加消息仍显示 3）；一次 run 写了多行也只算 1。无 `runId` 的历史消息
  退回每 `(speaker, turn)` 一条。
- 改动只在宿主侧 `unread.ts` 纯函数；面板显示逻辑不变。

### 验证
隔离 `$DSH_HOME` + 无头 Chrome 修复前后对照：0.3.2 上「4 条不同 run 的未读」显示 **1**（复现）；
0.3.3 显示 **4**；「3 bots + 1 条 post_message」仍是 **3**；单 run = 1；纯 post_message 多条同回合 = 1；
侧栏入口徽章 = 各房间之和；打开房间后清零（0.3.2 的「屏幕上的房间即已读」行为保持）；console/pageerror = 0。

### 发布说明
- 实际发布版本：core **0.3.2**（npm 已发布）、ui **0.3.8**、tools **0.3.1**，均已是 latest；bundle 的 GitHub Release
  **v0.3.3** 已发布、tarball 安装解析通过。npm 上的 bundle latest 仍是 **0.3.2**——它依赖 core `^0.3.1`，安装时会解析到
  core **0.3.2**，因此 `npm install dsh-plugin-agent-collaboration` 同样包含本版修复；bundle **0.3.3** 的 staged 版本
  待一次独立浏览器 2FA 批准后才会把 npm latest 更新到 0.3.3（纯版本元数据差异，不影响功能）。
- 客户端产物大小不变（3.32 MB / gzip 914 KB）；本版是宿主侧计数修复，**重启 DSH 才会生效**。

## 0.3.2 — 未读角标：在会话界面里就是已读

修复用户报告的未读角标问题：**明明停在某个 Bot 单聊 / 群聊的会话界面里，该房间的未读角标依然显示**，
必须切到别处再切回来（或点左侧房间）才消失。

### 修复
- **屏幕上看见的房间即已读。** 0.3.1 只有在用户"显式点击"房间时才推进已读水位；面板打开时自动选中的
  房间、以及用户已经停留的房间，都仍然显示旧角标。现在只要房间被显示在前台（自动选中或点击，规则相同），
  它已有的未读就会在几百毫秒内清零。
- **停留期间到达的新回复也立即计入已读。** 0.3.1 把"打开之后到达"的消息一律留在未读，指望用户切走再切回来
  才清零——这正是「我在会话界面里却一直显示未读」的主要来源。现在消息在当前可见房间到达时即推进水位；
  **只有窗口隐藏/最小化时到达的消息保持未读**，回到窗口后自动清零（计数在用户回来时仍然是准的）。
- 已有的防闪烁机制保持不变：每个 (房间, 时间点) 至多一次 `markRoomRead`、只在宿主确认覆盖全房间时才做本地
  删除；不为已读水位倒退或旧目标发请求。

### 验证
隔离 `$DSH_HOME` + 无头 Chrome 修复前后对照：0.3.1 上复现「自动选中房间角标常驻 / 停留时到达的回复不消」，
0.3.2 上两场景均在 ≤3s 内清零；未选中房间的未读角标仍正常显示；无请求风暴、无 console/pageerror。

### 发布说明
- npm 上实际发布的版本：bundle **0.3.2**、`ui-agent-community` **0.3.8**、`agent-community` 0.3.1、
  `tool-agent-community` 0.3.1（本版 core/tools 无改动）。`bundle@0.3.2` 依赖 `ui ^0.3.2`，由 0.3.8 满足；
  `npm install dsh-plugin-agent-collaboration@0.3.2` 的依赖解析已实测通过。
- **ui 为什么是 0.3.8 而不是 0.3.2**：npm 对「bypass-2FA token 发布较大包」会转入 staged 审批，且直发时会出现
  publish 打印成功但版本不可见、重发报 `409 Cannot publish over previously staged version` 的登记错误
  （[npm/cli#9889](https://github.com/npm/cli/issues/9889)）。0.3.2 起的多个直发版本被 npm 占用；最终用
  `npm stage publish` 暂存、在 npmjs.com 以 2FA 批准，发布为 **0.3.8**。功能内容与 0.3.2 构建完全一致
  （`client.js` 3,321,934 B / md5 `6630f17b…`），仅版本号不同。
- 客户端产物大小不变（仍是 3.32 MB / gzip 913 KB）。

## 0.3.1 — 面板内自绘预览：PDF / Word / Excel

交付卡片点击后，面板右侧栏现在用**真正的查看器**打开文件，而不是浏览器内嵌查看器或「不支持内嵌」提示：
PDF 由 PDF.js 自绘（翻页 / 缩放 / 适应宽度），`.docx` 由 docx-preview 直接渲染（分页、正文可选中、适应宽度），
`.xlsx` / `.csv` 由 SheetJS 渲染成可滚动的表格（多工作表、冻结表头、行/列上限）。PowerPoint 与旧版
`.doc` / `.xls` 仍由宿主转成 PDF，再交给同一个 PDF 查看器。

### 新增
- **PDF 查看器（pdfjs-dist 6.3.289）。** canvas 自绘 + 工具栏（上一页/下一页、页码跳转输入、缩放 −/+/百分比、
  适应宽度）；DPR 正确的背板尺寸；每个预览独占自己的 module Worker / loading task，切标签或卸载即取消渲染并终止。
  PDF.js 的 worker 源码在构建期内联进客户端单文件产物，运行时用 Blob URL 启动——DSH 的工作机制是「每个插件一个脚本、
  不读兄弟资源」，这是唯一可行的部署形态（也是本次唯一的硬阻塞，先用 POC 在无头 Chrome 验证后再落地）。
- **`.docx` 直读（docx-preview 0.3.7）。** 直接渲染分页 DOM（正文可选中复制）、页宽自适应 + 缩放；渲染后按白名单
  清理文档内链接（仅保留 http(s)/mailto，`javascript:` 等移除）；无显式页宽的文档补 A4 兜底，避免手搓文档缩成一团。
- **`.xlsx` / `.csv`（SheetJS 0.18.5）。** 多工作表标签、冻结表头与行号、固定行高虚拟滚动（20 万行 / 100 列上限，
  超出在状态栏提示）、列宽取自工作簿、日期/百分比/千分位按单元格格式显示、坏文件给中文错误态；CSV 与 xlsx 共用渲染。
- **宿主预览 RPC 扩展。** `readDeliverablePreview` 对 `.docx` / `.xlsx` 返回原始字节（≤8 MB，超出仍回 `binary` 让用户
  用本机应用打开），客户端因此能直接渲染；`renderDeliverableDocument` 保留给 PPT / 旧版 Office。
- **预览加载路径收敛。** 新增 `preview/load.ts` + `preview/PreviewContent.tsx`：一个地方决定「字节 / 文本 / 图片 /
  宿主转 PDF」，dock 只负责标签与加载态；卡片不再各自维护一份预览逻辑。

### 移除
- 交付卡里那条**不可达**的旧预览对话框（`DeliverablePreviewDialog` / `PreviewBody`）及其重复加载逻辑：右侧预览栏
  是唯一预览路径（该对话框的触发函数从未被调用，属于死代码）。

### 文档
- 新增 `THIRD_PARTY_NOTICES.md`：PDF.js / docx-preview / JSZip / SheetJS 的许可证、打包方式与已知限制。
- README（中英）：功能清单加入三个查看器，开发章节说明「查看器打进单文件浏览器产物」的原因与体积，tarball 链接
  更新到 v0.3.1；`ACCEPTANCE.zh-CN.md` 新增「面板内预览查看器」验收节。

### 发布说明
- 版本：bundle / core / ui 升到 **0.3.1**；`tool-agent-community` 本版无改动，保持 0.3.1 不重发。
- 客户端产物：`ui-agent-community/lib/client.js` 由 560 KB 变为 **3.32 MB**（gzip 168 KB → **913 KB**）。这是把三个
  查看器 + PDF worker 内联进单文件产物的代价；`accepted` 验收记录里含冷启动对比（面板首次打开仍在百毫秒级）。
- 验收：隔离 `$DSH_HOME` 实例 + 无头 Chrome 端到端 33/33（PDF canvas / docx 分页 / xlsx 冻结表头 / 其他类型回归），
  `console.error` 与 `pageerror` 均为 0；0.3.0 基线同环境对照留存。

## 0.3.0 — Bot 交付的文件卡片

Bot 现在可以把本轮产出的文件**交付给用户**：回复下方出现文件卡片，可在面板里预览、用本机关联应用打开、
在 Finder 中定位。卡片形态与 DSH 主会话的交付卡一致（每回合一组、内含多文件），但数据与打开链路完全在插件内，
不依赖 DSH 的 `present` 工具或 `deliverables/presented` 事件。

### 新增
- **`agent_community_deliver` 工具（第 15 个模型工具）。** `files: [{ path, description? }]`，1–8 个；相对路径按
  Bot 工作区解析，绝对路径可指向工作区之外；只接受已存在的普通文件（目录、最终符号链接、缺失路径会被拒绝）。
  校验语义与 DSH `present` 对齐，模型的使用习惯可以直接迁移。
- **交付卡片。** 每回合一张卡组、内含多文件；单文件一行、2–4 个两列网格、>4 折叠；卡片显示类型图标、文件名、
  说明（缺省回退扩展名大写）。点击卡片在面板内预览：Markdown/文本分页、图片内嵌、PDF 内嵌；Office/二进制只给
  「用应用打开」。回复下方渲染，计入空回合守卫（只有文件没有正文的回合不会消失）。
- **打开方式与定位。** 卡片右侧「打开 + 更多打开方式」split 按钮：默认应用、本机 LaunchServices 关联应用列表
  （默认项标「（默认）」）、底部「显示文件位置」（Finder 选中）。无桌面能力的主机自动隐藏该控件。
- **持久化。** 交付文件随 `BotMessage.deliverables` 落盘，重启后由 `seedLedgerRoom` 重建卡片；旧状态文件
  直接兼容（可选字段，不升 `state.version`）。
- **预览走插件自己的受限 RPC。** 只按 `(room, run, index)` 读取已声明的文件，客户端不能传任意路径；文本 ≤512 KB、
  图片/PDF ≤8 MB；Bot 会话 id 不下发到浏览器（保持账本红线）。

### 文档
- README（中英）工具数 14 → 15，并加入交付卡片说明；`ACCEPTANCE.zh-CN.md` 新增「八、文件交付卡」验收节，
  提示词段数同步为九段。

### 发布说明
- `@dsh-plugin-agent-community/tool-agent-community` 的 `0.3.0` 在 npm 一侧停在 staged 状态（既不能覆盖也不能
  删除），因此该组件以 **0.3.1** 发布；bundle 的依赖是 `^0.3.0`，安装时会自动解析到 0.3.1，其余三个包仍为 0.3.0。
- 版本号同步 0.3.0；发布流程按维护基线执行（GitHub Release + npm 四包 + 市场条目更新）。

## 0.2.2 — DSH 0.2.1-rc.2 兼容，模型目录完全跟随设置

本版本修复 DSH 升级到 `0.2.1-rc.2` 之后 Bot 无法运行的问题，并让「提供方 / 模型 / 思考强度」彻底以 DSH 设置为唯一来源。
每一项都在真实的 `0.2.1-rc.2` 环境中复验过。

### 修复
- **DSH `0.2.1-rc.2` 兼容：`{{cwd}}` 不再是提示词变量。** 新版宿主对未知变量**直接抛错**，而 Bot preset 的
  persona `suffix` 还写着 `Your working directory is {{cwd}}.` —— 于是每一轮 Bot 运行都在模型调用之前失败
  （`unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`），界面表现为「发消息没有回复、没有 Bot 运行」。
  现在 suffix 为空（工作目录由宿主的 working-directory 服务作为普通上下文提供）；目录形式的 Bot preset 同步改为合法的
  `prefix`（旧的 `text` 键不在 persona 的 schema 里）。
- **Provider / Model / 思考强度全部来自 DSH 设置。** 新增 `modelCatalog()`：一次拿到「全部提供方 + 全部模型 +
  部署默认模型 + 当前不可用的提供方」。新建 Bot 的默认值是设置里的默认模型及其自带档位；编辑 Bot 时可自由切换。
- **模型菜单按 (提供方 × 模型) 列出。** 同一模型 id 挂在多个提供方下时（本机就有）不再被按 id 合并，也不会静默
  落到第一个提供方；菜单项 id 为 `<provider>:<model>`，通知里同时写明模型与提供方。
- **打开模型菜单时重新读取目录。** 在设置里新增/改名的提供方与模型，无需重开面板即可见。
- **设置里配置了但当前不可用的提供方**会在 Bot 设置里说明原因，不再静默消失；Bot 已保存但目录中已不存在的
  提供方 / 模型 / 档位会以「当前值」形式继续显示，而不是空白。

### 文档
- README（中英）更新到 DSH `0.2.1-rc.2` 与 `v0.2.2`，并明确 peer 范围按「不锁 DSH 版本」策略为 `*`。
- 工具数量与清单同步为 14 个（补上 `agent_community_remember`）。

## 0.2.1 — 修复

本版本修复以下问题，每一项都在真实环境中复验过。


### 修复
- 折叠不影响未读计算。
- **`@all` 紧跟中文不再漏判**：`@all你好` 是全员广播，`@allow` 不是。
- **「我做不到」不再被学成做法**：拒绝语在两条晋升通道都不采纳。
- **`remove_bot` 接受名字**，不再只认 id；**队长可以移除自己**（领导权显式交接）。
- **工具 schema 递归归一化**：属性级 `required` 泄漏进 JSON Schema 会让整个请求被拒。
- **0 成员的群**被拒绝创建（永远没有 leader，消息无处可去）。
- **Bot 拥有自己的 agent preset**：`workflow`/`subagent`/`create_goal`/`present`/`exit_plan_mode` 等
  越权工具从 Bot 目录消失（工具面 46 → 37）。用本部署的机制声明：`dsh-agent-preset` 插件行。
- **掩码每回合重贴**：Agent Teams 的工具在创建之后才挂载，一次性的 deny 挡不住它们。
- **删群归档所有记得这里的 Bot**，包括被踢出过的成员（此前会留下孤儿记忆文件）。
- **未读水位真正写入**：房间打开时消息尚未加载，planner 拿不到锚点且不再重试。
- **`message_member`**：成员之间、成员向 leader 的直连消息（此前提示词让成员用不存在的
  `task_report`）。
- **主会话不再指挥 Bots**：`tool-agent-community` 那一行默认关闭。
- 安装器：内容相同不再重写（避免客户端模块哈希失效）、`.ignored` 副本同步（宿主真正加载的那份）、
  `cp` 返回值不再中断安装；`verify-install` 从 profile 解析。

### 移除
- **转写导出**：`exportTranscript.ts` 与「导出」按钮整体移除（它不在 35 项验收清单里）。

# Changelog

## 0.2.0（已发布）

> 这一版把 Bots团队 从"群里每个 Bot 都会看见每条消息"改成一个真正的房间：**只有一个地方决定谁运行**，Bot 有自己的房间记忆与目标，能调用其他成员干活，并且**不会**在别人说话时白跑一轮。

### 运行策略（谁被唤醒）

- **一个决策点**：`routing.ts` 的七步表，其余任何地方都不再为用户消息排 run。
- 七步：单聊 → `@all`/`@所有人` → `@某人` → 管理指令（"把 A 踢出去"给 leader，不给 A 本人）→ 写出名字 → **角色词命中最多者胜、并列才全叫** → **兜底只有 leader**。
- **没点名不再全员运行**：以前一句「你好」会唤醒四个 Bot（四次完整模型调用），现在只有 leader，由它决定要不要分工。
- 新增 **`@all` / `@所有人`**：唯一让全员回答的方式；mention 菜单里有"所有人"一行。普通文本"大家"不触发。
- `@all` 超过并发槽的成员排队，面板提示"已排队 N 个"。
- **删除静默哨兵**（`（无需补充）` 常量、判定、提示词分支）：被点名的才会运行，因此不再需要"叫醒了但要闭嘴"这条路径，也不再出现"跑完整一轮只为说没事"的浪费。
- **删除死代码** `GroupTaskDriver.onUserMessage`（从未被调用，是第二条唤醒路径）。

### 工具面

- **修复黑名单根本没生效**：`tools.restrict()` 会因**任一未知名字**让整次调用失败，而插件只调一次并吞掉异常 —— Bot 目录里 `ask_user_question`、`skill` 在黑名单里却仍然出现。现在**逐名调用**、单项失败只损失那一个名字，并把 `applied/skipped` 写进日志。
- 默认黑名单收敛为完整的"房间 Bot 工具面"：`plugin_manager`、`workflow`、`subagent*`、`goal` 三件套、`present`、`exit_plan_mode`、`load_workspace_dependencies`、Agent Teams 三件套。
- 插件自己注册的同名工具（提问卡、skill 包装）**仍然可用** —— DSH 规定作用域内注册不会被全局禁用遮蔽。

### Bot 的系统提示词

- `bot-prompt.ts` 八段（identity / room / collaboration / memory / boundary / tools / goal / workflow）注册在 **Bot 自己的 agent 作用域**，遮蔽预设里那套"编码代理"的说法。
- 用**空文本遮蔽**五个不适用分节：`tool:goal`、`tool:workflow`、`ui:deliverable-file-references`、`harness:source`、`app:web-surface`。
- 每轮重复注入的 `[工作边界]`、`[群聊规则]`、`[对话]` 移除 —— 它们是系统提示词的一部分，不该每条消息重发一遍。

### 目标与派工

- **目标属于房间**（`room.goal`，只按 `roomId` 索引）：单聊 A／单聊 B／群 A／群 B 四重隔离是**结构性**的，没有"所有目标"的读取口，工具连房间参数都没有。
- `get_goal` 改为读**当前房间**的目标；`agent_community_goal` 负责设定/暂停/继续/完成；群里只有 leader（或用户）能改。
- 目标续跑由插件决定：有实际进展才排下一轮，**连续 3 轮无进展自动暂停**并提示；用户发言重置预算。
- **`agent_community_dispatch`**：把活交给房间里**已存在的成员**（1–4 个），**立即返回**——leader 本轮先向用户汇报"已派给谁"，成员完成后系统带着回报唤醒 leader 继续。单聊里拒绝并提示先建群；只有 leader 能派；每次失败都逐条说明原因。
- `workflow`（DSH 的）被移除：它开的是**调用者会话里的子代理**，房间里看不见、不占并发额度、停止按钮也够不着。

### 记忆

- **文件优先**：`memory/<botId>/rooms/<roomId>.md` 一个房间一个文件，人可以直接打开、编辑；`INDEX.md` 是派生文件，删了能重建。
- **生命周期**：清空消息**不动**记忆；删除群聊**归档**记忆；踢人**保留**；**删除 Bot 才彻底删除**，且先把它在群里的分区归档到 `_archive/<roomId>/` 再删目录。
- **晋升双通道**：同一请求成功两次 → `procedure`；**反复犯错 → 用户干预 → 做对** → `lesson`，**负例与正例都写进 `<Bot 工作区>/AGENTS.md` 的托管区**，带 run id 证据。没有 run 支撑的自述不晋升（弱证据）。用户手写的内容永不覆盖。
- 超限的旧条目移入 `*.overflow.md`（只移不删），文件与注入都有硬预算。
- **注入改成 baseline + 增量**：首轮给最近记忆，之后只给新增，省 token 并保护 prefix cache。
- 新增 `agent_community_recall`：在本房间记忆里按关键词检索，返回**出处**（时间 + run id + 文件路径）——优先参考实际运行，而不是凭记忆推测。

### 上下文压缩

- **压缩 = 折叠，不是删除**：原文留在转写里（可以往上翻），只有模型的窗口换成"1 条摘要 + 最近 N 条"。折叠区间记录在 `room.foldedSeqs`。
- 不再 dispose 成员的 agent、不再清空 `roomAgentSessions`、不再 purge 会话日志、不再推进 `compactCount` —— Bot 自己的上下文窗口交给 DSH（`standard` 预设自带压缩）。

### 修复

- 未读角标闪烁（`planMarkRead` 按时间去重 + 发送路径用真实返回的消息做锚点）。
- 单聊一句话建出两个群（建群只走确认框）。
- 安装脚本因 `head -c 80` 与 83 字节特征串不匹配而永远失败。
- 跨房间读取/写入一律拒绝。

### 测试


## 0.1.2（已发布）

上一个公开发布版本。安装方式见 README。
