/**
 * SessionRunner — one native DSH Agent per `(roomId, botId)`.
 *
 * WHY ONE PER PAIR, NOT ONE PER ROOM
 * The room-host dispatcher was removed in favour of leader-driven coordination
 * (decision ③), and every bot needs a memory that is isolated from every other
 * room. A distinct `sessionId` per pair is what makes that isolation *structural*
 * rather than a convention: `dsh-session` has no code path that reads another
 * session, so two rooms physically cannot leak into each other. Requirements R1
 * and R2 fall out of the key, not out of prompt discipline.
 *
 * VISIBILITY (the user's hard rule: these sessions must NEVER appear in DSH's
 * sidebar). Two independent layers:
 *   1. Sessions created programmatically are never attached to a workspace.
 *      `dsh-api-session-controller` only calls `workspace.attachSession()` when the
 *      creating request names a workspace, and this path does not go through it at
 *      all. Verified empirically: plugin-created sessions exist on disk under
 *      `~/.dsh/sessions/_no-cwd/` but appear in no `workspace.json` record.
 *   2. `reconcileVisibility()` archives/detaches anything this runner owns, for the
 *      case where a future DSH build starts attaching automatic sessions.
 *
 * cwd is the bot's REAL workspace, deliberately unlike the old host runner which
 * used a private directory. `session.header.cwd` is what native tools receive as
 * their working directory (`dsh-tools:1423`), so members must point at the real
 * workspace to be able to work. Hiding does not depend on the cwd.
 *
 * EVICTION. A running agent is NEVER evicted. `agent.status` cannot be trusted for
 * that decision: the loop reports `idle` for BOTH the `idle` and the `maintenance`
 * phase, and compaction runs in `maintenance` — so a status check would dispose an
 * agent mid-compaction. The `turnBoundary` projection is consulted instead.
 */
import { appendFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from './dsh-compat.ts'
import type { BotId, BotRoomId } from './types.ts'
import { installBotPrompt } from './bot-prompt.ts'

/** What the runner needs from the community service. Narrow on purpose. */
export interface SessionRunnerAccessor {
  /**
   * The session id this pair owns, INCLUDING its generation.
   *
   * Supplied by the service rather than derived here, because the id has exactly one
   * correct answer and the service is what advances it. It used to be computed in both
   * places: `clearMessages` bumped the generation while the runner always rebuilt
   * generation 0, so after a clear the service believed it had a fresh session while
   * the runner RESUMED THE OLD ONE — handing the bot back the conversation the user had
   * just deleted, which is precisely the "it replied with the content I cleared" bug.
   */
  sessionIdFor(roomId: string, botId: string): SessionId
  /**
   * The room's coordinator (its leader), or undefined for a 1:1 / a room with no members.
   *
   * Needed to TELL each bot who is in charge: the coordinator may invite, remove, dispatch and
   * finish, and a bot that cannot see whether that is itself refuses work it owns.
   */
  leaderOf(roomId: string): string | undefined
  /** A bot's display name, for naming the leader in a member's prompt. */
  botName(botId: string): string
  /**
   * Whether this bot is still a member of this room.
   *
   * A bot can LEAVE mid-turn: the coordinator executes `remove_bot`, and when the target is the
   * coordinator itself the service stops that very run and retires its session. Repairing a turn
   * whose bot is gone is pointless, and reporting it as a model failure is simply wrong.
   */
  isMember(roomId: string, botId: string): boolean
  /** Bot identity + model route, or undefined when the bot is gone. */
  botById(botId: string): {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly provider?: string | undefined
    readonly model?: string | undefined
    readonly reasoningEffort?: string | undefined
    readonly systemPrompt?: string | undefined
    readonly workspace?: string | undefined
    /** The bot's declared permission level, mapped onto the deployment's presets. */
    readonly permission?: 'read-only' | 'workspace-write' | 'full-access' | string | undefined
  } | undefined
  /** Room shape the perception layer needs. */
  roomById(roomId: string): {
    readonly id: string
    readonly memberIds: readonly string[]
    readonly directBotId?: string | undefined
  } | undefined
  /** Recent room history, oldest first, for seeding a fresh session. */
  historyFor(roomId: string, limit: number): ReadonlyArray<{ readonly senderName: string; readonly text: string }>
  /** Fallback workspace when a bot declares none. */
  defaultWorkspace(): Promise<string>
}

/**
 * The slice of `Session` this runner reads.
 *
 * Typed narrowly rather than imported: `dsh-session`'s Session carries a large
 * surface we do not touch, and a narrow shape keeps the coupling obvious.
 */
interface SessionView {
  deriveMessages(): ReadonlyArray<{ readonly content?: readonly unknown[] }>
  /** Present on a real Session; read only for `agentPreset`. */
  readonly header?: { readonly agentPreset?: string | undefined } | undefined
}

/** Why a turn ended, in the vocabulary the UI already understands. */
export type TurnEndReason = 'completed' | 'max-tokens' | 'aborted' | 'error'

/**
 * A real sign of work inside a turn — what the run's deadline is extended on.
 *
 * `frame` = a model stream frame arrived (thinking or answer text; tokens are being
 * produced); `tool` = a tool call started or finished. A heartbeat is NOT progress: a hung
 * provider still heartbeats, and treating it as progress would make "no-progress" useless.
 */
export type ProgressKind = 'frame' | 'tool-start' | 'tool-end'

export interface TurnOutcome {
  /** Visible text the model put in the message channel. Empty means it said nothing. */
  readonly text: string
  /** Reasoning channel text, tracked so the caller can detect "analysis only". */
  readonly reasoning: string
  readonly stopReason: TurnEndReason
  /** How many text-channel repair attempts were needed (0 = answered first time). */
  readonly repairs: number
  /** True when even the repair turns produced no visible text. */
  readonly textChannelFailed: boolean
  /**
   * True when the turn was stopped before it could answer: the caller (run executor) asked
   * for the abort, so the run must settle as `interrupted`, never as a completed answer.
   *
   * This is the difference between "the model produced nothing" (a failure worth reporting)
   * and "the user pressed stop" (not a failure, and no retry may follow).
   */
  readonly stopped?: boolean | undefined
  /**
   * The bot left the room during this turn (it executed its own removal, or was kicked).
   *
   * Not a model failure and not something to repair: the turn ended because the bot's membership
   * did. The service has already told the room what happened.
   */
  readonly leftRoom?: boolean | undefined
  /** Where this turn ended in the session log; absent only when the session is already gone. */
  readonly sessionSeq?: SessionSeq | undefined
}

/** Tunables the service passes in; defaults live here so tests can override. */
export interface SessionRunnerOptions {
  /** Idle agents kept alive. Beyond this the least-recently-used idle one is disposed. */
  readonly idleLimit?: number
  /** Hard ceiling on live agents. Beyond this a run waits for a slot. */
  readonly hardLimit?: number
  /** Messages replayed into a brand-new session so it remembers the room. */
  readonly seedMessages?: number
  /** Text-channel repair turns before giving up. */
  readonly repairAttempts?: number
  /**
   * Compose the agent's scoped world before it is published.
   *
   * The service uses this to register the collaboration tools (`propose_group` in a
   * 1:1, the coordination trio in a group) and to scope tool restrictions for the
   * bot's permission level. Scoped registrations vanish with the agent on dispose,
   * so a bot's tools can never outlive it or leak into another bot's scope.
   */
  readonly setupAgent?:
    | ((agentCtx: Context, roomId: string, botId: string) => void)
    | undefined
  /**
   * Agent preset every bot session is created under (default `standard`).
   *
   * Without one a bot saw only the tools a plugin registers directly — the community
   * and team families, 31 in total — and none of the preset-bound core tools: no bash,
   * no read/write/edit, no web_search/web_fetch, no skill, no todo_write. That is the
   * literal reason bots kept reporting "本群 runner 无写盘/命令执行能力".
   */
  readonly agentPreset?: string | undefined
  /**
   * Global tools a bot session must never see. `plugin_manager` is the default: it can
   * disable or uninstall plugins, this one included.
   */
  readonly deniedTools?: readonly string[] | undefined
  /** Directory for the append-only preset diagnostic (tests leave it undefined). */
  readonly presetLogDir?: string | undefined
  /**
   * Hide a freshly created session from DSH's sidebar.
   *
   * CALLED ON EVERY CREATE, not just at startup. A session is visible the moment it
   * exists, and the startup sweep only covers sessions that existed when the process
   * booted — so without this, every session made during a session appears in the
   * sidebar until the next restart.
   */
  readonly hideSession?: ((sessionId: string) => void) | undefined
  /**
   * Make a session runnable again, BEFORE its turn.
   *
   * Required because DSH installs an admission gate that rejects every
   * `agent/pre-step` for an archived session, and a rejected step ends the turn as
   * `blocked` WITHOUT issuing a model request — which presents to the user as "no
   * reply and nothing running". Hiding a session therefore cannot be a one-time act
   * at creation: it must be undone before each turn and re-applied after it settles.
   */
  readonly restoreSession?: ((sessionId: string) => Promise<void>) | undefined
}

/**
 * Prefix marking a session as ours. Used both to build ids and by the startup sweep
 * that archives anything we own, so "forgot to register a session" cannot leak one
 * into DSH's sidebar.
 */
const OWNED_PREFIX = 'ac:'

/**
 * Separator between room and bot in an owned session id. A colon, because room and
 * bot ids are UUIDs and cannot contain one — which is what makes the id reversible.
 */
const OWNED_SEP = ':'

/**
 * The host tools a bot session must never see, in one place.
 *
 * TWO KINDS OF ENTRY, and the difference matters:
 *   · `plugin_manager` — genuinely dangerous for a bot (it can disable or uninstall plugins,
 *     this one included), and
 *   · names the PLUGIN ITSELF re-registers in the agent scope (`ask_user_question` → the
 *     ledger question card, `skill` → the plugin's own framing wrapper). A global deny does
 *     not hide a scoped registration (DSH: "scoped registrations remain visible"), so the
 *     bot keeps the working card while the host's UI-bound version stays hidden.
 *
 * The rest is the room-bot tool surface: every entry brings system-prompt guidance that
 * assumes a role a Bot in a room does not have. Observed on a real bot session before this
 * list existed: `workflow`, `subagent`, `subagent_fork`, `create_goal`/`get_goal`/
 * `update_goal`, `present`, `exit_plan_mode`, `list_agents`, `send_message` and
 * `interrupt_agent` were all in the catalog, and their paragraphs were in the prompt.
 *
 * NOTE: this list is a MASK, not an unmount. A name the scope does not know is skipped (see
 * `restrictGlobalTools`), so a deployment may trim it without breaking startup.
 */
/**
 * Tools that belong to DSH's own Agent Teams and must not be used from a room.
 *
 * WHY A GUARD AND NOT A RESTRICTION. These five are registered ON the bot agent's own scope by the
 * profile's Agent Teams bundle — measured in a live session (38 tools, all five present). DSH's
 * `tools.restrict()` is a GLOBAL-tool mask: it validates names against the scope's
 * `restrictableNames` and throws for anything else, so a sibling scope-local registration cannot
 * be hidden by it, from the plugin or anywhere else. Upstream documents the cause and defers it:
 * "in-process one-shot children receive their subagent descriptor after publication. Team
 * installation can therefore mistake them for Leads and expose Team policy and tools. Calls are
 * rejected once the descriptor identifies them as non-members."
 *
 * What CAN be done from the plugin is `tools.guard()`, registered through the agent's own ctx:
 * "Any matching guard may deny by returning a reason." The tools stay listed, but every call from
 * a bot is refused with a reason the model reads — so a bot cannot spawn teammates, cannot message
 * a "member" that is not in the room, and cannot interrupt one. For a room, `assign_task` /
 * `message_member` / `finish_task` are the collaboration surface, and this makes that literal.
 */
export const AGENT_TEAMS_TOOLS: readonly string[] = [
  'list_agents', 'send_message', 'interrupt_agent', 'spawn_teammate', 'wait_agent',
  // ── THE HOST'S OWN TASK BOARD (DUP-17) ────────────────────────────────────────
  //
  // DSH's Agent Teams bundle registers `team_task_create/list/get/update` ON the bot agent's
  // scope. A room ALREADY has a task board — the leader's `assign_task`/`dispatch`, the members'
  // `message_member` reports and `finish_task`'s single summary, all backed by `room.taskState`
  // — so the host board is a second, conflicting one: work recorded there is invisible to the
  // room (and its "owner"/"target" are Agent Teams targets, not room members). The names below
  // are what the host actually registers (verified against the shipped DSH build).
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update', 'team_task_delete',
  // Not Agent Teams, but the same class: mounted by another composition, not ours to remove, and
  // meaningless in a bot's own workspace.
  'load_workspace_dependencies',
]

/**
 * Host tool families refused as a PREFIX, not just by exact name.
 *
 * The exact list above can lag a host release that adds `team_task_…` tools; refusing the whole
 * family keeps a room's task board single no matter which variant appears.
 */
export const AGENT_TEAMS_TOOL_PREFIXES: readonly string[] = ['team_task_']

/** The tool name a guard/interceptor was handed, whatever shape the runtime uses. */
export function toolNameOf(exec: unknown): string | undefined {
  if (exec === null || typeof exec !== 'object') return undefined
  const e = exec as { toolName?: unknown; name?: unknown; call?: { name?: unknown }; tool?: { name?: unknown } }
  for (const candidate of [e.toolName, e.name, e.call?.name, e.tool?.name]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/** The refusal a room gives for an Agent Teams tool, or undefined when the call is allowed. */
export function agentTeamsDenial(exec: unknown): string | undefined {
  const name = toolNameOf(exec)
  if (name === undefined) return undefined
  const denied = AGENT_TEAMS_TOOLS.includes(name)
    || AGENT_TEAMS_TOOL_PREFIXES.some(prefix => name.startsWith(prefix))
  if (!denied) return undefined
  // The host's task board (team_task_*) gets its own sentence: the generic "use the room's
  // tools" answer would not say WHY a second board is the wrong place for the work.
  const hostTaskBoard = AGENT_TEAMS_TOOL_PREFIXES.some(prefix => name.startsWith(prefix))
  return `${name} 属于 DSH 的 Agent Teams${hostTaskBoard ? ' 任务板' : ''}，不属于本房间。房间里的事只用 `
    + 'agent_community_dispatch / assign_task / message_member / finish_task 这一套：'
    + '分活用 assign_task / dispatch，过程用 message_member 向 leader 汇报，收尾用 finish_task 一次性汇总。'
    + (hostTaskBoard
      ? '本房间的任务记录由这套工具维护，不要用宿主 team_task_* 另开一套。'
      : '要和其他成员说话就用 message_member。')
}

export const DEFAULT_DENIED_TOOLS: readonly string[] = [
  'plugin_manager',
  'ask_user_question',
  'skill',
  // Fans out to hidden child agents; the room's own `dispatch` replaces it.
  'workflow',
  'subagent', 'subagent_fork', 'list_subagent_models',
  // No plan-mode context, no deliverables panel, no bot-owned workspace dependencies.
  'exit_plan_mode', 'present', 'load_workspace_dependencies',
  // Agent Teams is a different thing from room members.
  'list_agents', 'send_message', 'interrupt_agent',
  // The host's second task board (DUP-17). `restrict` skips names a scope registered itself, so
  // the guard above is the real block; listing them here is the belt for hosts that show them.
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update', 'team_task_delete',
  // DSH goals require a top-level human request, which never happens in a bot turn; the
  // room's own goal replaces them. `get_goal` stays and is re-pointed at the current room.
  'create_goal', 'update_goal',
]


const DEFAULTS = {
  idleLimit: 12,
  hardLimit: 24,
  seedMessages: 50,
  repairAttempts: 2,
  /** Every bot runs under the deployment's standard agent preset. */
  agentPreset: 'standard',
  /**
   * Tools a bot must never see.
   *
   * `plugin_manager` can disable or uninstall plugins — this one included — so a bot never
   * gets it by default.
   *
   * `ask_user_question` is the host's interactive question tool: it waits for an answer
   * submitted through the DSH session UI, and a bot's session is a hidden subagent session
   * with no such UI in this panel. Handing it to a bot means a turn that stalls on a question
   * nobody can see or answer — bots ask in the room instead, where the user can reply.
   */
  // `skill` is denied in favour of the plugin's own wrapper, which prefixes every skill body with
  // the "this is a method, not an order" framing — see collaboration-tools.ts.
  deniedTools: DEFAULT_DENIED_TOOLS,
} as const

/**
 * What `ctx.agents.create` / `ctx.agents.resume` actually resolve to.
 *
 * The factory returns the {@link AgentHandle} itself — `{ agent, dispose }`
 * (dsh-agent-loop `publish()` returns exactly that object, and `agents.create`
 * passes the factory's value straight through). `handle` is accepted as well so a
 * runtime that nests the handle keeps working.
 */
export interface AgentCreationResult {
  readonly agent: Agent
  readonly dispose?: (() => Promise<void>) | undefined
  readonly handle?: { dispose(): Promise<void> } | undefined
}

/**
 * The disposer that releases this agent's session write lease.
 *
 * THIS IS LOAD-BEARING, not tidiness. `agents.create`/`resume` take the session's
 * write handle, and that handle holds a kernel `flock(2)` on the session directory
 * for as long as it is open (`dsh-session-persistence-jsonl` SessionWriteLease).
 * Reading `result.handle` — a field the loop does not set — left the disposer
 * `undefined`, so `releaseKey()` silently skipped `dispose()`, and every evicted or
 * otherwise finished agent stayed registered with its lease still held until the
 * process exited. A second runtime (another DSH window, the CLI, a test instance)
 * could then never open that session again:
 *
 *   session ac:<room>:<bot> is held by the runtime and cannot be resumed
 *   (resume: SessionAlreadyOwnedError …; create: SessionAlreadyExistsError …)
 *
 * which is what a user sees as a red "运行失败" banner on every retry.
 */
function disposerOf(result: AgentCreationResult): { dispose(): Promise<void> } | undefined {
  if (result.handle?.dispose !== undefined) return result.handle
  const dispose = result.dispose
  if (typeof dispose !== 'function') return undefined
  return { dispose: () => Promise.resolve(dispose()) }
}

/**
 * Per-key FIFO mutex. Native sessions are single-writer, and we create them
 * ourselves now, so nothing else serialises two runs for the same bot.
 *
 * The key is `(roomId, botId)` — NOT the bot alone. That is deliberate: R11
 * requires a bot to run in a 1:1 and in a group at the same time, and those are
 * different keys, so they never block each other.
 */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => { release = resolve })
    this.tails.set(key, next)
    try {
      await prev
      return await fn()
    } finally {
      release()
      if (this.tails.get(key) === next) this.tails.delete(key)
    }
  }

  get depth(): number {
    return this.tails.size
  }
}

