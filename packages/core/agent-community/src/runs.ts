/**
 * Bot run executor — claims queued runs, calls the model directly, executes any
 * tools the model asks for, and settles the result back into community state.
 *
 * Bot turns deliberately do NOT go through DSH's Agent/Session pipeline: a
 * Session is persisted and listed in DSH's sidebar, and Bot Community rooms must
 * never appear there. `ctx.llm.stream()` plus the in-process ToolRunner keeps the
 * entire loop inside the plugin, with the ledger as its only record.
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  BotId,
  BotIdentity,
  BotRoomId,
  BotRunId,
  BotMessageId,
  DeliveredFile,
  RunEvidence,
} from './types.ts'
import { VisibilityController } from './visibility.ts'
import { toolSchemas, ToolRunner, type ToolInvocation } from './tools.ts'
import { buildPerception, type Perception, type PerceptionValue } from './perception.ts'
import { optionalService } from './session-runner.ts'
import { renderMemoryDelta } from './bot-memory.ts'
import { buildHistoryWindow } from './context-window.ts'
import {
  assemblePrompt,
  historyHeader,
  inputBlock,
  type PromptSections,
} from './prompt-contract.ts'
import { buildRunEvidence, classifyFaultSide, finishPathOf } from './run-evidence.ts'
import { estimateTokens, sectionStats } from './context-cost.ts'
import type { ProgressKind, SessionRunner } from './session-runner.ts'
import type { LedgerProjector } from './ledger.ts'
import {
  classifyFailure,
  deriveDeadlineBudget,
  isRetryableFailureKind,
  nextExtensionDeadline,
  noProgressLimitMs,
  percentile,
  resolveRetryPolicy,
  resolveTimeoutPolicy,
  retryBackoffMs,
  activeToolExemptsNoProgress,
  shouldExtend,
  taskClassOf,
  type FailureKind,
  type RunRetryPolicy,
  type RunTimeoutPolicy,
  type TaskClass,
} from './run-budget.ts'

// ── Constants ────────────────────────────────────────────────────────────────

const LEASE_OWNER = randomUUID()          // stable identity for this process
/** How many consecutive claim failures before a run is settled as failed. */
const CLAIM_ATTEMPT_LIMIT = 5

/** How long a run may sit queued before it is treated as stuck rather than waiting. */
const STALE_QUEUE_MS = 90_000

const TICK_INTERVAL_MS = 250              // polling fallback when no event wakes us
const MAX_TOOL_ROUNDS = 8                // tool rounds allowed before answering
/**
 * How often a live run's progress is written to state.
 *
 * Progress arrives per stream frame (many per second); persisting each one would turn the
 * timer into a write amplifier. The in-memory value is authoritative for the deadline check,
 * and this interval is only about what a restart/panel can see.
 */
const PROGRESS_PERSIST_INTERVAL_MS = 5_000
/** Default lease when the caller passes none (schematised config supplies the real value). */
const DEFAULT_RUN_LEASE_MS = 60_000

/** Per-result budget for tool text handed to the model. */
const MAX_TOOL_RESULT_CHARS = 8_000
/** How many of the NEWEST tool results stay verbatim before the rest are digested. */
const KEEP_VERBATIM_RESULTS = 2

/**
 * Shrink superseded `tool` results in place.
 *
 * Only the newest {@link KEEP_VERBATIM_RESULTS} results stay whole; older ones keep a
 * head plus a marker. The model still sees that the tool ran and broadly what it
 * returned, but the request stops growing linearly with the number of rounds.
 *
 * @param conversation - in-flight message list, mutated in place.
 * @param budget - maximum characters kept per digested result.
 * @param keep - how many trailing results to leave untouched.
 */
function compactToolResults(
  conversation: Array<{ role: string; content: Array<{ type: string; text?: string }> }>,
  budget: number,
  keep: number,
): void {
  const toolIndexes: number[] = []
  for (let i = 0; i < conversation.length; i++) {
    if (conversation[i]!.role === 'tool') toolIndexes.push(i)
  }
  const verbatimFrom = toolIndexes.length - keep
  for (let n = 0; n < toolIndexes.length; n++) {
    if (n >= verbatimFrom) continue
    const msg = conversation[toolIndexes[n]!]!
    for (const block of msg.content) {
      if (block.type !== 'text' || block.text === undefined) continue
      if (block.text.length <= budget) continue
      const dropped = block.text.length - budget
      block.text = `${block.text.slice(0, budget)}\n… [省略 ${dropped} 字符：该结果已被后续工具结果取代]`
    }
  }
}

/**
 * The subset of `@deepseek-ai/dsh-llm` StreamChunk this executor consumes.
 * Declared structurally so the plugin does not need the LLM package's full types
 * at build time (it is a peer supplied by the DSH host).
 */
type LlmChunk =
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | {
    readonly type: 'tool-call-delta'
    readonly index: number
    readonly id?: unknown
    readonly name?: string
    readonly argumentsDelta?: string
  }
  | {
    readonly type: 'block-end'
    readonly index: number
    readonly block?: {
      readonly type?: string
      readonly id?: unknown
      readonly name?: unknown
      readonly arguments?: unknown
    } | undefined
  }
  | {
    readonly type: 'usage'
    readonly usage: {
      readonly inputTokens?: number
      readonly outputTokens: number
      readonly totalTokens?: number | undefined
      readonly cacheReadTokens?: number
      readonly cacheWriteTokens?: number
    }
  }
  | {
    /**
     * Terminal chunk. A provider throw is converted into this shape by the adapter
     * (`adapterFailureChunk`), so `reason` carries the ONLY description of why a
     * request was rejected — reading it is mandatory, not optional.
     */
    readonly type: 'finish'
    readonly reason?: {
      readonly kind?: string
      readonly failure?: { readonly code?: string; readonly message?: string }
    } | undefined
  }

// ── Minimal shapes we read from community state ──────────────────────────────

interface RunSnapshot {
  readonly id: BotRunId
  readonly botId: BotId
  readonly roomId: BotRoomId
  readonly sessionId: SessionId
  readonly status: string
  readonly controlRevision: number
  readonly attempt: number
  readonly maxAttempts: number
  readonly prompt: string
  readonly leaseOwner?: string | undefined
  readonly leaseExpiresAt?: string | undefined
  readonly nextRetryAt?: string | undefined
  // ── adaptive timeout state (S8), persisted on the run row ──────────────────
  readonly deadlineAt?: string | undefined
  readonly lastProgressAt?: string | undefined
  readonly extensions?: number | undefined
  readonly progressEvents?: number | undefined
  readonly failureKind?: FailureKind | undefined
  readonly timeoutOverrideMs?: number | undefined
  /** When the run was first created; NOT when it entered the queue. */
  readonly createdAt?: string | undefined
  /** When this run's status last changed — the queue clock for `cancelStaleQueuedRuns`. */
  readonly updatedAt?: string | undefined
  readonly origin?: string | undefined
}

interface BotSnapshot {
  readonly id: BotId
  readonly name: string
  readonly description: string
  readonly systemPrompt?: string | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly reasoningEffort?: string | undefined
  readonly workspace?: string | undefined
  readonly permission?: 'read-only' | 'workspace-write' | 'full-access' | undefined
}

interface MessageSnapshot {
  /** Message id, used by the fold window (`windowForPrompt`). */
  readonly id: string
  readonly roomId: BotRoomId
  readonly sender: { readonly kind: string; readonly name: string }
  /** Visible text. */
  readonly text: string
  /** Model-facing payload when it differs from `text` (a `/skill` expansion). */
  readonly modelText?: string | undefined
  readonly createdAt: string
}

interface RoomAgentSessionEntry {
  readonly roomId: BotRoomId
  readonly botId: BotId
  readonly sessionId: SessionId
}

/**
 * The live budget of one running turn.
 *
 * In memory on purpose: the deadline is judged every 250 ms by the process that owns the
 * turn, and the persisted copy (`deadlineAt`, `lastProgressAt`) exists for the panel and for
 * a restart — not for the hot loop.
 */
interface RunBudgetState {
  readonly roomId: string
  readonly botId: string
  readonly origin: string | undefined
  readonly prompt: string
  readonly taskClass: TaskClass
  readonly startedAtMs: number
  deadlineAtMs: number
  readonly baseBudgetMs: number
  readonly derivedSource: string
  extensions: number
  lastProgressAtMs: number
  progressEvents: number
  lastPersistMs: number
  lastProgressSeenMs: number
  /**
   * Tool calls currently in flight for THIS run. A long shell/command is real work even
   * though it emits no frames; while this is > 0 the no-progress guard is suspended.
   */
  activeTools: number
  /** Gaps between progress events (bounded), so a chatty run gets a wider silence window. */
  readonly progressGapsMs: number[]
}

// The community service exposes these accessors; typed minimally to avoid
// tight coupling (the service owns its full shape, we only need what we use).
export interface CommunityStateAccessor {
  getBot(id: string): BotSnapshot | undefined
  /**
   * The room as the perception layer needs it.
   *
   * `directBotId` distinguishes a 1:1 from a group, and `memberIds` is the ONLY
   * source of truth for who a bot may perceive inside a room — never "every bot that
   * exists", which is what made a group able to see bots that never joined.
   */
  getRoom(id: string):
    | {
        readonly paused?: boolean | undefined
        readonly memberIds: readonly BotId[]
        readonly directBotId?: BotId | undefined
        /** Folded message ids: excluded from the prompt, kept in the transcript. */
        readonly foldedSeqs?: readonly string[] | undefined
      }
    | undefined
  listRuns(botId?: string): RunSnapshot[]
  listMessages(roomId: string): MessageSnapshot[]
  /**
   * What THIS bot remembers about THIS room, oldest first.
   *
   * The pair is the interface: there is no "everything this bot remembers" method, so the prompt
   * builder has no way to leak one room's work into another. Memory is written by the service when
   * a turn finishes (`settleRun`) and by the bot's own `agent_community_remember` tool.
   */
  botMemoryFor(roomId: string, botId: string): ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly text: string
    readonly at: string
  }>
  /**
   * The `[本房间目标]` block for THIS room, or undefined when it has no goal.
   *
   * Room-keyed like the memory accessor above, and for the same reason: a caller cannot ask
   * for another room's goal, so one room's objective can never appear in another's prompt.
   */
  roomGoalBlock(roomId: string): string | undefined
  /**
   * The `[本房间必须遵守的硬性约束]` block for THIS room, or undefined when there is none.
   *
   * Room-keyed for the same reason as the goal/memory accessors: a caller cannot ask for another
   * room's constraints, so a rule stated in one room can never rule another. The constraints are
   * pinned at compaction time (`compactRoom`) and survive the window the user stated them in.
   */
  roomConstraintsBlock(roomId: string): string | undefined
  /**
   * The `[本群经验卡]` block for THIS room (OP-09), or undefined when it has no pattern cards.
   *
   * Room-keyed like the goal/constraints accessors: a pattern learned in one group can never be
   * rendered into another group's prompt.
   */
  roomPatternsBlock(roomId: string): string | undefined
  /** Every bot in the community (id + name are what the prompt needs). */
  /** Every bot, with the role text a 1:1 needs to decide who to propose. */
  listBots(): Array<{
    readonly id: string
    readonly name: string
    readonly description?: string | undefined
  }>
  /**
   * The `[可用技能]` block for one bot, or undefined when the room has none.
   *
   * Owned by the skill lifecycle (identity pre-selection + the full name universe),
   * NOT by the prompt builder — the builder used to render a names-only list of its
   * own, which bypassed the per-bot profile entirely.
   */
  skillPromptFor(roomId: string, botId: string): string | undefined
  /** Cached `SKILL.md` entries for a room, for the prompt builder. */
  listSkillsSync(roomId: string): Array<{ id: string; name: string; description: string; path: string }>
  /** Full text of a skill, or undefined when it is unknown. */
  loadSkill(roomId: string, name: string): Promise<{ name: string; content: string } | undefined>
  /** Write a stable (room, bot) → sessionId mapping and persist immediately. */
  ensureStableSession(roomId: string, botId: string): SessionId
  settleRun(input: {
    id: string
    expectedRevision: number
    leaseOwner: string
    status: 'completed' | 'interrupted' | 'failed'
    error?: string
    retry?: boolean
    /** Failure category; timeout / no-progress / user-cancel must never be retried. */
    failureKind?: FailureKind
    /** Measurable run evidence (OP-04): counters only, no prose. */
    evidence?: RunEvidence
    reply?: {
      text: string
      sessionSeq: SessionSeq
      reasoning?: string
      toolActivity?: readonly { name: string; status: string; detail?: string }[]
      /** Files this turn declared with `agent_community_deliver`. */
      deliverables?: readonly DeliveredFile[]
      usage?: { uncachedInputTokens: number; outputTokens: number; totalTokens: number }
    }
  }): Promise<RunSnapshot>
  /** Transition queued → running; writes lease fields and startedAt. */
  claimRun(input: {
    id: string
    expectedRevision: number
    leaseOwner: string
    leaseExpiresAt: string
  }): Promise<RunSnapshot>
  /**
   * Take over a run whose lease expired, whoever owned it.
   *
   * Needed because `claimRun` refuses a running run and `settleRun` refuses a
   * mismatched owner, which together left a dead process's run unrecoverable.
   */
  reclaimStaleRun(input: {
    id: string
    expectedRevision: number
    leaseOwner: string
    now: number
  }): RunSnapshot
  heartbeatRun(id: string, leaseOwner: string, expiresAt: string): void
  /**
   * Persist the adaptive-timeout state of a running run.
   *
   * Called at claim (deadline), on progress (throttled by the executor), and on each
   * extension. The hot loop reads its own in-memory copy; this is what a panel or a restart
   * can see.
   */
  updateRunBudget(id: string, patch: {
    deadlineAt?: string
    lastProgressAt?: string
    extensions?: number
    progressEvents?: number
  }): void
  /**
   * Called BEFORE a budget-exceeded run is settled, so the service can react where only it
   * has state: pause a goal whose continuation round timed out, and write the room notice.
   */
  onRunTimedOut?(input: {
    readonly runId: string
    readonly roomId: string
    readonly botId: string
    readonly origin: string | undefined
    readonly prompt: string
    readonly kind: 'timeout' | 'no-progress'
    readonly detail: string
  }): void
  resolveDefaultWorkspace(): Promise<string>
  /** All session ids currently tracked in roomAgentSessions. */
  listKnownSessionIds(): readonly string[]
}