/**
 * Does a `turn/end` error message describe a REJECTED REQUEST?
 *
 * Two families qualify, and both must be reported as a failure rather than mistaken for
 * "the model chose not to speak":
 *
 *   1. transport/provider failures — HTTP status, auth, timeouts, dropped connections;
 *   2. CONFIGURATION rejections the LLM layer raises *before* network I/O. The one observed in
 *      the field is `UNSUPPORTED_REASONING_EFFORT`: a provider/model that publishes no reasoning
 *      levels (any custom `api: openai-completions` model row today) rejects *every*
 *      `reasoningEffort`, with
 *        provider "workbuddy" model "cn:deepseek-v4.1-flash" does not support reasoning effort "max"
 *      That message names no HTTP code, so a status-only pattern missed it, `readTurn` saw no
 *      assistant text, and the run settled `completed` / `finishPath: 'empty'`: every bot turn
 *      died in ~20 ms and the user saw a grey「模型输出为空」notice with no error anywhere.
 *
 * A reasoning-only turn — the case the repair prompt exists for — does NOT match: its message
 * describes the model's output, not the request.
 */
export function looksLikeProviderRejection(message: string): boolean {
  return /request failed|HTTP[_ ]?\d|\b(401|403|404|429|5\d\d)\b|unauthor|forbidden|timed? ?out|ECONN|fetch failed|does not support|unsupported/iu
    .test(message)
}

export class SessionRunner {
  private readonly ctx: Context
  private readonly accessor: SessionRunnerAccessor
  /**
   * Resolved options: every number has its default applied, `setupAgent` stays
   * optional because it has no sensible default.
   */
  private readonly opts: {
    readonly idleLimit: number
    readonly hardLimit: number
    readonly seedMessages: number
    readonly repairAttempts: number
    readonly setupAgent?:
      | ((agentCtx: Context, roomId: string, botId: string) => void)
      | undefined
    readonly hideSession?: ((sessionId: string) => void) | undefined
    readonly restoreSession?: ((sessionId: string) => Promise<void>) | undefined
    readonly agentPreset?: string | undefined
    readonly deniedTools?: readonly string[] | undefined
    readonly presetLogDir?: string | undefined
  }
  private readonly mutex = new KeyedMutex()

  /** Live agents, keyed by (roomId, botId). */
  private readonly agents = new Map<string, Agent>()
  private readonly handles = new Map<string, { dispose(): Promise<void> } | undefined>()
  /** Monotonic tick of last use, for LRU eviction. */
  private readonly lastUsed = new Map<string, number>()
  /** Keys whose history has already been replayed into their session. */
  private readonly seeded = new Set<string>()
  /**
   * Keys with a turn in flight, tracked HERE rather than read back from the session.
   *
   * The `turnBoundary` projection would answer the same question, but reaching it
   * needs `ctx.sessionProjections` declared in `static inject`, and Cordis throws
   * "cannot get property without inject" for an undeclared service. Tracking our own
   * boundaries is both dependency-free and exact: the runner is the only thing that
   * starts and awaits these turns, and compaction happens at a step boundary INSIDE
   * the awaited window, so a compacting agent is always already marked running.
   */
  private readonly running = new Set<string>()
  /**
   * In-flight disposals, keyed by session id.
   *
   * `clearMessages` disposes the room's agents and deletes their logs, while the very
   * next user message can start a new run. Disposal is asynchronous, so without this
   * barrier the new run would look the agent up in `ctx.agents` and ADOPT the
   * not-yet-disposed one — then have it pulled out from under the turn, producing no
   * reply at all. `ensureAgent` awaits the pending disposal first, which makes the
   * "clear then immediately send" sequence safe.
   */
  private readonly disposal = new Map<string, Promise<void>>()
  /**
   * Progress callbacks of the turn currently running per pair, keyed like `agents`.
   *
   * The executor registers one through `run(..., onProgress)`; the global observers below
   * turn DSH's frame/tool events back into that callback, which is what lets an adaptive
   * deadline tell "still working" from "hung" without polling the session store.
   */
  private readonly progressHandlers = new Map<string, (kind: ProgressKind) => void>()
  private progressUninstall: (() => void) | undefined
  private tick = 0
  private disposed = false

  constructor(ctx: Context, accessor: SessionRunnerAccessor, opts: SessionRunnerOptions = {}) {
    this.ctx = ctx
    this.accessor = accessor
    // `setupAgent` has no default; spreading DEFAULTS over it would otherwise drop it.
    this.opts = { ...DEFAULTS, ...opts }

    // ONE BOOT LINE, so the file explains itself even before the first bot turn: which names
    // the plugin asks to deny, and which ones it guards instead (a restriction cannot hide a
    // sibling scope-local registration — see AGENT_TEAMS_TOOLS).
    //
    // IT MUST COME AFTER THE ASSIGNMENTS. Written first, it read `this.opts` while it was still
    // undefined and threw — and because the throw happened inside `new SessionRunner(...)`, it
    // aborted the rest of the service constructor, the executor was never created, and every run
    // the user created queued for ever with the panel showing 排队中 and no error anywhere. A
    // diagnostic that can break construction is worse than no diagnostic.
    this.noteToolMask(
      `boot deny=[${(opts.deniedTools ?? []).join(',')}] guard=[${AGENT_TEAMS_TOOLS.join(',')}]`,
    )
    // Observation must never be able to break construction: the same rule the boot line
    // above learned the hard way (a diagnostic that throws here leaves no executor at all).
    try {
      this.installProgressObservers()
    } catch {
      // A host without an event bus simply has no adaptive progress signal.
    }
  }

  /**
   * Subscribe to the two global streams that prove a turn is working.
   *
   * `global: true` is required for the same reason the ledger projection documents: frames
   * are emitted from each agent's own scoped dispatcher, so a non-global listener only sees
   * the first agent. Both listeners are no-ops until a run registers a progress handler, so a
   * runner used only for one-shot turns pays nothing.
   */
  private installProgressObservers(): void {
    const bus = this.ctx as unknown as {
      on?(
        event: string,
        handler: (...args: unknown[]) => void,
        opts?: { global?: boolean },
      ): () => void
    }
    if (typeof bus.on !== 'function') return
    const offFrame = bus.on('agent/assistant-stream', (payload) => {
      const frame = (payload as { frame?: { attemptId?: unknown } } | undefined)?.frame
      const attemptId = frame?.attemptId
      if (typeof attemptId !== 'string') return
      // DSH's attempt id is `${sessionId}:${attempt}` — drop the counter, parse the pair.
      const cut = attemptId.lastIndexOf(':')
      const owner = cut < 0 ? undefined : SessionRunner.parseSessionId(attemptId.slice(0, cut))
      if (owner === undefined) return
      this.progressHandlers.get(SessionRunner.key(owner.roomId, owner.botId))?.('frame')
    }, { global: true })
    const offEvent = bus.on('session/event', (...args: unknown[]) => {
      // Listener contract is `(session, event)`; a harness that emits one array is accepted.
      const [first, second] = args.length === 1 && Array.isArray(args[0])
        ? (args[0] as [unknown, unknown])
        : (args as [unknown, unknown])
      const sessionId = (first as { id?: unknown } | undefined)?.id
      const type = (second as { type?: unknown } | undefined)?.type
      if (typeof sessionId !== 'string' || typeof type !== 'string') return
      if (type !== 'tool/call' && type !== 'tool/result') return
      const owner = SessionRunner.parseSessionId(sessionId)
      if (owner === undefined) return
      // START/END are distinct: while a tool is in flight its silence is REAL work,
      // not a dead provider stream. RunExecutor keeps the active count and exempts it.
      this.progressHandlers.get(SessionRunner.key(owner.roomId, owner.botId))?.(
        type === 'tool/call' ? 'tool-start' : 'tool-end',
      )
    }, { global: true })
    this.progressUninstall = () => { offFrame(); offEvent() }
  }

  /**
   * Deterministic session id for a pair.
   *
   * Deterministic (not random) so a restart resumes the SAME session and the bot
   * keeps its memory. `SessionStore.prepare` only requires uniqueness — there is no
   * format constraint — so the readable `ac-` prefix is free, and it doubles as the
   * marker the startup sweep uses to find sessions this plugin owns.
   */
  /**
   * The session id a `(room, bot)` pair owns.
   *
   * `generation` distinguishes successive conversations in the same pair. It exists
   * because clearing a room must be a REAL erase: the id is deterministic, and a
   * deterministic id means the next run rebuilds the SAME session — and `resume` can
   * hand back the previous conversation from the runtime's in-memory store even after
   * the on-disk log was deleted. Bumping the generation on clear gives the next run an
   * id that has never existed, so nothing can resurrect what the user deleted.
   *
   * Generation 0 keeps the bare id, so the derivation stays a pure function of the
   * room's own state (its `clearCount`) rather than a stored list that a future call
   * site could forget to update.
   */
  static sessionIdFor(roomId: string, botId: string, generation = 0): SessionId {
    const base = `${OWNED_PREFIX}${roomId}${OWNED_SEP}${botId}`
    return (generation > 0 ? `${base}${OWNED_SEP}g${generation}` : base) as SessionId
  }

  /** Every session id this plugin could own, derived from live state. */
  static ownedIdPrefix(): string {
    return OWNED_PREFIX
  }

  /**
   * Split an owned session id back into its pair, or undefined when the id is not
   * ours. Parsing works because room and bot ids are UUIDs (hex + dashes) and the
   * separator is a colon, which a UUID cannot contain.
   *
   * The generation tail is NOT part of the bot id. `sessionIdFor` appends
   * `${OWNED_SEP}g${generation}` for every generation after the first, so a cleared
   * room's ids are `ac:<room>:<bot>:g7` — and returning `"<bot>:g7"` as the bot id
   * silently broke every consumer of this pair: `runIdFor(roomId, "<bot>:g7")` found
   * no live run, so `LedgerProjection` classified the run's OWN attempt as a
   * session-title call and discarded its whole live stream (no streamed text, no
   * 思考过程, no tool rows), and the collaboration tools could not resolve their
   * caller. Generation 0 keeps the bare id, so both shapes must parse.
   */
  static parseSessionId(sessionId: string): { roomId: string; botId: string } | undefined {
    if (!sessionId.startsWith(OWNED_PREFIX)) return undefined
    const at = sessionId.indexOf(OWNED_SEP, OWNED_PREFIX.length)
    if (at < 0) return undefined
    const roomId = sessionId.slice(OWNED_PREFIX.length, at)
    let botId = sessionId.slice(at + OWNED_SEP.length)
    // Only a trailing `g<digits>` marker is stripped — a UUID can never supply one,
    // so this cannot eat part of a real bot id.
    const tail = botId.lastIndexOf(OWNED_SEP)
    if (tail > 0 && /^g\d+$/.test(botId.slice(tail + 1))) botId = botId.slice(0, tail)
    return { roomId, botId }
  }

  static key(roomId: string, botId: string): string {
    return `${roomId}\u0000${botId}`
  }