// ── Executor ─────────────────────────────────────────────────────────────────

export class RunExecutor {
  private readonly ctx: Context
  private readonly svc: CommunityStateAccessor
  /** Consecutive claim failures per run, before it is settled instead of retried. */
  private readonly claimFailures = new Map<string, number>()
  private readonly maxConcurrent: number
  // ── ADAPTIVE TIMEOUT (S8) ────────────────────────────────────────────────────
  // The deadline is derived per run from measured durations (run-budget.ts); these are the
  // knobs, all configurable. No fixed run timeout is stored on the executor any more.
  private readonly timeoutPolicy: RunTimeoutPolicy
  private readonly retryPolicy: RunRetryPolicy
  /** Lease length; the previous code hardcoded 60 s here and in the heartbeat. */
  private readonly runLeaseMs: number
  /** Heartbeat cadence derived from the lease (lease / 4), not a second hardcoded number. */
  private readonly heartbeatIntervalMs: number
  /** Live budget of every run THIS process is driving, keyed by run id. */
  private readonly runBudgets = new Map<string, RunBudgetState>()
  /** Runs whose budget failure is already being settled (ticks can overlap via `nudge`). */
  private readonly budgetFailures = new Set<string>()
  private readonly historyMessages: number
  private readonly visibility: VisibilityController
  private ledger: LedgerProjector | undefined
  private readonly sessionRunner: SessionRunner | undefined
  /**
   * Perception per `(room, bot)`.
   *
   * Held here rather than rebuilt per turn because {@link Perception.deltaOnChange}
   * is stateful: it remembers what the bot was last told so it can emit ONLY the
   * changed part. Rebuilding it would make every turn look like a change and replay
   * the whole roster, which rewrites history and destroys the prefix cache.
   */
  private readonly perceptions = new Map<string, Perception>()
  /** Keys whose baseline perception block has already been delivered. */
  private readonly perceptionBaselineSent = new Set<string>()

  // AgentHandle objects for disposal on bot/room deletion, keyed by sessionId
  private readonly handles = new Map<string, { dispose(): void }>()
  // Runs currently being driven by this process
  private readonly active = new Set<string>()
  //
  // WHAT A STOP NEEDS, keyed by RUN id: the controller that aborts the stream, and the
  // `(room, bot)` pair whose LIVE AGENT lives inside the session runner.
  //
  // The executor cannot interrupt a model request itself — `agent.cancel` belongs to the
  // runner's private agent map, and the executor's own `agents` map was never populated, so
  // aborting this controller alone left the provider stream running (and billing) after
  // 「停止生成」. The pair is what lets `interruptRun`/`abortRoom` reach the real turn.
  private readonly runAborts = new Map<string, AbortController>()
  /** The pair each live run is driving, so a stop/room-abort can cancel the REAL agent turn. */
  private readonly runTargets = new Map<string, { readonly roomId: string; readonly botId: string }>()
  // Heartbeat timer references
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>()

  private tickTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  /** Default reasoning effort for bot calls when the bot sets none. '' disables. */
  private readonly defaultReasoningEffort: string
  /** Remembered entries rendered into a turn's prompt; 0 disables the block. */
  private readonly memoryPromptEntries: number
  /**
   * The newest memory entry each (room, bot) pair has already been shown in this process.
   *
   * In-memory on purpose: a restart re-sends the baseline once, which is the cheap and safe
   * direction to be wrong in.
   */
  private readonly injectedMemory = new Map<string, string>()

  constructor(
    ctx: Context,
    svc: CommunityStateAccessor,
    opts: {
      maxConcurrent?: number
      /** Overrides over DEFAULT_RUN_TIMEOUT_POLICY (bootstrap only matters before data). */
      timeoutPolicy?: Partial<RunTimeoutPolicy> | undefined
      /** Attempts + exponential backoff for retryable failures. */
      retryPolicy?: Partial<RunRetryPolicy> | undefined
      /** Lease length in ms; heartbeat is derived as lease / 4. */
      runLeaseMs?: number
      historyMessages?: number
      /**
       * How many remembered entries one turn sees. 0 removes the block entirely — memory is
       * still recorded, so a deployment can turn the prompt half off without losing the record.
       */
      memoryPromptEntries?: number
      defaultReasoningEffort?: string
      ledger?: LedgerProjector
      /**
       * Native-session driver. When present, a bot turn runs through a real DSH agent
       * (persistent memory, compaction, retries, tool policy). Absent during the
       * transition, in which case the in-process loop below still runs.
       */
      sessionRunner?: SessionRunner | undefined
    } = {},
  ) {
    this.ctx = ctx
    this.svc = svc
    // Matches the service default: a group's members must be able to answer at the
    // same time, and the slot count is global rather than per room.
    this.maxConcurrent = opts.maxConcurrent ?? 8
    this.timeoutPolicy = resolveTimeoutPolicy(opts.timeoutPolicy)
    this.retryPolicy = resolveRetryPolicy(opts.retryPolicy)
    this.runLeaseMs = Math.max(5_000, Math.round(opts.runLeaseMs ?? DEFAULT_RUN_LEASE_MS))
    this.heartbeatIntervalMs = Math.max(1_000, Math.floor(this.runLeaseMs / 4))
    this.historyMessages = opts.historyMessages ?? 10
    this.memoryPromptEntries = opts.memoryPromptEntries ?? 8
    this.defaultReasoningEffort = opts.defaultReasoningEffort ?? ''
    // Reminders must be able to fire: archiving a session deletes its pending schedules
    // (see VisibilityController.activeSchedules), so hiding asks first.
    this.visibility = new VisibilityController(ctx, {
      activeSchedules: async (sessionId: string) => {
        const schedule = optionalService<{ list?(request: { sessionId: string }): Promise<unknown[]> }>(ctx, 'schedule')
        if (schedule?.list === undefined) return 0
        try {
          const tasks = await schedule.list({ sessionId })
          return Array.isArray(tasks) ? tasks.length : 0
        } catch {
          return 0
        }
      },
    })
    this.ledger = opts.ledger
    this.sessionRunner = opts.sessionRunner
  }

  /**
   * Drive one bot turn through a native DSH agent.
   *
   * The runner supplies everything the in-process loop used to hand-roll: the turn
   * itself, the tool pipeline, retries on transport failures, compaction between
   * steps, and the "analysis only" recovery. What is left here is the two things the
   * runner cannot know about:
   *
   *   · what this bot is allowed to PERCEIVE in this room (roster vs members), and
   *   · the fact that a turn which produced no visible text must fail loudly rather
   *     than be reported as success.
   */
  private async callModelViaSession(
    run: RunSnapshot,
    bot: BotSnapshot,
    prompt: string,
    onProgress?: ((kind: ProgressKind) => void) | undefined,
  ): Promise<{
    text: string
    sessionSeq: SessionSeq
    /** True when the caller's abort stopped the turn: settle as interrupted, never retry. */
    stopped?: boolean | undefined
    reasoning?: string
    /** Tool cards of this turn, persisted with the reply so they survive a reload. */
    toolActivity?: readonly { name: string; status: string; detail?: string }[]
    usage?: {
      inputTokens?: number
      uncachedInputTokens: number
      outputTokens: number
      totalTokens: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
    }
  }> {
    const runner = this.sessionRunner
    if (runner === undefined) throw new Error('agent-community: session runner unavailable')

    // Memory first: a fresh session is empty, and the room transcript the user can see
    // must be visible to the bot too.
    //
    // SEEDING NEEDS THE AGENT TO EXIST, so it happens inside the run rather than before
    // it. `seedIfNeeded` injects into the live agent and returns early when there is
    // none — called here, before `run()` had created it, seeding silently never
    // happened at all and the bot answered with no knowledge of the room.
    // THE RUN OWNS ITS LIVE ROW. Reserved here so the streaming projection adopts this
    // row rather than opening a second one for the same answer.
    this.ledger?.reserveLiveRow(run.roomId, bot.id, bot.name, run.id)

    const delta = this.perceptionDelta(run.roomId, bot.id)
    // THE ABORT SIGNAL is how 「停止生成」 reaches the live model request: the runner
    // registers it, cancels the agent on abort, and returns a `stopped` outcome instead of
    // an answer. Without it the executor only flipped run state while the provider stream
    // kept running and billing.
    const runAbort = this.runAborts.get(run.id)
    let outcome: Awaited<ReturnType<typeof runner.run>>
    try {
      outcome = await runner.run(run.roomId, bot.id, prompt, delta, true, runAbort?.signal, onProgress, run.id)
    } catch (error: unknown) {
      // A failed turn must not leave a row on `streaming: true`, or the panel shows
      // "处理中…" over an answer that will never come and the turn looks live forever.
      this.ledger?.settleRunText(run.roomId, run.id)
      // Its declared files are dropped too: the turn never reached the user, and a card
      // group must not outlive the reply that would have introduced it.
      this.ledger?.discardDeliverables(run.roomId, run.id)
      this.ledger?.releaseLiveRow(run.roomId, bot.id)
      throw error
    }

    // A STOP IS NOT AN ANSWER. The turn was interrupted after the user pressed stop (or the
    // room/bot was removed): settle it as interrupted, publish nothing, and never retry.
    // The streamed ledger rows stay as the visible trace of what had been produced.
    if (outcome.stopped === true) {
      this.ledger?.settleRunText(run.roomId, run.id)
      this.ledger?.discardDeliverables(run.roomId, run.id)
      this.ledger?.releaseLiveRow(run.roomId, bot.id)
      return { text: '', sessionSeq: outcome.sessionSeq ?? (0 as SessionSeq), stopped: true }
    }

    // A turn that only produced reasoning is a FAILURE, not a silent success. The
    // runner already tried to convert it; if that failed we say so, because the
    // alternative — publishing the model's internal analysis as the answer — hides
    // the problem from the reader and from the logs.
    // A bot that left the room (removed itself, or was kicked) has nothing to answer with, and
    // its session is being recycled: neither "retry" nor "the model failed" describes that. The
    // room already got its note from the removal, so the run simply ends.
    if (outcome.leftRoom === true) {
      this.ledger?.settleRunText(run.roomId, run.id)
      this.ledger?.releaseLiveRow(run.roomId, bot.id)
      return { ...outcome, text: '', sessionSeq: outcome.sessionSeq ?? (0 as SessionSeq) }
    }

    if (outcome.textChannelFailed) {
      throw new Error(
        'agent-community: model produced no visible answer text '
        + `(reasoning-only after ${outcome.repairs} repair attempt(s) model=${bot.model ?? '?'})`,
      )
    }

    // ── THE ANSWER IS WRITTEN BY THE RUNNER, NOT LEFT TO THE STREAM ─────────────
    //
    // `LedgerProjection` paints text as deltas arrive, which is what makes the reply
    // appear live. But it is best-effort: a delta that never reaches an observer, or
    // one that arrives for an attempt whose row was never created, leaves the row empty
    // and still `streaming: true`. The panel renders exactly that as "处理中…" — and it
    // stayed that way forever even though the model had answered, which is precisely
    // what the user saw on some bots and not others.
    //
    // The runner's return value is the authority, so it is written here. Patching by
    // runId means this lands on whatever row the stream created, and it clears
    // `streaming` in the same write so the turn can never look live afterwards.
    this.ledger?.patchRunText(run.roomId, run.id, outcome.text, {
      botId: bot.id,
      botName: bot.name,
    })
    // The reasoning is guaranteed the same way the answer is. It is the model's private
    // scratchpad, shown collapsed under 思考过程 — not part of the reply, but the user
    // asks for it explicitly, and a stream-only path silently loses it whenever a frame
    // is missed or skipped.
    this.ledger?.patchRunReasoning(run.roomId, run.id, outcome.reasoning ?? '', {
      botId: bot.id,
      botName: bot.name,
    })
    // The run is over: the row is no longer live, so the next run for this pair reserves
    // a fresh one instead of streaming into this turn's answer.
    // Read the tool cards BEFORE releasing, then hand them to `settleRun` so they are
    // persisted on the message: the session events that produced them are process-local,
    // and without this a reload left the answer and the reasoning in place while the
    // turn's tools silently vanished from the transcript.
    const toolActivity = this.ledger?.toolActivityFromRun(run.roomId, run.id) ?? []
    // ── THE FILES THIS TURN DELIVERED ─────────────────────────────────────────
    //
    // The deliver tool kept them out of the ledger until the turn ended (the card group
    // renders AFTER the reply, and a row pushed mid-turn would let a retry duplicate it).
    // Read them before the row is released, stamp one `deliverable` row so the live panel
    // sees the cards too, and carry them into the settled message for restarts.
    const deliverables = this.ledger?.deliverablesFromRun(run.roomId, run.id) ?? []
    if (deliverables.length > 0) {
      this.ledger?.push({
        type: 'deliverable',
        roomId: run.roomId as never,
        botId: bot.id as never,
        botName: bot.name,
        runId: run.id as never,
        files: deliverables,
      } as never)
    }
    this.ledger?.releaseLiveRow(run.roomId, bot.id)
    return {
      text: outcome.text,
      sessionSeq: 0 as SessionSeq,
      ...(outcome.reasoning !== '' ? { reasoning: outcome.reasoning } : {}),
      ...(toolActivity.length > 0 ? { toolActivity } : {}),
      ...(deliverables.length > 0 ? { deliverables } : {}),
    }
  }