  /**
   * Whether the caller's signal has fired.
   *
   * A helper rather than an inline `signal?.aborted === true`: TypeScript narrows the
   * property to literal `false` after the first guard returns, and then treats every later
   * comparison as unreachable — even though the listener (which fires asynchronously) can
   * flip it between statements. Reading it through a parameter keeps the honest type.
   */
  private static aborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true
  }

  private static split(key: string): { roomId: string; botId: string } {
    const at = key.indexOf('\u0000')
    return { roomId: key.slice(0, at), botId: key.slice(at + 1) }
  }

  /** Live agent count — used by the queue to decide whether a slot is free. */
  get liveCount(): number {
    return this.agents.size
  }

  /**
   * Stop the live turn for one `(room, bot)` pair — the piece that makes 「停止生成」 real.
   *
   * WHY THE EXECUTOR CANNOT DO THIS ITSELF: the `Agent` object lives in this runner, keyed by
   * the pair, and `agent.cancel` is the only call that interrupts the model request in flight.
   * The executor used to abort its own `AbortController` and then look the agent up in a map
   * it never populated, so the model kept streaming (and billing) after the user pressed stop.
   *
   * `keepInbox: true` because a stop must not silently drop a prompt that is queued behind
   * the current turn (the next user message is not the stop button's to delete). The host
   * signature is called with the same shape the runner's own dispose path uses; a runtime
   * that rejects that second argument gets the bare-options retry, so the cancel still
   * happens instead of the whole stop silently failing.
   *
   * No-op when there is no live agent — a stop on an already-idle pair is not an error.
   */
  cancel(roomId: string, botId: string, reason = 'user interrupted'): void {
    const agent = this.agents.get(SessionRunner.key(roomId, botId))
    if (agent === undefined) return
    const request = { kind: 'hook' as const, reason }
    try {
      agent.cancel(request, { keepInbox: true })
    } catch {
      // Older host shapes accept only the request: the cast keeps this fallback compiling
      // against host typings while still trying the minimal call before giving up.
      try {
        (agent as unknown as { cancel(request: unknown): void }).cancel(request)
      } catch { /* best-effort: the turn may already be over */ }
    }
  }

  /** Stop every live turn for one room — used when the room is deleted or its agents are torn down. */
  cancelRoom(roomId: string, reason = 'room removed'): void {
    for (const key of [...this.agents.keys()]) {
      const parsed = SessionRunner.split(key)
      if (parsed.roomId === roomId) this.cancel(parsed.roomId, parsed.botId, reason)
    }
  }

  /**
   * Run one turn for a bot and return what it produced.
   *
   * Serialised per `(roomId, botId)`. The caller is responsible for having created
   * the run row; this method only drives the agent.
   */
  async run(
    roomId: string,
    botId: string,
    prompt: string,
    /**
     * Roster / membership / skill changes since this session last saw them.
     *
     * Delivered as an `inject` (model-facing context, no wake) BEFORE the turn, so it
     * lands in the same step. Only the CHANGED part travels: re-stating the roster
     * every turn would rewrite history and destroy the provider's prefix cache, which
     * is the mechanism the whole append-only design exists to protect.
     */
    contextDelta?: string | undefined,
    /**
     * Replay the room's history into this session before the turn.
     *
     * Done INSIDE the run because `seedIfNeeded` injects into the live agent: called
     * before `ensureAgent` had built one it found nothing and returned, so a fresh
     * session was never seeded and the bot answered knowing nothing about the room.
     */
    seed?: boolean | undefined,
    /**
     * Abort signal owned by the caller's run.
     *
     * Registered BEFORE the turn starts: when it fires, the runner cancels the live agent
     * (which interrupts the model request in flight) and the turn returns a `stopped`
     * outcome instead of repairing or continuing. Optional so every existing caller keeps
     * working; a caller that omits it keeps the historical behaviour.
     */
    signal?: AbortSignal | undefined,
    /**
     * Called once per REAL sign of work inside this turn: a model stream frame, or a tool
     * call starting/ending. The executor turns these into `lastProgressAt` for the adaptive
     * deadline, and keeps `tool-start`…`tool-end` pairs open as an active-tool exemption
     * (a heartbeat is not progress — see {@link ProgressKind}).
     *
     * Observation only: it changes no result and is removed with the turn. Optional so every
     * existing caller keeps working unchanged.
     */
    onProgress?: ((kind: ProgressKind) => void) | undefined,
  ): Promise<TurnOutcome> {
    const key = SessionRunner.key(roomId, botId)
    return this.mutex.run(key, async () => {
      // ── ABORT PATH ───────────────────────────────────────────────────────────────
      //
      // Two independent things happen on abort, and both are needed:
      //   · this listener asks the RUNNER to cancel the agent (the only call that stops the
      //     in-flight model request; aborting the executor's controller alone did nothing);
      //   · every loop boundary below re-checks `signal.aborted`, so no repair round and no
      //     tool round is started after the user pressed stop.
      // The listener is removed in `finally` (a long-lived signal must not accumulate one
      // listener per run), and a signal that is already aborted never registers at all.
      const onAbort = (): void => { this.cancel(roomId, botId, 'run aborted') }
      if (SessionRunner.aborted(signal)) return this.abortedOutcome()
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
      // A signal that fired between the check and `addEventListener` would otherwise lose
      // its wake-up (the listener was not attached yet) — re-check once inside the guard.
      if (SessionRunner.aborted(signal)) return this.abortedOutcome()
      // Register only inside the guarded section: every early return below passes through
      // `finally`, which is the one place the handler is removed again.
      if (onProgress !== undefined) this.progressHandlers.set(key, onProgress)
      const slot = await this.ensureSlot(signal)
      if (!slot) return this.abortedOutcome()
      const agent = await this.ensureAgent(roomId, botId)
      this.touch(key)
      this.running.add(key)
      // ── LIFT THE ARCHIVE, EVEN THOUGH WE NEVER SET IT ──────────────────────────
      //
      // The session id is DETERMINISTIC (`ac:<roomId>:<botId>`), and `archivedSessionIds`
      // is a registry-global set keyed by exactly that id. An older build hid sessions
      // by archiving them, so those ids are still in the set — and a fresh session
      // reusing the id inherits the block: `underArchivedSession` returns true and every
      // `agent/pre-step` is rejected, ending each turn as `blocked` with NO model
      // request. The bot goes completely silent.
      //
      // Unarchiving is now FREE OF SIDE EFFECTS: `sessionVisible` tests `origin` FIRST
      // and returns false for `subagent` before it ever consults the archive set, so
      // clearing the flag cannot make the session visible again. Visibility and archive
      // state are decoupled, which is what makes this safe.
      await this.opts.restoreSession?.(this.accessor.sessionIdFor(roomId, botId))
      if (contextDelta !== undefined && contextDelta !== '') {
        agent.inject(await createUserMessage({
          content: [{ type: 'text', text: contextDelta }],
          source: { kind: 'user' },
        }))
      }

      if (seed === true) await this.seedIfNeeded(roomId, botId)

      // Where this turn starts in the derived history. Captured BEFORE the prompt is
      // queued so `readTurn` can ignore every earlier turn, the system prompt and the
      // injected user blocks.
      const turnStart = this.messageCount(roomId, botId)

      const turns = this.opts.repairAttempts
      let reasoning = ''
      let repairs = 0

      for (let attempt = 0; attempt <= turns; attempt++) {
        // THE STOP CHECK COMES FIRST: a repair turn must never be started after the user
        // pressed stop, and a stop during setup/seed has no model request to cancel — this
        // check is what turns that into a clean `stopped` outcome instead of a phantom turn.
        if (SessionRunner.aborted(signal)) return this.abortedOutcome(reasoning, repairs)
        // ── IT MAY HAVE LEFT THE ROOM DURING THE PREVIOUS ATTEMPT ────────────────
        //
        // Observed in a group: the user asked to remove the coordinator, the coordinator
        // executed it (the fix that made that possible), the service stopped this run and retired
        // the session — and the loop then spent THREE repair attempts talking to a session being
        // torn down, ending in "model produced no visible answer text". The bot had done exactly
        // what it was told; the run must end as that, not as a model failure.
        if (!this.accessor.isMember(roomId, botId)) {
          return {
            text: '',
            // No turn to point at any more: the session was retired with the membership.
            // The session was retired with the membership; there is no turn to point at.
            sessionSeq: 0 as SessionSeq,
            reasoning,
            stopReason: 'completed',
            repairs,
            textChannelFailed: false,
            leftRoom: true,
          }
        }
        const text = attempt === 0 ? prompt : this.repairPrompt()
        // The final attempt disables the reasoning channel for its ONE request via
        // an `agent/request` override, so the model has only the text channel left.
        if (attempt >= turns && attempt > 0) this.armTextOnlyRequest(roomId, botId)

        // No prompt is queued after a stop: `followup` would start another model request,
        // which is exactly the "I pressed stop and it kept working" bug.
        if (SessionRunner.aborted(signal)) return this.abortedOutcome(reasoning, repairs)

        // `followup` queues a next-turn prompt and wakes the driver. The source is
        // `user` so the loop treats it as ordinary input; for repairs we mark it as a
        // plugin message so it is distinguishable in the transcript.
        agent.followup(await createUserMessage({
          content: [{ type: 'text', text }],
          // A repair is delivered on the user channel (that is the only channel a
          // followup can use), so `user` is the honest source — the transcript shows
          // it as an ordinary user turn, which is also what the reader expects.
          source: { kind: 'user' },
        }))
        await agent.whenIdle()
        // A cancelled turn resolves `whenIdle` with whatever it had produced; it must not be
        // read as an answer, repaired, or retried — the run settles as interrupted.
        if (SessionRunner.aborted(signal)) return this.abortedOutcome(reasoning, repairs)

        const outcome = this.readTurn(roomId, botId, turnStart)
        reasoning = outcome.reasoning
        if (outcome.text.trim() !== '') {
          return { ...outcome, repairs, textChannelFailed: false }
        }
        // ── A FAILED MODEL CALL IS NOT "THE MODEL SAID NOTHING" ─────────────────────
        //
        // Text-less with no reasoning used to be returned as a SUCCESS, on the theory
        // that the provider's own empty-response retry had already had its turn. When the
        // failure is a request error (404/401/…), that retry cannot help and there is
        // nothing to repair — so the run must fail loudly. Without this the run settled
        // `completed` and republished the previous answer (see `providerFailure`).
        const failure = this.providerFailure(this.sessionOf(roomId, botId) as SessionView)
        if (failure !== undefined) {
          const asConfigured = this.accessor.botById(botId)
          throw new Error(
            `agent-community: 模型请求失败（provider=${asConfigured?.provider ?? '?'} `
            + `model=${asConfigured?.model ?? '?'}）：${failure}`,
          )
        }
        // No visible text. Retry only when there is reasoning to convert — a turn
        // with neither is the provider's EMPTY_RESPONSE case and native retry owns it.
        if (reasoning.trim() === '') {
          return { ...outcome, repairs, textChannelFailed: false }
        }
        repairs = attempt + 1
      }

      // Repairs exhausted. NEVER publish reasoning as the answer — that was a real
      // bug once and it hides the failure from both the reader and the logs.
      return {
        text: '',
        reasoning,
        stopReason: 'completed',
        repairs,
        textChannelFailed: true,
      }
      } finally {
        // The listener must not outlive the turn: the signal belongs to the run, and a
        // stack of stale listeners would call `cancel` on whatever agent the pair holds
        // next time. Removed before the busy flag so an abort cannot race the next run.
        signal?.removeEventListener('abort', onAbort)
        // Same for the progress callback: only this turn's handler may be removed (a later
        // turn registers its own under the same pair key).
        if (onProgress !== undefined && this.progressHandlers.get(key) === onProgress) {
          this.progressHandlers.delete(key)
        }
        // Cleared even on throw, or a failed turn would leave the agent marked busy
        // forever and eviction would never reclaim it.
        this.running.delete(key)
      }
    })
  }

  /**
   * The outcome of a turn the caller aborted.
   *
   * Empty text and `stopped: true`: the executor settles the run as `interrupted`, which is
   * not a failure and must not be retried. Partial output stays in the session log and the
   * ledger rows already streamed, but it is not published as the answer to a task the user
   * stopped.
   */
  private abortedOutcome(reasoning = '', repairs = 0): TurnOutcome {
    return {
      text: '',
      reasoning,
      stopReason: 'aborted',
      repairs,
      textChannelFailed: false,
      stopped: true,
    }
  }

  /**
   * Read what the last settled turn produced.
   *
   * `turnBoundary` is the authority on whether a turn is open. `deriveMessages()`
   * is the authority on what the model actually said — an assistant message with
   * empty content derives to `null` and is absent here, which is exactly the
   * "analysis only" signal.
   */
  /**
   * The answer this turn produced.
   *
   * ONLY the assistant's own messages count, and only those written after the turn
   * began. A session's derived history holds far more than the reply: the system
   * prompt (`system/message`, role `system`), the perception and role blocks this
   * plugin injects (`user/message`, role `user`), runtime context, and every earlier
   * turn. Concatenating all of it — which is what this used to do — produced a
   * "reply" that was the system prompt and the model's private analysis glued to the
   * real answer, and the panel displayed exactly that.
   *
   * The reasoning channel is read separately and never folded into the text: it is the
   * model's private scratchpad, and publishing it as the answer is a content bug, not
   * a formatting one.
   */
  private readTurn(
    roomId: string,
    botId: string,
    fromIndex: number,
  ): { text: string; reasoning: string; stopReason: TurnEndReason } {
    const session = this.sessionOf(roomId, botId)
    if (session === undefined) {
      return { text: '', reasoning: '', stopReason: 'error' }
    }
    const messages = session.deriveMessages()
    const read = (
      slice: readonly { role?: string; content?: unknown }[],
    ): { text: string; reasoning: string } => {
      let text = ''
      let reasoning = ''
      for (const message of slice) {
        // `role` is the discriminator: `deriveMessages` also yields tool results and
        // the injected user/system turns, and only the assistant authored a reply.
        if (message.role !== 'assistant') continue
        const blocks = message.content
        if (!Array.isArray(blocks)) continue
        for (const block of blocks) {
          const b = block as { type?: string; text?: string }
          if (typeof b.text !== 'string') continue
          if (b.type === 'text') text += b.text
          else if (b.type === 'reasoning') reasoning += b.text
        }
      }
      return { text, reasoning }
    }

    const asMessages = messages as unknown as readonly { role?: string; content?: unknown }[]
    const from = Math.max(0, fromIndex)
    let { text, reasoning } = read(asMessages.slice(from))

    // Compaction can rewrite the history between the two reads, which would shift the
    // index; falling back to the newest assistant message WITH TEXT still recovers the
    // answer in that case.
    //
    // ── THE FALLBACK MUST NOT REACH BEFORE THE TURN BEGAN ─────────────────────────
    //
    // It used to search the WHOLE history, so a turn that produced no text at all —
    // a failed model call, most of all — returned the PREVIOUS turn's answer as if it
    // were this one's. Observed on a session whose provider was misconfigured: 60+
    // consecutive turns ended in `turn/end {kind: error, "… request failed (404)"}`,
    // and every one of them still published the same stale reply ("ATTACH-PROBE-4871")
    // while the run reported `completed`. The user sees a bot that answers every
    // question with an old answer and never complains — the hardest kind of failure to
    // notice, and the reason this bound is not negotiable.
    if (text === '' && fromIndex > 0) {
      const lastText = asMessages.slice(from).filter(m => {
        if (m.role !== 'assistant' || !Array.isArray(m.content)) return false
        return (m.content as { type?: string; text?: string }[])
          .some(b => b.type === 'text' && typeof b.text === 'string' && b.text !== '')
      })
      const tail = lastText[lastText.length - 1]
      if (tail !== undefined) ({ text, reasoning } = read([tail]))
    }
    // `stopReason` is reported as `completed` and is deliberately NOT derived from
    // the `turn/end` reason: reading that needs the `turnBoundary` projection, which
    // in turn needs `ctx.sessionProjections` declared in `static inject`. The caller
    // does not consume this field — it decides success from the text below and from
    // the run's own cancellation state — so paying a service dependency for it would
    // buy nothing.
    return { text, reasoning, stopReason: 'completed' as TurnEndReason }
  }

  /** How many messages the pair's session currently holds, or 0 when it is absent. */
  private messageCount(roomId: string, botId: string): number {
    const session = this.sessionOf(roomId, botId)
    if (session === undefined) return 0
    return session.deriveMessages().length
  }

  /** The repair instruction. Escalates: the last one is paired with a text-only request. */
  private repairPrompt(): string {
    return '把上面的分析直接写成给用户的最终回答（中文，不要输出你的思考过程本身）。'
  }

  /**
   * The provider failure this turn ended with, if it ended with one.
   *
   * WHY THIS EXISTS: a turn whose model call fails produces no assistant text, and with
   * no text the runner used to fall through to "the model said nothing" and report
   * success — so a bot whose provider was misconfigured (measured: 60+ consecutive
   * `turn/end {kind: error, "DeepSeek Messages request failed (404)"}`) answered every
   * message with the PREVIOUS turn's text, forever, with no error anywhere. The reader
   * cannot tell that apart from a working bot.
   *
   * The turn's own `turn/end` event is the only place that distinction exists. Reading it
   * through `session.ownEvents()` is marked deprecated for NEW callers in DSH, but it is
   * the synchronous read available here, and it is used strictly as a failure check: when
   * it finds nothing, behaviour is unchanged.
   *
   * Only REQUEST-shaped failures are reported. A reasoning-only turn also ends as `error`
   * — that is the case the repair prompt exists to fix, and it must keep going.
   *
   * @param session - the pair's session view.
   * @returns the provider's message, or undefined when the turn did not fail that way.
   */
  private providerFailure(session: SessionView): string | undefined {
    const withEvents = session as unknown as {
      ownEvents?(): readonly { type?: string; data?: { reason?: { kind?: string; error?: { message?: string } } } }[]
    }
    const events = withEvents.ownEvents?.()
    if (events === undefined) return undefined
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type !== 'turn/end') continue
      const reason = event.data?.reason
      if (reason?.kind !== 'error') return undefined
      const message = reason.error?.message ?? ''
      // A provider/transport/config rejection, not an internal "the model chose not to speak".
      const looksLikeRequestFailure = looksLikeProviderRejection(message)
      return looksLikeRequestFailure ? message : undefined
    }
    return undefined
  }

  /**
   * Arm a ONE-SHOT "no reasoning level" override for this agent's next request.
   *
   * `agent/request` is a waterfall whose default returns the config proposal, so a
   * listener can rewrite it. Doing it here — rather than changing the bot's own
   * reasoning setting — keeps the user's configuration untouched and affects exactly
   * one request, which is the whole point of the recovery: with the reasoning
   * channel unavailable the model must write into the text channel. The override
   * REMOVES the field (provider default) rather than forcing `'off'`, because a model
   * that publishes no levels rejects every value — including `'off'` — before the
   * request is sent, which would turn our own repair into a fake model failure.
   */
  private armTextOnlyRequest(roomId: string, botId: string): void {
    const key = SessionRunner.key(roomId, botId)
    this.textOnlyArmed.add(key)
  }

  private readonly textOnlyArmed = new Set<string>()

  /**
   * Register the per-agent `agent/request` override in the agent's own scope.
   *
   * Scoped registration matters: the listener disappears with the agent's scope on
   * dispose, so no global state accumulates and one bot's repair can never affect
   * another's request.
   */
  private installRequestOverride(agentCtx: Context, key: string): void {
    const svc = (agentCtx as unknown as {
      on?(
        event: string,
        handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
        opts?: { prepend?: boolean; global?: boolean },
      ): () => void
    })
    if (typeof svc.on !== 'function') return
    svc.on('agent/request', async (_payload, next) => {
      // ── THE MASK HAS TO BE RE-APPLIED, NOT JUST APPLIED ONCE ──────────────────
      //
      // The deny ran in `setup` when the agent was created, but the Agent Teams tools
      // (`list_agents`, `send_message`, `interrupt_agent`) are mounted by the profile's
      // `tool-agent-team` row AFTER that, into the same scope — and a restriction that ran before
      // a tool existed cannot hide it. Observed: those three sat in a bot's catalog while
      // `botDeniedTools` listed all three. Re-applying here, on every request, closes the ordering
      // hole; already-applied names are skipped so DSH's append-only restriction list cannot grow
      // without bound, and previously-skipped names are retried in case they registered late.
      this.reapplyToolMask(agentCtx, key)
      const config = await next() as Record<string, unknown>
      if (!this.textOnlyArmed.delete(key)) return config
      // ── ASK FOR THE PROVIDER DEFAULT, NOT FOR `'off'` ─────────────────────────
      //
      // This one-shot override exists so the repaired request writes into the TEXT channel. It
      // used to force `reasoningEffort: 'off'`, which is the same trap `ensureAgent` fell into:
      // a model that publishes no reasoning levels rejects the field *whatever* its value, so
      // the repair round died with `UNSUPPORTED_REASONING_EFFORT` and the run reported
      // "reasoning-only after N repair attempt(s)" — a model fault invented by our own override.
      // Dropping the field asks for the provider default, which at least lets the request run.
      const repaired = { ...config }
      delete repaired.reasoningEffort
      return repaired
    }, { prepend: true })
  }

  /**
   * Return the live agent for a pair, creating or resuming it as needed.
   *
   * `resume` is tried first so an agent that was evicted comes back with its
   * history. NOTE: `ResumeAgentOptions` requires `resumeSessionId` — the old host
   * runner passed `sessionId`, so its resume always threw and silently fell back to
   * create, which is why host memory did not survive a restart. The correct field is
   * used here.
   */
  private async ensureAgent(roomId: string, botId: string): Promise<Agent> {
    const key = SessionRunner.key(roomId, botId)
    const live = this.agents.get(key)
    if (live !== undefined) return live

    const bot = this.accessor.botById(botId)
    if (bot === undefined) throw new Error(`agent-community: bot "${botId}" no longer exists`)
    if (bot.provider === undefined || bot.model === undefined) {
      throw new Error(`agent-community: bot ${bot.name} has no provider/model configured`)
    }

    const agentsSvc = (this.ctx as unknown as {
      agents?: {
        resume?(opts: unknown): Promise<AgentCreationResult>
        create(opts: unknown): Promise<AgentCreationResult>
      }
    }).agents
    if (agentsSvc === undefined) {
      throw new Error('agent-community: ctx.agents is unavailable — cannot run a bot turn')
    }

    const sessionId = this.accessor.sessionIdFor(roomId, botId)
    const configured = bot.workspace !== undefined && bot.workspace !== ''
      ? bot.workspace
      : await this.accessor.defaultWorkspace()

    // ── THE WORKSPACE MUST ACTUALLY EXIST ──────────────────────────────────────
    //
    // It becomes the session's `cwd`, and a `cwd` pointing at a missing directory
    // makes session creation fail outright: the run then "completes" in the same
    // second it started, with no session on disk and no reply for the user.
    //
    // This is not hypothetical — `botWorkspaceDir()` only BUILDS the path
    // (`join(root, botId)`) and nothing ever created it, so every bot on a default
    // workspace pointed at a directory that did not exist. That is why some bots
    // answered and others were silent in the same room.
    //
    // Created here rather than only at bot-creation time so the invariant holds for
    // every path that can produce a workspace: an imported bot, a profile edited on
    // disk, or a directory the user removed while the app was running.
    await mkdir(configured, { recursive: true }).catch(() => undefined)
    const workspace = configured

    const agentOptions = {
      provider: bot.provider,
      model: bot.model,
      ...(bot.reasoningEffort !== undefined && bot.reasoningEffort !== ''
        ? { reasoningEffort: bot.reasoningEffort }
        : {}),
    }
    // A session resumed from an older build carries NO preset in its header — presets are
    // recorded at creation and `ResumeAgentOptions` has no meta field — so an existing
    // bot would keep its 31-tool world forever. Mounting into the agent's own scope is
    // the same call the loop makes for `meta.agentPreset`, and it is idempotent for a
    // session that already has one (skipped here).
    const preset = await this.resolvePresetId()
    const existingPreset = this.sessionOf(roomId, botId)?.header?.agentPreset
    const mountPreset = preset !== undefined && preset !== '' && existingPreset === undefined
    const setup = async (agentCtx: Context): Promise<void> => {
      this.installRequestOverride(agentCtx, key)
      if (mountPreset) await this.mountAgentPreset(agentCtx, preset)
      this.installAgentTeamsGuard(agentCtx, key)
      const deny = this.opts.deniedTools
      if (deny !== undefined && deny.length > 0) {
        const mask = restrictGlobalTools(agentCtx, deny)
        // ONE LINE OF TRUTH about the mask. A skipped name used to be invisible: the whole
        // restriction silently did nothing while the catalog still showed the tools.
        this.ctx.logger?.info?.(
          `agent-community: bot tool mask room=${roomId} bot=${botId} `
          + `applied=[${mask.applied.join(',')}] skipped=[${mask.skipped.join(',')}]`,
        )
        this.noteToolMask(
          `initial room=${roomId} bot=${botId} applied=[${mask.applied.join(',')}] `
          + `skipped=[${mask.skipped.join(',')}]`,
        )
      }
      // Collaboration tools are installed AFTER the mask on purpose: they are scoped
      // registrations, and DSH keeps those visible through a global deny — which is what
      // makes the plugin's own `ask_user_question`/`skill` work while the host's stay hidden.
      this.opts.setupAgent?.(agentCtx, roomId, botId)

      // ── THE PROMPT THIS BOT ACTUALLY NEEDS ───────────────────────────────────
      //
      // The preset's prompt describes a coding agent in a workspace: Agent Teams, hidden
      // subagent fleets, a deliverables panel, a Web GUI. A room Bot answers in a room. The
      // plugin's eight sections are registered in THIS agent scope (scoped sections shadow
      // global ones) and five inapplicable global sections are blanked by name — see
      // bot-prompt.ts for which and why.
      const bot = this.accessor.botById(botId)
      // WHO IS IN CHARGE HERE, stated per bot. The room's coordinator decides who may invite,
      // remove, dispatch and finish; a bot that cannot see whether that is IT will refuse work it
      // actually owns (measured: the leader told the user "我自己做不到" when asked to remove a
      // member — the removal it alone could perform).
      const leaderId = this.accessor.leaderOf(roomId)
      const prompt = installBotPrompt(agentCtx, {
        botName: bot?.name ?? 'Bot',
        botDescription: bot?.description ?? '',
        isLeader: leaderId !== undefined && leaderId === botId,
        ...(leaderId !== undefined && leaderId !== botId
          ? { leaderName: this.accessor.botName(leaderId) }
          : {}),
      })
      this.ctx.logger?.info?.(
        `agent-community: bot prompt room=${roomId} bot=${botId} `
        + `applied=[${prompt.applied.join(',')}] shadowed=[${prompt.shadowed.join(',')}] `
        + `skipped=[${prompt.skipped.join(',')}]`,
      )
    }
    // ── THE VISIBILITY SOLUTION ────────────────────────────────────────────────
    //
    // TWO independent things are needed, and they do NOT conflict:
    //
    // 1. `origin: 'subagent'` makes the session invisible. `sessionVisible` tests it
    //    FIRST and returns false before consulting anything else:
    //        function sessionVisible(session, current, archived, archivedFilter) {
    //          if (session.origin === "subagent") return false;   // unconditional
    //          ...
    //        }
    //    With NO `parentSession`, the admission gate also passes it through:
    //        if (header.origin !== "subagent" || header.parentSession === void 0) return false;
    //    So the session is hidden AND fully runnable — unlike archiving, which hides it
    //    but makes the gate reject every step, ending each turn as `blocked` with no
    //    model request.
    //
    // 2. `cwd` is REQUIRED and is safe to pass. It is not a hiding mechanism at all —
    //    it only decides which on-disk bucket the log lands in. DSH's system prompt
    //    assembly fails outright without it:
    //        prompt variable "{{cwd}}" has no value for this assembly
    //        (section "deployment:persona-suffix")
    //    which surfaces to the user as a turn that errors with no reply. Omitting it
    //    was a real bug: origin-hiding already covers visibility, so there was never a
    //    reason to drop the working directory too.
    const meta = {
      origin: 'subagent' as const,
      cwd: workspace,
      ...(preset !== undefined && preset !== '' ? { agentPreset: preset } : {}),
    }

    const sessionIdForPair = this.accessor.sessionIdFor(roomId, botId)
    // Wait out any disposal still in flight for this pair (see `disposal`).
    const pending = this.disposal.get(sessionIdForPair)
    if (pending !== undefined) {
      try {
        await pending
      } catch {
        // A failed disposal must not block the new run; fall through and rebuild.
      }
    }

    const services = this.ctx as unknown as {
      agents?: { get?(id: string): Agent | undefined }
    }

    // Adopt an agent that is ALREADY live for this id.
    //
    // Both other paths assume they are the only owner. `resume` refuses a session it
    // cannot take write ownership of, and `create` throws `session "<id>" already
    // exists` when the store still holds it — so a leftover handle used to leave the
    // bot permanently unrunnable with that error. Reusing the live agent is correct:
    // its session and history are exactly the ones this pair should be using.
    const adopted = this.findLiveAgent(services, sessionId)
    if (adopted !== undefined) {
      this.agents.set(key, adopted)
      // The disposer stays whatever it already is: this runner only knows a disposer
      // for an agent IT materialised, and adopting a foreign one must not invent a
      // second owner for a session we do not hold.
      this.touch(key)
      return adopted
    }

    let result: AgentCreationResult | undefined
    let resumeError: unknown
    if (typeof agentsSvc.resume === 'function') {
      try {
        result = await agentsSvc.resume({ resumeSessionId: sessionId, agentOptions, setup })
      } catch (error: unknown) {
        resumeError = error
      }
    }
    if (result === undefined) {
      try {
        result = await agentsSvc.create({ sessionId, meta, agentOptions, setup })
      } catch (error: unknown) {
        // `create` rejects with `session "<id>" already exists` when the store still
        // holds the id — which happens after the log is deleted, because deleting the
        // file does not evict a session the runtime already has. `resume` is the way
        // back in, so retry it now that the create attempt has run, and only report a
        // failure if BOTH paths refuse. The message names both causes so the next
        // reader does not have to rediscover this.
        if (/already exists/.test(String(error))) {
          try {
            result = await agentsSvc.resume!({ resumeSessionId: sessionId, agentOptions, setup })
          } catch {
            // The session is already open for writing somewhere we cannot reach: either
            // another DSH runtime on this machine holds its write lease (each bot's
            // session is locked for the whole life of the agent in that process), or
            // this process still holds a handle the registry no longer knows about.
            // Naming the remedy matters — the raw pair of exceptions below is what the
            // user saw as an unexplained red "运行失败" on every retry.
            throw new Error(
              `agent-community: session ${sessionId} 已被另一个运行时打开用于写入（或本进程仍持有旧句柄），`
              + `因此这个 Bot 现在无法运行。请关闭其它 DSH 窗口 / CLI 实例后重试，或重启应用。`
              + ` (resume: ${String(resumeError)}; create: ${String(error)})`,
            )
          }
        } else {
          throw error
        }
      }
    }

    // NOTE: deliberately NOT hidden here. Hiding archives the session, and an
    // archived session is refused by the admission gate on every step — hiding at
    // creation would make the bot permanently mute. The session is hidden after each
    // turn instead (see `run`).

    this.agents.set(key, result.agent)
    // The factory's own disposer — see `disposerOf` for why reading `.handle` here
    // left every session lease open until process exit.
    this.handles.set(key, disposerOf(result))
    // The bot's own permission decides the session's sandbox/approval knobs. Mapping
    // 'full-access' → the deployment's `danger-full-access` preset is what lets bash and
    // the file tools actually touch the filesystem instead of being denied by the
    // sandbox — the runtime half of "bots may use DSH's tools".
    this.applyPermissionPreset(roomId, botId)
    this.touch(key)
    return result.agent
  }

  /**
   * The live agent for a session id, however the host lets us see it.
   *
   * `registry.get(id)` is the direct route and `dsh-agent` does expose it — but a runtime
   * that does not, or that keys the agent under something other than the exact id we
   * derived, leaves the session owned by a write handle we can neither resume nor
   * recreate. Every later run for that room+bot then dies with
   *
   *   session ac:<room>:<bot> is held by the runtime and cannot be resumed, so this bot
   *   cannot run (resume: SessionAlreadyOwnedError …; create: SessionAlreadyExistsError …)
   *
   * which is exactly what a user sees as a red "运行失败" banner on every retry. Asking
   * the registry the long way — enumerate and compare `agent.sessionId`, the field
   * `Agent` declares — answers the same question on both runtimes, and adopting the live
   * agent is always better than materialising a second one for the same session.
   */
  private findLiveAgent(
    services: { agents?: { get?(id: SessionId): Agent | undefined; list?(): Agent[] } },
    sessionId: SessionId,
  ): Agent | undefined {
    const direct = services.agents?.get?.(sessionId)
    if (direct !== undefined) return direct
    const all = services.agents?.list?.()
    if (all === undefined) return undefined
    return all.find(agent => (agent as { sessionId?: SessionId }).sessionId === sessionId)
  }

  /** The live Session for a pair, or undefined when the agent is not materialised. */
  private sessionOf(roomId: string, botId: string): SessionView | undefined {
    const sessions = (this.ctx as unknown as {
      sessions?: { get(id: string): SessionView | undefined }
    }).sessions
    if (sessions === undefined) return undefined
    return sessions.get(this.accessor.sessionIdFor(roomId, botId) as unknown as string)
  }

  /**
   * Mount a deployment agent preset into ONE agent's scope.
   *
   * `ctx.agentPresets.mount` is the same call the loop makes when a session is created
   * with `meta.agentPreset`; doing it in `setup` is what upgrades a session that was
   * created before this plugin knew about presets.
   */
  /**
   * The preset this bot session should run under, or `undefined` to use the deployment default.
   *
   * The plugin ships its own `bot` preset, but "the plugin must not require a particular DSH
   * version" is a standing requirement: a host whose roster does not offer it (older DSH, a user
   * who deleted `<DSH_HOME>/.agent-presets/bot`, a deployment that supplies its own presets)
   * must still get working bots rather than sessions that refuse to start. So the roster is
   * asked first and an unknown preset degrades to "no preset" — the behaviour every bot had
   * before presets were wired up at all.
   *
   * The roster API is probed defensively (`has(id)`, then `has(ctx, id)`): the package is
   * resolved from the host, so its exact signature is not ours to pin, and a probe that throws
   * must not take a bot down with it.
   */
  private async resolvePresetId(): Promise<string | undefined> {
    const preset = this.opts.agentPreset
    if (preset === undefined || preset === '') return undefined
    type Roster = { has?: (...args: unknown[]) => unknown }
    const roster = (optionalService<Roster>(this.ctx, 'agentPresets')
      ?? safeProperty<Roster>(this.ctx, 'agentPresets'))
    if (roster?.has === undefined) return preset
    for (const args of [[preset], [this.ctx, preset]]) {
      try {
        const answer = await roster.has(...args)
        if (answer === false) {
          this.notePresetMount(`skip preset=${preset} reason=not-in-roster`)
          return undefined
        }
        if (answer === true) return preset
      } catch {
        // A different signature threw; try the next shape, then give up and keep the preset.
      }
    }
    return preset
  }

  /** Names already restricted for this session, so the per-request re-apply stays bounded. */
  private readonly maskApplied = new Map<string, Set<string>>()

  /**
   * Re-apply the deny mask for tools that registered after the one-shot pass in `setup`.
   *
   * Idempotent by construction: DSH appends restrictions, so re-restricting an applied name is
   * wasteful and unbounded, while a name that was unknown at setup time (and therefore skipped)
   * may exist now. Only the difference is sent.
   */
  private reapplyToolMask(agentCtx: Context, key: string): void {
    const deny = this.opts.deniedTools
    if (deny === undefined || deny.length === 0) return
    const applied = this.maskApplied.get(key) ?? new Set<string>()
    const pending = deny.filter(name => !applied.has(name))
    if (pending.length === 0) return
    const result = restrictGlobalTools(agentCtx, pending)
    for (const name of result.applied) applied.add(name)
    this.maskApplied.set(key, applied)
    if (result.applied.length > 0 || result.skipped.length > 0) {
      // ONE LINE OF TRUTH about a late registration: without it, "the tool is still there" has no
      // trace at all and looks like the mask is broken rather than early.
      this.noteToolMask(
        `re-apply applied=[${result.applied.join(',')}] still-skipped=[${result.skipped.join(',')}]`,
      )
    }
  }

  /**
   * Refuse the Agent Teams tools inside this bot's scope (§ see {@link AGENT_TEAMS_TOOLS}).
   *
   * Registered on the agent's own ctx, so it cannot affect the user's main session — which keeps
   * Agent Teams exactly where it belongs.
   */
  private installAgentTeamsGuard(agentCtx: Context, key: string): void {
    type GuardHost = { guard?(check: (exec: unknown) => string | undefined): unknown }
    const tools = optionalService<GuardHost>(agentCtx, 'tools') ?? safeProperty<GuardHost>(agentCtx, 'tools')
    if (tools?.guard === undefined) {
      this.noteToolMask(`guard unavailable scope=${key} (no tools.guard on this runtime)`)
      return
    }
    try {
      tools.guard((exec) => {
        const refusal = agentTeamsDenial(exec)
        if (refusal !== undefined) {
          // A refusal is worth a line: it is the difference between "the model found another way"
          // and "the model tried the wrong tool and was told why".
          this.noteToolMask(`denied tool=${toolNameOf(exec) ?? '?'} scope=${key}`)
        }
        return refusal
      })
      this.noteToolMask(`guard installed deny=[${AGENT_TEAMS_TOOLS.join(',')}] scope=${key}`)
    } catch (error: unknown) {
      this.noteToolMask(`guard FAILED scope=${key} error=${String(error)}`)
    }
  }

  private async mountAgentPreset(agentCtx: Context, preset: string): Promise<void> {
    type Registry = { mount?(ctx: Context, id?: string): Promise<unknown> }
    // ── THE SERVICE LIVES OUTSIDE THE AGENT'S ISOLATED SCOPE ──────────────────
    //
    // `mount(ctx, id)` binds the preset to the ctx passed in (the agent scope), but the
    // SERVICE must be read from a context that can actually see it. An agent context is
    // isolated, so both `agentCtx.get('agentPresets')` and `agentCtx.agentPresets` come
    // back empty/throw — which is why a plain mount attempt was a silent no-op and the
    // bots kept their 31 tools. Read it from the PLUGIN's context instead, and fall back
    // to cordis's `inject()` (the documented optional-dependency path) when even that
    // does not resolve yet.
    const candidates: Array<[string, Registry | undefined]> = [
      ['plugin.get', optionalService<Registry>(this.ctx, 'agentPresets')],
      ['plugin.prop', safeProperty<Registry>(this.ctx, 'agentPresets')],
      ['agent.get', optionalService<Registry>(agentCtx, 'agentPresets')],
      ['agent.prop', safeProperty<Registry>(agentCtx, 'agentPresets')],
    ]
    for (const [via, registry] of candidates) {
      if (registry?.mount === undefined) continue
      try {
        await registry.mount(agentCtx, preset)
        this.notePresetMount(`ok preset=${preset} via=${via}`)
        return
      } catch (error: unknown) {
        this.notePresetMount(`FAIL preset=${preset} via=${via} error=${String(error)}`)
      }
    }
    // Nothing resolved synchronously. `ctx.inject` runs the callback as soon as the
    // service exists — the mount then lands between turns, so the bot picks the preset
    // up on its NEXT request instead of never.
    const inject = (this.ctx as unknown as {
      inject?: (deps: string[], cb: (scoped: Context) => void) => unknown
    }).inject
    if (typeof inject === 'function') {
      try {
        // Record that we are WAITING: without this line a never-firing callback left no
        // trace at all, which is indistinguishable from "nothing was attempted".
        this.notePresetMount(`pending preset=${preset} via=inject (agentPresets not available synchronously)`)
        inject.call(this.ctx, ['agentPresets'], (scoped: Context) => {
          const registry = optionalService<Registry>(scoped, 'agentPresets') ?? safeProperty<Registry>(scoped, 'agentPresets')
          if (registry?.mount === undefined) {
            this.notePresetMount(`FAIL preset=${preset} via=inject: no service`)
            return
          }
          void registry.mount(agentCtx, preset).then(
            () => this.notePresetMount(`ok preset=${preset} via=inject`),
            (error: unknown) => this.notePresetMount(`FAIL preset=${preset} via=inject error=${String(error)}`),
          )
        })
        return
      } catch (error: unknown) {
        this.notePresetMount(`FAIL preset=${preset} via=inject threw ${String(error)}`)
      }
    }
    this.notePresetMount(`FAIL preset=${preset} no resolver for agentPresets`)
  }

  /**
   * Record the preset-mount outcome in a small append-only file.
   *
   * The host keeps plugin logger output in memory, so a silent no-op here is invisible
   * from outside the process — and an invisible no-op is exactly how the first version
   * shipped without giving any bot a single new tool. One line per attempt, capped, in
   * the plugin's own data directory.
   */
  /**
   * Record what the tool mask actually did, in a file a human can read.
   *
   * WHY. The acceptance checklist asks a reviewer to confirm "the bot's catalog no longer lists X"
   * by reading a log line — and that line went to the plugin's logger, which this deployment does
   * not surface anywhere (measured: nothing from `agent-community:` reaches the host's stdout or
   * `~/Library/Logs`). The mask therefore had NO readable trace at all, which is exactly the state
   * in which "the tool is still there" cannot be told apart from "the restriction was skipped
   * because DSH keeps scope-local registrations visible".
   *
   * Same file-and-append shape as {@link notePresetMount}: diagnostics must never break a run.
   */
  private noteToolMask(line: string): void {
    // Optional chaining on purpose: this is a diagnostic, and it must stay harmless even when
    // called before the fields exist.
    const dir = this.opts?.presetLogDir
    if (dir === undefined) return
    try {
      appendFileSync(join(dir, 'tool-mask.log'), `${new Date().toISOString()} ${line}\n`)
    } catch {
      // Diagnostics must never break a run.
    }
  }

  private notePresetMount(line: string): void {
    const dir = this.opts?.presetLogDir
    if (dir === undefined) return
    try {
      appendFileSync(join(dir, 'preset-mount.log'), `${new Date().toISOString()} ${line}\n`)
    } catch {
      // Diagnostics must never break a run.
    }
  }

  /**
   * Apply the bot's permission to its session (sandbox + approval policy).
   *
   * The bot model has carried `permission` since it was written; with the native-session
   * executor nothing consumed it, so every bot ran under whatever the deployment's
   * default happened to be. Mapping through `permissionPresets` is the documented path
   * (`set(session, name)`), and an unknown name in a custom deployment is ignored.
   */
  private applyPermissionPreset(roomId: string, botId: string): void {
    const bot = this.accessor.botById(botId)
    const permission = bot?.permission
    if (permission === undefined || permission === '') return
    const svc = optionalService<{ set?(session: unknown, name: string): void }>(
      this.ctx, 'permissionPresets',
    )
    const session = this.sessionOf(roomId, botId)
    if (svc?.set === undefined || session === undefined) return
    const name = permissionPresetName(permission)
    try {
      svc.set(session, name)
    } catch (error: unknown) {
      this.ctx.logger?.warn?.(
        `agent-community: permission preset "${name}" is not available in this deployment: ${String(error)}`,
      )
    }
  }

  /**
   * Whether an agent must not be evicted.
   *
   * Three ways to be busy, and all three matter:
   *   · an open turn            — it is working right now
   *   · an open step            — covers the compaction window, which runs in the
   *                               `maintenance` phase and reports `idle` via `status`
   *   · a non-empty inbox       — disposing would drop a queued prompt
   */
  private isBusy(key: string): boolean {
    return this.running.has(key)
  }

  private touch(key: string): void {
    this.tick += 1
    this.lastUsed.set(key, this.tick)
  }

  /**
   * Make room before materialising another agent.
   *
   * Two levels, per the user's decision: keep at most `idleLimit` agents alive, but
   * let RUNNING agents push the total to `hardLimit`. Past the hard limit the caller
   * waits — the loop below polls rather than evicting a working agent, because
   * evicting one would kill a task in flight.
   */
  private async ensureSlot(signal?: AbortSignal): Promise<boolean> {
    await this.evictIdle()
    const deadline = Date.now() + 10 * 60_000
    while (!this.disposed && this.agents.size >= this.opts.hardLimit) {
      // A stop must not wait behind the hard limit: the queued turn never started, and the
      // run loop turns `false` into a `stopped` outcome.
      if (SessionRunner.aborted(signal)) return false
      if (Date.now() > deadline) {
        throw new Error(
          `agent-community: no free agent slot after 10 minutes (live=${this.agents.size} `
          + `hardLimit=${this.opts.hardLimit})`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
      await this.evictIdle()
    }
    return !SessionRunner.aborted(signal)
  }

  /** Dispose least-recently-used IDLE agents until the idle count fits the budget. */
  private async evictIdle(): Promise<void> {
    if (this.agents.size <= this.opts.idleLimit) return
    const idle = [...this.agents.keys()]
      .filter((key) => !this.isBusy(key))
      .sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0))
    let excess = this.agents.size - this.opts.idleLimit
    for (const key of idle) {
      if (excess <= 0) break
      await this.releaseKey(key)
      excess -= 1
    }
  }

  /** Dispose one agent. Its session log stays on disk, so `resume` restores memory. */
  async releaseKey(key: string): Promise<void> {
    const handle = this.handles.get(key)
    this.agents.delete(key)
    this.handles.delete(key)
    this.lastUsed.delete(key)
    this.textOnlyArmed.delete(key)
    if (handle !== undefined) {
      try {
        await handle.dispose()
      } catch {
        // Best-effort: a failed dispose must not block the eviction path.
      }
    }
  }

  /** Dispose every agent for a room. Used on room deletion and on clearing messages. */
  async disposeRoom(roomId: string): Promise<void> {
    const work = (async () => {
      for (const key of [...this.agents.keys()]) {
        if (SessionRunner.split(key).roomId === roomId) await this.releaseKey(key)
        if (SessionRunner.split(key).roomId === roomId) this.seeded.delete(key)
      }
    })()
    this.trackDisposal(work, roomId, undefined)
    await work
  }

  /** Dispose every agent for a bot, in every room. Used on bot deletion. */
  async disposeBot(botId: string): Promise<void> {
    const work = (async () => {
      for (const key of [...this.agents.keys()]) {
        if (SessionRunner.split(key).botId === botId) await this.releaseKey(key)
      }
    })()
    this.trackDisposal(work, undefined, botId)
    await work
  }

  /**
   * Record a disposal so a run starting concurrently waits for it.
   *
   * Registered under the session ids the disposal will retire — both the ones known
   * right now and the pair's deterministic id, which is what a new run would reuse.
   * The entry is dropped once the promise settles, so the map never grows.
   */
  private trackDisposal(work: Promise<void>, roomId: string | undefined, botId: string | undefined): void {
    const ids = new Set<string>()
    for (const key of this.agents.keys()) {
      const parsed = SessionRunner.split(key)
      if (roomId !== undefined && parsed.roomId !== roomId) continue
      if (botId !== undefined && parsed.botId !== botId) continue
      ids.add(this.accessor.sessionIdFor(parsed.roomId, parsed.botId))
    }
    if (roomId !== undefined && botId !== undefined) ids.add(this.accessor.sessionIdFor(roomId, botId))
    const settled = work.catch(() => undefined).then(() => {
      for (const id of ids) this.disposal.delete(id)
    })
    for (const id of ids) this.disposal.set(id, settled)
  }

  /**
   * Drop the "already seeded" mark for a room so the next session replays the
   * CURRENT history.
   *
   * Called when the user clears a room's messages: the transcript is gone, so the
   * bot must not keep remembering it. Without this the bot would answer from
   * content the user deleted — a content leak, not just a stale cache.
   */
  forgetRoom(roomId: string): void {
    for (const key of [...this.seeded]) {
      if (SessionRunner.split(key).roomId === roomId) this.seeded.delete(key)
    }
  }

  /** Every session id this runner currently owns — for visibility reconciliation. */
  liveSessionIds(): SessionId[] {
    return [...this.agents.keys()].map((key) => {
      const { roomId, botId } = SessionRunner.split(key)
      return this.accessor.sessionIdFor(roomId, botId)
    })
  }

  /** Dispose everything. Called on plugin teardown. */
  async disposeAll(): Promise<void> {
    this.disposed = true
    // Drop the global observers with the runner: a listener left on the host bus would keep
    // this (dead) instance alive and call into a disposed progress map.
    try {
      this.progressUninstall?.()
    } catch {
      // Best-effort teardown: the host may already have dropped the bus.
    }
    this.progressUninstall = undefined
    this.progressHandlers.clear()
    for (const key of [...this.agents.keys()]) await this.releaseKey(key)
  }

  /**
   * Replay the room's recent history into a freshly created session.
   *
   * A brand-new session has no memory, but the room transcript still exists
   * (decision: history persists until the user clears it), so the bot must be given
   * what the user can see. `inject` adds model-facing context WITHOUT waking the
   * driver, which is exactly right here: we want the memory present, not a turn.
   *
   * Seeding appends to the tail, so it does not disturb the (empty) prefix.
   */
  async seedIfNeeded(roomId: string, botId: string): Promise<void> {
    const key = SessionRunner.key(roomId, botId)
    if (this.seeded.has(key)) return
    const agent = this.agents.get(key)
    if (agent === undefined) return
    const history = this.accessor.historyFor(roomId, this.opts.seedMessages)
    this.seeded.add(key)
    if (history.length === 0) return
    const transcript = history
      .map((m) => `${m.senderName}: ${m.text}`)
      .join('\n')
    agent.inject(await createUserMessage({
      content: [{ type: 'text', text: `[房间历史摘要]\n以下是本房间此前的对话，供你了解上下文：\n${transcript}` }],
      source: { kind: 'user' },
    }))
  }
}

/**
 * Remove GLOBAL tools from one agent's view.
 *
 * `tools.restrict` is scope-local and only masks global registrations, so the
 * plugin's own scoped tools (the community families) survive untouched. A deployment
 * without the tools service simply keeps every tool.
 */
export function restrictGlobalTools(
  agentCtx: Context,
  deny: readonly string[],
): { readonly applied: readonly string[]; readonly skipped: readonly string[] } {
  const tools = optionalService<{ restrict?(filter: { deny: readonly string[] }): unknown }>(agentCtx, 'tools')
  if (tools?.restrict === undefined) return { applied: [], skipped: [...deny] }
  const applied: string[] = []
  const skipped: string[] = []
  for (const name of deny) {
    try {
      // ONE NAME PER CALL, and that is the whole point of this function.
      //
      // `tools.restrict()` validates the ENTIRE filter first and rejects the call when any
      // name is unknown to the scope ("names unknown global tool ...; known global tools:"),
      // and the old code called it once inside a bare `catch {}`. Observed on a real bot
      // session: its tool catalog still listed `ask_user_question` and `skill` even though
      // both sat in `botDeniedTools` — one name the scope did not know about (the plugin
      // registers its OWN tool of that name after this runs) discarded the whole mask.
      //
      // DSH appends restrictions, so per-name calls intersect to exactly the intended mask;
      // the only difference is that a bad name now costs one name instead of all of them.
      tools.restrict({ deny: [name] })
      applied.push(name)
    } catch {
      // Either the name is unknown to this scope, or it names a tool the plugin registered
      // in the agent scope itself — and those stay visible by design (`restrict` cannot and
      // must not hide a scoped registration). Recorded, not thrown: a stale entry in a
      // deployment's deny list must not stop a bot from starting.
      skipped.push(name)
    }
  }
  return { applied, skipped }
}