  /**
   * Roster / membership / skill text this bot has not seen yet, or undefined when
   * nothing changed.
   *
   * The FIRST call returns the whole perception block (that is the baseline); later
   * calls return only the difference. Appending on change keeps the conversation
   * append-only, which is what keeps the provider's prefix cache alive.
   */
  private perceptionDelta(roomId: string, botId: string): string | undefined {
    const key = `${roomId}\u0000${botId}`
    const value = this.perceptionValue(roomId)
    let perception = this.perceptions.get(key)
    if (perception === undefined) {
      perception = buildPerception({ room: value.room, bots: value.bots, selfId: botId, ...(value.skills !== undefined ? { skills: value.skills } : {}) })
      this.perceptions.set(key, perception)
    }
    if (!this.perceptionBaselineSent.has(key)) {
      this.perceptionBaselineSent.add(key)
      return perception.systemContext
    }
    return perception.deltaOnChange(value)
  }

  /** Snapshot of everything that can change under a bot's feet in one room. */
  private perceptionValue(roomId: string): PerceptionValue {
    const room = this.svc.getRoom(roomId)
    const bots = this.svc.listBots().map(b => ({
      id: b.id,
      name: b.name,
      ...(b.description !== undefined ? { description: b.description } : {}),
    }))
    const skills = this.svc.listSkillsSync(roomId).map(sk => sk.name)
    // `room: undefined` means membership is UNKNOWN, which the perception layer
    // treats as a group with no members — when in doubt, reveal less, never more.
    return {
      room: room !== undefined
        ? {
            memberIds: room.memberIds,
            ...(room.directBotId !== undefined ? { directBotId: room.directBotId } : {}),
          }
        : undefined,
      bots,
      skills,
    }
  }

  /** Drop perception state for a room so a cleared or deleted room forgets it. */
  forgetPerception(roomId: string): void {
    for (const key of [...this.perceptions.keys()]) {
      if (key.startsWith(`${roomId}\u0000`)) {
        this.perceptions.delete(key)
        this.perceptionBaselineSent.delete(key)
      }
    }
  }

  /**
   * Release every live agent for a room.
   *
   * Called by the service on room deletion, on `clearMessages`, and when a room
   * dissolves. Clearing messages matters as much as deleting: the transcript is gone,
   * so the bot must not keep answering from content the user deleted — that would be
   * a content leak, not just a stale cache.
   */
  async disposeRoomAgents(roomId: string): Promise<void> {
    this.forgetPerception(roomId)
    // CANCEL BEFORE DISPOSING. Disposing a handle under an in-flight model request leaves
    // the provider stream alive with no session to consume it; cancelling the live runs
    // first is what makes "删房/清空" actually stop the work (and stops the billing).
    this.abortRoom(roomId)
    const runner = this.sessionRunner
    if (runner === undefined) return
    runner.forgetRoom(roomId)
    // AWAITED, not fire-and-forget. The caller (clearMessages) deletes the session
    // logs next, and the user can send a new message immediately after; leaving the
    // disposal in flight let the next run adopt an agent that was about to be torn
    // down, which surfaced as a bot that never replied. The runner also keeps a
    // disposal barrier, so a run that races ahead still waits rather than adopting.
    try {
      await runner.disposeRoom(roomId)
    } catch {
      // Best-effort: a failed disposal must not abort the state transition.
    }
  }

  /**
   * Hide one session from DSH's sidebar.
   *
   * Delegates to the same `VisibilityController` used for the startup sweep, so a
   * session created mid-run is hidden by exactly the mechanism that hides the ones
   * found at boot.
   */
  /**
   * The controller that hides sessions, for the startup sweep.
   *
   * Exposed so the service uses the SAME detach+archive path as the per-create hook;
   * a second implementation would drift and one of the two would stop working.
   */
  visibilityController(): VisibilityController {
    return this.visibility
  }

  hideSession(sessionId: string): void {
    void this.visibility.hide(sessionId as never).catch(() => undefined)
  }

  /**
   * Unarchive one session so its next turn can run.
   *
   * ⚠️ GOES STRAIGHT TO THE REGISTRY. `VisibilityController.restore()` is documented as
   * an intentional no-op ("Kept as a named step because RunExecutor calls it in the
   * V-9 safety sequence"), so routing through it silently does nothing — and the
   * session stays archived, which the admission gate answers by rejecting every step
   * and ending the turn as `blocked` with no model request.
   */
  async restoreSession(sessionId: string): Promise<void> {
    const registry = (this.ctx as unknown as {
      workspaceRegistry?: { unarchiveSession?(id: string): Promise<void> }
    }).workspaceRegistry
    if (registry?.unarchiveSession === undefined) return
    try {
      await registry.unarchiveSession(sessionId)
    } catch {
      // Best-effort: a failure surfaces as a turn that produces no text.
    }
  }

  /**
   * Release every live agent for one bot, in every room. Called on bot deletion.
   *
   * The live turns are CANCELLED first: disposing an agent handle while its model request
   * is in flight tears down the session under the provider call — the process then keeps
   * paying for a stream nobody can consume. `stopRun` also marks the run aborted, so its
   * settle path does not report a model failure for a bot the user just removed.
   */
  disposeBotAgents(botId: string): void {
    for (const [runId, target] of [...this.runTargets]) {
      if (target.botId === botId) this.stopRun(runId, 'bot removed')
    }
    const runner = this.sessionRunner
    if (runner === undefined) return
    void runner.disposeBot(botId).catch(() => undefined)
  }

  /**
   * Cancel an in-flight run — the executor side of 「停止生成」.
   *
   * Accepts either a run id (what the stop button has) or a session id (older callers), and
   * resolves both through the run table. A stop always has THREE effects, applied by
   * {@link stopRun}: abort this executor's controller, cancel the LIVE agent turn through the
   * session runner (the only call that interrupts the provider request), and let the caller
   * settle the run as `interrupted`. A stop on a turn that already finished is a no-op.
   */
  interruptRun(idOrSession: string): void {
    const run = this.resolveLiveRun(idOrSession)
    if (run === undefined) return
    this.stopRun(run.id, 'user interrupted')
  }

  /**
   * Abort every live run belonging to a room — used when a room is deleted or its agents are
   * torn down. Each run gets the same real cancel as the stop button (`room removed`).
   */
  abortRoom(roomId: string): void {
    const runs = this.svc.listRuns()
    for (const [runId, target] of [...this.runTargets]) {
      if (target.roomId === roomId) this.stopRun(runId, 'room removed')
    }
    // A run that registered an abort controller but not yet its target (the window between
    // `driveRun`'s registration and its claim) still needs its stream aborted.
    for (const [runId, controller] of [...this.runAborts]) {
      if (this.runTargets.has(runId)) continue
      const run = runs.find(r => r.id === runId)
      if (run?.roomId !== roomId) continue
      try { controller.abort(new Error('room removed')) } catch { /* best-effort */ }
    }
    // SWEEP: an agent can outlive its run row (state cleared, or a run settled while the
    // turn was still winding down). Cancelling by room closes that gap before the caller
    // disposes the agents.
    this.sessionRunner?.cancelRoom(roomId, 'room removed')
  }

  /** The run an id names: a run id first, else a LIVE run whose session id was passed. */
  private resolveLiveRun(idOrSession: string): RunSnapshot | undefined {
    const runs = this.svc.listRuns()
    const byId = runs.find(r => r.id === idOrSession)
    if (byId !== undefined) return byId
    return runs.find(r =>
      String(r.sessionId) === idOrSession && (r.status === 'running' || r.status === 'queued'),
    )
  }

  /**
   * Apply one stop to one run: abort the executor's controller, then cancel the live agent
   * turn through the session runner.
   *
   * ORDER MATTERS. The controller tells the local loop (`callModel`'s round timer and the
   * runner's `signal` boundary) to stop; `cancel` is what actually tears down the in-flight
   * model request inside DSH. Idempotent and best-effort: an unclaimed/queued run has no
   * agent to cancel, and a second stop is harmless.
   */
  private stopRun(runId: string, reason: string): void {
    const controller = this.runAborts.get(runId)
    if (controller !== undefined) {
      try { controller.abort(new Error(reason)) } catch { /* best-effort */ }
    }
    const target = this.runTargets.get(runId)
    if (target !== undefined) {
      // The run id goes with the request: only the run that owns the pair's live turn may
      // cancel it (see `SessionRunner.cancel`). A queued run of the same pair has a target but
      // no turn of its own — its stop must not abort the other run's model request.
      this.sessionRunner?.cancel(target.roomId, target.botId, reason, runId)
      return
    }
    // No registered target: only a run this process is actually driving has an agent to
    // cancel, and only while it is still live (a stale stop must not hit the NEXT run of the
    // same pair — the pair key is the same, the turn is not).
    if (controller === undefined) return
    const run = this.svc.listRuns().find(r => r.id === runId)
    if (run !== undefined && (run.status === 'running' || run.status === 'queued')) {
      this.sessionRunner?.cancel(run.roomId, run.botId, reason, runId)
    }
  }

  /** Start polling; recover stale running runs left by a prior crash. */
  async start(): Promise<void> {
    await this.recoverStaleLeasedRuns()
    await this.cancelStaleQueuedRuns()
    // P0-1 (v5): reconcile visibility on startup — archive all known bot sessions
    // so sessions created before the hide-on-settle path was deployed are hidden too.
    await this.visibility.reconcile(this.svc.listKnownSessionIds())
    this.scheduleTick()
  }

  dispose(): void {
    this.disposed = true
    if (this.tickTimer !== undefined) clearTimeout(this.tickTimer)
    for (const interval of this.heartbeats.values()) clearInterval(interval)
    this.heartbeats.clear()
    // Stop every live model turn through the runner — the executor does not own the agents,
    // so dropping its own controllers here would leave the provider streams alive.
    for (const target of this.runTargets.values()) {
      this.sessionRunner?.cancel(target.roomId, target.botId, 'executor disposed')
    }
    this.runTargets.clear()
    this.runAborts.clear()
    this.runBudgets.clear()
    this.budgetFailures.clear()
    // B-5: release all AgentHandles so sessions are properly torn down
    for (const handle of this.handles.values()) {
      try { handle.dispose() } catch { /* best-effort */ }
    }
    this.handles.clear()
  }