/**
 * Map the bot's permission vocabulary onto the deployment's preset names.
 *
 * The bot model says `full-access`; the permission presets call that sandbox
 * `danger-full-access`. The other two names are identical in both vocabularies, so the
 * mapping is deliberately total and pure — the caller only has to ignore an unknown
 * name in a custom deployment.
 */
export function permissionPresetName(permission: string): string {
  return permission === 'full-access' ? 'danger-full-access' : permission
}

/**
 * Read an OPTIONAL service from a context without tripping cordis's inject gate.
 *
 * `ctx.agentPresets` is a typed property gated by `static inject`: reading a name that
 * is not injected throws `cannot get property "X" without inject` — which is exactly how
 * sending a message started failing, because the mount ran on the AGENT's context, whose
 * inject list this plugin does not own.
 *
 * `ctx.get(name)` is cordis's own escape hatch ("read a service from the store without
 * the inject requirement"), so it is tried first; the property access stays as a fallback
 * for a build where `get` is unavailable. Both are guarded, and every failure returns
 * `undefined` — a missing optional service must never break a bot turn.
 */
export function optionalService<T>(ctx: Context, name: string): T | undefined {
  const holder = ctx as unknown as { get?(n: string): unknown } & Record<string, unknown>
  try {
    const viaGet = holder.get?.(name)
    if (viaGet !== undefined && viaGet !== null) return viaGet as T
  } catch {
    // `get` itself refused (or does not exist on this context): fall through.
  }
  try {
    const viaProperty = holder[name]
    if (viaProperty !== undefined && viaProperty !== null) return viaProperty as T
  } catch {
    // Not injected on this context — the caller treats that as "service absent".
  }
  return undefined
}

/** Property read that tolerates cordis's inject gate. */
function safeProperty<T>(ctx: Context, name: string): T | undefined {
  try {
    const value = (ctx as unknown as Record<string, unknown>)[name]
    return value === null ? undefined : value as T | undefined
  } catch {
    return undefined
  }
}