  /** Wake up immediately (called after sendMessage creates new runs). */
  nudge(): void {
    if (this.disposed) return
    if (this.tickTimer !== undefined) { clearTimeout(this.tickTimer); this.tickTimer = undefined }
    void this.tick()
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private scheduleTick(): void {
    if (this.disposed) return
    this.tickTimer = setTimeout(() => { void this.tick() }, TICK_INTERVAL_MS)
  }

  private async tick(): Promise<void> {
    if (this.disposed) return
    try {
      // Deadline/no-progress first: it is the reason a stuck run stops even when every
      // concurrency slot is busy (no slot means no pick, not no supervision).
      await this.enforceRunBudgets()
      const slots = this.maxConcurrent - this.active.size
      if (slots > 0) {
        // Reclaim the queue from runs that will never start before handing slots out,
        // or a stuck run keeps consuming one on every pass.
        await this.cancelStaleQueuedRuns()
        const candidates = this.pickQueued(slots)
        for (const run of candidates) {
          // NOT JUST fire-and-forget: an unhandled rejection here used to leave the run queued
          // for ever with no trace anywhere. Record it and settle it as a real failure, so the
          // panel shows the reason instead of an eternal 排队中.
          void this.driveRun(run).catch((error: unknown) => {
            const msg = error instanceof Error ? error.message : String(error)
            this.active.delete(run.id)
            void this.svc.settleRun({
              id: run.id,
              expectedRevision: run.controlRevision,
              leaseOwner: LEASE_OWNER,
              status: 'failed',
              failureKind: 'unknown',
              error: `运行未能启动：${msg}`,
            }).catch(() => undefined)
          })
        }
      }
    } finally {
      if (!this.disposed) this.scheduleTick()
    }
  }

  private pickQueued(limit: number): RunSnapshot[] {
    const now = Date.now()
    return this.svc.listRuns()
      .filter(r =>
        r.status === 'queued' &&
        !this.active.has(r.id) &&
        (r.nextRetryAt === undefined || new Date(r.nextRetryAt).getTime() <= now),
      )
      .slice(0, limit)
  }

  /**
   * Cancel queued runs that have waited far longer than any slot contention explains.
   *
   * The queue is picked in insertion order and a run that cannot start still occupies
   * the user's attention: the panel renders a 排队 banner and every bot behind it sits
   * on 处理中…. A run parked this long is not waiting for a slot, it is stuck — most
   * often a leftover from the legacy task feature (`origin: 'routine'`), which creates
   * runs independently of the leader-driven flow and can leave them queued forever.
   * Cancelling them is what lets the user's own messages through.
   *
   * WHAT COUNTS AS "WAITED": time in the QUEUE, not the run's age. A run recovered from
   * an expired lease is queued again with its original `createdAt` intact — that instant
   * is what `updatedAt` records the requeue, so judging by `createdAt` cancelled a
   * freshly salvaged run on the very next tick (measured: a 3-minute-old run reclaimed
   * from a dead process reported "abandoned after waiting 185s" a second later). Every
   * `settleRun` — retry or terminal — stamps `updatedAt`, and `claimRun` does too, so
   * `updatedAt` is the one field that always means "when this status began".
   */
  private async cancelStaleQueuedRuns(): Promise<void> {
    const now = Date.now()
    const all = this.svc.listRuns()
    for (const run of all) {
      if (run.status !== 'queued') continue
      if (this.active.has(run.id)) continue
      // Prefer the last status transition (queue time); fall back to birth for a run
      // that predates the field being written on transition.
      const stamp = run.updatedAt ?? run.createdAt
      const queuedSince = stamp === undefined ? Number.NaN : Date.parse(stamp)
      if (!Number.isFinite(queuedSince) || now - queuedSince <= STALE_QUEUE_MS) continue
      const waited = Math.round((now - queuedSince) / 1000)
      try {
        await this.svc.settleRun({
          id: run.id,
          expectedRevision: run.controlRevision,
          leaseOwner: LEASE_OWNER,
          status: 'failed',
          failureKind: 'unknown',
          error: `agent-community: abandoned after waiting ${waited}s in the queue `
            + 'without starting — a run this old is stuck, and it blocked every newer one',
        })
        this.ctx.logger?.warn?.(
          `agent-community: cancelled stale queued run ${run.id} (origin=${run.origin}, waited ${waited}s)`,
        )
      } catch {
        // Lost the race with a real claim; the run is starting after all.
      }
    }
  }

  /**
   * Fail runs whose lease expired, so a room cannot stay wedged for ever.
   *
   * A run left `running` by a process that died holds a lease nobody will renew. It
   * used to be recovered by settling it with `leaseOwner: run.leaseOwner ?? LEASE_OWNER`
   * — but `LEASE_OWNER` is minted per process (`const LEASE_OWNER = randomUUID()`), and
   * `settleRun` refuses an owner that does not match the stored one. The dead process's
   * UUID never matches, the settle threw, and the empty `catch` swallowed it: the run
   * stayed `running` with an expired lease across every restart, the room rendered a
   * 排队 banner with a dead 停止生成 button, and every later message queued behind it.
   *
   * So recovery first TAKES the lease over (`reclaimStaleRun`, which itself proves the
   * lease is expired and the revision still current) and only then settles under the
   * owner it now holds. Failures are logged rather than swallowed — this path exists
   * precisely because "recovery silently did nothing" is invisible to the user.
   */
  private async recoverStaleLeasedRuns(): Promise<void> {
    const now = Date.now()
    const stale = this.svc.listRuns().filter(r =>
      r.status === 'running' &&
      r.leaseExpiresAt !== undefined &&
      new Date(r.leaseExpiresAt).getTime() < now,
    )
    for (const run of stale) {
      try {
        const reclaimed = this.svc.reclaimStaleRun({
          id: run.id,
          expectedRevision: run.controlRevision,
          leaseOwner: LEASE_OWNER,
          now,
        })
        const canRetry = this.retryAllowed(reclaimed.attempt, 'lease-lost')
        await this.svc.settleRun({
          id: reclaimed.id,
          expectedRevision: reclaimed.controlRevision,
          leaseOwner: LEASE_OWNER,
          status: 'failed',
          error: 'lease expired on startup — retrying',
          failureKind: 'lease-lost',
          retry: canRetry,
        })
        this.ctx.logger?.warn?.(
          `agent-community: reclaimed stale run ${run.id} (owner ${run.leaseOwner ?? 'none'} `
          + `→ ${LEASE_OWNER}); it is ${canRetry ? 'queued for retry' : 'failed'}`,
        )
      } catch (error: unknown) {
        // Lost the race to a live successor (revision moved on or the lease was
        // renewed). Anything else is worth seeing in the log.
        this.ctx.logger?.warn?.(
          `agent-community: could not reclaim stale run ${run.id}: ${String(error)}`,
        )
      }
    }
  }

  private async driveRun(run: RunSnapshot): Promise<void> {
    this.active.add(run.id)
    // One controller per run, published so a stop can reach the live stream, plus the pair
    // its live agent belongs to, so the stop can cancel the REAL model turn (see `stopRun`).
    const runAbort = new AbortController()
    this.runAborts.set(run.id, runAbort)
    this.runTargets.set(run.id, { roomId: run.roomId, botId: run.botId })
    try {
      // Claim the run (queued → running). The lease length is CONFIG (runLeaseMs), which
      // was a dead option before S8: both this and the heartbeat hardcoded 60 s.
      const leaseExpiresAt = new Date(Date.now() + this.runLeaseMs).toISOString()
      let claimed: RunSnapshot
      try {
        claimed = await this.svc.claimRun({
          id: run.id,
          expectedRevision: run.controlRevision,
          leaseOwner: LEASE_OWNER,
          leaseExpiresAt,
        })
      } catch (error: unknown) {
        // A run that cannot be claimed must not stay queued forever. `pickQueued` would
        // hand it back on every tick, so the panel keeps rendering the 排队 banner and
        // the bot never answers — an infinite, silent retry. Count the failures and
        // settle it once the retries are spent; a transient CAS loss costs one tick.
        const failures = (this.claimFailures.get(run.id) ?? 0) + 1
        this.claimFailures.set(run.id, failures)
        if (failures >= CLAIM_ATTEMPT_LIMIT) {
          this.claimFailures.delete(run.id)
          const msg = error instanceof Error ? error.message : String(error)
          try {
            await this.svc.settleRun({
              id: run.id,
              expectedRevision: run.controlRevision,
              leaseOwner: LEASE_OWNER,
              status: 'failed',
              failureKind: 'unknown',
              error: `agent-community: run could not be claimed after ${failures} attempts (${msg})`,
            })
          } catch {
            // A revision mismatch here too; the run is already gone from the queue's
            // reach and the message above is recorded in the logs.
          }
          this.ledger?.push({
            type: 'error',
            roomId: run.roomId,
            botId: run.botId,
            botName: this.svc.getBot(run.botId)?.name ?? run.botId,
            message: `运行无法启动：${msg}`,
            at: new Date().toISOString(),
          })
        }
        return
      }

      // ── DERIVE THIS RUN'S DEADLINE (S8) ──────────────────────────────────────────
      //
      // The budget is measured, not configured as a constant: p95 of this deployment's
      // completed runs for the same (bot, origin, task-class), with the documented fallbacks
      // and clamp (see `run-budget.ts`). A panel override wins for this run only.
      const budget = this.openRunBudget(claimed)
      this.runBudgets.set(run.id, budget)
      this.svc.updateRunBudget(run.id, {
        deadlineAt: new Date(budget.deadlineAtMs).toISOString(),
        lastProgressAt: new Date(budget.lastProgressAtMs).toISOString(),
        extensions: 0,
        progressEvents: 0,
      })
      this.ctx.logger?.info?.(
        `agent-community: run ${run.id} budget ${Math.round(budget.baseBudgetMs / 1000)}s `
        + `(${budget.derivedSource}, class=${budget.taskClass}) lease=${Math.round(this.runLeaseMs / 1000)}s`,
      )

      // Heartbeat so the lease stays alive during a long turn. Cadence is lease/4, so a
      // deployment that configures a longer lease does not keep a second hardcoded 15 s.
      const hbInterval = setInterval(() => {
        const newExpiry = new Date(Date.now() + this.runLeaseMs).toISOString()
        this.svc.heartbeatRun(run.id, LEASE_OWNER, newExpiry)
      }, this.heartbeatIntervalMs)
      this.heartbeats.set(run.id, hbInterval)

      let settled = false
      // OP-04/OP-15: run evidence is built from these facts plus the reply.
      const startedAtMs = Date.now()
      let promptChars = 0
      let contextSections: Readonly<Record<string, number>> | undefined
      let promptTokensEstimate: number | undefined
      try {
        const bot = this.svc.getBot(run.botId)
        const composed = this.composePrompt(run, bot, run.botId)
        const prompt = composed.prompt
        promptChars = prompt.length
        const stats = sectionStats(composed.sections)
        // Measured characters per section + one clearly-rough token estimate. No prompt text
        // is stored anywhere: the evidence keeps numbers only.
        contextSections = stats.chars
        promptTokensEstimate = estimateTokens(stats.totalChars)
        // Progress = a stream frame or a tool event, fed back into the budget state. It is
        // what lets a long-but-working turn be extended instead of killed at the deadline.
        const onProgress = (kind: ProgressKind): void => { this.noteProgress(run.id, kind) }
        const reply = await this.callModel(run, bot, prompt, onProgress)

        // P0-2: push bot-text ledger entry — but never an empty one. A bot that
        // The bot-text (and any reasoning / tool) ledger entries were already
        // streamed by callModel as the model produced them, so there is nothing to
        // append here — appending again would duplicate the answer in the panel.
        //
        // A user stop settles as `interrupted`, never `completed`: controlRun already
        // wrote that status, and re-settling as completed would report a finished turn
        // for a turn the user cut short. Its revision bump usually makes this settle
        // fail the CAS check anyway, so `interrupted` is what survives either way.
        await this.svc.settleRun({
          id: run.id,
          expectedRevision: claimed.controlRevision,
          leaseOwner: LEASE_OWNER,
          status: reply.stopped === true ? 'interrupted' : 'completed',
          // OP-04: counters + finish path; the SERVICE folds in duration and turns
          // `finish_task` reports into finishPath='finish_task'.
          evidence: buildRunEvidence({
            durationMs: Date.now() - startedAtMs,
            promptChars,
            ...(contextSections !== undefined ? { contextSections } : {}),
            ...(promptTokensEstimate !== undefined ? { promptTokensEstimate } : {}),
            toolActivity: reply.toolActivity,
            deliverableCount: reply.deliverables?.length ?? 0,
            usage: reply.usage,
            finishPath: finishPathOf({
              status: reply.stopped === true ? 'interrupted' : 'completed',
              replyText: reply.text,
              stopped: reply.stopped,
            }),
          }),
          reply,
        })
        settled = true
      } catch (error: unknown) {
        if (!settled) {
          // An abort can also surface as a thrown AbortError (the provider wrapper
          // rejects rather than emitting a terminal chunk). That is the same user
          // stop, so it must not be recorded as a run failure.
          if (runAbort?.signal.aborted === true) {
            this.ctx.logger?.info?.(
              `agent-community: run ${run.id} aborted by the user`,
            )
            // SETTLE THE ABORTED RUN, not just the flag. `controlRun('interrupt')` already
            // wrote `interrupted`, so this CAS usually loses and is ignored — but a stop
            // that did NOT come through controlRun (room/bot removal, executor dispose)
            // would otherwise leave the run `running` until lease recovery.
            try {
              await this.svc.settleRun({
                id: run.id,
                expectedRevision: claimed.controlRevision,
                leaseOwner: LEASE_OWNER,
                status: 'interrupted',
                evidence: buildRunEvidence({
                  durationMs: Date.now() - startedAtMs,
                  promptChars,
                  ...(contextSections !== undefined ? { contextSections } : {}),
                  ...(promptTokensEstimate !== undefined ? { promptTokensEstimate } : {}),
                  finishPath: 'stopped',
                  faultSide: 'user',
                }),
              })
            } catch {
              // Already settled by controlRun (revision moved on), or gone: both fine.
            }
            settled = true
          } else {
            const msg = error instanceof Error ? error.message : String(error)
            const failureKind = classifyFailure('failed', msg)
            // A retry is only for TRANSIENT failures and only inside the configured policy;
            // timeout / no-progress / a user stop are terminal (S8).
            const shouldRetry = this.retryAllowed(claimed.attempt, failureKind)
            try {
              await this.svc.settleRun({
                id: run.id,
                expectedRevision: claimed.controlRevision,
                leaseOwner: LEASE_OWNER,
                status: 'failed',
                error: msg,
                failureKind,
                retry: shouldRetry,
                // OP-04: record WHERE the failure came from. Retry policy is unchanged.
                evidence: buildRunEvidence({
                  durationMs: Date.now() - startedAtMs,
                  promptChars,
                  ...(contextSections !== undefined ? { contextSections } : {}),
                  ...(promptTokensEstimate !== undefined ? { promptTokensEstimate } : {}),
                  finishPath: 'failed',
                  faultSide: classifyFaultSide({ failureKind, error: msg }),
                }),
              })
            } catch {
              // settle failed (revision mismatch from concurrent controlRun); ignore
            }
            // P0-4: push error entry to ledger for transparent failure reporting
            this.ledger?.push({
              type: 'error',
              roomId: run.roomId,
              botId: run.botId,
              botName: this.svc.getBot(run.botId)?.name ?? run.botId,
              message: msg,
              at: new Date().toISOString(),
            })
          }
        }
      } finally {
        const hb = this.heartbeats.get(run.id)
        if (hb !== undefined) { clearInterval(hb); this.heartbeats.delete(run.id) }
      }
    } finally {
      this.active.delete(run.id)
      this.runAborts.delete(run.id)
      this.runTargets.delete(run.id)
      this.runBudgets.delete(run.id)
    }
  }



  // ── ADAPTIVE TIMEOUT (S8) ──────────────────────────────────────────────────

  /**
   * Build the live budget for a claimed run: the deadline it may run to, and the state the
   * 250 ms tick needs to judge progress.
   *
   * HISTORY IS THE SOURCE. `svc.listRuns()` already carries `startedAt`/`finishedAt` for every
   * settled run, so a deadline needs no new counter: sort the measured durations into the
   * (bot, origin, task-class), origin, and all-run samples and let `deriveDeadlineBudget`
   * pick p95 × safety with its clamps. A small deployment therefore starts at the configured
   * bootstrap and converges to its own real task times as runs complete.
   */
  private openRunBudget(run: RunSnapshot): RunBudgetState {
    const now = Date.now()
    const origin = run.origin
    const prompt = run.prompt ?? ''
    const taskClass = taskClassOf(prompt, origin)
    const window = this.timeoutPolicy.sampleWindow

    const durationOf = (candidate: RunSnapshot): number | undefined => {
      if (candidate.status !== 'completed') return undefined
      if (candidate.startedAt === undefined || candidate.finishedAt === undefined) return undefined
      const started = Date.parse(candidate.startedAt)
      const finished = Date.parse(candidate.finishedAt)
      const duration = finished - started
      return Number.isFinite(duration) && duration > 0 ? duration : undefined
    }
    const keyDurations: number[] = []
    const originDurations: number[] = []
    const allDurations: number[] = []
    for (const candidate of this.svc.listRuns()) {
      const duration = durationOf(candidate)
      if (duration === undefined) continue
      allDurations.push(duration)
      if (candidate.origin === origin) originDurations.push(duration)
      if (candidate.botId === run.botId && candidate.origin === origin
        && taskClassOf(candidate.prompt ?? '', candidate.origin) === taskClass) {
        keyDurations.push(duration)
      }
    }
    const newest = (values: readonly number[]): number[] => values.slice(-window)
    const derived = deriveDeadlineBudget({
      durationsMs: newest(keyDurations),
      originDurationsMs: newest(originDurations),
      allDurationsMs: newest(allDurations),
      policy: this.timeoutPolicy,
    })
    const override = run.timeoutOverrideMs
    const hasOverride = override !== undefined && Number.isFinite(override) && override > 0
    const budgetMs = hasOverride
      ? Math.round(Math.min(this.timeoutPolicy.capMs, Math.max(this.timeoutPolicy.floorMs, override)))
      : derived.budgetMs
    return {
      roomId: String(run.roomId),
      botId: String(run.botId),
      origin,
      prompt,
      taskClass,
      startedAtMs: now,
      deadlineAtMs: now + budgetMs,
      baseBudgetMs: budgetMs,
      derivedSource: hasOverride ? 'override' : derived.source,
      extensions: 0,
      lastProgressAtMs: now,
      progressEvents: 0,
      lastPersistMs: now,
      lastProgressSeenMs: now,
      activeTools: 0,
      progressGapsMs: [],
    }
  }

  /**
   * A run's turn actually began — restart its execution budget clock.
   *
   * Called by {@link SessionRunner} once the pair's mutex is held and the agent is ready. The
   * budget used to start at the CLAIM, which charged the time a run spent queued behind the
   * previous turn of the same bot against the model's allowance: a follow-up message then failed
   * with "已用 180s，预算 180s" having produced nothing. Everything before this point is queue
   * time, not execution, so the deadline is recomputed from now and the run's own derived budget
   * (not the cap) still applies.
   */
  onTurnStarted(runId: string): void {
    const budget = this.runBudgets.get(runId)
    if (budget === undefined) return
    const now = Date.now()
    const waitedMs = now - budget.startedAtMs
    if (waitedMs < 1_000) return
    budget.startedAtMs = now
    budget.deadlineAtMs = now + budget.baseBudgetMs
    budget.lastProgressAtMs = now
    budget.lastProgressSeenMs = now
    budget.progressEvents = 0
    budget.lastPersistMs = now
    this.svc.updateRunBudget(runId, {
      deadlineAt: new Date(budget.deadlineAtMs).toISOString(),
      lastProgressAt: new Date(now).toISOString(),
    })
    const waitedS = Math.round(waitedMs / 1000)
    const budgetS = Math.round(budget.baseBudgetMs / 1000)
    this.ctx.logger?.info?.(
      `agent-community: run ${runId} waited ${waitedS}s for its pair's turn — `
      + `execution budget restarted (${budgetS}s)`,
    )
    this.ledger?.push({
      type: 'dispatch',
      roomId: budget.roomId,
      text: `排队等待 ${waitedS}s 后才轮到本回合，执行预算从此刻起重新计时 ${budgetS}s`,
      at: new Date(now).toISOString(),
    })
  }

  /**
   * A real sign of work from the runner: update the in-memory progress clock (authoritative
   * for the deadline check) and persist it at most every few seconds.
   */
  private noteProgress(runId: string, kind: ProgressKind): void {
    const budget = this.runBudgets.get(runId)
    if (budget === undefined) return
    const now = Date.now()
    if (kind === 'tool-start') budget.activeTools += 1
    else if (kind === 'tool-end' && budget.activeTools > 0) budget.activeTools -= 1
    const gap = now - budget.lastProgressAtMs
    if (gap > 0) {
      budget.progressGapsMs.push(gap)
      if (budget.progressGapsMs.length > 32) budget.progressGapsMs.shift()
    }
    budget.lastProgressAtMs = now
    budget.lastProgressSeenMs = now
    budget.progressEvents += 1
    if (now - budget.lastPersistMs >= PROGRESS_PERSIST_INTERVAL_MS) {
      budget.lastPersistMs = now
      this.svc.updateRunBudget(runId, {
        lastProgressAt: new Date(now).toISOString(),
        progressEvents: budget.progressEvents,
      })
    }
  }

  /** Whether a failed attempt may be retried: transient kind AND inside the retry policy. */
  private retryAllowed(attempt: number, kind: FailureKind): boolean {
    return isRetryableFailureKind(kind) && attempt + 1 < this.retryPolicy.maxAttempts
  }

  /**
   * Supervise every run this process is driving.
   *
   * Two independent failures are checked, because they mean different things:
   *   · SILENCE — no progress event for longer than the no-progress window. The turn is hung
   *     (a dead provider stream), so it is cancelled and settled as `no-progress`;
   *   · DEADLINE — the derived budget elapsed. If the run is still progressing it is
   *     EXTENDED (bounded by maxExtensions and the cap); otherwise it is cancelled and
   *     settled as `timeout`.
   *
   * Neither is retried: the budget exists precisely to stop burning tokens on them.
   */
  private async enforceRunBudgets(): Promise<void> {
    if (this.runBudgets.size === 0) return
    const now = Date.now()
    const runs = this.svc.listRuns()
    for (const [runId, budget] of [...this.runBudgets]) {
      // Two ticks can overlap (every `nudge` starts one), so a failure must be claimed
      // once: otherwise both would write a notice and race the same settle CAS.
      if (this.budgetFailures.has(runId)) continue
      const run = runs.find(candidate => candidate.id === runId)
      // A run settled/aborted elsewhere drops out of supervision silently.
      if (run === undefined || run.status !== 'running') {
        this.runBudgets.delete(runId)
        continue
      }
      // ── A RUN WAITING FOR ITS PAIR'S TURN HAS NOT SPENT ITS BUDGET YET ─────────────
      //
      // Two runs of one (room, bot) coexist whenever a second message arrives during the first's
      // turn: the runner serialises them with a per-pair mutex, so this one sits in the queue
      // doing nothing while its deadline ticks. Enforcing that deadline killed a follow-up
      // message at "已用 180s，预算 180s" without it ever sending a request — and the stop it
      // then issued cancelled the turn the OTHER run was driving (that reached a pending
      // approval dialog, which came back as `cancelled` mid-turn).
      //
      // The wait itself stays bounded by the overall cap, so a pair can never queue forever.
      if (this.sessionRunner !== undefined
        && !this.sessionRunner.isTurnOwner(run.roomId, run.botId, runId)) {
        const waitedMs = now - budget.startedAtMs
        if (waitedMs > this.timeoutPolicy.capMs) {
          await this.failRunForBudget(
            run,
            budget,
            'timeout',
            `等待同一 bot 的上一轮结束超过总上限 ${Math.round(this.timeoutPolicy.capMs / 1000)}s`,
          )
        }
        continue
      }
      // ── ACTIVE TOOL EXEMPTION ──────────────────────────────────────────────
      // A shell command / long tool may run for hours without emitting frames or the
      // tool/result event. That is genuine work, not a dead provider stream: suspend
      // the silence rule and roll an expired deadline forward (bounded by cap) until the
      // tool reports. A truly hung tool is still bounded by the overall cap and by the
      // user's stop button.
      if (activeToolExemptsNoProgress(budget.activeTools)) {
        const capAtMs = budget.startedAtMs + this.timeoutPolicy.capMs
        if (now >= capAtMs) {
          await this.failRunForBudget(
            run, budget, 'timeout',
            `活跃工具运行超过总上限 ${Math.round(this.timeoutPolicy.capMs / 1000)}s`,
          )
          continue
        }
        if (now >= budget.deadlineAtMs) {
          budget.deadlineAtMs = Math.min(capAtMs, now + budget.baseBudgetMs)
          this.svc.updateRunBudget(runId, { deadlineAt: new Date(budget.deadlineAtMs).toISOString() })
        }
        continue
      }
      const observedGapP95 = budget.progressGapsMs.length >= 5
        ? percentile(budget.progressGapsMs, 0.95)
        : undefined
      const silenceLimit = noProgressLimitMs(this.timeoutPolicy, observedGapP95)
      // BEFORE THE FIRST PROGRESS EVENT the clock covers agent materialisation, seeding and
      // the first model dispatch — none of which emit frames. Give that start-up twice the
      // window; afterwards the measured silence rule applies unchanged.
      const graceMs = budget.progressEvents === 0
        ? Math.max(silenceLimit, this.timeoutPolicy.noProgressFloorMs * 2)
        : silenceLimit
      const silentFor = now - budget.lastProgressAtMs
      if (silentFor > graceMs) {
        await this.failRunForBudget(
          run,
          budget,
          'no-progress',
          `连续 ${Math.round(silentFor / 1000)}s 无进展（上限 ${Math.round(graceMs / 1000)}s）`,
        )
        continue
      }
      if (now < budget.deadlineAtMs) continue

      const extendInput = {
        nowMs: now,
        deadlineAtMs: budget.deadlineAtMs,
        lastProgressAtMs: budget.lastProgressAtMs,
        policy: this.timeoutPolicy,
        extensions: budget.extensions,
        startedAtMs: budget.startedAtMs,
        baseBudgetMs: budget.baseBudgetMs,
      }
      const verdict = shouldExtend(extendInput)
      if (verdict === 'ok') continue
      if (verdict === 'timed-out') {
        await this.failRunForBudget(
          run,
          budget,
          'timeout',
          `已用 ${Math.round((now - budget.startedAtMs) / 1000)}s，预算 ${Math.round(budget.baseBudgetMs / 1000)}s，延长 ${budget.extensions}/${this.timeoutPolicy.maxExtensions} 次`,
        )
        continue
      }
      const next = nextExtensionDeadline(extendInput)
      if (next === undefined) {
        await this.failRunForBudget(run, budget, 'timeout', '预算与上限已用尽')
        continue
      }
      const added = next - budget.deadlineAtMs
      budget.extensions += 1
      budget.deadlineAtMs = next
      this.svc.updateRunBudget(runId, {
        deadlineAt: new Date(next).toISOString(),
        extensions: budget.extensions,
      })
      this.ctx.logger?.info?.(
        `agent-community: run ${runId} extended (${budget.extensions}/${this.timeoutPolicy.maxExtensions}) `
        + `by ${Math.round(added / 1000)}s — still progressing`,
      )
      this.ledger?.push({
        type: 'dispatch',
        roomId: run.roomId,
        text: `运行时限延长（${budget.extensions}/${this.timeoutPolicy.maxExtensions}）：`
          + `仍在进展，再给 ${Math.round(added / 1000)}s，累计上限 ${Math.round(this.timeoutPolicy.capMs / 1000)}s`,
        at: new Date(now).toISOString(),
      })
    }
  }

  /**
   * Stop a run whose budget was exceeded: tell the service (it pauses a goal continuation and
   * writes the room notice), settle it as `failed` with the reason, THEN cancel the live turn.
   *
   * The order matters: settling first claims the run's revision, so the drive loop's own
   * "aborted" settle can no longer overwrite the outcome with `interrupted` and lose the
   * failure kind. Cancelling after the settle stops the provider stream immediately.
   */
  private async failRunForBudget(
    run: RunSnapshot,
    budget: RunBudgetState,
    kind: 'timeout' | 'no-progress',
    detail: string,
  ): Promise<void> {
    this.runBudgets.delete(run.id)
    this.budgetFailures.add(run.id)
    try {
      await this.applyBudgetFailure(run, budget, kind, detail)
    } finally {
      this.budgetFailures.delete(run.id)
    }
  }

  /** The body of {@link failRunForBudget}; split so the in-flight guard always releases. */
  private async applyBudgetFailure(
    run: RunSnapshot,
    budget: RunBudgetState,
    kind: 'timeout' | 'no-progress',
    detail: string,
  ): Promise<void> {
    const label = kind === 'no-progress' ? '运行无进展，已停止' : '运行超时，已停止'
    try {
      this.svc.onRunTimedOut?.({
        runId: run.id,
        roomId: run.roomId,
        botId: run.botId,
        origin: run.origin,
        prompt: run.prompt,
        kind,
        detail,
      })
    } catch (error: unknown) {
      this.ctx.logger?.warn?.(`agent-community: onRunTimedOut failed: ${String(error)}`)
    }
    let settled = false
    try {
      await this.svc.settleRun({
        id: run.id,
        expectedRevision: run.controlRevision,
        leaseOwner: LEASE_OWNER,
        status: 'failed',
        error: `${label}：${detail}`,
        failureKind: kind,
        retry: false,
        // OP-04: a budget verdict is the harness's own policy, not a model fault.
        evidence: buildRunEvidence({
          durationMs: Date.now() - Date.parse(run.startedAt ?? run.createdAt ?? new Date().toISOString()),
          finishPath: kind === 'timeout' ? 'timeout' : 'no-progress',
          faultSide: 'harness',
        }),
      })
      settled = true
    } catch (error: unknown) {
      this.ctx.logger?.warn?.(
        `agent-community: could not settle ${kind} run ${run.id}: ${String(error)}`,
      )
    }
    try { this.runAborts.get(run.id)?.abort(new Error(kind)) } catch { /* best-effort */ }
    this.sessionRunner?.cancel(
      budget.roomId,
      budget.botId,
      kind === 'no-progress' ? 'no progress' : 'timeout',
      // Scoped to THIS run: a budget verdict is a statement about one run, and the pair's live
      // turn may belong to another run entirely (the queued follow-up case).
      run.id,
    )
    if (!settled) return
    this.ledger?.push({
      type: 'error',
      roomId: run.roomId,
      botId: run.botId,
      botName: this.svc.getBot(run.botId)?.name ?? run.botId,
      message: `${label}：${detail}`,
      at: new Date().toISOString(),
    })
  }

  /**
   * Build the single prompt for one bot turn.
   *
   * Silence is deliberately narrow: a bot may only decline when the message
   * @mentions another member of the same room and not this bot. Every other case
   * must produce a reply — the earlier wording ("reply only if it relates to your
   * role") let the model opt out of ordinary messages, which made the first
   * message in a fresh DM or group go unanswered.
   */
  /**
   * Assemble this turn's prompt AND the per-section measurement (OP-15).
   *
   * The prompt bytes/order are unchanged; `sections` is the same map `assemblePrompt` consumed,
   * kept so the executor can attribute the turn's context cost per section without re-parsing
   * (or storing) the text.
   */
  private composePrompt(
    run: RunSnapshot,
    bot: BotSnapshot | undefined,
    botId: string,
  ): { prompt: string; sections: PromptSections } {
    const roomForFold = this.svc.getRoom(run.roomId)
    const messages = this.svc.listMessages(run.roomId)
    // Folding is a window operation: the folded rows keep their place in the transcript
    // but must not be sent again. `windowForPrompt` used to apply the fold AND the count
    // slice; the budgeted window below owns the slice, so only the fold filter stays.
    const folded = new Set(roomForFold?.foldedSeqs ?? [])
    const visible = folded.size === 0 ? messages : messages.filter(m => !folded.has(m.id))
    // `buildHistoryWindow` drops THIS TURN'S input row (the user's message is already in
    // the transcript, and `[本轮输入]` below repeats it) and enforces a byte budget.
    const history = buildHistoryWindow(
      visible.map(message => ({
        id: message.id,
        // Prefer the model-facing payload: a `/skill` message carries the expanded
        // skill body there while `text` stays the plain draft for display.
        text: message.modelText ?? message.text,
        displayText: message.text,
        senderKind: message.sender.kind,
        senderName: message.sender.name,
      })),
      { maxMessages: this.historyMessages, runPrompt: run.prompt },
    )

    // ── THE ROOM'S ROSTER, NEVER THE COMMUNITY'S ────────────────────────────────
    //
    // This used `listBots()` — every bot that exists — so a two-member group was told
    // it contained all four, and a 1:1 was told it was a group with strangers in it.
    // The models noticed: a bot's own reasoning in a fresh room read "the room rules
    // mention htsrgds an[d jilhjhg]" while the perception block injected in the same
    // turn said "你只能感知以上成员". Naming a non-member also leaks other bots into a
    // private chat, which is the isolation the perception layer is built to keep —
    // `getRoom().memberIds` is the only source of truth for who is in the room.
    const room = this.svc.getRoom(run.roomId)
    const memberIds = room?.memberIds ?? (bot !== undefined ? [bot.id as BotId] : [])
    const members = memberIds
      .map(id => this.svc.getBot(id))
      .filter((b): b is NonNullable<typeof b> => b !== undefined)
    // Kept for the roster-independent parts of the prompt (skill selection uses botId, and
    // `members` still documents who the room holds); the group rule text itself moved to the
    // system prompt.

    // ── THE PROMPT CONTRACT (OP-05, v2 in OP-03) ────────────────────────────────
    //
    // This used to be a `parts: string[]` joined here, which made the section order and the
    // separators an implicit convention of this function — any refactor could reorder two
    // blocks and make every stored evaluation compare different harnesses. The names, order
    // and separator now live in `prompt-contract.ts` and are golden-tested; this function only
    // fills the sections.
    //
    // ROLE ISOLATION: every dynamic section below (role/skills/goal/constraints/memory/history/
    // input) is assembled into ONE user message. None of it is ever placed in the system prompt
    // or in a tool-instruction role — the system prompt is the static bot persona
    // (`bot-prompt.ts`), and the instructions of this turn are only the `[本轮输入]` block.
    // `memory` and `history` are untrusted context evidence; `assemblePrompt` puts the fixed
    // `[上下文证据规则]` guard in front of the first of them, every turn they exist.
    const sections: PromptSections = {}
    if (bot !== undefined) {
      // The bot's own system prompt belongs here. It was only ever read by the LEGACY
      // non-session path, so on the native prompt path — the one every real run takes — a bot
      // created with a system prompt behaved as if it had none.
      const persona = bot.systemPrompt !== undefined && bot.systemPrompt !== ''
        ? `${bot.systemPrompt}\n你是 ${bot.name}。${bot.description ?? ''}`
        : `你是 ${bot.name}。${bot.description ?? ''}`
      sections.role = `[角色]\n${persona}`
    }
    // ── 没有要求就不要开工 ────────────────────────────────────────────────────────────────────────
    // Stated on EVERY turn, not just when a question is pending: a bot that treats an unanswered
    // question (or a bare greeting) as permission to start building produces work nobody asked for.
    // Observed: the user said only 你好, left the question card alone, and the bot wrote a whole
    // brand package. Asking is encouraged; acting without an answer is not.
    // ── THE PER-TURN BLOCKS ARE DYNAMIC ONLY ────────────────────────────────────
    //
    // `[工作边界]`, `[群聊规则]`/`[对话]` and the group-membership line used to be rebuilt
    // here on EVERY turn, byte for byte identical — pure prompt cost, and it also meant the
    // room's rules lived in two places. They now belong to the Bot's SYSTEM PROMPT
    // (`bot-prompt.ts`: bots:boundary, bots:room, bots:collaboration), which is assembled
    // once per session and is the place a model actually looks for standing rules.
    //
    // What stays here is what genuinely changes per turn: the room's goal, this room's
    // memory, the recent window, and the input. (`[本房间记忆]` and `[本房间目标]` are added
    // by the memory/goal work; the roster already reaches the model through the perception
    // layer, which is the only source of truth for who is in the room.)

    // Skills are rendered by the skill lifecycle, which pre-selects the ones that fit
    // THIS bot and still lists the full name universe so nothing is unreachable. The
    // builder used to render its own names-only list, which ignored the profile.
    const skillBlock = this.svc.skillPromptFor(run.roomId, botId)
    if (skillBlock !== undefined && skillBlock !== '') sections.skills = skillBlock
    // ── WHAT THIS BOT ALREADY DID IN THIS ROOM ──────────────────────────────────
    //
    // Before the recent-message window on purpose: this is standing knowledge about the room,
    // while the window is the immediate context. `renderMemoryBlock` receives only this pair's
    // entries, so the block cannot name another room's work — the isolation rule is structural
    // here, not a request written into the prompt.
    // ── THE ROOM'S GOAL ─────────────────────────────────────────────────────────
    //
    // First, because it is the shortest and most stable part of the dynamic context, and the
    // one the model should read before its memory: "what are we doing here" outranks "what
    // have I done here".
    const goal = this.svc.roomGoalBlock(run.roomId)
    if (goal !== undefined) sections.goal = goal
    // ── HARD CONSTRAINTS THE USER STATED (OP-03) ────────────────────────────────
    //
    // Pinned at compaction time from the user's own messages, so a "必须/不要" rule survives
    // the fold that removes the sentence it was stated in. Placed AFTER the goal and BEFORE
    // memory/history on purpose: standing user rules outrank remembered data, and the
    // assembler inserts its trust-boundary guard right after this section.
    const constraints = this.svc.roomConstraintsBlock(run.roomId)
    if (constraints !== undefined && constraints !== '') sections.constraints = constraints
    // ── HOW THIS GROUP WORKS (OP-09) ───────────────────────────────────────────
    //
    // Learned from finished tasks in THIS room (deterministic pattern cards). Placed after the
    // user's hard constraints and before memory/history: it is standing knowledge about the
    // group's way of working, not untrusted transcript data, so the assembler's trust guard
    // stays in front of memory/history only.
    const patterns = this.svc.roomPatternsBlock(run.roomId)
    if (patterns !== undefined && patterns !== '') sections.patterns = patterns
    if (bot !== undefined && this.memoryPromptEntries > 0) {
      // BASELINE ONCE, DELTA AFTER: the executor remembers what this pair has already been
      // shown, so a turn carries the recent memory only when it is the first, and otherwise
      // just the new lines. Repeating the same paragraph every turn is pure prompt cost and it
      // breaks the request prefix cache.
      const key = `${run.roomId}\u0000${bot.id}`
      const delta = renderMemoryDelta(this.svc.botMemoryFor(run.roomId, bot.id), this.injectedMemory.get(key), {
        limit: this.memoryPromptEntries,
      })
      if (delta.block !== undefined) sections.memory = delta.block
      if (delta.newestId !== undefined) this.injectedMemory.set(key, delta.newestId)
    }
    if (history.text !== '') {
      // Say so when the block was clipped: a model that is told the window is partial
      // asks for the file/command instead of assuming the transcript ends there.
      sections.history = `${historyHeader(this.historyMessages, history.truncated)}\n${history.text}`
    }
    sections.input = inputBlock(run.prompt)
    return { prompt: assemblePrompt(sections), sections }
  }

  /** Back-compat for callers/tests that only need the bytes. */
  private buildPrompt(
    run: RunSnapshot,
    bot: BotSnapshot | undefined,
    botId: string,
  ): string {
    return this.composePrompt(run, bot, botId).prompt
  }

  /**
   * One bot turn: stream the model, execute any tools it asks for, and repeat
   * until it answers with text or the tool-round budget runs out.
   *
   * Everything the model produces is mirrored into the ledger *as it arrives* —
   * a `bot-reasoning` entry for thinking, a `bot-text` entry flagged
   * `streaming: true` for the answer, and one `tool-call` + `tool-result` pair per
   * invocation. The panel renders those entries directly, so the user watches the
   * turn progress instead of waiting for a single final blob.
   */
  /**
   * Flip any still-streaming text entries to settled.
   *
   * The panel decides between the deep-diving row and the finished tail from
   * `streaming`, so an entry left flagged true pins the turn on「深度求索中」
   * forever — which is what happened whenever a run threw after text had
   * already started streaming.
   */
  private settleStreamingEntries(ids: ReadonlySet<string>, roomId: BotRoomId): void {
    for (const id of ids) {
      this.ledger?.patch(id, roomId, { streaming: false })
    }
  }

  private async callModel(
    run: RunSnapshot,
    bot: BotSnapshot | undefined,
    prompt: string,
    onProgress?: ((kind: ProgressKind) => void) | undefined,
  ): Promise<{
    text: string
    sessionSeq: SessionSeq
    /** True when the user stopped the run; the caller must NOT report a failure. */
    stopped?: boolean | undefined
    reasoning?: string
    usage?: {
      inputTokens?: number
      uncachedInputTokens: number
      outputTokens: number
      totalTokens: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
    }
  }> {
    // Native-session path. The runner owns the loop; ledger rows arrive through
    // LedgerProjection instead of being pushed from here. `onProgress` is observation
    // only: it feeds the adaptive deadline, and changes nothing the turn produces.
    if (this.sessionRunner !== undefined && bot !== undefined) {
      return await this.callModelViaSession(run, bot, prompt, onProgress)
    }

    const llm = (this.ctx as unknown as {
      llm?: { stream(options: Record<string, unknown>): AsyncIterable<LlmChunk> }
    }).llm
    if (llm?.stream === undefined) {
      throw new Error(
        'agent-community: ctx.llm is unavailable — cannot run a bot turn without the LLM service',
      )
    }
    const provider = bot?.provider
    const model = bot?.model
    if (provider === undefined || model === undefined) {
      throw new Error(
        `agent-community: bot ${bot?.name ?? run.botId} has no provider/model configured`,
      )
    }

    const workspace = bot?.workspace !== undefined && bot.workspace !== ''
      ? bot.workspace
      : process.cwd()
    const runner = new ToolRunner(
      workspace,
      bot?.permission ?? 'workspace-write',
      // Skills resolve through the host registry, so the bot can invoke the same
      // skills the menu offers instead of only being told they exist.
      async (name) => (await this.svc.loadSkill(run.roomId, name))?.content,
    )

    // Bot's own effort wins; otherwise the configured default. Without one the
    // model is never asked to reason and no thinking stream exists to show.
    const effectiveEffort = (bot?.reasoningEffort !== undefined && bot.reasoningEffort !== ''
      ? bot.reasoningEffort
      : this.defaultReasoningEffort)

    // The provider accepts exactly these four values and rejects anything else with
    // UNSUPPORTED_REASONING_EFFORT. An invalid value here is a CONFIGURATION mistake,
    // so fail loudly with the offending string instead of letting the stream die and
    // reporting the generic "model returned no text".
    const EFFORTS = ['off', 'low', 'high', 'max']
    if (effectiveEffort !== '' && !EFFORTS.includes(effectiveEffort)) {
      throw new Error(
        `agent-community: unsupported reasoning effort "${effectiveEffort}" `
        + `(expected one of ${EFFORTS.join(' / ')}, or '' for the provider default)`,
      )
    }

    // System prompt. Native composes this from ORDERED SECTIONS (identity, deployment
    // persona, tool guidance — `dsh-system-prompt` SECTION_ORDERS) rather than one
    // bare line, and the wording materially affects whether the model puts its answer
    // in the visible text channel or only in the reasoning channel. A one-line
    // identity was enough for the model to treat its reasoning as the whole answer.
    // A room with more than one member is a group chat.
    const members = this.svc.getRoom(run.roomId)?.memberIds.length ?? 1
    const groupRoom = members > 1

    const persona = bot?.systemPrompt !== undefined && bot.systemPrompt !== ''
      ? bot.systemPrompt
      : `你是 ${bot?.name ?? 'bot'}。${bot?.description ?? ''}`
    const system = [
      persona,
      groupRoom
        ? '这是一个群聊：群里还有其他人，你只需以自己的身份回应，不必替别人说话，也不必复述别人的内容。'
          // ── SAY IT WHERE THE MODEL LOOKS ────────────────────────────────────────
          //
          // The bot's answer IS published to the room automatically (the executor appends it
          // as a transcript row when the turn ends). Nothing said so, while
          // `agent_community_post_message` was described as "post a message in the room" —
          // and a bot duly answered a greeting and then posted the same answer again, so the
          // user saw two replies to one message (「bot 会对我的消息回复两次」).
          + '你这一轮的正文答复会自动发布到群里，用户直接就能看到；'
          + '不要再用 agent_community_post_message 把自己的答复（或它的摘要、改写）再发一遍——'
          + '那会让用户看到同一个回答两次。该工具只用于把一条消息明确发给群里的另一个 Bot。'
        : '这是一对一会话。',
      '输出要求：把你的答复写在正文里，正文是用户唯一能看到的内容；思考过程用户看不到。'
        + '不要只做分析就结束，任何一轮都必须以给用户的正文答复收尾。',
      '用中文回答，简洁直接，不要输出内部推理过程本身。',
    ].join('\n\n')

    // A user-role RequestUserInput carries `content` as ContentBlock[], NOT a bare
    // string. Passing a string made the adapter project an empty body, which the
    // provider answered with no text at all ("model returned no text").
    // Message shapes mirror `@deepseek-ai/dsh-llm`:
    //   assistant + `tool-call` blocks  → the model's own request
    //   role: 'tool' + `toolCallId`     → the matching result
    // The previous loop appended tool output as a `user` text message and dropped the
    // assistant's tool call entirely, so every round the model saw results answering
    // a request it had no record of making.
    // Field names verified against the provider mapping
    // (`dsh-llm-deepseek`): an assistant `tool-call` block must be
    // `{ type, id, name, arguments }` — it becomes `{ type: 'tool_use', id, name, input }`.
    // The `toolCallId/toolCallName/toolCallArguments` names belong to the STREAM
    // delta chunks, not to message blocks; using them here produced a block with no
    // `id`/`name`, which the provider rejected and the turn ended on `[finish]` with
    // no text at all.
    type Block =
      | { type: 'text'; text: string }
      | { type: 'tool-call'; id: string; name: string; arguments: string }
    type Msg =
      | { role: 'user'; content: Block[] }
      | {
        role: 'assistant'
        content: Block[]
        /**
         * Producer metadata. REQUIRED: the provider's replay validator dereferences
         * `message.source.kind` unconditionally, so omitting it crashes the adapter.
         */
        source: { kind: 'model'; provider: string; model: string }
      }
      | { role: 'tool'; toolCallId: string; content: Block[] }
    const conversation: Msg[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]

    let answer = ''
    let reasoningAll = ''
    let usage: {
      inputTokens?: number
      uncachedInputTokens: number
      outputTokens: number
      totalTokens: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
    } | undefined
    let textEntryId: string | undefined
    // Every bot-text entry left flagged `streaming: true` while the model ran.
    // A throw must settle all of them: the panel renders the deep-diving row
    // from that flag, so an unsettled entry shows "深度求索中" forever.
    const streamingTextEntries = new Set<string>()
    // How many times we have asked the model to turn its reasoning into an answer.
    let reasoningNudges = 0
    // Persisted onto the reply so a restart can rebuild the tool rows: the ledger
    // is in-memory only, so without this every tool call and its output vanished
    // from the panel after a DSH restart.
    const toolActivity: { name: string; status: string; detail?: string }[] = []
    let reasoningEntryId: string | undefined
    let streamedChars = 0
    // Last-resort answer effort. `reasoningEffort` is a PER-REQUEST parameter, so
    // when persuasion has failed the turn can be re-asked with thinking disabled —
    // the model then has only the text channel to write into. This does NOT touch
    // the bot's own setting: it applies to one recovery call inside this turn.
    let answerEffort = effectiveEffort
    // Set once the forced-text recovery call has been issued.
    let forcedText = false

    // Open the turn's bot-text row IMMEDIATELY, empty.
    //
    // The row used to be created on the first text delta, so nothing in the ledger
    // carried `streaming: true` while the model was reasoning or calling tools —
    // which is most of a turn. The panel reads that flag to show the whale and its
    // live timer, so the indicator only appeared once text started arriving, if at
    // all. An empty row renders as no bubble (the panel skips a text block with no
    // text) but does carry the live flag for the whole turn.
    textEntryId = this.ledger?.push({
      type: 'bot-text',
      roomId: run.roomId,
      botId: run.botId,
      botName: bot?.name ?? run.botId,
      runId: run.id,
      text: '',
      streaming: true,
      at: new Date().toISOString(),
    }).id
    if (textEntryId !== undefined) streamingTextEntries.add(textEntryId)

    // The stop controller lives OUTSIDE the round loop. Chaining it into a
    // per-round controller only killed the round in flight: the loop then started
    // the next round and the bot answered anyway, which is exactly "I pressed stop
    // and it kept going".
    const runAbort = this.runAborts.get(run.id)
    let stopped = false
    const onRunAbort = (): void => { stopped = true }
    if (runAbort !== undefined) {
      if (runAbort.signal.aborted) stopped = true
      runAbort.signal.addEventListener('abort', onRunAbort, { once: true })
    }

    try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // A stop between rounds must end the whole turn, not just this round.
      if (stopped) break
      const controller = new AbortController()
      if (runAbort !== undefined) {
        if (runAbort.signal.aborted) controller.abort()
        else runAbort.signal.addEventListener('abort', () => {
          try { controller.abort() } catch { /* noop */ }
        }, { once: true })
      }
      // The legacy in-process loop has no per-run deadline of its own; it inherits the
      // configured cold-start budget so the code path stops carrying a hardcoded timeout.
      const timer = setTimeout(() => controller.abort(), this.timeoutPolicy.bootstrapMs)

      let roundText = ''
      const seenChunks = new Set<string>()
      const toolCalls = new Map<number, { id: string; name: string; args: string }>()

      try {
        const stream = llm.stream({
          provider,
          model,
          // Ask for thinking explicitly; without this the model runs without
          // reasoning and produces no stream to display.
          ...(answerEffort !== '' ? { reasoningEffort: answerEffort } : {}),
          system,
          messages: conversation,
          // Tools are declared on EVERY round.
          //
          // Restricting them to round 0 broke tool use outright: the provider validates
          // the history it is handed and rejects a request whose tool-call blocks have
          // no matching results (`history ends with unresolved tools`), while a model
          // that can see its own `tool_use` blocks but has NO tools to call answers with
          // nothing at all — the turn ended on a bare `finish` chunk with no text and no
          // reasoning. Whether it happened depended on whether the model chose to call a
          // tool on round 0, which is why some bots worked and others did not.
          tools: toolSchemas(bot?.permission ?? 'workspace-write'),
          signal: controller.signal,
        })
        for await (const chunk of stream) {
          onProgress?.('frame')
          seenChunks.add(chunk.type)
          // A provider failure arrives as a TERMINAL `finish` chunk carrying the real
          // error — the adapter converts any throw with `adapterFailureChunk`:
          //   { type: 'finish', reason: { kind: 'error', failure } }
          // Ignoring `reason` is why every rejection surfaced as a useless "model
          // returned no text": the reason (an invalid request, an unresolved tool call,
          // a quota problem) was sitting right there in the chunk.
          if (chunk.type === 'finish') {
            const reason = (chunk as { reason?: { kind?: string; failure?: { code?: string; message?: string } } }).reason
            if (reason?.kind === 'error') {
              const f = reason.failure
              throw new Error(
                `agent-community: provider rejected the request`
                + `${f?.code !== undefined ? ` [${f.code}]` : ''}: ${f?.message ?? 'unknown failure'}`,
              )
            }
            // An abort is a USER STOP, not a failure. Throwing here made the stop
            // button produce an error entry ("model call aborted") in the transcript:
            // the driver's catch pushed it to the ledger even though settleRun was
            // rejected by the revision bump `controlRun('interrupt')` had already made.
            if (reason?.kind === 'aborted') { stopped = true; break }
          }
          if (chunk.type === 'reasoning-delta') {
            reasoningAll += chunk.text
            if (reasoningEntryId === undefined) {
              reasoningEntryId = this.ledger?.push({
                type: 'bot-reasoning',
                roomId: run.roomId,
                botId: run.botId,
                botName: bot?.name ?? run.botId,
                runId: run.id,
                text: reasoningAll,
                at: new Date().toISOString(),
              }).id
            } else {
              this.ledger?.patch(reasoningEntryId, run.roomId, { text: reasoningAll })
            }
          } else if (chunk.type === 'text-delta') {
            roundText += chunk.text
            answer += chunk.text
            streamedChars += chunk.text.length
            if (textEntryId === undefined) {
              // eslint-disable-next-line prefer-const -- assigned once, read after
              textEntryId = this.ledger?.push({
                type: 'bot-text',
                roomId: run.roomId,
                botId: run.botId,
                botName: bot?.name ?? run.botId,
                runId: run.id,
                text: answer,
                streaming: true,
                at: new Date().toISOString(),
              }).id
              if (textEntryId !== undefined) streamingTextEntries.add(textEntryId)
            } else {
              this.ledger?.patch(textEntryId, run.roomId, { text: answer })
            }
          } else if (chunk.type === 'tool-call-delta') {
            const cur = toolCalls.get(chunk.index) ?? { id: '', name: '', args: '' }
            if (chunk.id !== undefined && chunk.id !== '') cur.id = String(chunk.id)
            if (chunk.name !== undefined && chunk.name !== '') cur.name = chunk.name
            cur.args += chunk.argumentsDelta ?? ''
            toolCalls.set(chunk.index, cur)
          } else if (chunk.type === 'block-end') {
            // Some providers emit the assembled block instead of (or in addition
            // to) deltas. Fill in whatever the deltas left blank so a complete
            // block alone is still executable.
            const block = chunk.block
            if (block !== undefined && block.type === 'tool-call') {
              const cur = toolCalls.get(chunk.index) ?? { id: '', name: '', args: '' }
              if (cur.id === '' && block.id !== undefined) cur.id = String(block.id)
              if (cur.name === '' && typeof block.name === 'string') cur.name = block.name
              if (cur.args === '' && typeof block.arguments === 'string') cur.args = block.arguments
              toolCalls.set(chunk.index, cur)
            }
          } else if (chunk.type === 'usage') {
            // Preserve the provider's full accounting so the UI can show the same
            // breakdown the native conversation does (input / cache / output / total).
            usage = {
              inputTokens: chunk.usage.inputTokens ?? 0,
              uncachedInputTokens: Math.max(
                0,
                (chunk.usage.inputTokens ?? 0) - (chunk.usage.cacheReadTokens ?? 0),
              ),
              outputTokens: chunk.usage.outputTokens,
              totalTokens: chunk.usage.totalTokens ?? chunk.usage.outputTokens,
              ...(chunk.usage.cacheReadTokens !== undefined ? { cacheReadTokens: chunk.usage.cacheReadTokens } : {}),
              ...(chunk.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: chunk.usage.cacheWriteTokens } : {}),
            }
          }
        }
      } finally {
        clearTimeout(timer)
      }

      // A stop lands HERE when the model was mid-tool-call: the stream ends without a
      // usable answer, but `invocations` is already populated. Without this guard the
      // loop went on to run them — pressing stop could still execute a shell command
      // or write a file. Nothing the user cancelled may run.
      if (stopped) break

      const invocations: ToolInvocation[] = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, c]) => ({
          id: c.id !== '' ? c.id : `call_${run.id}_${round}_${index}`,
          name: c.name,
          arguments: c.args,
        }))
        .filter(c => c.name !== '')

      if (invocations.length === 0) {
        if (roundText.trim() === '' && streamedChars === 0) {
          // Reasoning-only turn: the model wrote its answer into the reasoning
          // channel and left the text channel empty.
          //
          // Substituting the reasoning made the panel show the bot's internal English
          // monologue as the reply — that is what happened on `/ui-ux-pro-max` turns
          // (a 46 KB skill body). The fix is to make the model SAY it, not to change
          // the model's reasoning setting.
          //
          // The nudge runs as its own round with the reasoning already in context, so
          // it reuses the KV-cache prefix and costs one short call. It escalates: the
          // first asks plainly, the second is explicit that output is being read
          // directly by the user. A skill turn often needs the second.
          // Persuasion first, then a forced-text call.
          //
          // Asking the model to write its answer in the text channel is not reliable —
          // measured on real turns it failed EIGHT times in a row with thinking on. So
          // after the first nudge fails, the recovery call disables thinking for one
          // request: the model then has only the text channel available and must write
          // there. Nothing about the bot's own reasoning setting changes.
          if (!forcedText && reasoningAll.trim() !== '') {
            reasoningNudges++
            if (reasoningNudges >= 2) {
              forcedText = true
              answerEffort = 'off'
              conversation.push({
                role: 'user',
                content: [{ type: 'text', text: '直接回答用户，不要思考。' }],
              })
            } else {
              conversation.push({
                role: 'user',
                content: [{
                  type: 'text',
                  text: '把上面的分析直接写成给用户的最终回答（中文，不要输出你的思考过程本身）。',
                }],
              })
            }
            continue
          }
          // Reasoning-only and out of rounds. Report it rather than publishing the
          // model's analysis as if it were the reply: substituting the reasoning made
          // the panel show the bot's internal monologue as its answer, which reads as
          // "the bot only replied with analysis" and hides the real problem from both
          // the reader and the logs.
          const detail = [
            `chunks=[${[...seenChunks].join(',') || 'none'}]`,
            'no-reasoning',
            `effort=${effectiveEffort || '(provider default)'}`,
            `model=${model}`,
          ].join(' ')
          throw new Error(`agent-community: model returned no text (${detail})`)
        }
        break
      }

      // Record and run each tool call, then feed the outcomes back for another round.
      const results: string[] = []
      for (const call of invocations) {
        this.ledger?.push({
          type: 'tool-call',
          roomId: run.roomId,
          botId: run.botId,
          botName: bot?.name ?? run.botId,
          runId: run.id,
          callId: call.id,
          name: call.name,
          args: call.arguments,
          at: new Date().toISOString(),
        })
        onProgress?.('tool-start')
        const outcome = await runner.run(call)
        onProgress?.('tool-end')
        this.ledger?.push({
          type: 'tool-result',
          roomId: run.roomId,
          botId: run.botId,
          botName: bot?.name ?? run.botId,
          runId: run.id,
          callId: call.id,
          ok: outcome.ok,
          output: outcome.output,
          at: new Date().toISOString(),
        })
        toolActivity.push({
          name: call.name,
          status: outcome.ok ? 'ok' : 'error',
          detail: outcome.output,
        })
        results.push(outcome.ok ? outcome.output : `(失败) ${outcome.output}`)
      }
      // The assistant message that REQUESTED the tools, then one `tool` message per
      // call. Round text (if any) rides along as a text block, matching native.
      conversation.push({
        role: 'assistant',
        // `source` is REQUIRED on an assistant message.
        //
        // The provider's replay validator reads `message.source.kind` and
        // `message.source.replayState` unconditionally, so a message without `source`
        // crashes it with "Cannot read properties of undefined (reading 'replayState')"
        // — which surfaced as a generic provider rejection. Only turns that actually
        // called a tool produce an assistant message, so the failure looked random:
        // a plain reply never exercised the code path.
        //
        // Native builds it as `{ kind: 'model', ... }` (`createAssistantMessage`).
        // `replayState` is intentionally absent: the validator treats a missing
        // replayState as "no replay metadata" and degrades to plain content, which is
        // exactly right for a hand-built message.
        source: { kind: 'model', provider, model },
        content: [
          ...(roundText.trim() !== '' ? [{ type: 'text' as const, text: roundText }] : []),
          ...invocations.map(c => ({
            type: 'tool-call' as const,
            id: c.id,
            name: c.name,
            arguments: c.arguments,
          })),
        ],
      })
      for (let i = 0; i < invocations.length; i++) {
        const call = invocations[i]!
        conversation.push({
          role: 'tool',
          toolCallId: call.id,
          content: [{ type: 'text', text: results[i] ?? '' }],
        })
      }
      // Compact the tool results that are no longer the newest ones.
      //
      // Native runs a real compaction policy (thresholdRatio .8, retainRatio .16 —
      // summarise the old, keep a verbatim tail). Without any budget the loop
      // replayed every tool output in full on every later round, so a five-round
      // turn paid for round one's output five times. Digesting superseded results
      // keeps the newest ones verbatim and bounds the prefix.
      compactToolResults(conversation, MAX_TOOL_RESULT_CHARS, KEEP_VERBATIM_RESULTS)
    }
    } catch (error: unknown) {
      // Settle before propagating: a throw mid-stream would otherwise leave the
      // turn flagged as streaming and the panel pinned on the deep-diving row.
      this.settleStreamingEntries(streamingTextEntries, run.roomId)
      throw error
    }

    // Finalise: the turn is over, so the streamed entry stops being "streaming".
    if (textEntryId !== undefined) {
      this.ledger?.patch(textEntryId, run.roomId, {
        text: answer,
        streaming: false,
        ...(usage !== undefined ? { usage } : {}),
      })
      streamingTextEntries.delete(textEntryId)
    }
    this.settleStreamingEntries(streamingTextEntries, run.roomId)

    // A stop can land before the first token. That is not a model failure, so the
    // "no answer text" diagnostic (which exists to expose a real provider problem)
    // must not fire — return the partial text instead.
    if (stopped) {
      this.ctx.logger?.info?.(
        `agent-community: run ${run.id} stopped by the user after ${String(answer.length)} char(s)`,
      )
      return { text: answer, sessionSeq: 0 as SessionSeq, stopped: true }
    }
    if (answer.trim() === '') {
      throw new Error(
        'agent-community: model produced no answer text '
        + `(effort=${effectiveEffort || '(provider default)'} model=${model} `
        + `rounds=${MAX_TOOL_ROUNDS} nudges=${reasoningNudges})`,
      )
    }
    // A bot that declined to speak produces no message at all, so a group room
    // does not fill up with "no comment" replies. Match tolerantly: the model may
    // wrap the marker in punctuation or restate it as "无需补充".
    return {
      text: answer,
      sessionSeq: 0 as SessionSeq,
      ...(reasoningAll !== '' ? { reasoning: reasoningAll } : {}),
      ...(toolActivity.length > 0 ? { toolActivity } : {}),
      ...(usage !== undefined ? { usage } : {}),
    }
  }

}
