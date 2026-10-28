/** Agent Community core service — Bot management, rooms, messaging, run scheduling, and state persistence. */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { withFileLock, writeFileAtomic } from './atomic.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type {
  BotCommunitySnapshot, BotId, BotIdentity, BotMessage, BotMessageId,
  BotRoom, BotRoomId, BotRun, BotRunId, BotMailboxItem,
  ControlBotRunRequest, CreateBotRequest, CreateRoomRequest,
  DeleteBotRequest, DeleteRoomRequest, RetryBotRunRequest,
  SendRoomMessageRequest, SettleBotRunRequest, UpdateBotRequest, UpdateRoomRequest,
  SendRoomMessageAttachment, BotMessageAttachment,
  BotProfileBinding, BotPresence, BotTeam, BotTeamMembership,
  BotMessageUsage,
  DismissTeamRequest, PostTeamMessageRequest, TeamMessageResult,
  CreateTeamRequest, BotTeamMessageKind, BotTeamRunOrigin,
  BotTask, BotTaskStatus,
  DecomposeTasksRequest, AssignTasksRequest, ReportTaskRequest,
  PostBotMessageRequest, SubmitFinalRequest,
  GroupProposal, ConfirmGroupRequest, DeclineGroupRequest, ProposeGroupRequest,
  BotSkillProfile, PendingGroupProposal, RoomTaskState, RoomTaskAssignment,
  AnswerBotQuestionRequest,
  MarkRoomReadRequest,
  NoticeRoomRequest,
  BotRoomNotice,
  BotMemoryEntry,
  RoomGoal,
  DeliveredFile,
  AbstainRequest,
  RoomPatternRequest,
  UpdateRoomExperienceRequest,
  HarnessAttribution,
  FinishEvidence,
  RunEvidence,
} from './types.ts'
import { routeMessage, namedBotIdsIn, mentionsEveryone } from './routing.ts'
import { abstainNotice, normalizeAbstain, normalizeThreading } from './abstention.ts'
import { renderAttachmentReference, storeAttachments, type StoredAttachment } from './attachments.ts'
import { RunExecutor } from './runs.ts'
import { LedgerProjector, type SeedRoomItem } from './ledger.ts'
import type { LedgerEntry } from './ledger.ts'
import { ApprovalBridge } from './approval-bridge.ts'
import { QuestionBridge } from './question-bridge.ts'
import { advanceSchedule, dueSchedules, planImport, type BotSchedule, type HostScheduleRow } from './bot-schedules.ts'
import type { ApprovalBridgeAccessor } from './approval-bridge.ts'
import { SkillLifecycle, type LlmStream, type SkillEntry } from './skills-profile.ts'
import { DEFAULT_MAX_ROUNDS, GroupFlowService, type GroupFlowPort } from './group-flow.ts'
import { SessionRunner, optionalService, DEFAULT_DENIED_TOOLS } from './session-runner.ts'
import { CURRENT_VERSION, emptyState, parsePersistedState, type PersistedState, type RoomAgentSession } from './persistence.ts'
import { decideReadMark, repairReadMarks, totalUnread, unreadByRoom } from './unread.ts'
import { LedgerProjection } from './ledger-projection.ts'
import { GroupTaskDriver, type GroupTaskState } from './group-task.ts'
import { chooseFinalDelivery, publishOf, type RunPublish } from './publish-policy.ts'
import { checkFinishEvidence } from './finish-gate.ts'
import { taskAdherence } from './adherence.ts'
import { ReputationWatchdog } from './reputation.ts'
import {
  buildGroupPatternCard,
  composeExperienceText,
  mergeGroupPatterns,
  renderExperienceBlock,
  renderGroupPatternsBlock,
} from './group-patterns.ts'
import { normalizeSubscriptions } from './intent-subscription.ts'
import { assessGoalDrift } from './goal-drift.ts'
import { diagnoseRunFailure } from './run-diagnosis.ts'
import { copyHandoffFile, planFileHandoff } from './file-handoff.ts'
import { buildRunEvidence, classifyFaultSide, finishPathOf } from './run-evidence.ts'
import { registerCollaborationTools } from './collaboration-tools.ts'
import { crossRoomError, screenRoomCreation, type RoomCreationActor } from './room-guard.ts'
import {
  applyBotGoalChange, applyUserGoalChange, authorizeGoal, authorizedRoundBudget,
  canEditGoal, canReadGoal, describeGoal, goalAuthorizationUsable,
  goalContinuationDecision, goalPromptBlock, pauseGoal, resumeGoal,
  DEFAULT_GOAL_MAX_ROUNDS, GOAL_STALL_LIMIT, type BotGoalAction, type GoalActor,
} from './room-goal.ts'
import { planDispatch, handoffReport, MAX_DISPATCH_TASKS, type DispatchTask } from './dispatch.ts'
import {
  buildHarnessAttribution,
  readPluginVersion,
  HARNESS_REVISION,
} from './harness-attribution.ts'
import { PROMPT_CONTRACT_VERSION } from './prompt-contract.ts'
import {
  classifyFailure,
  isRetryableFailureKind,
  resolveRetryPolicy,
  retryBackoffMs,
  DEFAULT_RUN_RETRY_POLICY,
  DEFAULT_RUN_TIMEOUT_POLICY,
  type RunRetryPolicy,
  type RunTimeoutPolicy,
} from './run-budget.ts'
import {
  summarizeSnapshotMessages,
  summarizeSnapshotRuns,
} from './snapshot-lite.ts'
import { searchMemory, taskMemoryText } from './bot-memory.ts'
import { MemoryStore, memoryPaths, type RoomMemoryMeta } from './memory-store.ts'
import { scanPromotions } from './memory-promote.ts'
import { decayForCorrections, entryMetaForNote, entryMetaForRun } from './memory-lifecycle.ts'
import { Maintenance, type MaintenanceHost } from './maintenance.ts'
import { findBotByName, requireBot, requireRoom, NotFoundError } from './lookup.ts'
import { resolveRoomLeader } from './room-leader.ts'
import {
  COMPACT_SENDER_NAME,
  checkpointCreatedAt,
  clampKeepLast,
  extractPinnedConstraints,
  foldedMessageIds,
  mergePinnedConstraints,
  roomConstraintsText,
  splitForCompaction,
  summariseHistory,
  summaryMessageText,
  type CompactRoomRequest,
  type CompactRoomResult,
  type CompactStream,
} from './compact.ts'

/**
 * Convert the driver's runtime state to its persisted form, and back.
 *
 * `GroupTaskDriver` keeps a `Set` of running bots (fast membership) and a queue of
 * unread reports (drained per integrate turn); `RoomTaskState` is a plain readonly
 * snapshot. The conversion is explicit rather than structural so a field added on one
 * side cannot silently disappear from the other.
 */
function toRoomTaskState(state: GroupTaskState, previous?: RoomTaskState | undefined): RoomTaskState {
  const assignments = state.assignments.map(a => ({
    id: `${a.botId}:${a.at}`,
    botId: brandId<BotId>(a.botId),
    task: a.task,
    at: a.at,
    status: a.status === 'running' ? 'working' : a.status === 'done' ? 'done' : 'blocked',
    ...(a.result !== undefined ? { report: { text: a.result, at: a.at } } : {}),
  })) as readonly RoomTaskAssignment[]
  return {
    round: state.round,
    // ⚠️ WAS HARD-CODED 0. `group-flow.ts` compares `round > state.maxRounds` against the PERSISTED
    // board, so every save reset the budget to zero and the next advance (1 > 0) finalised the board
    // with "已达轮次上限 0，收尾" — the giveaway was the dock card showing "0/1". Carry the existing
    // budget forward and default to the configured one for a board that has none yet.
    maxRounds: previous?.maxRounds ?? DEFAULT_MAX_ROUNDS,
    assignments,
    // P2: the adherence scorecard is DERIVED from the persisted board, never a writer's claim.
    adherence: taskAdherence({ assignments, finished: state.finished }),
    // The user's original task text survives a conversion; a member hand-off restates it verbatim.
    ...(previous?.objective !== undefined ? { objective: previous.objective } : {}),
    ...(state.finished !== undefined ? { finished: state.finished } : {}),
    // OP-07: the version metadata is carried, never bumped here — `task-board.ts`/group-flow own
    // the bump. Copying it keeps optimistic concurrency working across the driver conversion.
    ...(previous?.schemaVersion !== undefined ? { schemaVersion: previous.schemaVersion } : {}),
    ...(previous?.version !== undefined ? { version: previous.version } : {}),
    ...(previous?.updatedAt !== undefined ? { updatedAt: previous.updatedAt } : {}),
  }
}

function fromRoomTaskState(state: RoomTaskState | undefined): GroupTaskState | undefined {
  if (state === undefined) return undefined
  return {
    round: state.round,
    stalledRounds: 0,
    assignments: state.assignments.map(a => ({
      botId: a.botId,
      task: a.task,
      at: a.at,
      status: a.status === 'done' ? 'done' : a.status === 'blocked' ? 'failed' : 'running',
      ...(a.report !== undefined ? { result: a.report.text } : {}),
    })),
    runningBotIds: new Set<string>(),
    pendingReports: [],
    ...(state.finished !== undefined ? { finished: state.finished } : {}),
    // NOTE (OP-07): `schemaVersion`/`version`/`updatedAt` are PERSISTED board metadata. The
    // in-memory driver has no writer for them (group-flow/task-board own the bumps), so the
    // conversion leaves them on `room.taskState`; `toRoomTaskState` copies them back on the next
    // save. Dropping them here would reset optimistic concurrency to 0 on every load.
  }
}

export type * from './types.ts'
export type { BotId, BotRoomId, BotRunId, BotMessageId } from './types.ts'

export const name = 'agent-community'

export interface Config {
  readonly maxBots?: number
  readonly maxRooms?: number
  readonly maxMessages?: number
  readonly maxRuns?: number
  /**
   * Explicit agent-community home — where `agent-community/state.json` lives.
   *
   * Highest precedence. When unset the home is the HARNESS home (`$DSH_HOME`, else
   * `~/.dsh`), so a second runtime started with an isolated `$DSH_HOME` no longer
   * reads and writes the first one's board.
   */
  readonly homeDir?: string
  /** Max runs executing concurrently (default 2). */
  readonly maxConcurrentRuns?: number
  /**
   * DEPRECATED legacy knob. Kept only so an older deployment patch that sets it still
   * parses; the runtime deadline is ADAPTIVE now (see `runTimeoutPolicy`). Its default is
   * the policy bootstrap, not a hidden 600 s constant.
   */
  readonly runTimeoutMs?: number
  /**
   * Lease duration in milliseconds (default 60_000). The heartbeat cadence is lease/4, so
   * this one option controls both; it used to be a dead setting with 60 s hardcoded twice.
   */
  readonly runLeaseMs?: number
  /**
   * Adaptive task-time allowance: the deadline comes from measured run durations, per
   * (bot, origin, task class), never from one hardcoded number. Every field is configurable;
   * defaults live in `run-budget.ts` (bootstrap 15 min, floor 3 min, cap 2 h, p95 × 1.5,
   * no-progress 2 min–30 min, up to 2 × 50 % extensions).
   */
  readonly runTimeoutPolicy?: Partial<RunTimeoutPolicy>
  /** Retry budget for transient failures: attempts + exponential backoff base. */
  readonly runRetryPolicy?: Partial<RunRetryPolicy>
  /**
   * How many IDLE bot agents stay materialised (default 12). Past this the
   * least-recently-used one is disposed, which releases its session write lease —
   * so this is the knob that decides when another runtime may open that session.
   */
  readonly idleLimit?: number
  /** Ceiling on total live agents, running ones included (default 24). */
  readonly hardLimit?: number
  /** Number of recent room messages to include in each Bot prompt (default 10). */
  readonly historyMessagesInPrompt?: number
  /**
   * @deprecated NOT READ BY ANY CODE (verified across the package): a2a chattiness is bounded
   * by the one-hop rule instead — a bot answering a peer message never starts another run
   * (see `postBotMessage`). Kept only so existing config files and the schema keep parsing;
   * removing it is a separate, user-visible config change.
   */
  readonly a2aMinIntervalMs?: number
  /**
   * How long the user has to answer a group proposal before it counts as a refusal
   * (§5.4 timeout = decline). Defaults to the panel dialog's own two minutes so the
   * two deadlines agree; this one is the backstop for a closed panel.
   */
  readonly groupProposalTimeoutMs?: number
  /**
   * Where DSH keeps its session logs. Defaults to `<home>/sessions` — the same
   * `~/.dsh/sessions` the runtime uses. Overridable so a test can exercise the
   * deletion and sweep paths without touching the user's real session store.
   */
  readonly sessionsDir?: string
  /**
   * Default reasoning effort for bot model calls when a bot sets none. Bot turns
   * only produce a visible thinking stream when reasoning is requested, so this
   * is what makes the panel show thinking at all. Set to '' to disable.
   */
  readonly botReasoningEffort?: string
  /** Agent preset for bot sessions (default `standard`). */
  readonly botAgentPreset?: string
  /** Global tools bot sessions must never see (default `['plugin_manager']`). */
  readonly botDeniedTools?: string[]
  /** Maximum files one `agent_community_deliver` call may declare (DSH present uses 8). */
  readonly deliverMaxFiles?: number
  /**
   * How many remembered entries one (room, bot) pair keeps, newest kept (default 12).
   *
   * Every finished turn adds one line, so this is what bounds the board and the rendered prompt
   * block. Set to 0 to keep bots from remembering anything automatically — an explicit
   * `agent_community_remember` note is still stored, because the bot asked for it.
   */
  readonly memoryEntriesPerRoom?: number
  /** How many of those entries are rendered into a turn's prompt (default 8). */
  readonly memoryPromptEntries?: number
}

/** The mirror's key for one (room, bot) pair. Room first, so a room prefix is a valid filter. */
function memoryKey(roomId: string, botId: string): string {
  return `${roomId}\u0000${botId}`
}

export const Config: z<Config> = z.object({
  maxBots: z.number().step(1).min(1).default(32),
  maxRooms: z.number().step(1).min(1).default(64),
  maxMessages: z.number().step(1).min(1).default(10_000),
  maxRuns: z.number().step(1).min(1).default(1_000),
  /**
   * Explicit agent-community home. Highest precedence; defaults to the harness home
   * (`$DSH_HOME`, else `~/.dsh`) — see `resolveAgentCommunityHome`.
   */
  homeDir: z.string().required(false),
  maxConcurrentRuns: z.number().step(1).min(1).default(8),
  // Legacy: defaulted to the ATA bootstrap so no runtime path carries a hardcoded 600 s.
  runTimeoutMs: z.number().step(1).min(1000).default(DEFAULT_RUN_TIMEOUT_POLICY.bootstrapMs),
  runLeaseMs: z.number().step(1).min(5000).default(60_000),
  /**
   * Adaptive timeout policy. Optional as a whole (defaults are applied in code); when the
   * deployment sets it, each furnished field overrides that one default.
   */
  runTimeoutPolicy: z.object({
    bootstrapMs: z.number().step(1).min(1000).default(DEFAULT_RUN_TIMEOUT_POLICY.bootstrapMs),
    floorMs: z.number().step(1).min(1000).default(DEFAULT_RUN_TIMEOUT_POLICY.floorMs),
    capMs: z.number().step(1).min(1000).default(DEFAULT_RUN_TIMEOUT_POLICY.capMs),
    sampleWindow: z.number().step(1).min(5).default(DEFAULT_RUN_TIMEOUT_POLICY.sampleWindow),
    safetyFactor: z.number().min(1).default(DEFAULT_RUN_TIMEOUT_POLICY.safetyFactor),
    noProgressFactor: z.number().min(1).default(DEFAULT_RUN_TIMEOUT_POLICY.noProgressFactor),
    noProgressFloorMs: z.number().step(1).min(1000).default(DEFAULT_RUN_TIMEOUT_POLICY.noProgressFloorMs),
    noProgressCapMs: z.number().step(1).min(1000).default(DEFAULT_RUN_TIMEOUT_POLICY.noProgressCapMs),
    extendFactor: z.number().min(0).default(DEFAULT_RUN_TIMEOUT_POLICY.extendFactor),
    maxExtensions: z.number().step(1).min(0).default(DEFAULT_RUN_TIMEOUT_POLICY.maxExtensions),
  }).required(false),
  runRetryPolicy: z.object({
    maxAttempts: z.number().step(1).min(1).default(DEFAULT_RUN_RETRY_POLICY.maxAttempts),
    backoffMs: z.number().step(1).min(0).default(DEFAULT_RUN_RETRY_POLICY.backoffMs),
  }).required(false),
  /**
   * How many IDLE bot agents stay materialised. Past this the least-recently-used
   * one is disposed — which is also what releases its session's write lease.
   *
   * Exposed because it was a constant: a deployment (or a test that wants to watch
   * one eviction) had no way to lower it, and the disposal path is exactly where a
   * held lease used to leak.
   */
  idleLimit: z.number().step(1).min(1).default(12),
  /** Ceiling on total live agents; RUNNING ones may push the total up to here. */
  hardLimit: z.number().step(1).min(1).default(24),
  historyMessagesInPrompt: z.number().step(1).min(0).default(10),
  // Deprecated and unread (see Config.a2aMinIntervalMs): not deleted so existing user configs
  // keep parsing. New throttling belongs next to the code that enqueues a2a runs.
  a2aMinIntervalMs: z.number().step(1).min(0).default(3_000),
  groupProposalTimeoutMs: z.number().step(1).min(1000).default(120_000),
  sessionsDir: z.string().required(false),
  /**
   * Default reasoning effort for bot turns. `''` means "whatever the provider/model defaults
   * to", and it is the only value that is safe on every route: a model that publishes no
   * reasoning levels — every hand-declared `api: openai-completions` model row — REJECTS any
   * explicit level with UNSUPPORTED_REASONING_EFFORT before the request leaves the process
   * (`resolveCallWithInfo`: `reasoning === undefined && requested !== undefined` throws), so a
   * non-empty default here makes every bot turn fail on such a deployment. A provider that does
   * publish levels still honours what each bot sets for itself (see the bot settings form).
   */
  botReasoningEffort: z.string().default(''),
  /**
   * Agent preset every bot session runs under. `standard` is the deployment's normal
   * session profile, so bots see the same tool families the user does.
   */
  // The DEFAULT matters more than the runtime expression below: a schema default always
  // supplies a value, so `config.botAgentPreset ?? 'bot'` never fell through and every bot kept
  // mounting `standard` (measured: the mount log said `ok preset=standard` after the switch was
  // supposedly in place). This field is the switch.
  botAgentPreset: z.string().default('bot'),
  /**
   * Global tools a bot must never see. `plugin_manager` can disable or uninstall plugins
   * (this one included); `ask_user_question` waits on a UI a hidden bot session does not
   * have, so a bot would stall on a question the user never sees. A deployment can narrow
   * or widen the mask here without touching code.
   */
  // `skill` joins the list: bots get the plugin's own wrapper so every loaded skill body carries the
  // "method, not an order" framing (see collaboration-tools.ts).
  botDeniedTools: z.array(z.string()).default(['plugin_manager', 'ask_user_question', 'skill']),
  /**
   * Files one deliverable declaration may carry. Same ceiling as DSH's `present`
   * (`maxFiles: 8`); the prompt asks the model for 1-2 and the panel collapses >4.
   */
  deliverMaxFiles: z.number().step(1).min(1).max(32).default(8),
  /**
   * Remembered entries kept per (room, bot). 0 disables automatic task memory but still stores
   * an explicit `agent_community_remember` note — that one the bot asked for by name.
   */
  memoryEntriesPerRoom: z.number().step(1).min(0).default(12),
  /** Entries rendered into one turn's prompt (newest first, oldest dropped). */
  memoryPromptEntries: z.number().step(1).min(0).default(8),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentCommunity: AgentCommunityService
  }
}

/**
 * How long a state write waits for the writer lock before giving up.
 *
 * Generous on purpose — a real peer's write is milliseconds — while still bounded,
 * because the alternative (waiting for ever) is what wedged a live board.
 */
const STATE_LOCK_WAIT_MS = 30_000

/**
 * A lock file with no owner record is abandoned; one that is merely old is suspicious.
 *
 * `dsh-atomic-write` writes `<path>.lock` as `wx` and recovers a lock whose recorded
 * PID is gone — but an EMPTY lock file yields no record, so it can never be taken over
 * and simply blocks every later writer. That is not hypothetical: this plugin's own
 * `state.json.lock` was found sitting at zero bytes after a process was killed
 * mid-write, and from then on every state write waited for ever — orders, run
 * settlements and run recovery all updated memory and never reached the disk, so a
 * stale run could not be cleared and its room showed 排队 for ever.
 */
const STALE_LOCK_AGE_MS = 10 * 60_000

/**
 * How long mutations are coalesced before one state write.
 *
 * Inside the panel's 400 ms poll window and short enough that a crash loses at most a quarter
 * of a second of state; long enough that the four writes one settled run used to enqueue
 * (runs, messages, goal, ledger) collapse into ONE. Deletion/session paths do not wait for
 * this: they call `flushNow()`, which cancels the timer and writes immediately.
 */
const WRITE_COALESCE_MS = 250

/**
 * Minimum gap between two goal-drift warnings for one room (OP-13).
 *
 * The watchdog is advisory. One visible notice per room per ten minutes keeps a drifting room
 * informed without burying the transcript in duplicates while nothing changed.
 */
const GOAL_DRIFT_NOTICE_INTERVAL_MS = 10 * 60_000

/** How many run ids the diagnosis dedupe set remembers before evicting the oldest. */
const DIAGNOSED_RUN_IDS_MAX = 200

/** Read the PID a lock file records, or undefined when it records nothing usable. */
async function recordedLockPid(lockPath: string): Promise<number | undefined> {
  try {
    const raw = await readFile(lockPath, 'utf8')
    const pid = Number.parseInt(raw.trim(), 10)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** Whether a PID is still running (signal 0 probes without delivering anything). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    // EPERM means it exists but belongs to someone else; only ESRCH is proof of death.
    return (error as { code?: string } | undefined)?.code === 'EPERM'
  }
}

/**
 * Take the write lock for one state file, clearing an abandoned one if needed.
 *
 * Same protocol as `dsh-atomic-write`'s lock (create `.lock` with `wx`, delete it
 * afterwards) but with two properties that file has and this plugin needs:
 *
 *  · the wait is BOUNDED, so a permanently held lock surfaces as a logged write
 *    failure instead of a Promise that never settles (the write queue is serialized
 *    behind that Promise, so one stuck lock silently stops every later write);
 *  · a lock that provably has no live owner is cleared instead of waited on — an
 *    EMPTY lock file yields no owner record at all, so the library's own takeover
 *    check can never recover it and it blocks the board for ever.
 *
 * The wait is also sized to the evidence: `withFileLock` writes the lock file EMPTY
 * and fills the PID in a moment later, so an empty lock is either a writer in its
 * first milliseconds or a corpse — never a writer that has been working for seconds.
 * An empty lock therefore gets a short grace period, while a recorded owner gets the
 * full wait (a real peer's write is milliseconds anyway).
 *
 * @param statePath - the state file whose `<statePath>.lock` guards it.
 * @param operation - the write to run while the lock is held.
 * @returns whatever `operation` returns.
 * @throws when the lock cannot be taken, naming what was holding it.
 */
async function withStateLock<T>(statePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${statePath}.lock`
  const ageOfLock = (): Promise<number | undefined> =>
    stat(lockPath).then((info) => Date.now() - info.mtimeMs).catch(() => undefined)
  // How long an EMPTY lock may be believed to belong to a writer that is still starting.
  // `withFileLock` creates the file and records its PID a moment later, so an empty lock
  // has either just appeared (a peer mid-acquire) or is a corpse left by a killed write.
  const EMPTY_LOCK_GRACE_MS = 3_000
  const attempt = (waitMs: number): Promise<T> => withFileLock(statePath, operation, { waitMs })
  const ownerNow = (): Promise<number | undefined> => recordedLockPid(lockPath)
  const lockAge = (): Promise<number | undefined> => ageOfLock()
  const abandoned = async (): Promise<boolean> => {
    const owner = await ownerNow()
    if (owner !== undefined) {
      const ageMs = await lockAge()
      return !processAlive(owner) || (ageMs !== undefined && ageMs > STALE_LOCK_AGE_MS)
    }
    const ageMs = await lockAge()
    // No file at all: nothing is holding it.
    return ageMs === undefined || ageMs > EMPTY_LOCK_GRACE_MS
  }
  if (await abandoned()) await rm(lockPath, { force: true }).catch(() => undefined)

  // The wait is sized to the evidence: an empty lock is never a peer that has been
  // writing for seconds, so it only gets the grace period; a recorded (live) owner gets
  // the full timeout, which a real write — milliseconds — never approaches.
  const owner = await ownerNow()
  const waitMs = owner === undefined ? EMPTY_LOCK_GRACE_MS : STATE_LOCK_WAIT_MS
  try {
    return await attempt(waitMs)
  } catch (first: unknown) {
    if (!await abandoned()) throw first
    await rm(lockPath, { force: true }).catch(() => undefined)
    try {
      return await attempt(EMPTY_LOCK_GRACE_MS)
    } catch (second: unknown) {
      throw new Error(
        `agent-community: could not take the state writer lock at ${lockPath} even after clearing an `
        + `abandoned one (first: ${String(first)}; retry: ${String(second)})`,
      )
    }
  }
}

/**
 * Resolve which directory holds this plugin's own data (`agent-community/state.json`,
 * `agent-community/workspaces`, `sessions`).
 *
 * WHY THIS FUNCTION EXISTS
 *
 * The plugin used to resolve its home as `config.homeDir ?? join(homedir(), '.dsh')`,
 * ignoring the harness home entirely. DSH itself keeps ALL user data under
 * `resolveDshHome()` (`$DSH_HOME`, else `~/.dsh`), so a second runtime started with
 * `DSH_HOME=/tmp/x` — the documented way to isolate an instance — still read and wrote
 * the FIRST runtime's board. Two consequences, both observed on the real app:
 *
 *   1. A test instance silently polluted the user's real board (its messages, runs and
 *      a test Bot all landed in `~/.dsh/agent-community/state.json`).
 *   2. Two runtimes sharing one board also share one session store, and each bot's
 *      session carries a kernel write lease (`flock`) held for the agent's whole life —
 *      so the second runtime failed every turn with `SessionAlreadyOwnedError`, which
 *      the user saw as the red 运行失败 banner.
 *
 * Precedence: `config.homeDir` → `$DSH_HOME` → `~/.dsh`.
 *
 * BACK-COMPATIBILITY: an installation whose board still lives in `~/.dsh` keeps using
 * it when the harness home has no board yet but the legacy path does (an existing
 * profile booted with a fresh `$DSH_HOME`, for example). Only a genuinely new home —
 * empty, as a test instance's would be — is adopted, which is exactly what makes
 * isolation work; `~/.dsh` stays the last resort so no existing user sees an empty board.
 *
 * @param input.configured - `config.homeDir`, if the deployment set one.
 * @param input.env - environment to read `$DSH_HOME` from (defaults to `process.env`).
 * @param input.legacyStatePath - the pre-existing `<~/.dsh>/agent-community/state.json`.
 * @param input.exists - state-file probe, injected so this stays pure and testable.
 * @param input.warn - optional diagnostic sink.
 * @returns the absolute home directory.
 */
export function resolveAgentCommunityHome(input: {
  configured?: string | undefined
  env?: Record<string, string | undefined>
  legacyStatePath: string
  exists: (path: string) => boolean
  warn?: ((message: string) => void) | undefined
}): string {
  const expand = (path: string): string => resolve(path.replace(/^~(?=[/\\]|$)/u, homedir()))
  if (input.configured !== undefined && input.configured.trim() !== '') {
    return expand(input.configured)
  }
  const env = input.env ?? process.env
  const fromEnv = env.DSH_HOME
  const harnessHome = fromEnv !== undefined && fromEnv.trim() !== ''
    ? expand(fromEnv)
    : join(homedir(), '.dsh')
  const hasBoard = (home: string): boolean => input.exists(join(home, 'agent-community', 'state.json'))
  if (hasBoard(harnessHome)) return harnessHome
  if (harnessHome !== join(homedir(), '.dsh') && hasBoard(join(homedir(), '.dsh'))) {
    input.warn?.(
      `agent-community: the harness home (${harnessHome}) has no board yet, but `
      + `${input.legacyStatePath} does — using the existing board. Point homeDir (or `
      + `$DSH_HOME) at a fresh directory to get an isolated board.`,
    )
    return join(homedir(), '.dsh')
  }
  return harnessHome
}

function brandId<T extends string>(raw: string): T {
  return raw as T
}

function nowIso(): string {
  return new Date().toISOString()
}

function defaultProfile(name: string): BotProfileBinding {
  return {
    profileId: `bot-${name.toLowerCase().replace(/\s+/g, '-')}`,
    memoryNamespace: `bot-${name.toLowerCase().replace(/\s+/g, '-')}`,
  }
}

/** Persistent Bot Community service. */
/**
 * Duration to stamp on a settled run's ledger rows.
 *
 * Uses the *updated* run so the freshly written `finishedAt` is included — reading
 * the pre-settle snapshot would compute the duration against a missing end time and
 * collapse it to zero.
 */
function terminalDurationMs(
  prev: { startedAt?: string | undefined; createdAt: string },
  updated: { finishedAt?: string | undefined; status: string },
): number | undefined {
  // Only a normally finished run reports a completion time; a cancelled run does not.
  if (updated.status !== 'completed') return undefined
  const ms = runDurationMs({ ...prev, finishedAt: updated.finishedAt })
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/**
 * Wall-clock duration of a run, from its start to its finish.
 *
 * `startedAt` is set when the run leaves the queue; fall back to `createdAt` so a run
 * that never got claimed still reports something sensible rather than NaN.
 */
function runDurationMs(run: { startedAt?: string | undefined; createdAt: string; finishedAt?: string | undefined }): number {
  const start = Date.parse(run.startedAt ?? run.createdAt)
  const end = Date.parse(run.finishedAt ?? new Date().toISOString())
  if (Number.isNaN(start) || Number.isNaN(end)) return 0
  return Math.max(0, end - start)
}

export class AgentCommunityService extends TypertRemoteService {
  // 'approval' and 'permissionPresets' are read via (ctx as unknown as {...}) at runtime;
  // Cordis 4 throws "cannot get property X without inject" the moment they are accessed,
  // so they must be listed here even though we use optional-chaining after the cast.
  //
  // 'llm' is how bot turns are executed (RunExecutor.callModel → ctx.llm.stream).
  // 'sessions'/'agents' remain for the host-runner and session bookkeeping; the run
  // executor no longer materialises DSH Agents, so nothing it does creates a Session.
  static inject = [
    'sessions', 'agents', 'workspaceRegistry', 'approval', 'permissionPresets', 'llm',
    // The Host desktop surface (open/reveal/list applications for one path). The
    // service exposes no session identity in these calls, so it is safe to reach from
    // the plugin's host half — this is the same implementation DSH's chat cards use.
    'sessionController',
    // NOTE: `skills` is deliberately NOT listed here. Cordis only activates a
    // plugin once every injected service exists, so requiring it made the whole
    // plugin disappear whenever the skill packages were absent. It is read
    // opportunistically instead (see skillsRegistry).
  ] as const
  static Config: z<Config> = Config

  private state: PersistedState = emptyState()
  /** Root of this plugin's own data — see `resolveAgentCommunityHome`. */
  private readonly home: string
  private readonly statePath: string
  private readonly sessionsDir: string
  private saveQueue: Promise<void> = Promise.resolve()
  /**
   * Pending coalesced write, if any.
   *
   * Every state mutation used to enqueue its own FULL write of state.json (8+ MB on this
   * board, including one per heartbeat). A mutation burst — one settled run updates runs,
   * messages, ledger and goal — therefore serialized several full copies of the same growing
   * file. This timer collapses all mutations inside one window into a single write of the
   * CURRENT state; `flushNow` bypasses and drains it.
   */
  private writeTimer: ReturnType<typeof setTimeout> | undefined
  /** Set when the state file is unreadable/damaged: no writer may run. See blockWrites(). */
  private writesBlocked = false
  /** Human-readable reason surfaced through snapshot() when writes are blocked. */
  private stateError: string | undefined
  /** Monotonic id of the newest state handed to the writer, so a stale snapshot cannot land late. */
  private writeRevision = 0
  private writtenRevision = 0
  private readonly cfg: Required<Omit<Config, 'homeDir' | 'sessionsDir'>>
  /**
   * File-backed memory, one Markdown file per (room, bot).
   *
   * The PROMPT path needs memory synchronously (`buildPrompt` runs inside a turn), so the
   * service keeps an in-memory mirror that is loaded once at startup and updated on every
   * write. The files stay the source of truth: the mirror is a cache of them, not a second one.
   */
  private memoryStore: MemoryStore | undefined
  private readonly memoryMirror = new Map<string, BotMemoryEntry[]>()
  private readonly ready: Promise<void>
  /** Rooms whose ledger has already been hydrated from state. */
  private readonly ledgerHydrated = new Set<string>()
  /**
   * Rooms with a `compactRoom` call in flight.
   *
   * A compaction is a model call followed by a rewrite of the room's history; two of them
   * overlapping would have the second delete messages the first had already summarised.
   */
  private readonly compacting = new Set<string>()
  /** Skill discovery + per-bot profiles, signature-driven (§5.3). */
  private readonly skills: SkillLifecycle
  /** Proposal → confirm/decline → invite → dissolve → hand-off (§5.4–5.9). */
  private readonly groupFlow: GroupFlowService
  private executor: RunExecutor | undefined
  private readonly ledger: LedgerProjector
  /**
   * One native DSH agent per `(roomId, botId)`.
   *
   * Created in `start()` rather than the constructor: it needs the ledger and the
   * skill lifecycle to exist first, and building it eagerly would let a partially
   * constructed service hand out agents.
   */
  private sessionRunner: SessionRunner | undefined
  /** Projects native session events into ledger rows. */
  private ledgerProjection: LedgerProjection | undefined
  /** Leader-driven group coordination. */
  private groupTask: GroupTaskDriver | undefined
  private approvalBridge: ApprovalBridge | undefined
  /** Bots asking the user a question: the card blocks the turn until answered. */
  private questionBridge: QuestionBridge | undefined
  private approvalBridgeDispose: (() => void) | undefined
  /** Expires unanswered group proposals even when no panel is open. */
  private proposalSweeper: ReturnType<typeof setInterval> | undefined
  /** Fires bot reminders the host cannot deliver (subagent-owned sessions). */
  private botScheduleTimer: ReturnType<typeof setInterval> | undefined
  /**
   * `finish_task` reports waiting for the run that produced them to settle.
   *
   * The report is NOT a room row of its own: a ledger push carried no runId and no
   * reasoning, while the turn's answer carried both — the user saw one delivery twice.
   * `finish_task` runs INSIDE the leader's turn, before `settleRun` has written that
   * turn's reply, so this is the hand-off point: stash by run id here, consume in
   * `settleRun`, and publish exactly one message. Keyed by run id; the `room\0leader`
   * key is the fallback for a finish that arrives outside a run (older callers).
   */
  private readonly pendingFinishReports = new Map<string, string>()
  /**
   * Consecutive finish-gate rejections per (room, leader), plus the task-board signature they
   * belong to. OP-02: the first two refusals are strict; the third lets the task close as
   * `bypassed` (recorded as unverified) so a leader that cannot produce verifiable evidence
   * cannot deadlock the room for ever. A changed board resets the count (new task).
   */
  private readonly finishGateRejections = new Map<string, { count: number; board: string }>()
  /**
   * OP-18: one quiet reputation reminder per room per ten minutes after a group task closes.
   * It reads only the persisted board and only WRITES a notice; no dispatch or roster change.
   */
  private readonly reputationWatchdog = new ReputationWatchdog()
  /**
   * Last goal-drift warning per room (OP-13). The watchdog only WARNS, and one notice per room
   * per 10 minutes is enough: repeated notices would bury the transcript without adding facts.
   */
  private readonly goalDriftWarnedAt = new Map<string, number>()
  /**
   * Runs that already got their one grey diagnosis line. A settle can be observed twice (a
   * re-delivered settle, a recovery pass); the transcript must not say it twice.
   */
  private readonly diagnosedRunIds = new Set<string>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentCommunity')
    this.cfg = {
      maxBots: config.maxBots ?? 32,
      maxRooms: config.maxRooms ?? 64,
      maxMessages: config.maxMessages ?? 10_000,
      maxRuns: config.maxRuns ?? 1_000,
      maxConcurrentRuns: config.maxConcurrentRuns ?? 8,
      runTimeoutMs: config.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_POLICY.bootstrapMs,
      runLeaseMs: config.runLeaseMs ?? 60_000,
      runTimeoutPolicy: config.runTimeoutPolicy ?? {},
      runRetryPolicy: config.runRetryPolicy ?? {},
      idleLimit: config.idleLimit ?? 12,
      hardLimit: config.hardLimit ?? 24,
      historyMessagesInPrompt: config.historyMessagesInPrompt ?? 10,
      a2aMinIntervalMs: config.a2aMinIntervalMs ?? 3_000,
      botAgentPreset: config.botAgentPreset ?? 'bot',
      botDeniedTools: config.botDeniedTools ?? [...DEFAULT_DENIED_TOOLS],
      deliverMaxFiles: config.deliverMaxFiles ?? 8,
      memoryEntriesPerRoom: config.memoryEntriesPerRoom ?? 12,
      memoryPromptEntries: config.memoryPromptEntries ?? 8,
      groupProposalTimeoutMs: config.groupProposalTimeoutMs ?? 120_000,
      botReasoningEffort: config.botReasoningEffort ?? '',
    }
    this.home = resolveAgentCommunityHome({
      configured: config.homeDir,
      legacyStatePath: join(homedir(), '.dsh', 'agent-community', 'state.json'),
      exists: (path) => existsSync(path),
      warn: (message) => { this.ctx.logger?.warn?.(message) },
    })
    this.statePath = join(this.home, 'agent-community', 'state.json')
    // The memory root sits beside the board, for the same reason: everything the plugin owns
    // lives under one directory, so a user can find (or remove) all of it in one place.
    this.memoryStore = new MemoryStore(join(this.home, 'agent-community', 'memory'))
    this.sessionsDir = config.sessionsDir !== undefined
      ? resolve(config.sessionsDir.replace(/^~(?=[/\\]|$)/u, homedir()))
      : join(this.home, 'sessions')
    // P0-2: Ledger projector — in-memory store, shared with RunExecutor and ApprovalBridge
    this.ledger = new LedgerProjector(this)
    this.skills = new SkillLifecycle({
      scan: roomId => this.listSkills(roomId),
      statFile: async (path) => {
        const info = await stat(path)
        return { mtimeMs: info.mtimeMs, size: info.size }
      },
      getBot: botId => this.state.bots.find(b => b.id === botId),
      saveProfile: (botId, profile) => { this.saveSkillProfile(botId, profile) },
      stream: () => this.directStream(),
      logger: this.ctx.logger as unknown as { info?(...a: unknown[]): void; warn?(...a: unknown[]): void },
    })
    this.groupFlow = new GroupFlowService(this.groupFlowPort(), {
      proposalTimeoutMs: this.cfg.groupProposalTimeoutMs,
    })
    this.ready = this.load()
    // Start the run executor once state is loaded, passing through executor tunables
    void this.ready.then(async () => {
      // Per-bot workspaces must be resolved before any run starts.
      await this.resolveDefaultWorkspace()
      this.maintenance.migrateBotsToPrivateWorkspaces()

      // Warm the skill cache so the prompt builder has it synchronously.
      await this.refreshSkillCache()

      // Retire rooms whose owning bot was deleted before this fix existed.
      this.maintenance.pruneOrphanRooms()

      // Retire the conversation text older builds left in cleared rooms' run logs.
      this.maintenance.stripClearedRunPrompts()

      // Workspaces of bots that no longer exist (empty by construction).
      await this.maintenance.pruneOrphanWorkspaces()

      // Restore each room's visible history from the persisted messages. The ledger
      // projector is in-memory, so without this a DSH restart left every panel
      // blank while the bots could still read the history from the state file.
      this.maintenance.seedLedgerFromState()

      // P0-3: Install approval bridge before starting executor so the
      // prepend:true listener is registered before any run starts
      const accessor: ApprovalBridgeAccessor = {
        memberRoomId: (sessionId: string) => {
          const entry = this.state.roomAgentSessions.find(s => s.sessionId === sessionId)
          if (entry === undefined) return undefined
          return { roomId: entry.roomId, botId: entry.botId }
        },
      }
      this.approvalBridge = new ApprovalBridge(ctx, this.ledger, accessor)
      this.approvalBridgeDispose = this.approvalBridge.install()
      // Bots ask questions through this bridge: the row is the card, the RPC is the answer.
      this.questionBridge = new QuestionBridge(ctx, this.ledger)

      // §17.4 (b+c): the session ids this plugin can ever create are deterministic,
      // so visibility is derived instead of hand-maintained — and every session left
      // behind by an earlier run is archived up front, before any agent can start.

      // Native session driver. Built before the executor so the executor can be
      // handed a runner that is fully wired — an executor that starts runs against a
      // half-initialised runner would materialise agents with no tools registered.
      const runner = new SessionRunner(ctx, {
        // WHO IS IN CHARGE, told to each bot: the coordinator may invite/remove/dispatch/finish.
        leaderOf: (roomId) => this.leaderOfRoom(roomId),
        isMember: (roomId, botId) =>
          this.state.rooms.find(r => r.id === roomId)?.memberIds.includes(botId as BotId) ?? false,
        botName: (botId) => this.state.bots.find(b => b.id === botId)?.name ?? botId,
        botById: (botId) => {
          const bot = this.state.bots.find(b => b.id === botId)
          return bot === undefined
            ? undefined
            : {
                id: bot.id,
                name: bot.name,
                description: bot.description ?? '',
                ...(bot.provider !== undefined ? { provider: bot.provider } : {}),
                ...(bot.model !== undefined ? { model: bot.model } : {}),
                ...(bot.reasoningEffort !== undefined ? { reasoningEffort: bot.reasoningEffort } : {}),
                ...(bot.systemPrompt !== undefined ? { systemPrompt: bot.systemPrompt } : {}),
                ...(bot.workspace !== undefined ? { workspace: bot.workspace } : {}),
                // The bot's declared permission drives its session's sandbox/approval
                // preset; without it every bot ran under the deployment default.
                ...(bot.permission !== undefined ? { permission: bot.permission } : {}),
              }
        },
        roomById: (roomId) => {
          const room = this.state.rooms.find(r => r.id === roomId)
          return room === undefined
            ? undefined
            : {
                id: room.id,
                memberIds: room.memberIds,
                ...(room.directBotId !== undefined ? { directBotId: room.directBotId } : {}),
              }
        },
        // THE single source of truth for a pair's session id. The runner asks for it
        // instead of deriving its own, so the generation advanced by `clearMessages`
        // cannot be missed — missing it meant resuming the conversation the user had
        // just deleted.
        sessionIdFor: (roomId, botId) => this.sessionIdFor(roomId, botId),
        historyFor: (roomId, limit) =>
          this.listMessages(roomId)
            .slice(-limit)
            .map(m => ({ senderName: m.sender.name, text: m.modelText ?? m.text })),
        defaultWorkspace: async () => homedir(),
      }, {
        // Compose each agent's scoped world: collaboration tools plus the permission
        // scoping for this bot. Scoped registrations disappear with the agent.
        // Every session this plugin creates must be hidden the instant it exists.
        // The startup sweep alone is not enough: it can only cover sessions that were
        // already on disk when the process booted, so without this hook any turn
        // started during the session puts a bot conversation in DSH's sidebar.
        // The two halves of the visibility sequence. Hiding is not a one-time act:
        // an archived session is refused by the admission gate, so every turn is
        // bracketed by restore → run → hide.
        restoreSession: async (sessionId) => {
          // Awaited by the runner before the turn: see SessionRunnerOptions.
          await this.executor?.restoreSession(sessionId)
        },
        hideSession: (sessionId) => { this.executor?.hideSession(sessionId) },
        // ── WHAT WORLD A BOT LIVES IN ─────────────────────────────────────────────
        //
        // Every bot session is created under this deployment's agent preset, so bots get
        // the same core tools the user's own session has (bash, read/write/edit, glob,
        // grep, web_search/web_fetch, skill, todo_write, subagent, …) on top of the
        // plugin-registered community tools. Before this they had 31 tools and none of
        // the core ones, which is why they kept saying they could not touch files.
        // Bot sessions run the plugin's own preset (shipped in this package and installed into
        // <DSH_HOME>/.agent-presets/bot). `standard` gave them `workflow`/`subagent`/`create_goal`
        // and friends, which a global deny cannot hide because the preset mounts them per agent.
        // An explicit config value still wins, and the runner falls back to the deployment
        // default when the roster does not know this preset (see `resolvePresetId`).
        agentPreset: config.botAgentPreset ?? 'bot',
        deniedTools: config.botDeniedTools ?? DEFAULT_DENIED_TOOLS,
        // Where the preset-mount diagnostic lands (plugin data dir, not the profile).
        presetLogDir: join(this.home, 'agent-community'),
        setupAgent: (agentCtx, roomId, botId) => {
          // ⚠️ NATIVE FILE TOOLS ARE USED, NOT A PRIVATE COPY.
          //
          // The session carries a real `cwd` (see SessionRunner), so DSH's own `read` /
          // `write` / `edit` / `bash` resolve paths correctly and enforce the permission
          // preset through the native pipeline. Registering replacements was actively
          // harmful: `tools.register` THROWS on a duplicate name
          // (`tool "read" is already registered`), so doing it here aborted the agent's
          // setup and left the bot with no working context at all.
          const failedTools = this.installCollaborationTools(agentCtx, roomId, botId)
          if (failedTools.length > 0) {
            // A name the deployment already owns in this scope. The bot loses that ONE tool;
            // everything else registered, which is the whole point of the per-tool guard.
            this.ctx.logger?.warn?.(
              `agent-community: ${failedTools.length} collaboration tool(s) could not register for `
              + `room=${roomId} bot=${botId}: ${failedTools.map(f => `${f.name} (${f.reason})`).join('; ')}`,
            )
          }
        },
        // How aggressively materialised agents are retired (see Config.idleLimit).
        // Disposal is what closes the session write handle, so these limits decide
        // when a bot's session becomes openable by another runtime again.
        idleLimit: config.idleLimit ?? 12,
        hardLimit: config.hardLimit ?? 24,
      })
      this.sessionRunner = runner
      this.ledgerProjection = new LedgerProjection({
        ledger: this.ledger,
        // ── WHICH RUNS MAY SPEAK IN THE ROOM ───────────────────────────────────
        //
        // A turn woken by a member's report is coordination: the user did not ask for it
        // and cannot act on it. Rendering it produced five bot messages for one
        // instruction — three of them the same bot announcing completion. The project's
        // rule (user decision 2) is that MEMBERS stay visible; what must not be rendered
        // is the leader's integrate turn restating them.
        //
        // The answer is the run's own `publish` flag, so it follows the run from the
        // place that created it (`enqueueGroupRun` marks the integrate turn internal) and
        // there is exactly one source of truth. `undefined` (no live run) leaves the
        // projection's title-stream gate in charge.
        runPublishFor: (roomId, botId) => {
          const run = this.liveRunFor(roomId, botId)
          return run === undefined ? undefined : publishOf(run)
        },
        botName: (botId) => this.state.bots.find(b => b.id === botId)?.name ?? botId,
        // ── ANY UNFINISHED RUN, NOT JUST `running` ─────────────────────────────
        //
        // The projection stamps this id onto every ledger row it creates, and the UI
        // keys the whole turn off it: `groupIntoTurns` sets `TurnGroup.runId` from the
        // entry, and the "深度求索中，用时 X 秒" timer only renders when that id
        // resolves to a run that has a `startedAt`.
        //
        // Matching only `running` therefore lost the timer on exactly the runs that
        // were still `queued` when their first frames arrived — which is why some bots
        // showed the whale and its clock while others showed neither. The window is
        // real: a run is created as `queued` and only flips to `running` when the
        // executor picks it up, while an agent started for it can already be emitting
        // reasoning deltas.
        //
        // Taking the LAST match keeps the newest run when a pair has several, and the
        // terminal statuses stay excluded so a finished run never adopts new rows.
        runIdFor: (roomId, botId) => {
          const live = this.state.runs.filter(
            r => r.roomId === roomId && r.botId === botId
              && r.status !== 'completed' && r.status !== 'failed' && r.status !== 'cancelled',
          )
          return live[live.length - 1]?.id
        },
      })
      this.ledgerProjection.install(ctx)
      this.groupTask = new GroupTaskDriver({
        // The integrate turn passes `internal: true`; assign/assignEach pass visible.
        enqueueRun: (roomId, botId, prompt, options) => this.enqueueGroupRun(roomId, botId, prompt, options),
        roomById: (roomId) => {
          const room = this.state.rooms.find(r => r.id === roomId)
          return room === undefined
            ? undefined
            : {
                memberIds: room.memberIds,
                ...(room.directBotId !== undefined ? { directBotId: room.directBotId } : {}),
              }
        },
        leaderOf: (roomId) => this.leaderOfRoom(roomId),
        botName: (botId) => this.state.bots.find(b => b.id === botId)?.name ?? botId,
        hasLiveRun: (roomId) => this.state.runs.some(r => r.roomId === roomId && (r.status === 'running' || r.status === 'queued')),
        isCompacting: () => false,
        postReport: (roomId, leaderId, report) => {
          // ── THE REPORT IS THE RUN'S DELIVERY, NOT A SECOND ROW ─────────────────
          //
          // `finish_task` runs INSIDE the leader's turn, before `settleRun` has been
          // reached — the turn's own reply is not in `state.messages` yet, so the old
          // `alreadyDelivered` comparison was always false at this moment and pushed a
          // ledger row that carried no runId and no reasoning beside the real answer.
          // That was the user's "two replies, one with 思考过程 and one without".
          //
          // The report is therefore handed to the run (stashed by run id) and decided in
          // `settleRun`, which is the single delivery path: one message, with the run's
          // metadata, persisted with the run so a restart shows the same transcript.
          this.recordFinishReport(roomId, leaderId, report)
        },
        lastUserMessageAt: (roomId) => [...this.state.messages]
          .filter(m => m.roomId === roomId && m.sender.kind === 'user')
          .reduce((latest, m) => (m.createdAt > latest ? m.createdAt : latest), '') || undefined,
        // OP-19: the room's goal text drives the member-report order in the integrate prompt.
        roomGoalText: (roomId) => this.roomGoal(roomId)?.text,
        saveTaskState: (roomId, taskState) => {
          this.state = {
            ...this.state,
            rooms: this.state.rooms.map(r => (r.id === roomId
              // The existing board is passed in so its budget and the user's original task text
              // survive the conversion — both used to be dropped on every save.
              ? { ...r, taskState: toRoomTaskState(taskState, r.taskState) }
              : r)),
          }
          this.enqueueWrite()
        },
        loadTaskState: (roomId) => {
          const room = this.state.rooms.find(r => r.id === roomId)
          return fromRoomTaskState(room?.taskState)
        },
      })
      this.executor = new RunExecutor(ctx, this, {
        // ── GROUP MEMBERS RUN TOGETHER ─────────────────────────────────────────
        //
        // The slot count is GLOBAL, not per room: `tick()` computes
        // `slots = maxConcurrent - active.size`, so a group of five bots could only
        // ever have two answering at once and the rest sat behind a 排队 banner. The
        // product expectation is the opposite — a group is created precisely so its
        // members work AT THE SAME TIME, and serialising them makes the group feel
        // broken rather than busy.
        //
        // Eight is a bound on runaway fan-out (each run is a live Agent making its own
        // provider call), not a claim about how many bots a group may hold; it is
        // configurable for deployments that need a different ceiling.
        maxConcurrent: config.maxConcurrentRuns ?? 8,
        // Adaptive deadline + retry + lease: all wired from Config, so a deployment tunes
        // task time through configuration instead of editing a constant.
        timeoutPolicy: config.runTimeoutPolicy,
        retryPolicy: config.runRetryPolicy,
        runLeaseMs: config.runLeaseMs ?? 60_000,
        historyMessages: config.historyMessagesInPrompt ?? 10,
        memoryPromptEntries: config.memoryPromptEntries ?? 8,
        defaultReasoningEffort: config.botReasoningEffort ?? '',
        // The executor reserves a live row and writes the final answer for every run;
        // this view drops both for an internal run so its turn never reaches the panel.
        // The one row it may owe the user (a finish report) is pushed by `settleRun`.
        ledger: this.executorLedgerView(),
        sessionRunner: runner,
      })
      // Sweep AFTER the executor exists and BEFORE it starts: the sweep needs the
      // executor's VisibilityController (hiding means detach + archive, and that
      // controller owns the pairing), while no agent may start before the sweep has
      // hidden what earlier runs left behind.
      // A failing cleanup must never prevent the executor from starting: without it every run the
      // user creates queues for ever, which is exactly the state this trace was written to find.
      try {
        await this.maintenance.sweepPluginSessions()
      } catch {
        // A failing cleanup must never prevent the executor from starting: without it every run
        // the user creates queues for ever.
      }

      void this.executor.start()
      // ── PROOF OF LIFE ────────────────────────────────────────────────────────
      //
      // One line at mount time, in a file a human can read. A queued run that never starts has two
      // possible causes that look identical from outside: this code is not what the host loaded,
      // or the executor was never created. This line separates them — it is written the moment the
      // service is constructed and the executor exists.

      // A proposal nobody answers must still resolve (§5.4): the panel has its own
      // countdown, this covers the closed-tab case.
      this.proposalSweeper = setInterval(() => {
        try { this.groupFlow.sweepExpired() } catch { /* expiry is best-effort */ }
      }, 15_000)
      this.proposalSweeper.unref?.()

      // Bot reminders: import whatever the host cannot deliver, then fire what is due. Import
      // first so a reminder created seconds ago is already owned by the time the first tick runs.
      void this.importHostSchedules()
      this.botScheduleTimer = setInterval(() => {
        void this.importHostSchedules()
        this.fireBotSchedules()
      }, 5_000)
      this.botScheduleTimer.unref?.()
    }).catch((error: unknown) => {
      // A rejection here must never be silent: it would leave the panel empty with no
      // trace, which is indistinguishable from "the plugin did not load".
      this.ctx.logger?.error?.(
        `agent-community: startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      )
    })
    // Dispose executor and approval bridge when this service is disposed.
    //
    // ASYNC ON PURPOSE: a coalesced write may still be waiting in `writeTimer`, and the old
    // synchronous handler dropped it — the last mutations before quit were lost. Flush first
    // (awaited), then tear down; a failed flush is logged and must not block teardown.
    ;(ctx as unknown as { on(event: string, fn: () => void | Promise<void>): void })
      .on('dispose', async () => {
        try {
          await this.flushNow()
        } catch (error: unknown) {
          this.ctx.logger?.warn?.(`agent-community: final state flush failed: ${String(error)}`)
        } finally {
          if (this.writeTimer !== undefined) {
            clearTimeout(this.writeTimer)
            this.writeTimer = undefined
          }
          this.executor?.dispose()
          this.approvalBridgeDispose?.()
          if (this.proposalSweeper !== undefined) clearInterval(this.proposalSweeper)
          if (this.botScheduleTimer !== undefined) clearInterval(this.botScheduleTimer)
          this.questionBridge?.dispose()
        }
      })
  }

  /** Resolve once the persisted state has been read. Callers that must observe
   *  prior state before mutating should await this first. */
  whenReady(): Promise<void> {
    return this.ready
  }

  // ── Plumbing for the two extracted services ────────────────────────────────

  /**
   * The one sanctioned way to call a model without a session (§24.4).
   *
   * `ctx.llm.stream` is used for work that has no history to keep — skill profiles
   * and the "is this a group task?" judgement. Routing these through an Agent would
   * mint a session per call, which is exactly the session pile-up the visibility
   * rules exist to prevent.
   */
  private directStream(): LlmStream | undefined {
    const llm = (this.ctx as unknown as {
      llm?: { stream?: (options: Record<string, unknown>) => AsyncIterable<{ type: string; text?: string | undefined }> }
    }).llm
    if (llm?.stream === undefined) return undefined
    return options => llm.stream!(options as unknown as Record<string, unknown>)
  }

  /** Persist an analysed skill profile onto its bot (§5.3). */
  private saveSkillProfile(botId: string, profile: BotSkillProfile): void {
    const idx = this.state.bots.findIndex(b => b.id === botId)
    if (idx < 0) return
    const bots = [...this.state.bots]
    bots[idx] = { ...bots[idx]!, skillProfile: profile, updatedAt: nowIso() }
    this.state = { ...this.state, bots }
    this.enqueueWrite()
  }

  /**
   * How many notices one room keeps on disk.
   *
   * Notices are status feedback, not user data, so an unbounded list would let a long-lived room
   * grow `state.json` forever. Keeping the newest rows means the transcript a user re-opens shows
   * the recent history of what happened to the room, which is what the row is for.
   */
  private static readonly MAX_ROOM_NOTICES = 200

  /**
   * Record one system notice — the durability half of the transcript's grey divider row.
   *
   * Persisted on the ROOM and pushed to the ledger in one move, so the live view and the reloaded
   * view cannot disagree. Two deliberate choices:
   *
   *  · `state.messages` is NOT touched. The unread badge is derived from the room's messages and the
   *    model prompt is built from them, so keeping notices off that list is what makes "a notice
   *    never counts as unread and is never sent to the bot" true by construction rather than by a
   *    filter each new reader has to remember.
   *  · An unknown room is a no-op, not a throw: the caller is reporting something that ALREADY
   *    happened (a model was set, a bot was invited), and failing the report would not undo it.
   */
  private recordNotice(roomId: string, text: string): BotRoomNotice | undefined {
    const trimmed = text.trim()
    if (trimmed === '') return undefined
    const idx = this.state.rooms.findIndex(r => r.id === roomId)
    if (idx < 0) return undefined
    const notice: BotRoomNotice = { id: randomUUID(), text: trimmed, at: nowIso() }
    const room = this.state.rooms[idx]!
    const kept = [...(room.notices ?? []), notice]
    const rooms = [...this.state.rooms]
    rooms[idx] = {
      ...room,
      notices: kept.length > AgentCommunityService.MAX_ROOM_NOTICES
        ? kept.slice(kept.length - AgentCommunityService.MAX_ROOM_NOTICES)
        : kept,
    }
    this.state = { ...this.state, rooms }
    this.enqueueWrite()
    // The LIVE row: same `dispatch` type the rebuild produces, which is what makes the text a
    // divider row in the transcript rather than a bubble or a strip.
    this.ledger.push({
      type: 'dispatch',
      roomId: brandId<BotRoomId>(roomId),
      text: notice.text,
      at: notice.at,
    })
    return notice
  }

  /**
   * OP-12: record a bot's structured abstention as a visible notice.
   *
   * The tool surface is `agent_community_abstain`; this is its service half. It deliberately:
   *  · returns a failure ONLY for a missing reason — the one case where the model can fix it;
   *  · writes a `dispatch` notice (durable + live) so the USER sees the bot explaining itself; by
   *    the notice rule the line is NOT injected into any bot's next prompt (and never becomes a
   *    bot message);
   *  · does NOT post as the bot, end the turn, or touch memory: an abstention is information, not
   *    a verdict. The run keeps its own reply path.
   */
  private recordAbstain(input: {
    readonly roomId: string
    readonly botId: string
    readonly reason: string
    readonly missing?: readonly string[] | undefined
    readonly suggestedOwner?: string | undefined
  }): { readonly ok: boolean; readonly reason?: string | undefined } {
    const normalized = normalizeAbstain({
      reason: input.reason,
      ...(input.missing !== undefined ? { missing: input.missing } : {}),
      ...(input.suggestedOwner !== undefined ? { suggestedOwner: input.suggestedOwner } : {}),
    })
    if (normalized === undefined) {
      return { ok: false, reason: 'reason 不能为空：请说明为什么这一项做不到（缺什么、卡在哪里）。' }
    }
    const botName = this.state.bots.find(b => b.id === input.botId)?.name ?? input.botId
    const notice = this.recordNotice(input.roomId, abstainNotice(normalized, botName))
    if (notice === undefined) {
      return { ok: false, reason: '这个房间已不存在，说明没有记录成功。' }
    }
    return { ok: true }
  }

  /**
   * OP-22: copy one member's produced file into another member's workspace (file-first handoff).
   *
   * WHY THE SERVICE AND NOT THE TOOL. Both workspaces are service knowledge (`runWorkspaceDir`),
   * and the source path is untrusted input. Everything is checked before a byte is copied:
   *   · the room must be a live group and both bots must be members of it;
   *   · the target must be named exactly as the room roster names it (no ids, no "someone");
   *   · the source must canonicalize INSIDE the sender's workspace (realpath, so `..` and
   *     symlink escapes are refused), be a regular non-empty file, ≤32MB;
   *   · the copy lands in `<target workspace>/handoffs/<UTC stamp>-<safe name>`.
   *
   * A handoff is a COPY: the sender keeps its file (nothing is moved or deleted). The receiver is
   * woken through the normal member-message path with the new absolute path, and the room gets a
   * visible notice so the user can see the artifact changed hands.
   */
  private async handoffFileToMember(input: {
    readonly roomId: string
    readonly botId: string
    readonly toName: string
    readonly path: string
    readonly note?: string | undefined
  }): Promise<{
    ok: boolean
    reason?: string | undefined
    targetPath?: string | undefined
    size?: number | undefined
  }> {
    const room = this.state.rooms.find(r => r.id === input.roomId)
    if (room === undefined) return { ok: false, reason: '这个房间已不存在' }
    if (room.directBotId !== undefined) return { ok: false, reason: '文件交接只在群聊里可用' }
    if (!room.memberIds.some(id => id === input.botId)) return { ok: false, reason: '发送方不在这个群里' }
    const toName = input.toName.trim()
    if (toName === '') return { ok: false, reason: 'toName 不能为空' }
    const target = room.memberIds
      .map(id => this.state.bots.find(bot => bot.id === id))
      .find(bot => bot !== undefined && bot.name.trim() === toName)
    if (target === undefined) return { ok: false, reason: `本群没有名为「${toName}」的成员` }
    if (target.id === input.botId) return { ok: false, reason: '不能把文件交接给自己' }

    const plan = await planFileHandoff({
      senderWorkspace: this.runWorkspaceDir(input.botId),
      targetWorkspace: this.runWorkspaceDir(target.id),
      sourcePath: input.path,
    })
    if (!plan.ok) return { ok: false, reason: plan.reason }
    const copied = await copyHandoffFile(plan)
    if (!copied.ok) return { ok: false, reason: copied.reason }

    const note = (input.note ?? '').trim().slice(0, 500)
    const filename = basename(plan.sourcePath)
    try {
      await this.postBotMessage({
        roomId: brandId<BotRoomId>(input.roomId),
        senderSessionId: this.sessionIdFor(input.roomId, input.botId),
        text: `[文件交接] 已把「${filename}」复制到你的工作区：${plan.targetPath}`
          + (note !== '' ? `；说明：${note}` : ''),
        toBotName: target.name,
        // Coordination is not conversation: the file arrives, the recipient wakes, and the room
        // instead sees the one-line notice below.
        internal: true,
      })
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `文件已复制，但通知「${target.name}」失败：${detail}` }
    }
    this.recordNotice(input.roomId, `已交接文件「${filename}」给「${target.name}」`)
    return { ok: true, targetPath: plan.targetPath, size: plan.size }
  }

  /**
   * The panel's notice row: 「已把「X」的模型设为：…」 and friends.
   *
   * Returns whether the row was recorded, so a caller that cares can tell "the room is gone" from
   * "done". The panel does not care: it fires and forgets, because the row is feedback about an
   * action whose result it has already shown.
   */
  async noticeRoom(input: NoticeRoomRequest): Promise<{ readonly stored: boolean }> {
    return { stored: this.recordNotice(input.roomId, input.text) !== undefined }
  }

  /** The state access the group flow needs; the flow owns decisions, not storage. */
  private groupFlowPort(): GroupFlowPort {
    return {
      getRoom: roomId => this.getRoom(roomId),
      listRooms: () => this.listRooms(),
      saveRoom: (room) => {
        const idx = this.state.rooms.findIndex(r => r.id === room.id)
        // A concurrent delete wins: re-adding the room here would resurrect it.
        if (idx < 0) return
        const rooms = [...this.state.rooms]
        rooms[idx] = room
        this.state = { ...this.state, rooms }
        this.enqueueWrite()
      },
      listBots: () => this.listBots(),
      getBot: id => this.getBot(id),
      getMessage: id => this.state.messages.find(m => m.id === id),
      createRoom: input => this.createRoom(input),
      appendMessage: (message) => {
        this.state = { ...this.state, messages: [...this.state.messages, message] }
        this.enqueueWrite()
        this.ledger.push({
          type: 'user',
          roomId: message.roomId,
          text: message.text,
          senderName: message.sender.name,
          at: message.createdAt,
          // Same passthrough as `sendMessage`: a user row's bubble draws the files, and
          // the ledger — not `state.messages` — is what the panel renders.
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          // OP-14 threading survives a reload only if the rebuilt row carries it too.
          ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
          ...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
          ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
        })
      },
      note: (roomId, text) => {
        // THE single sink for system rows. Group flow's 「已邀请 X 加入群聊」 and the panel's
        // 「已把「X」的模型设为：…」 must be the same kind of thing — a grey divider row inside the
        // transcript — and both must survive a reload, so this records durably and pushes the live row.
        this.recordNotice(roomId, text)
      },
      queueRun: ({ roomId, botId, prompt, origin }) => {
        // A new turn in this room: the invite budget (§5.6 单轮 ≤ 4) restarts here.
        this.groupFlow.beginRound(roomId)
        this.queueRoomRun(roomId, botId, prompt, origin)
      },
      deleteRoom: async (roomId) => { await this.deleteRoom({ id: roomId }) },
      nudge: () => { this.executor?.nudge() },
      resumeSoloTurn: (roomId, botId, prompt) => { this.resumeSoloTurn(roomId, botId, prompt) },
      stream: () => this.directStream(),
      nextId: () => randomUUID(),
      now: () => nowIso(),
      logger: this.ctx.logger as unknown as { info?(...a: unknown[]): void; warn?(...a: unknown[]): void },
    }
  }

  /**
   * Queue exactly one run for one bot.
   *
   * Unlike `sendMessage` this never fans out over the member list: both callers
   * (a confirmed group's leader, a declined proposal's direct chat) act on behalf of
   * a single bot, and starting the others would resurrect the "everyone runs once"
   * model the leader-driven design replaced.
   */
  /**
   * The group's coordinator — the SAME answer the group flow and the task board use.
   *
   * The stored `team.leader` wins while it is a bot that is still a member; otherwise the first
   * member in join order, so a group can never end up leaderless while it still has members and
   * a hand-made/legacy room (no `team` at all) still has a working coordinator. Delegated to
   * `resolveRoomLeader` so there is exactly one implementation of that rule.
   */
  private leaderOfRoom(roomId: string): string | undefined {
    // ONE rule for every caller (service, group flow, task board): the stored leader while it
    // is a live member, otherwise the first member in join order. See `room-leader.ts` for why
    // two resolvers used to disagree about hand-made and legacy groups.
    return resolveRoomLeader(this.state.rooms.find(r => r.id === roomId))
  }

  /**
   * Enqueue one member's work in a group.
   *
   * `bot-message` rather than `user`: the prompt was written by the leader, not typed
   * by the user, and the distinction is what lets a later reader tell a hand-off from
   * something the user actually said.
   *
   * `options.internal` marks the leader's INTEGRATE turn: it runs (and may finish the
   * task), but its prose is coordination, not an answer — the members' own replies are
   * already in the room. Published turns (a member's assigned work) omit it.
   */
  private enqueueGroupRun(
    roomId: string,
    botId: string,
    prompt: string,
    options?: { readonly internal?: boolean | undefined },
  ): boolean {
    const room = this.state.rooms.find(r => r.id === roomId)
    if (room === undefined || !room.memberIds.some(id => id === botId)) return false
    const bot = this.state.bots.find(b => b.id === botId)
    if (bot === undefined) return false
    try {
      // A paused room creates no runs from ANY source (see `queueRoomRun`).
      const run = this.queueRoomRun(roomId, botId, prompt, 'bot-message')
      if (run === undefined) return false
      // Tag the run here, where its purpose is known: the integrate turn is internal,
      // every other group hand-off (assign_task / dispatch / message_member) is a
      // member's own visible contribution.
      this.markRunPublish(run.id, options?.internal === true ? 'internal' : 'visible')
      return true
    } catch {
      return false
    }
  }

  /**
   * Tag a run with how it may speak, after creation.
   *
   * Written here rather than inside `queueRoomRun` because that is the single creation
   * point shared by every wake-up path and it carries no policy; the run is still
   * `queued`, so no consumer (executor, projection) has read it yet. The flag is what
   * `publish-policy` and every row writer consult.
   */
  private markRunPublish(runId: string, publish: RunPublish): void {
    this.state = {
      ...this.state,
      runs: this.state.runs.map(r => (r.id === runId ? { ...r, publish } : r)),
    }
    this.enqueueWrite()
  }

  private installCollaborationTools(
    agentCtx: Context,
    roomId: string,
    botId: string,
  ): ReadonlyArray<{ readonly name: string; readonly reason: string }> {
    return registerCollaborationTools(agentCtx, {
      ownerOf: (exec) => {
        const viaExec = (exec as { agent?: { session?: { id?: string } } })?.agent?.session?.id
        if (typeof viaExec === 'string') return SessionRunner.parseSessionId(viaExec)
        // Fall back to the ids this registration was made for. The tool can then only
        // ever act on behalf of the agent it was registered into.
        return { roomId, botId }
      },
      roomKind: (id) => {
        const room = this.state.rooms.find(r => r.id === id)
        if (room === undefined) return undefined
        return room.directBotId !== undefined ? 'direct' : 'group'
      },
      leaderOf: (id) => this.leaderOfRoom(id),
      botName: (botId) => this.state.bots.find(b => b.id === botId)?.name ?? botId,
      memberIds: (id) => this.state.rooms.find(r => r.id === id)?.memberIds ?? [],
      liveBotIds: () => this.state.bots.map(b => b.id),
      proposeGroup: async (input) => {
        // ── ONE WRITER FOR PROPOSALS ────────────────────────────────────────────
        //
        // This used to write `pendingGroupProposal` straight into state with `taskText: ''` and
        // no `sourceMessageId`, which broke three things at once: the panel's watcher requires a
        // source message, so the dialog never appeared; confirming it replayed an EMPTY task into
        // the group; and `expired()` could never fire because there was no deadline. Routing
        // through the group flow gives a bot's proposal exactly the shape the panel's own
        // analysis produces — same dialog, same task text, same expiry.
        const message = [...this.state.messages]
          .reverse()
          .find(m => m.roomId === input.roomId && m.sender.kind === 'user')
        if (message === undefined) {
          return { ok: false, reason: '这个房间还没有用户消息，无法把建群提议交给用户确认。' }
        }
        const existing = this.groupFlow.pending(input.roomId)
        if (existing !== undefined) {
          // Not a failure: the user is already being asked. Saying so stops the model from
          // proposing again (and from believing nothing happened).
          return { ok: false, reason: `已经有一个待确认的建群提议（${existing.name}），等用户决定即可。` }
        }
        const proposal = await this.groupFlow.propose({
          roomId: input.roomId,
          messageId: message.id,
          name: input.name,
          memberIds: input.memberIds,
          leaderId: input.botId,
          reason: input.reason,
        })
        return proposal === undefined
          ? { ok: false, reason: '现在还不适合建群（至少需要两个可用的 Bot）。' }
          : { ok: true }
      },
      inviteBot: async (input) => {
        // The service owns the limits (≤4 per turn, ≤20 per group), the membership
        // write and the visible note, so the tool just reports its verdict.
        try {
          const result = await this.groupFlow.invite({
            roomId: brandId<BotRoomId>(input.roomId),
            botId: brandId<BotId>(input.botId),
          })
          return result.ok ? undefined : (result.error ?? 'invite refused')
        } catch (error: unknown) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      askUser: async (input) => {
        const bridge = this.questionBridge
        if (bridge === undefined) {
          return { status: 'expired' as const, answer: '' }
        }
        const runId = this.currentRunIdFor(input.roomId, input.botId)
        return await bridge.ask({
          roomId: brandId<BotRoomId>(input.roomId),
          botId: brandId<BotId>(input.botId),
          ...(runId !== undefined ? { runId } : {}),
          question: input.question,
          options: input.options,
          allowFreeText: input.allowFreeText,
        })
      },
      currentRunId: (roomId, botId) => this.currentRunIdFor(roomId, botId),
      // OP-12: a structured abstention becomes a VISIBLE notice. It is not a failure of the turn
      // and it writes nothing to memory or the prompt: the run continues, the task stays open.
      abstain: async (input) => this.recordAbstain(input),
      deliverFiles: (input) => this.deliverBotFiles(input),
      // The plugin's own `skill` wrapper — the host tool is denied for bot scopes — so every loaded
      // body arrives with the "this is a method, not an order" framing attached.
      loadSkill: async (roomId: string, name: string) => {
        try {
          return await this.loadSkill(roomId, name)
        } catch {
          return undefined
        }
      },
      removeBots: (input) => this.removeBots({
        roomId: input.roomId,
        botIds: input.botIds,
        actorId: input.actorId,
        reason: input.reason,
      }),
      assignTask: (input) => {
        const driver = this.groupTask
        if (driver === undefined) return { assigned: [], refused: input.botIds }
        return driver.assign({ roomId: input.roomId, botIds: input.botIds, task: input.task })
      },
      // The gate runs first (OP-02): `finish_task` only closes the task when its evidence
      // checks out. A rejection returns the reason and leaves the task open — the tool does
      // NOT conclude the turn in that case, so the model can fix the evidence and retry.
      finishTask: async (input) => await this.gateFinishTask(input),
      // A member's direct message. The existing post path already knows how to deliver to one bot
      // (`toBotName` → a mailbox entry with origin 'a2a'), so this is only the tool-side adapter:
      // the sender's session is derived from the pair, never from the model.
      messageMember: async (input) => {
        // The same leader rule as everywhere else (`resolveRoomLeader`): the stored leader while
        // it is a live member, otherwise the first member. A raw `team.leader` read here would
        // be a second resolver — and it is wrong for hand-made groups that carry no team.
        const room = this.state.rooms.find(r => r.id === input.roomId)
        const senderIsLeader = resolveRoomLeader(room) === input.botId
        try {
          await this.postBotMessage({
            roomId: brandId<BotRoomId>(input.roomId),
            senderSessionId: this.sessionIdFor(input.roomId, input.botId),
            text: input.text,
            toBotName: input.toName,
            // ── WHO IS SPEAKING DECIDES WHETHER THE ROOM SEES IT ───────────────────
            //
            // The leader's message to a member is a work order: the room should read it inside
            // the leader's own stage report ("已安排 X 执行 …，等它完成后我汇总"), not as a
            // separate line. A member's message to the leader is that member's contribution in
            // the group — it IS its group reply and must be visible.
            // ── COORDINATION IS NOT CONVERSATION ────────────────────────────────────
            //
            // Measured field by field: every `message_member` post appeared in the room as a
            // message with NO runId and NO reasoning — rsfa's report to the leader beside its actual
            // answer, so the user saw two replies where one was expected and asked, rightly, why a
            // message without 思考过程 exists at all. It is delivered to the target and wakes it;
            // it is not part of the room's transcript.
            internal: true,
          })
          return { ok: true }
        } catch (error: unknown) {
          return { ok: false, reason: error instanceof Error ? error.message : String(error) }
        }
      },
      // OP-22: file-first handoff. The service owns both workspace paths, the containment/size
      // checks and the copy; the tool only names the member and the workspace-relative file.
      handoffFile: async (input) => this.handoffFileToMember(input),
      roomGoal: (input) => {
        const goal = this.roomGoal(input.roomId)
        return goal === undefined
          ? undefined
          : {
            text: goal.text,
            status: goal.status,
            updatedAt: goal.updatedAt,
            ...(goal.authorization !== undefined
              ? {
                authorization: {
                  maxRounds: goal.authorization.maxRounds,
                  roundsUsed: goal.authorization.roundsUsed,
                },
              }
              : {}),
          }
      },
      setRoomGoal: async (input) => {
        // The room comes from the SESSION, never from the model: `ownerOf` resolved it, and
        // the actor is that session — so a bot cannot name another room's goal, and the
        // authority check runs against the room it is actually in. A Bot's call lands as a
        // PROPOSAL unless the goal is already active under the user's grant (see `setRoomGoal`).
        const result = await this.setRoomGoal({
          roomId: input.roomId,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.action !== undefined ? { action: input.action } : {}),
          actorSessionId: this.sessionIdFor(input.roomId, input.botId),
        })
        if (!result.ok) {
          return { ok: false, ...(result.reason !== undefined ? { reason: result.reason } : {}) }
        }
        // The model needs the RESULTING status, not just "ok": 'proposed' must be reported as a
        // suggestion awaiting the user, or the bot will believe it granted itself auto-run.
        return {
          ok: true,
          ...(result.goal !== undefined
            ? {
              goal: {
                text: result.goal.text,
                status: result.goal.status,
                updatedAt: result.goal.updatedAt,
                ...(result.goal.authorization !== undefined
                  ? {
                    authorization: {
                      maxRounds: result.goal.authorization.maxRounds,
                      roundsUsed: result.goal.authorization.roundsUsed,
                    },
                  }
                  : {}),
              },
            }
            : {}),
        }
      },
      recall: (input) => this.recallMemory({
        roomId: input.roomId,
        botId: input.botId,
        query: input.query,
      }),
      dispatch: (input) => {
        const result = this.dispatchToMembers({
          roomId: input.roomId,
          tasks: input.tasks,
          actorSessionId: this.sessionIdFor(input.roomId, input.botId),
        })
        return {
          ok: result.ok,
          queued: result.queued.map(id => ({ botId: id, name: this.state.bots.find(b => b.id === id)?.name ?? id })),
          refused: result.refused,
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        }
      },
    })
  }

  /**
   * Queue exactly one run, unless the room is paused.
   *
   * THE PAUSED GUARD LIVES HERE, not only in `sendMessage`: the panel's 「暂停（不创建新运行）」
   * promised that no run is created, but schedules, goal continuations, a2a wakes and group
   * hand-offs each called this method directly and only the user-message path checked the flag.
   * Refusing at the single creation point makes the promise true for every source, and returns
   * undefined so a caller that needs the run (the goal continuation) can skip its bookkeeping.
   */
  private queueRoomRun(roomId: string, botId: string, prompt: string, origin: BotRun['origin']): BotRun | undefined {
    const room = this.state.rooms.find(r => r.id === roomId)
    if (room !== undefined && room.paused === true) {
      this.ctx.logger?.info?.(
        `agent-community: skipped ${origin} run for paused room ${roomId}`,
      )
      return undefined
    }
    // A user instruction begins a task; the previous task's completion must not outlive it.
    if (origin === 'user') this.groupTask?.beginTask(roomId)

    const run: BotRun = {
      id: brandId<BotRunId>(randomUUID()),
      botId: brandId<BotId>(botId),
      roomId: brandId<BotRoomId>(roomId),
      sessionId: this.ensureStableSession(roomId, botId),
      origin,
      prompt,
      status: 'queued',
      controlRevision: 0,
      attempt: 0,
      maxAttempts: 3,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.state = { ...this.state, runs: [...this.state.runs, run] }
    this.enqueueWrite()
    return run
  }

  /**
   * Keep the direct-chat turn alive after a group proposal is refused (§5.4).
   *
   * A live turn is only nudged; a follow-up is queued solely when nothing is
   * running, so a decline can never run the same task twice.
   */
  private resumeSoloTurn(roomId: string, botId: string, prompt: string): void {
    const live = this.state.runs.some(
      r => r.roomId === roomId && r.botId === botId && (r.status === 'queued' || r.status === 'running'),
    )
    if (live) {
      this.executor?.nudge()
      return
    }
    this.queueRoomRun(roomId, botId, prompt, 'user')
    this.executor?.nudge()
  }

  /**
   * Tear down every live agent a room owns, then abort anything still in flight.
   *
   * The executor owns the agents, so this asks it through a duck-typed hook rather
   * than reaching into its internals: `abortRoom` exists today, and an executor that
   * later materialises DSH Agents exposes `disposeRoomAgents` for the same purpose.
   * Missing hooks are not an error — the plugin's own LLM-direct path creates no
   * Agent at all.
   */
  private disposeRoomAgents(roomId: string): void {
    const executor = this.executor as unknown as {
      abortRoom?(roomId: string): void
      disposeRoomAgents?(roomId: string): void
      disposeBotAgents?(roomId: string, botId: string): void
    } | undefined
    try { executor?.disposeRoomAgents?.(roomId) } catch { /* best-effort */ }
    try { executor?.abortRoom?.(roomId) } catch { /* best-effort */ }
  }

  /** Same, scoped to one bot across every room it belongs to. */
  private disposeBotAgents(roomId: string, botId: string): void {
    const executor = this.executor as unknown as {
      disposeBotAgents?(roomId: string, botId: string): void
    } | undefined
    try { executor?.disposeBotAgents?.(roomId, botId) } catch { /* best-effort */ }
  }

  private async load(): Promise<void> {
    await mkdir(join(this.statePath, '..'), { recursive: true })
    let raw: string
    try {
      raw = await readFile(this.statePath, 'utf8')
    } catch (error: unknown) {
      // ONLY a missing file means "this community has no state yet". Anything else (EACCES, EIO, a
      // directory in the way) must not be read as empty: the next write would replace a file we
      // merely failed to read.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = emptyState()
        return
      }
      this.blockWrites(`state file could not be read: ${String(error)}`)
      return
    }

    let loaded: { state: PersistedState; migrated: boolean }
    try {
      loaded = parsePersistedState(raw, this.ctx.logger)
    } catch (error: unknown) {
      // Damaged state: keep the bytes for a human, then refuse to write so the damage cannot be
      // replaced by an empty file. The plugin still starts, with an empty in-memory community.
      await this.quarantineState(raw)
      this.blockWrites(error instanceof Error ? error.message : String(error))
      return
    }

    this.state = loaded.state
    // ── HEAL MARKS WRITTEN BY OLDER BUILDS ──────────────────────────────────────
    //
    // A read water mark from before marks carried a time, whose message was later deleted
    // (compaction), can never be interpreted — and reading it as "read everything" keeps
    // that room's unread dot off for ever. Observed on a real board: a group with three bot
    // replies reported no unread because its mark pointed at a compacted-away message. New
    // marks carry their time; this repairs the ones that cannot, at load time.
    // ── MEMORY FILES: load the mirror, migrate a board that still inlines it ────
    //
    // Runs before anything can serve a prompt, and before the first write, so no turn ever
    // sees a half-loaded memory.
    await this.loadMemory()

    const marks = this.state.roomReadAt ?? {}
    const repaired = repairReadMarks(this.state.messages, marks)
    if (repaired > 0) {
      this.state = { ...this.state, roomReadAt: marks }
      this.ctx.logger.warn?.(
        `agent-community: repaired ${repaired} unread water mark(s) that no longer pointed at a `
        + 'message — those rooms can report unread again',
      )
      this.enqueueWrite()
    }
    if (loaded.migrated) this.enqueueWrite()
  }

  /**
   * Stop persisting, and say why.
   *
   * Set when the state file is unreadable or damaged. Every writer checks it, because the failure it
   * prevents is the worst one this service has: writing an empty community over the user's only copy.
   */
  private blockWrites(reason: string): void {
    this.writesBlocked = true
    this.stateError = reason
    this.ctx.logger.error(`agent-community: state writes disabled — ${reason}`)
  }

  /** Copy an unparseable state file aside so the user can inspect or repair it. */
  private async quarantineState(raw: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const target = `${this.statePath}.corrupt-${stamp}.json`
    try {
      await writeFileAtomic(target, raw, { mode: 0o600, dirMode: 0o700 })
      this.ctx.logger.error(`agent-community: damaged state preserved at ${target}`)
    } catch (error: unknown) {
      // Failing to copy is not fatal: the original is untouched, because writes are blocked.
      this.ctx.logger.error(`agent-community: could not preserve damaged state: ${String(error)}`)
    }
  }

  /**
   * Persist immediately and await it, instead of queueing behind the coalescing writer.
   *
   * Deletion must be on disk before its folders are removed, so the "gone" state can never be
   * lost to a crash between the two. This call also DROPS a pending coalesced write: the
   * state written here is at least as new as anything that timer would have written.
   */
  private async flushNow(): Promise<void> {
    if (this.writesBlocked) return
    // Cancel the pending debounce: this call is the write it was waiting to schedule.
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer)
      this.writeTimer = undefined
    }
    // Drain whatever the writer already owes, then make sure the state as of THIS call is on
    // disk. Deletion paths await this so "gone" is durable before folders are removed.
    const snapshot = this.state
    const revision = ++this.writeRevision
    await this.saveQueue
    await this.writeSnapshot(snapshot, revision)
  }

  /**
   * Schedule one state write, coalescing every mutation inside the window.
   *
   * WHY NOT WRITE PER MUTATION: a single settled run mutates the runs array, appends a
   * message, bumps the goal and pushes a ledger row — four `enqueueWrite()` calls inside one
   * millisecond, each of which used to serialize the whole (multi-megabyte) state. With a
   * full write per heartbeat on top, the writer was the board's hottest path for no gain.
   *
   * The timer captures nothing: when it fires, the CURRENT `this.state` is written and it is
   * stamped with a new revision (`queueStateWrite`), so mutations that happen while a write is
   * in flight still end up in the next one. `flushNow()` cancels this timer and writes at once.
   */
  private enqueueWrite(): void {
    if (this.writesBlocked) return
    if (this.writeTimer !== undefined) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined
      this.queueStateWrite()
    }, WRITE_COALESCE_MS)
    // A pending save must not keep the host process alive on its own.
    this.writeTimer.unref?.()
  }

  /**
   * Enqueue one serialized write of the state AS OF NOW.
   *
   * The revision is captured here, not when the queued task finally runs: bytes on disk are
   * ordered by mutation order, and a write a newer one already covered can be skipped
   * (`writeSnapshot` compares revisions). This is also why two writers — this queue and
   * `flushNow` — cannot interleave a stale snapshot over a newer one.
   */
  private queueStateWrite(): void {
    if (this.writesBlocked) return
    const snapshot = this.state
    const revision = ++this.writeRevision
    this.saveQueue = this.saveQueue
      .then(() => this.writeSnapshot(snapshot, revision))
      .catch((error: unknown) => {
        // Swallowing this would silently lose every later mutation, so it is reported; the queue
        // itself must still settle so it keeps accepting writes.
        this.ctx.logger.warn(`agent-community: state write failed: ${String(error)}`)
      })
  }

  /** One serialized write. Skips work when a newer revision already reached the disk. */
  private async writeSnapshot(snapshot: PersistedState, revision: number): Promise<void> {
    if (this.writesBlocked || revision <= this.writtenRevision) return
    // `withStateLock`, NOT the library's bare `withFileLock`: an abandoned lock file
    // otherwise blocks this write for ever, and because every later write queues behind
    // this Promise, the whole board stops reaching the disk without a single error.
    await withStateLock(this.statePath, async () => {
      // 0o600: state.json holds bot prompts and room history; the tree is user-private and
      // `dirMode` keeps it that way on first creation.
      //
      // COMPACT JSON ON PURPOSE: this file is machine state, not something a human edits by
      // hand (damaged state is quarantined, not repaired in place). Pretty-printing cost
      // ~30 % of the bytes on every write; the pretty copy a developer wants is one
      // `jq . state.json` away.
      await writeFileAtomic(this.statePath, JSON.stringify(snapshot), {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
    this.writtenRevision = Math.max(this.writtenRevision, revision)
  }

  // ── Bot Management ─────────────────────────────────────────────────────────

  /**
   * Copy a bot into a new bot and hand back its direct room, so the UI can jump
   * straight into the copy's conversation.
   *
   * Naming follows the source: forking the same bot repeatedly yields
   * "name（1）", "name（2）", … A copy is itself forkable and starts its own series.
   * The copy inherits configuration, model, workspace, prompt, permission and
   * avatar, plus the source conversation's messages, so the fork continues from
   * the point it was taken at rather than opening empty.
   *
   * @param sourceRoomId room whose transcript is carried over; the bot's direct
   *   room is used when omitted.
   */
  async copyBot(
    botId: string,
    sourceRoomId: string,
    upToMessageId: string,
  ): Promise<{ bot: BotIdentity; room: BotRoom }> {
    const src = requireBot(this.state, botId)
    if (this.state.bots.length >= this.cfg.maxBots) {
      throw new Error(`Bot limit ${this.cfg.maxBots} reached`)
    }
    const resolvedSourceRoomId = sourceRoomId !== ''
      ? sourceRoomId
      : this.state.rooms.find(r => r.directBotId === src.id)?.id
    if (resolvedSourceRoomId === undefined) {
      throw new Error(`No source room for bot "${botId}"`)
    }

    // Label by source bot: count existing copies of this same bot. Indexes are
    // monotonic (max + 1) so deleting a copy never reuses its number.
    const siblings = this.state.bots.filter(b => b.forkedFromBotId === src.id)
    let index = siblings.reduce((max, b) => Math.max(max, b.forkIndex ?? 0), 0) + 1

    const baseName = this.stripForkSuffix(src.name)
    let name = `${baseName}（${index}）`
    while (this.state.bots.some(b => b.name === name)) {
      index += 1
      name = `${baseName}（${index}）`
    }

    const copyId = brandId<BotId>(randomUUID())
    const copy: BotIdentity = {
      id: copyId,
      name,
      description: src.description,
      // Copy the avatar verbatim: the seed drives the emoji, so a fresh random
      // seed rendered the copy with an unrelated (unrecognisable) icon.
      avatar: { seed: src.avatar.seed, locked: src.avatar.locked },
      provider: src.provider,
      model: src.model,
      reasoningEffort: src.reasoningEffort,
      // A fork gets a private workspace too: inheriting the source's directory
      // would keep the two bots sharing files.
      workspace: await this.ensureBotWorkspace(copyId),
      systemPrompt: src.systemPrompt,
      mentionOnly: src.mentionOnly,
      permission: src.permission,
      profile: defaultProfile(name),
      forkedFromBotId: src.id,
      forkIndex: index,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    const room: BotRoom = {
      id: brandId<BotRoomId>(randomUUID()),
      name,
      directBotId: copy.id,
      memberIds: [copy.id],
      mentionOnly: false,
      sequence: 0,
      connection: 'connected',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }

    // Carry the source conversation over: a fork continues from the point it was
    // taken at, so the copy opens with the same transcript instead of an empty room.
    // A fork continues FROM the chosen message, so only that message and the
    // ones before it are carried over — everything after it belongs to the
    // timeline being branched away from.
    let sourceMessages = this.state.messages.filter(m => m.roomId === resolvedSourceRoomId)
    if (upToMessageId !== '') {
      const cut = sourceMessages.findIndex(m => m.id === upToMessageId)
      if (cut < 0) {
        throw new Error(
          `Message "${upToMessageId}" not found in room "${resolvedSourceRoomId}"`,
        )
      }
      sourceMessages = sourceMessages.slice(0, cut + 1)
    }
    const carried: BotMessage[] = sourceMessages.map((m, i) => ({
      ...m,
      id: brandId<BotMessageId>(randomUUID()),
      roomId: room.id,
      sender: {
        ...m.sender,
        // The copied bot answers as itself from here on; the user stays the user.
        ...(m.sender.kind === 'bot' ? { botId: copy.id, name: copy.name } : {}),
      },
      sequence: i,
    }))
    this.state = {
      ...this.state,
      bots: [...this.state.bots, copy],
      rooms: [...this.state.rooms, room],
      messages: [...this.state.messages, ...carried],
    }
    this.enqueueWrite()
    return { bot: copy, room }
  }

  /** Drop a trailing "（n）" so copies of copies do not stack suffixes. */
  private stripForkSuffix(name: string): string {
    return name.replace(/（\d+）$/, '')
  }

  async createBot(input: CreateBotRequest): Promise<BotIdentity> {
    if (this.state.bots.length >= this.cfg.maxBots) {
      throw new Error(`Bot limit ${this.cfg.maxBots} reached`)
    }
    if (this.state.bots.some(b => b.name === input.name)) {
      throw new Error(`Bot name "${input.name}" already exists`)
    }
    const id = brandId<BotId>(randomUUID())
    const bot: BotIdentity = {
      id,
      name: input.name,
      description: input.description ?? '',
      avatar: {
        seed: input.avatarSeed ?? randomUUID(),
        locked: input.avatarLocked ?? false,
      },
      provider: input.provider,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      // The workspace becomes the session's `cwd`; a path that does not exist makes
      // session creation fail and the bot silently produce nothing.
      workspace: input.workspace ?? await this.ensureBotWorkspace(id),
      systemPrompt: input.systemPrompt,
      mentionOnly: input.mentionOnly,
      // OP-18: bounded and normalized at the one write point, so persisted bots cannot carry a
      // pasted keyword dump or an unbounded list.
      ...(input.subscriptions !== undefined
        ? { subscriptions: normalizeSubscriptions(input.subscriptions) }
        : {}),
      permission: input.permission ?? 'full-access',
      profile: { ...defaultProfile(input.name), ...input.profile },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.state = { ...this.state, bots: [...this.state.bots, bot] }
    this.enqueueWrite()
    return bot
  }

  async updateBot(input: UpdateBotRequest): Promise<BotIdentity> {
    const idx = this.state.bots.findIndex(b => b.id === input.id)
    if (idx < 0) throw new Error(`Bot "${input.id}" not found`)
    const prev = this.state.bots[idx]!
    if (input.name !== undefined && input.name !== prev.name) {
      if (this.state.bots.some(b => b.name === input.name)) {
        throw new Error(`Bot name "${input.name}" already exists`)
      }
    }
    const updated: BotIdentity = {
      ...prev,
      name: input.name ?? prev.name,
      description: input.description ?? prev.description,
      provider: input.provider ?? prev.provider,
      model: input.model ?? prev.model,
      reasoningEffort: input.reasoningEffort ?? prev.reasoningEffort,
      workspace: input.workspace ?? prev.workspace,
      systemPrompt: input.systemPrompt ?? prev.systemPrompt,
      mentionOnly: input.mentionOnly ?? prev.mentionOnly,
      // OP-18: an explicit list (even empty) replaces the stored one; omitting keeps it.
      subscriptions: input.subscriptions !== undefined
        ? normalizeSubscriptions(input.subscriptions)
        : prev.subscriptions,
      permission: input.permission ?? prev.permission,
      avatar: {
        seed: input.avatarSeed ?? prev.avatar.seed,
        locked: input.avatarLocked ?? prev.avatar.locked,
        assetPath: prev.avatar.assetPath,
      },
      profile: input.profile !== undefined
        ? { ...prev.profile, ...input.profile }
        : prev.profile,
      updatedAt: nowIso(),
    }
    const bots = [...this.state.bots]
    bots[idx] = updated
    this.state = { ...this.state, bots }
    this.enqueueWrite()
    return updated
  }

  async deleteBot(input: DeleteBotRequest): Promise<void> {
    const prev = requireBot(this.state, input.id)
    const botId = prev.id
    // A direct room belongs to exactly one bot: deleting the bot must delete the
    // room and its transcript too. Removing the bot from memberIds alone left an
    // orphaned room (memberIds: []) that the UI still listed, with every message
    // still readable — deleting a bot appeared to do nothing.
    const orphanRoomIds = new Set(
      this.state.rooms.filter(r => r.directBotId === botId).map(r => r.id),
    )
    // Group rooms the bot was a member of: its session must go with it, and a room
    // it was leading needs a new leader (§5.4 hand-off).
    const touchedGroupIds = this.state.rooms
      .filter(r => r.directBotId === undefined && r.memberIds.includes(botId))
      .map(r => r.id)
    // The bot's own session logs, per room, read BEFORE the state rewrite drops the
    // bookkeeping that points at them (§23.3: an orphaned log is a memory leak the
    // user cannot see, and a deleted bot's memory must not outlive it).
    // ── DELETE THE BOT'S MEMORY, KEEPING ITS GROUP PARTITIONS ───────────────────
    //
    // The user's rule: deleting a bot erases its memory from the device, EXCEPT what it wrote
    // in groups — those partitions belong to the group and are archived first. Order matters:
    // archive, then remove the bot directory, so the archive can never be caught by the
    // deletion it is meant to survive.
    await this.archiveBotGroupMemory(botId)
    await this.memoryStore?.deleteBot(botId)
    for (const key of [...this.memoryMirror.keys()]) if (key.endsWith(`\u0000${botId}`)) this.memoryMirror.delete(key)

    const botSessions = [
      ...[...orphanRoomIds].flatMap(id => this.maintenance.sessionIdsOfRoom(id)),
      ...touchedGroupIds.flatMap(id => [
        this.sessionIdFor(id, botId),
        ...this.state.roomAgentSessions.filter(s => s.roomId === id && s.botId === botId).map(s => s.sessionId),
      ]),
    ]
    this.state = {
      ...this.state,
      bots: this.state.bots.filter(b => b.id !== botId),
      rooms: this.state.rooms
        .filter(r => !orphanRoomIds.has(r.id))
        .map(r => (
          r.memberIds.includes(botId)
            ? { ...r, memberIds: r.memberIds.filter(id => id !== botId), updatedAt: nowIso() }
            : r
        )),
      messages: this.state.messages.filter(m => !orphanRoomIds.has(m.roomId)),
      runs: this.state.runs.filter(r => r.botId !== botId && !orphanRoomIds.has(r.roomId)),
      roomAgentSessions: this.state.roomAgentSessions.filter(s => s.botId !== botId),
      mailbox: this.state.mailbox.filter(m => m.botId !== botId),
    }
    // Collect the soon-to-be-deleted session ids BEFORE dropping the state that
    // records them, then clear the in-memory ledger and the on-disk artifacts.
    const purged = [...orphanRoomIds].map(id => ({ id, sessions: this.maintenance.sessionIdsOfRoom(id) }))
    for (const roomId of orphanRoomIds) {
      this.ledger.clearRoom(roomId)
      this.ledgerHydrated.delete(roomId)
    }
    // Every live agent of this bot is gone with it, in group rooms as well as DMs.
    for (const roomId of orphanRoomIds) this.disposeRoomAgents(roomId)
    for (const roomId of touchedGroupIds) this.disposeBotAgents(roomId, botId)
    await this.flushNow()
    for (const { id, sessions } of purged) await this.maintenance.purgeRoomArtifacts(id, sessions)
    await this.maintenance.purgeSessionIds(botSessions, `bot ${botId}`)
    // The derived fold of every session this bot owned, then the bot's own workspace —
    // the bot is gone, so nothing may keep reading or writing either one.
    await this.maintenance.purgeProjectionCache(botSessions)
    await this.maintenance.removeBotWorkspace(prev)
    // §5.4/§5.7: a group that lost its leader needs one, and a group that lost its
    // last member cannot be addressed at all.
    for (const roomId of touchedGroupIds) {
      this.groupFlow.handoffLeadership(roomId, botId)
      await this.groupFlow.dissolveIfEmpty(roomId)
    }
  }

  listBots(): BotIdentity[] {
    return [...this.state.bots]
  }

  getBot(id: string): BotIdentity | undefined {
    return this.state.bots.find(b => b.id === id)
  }

  // ── Room Management ────────────────────────────────────────────────────────

  async createRoom(input: CreateRoomRequest): Promise<BotRoom> {
    if (this.state.rooms.length >= this.cfg.maxRooms) {
      throw new Error(`Room limit ${this.cfg.maxRooms} reached`)
    }
    // ── ONE REQUEST, ONE GROUP ──────────────────────────────────────────────────
    //
    // A Bot may not create a GROUP room, whichever room it is working in. Failure mode: the
    // user asked a 1:1 bot to pull a group together, the panel's post-send analysis proposed one
    // (the user confirmed it), and the bot — still inside its own turn — called this very method
    // through `agent_community_create_room` and built a SECOND group. The bot's sanctioned path is
    // `propose_group`, which reaches the user as a dialog; see room-guard.ts for the rule.
    const decision = screenRoomCreation(input, this.roomCreationActor(input.actorSessionId))
    if (!decision.allow) throw new Error(decision.reason)
    let team: BotTeam | undefined
    if (input.team !== undefined) {
      team = this.buildTeam(input.team)
    }
    // For direct-bot rooms, ensure the bot is always in memberIds so shouldRun
    // finds it when sendMessage iterates members.
    const rawMembers = input.memberIds ?? []
    const memberIds: BotId[] = rawMembers.map(id => brandId<BotId>(id))
    if (input.directBotId !== undefined && !memberIds.includes(brandId<BotId>(input.directBotId))) {
      memberIds.push(brandId<BotId>(input.directBotId))
    }
    const room: BotRoom = {
      id: brandId<BotRoomId>(randomUUID()),
      name: input.name,
      directBotId: input.directBotId !== undefined
        ? brandId<BotId>(input.directBotId)
        : undefined,
      imagePath: input.imagePath,
      memberIds,
      mentionOnly: input.mentionOnly ?? false,
      paused: input.paused,
      sequence: 0,
      connection: 'disconnected',
      team,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.state = { ...this.state, rooms: [...this.state.rooms, room] }
    this.enqueueWrite()
    return room
  }

  /**
   * Who is asking for a room, from the calling agent's session id.
   *
   * A session id this plugin owns (`ac:<roomId>:<botId>`) identifies a Bot and the room it is
   * working in — which is what makes `screenRoomCreation` able to refuse a second group. Anything
   * else (no session, the user's own agent session, a session of another plugin) is the user
   * acting through the panel or the CLI, and is allowed.
   */
  private roomCreationActor(actorSessionId: string | undefined): RoomCreationActor {
    if (actorSessionId === undefined) return { kind: 'user' }
    const owner = SessionRunner.parseSessionId(actorSessionId)
    if (owner === undefined) return { kind: 'user' }
    const room = this.state.rooms.find(r => r.id === owner.roomId)
    return { kind: 'bot', roomKind: room?.directBotId !== undefined ? 'direct' : 'group' }
  }

  private buildTeam(req: CreateTeamRequest): BotTeam {
    if (req.leaderBotId !== undefined) {
      const bot = this.state.bots.find(b => b.id === req.leaderBotId)
      if (!bot) throw new Error(`Leader Bot "${req.leaderBotId}" not found`)
      return {
        leader: { kind: 'bot', botId: brandId<BotId>(req.leaderBotId) },
        leaderName: req.leaderName,
        workspace: req.workspace,
        status: 'active',
      }
    }
    if (req.leaderSessionId !== undefined) {
      return {
        leader: { kind: 'session', sessionId: brandId<SessionId>(req.leaderSessionId) },
        leaderName: req.leaderName,
        workspace: req.workspace,
        status: 'active',
      }
    }
    throw new Error('Either leaderBotId or leaderSessionId is required')
  }

  async updateRoom(input: UpdateRoomRequest): Promise<BotRoom> {
    const idx = this.state.rooms.findIndex(r => r.id === input.id)
    if (idx < 0) throw new Error(`Room "${input.id}" not found`)
    const prev = this.state.rooms[idx]!
    const nextMembers = input.memberIds !== undefined
      ? input.memberIds.map(id => brandId<BotId>(id))
      : prev.memberIds
    const updated: BotRoom = {
      ...prev,
      name: input.name ?? prev.name,
      imagePath: input.imagePath ?? prev.imagePath,
      memberIds: nextMembers,
      mentionOnly: input.mentionOnly ?? prev.mentionOnly,
      paused: input.paused ?? prev.paused,
      updatedAt: nowIso(),
    }
    const rooms = [...this.state.rooms]
    rooms[idx] = updated
    this.state = { ...this.state, rooms }
    this.enqueueWrite()
    // A member removed by hand is the same event as a bot deleted: the room may
    // have lost its leader, and it may have lost its last member (§5.7).
    const removed = prev.memberIds.filter(id => !nextMembers.includes(id))
    for (const botId of removed) this.groupFlow.handoffLeadership(prev.id, botId)
    if (removed.length > 0) {
      // Same cleanup the bot-driven kick uses: runs stopped, board released, sessions and
      // host caches purged. A hand-edit and a `remove_bot` must not diverge.
      await this.maintenance.cleanupRemovedMembers(prev.id, removed, `removed members of room ${prev.id}`)
      const dissolved = await this.groupFlow.dissolveIfEmpty(prev.id)
      if (dissolved) return updated
    }
    return this.getRoom(input.id) ?? updated
  }

  async deleteRoom(input: DeleteRoomRequest): Promise<void> {
    if (!this.state.rooms.some(r => r.id === input.id)) {
      throw new Error(`Room "${input.id}" not found`)
    }
    const roomId = brandId<BotRoomId>(input.id)
    const sessions = this.maintenance.sessionIdsOfRoom(input.id)
    // ARCHIVE, DO NOT DELETE: the user's rule is that deleting a room keeps what the bots
    // learned in it. Read the members BEFORE the room record goes away — that list is what
    // says whose partitions to move.
    const memberIds = this.state.rooms.find(r => r.id === roomId)?.memberIds ?? []
    // Stop the work first: dropping the rows while a run is streaming leaves the
    // model writing into a room that no longer exists.
    this.disposeRoomAgents(input.id)
    this.state = {
      ...this.state,
      rooms: this.state.rooms.filter(r => r.id !== roomId),
      // A deleted room's messages, runs, and bot sessions are unreachable;
      // keeping them would leak state and keep runs reported as active.
      messages: this.state.messages.filter(m => m.roomId !== roomId),
      runs: this.state.runs.filter(r => r.roomId !== roomId),
      mailbox: this.state.mailbox.filter(m => m.roomId !== roomId),
      roomAgentSessions: this.state.roomAgentSessions.filter(s => s.roomId !== roomId),
      // NOTE: memory is NOT dropped here — a deleted room's partitions are ARCHIVED by
      // `archiveRoomMemory` (below), because the user's rule is that deleting a room keeps
      // what the bots learned there.
    }
    // The ledger is the panel's only render source; without this the deleted
    // room's transcript stays in memory and can reappear.
    this.ledger.clearRoom(roomId)
    this.ledgerHydrated.delete(roomId)
    // ── ARCHIVE THE ROOM'S HISTORY, NOT JUST ITS ROSTER ───────────────────────
    //
    // `memberIds` alone was not enough: a bot kicked before the room was deleted kept its
    // partition in the live tree forever — the room was gone, and no archive entry was written
    // for it either. Observed with a temp group whose kicked member still had a
    // 535-byte memory file after the group was deleted. The user's rule is that deleting a room
    // keeps what the bots learned there, which is about the room's history rather than about who
    // happened to be a member at the end.
    const rememberedBots = this.memoryStore === undefined
      ? []
      : await this.memoryStore.botsWithRoom(roomId)
    await this.archiveRoomMemory(roomId, [...new Set([...memberIds, ...rememberedBots])])
    await this.flushNow()
    await this.maintenance.purgeRoomArtifacts(roomId, sessions)
    await this.maintenance.purgeProjectionCache(sessions)
  }

  listRooms(): BotRoom[] {
    return [...this.state.rooms]
  }

  getRoom(id: string): BotRoom | undefined {
    return this.state.rooms.find(r => r.id === id)
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  async sendMessage(input: SendRoomMessageRequest): Promise<BotMessage> {
    const room = requireRoom(this.state, input.roomId)
    const roomMessageCount = this.state.messages.filter(m => m.roomId === input.roomId).length

    // Resolve @mentions from explicit list + parsed @名字/@id prefixes in text
    const explicitMentions: BotId[] = (input.mentions ?? []).map(ref => {
      const byId = this.state.bots.find(b => b.id === ref)
      if (byId !== undefined) return byId.id
      const byName = findBotByName(this.state, ref)
      return byName?.id
    }).filter((id): id is BotId => id !== undefined)

    const parsedMentions: BotId[] = []
    const mentionRegex = /@([\w一-鿿]+)/gu
    let m: RegExpExecArray | null
    while ((m = mentionRegex.exec(input.text)) !== null) {
      const token = m[1]!
      const byName = findBotByName(this.state, token)
      if (byName !== undefined && !parsedMentions.includes(byName.id)) {
        parsedMentions.push(byName.id)
      }
    }

    const mentions = [...new Set([...explicitMentions, ...parsedMentions])]

    // ── ATTACHMENTS ─────────────────────────────────────────────────────────────
    // The files the user picked ride this message as base64. They are written into the
    // workspace of every bot that may read the message, and referenced from the MODEL
    // payload only: `text` stays the draft, so the user's bubble shows what they typed
    // instead of a generated `[附件]` block. Over-limit input throws HERE, before the
    // message exists — a silent drop would leave the user believing the bot had received
    // a file it never saw.
    const attachmentStore = await this.storeMessageAttachments(input.attachments, room)
    const modelPayload = attachmentStore === undefined
      ? input.modelText
      : `${input.modelText ?? input.text}`
        + renderAttachmentReference(attachmentStore.stored, { absolutePaths: attachmentStore.singleRecipient })
    // What the transcript DRAWS. Built from the stored files rather than from the input,
    // so a bubble can never name a file or a size the workspace does not actually hold.
    // The bytes stay out of it on purpose — `state.json` is message history.
    const attachmentMeta: BotMessageAttachment[] | undefined = attachmentStore?.stored.map(s => ({
      name: s.name,
      size: s.bytes,
      mime: s.mime,
      kind: s.mime.startsWith('image/') ? 'image' as const : 'file' as const,
    }))

    // ── OP-14: THREADS / TASK LINKS (validated, never trusted) ─────────────────
    //
    // `replyTo` has to name an existing message in THIS room — a cross-room pointer would be a
    // link between two isolation domains — and the labels are bounded. Invalid values are
    // DROPPED, not rejected: threading is metadata, and a bad label must not cost the user their
    // message. `normalizeThreading` owns the rules (and is tested without a host).
    const threading = normalizeThreading(
      {
        ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      },
      {
        messageInRoom: id => this.state.messages.some(
          m => m.id === id && m.roomId === input.roomId,
        ),
      },
    )
    const message: BotMessage = {
      id: brandId<BotMessageId>(randomUUID()),
      roomId: brandId<BotRoomId>(input.roomId),
      sender: { kind: 'user', name: input.senderName ?? 'user' },
      // Deliberately UNTOUCHED by attachments: "exactly what the user typed". An
      // attachment-only message therefore keeps `text: ''` and is made visible by
      // `attachments` below — never by inventing placeholder text, which the bubble
      // would then show twice (once as prose, once as the file row).
      text: input.text,
      // The expanded skill body rides a separate field. `text` stays the draft, so the
      // panel shows what the user typed instead of 46 KB of SKILL.md and raw tags.
      ...(modelPayload !== undefined && modelPayload !== input.text
        ? { modelText: modelPayload }
        : {}),
      ...(attachmentMeta !== undefined ? { attachments: attachmentMeta } : {}),
      mentions,
      ...threading,
      createdAt: nowIso(),
      sequence: roomMessageCount,
    }
    // Trim per room, not globally: a global cap would silently drop other rooms'
    // history once one busy room filled the budget.
    const perRoomCap = Math.max(1, Math.floor(this.cfg.maxMessages / Math.max(1, this.state.rooms.length)))
    const others = this.state.messages.filter(m => m.roomId !== input.roomId)
    const mine = this.state.messages.filter(m => m.roomId === input.roomId)
    const kept = [...mine, message].slice(-perRoomCap)
    const messages = [...others, ...kept]

    // A user message restarts the room goal's continuation budget: the room is back under
    // human direction, so "N automatic rounds" is measured from here rather than from the
    // goal's creation. Only touched when something is left to clear.
    const goalRoom = this.state.rooms.find(r => r.id === input.roomId)
    if (goalRoom?.goal !== undefined && (goalRoom.goal.continuations ?? 0) > 0) {
      this.patchRoom(input.roomId, r => ({ ...r, goal: { ...r.goal!, continuations: 0, stalledRounds: 0 } }))
    }

    // Create a queued run for each member bot so they can observe and reply.
    // Bots marked mentionOnly only run when they appear in message.mentions;
    // room.mentionOnly applies the same restriction to all members at once.
    // If the message explicitly @mentions any bot, only those bots run regardless
    // of the mentionOnly flag — @mention is always an explicit directive.
    const shouldRun = (botId: BotId): boolean => {
      if (room.paused) return false
      const bot = this.state.bots.find(b => b.id === botId)
      if (bot === undefined) return false
      if (message.mentions.length > 0 && !message.mentions.includes(botId)) return false
      const mentionOnly = bot.mentionOnly === true || room.mentionOnly
      if (mentionOnly && !message.mentions.includes(botId)) {
        // ── A NAME IN THE TEXT IS A DIRECTIVE TOO ────────────────────────────────
        //
        // Observed in the UI: with 仅在被 @ 时响应 on, a user who TYPES
        // `@fghj 你看一下` got silence — the composer only produces `message.mentions` when the
        // mention is picked from the menu, so a hand-typed @name arrives as plain text and this
        // filter dropped it. The router itself treats a written name as targeted (its own name
        // step runs before the leader fallback), and the acceptance checklist expects exactly
        // this: 「群里发 @B 你看一下 → 只有 B 回复」. Being stricter than the router here made the
        // room look broken rather than quiet.
        const named = namedBotIdsIn(message.text, this.state.bots.map(b => ({ id: b.id, name: b.name })))
        if (!named.includes(botId)) return false
      }
      return true
    }

    // ── WHO ANSWERS: THE LEADER, NOT THE WHOLE ROSTER ───────────────────────────
    //
    // This used to wake EVERY member on EVERY message, with no de-duplication. One
    // "你好" started four runs; four of them started sixteen. Bot replies are messages
    // too, so each answer fanned out again and the queue grew faster than it drained —
    // which is what the user saw as a permanent 排队 banner, the same bot answering the
    // same question twice, and every other bot stuck on 处理中… behind the pile.
    //
    // The room is LEADER-DRIVEN: a group message wakes the leader, who hands work out
    // through `assign_task`. Members run when they are named — which is exactly what an
    // @mention means — and never merely because a message arrived.
    // ── WHO ANSWERS, DECIDED BY THE MESSAGE ─────────────────────────────────────
    //
    // THE ROOM'S RUN STRATEGY: a direct room has one recipient; `@all` wakes the room on
    // purpose; `@mention`/a written name wakes exactly those members; a management
    // instruction goes to the leader; the best role match wins (ties keep everyone); and
    // when NOTHING matched the leader takes it and decides — "你好" must not wake four
    // bots. See `routing.ts`, whose table is the single source of truth for who runs.
    const decision = routeMessage({
      members: room.memberIds
        .map(id => this.state.bots.find(b => b.id === id))
        .filter((b): b is NonNullable<typeof b> => b !== undefined)
        .map(b => ({
          id: b.id,
          name: b.name,
          ...(b.description !== undefined ? { description: b.description } : {}),
          ...(b.systemPrompt !== undefined ? { systemPrompt: b.systemPrompt } : {}),
        })),
      message: { text: message.text, mentions: message.mentions, mentionedIds: message.mentions },
      // `@all` / `@所有人`: the one way to ask the whole room, and the only path that
      // wakes every member. Plain words like 大家 are not tokens — see `mentionsEveryone`.
      allMentioned: mentionsEveryone(message.text),
      // A coordination request may name a bot that is NOT in the room ("把 X 拉进群"), so
      // the router is told about every live bot the text names, not just the members.
      namedBotIds: namedBotIdsIn(message.text, this.state.bots.map(b => ({ id: b.id, name: b.name }))),
      // OP-18: the members' declared intent keywords. Built from the same member list the
      // router is given, so a subscription can only ever route INSIDE this room.
      subscriptions: Object.fromEntries(
        room.memberIds
          .map(id => this.state.bots.find(b => b.id === id))
          .filter((b): b is NonNullable<typeof b> => b !== undefined)
          .map(b => [b.id, b.subscriptions ?? []] as [string, readonly string[]]),
      ),
      ...(room.directBotId !== undefined ? { directBotId: room.directBotId } : {}),
      ...(this.leaderOfRoom(room.id) !== undefined
        ? { leaderId: this.leaderOfRoom(room.id)! }
        : {}),
    })
    const targets = decision.targets.map(id => brandId<BotId>(id))
    // Recorded so the transcript can say who was picked and why, and so a surprising
    // choice can be diagnosed from the message alone.
    if (decision.reason === 'coordinator') {
      // Worth a line of its own: the routing choice is surprising on purpose (the message
      // named a member, yet the leader runs), so a confusing result must be explainable
      // from the log alone.
      this.ctx.logger?.info?.(
        `agent-community: routed a removal instruction to the room's coordinator ${String(decision.targets[0]).slice(0, 8)}`,
      )
    }
    if (decision.reason === 'matched') {
      this.ctx.logger?.info?.(
        `agent-community: routed a group message to ${decision.targets.length} bot(s) `
        + `by content (${Object.entries(decision.matched).map(([id, t]) => `${id.slice(0, 8)}:${t.join('|')}`).join(', ')})`,
      )
    }

    const newRuns: BotRun[] = targets
      .filter(shouldRun)
      .map(botId => ({
        id: brandId<BotRunId>(randomUUID()),
        botId,
        roomId: brandId<BotRoomId>(input.roomId),
        // The pair's derived session id (§17.4 b), registered in state so the
        // approval bridge and visibility reconcile can resolve it. Never a random
        // id: an unregistered session is one the startup sweep cannot hide.
        sessionId: this.ensureStableSession(room.id, botId),
        origin: 'user' as const,
        // A user message is always the room's conversation: visible. Explicit so the
        // publish rule has one place to look, even though absent means the same thing.
        publish: 'visible' as const,
        prompt: input.text,
        status: 'queued' as const,
        controlRevision: 0,
        attempt: 0,
        maxAttempts: 3,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }))

    const allRuns = [...this.state.runs, ...newRuns]
    this.state = { ...this.state, messages, runs: allRuns }
    this.enqueueWrite()
    // ── A NEW GROUP INSTRUCTION OPENS A NEW TASK ────────────────────────────────
    //
    // A group user message used to reach the driver through NO hook at all: `beginTask` was
    // only called from `queueRoomRun`, which this path never uses (the runs above are built
    // inline). Two things were therefore wrong per instruction: the previous task's
    // `finished` outlived it, and the round budget had no reset. Both belong here — after the
    // message is state, so `lastUserMessageAt` sees the instruction being served.
    if (room.directBotId === undefined) {
      this.groupTask?.beginTask(room.id)
      // A turn boundary for the invite budget (§5.6: at most four invites per turn). Group
      // turns never called this, so the cap degraded to a rolling 60-second window.
      this.groupFlow.beginRound(room.id)
    }
    // P0-2: push user message to ledger so group chat panels see it immediately
    this.ledger.push({
      type: 'user',
      roomId: message.roomId,
      text: message.text,
      senderName: message.sender.name,
      at: message.createdAt,
      // The LIVE row needs the metadata as much as the rebuilt one: an attachment-only
      // message has `text: ''`, so without this the bubble is empty until the next
      // restart — exactly the defect this field exists to fix.
      ...(attachmentMeta !== undefined ? { attachments: attachmentMeta } : {}),
      // OP-14: the same validated threading the persisted message carries.
      ...threading,
    })
    // Wake up the executor immediately instead of waiting for the next poll tick
    this.executor?.nudge()
    return message
  }

  listMessages(roomId: string): BotMessage[] {
    return this.state.messages.filter(m => m.roomId === roomId)
  }

  /**
   * §17.4 (b): the session id a (room, bot) pair owns, derived rather than stored.
   *
   * Deterministic on purpose. Visibility is enforced by archiving session ids, and a
   * hand-maintained list of ids fails silently the first time a creation site forgets
   * to register: the session becomes visible on the user's sidebar. A derived id
   * cannot be forgotten, and it makes the id list recomputable from state alone.
   */
  /** The room's current session generation; 0 until its messages are cleared or compacted. */
  private generationOf(roomId: string): number {
    const room = this.state.rooms.find(r => r.id === roomId)
    // TWO independent things retire a room's sessions: clearing its history and compacting
    // it. Both replace what a bot would be seeded from, so both must move the generation —
    // otherwise the next run resumes the old session and replays the very transcript the
    // user just compressed, and 压缩 becomes cosmetic (`sessionIdFor` is derived from this).
    return (room?.clearCount ?? 0) + (room?.compactCount ?? 0)
  }

  private sessionIdFor(roomId: string, botId: string): SessionId {
    // DELEGATED, not re-implemented. This used to build `ac-<room>-<bot>` while
    // SessionRunner built `ac:<room>:<bot>` — two schemes for the same thing, and the
    // startup sweep matched the wrong one, so it found nothing to hide and every bot
    // session stayed on the user's sidebar. One source of truth, one prefix.
    return SessionRunner.sessionIdFor(roomId, botId, this.generationOf(roomId))
  }

  /**
   * Clear a room's visible history AND the memory behind it (§23.1).
   *
   * The two are separate stores: the ledger is what the user reads, the bot sessions
   * are what the model remembers. Clearing only the ledger left every bot still
   * "remembering" text the user had deleted — the next turn could quote it back, which
   * is a content leak, not a cosmetic bug. So this disposes the room's live agents and
   * deletes their session logs in the same step; the next run starts from an empty
   * history (§23.1 G4).
   *
   * Also cancels stale non-running runs so failed badges disappear from the UI.
   *
   * The room's TASK BOARD and round state go with it. They are the round's memory of
   * "what this conversation is about", and `agent_community_get_context` hands them to
   * every bot that orients itself — a tool description that says "Call this first".
   * Leaving them behind made a cleared room lie: the first bot to answer a fresh "你好"
   * reported the PREVIOUS round's deliverables as current progress ("tokens.json already
   * delivered, only the AA patch is undecided"), and because each later bot read that
   * answer as room context, the whole group built on a round that no longer existed.
   * Clearing the conversation clears the board that belongs to it.
   */
  async clearMessages(roomId: string): Promise<void> {
    const sessions = this.maintenance.sessionIdsOfRoom(roomId)
    // Stop the agents BEFORE dropping their bookkeeping, so a live turn cannot keep
    // writing into the history that is being cleared.
    await this.disposeRoomAgents(roomId)
    const messages = this.state.messages.filter(m => m.roomId !== roomId)
    // Drop the in-memory coordination state too, so the next round starts from round 0
    // instead of inheriting the cleared round's assignments and pending reports.
    this.groupTask?.forget(roomId)
    // EVERY unfinished run of this room is cancelled — `queued` included.
    //
    // The old guard skipped `queued` runs, so a room could be cleared while its parked
    // runs stayed queued forever: the executor kept picking them, the panel kept showing
    // the 排队 banner, and the bots appeared to hang on 处理中… with nothing to do,
    // because the messages they were answering had just been deleted.
    const runs = this.state.runs.map(r => {
      if (r.roomId !== roomId) return r
      // ── THE RUN LOG KEEPS THE CONVERSATION TEXT UNLESS WE STRIP IT ───────────
      //
      // `prompt` is the user's own words (or the leader's task brief) and it is
      // persisted in state.json, so "clear messages" left the whole conversation
      // readable on disk in the run history long after the transcript, the ledger,
      // the sessions and the task board were gone. The run row itself is diagnostics —
      // keep it, but with no content in it.
      const stripped = r.prompt === '' ? r : { ...r, prompt: '' }
      return stripped.status !== 'completed' && stripped.status !== 'failed'
        && stripped.status !== 'cancelled' && stripped.status !== 'interrupted'
        ? { ...stripped, status: 'cancelled' as const, updatedAt: nowIso() }
        : stripped
    })
    this.ledger.clearRoom(brandId<BotRoomId>(roomId))
    // The task board and the round state are the CLEARED ROUND's, so they go with it.
    // `getRoomContext` serves `room.tasks` to every bot as "the room's current
    // progress" (the tool says "Call this first to orient yourself"), so a board that
    // outlives its conversation is not stale bookkeeping — it is a false statement
    // about the room. `tasks: []` and dropping `taskState` make the next round start
    // blank; JSON drops the undefined key, so nothing is persisted for it.
    const rooms = this.state.rooms.map(r =>
      r.id === roomId
        // `notices: []` is part of the same promise as dropping the messages: the ledger is cleared
        // here, and a durable notice left in state would come back as a row on the next reload —
        // a transcript the user cleared that is not actually empty.
        //
        // `pendingGroupProposal: undefined` belongs to the same promise, and was missing: a
        // proposal recorded for a message the user then CLEARED stayed on the room, so the dialog
        // came back and confirming it built a group whose task was the text of a deleted message.
        ? {
          ...r,
          tasks: [] as BotTask[],
          taskState: undefined,
          notices: [],
          pendingGroupProposal: undefined,
          // OP-03: constraints were pinned from THOSE messages. Keeping them would let a rule
          // whose sentence was deleted rule a conversation that no longer exists, and the next
          // compaction would re-inject it into the summary.
          pinnedConstraints: [],
        } as BotRoom & { tasks: BotTask[] }
        : r,
    )
    this.state = {
      ...this.state,
      messages,
      runs,
      rooms,
      roomAgentSessions: this.state.roomAgentSessions.filter(s => s.roomId !== roomId),
      // MEMORY IS DELIBERATELY UNTOUCHED. Clearing the transcript clears the WINDOW's context,
      // and nothing else: the user's rule is 「清空消息时 bot 的记忆不能被删除，只是清空对话
      // 窗口的上下文」. An earlier version dropped it here, which silently destroyed the very
      // thing this feature exists to keep.
    }
    this.enqueueWrite()
    await this.flushNow()
    // Purge the OLD generation's logs first, then advance the generation. Advancing
    // first would leave those logs unreferenced and un-purged.
    await this.maintenance.purgeRoomArtifacts(roomId, sessions)
    // …and the derived fold the host keeps for those sessions. The log is not the only
    // copy of a conversation: `session_projcache` held readable text from cleared rooms.
    await this.maintenance.purgeProjectionCache(sessions)
    this.state = {
      ...this.state,
      rooms: this.state.rooms.map(r =>
        r.id === roomId ? { ...r, clearCount: (r.clearCount ?? 0) + 1 } : r,
      ),
    }
    this.enqueueWrite()
    await this.flushNow()
  }

  /**
   * Compress a room's older history into ONE summary row, keeping the newest `keepLast` verbatim.
   *
   * WHY THE ROOM'S OWN MESSAGES ARE THE THING TO COMPRESS. There is no host-side
   * compaction API: the bot's session is hidden inside this plugin, and `RunExecutor`'s
   * memory is exactly `historyMessagesInPrompt` messages read from `state.messages`
   * (plus `SessionRunner`'s seed of the same list into a fresh session). So replacing the
   * old messages with a summary is the one lever that shrinks what every later turn —
   * and every fresh session — actually carries.
   *
   * THE THREE STORES MOVE TOGETHER, or the compression is a lie in one of them:
   *
   *   · `state.messages` — the older segment becomes {@link summaryMessageText}'s single
   *     `压缩摘要` message; the newest `keepLast` stay byte-for-byte.
   *   · the LEDGER — the panel renders the ledger, not the messages, so it is rebuilt
   *     from the new list (`seedLedgerRoom`) and the pre-compaction rows are gone.
   *   · the SESSIONS — the summary only compresses what a bot carries forward if the old
   *     session is not resumable: refreshing its seed from `state.messages` would restore
   *     the whole transcript from the runtime's own log. The room's generation therefore
   *     advances (`compactCount`) and the retired logs are purged, exactly as
   *     `clearMessages` does for a cleared room.
   *
   * ORDERING IS THE SAFETY PROPERTY. Every refusal — too short, a live turn, a model
   * failure, a message that arrived while the model was thinking — happens BEFORE the
   * first write, so a rejected compaction leaves the room byte-for-byte unchanged.
   */
  async compactRoom(input: CompactRoomRequest): Promise<CompactRoomResult> {
    await this.whenReady()
    const roomId = input.roomId
    const room = requireRoom(this.state, roomId)
    const keepLast = clampKeepLast(input.keepLast)

    // A live turn is appending to the very history this method rewrites, and retiring the
    // session mid-turn would cut it off. Refuse instead of racing it.
    if (this.liveRunIn(roomId)) {
      return {
        compacted: false,
        reason: '这个房间正在回复中，等这一轮结束再压缩。',
        removed: 0, kept: 0, sessionsRetired: 0,
      }
    }
    // Double-click guard: the second call must not start a second summariser over the same
    // segment. (The window is short — one model call — but the two would otherwise both
    // mutate, and the second would delete messages the first had already summarised.)
    if (this.compacting.has(roomId)) {
      return {
        compacted: false,
        reason: '正在压缩这个房间，请稍候。',
        removed: 0, kept: 0, sessionsRetired: 0,
      }
    }

    const messages = this.listMessages(roomId)
    if (messages.length <= keepLast + 2) {
      return {
        compacted: false,
        reason: `对话还太短（${messages.length} 条），不需要压缩。`,
        removed: 0, kept: messages.length, sessionsRetired: 0,
      }
    }

    const botId = room.directBotId ?? room.memberIds[0]
    const bot = botId === undefined ? undefined : this.getBot(botId)
    // `directStream()` IS the plugin's sanctioned path (`ctx.llm.stream`, §24.4 — the same
    // one the group-proposal judgement and the skill profiler use); only its declared
    // request type is stale. It says `messages: { content: string }`, while the host's
    // envelope requires `ContentBlock[]`, and a string there is what the adapter rejected
    // as a bare TRANSPORT failure. The cast is the type catching up with the wire, not a
    // second client.
    const stream = this.directStream() as unknown as CompactStream | undefined
    if (stream === undefined || bot?.provider === undefined || bot.model === undefined) {
      return {
        compacted: false,
        reason: '这个房间没有可用于生成摘要的模型，未做修改。',
        removed: 0, kept: messages.length, sessionsRetired: 0,
      }
    }

    const { older, tail } = splitForCompaction(messages, keepLast)
    this.compacting.add(roomId)
    let summary: string
    try {
      summary = await summariseHistory({
        stream,
        provider: bot.provider,
        model: bot.model,
        roomName: room.name ?? '',
        // The room-bot session this summary belongs to. It is ROUTING METADATA, not a
        // write: the call is stamped as an auxiliary `compaction` of that conversation
        // instead of a stray turn with no route, which is what the provider transport
        // rejected with a bare TRANSPORT failure when the field was missing.
        sessionId: this.sessionIdFor(roomId, bot.id),
        // The model-facing payload wins, exactly as `buildPrompt` does it: a `/skill`
        // message carries the expanded body there while the bubble shows the draft.
        older: older.map(m => ({ senderName: m.sender.name, text: m.modelText ?? m.text })),
      })
    } finally {
      this.compacting.delete(roomId)
    }

    // ── NOTHING ABOVE THIS LINE HAS MUTATED ANYTHING ──────────────────────────
    //
    // The model call is the only await that can last seconds, so the room may have moved
    // under it. Re-read and require the SAME head: summarising a stale segment and then
    // deleting the messages that arrived in the meantime would lose them, which is the one
    // thing this method must never do.
    const current = this.listMessages(roomId)
    const unchanged = current.length === messages.length
      && current.every((m, i) => m.id === messages[i]!.id)
    if (!unchanged || this.liveRunIn(roomId)) {
      return {
        compacted: false,
        reason: '压缩期间房间里有新消息，未做修改，请重试。',
        removed: 0, kept: current.length, sessionsRetired: 0,
      }
    }

    // ── NON-DESTRUCTIVE FROM HERE (the user's rule: 压缩必须可找回) ─────────────
    //
    // The bot sessions are NOT disposed and their logs are NOT purged: a bot's own window is
    // DSH's business — the `standard` preset already compacts it under its own pressure line
    // (80% of the window, keeping the newest 16% verbatim) — and retiring the session here was
    // the plugin deleting memory the user never asked it to delete.

    // ── HARD CONSTRAINTS SURVIVE THE FOLD (OP-03) ──────────────────────────────
    //
    // The segment being replaced is about to leave the prompt. A summary model may paraphrase
    // or silently drop a "必须/不要" rule stated there, so the user's hard constraints are
    // extracted VERBATIM from `older` (user messages only) and merged with what this room
    // already pinned. They are then: (a) appended to the summary message text, and (b) stored
    // on the room, where `roomConstraintsBlock` re-injects them into EVERY later turn. The
    // room is re-read here, not taken from the pre-summarise snapshot, so a concurrent change
    // cannot be overwritten by a stale list.
    const pinnedConstraints = mergePinnedConstraints(
      this.state.rooms.find(r => r.id === roomId)?.pinnedConstraints,
      extractPinnedConstraints(older),
    )

    const summaryMessage: BotMessage = {
      id: brandId<BotMessageId>(randomUUID()),
      roomId: brandId<BotRoomId>(roomId),
      // `routine` is the honest kind: no bot and no user wrote this row, the plugin did.
      sender: { kind: 'routine', name: COMPACT_SENDER_NAME },
      text: summaryMessageText(older.length, summary, pinnedConstraints),
      mentions: [],
      // Stamped at the FOLD BOUNDARY — just before the first kept message — so the rebuilt
      // transcript shows the checkpoint in the newest page. The first version used the oldest
      // replaced message, which put the row at the very start of the room; the panel loads the
      // newest page and the summary was invisible until 「加载更早」 (found in an E2E run).
      createdAt: checkpointCreatedAt(older, tail),
      kind: 'summary',
    }
    // The ORIGINAL rows stay. The checkpoint is ADDED, and the folded ids are recorded so the
    // prompt can skip them — folding is a window operation, not a delete.
    //
    // THE IDS COME FROM THE SPLIT, NEVER FROM TIMESTAMPS. `older` IS the segment the summary
    // replaced, so its ids are the fold set by construction. Recomputing it from
    // `createdAt < summaryMessage.createdAt` was always empty (the checkpoint is stamped at the
    // boundary, not at the oldest replaced row), which is how the prompt kept replaying
    // everything the summary had replaced.
    const foldedIds = foldedMessageIds(older)
    this.state = {
      ...this.state,
      messages: [...this.state.messages, summaryMessage],
      rooms: this.state.rooms.map(r => r.id === roomId
        ? {
          ...r,
          foldedSeqs: foldedIds,
          foldCheckpointId: summaryMessage.id,
          // Pinned constraints live on the ROOM, not on the summary row: the summary ages out
          // of the prompt window, a user rule must not. Cleared by `clearMessages`.
          pinnedConstraints,
          // `compactCount` is deliberately NOT bumped: it advances the session generation,
          // which would abandon every member's conversation — the opposite of what the user
          // asked for.
          updatedAt: nowIso(),
        }
        : r),
    }
    this.enqueueWrite()
    await this.flushNow()
    // ── THE PANEL RENDERS THE LEDGER, NOT `state.messages` ────────────────────
    //
    // Without a rebuild the compaction was invisible in the room: the summary message has no
    // runId, so `seedRoom`'s "a message without a runId is a coordination post, never render
    // it" rule would drop it, and the live ledger still held the PRE-compaction rows. Rebuild
    // the room now: nothing is live (refused above), the persisted state is already flushed,
    // and the originals are still in `state.messages`, so the rebuild keeps every original row
    // AND adds the checkpoint row. `seedLedgerRoom` sorts by time, so the checkpoint lands at
    // the fold boundary. Best-effort: the state mutation already succeeded and a projection
    // refresh must not turn a successful compaction into an error.
    try {
      this.ledger.clearRoom(brandId<BotRoomId>(roomId))
      // Mark hydrated BEFORE seeding: a lazy `listLedger` would otherwise rebuild the room a
      // second time on the panel's first poll (two rows per message, both with fresh ids).
      this.ledgerHydrated.add(roomId)
      this.maintenance.seedLedgerRoom(roomId)
    } catch (error: unknown) {
      this.ctx.logger?.warn?.(
        `agent-community: compacted room ${roomId} but could not rebuild its ledger: ${String(error)}`,
      )
    }
    this.ctx.logger?.info?.(
      `agent-community: folded room ${roomId}: ${foldedIds.length} message(s) behind 1 checkpoint, `
      + `${tail.length} kept in the window; originals retained (panel rebuilt), bot sessions untouched`,
    )
    return {
      compacted: true,
      removed: foldedIds.length,
      kept: tail.length,
      summary,
      // Always 0 now: no session is retired, because a bot's own window belongs to DSH.
      sessionsRetired: 0,
    }
  }

  /** True while any run of this room is queued or running. */
  private liveRunIn(roomId: string): boolean {
    return this.state.runs.some(
      r => r.roomId === roomId && (r.status === 'queued' || r.status === 'running'),
    )
  }

  // ── Run Management ─────────────────────────────────────────────────────────

  listRuns(botId?: string): BotRun[] {
    if (botId !== undefined) return this.state.runs.filter(r => r.botId === botId)
    return [...this.state.runs]
  }

  async retryRun(input: RetryBotRunRequest): Promise<BotRun> {
    const idx = this.state.runs.findIndex(r => r.id === input.id)
    if (idx < 0) throw new Error(`Run "${input.id}" not found`)
    const prev = this.state.runs[idx]!
    if (prev.controlRevision !== input.expectedRevision) {
      throw new Error(`Run "${input.id}" revision mismatch`)
    }
    const updated: BotRun = {
      ...prev,
      status: 'queued',
      controlRevision: prev.controlRevision + 1,
      attempt: prev.attempt + 1,
      updatedAt: nowIso(),
    }
    const runs = [...this.state.runs]
    runs[idx] = updated
    // Whatever path brought the run to a terminal state, no ledger entry for it may
    // stay flagged `streaming: true`: the panel reads that flag to decide between
    // the deep-diving row and the finished answer, so a leftover flag shows
    // 「深度求索中」until the room is reloaded.
    if (updated.status !== 'running' && updated.status !== 'queued') {
      this.ledger.settleRunEntries(prev.id, prev.roomId, terminalDurationMs(prev, updated))
    }
    this.state = { ...this.state, runs }
    this.enqueueWrite()
    return updated
  }

  async controlRun(input: ControlBotRunRequest): Promise<BotRun> {
    const idx = this.state.runs.findIndex(r => r.id === input.id)
    if (idx < 0) throw new Error(`Run "${input.id}" not found`)
    const prev = this.state.runs[idx]!
    if (prev.controlRevision !== input.expectedRevision) {
      throw new Error(`Run "${input.id}" revision mismatch`)
    }
    const statusMap = {
      steer: prev.status,
      interrupt: 'interrupted' as const,
      cancel: 'cancelled' as const,
    }
    const updated: BotRun = {
      ...prev,
      status: statusMap[input.action],
      controlRevision: prev.controlRevision + 1,
      updatedAt: nowIso(),
    }
    const runs = [...this.state.runs]
    runs[idx] = updated
    this.state = { ...this.state, runs }
    this.enqueueWrite()
    // Actually cancel the live run when the user hits stop/interrupt.
    //
    // This used to look up a SESSION id and hand it to an executor map that is keyed
    // by session id but never written to, so the lookup always failed and the stop
    // was a silent no-op — the bot kept streaming and replied anyway. The run id is
    // what identifies the in-flight work, so pass that.
    if (input.action === 'interrupt' || input.action === 'cancel') {
      this.executor?.interruptRun(prev.id)
      // Settle anything the run left mid-stream, so the panel cannot sit on a
      // "深度求索中" spinner for a run that will never produce more output.
      // A stop has no completion time to report, so stamp no duration.
      this.ledger.settleRunEntries(prev.id, prev.roomId)
    }
    return updated
  }

  /**
   * Terminal transition for one run, the only way a run leaves `running`.
   * `controlRun` can only interrupt or cancel; without this a completed run
   * would keep its owner reported as busy forever.
   */
  async settleRun(input: SettleBotRunRequest): Promise<BotRun> {
    const idx = this.state.runs.findIndex(r => r.id === input.id)
    if (idx < 0) throw new Error(`Run "${input.id}" not found`)
    const prev = this.state.runs[idx]!
    if (prev.controlRevision !== input.expectedRevision) {
      throw new Error(`Run "${input.id}" revision mismatch`)
    }
    if (input.leaseOwner !== undefined && prev.leaseOwner !== input.leaseOwner) {
      throw new Error(`Run "${input.id}" lease owner mismatch`)
    }
    // ── RETRY IS A POLICY, NOT A HABIT ──────────────────────────────────────────
    //
    // The kind decides whether another attempt makes sense at all: transport/provider/tool
    // failures are transient, while a timeout, a no-progress stop and a user stop are
    // terminal (retrying them burns the same tokens for the same outcome). The budget is the
    // configured retry policy, and the wait is exponential via `nextRetryAt` — the queue
    // already honours that field, it was simply never written before S8.
    const retryPolicy = resolveRetryPolicy(this.cfg.runRetryPolicy)
    const failureKind = input.status === 'failed'
      ? input.failureKind ?? classifyFailure(input.status, input.error)
      : undefined
    const shouldRetry = input.retry === true && input.status === 'failed'
      && failureKind !== undefined && isRetryableFailureKind(failureKind)
      && prev.attempt + 1 < retryPolicy.maxAttempts
    const nextRetryAt = shouldRetry
      ? new Date(Date.now() + retryBackoffMs(retryPolicy, prev.attempt)).toISOString()
      : undefined
    const base: BotRun = {
      ...prev,
      status: shouldRetry ? 'queued' : input.status,
      controlRevision: prev.controlRevision + 1,
      attempt: shouldRetry ? prev.attempt + 1 : prev.attempt,
      finishedAt: shouldRetry ? prev.finishedAt : nowIso(),
      error: input.error ?? prev.error,
      lastError: input.error ?? prev.lastError,
      failureKind,
      nextRetryAt,
      // The next attempt derives a fresh budget on claim; a terminal run keeps the one it had
      // for diagnosis (the panel can show "deadline was X").
      ...(shouldRetry
        ? { deadlineAt: undefined, lastProgressAt: undefined, extensions: 0, progressEvents: 0 }
        : {}),
      updatedAt: nowIso(),
    }
    let runs = [...this.state.runs]
    runs[idx] = base
    let messages = this.state.messages
    // ── ONE RUN, ONE DELIVERY ──────────────────────────────────────────────────
    //
    // Everything the room should see from this run is decided HERE, once:
    //   · a visible run publishes its own reply — a member's answer stays visible (the
    //     user's decision), and so does a normal answer;
    //   · an internal run (the leader's integrate turn) publishes nothing, because the
    //     members it summarises already spoke in the room; only the report it finished
    //     the task with is delivered (see `chooseFinalDelivery`);
    //   · a run that produced no text but did finish the task delivers its report — a
    //     tool-only `finish_task` used to leave the room silent;
    //   · a retry is not a finished turn: it delivers nothing.
    //
    // `postReport` no longer writes a row of its own (it stashes the report on the run),
    // which is what stops one delivery from rendering twice: once with the run's
    // reasoning, once as a bare ledger row.
    const replyText = input.reply?.text ?? ''
    const retrying = base.status === 'queued'
    const publish = publishOf(prev)
    const finishReport = retrying ? undefined : this.takeFinishReport(prev)
    // ── RUN EVIDENCE (OP-04) ────────────────────────────────────────────────────
    //
    // The run's measurable record: duration and finish path folded in HERE (the executor
    // cannot know how a finish_task report is delivered, or what the real wall-clock cost
    // was up to settle); failure side attributed from the resolved failure kind/error.
    // Both are additive — nothing in the delivery/retry/publish flow reads them.
    const durationMs = runDurationMs(base)
    const evidence = this.finalizeRunEvidence(base, input, failureKind, finishReport, durationMs)
    const updated: BotRun = {
      ...base,
      evidence,
      ...(evidence.faultSide !== undefined ? { faultSide: evidence.faultSide } : {}),
    }
    runs[idx] = updated
    const delivery = retrying
      ? { text: '', publishFinal: false }
      : chooseFinalDelivery({
          replyText,
          ...(finishReport !== undefined ? { finishReport } : {}),
          publish,
        })
    if (delivery.publishFinal) {
      // Idempotent: a settle observed twice (or a retry that already delivered once) must
      // not append the same body again.
      const alreadyDelivered = this.state.messages.some(
        m => m.roomId === prev.roomId && m.runId === prev.id,
      )
      if (!alreadyDelivered) {
        // B-2: use the real session id from roomAgentSessions rather than
        // prev.sessionId, which is often a stale UUID that has no session directory.
        const realSessionId = this.state.roomAgentSessions.find(
          s => s.roomId === prev.roomId && s.botId === prev.botId,
        )?.sessionId ?? prev.sessionId
        const reply: BotMessage = {
          id: brandId<BotMessageId>(randomUUID()),
          roomId: prev.roomId,
          sender: {
            kind: 'bot',
            botId: prev.botId,
            name: this.state.bots.find(b => b.id === prev.botId)?.name ?? 'bot',
          },
          text: delivery.text,
          mentions: [],
          createdAt: nowIso(),
          runId: prev.id,
          sessionId: realSessionId,
          ...(input.reply !== undefined ? { sessionSeq: input.reply.sessionSeq } : {}),
          // For an internal turn only the DELIVERED body survives. Its reasoning and tool
          // cards were suppressed live (the turn is coordination), so persisting them would
          // make the same turn look different after a restart — the inconsistency this
          // publication change exists to remove. Files are different: they are the turn's
          // own output and the panel's cards must survive a reload.
          ...(publish === 'visible' && input.reply?.reasoning !== undefined ? { reasoning: input.reply.reasoning } : {}),
          ...(publish === 'visible' && input.reply?.toolActivity !== undefined ? { toolActivity: input.reply.toolActivity } : {}),
          ...(input.reply?.deliverables !== undefined ? { deliverables: input.reply.deliverables } : {}),
          ...(input.reply?.usage !== undefined ? { usage: input.reply.usage } : {}),
          // Wall-clock time for this run, so the panel can show the same
          // "已完成，用时 1分23秒" line the native transcript does.
          durationMs,
          sequence: this.state.messages.filter(m => m.roomId === prev.roomId).length,
        }
        messages = [...messages, reply]
      }
    }
    this.state = { ...this.state, runs, messages }
    this.enqueueWrite()
    // ── THE LEDGER MUST SHOW THE SAME THING ────────────────────────────────────
    //
    // The panel renders the ledger, not `state.messages`. A visible run already wrote its
    // answer row through the projection/executor; an internal run's writers were all
    // suppressed, so its delivered report is pushed here — one row, with the run id and
    // duration, so a reload shows the same transcript. A run with nothing to deliver must
    // not leave a row flagged live.
    if (delivery.publishFinal) {
      this.writeDeliveredRow(updated, delivery.text, input.reply?.usage)
    } else {
      this.ledger.settleRunText(prev.roomId, prev.id)
    }
    // ── WHAT THIS BOT DID, IN THIS ROOM ─────────────────────────────────────────
    //
    // One line per finished turn, keyed by (room, bot) — the pair the user's isolation rule is
    // about. Only a turn that DELIVERED something is recorded: an internal run that published
    // nothing (a pure integration pass) was coordination, not something the bot accomplished,
    // and `completed` excludes a retry, a stop and a failure.
    //
    // File-backed, and it says so: `rememberTask` reports a write failure rather than swallowing
    // it, because a memory that silently did not get written is worse than no memory at all.
    if (updated.status === 'completed' && delivery.publishFinal) {
      void this.rememberTask(prev, delivery.text)
    }
    // ── THE ROOM REACTS TO A SETTLED RUN ────────────────────────────────────────
    //
    // Two things follow a finished turn, and both belong to the ROOM rather than to the run:
    // a member that was handed work may let the leader continue (`onMemberFinished`), and an
    // active room goal decides whether to keep going or to stall out. A retry (`queued`) is
    // not a finished turn, so it is not passed on.
    if (updated.status === 'completed' || updated.status === 'failed'
      || updated.status === 'interrupted' || updated.status === 'cancelled') {
      this.afterRunSettled(prev, updated.status, replyText, input.reply?.toolActivity?.length ?? 0)
      // OP-16: after the room reacted, decide whether this settle deserves a human's attention.
      this.maybeDiagnoseRun(updated)
    }
    // NOTE: deliberately NO re-seed here.
    //
    // `settleRunEntries` above already stamped the duration onto the live rows, so a
    // rebuild adds nothing. It actively hurts: `seedLedgerRoom` numbers rows from a
    // GLOBAL counter, while a ledger row's `sequence` is meant to be room-monotonic
    // in send order. Re-seeding therefore (a) reordered the transcript — a tool row
    // could be sorted above a message that preceded it — and (b) handed rows numbers
    // BELOW the cursor the client already held, so a cursor query returned nothing
    // newer and the finished reply with its duration never reached the panel until
    // the reader left the room and the component re-mounted with a zero cursor.
    return updated
  }

  // ── Default workspace ──────────────────────────────────────────────────────

  /**
   * Root that holds one private directory per bot.
   *
   * Follows the SAME home as the board (see `resolveAgentCommunityHome`): a bot's
   * workspace is its session's `cwd`, and that `cwd` decides which on-disk session
   * bucket the conversation lands in. Hardcoding `~/.dsh` here while the board moved
   * with `$DSH_HOME` would put an isolated instance's sessions back in the shared store.
   */
  private botWorkspaceRoot(): string {
    return join(this.home, 'agent-community', 'workspaces')
  }

  /**
   * A bot's private workspace directory.
   *
   * Bots used to default to the shared DSH workspace, so a file one bot created
   * during a direct chat was visible to every other bot in every group chat —
   * which looked exactly like the group bot "remembering" the private chat. Each
   * bot now gets its own directory.
   */
  private botWorkspaceDir(botId: string): string {
    const safe = botId.replace(/[^a-zA-Z0-9._-]/g, '_')
    return join(this.botWorkspaceRoot(), safe)
  }

  /**
   * The bot's workspace, created on disk if it is missing.
   *
   * `botWorkspaceDir` only builds a path. Without this the directory never existed,
   * and since the path is handed to the session as its `cwd`, session creation failed
   * and the bot silently produced nothing. Awaiting the mkdir before persisting the
   * bot keeps the invariant true from the moment the bot exists.
   */
  private async ensureBotWorkspace(botId: string): Promise<string> {
    const dir = this.botWorkspaceDir(botId)
    await mkdir(dir, { recursive: true }).catch(() => undefined)
    return dir
  }

  /**
   * The directory a bot's sessions actually run in.
   *
   * `bot.workspace` wins when the user configured one — that IS the session's `cwd` —
   * and `botWorkspaceDir` is the fallback, the same rule `session-runner` applies. An
   * attachment must land in the first of those: a file written to the default directory
   * of a bot that runs somewhere else sits outside its workspace, where a sandboxed bot
   * cannot read it — which is the same as not attaching it at all.
   */
  private runWorkspaceDir(botId: string): string {
    const bot = this.state.bots.find(b => b.id === botId)
    const configured = bot?.workspace
    return configured !== undefined && configured !== '' ? configured : this.botWorkspaceDir(botId)
  }

  /**
   * Store a message's attachments in the workspace of every bot that may read it.
   *
   * A direct room writes exactly one copy (it has one bot). A group writes one copy per
   * member, because the routing decision that picks the answering bot is made further
   * down `sendMessage` — writing only for the room's leader would hand the file to a bot
   * that never answers, and a file the winner cannot open is the same as no attachment.
   *
   * Returns `undefined` when the message carries no files, so the caller can leave the
   * model payload byte-for-byte as it was.
   */
  private async storeMessageAttachments(
    attachments: readonly SendRoomMessageAttachment[] | undefined,
    room: BotRoom,
  ): Promise<{ stored: StoredAttachment[]; singleRecipient: boolean } | undefined> {
    const list = attachments ?? []
    if (list.length === 0) return undefined
    const recipientIds = room.directBotId !== undefined ? [room.directBotId] : room.memberIds
    if (recipientIds.length === 0) {
      throw new Error('这个房间没有成员 Bot，附件无处保存')
    }
    const at = new Date()
    let stored: StoredAttachment[] = []
    for (const botId of recipientIds) {
      // Same bytes and same names per bot, but different absolute directories — which is
      // exactly why only a single-recipient message can quote an absolute path.
      const written = await storeAttachments(this.runWorkspaceDir(botId), list, at)
      if (stored.length === 0) stored = written
    }
    return { stored, singleRecipient: recipientIds.length === 1 }
  }

  private defaultWorkspaceCache: string | undefined

  async resolveDefaultWorkspace(): Promise<string> {
    if (this.defaultWorkspaceCache !== undefined) return this.defaultWorkspaceCache
    // Try DSH workspace registry first; fall back to a well-known path.
    try {
      const registry = this.ctx.get('workspaceRegistry') as
        | { list(): Array<{ path: string }> }
        | null
        | undefined
      const first = registry?.list()?.[0]?.path
      if (first !== undefined && first !== '') {
        this.defaultWorkspaceCache = first
        return first
      }
    } catch {
      // workspaceRegistry not available in this DSH build; use fallback
    }
    const fallback = join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace')
    this.defaultWorkspaceCache = fallback
    return fallback
  }

  /** Returns defaults the UI needs to pre-populate the create-bot form. */
  async getDefaults(): Promise<{ defaultWorkspace: string }> {
    return { defaultWorkspace: await this.resolveDefaultWorkspace() }
  }

  // ── Team helpers ───────────────────────────────────────────────────────────

  async teamMembership(sessionId: string): Promise<BotTeamMembership | undefined> {
    for (const room of this.state.rooms) {
      if (room.team === undefined) continue
      const { leader } = room.team
      if (leader.kind === 'session' && leader.sessionId === sessionId) {
        return { room, role: 'lead', name: room.team.leaderName }
      }
      const session = this.state.roomAgentSessions.find(
        s => s.roomId === room.id && s.sessionId === sessionId,
      )
      if (session !== undefined) {
        const bot = this.state.bots.find(b => b.id === session.botId)
        return { room, role: 'member', name: bot?.name ?? 'member', botId: session.botId }
      }
    }
    return undefined
  }

  async postTeamMessage(input: PostTeamMessageRequest): Promise<TeamMessageResult> {
    const room = requireRoom(this.state, input.roomId)
    const msg: BotMessage = {
      id: brandId<BotMessageId>(randomUUID()),
      roomId: brandId<BotRoomId>(input.roomId),
      sender: {
        kind: input.sender.kind,
        ...(input.sender.botId !== undefined ? { botId: brandId<BotId>(input.sender.botId) } : {}),
        name: input.sender.name,
      },
      text: input.text,
      mentions: [],
      kind: input.kind,
      targetNames: [...input.targetNames],
      createdAt: nowIso(),
      sequence: this.state.messages.filter(m => m.roomId === input.roomId).length,
    }
    const runs: BotRun[] = input.targetBotIds.map(botId => ({
      id: brandId<BotRunId>(randomUUID()),
      botId: brandId<BotId>(botId),
      roomId: brandId<BotRoomId>(input.roomId),
      // A run owns a real Session so its bot conversation can be rendered by the
      // shared Conversation surface; a fabricated id would leave the embedded
      // view with nothing to bind to.
      sessionId: brandId<SessionId>(randomUUID()),
      origin: input.origin,
      prompt: input.text,
      assignment: input.assignment,
      status: 'queued' as const,
      controlRevision: 0,
      attempt: 0,
      maxAttempts: 3,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }))
    const activeRuns = this.state.runs.filter(
      r => r.status === 'queued' || r.status === 'running',
    ).length
    if (activeRuns + runs.length > this.cfg.maxRuns) {
      throw new Error(
        `Run limit ${this.cfg.maxRuns} reached (${activeRuns} active, ${runs.length} requested)`,
      )
    }
    const messages = [...this.state.messages, msg]
    const allRuns = [...this.state.runs, ...runs]
    this.state = { ...this.state, messages, runs: allRuns }
    this.enqueueWrite()
    return { message: msg, runs }
  }

  async dismissTeam(input: DismissTeamRequest): Promise<void> {
    const idx = this.state.rooms.findIndex(r => r.id === input.roomId)
    if (idx < 0) throw new Error(`Room "${input.roomId}" not found`)
    const prev = this.state.rooms[idx]!
    if (prev.team === undefined) throw new Error(`Room "${input.roomId}" is not a team room`)
    const updated: BotRoom = {
      ...prev,
      team: { ...prev.team, status: 'dismissed' },
      updatedAt: nowIso(),
    }
    const rooms = [...this.state.rooms]
    rooms[idx] = updated
    this.state = { ...this.state, rooms }
    this.enqueueWrite()
  }

  // ── Bot Sessions ───────────────────────────────────────────────────────────

  /**
   * The session a (room, bot) pair owns, registered in state and returned.
   *
   * The id is DERIVED, not randomised (§17.4 b): `ac-<roomId>-<botId>`. A random id
   * per run meant the visibility list could only ever be a hand-maintained
   * bookkeeping table, and any creation site that forgot to register left a session
   * on the user's sidebar. With a derived id the list is recomputable from
   * `state.rooms × state.bots`, and `listKnownSessionIds` cannot fall out of date.
   *
   * Idempotent: re-registering the same pair writes nothing, so the hot paths
   * (sendMessage, clear-then-reseed) no longer churn state.json.
   */
  ensureStableSession(roomId: string, botId: string): SessionId {
    const room = requireRoom(this.state, roomId)
    const bot = requireBot(this.state, botId)
    const sessionId = this.sessionIdFor(roomId, botId)
    const existing = this.state.roomAgentSessions.find(
      s => s.roomId === roomId && s.botId === botId,
    )
    if (existing?.sessionId === sessionId) return sessionId
    const others = this.state.roomAgentSessions.filter(
      s => !(s.roomId === roomId && s.botId === botId),
    )
    const entry: RoomAgentSession = {
      roomId: brandId<BotRoomId>(roomId),
      botId: brandId<BotId>(botId),
      sessionId,
    }
    this.state = { ...this.state, roomAgentSessions: [...others, entry] }
    this.enqueueWrite()
    return sessionId
  }

  /** Transition a queued run to running state with a lease. */
  async claimRun(input: {
    id: string
    expectedRevision: number
    leaseOwner: string
    leaseExpiresAt: string
  }): Promise<BotRun> {
    const idx = this.state.runs.findIndex(r => r.id === input.id)
    if (idx < 0) throw new Error(`Run "${input.id}" not found`)
    const prev = this.state.runs[idx]!
    if (prev.status !== 'queued') throw new Error(`Run "${input.id}" is not queued (status: ${prev.status})`)
    if (prev.controlRevision !== input.expectedRevision) {
      throw new Error(`Run "${input.id}" revision mismatch`)
    }
    const updated: BotRun = {
      ...prev,
      status: 'running',
      controlRevision: prev.controlRevision + 1,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
      startedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
      // A fresh attempt gets a fresh budget: the executor derives a new deadline right after
      // the claim, and the previous attempt's clock (or a retry's nextRetryAt) must not leak
      // into it. `failureKind` is cleared for the same reason — it describes the last try.
      deadlineAt: undefined,
      lastProgressAt: undefined,
      extensions: 0,
      progressEvents: 0,
      nextRetryAt: undefined,
      failureKind: undefined,
      // ── WHO IS RUNNING THIS (OP-01) ────────────────────────────────────────────
      // Recorded once, at the moment the run really starts; a retry/requeue keeps the same
      // attribution (`prev.harness`), because the harness of the attempt that produced the
      // result is what a stored evaluation must be compared against.
      harness: prev.harness ?? this.currentHarnessAttribution(),
      updatedAt: nowIso(),
    }
    const runs = [...this.state.runs]
    runs[idx] = updated
    this.state = { ...this.state, runs }
    this.enqueueWrite()
    return updated
  }

  /**
   * The harness a run claimed NOW would be attributed to (OP-01).
   *
   * Read at claim time, from the live configuration, and stored on the run: a later config
   * change, a plugin upgrade or a prompt-contract bump must not retroactively relabel the runs
   * that already produced results. `readPluginVersion` reads package.json at runtime — the
   * source deliberately contains no version literal.
   */
  private currentHarnessAttribution(): HarnessAttribution {
    return buildHarnessAttribution({
      pluginVersion: readPluginVersion(),
      harnessRevision: HARNESS_REVISION,
      promptContract: PROMPT_CONTRACT_VERSION,
      preset: this.cfg.botAgentPreset ?? 'bot',
      historyMessages: this.cfg.historyMessagesInPrompt ?? 10,
      memoryPromptEntries: this.cfg.memoryPromptEntries ?? 8,
    })
  }

  /**
   * Persist the adaptive-timeout state of a running run (called by the executor).
   *
   * The executor's hot loop keeps its own copy; this is the durable half — a panel (or a
   * restart) can show the deadline it is running against, and how much progress was seen.
   * Writes are throttled by the caller (progress at most every few seconds; a deadline or an
   * extension immediately).
   */
  updateRunBudget(id: string, patch: {
    deadlineAt?: string
    lastProgressAt?: string
    extensions?: number
    progressEvents?: number
  }): void {
    const idx = this.state.runs.findIndex(r => r.id === id)
    if (idx < 0) return
    const prev = this.state.runs[idx]!
    if (prev.status !== 'running') return
    const updated: BotRun = {
      ...prev,
      ...(patch.deadlineAt !== undefined ? { deadlineAt: patch.deadlineAt } : {}),
      ...(patch.lastProgressAt !== undefined ? { lastProgressAt: patch.lastProgressAt } : {}),
      ...(patch.extensions !== undefined ? { extensions: patch.extensions } : {}),
      ...(patch.progressEvents !== undefined ? { progressEvents: patch.progressEvents } : {}),
      updatedAt: nowIso(),
    }
    const runs = [...this.state.runs]
    runs[idx] = updated
    this.state = { ...this.state, runs }
    this.enqueueWrite()
  }

  /**
   * A run's adaptive budget was exceeded (timeout / no progress). Called by the executor
   * BEFORE it settles the run, because this is the half only the service can do:
   *
   *   · the room gets a durable, human-readable notice (the error row is diagnostics);
   *   · a GOAL CONTINUATION round that timed out pauses its goal. Without this the goal
   *     would stay active and the next settle would queue another round into the same
   *     timeout — the "automatic work that never finishes" pattern S3 was about.
   */
  onRunTimedOut(input: {
    readonly runId: string
    readonly roomId: string
    readonly botId: string
    readonly origin: string | undefined
    readonly prompt: string
    readonly kind: 'timeout' | 'no-progress'
    readonly detail: string
  }): void {
    const label = input.kind === 'no-progress' ? '运行无进展，已停止' : '运行超时，已停止'
    this.recordNotice(
      input.roomId,
      `${label}：${input.detail}（可重试，或稍后在面板调整该任务的时限）`,
    )
    if (input.origin !== 'routine' || !input.prompt.startsWith('[继续目标]')) return
    const room = this.state.rooms.find(r => r.id === input.roomId)
    if (room?.goal === undefined || room.goal.status !== 'active') return
    this.patchRoom(input.roomId, r => ({
      ...r,
      goal: pauseGoal(room.goal!, nowIso()),
    }))
    this.recordNotice(
      input.roomId,
      '目标已自动暂停：自动续跑这一轮超时/无进展，等用户确认后再继续（避免继续烧时间）。',
    )
  }

  /**
   * Take over a run whose lease has expired, without needing to know its owner.
   *
   * `claimRun` is the queued→running transition and refuses a running run, and
   * `settleRun` refuses a lease owner that does not match the stored one. Together
   * those two guards made a run left behind by a killed process **unrecoverable**:
   * its `leaseOwner` is a random UUID minted by that dead process, so nothing this
   * process can pass will ever match, the settle throws, and the run stays `running`
   * for good — with the room showing a 排队 banner and a dead 停止生成 button while
   * every later message queues behind it.
   *
   * An EXPIRED lease is the plugin's own proof that the holder is gone (a live turn
   * renews it every 15 s), so recovery may take it: this re-stamps the lease under
   * `leaseOwner` and bumps the revision, after which a normal `settleRun` succeeds.
   * The revision check and the expiry check are both enforced here, so this cannot
   * steal a run that a live process is still heartbeating.
   *
   * @param input.id - the run to reclaim.
   * @param input.expectedRevision - caller's view of the run's revision.
   * @param input.leaseOwner - the owner taking over (this process's LEASE_OWNER).
   * @param input.now - current time, for the expiry test.
   * @returns the updated run.
   * @throws when the run is missing, moved on, not running, or its lease is still valid.
   */
  reclaimStaleRun(input: {
    id: string
    expectedRevision: number
    leaseOwner: string
    now: number
  }): BotRun {
    const idx = this.state.runs.findIndex(r => r.id === input.id)
    if (idx < 0) throw new Error(`Run "${input.id}" not found`)
    const prev = this.state.runs[idx]!
    if (prev.controlRevision !== input.expectedRevision) {
      throw new Error(`Run "${input.id}" revision mismatch`)
    }
    if (prev.status !== 'running') {
      throw new Error(`Run "${input.id}" is not running (status: ${prev.status})`)
    }
    const expires = prev.leaseExpiresAt === undefined ? undefined : Date.parse(prev.leaseExpiresAt)
    if (expires === undefined || !Number.isFinite(expires) || expires >= input.now) {
      throw new Error(`Run "${input.id}" still holds a live lease`)
    }
    const updated: BotRun = {
      ...prev,
      leaseOwner: input.leaseOwner,
      updatedAt: nowIso(),
    }
    const runs = [...this.state.runs]
    runs[idx] = updated
    this.state = { ...this.state, runs }
    this.enqueueWrite()
    return updated
  }

  /** Extend the lease on a running run (called on a heartbeat interval). */
  heartbeatRun(id: string, leaseOwner: string, leaseExpiresAt: string): void {
    const idx = this.state.runs.findIndex(r => r.id === id)
    if (idx < 0) return
    const prev = this.state.runs[idx]!
    if (prev.status !== 'running' || prev.leaseOwner !== leaseOwner) return
    const updated: BotRun = {
      ...prev,
      leaseExpiresAt,
      lastHeartbeatAt: nowIso(),
      updatedAt: nowIso(),
    }
    const runs = [...this.state.runs]
    runs[idx] = updated
    this.state = { ...this.state, runs }
    this.enqueueWrite()
  }

  /**
   * Return the bot's session in a room, if one has been created.
   * Session creation is now handled by ensureStableSession; this is read-only.
   */
  ensureRoomAgentSession(roomId: string, botId: string): SessionId {
    const room = requireRoom(this.state, roomId)
    const bot = requireBot(this.state, botId)
    const existing = this.state.roomAgentSessions.find(
      s => s.roomId === roomId && s.botId === botId,
    )
    if (existing !== undefined) return existing.sessionId
    // No session yet — the executor will create one when it claims the first run.
    // Return a stable id without persisting it, so the executor can own that write.
    return brandId<SessionId>(`pending:${roomId}:${botId}`)
  }

  /** The bot's session in a room, if one has been created. */
  roomAgentSession(roomId: string, botId: string): SessionId | undefined {
    return this.state.roomAgentSessions.find(
      s => s.roomId === roomId && s.botId === botId,
    )?.sessionId
  }

  /** Every room-scoped bot session, for UI listings. */
  listRoomAgentSessions(): readonly RoomAgentSession[] {
    return [...this.state.roomAgentSessions]
  }

  /**
   * All session ids the executor should detach from workspace / archive (§17.4 b).
   *
   * DERIVED, not stored: one deterministic id per (existing room, existing member),
   * plus whatever the legacy bookkeeping table still holds. The persisted entries are
   * kept in the union for one reason only — sessions minted by an older build carry a
   * random id, and dropping them from this list would un-hide them on the user's
   * sidebar (N12). Nothing writes a random id any more.
   */
  listKnownSessionIds(): readonly string[] {
    const ids = new Set<string>()
    for (const room of this.state.rooms) {
      for (const botId of room.memberIds) {
        if (this.state.bots.some(b => b.id === botId)) ids.add(this.sessionIdFor(room.id, botId))
      }
      if (room.directBotId !== undefined) ids.add(this.sessionIdFor(room.id, room.directBotId))
    }
    for (const s of this.state.roomAgentSessions) ids.add(s.sessionId)
    return [...ids]
  }

  /**
   * Return the session id the client should retain for a room's conversation.
   *
   * - DM: the same derived id the run executor uses for this bot.
   * - Group: the LEADER's derived session. The group used to allocate a separate
   *   host session here (`roomSessionId`) for the dispatcher agent; that role is gone
   *   (§24.5 — the leader schedules), so nothing is allocated and nothing is written
   *   to state. A group with no leader falls back to the first member's id so the
   *   caller always gets a stable, hideable session id rather than a fresh UUID that
   *   no visibility sweep could ever know about.
   */
  ensureRoomSession(roomId: string): { sessionId: SessionId; isGroup: boolean } {
    const room = requireRoom(this.state, roomId)
    const isGroup = room.directBotId === undefined
    if (!isGroup) {
      const botId = room.directBotId!
      const sessionId = this.ensureStableSession(roomId, botId)
      // Keep directSessionId in sync so old persisted values still resolve.
      const idx = this.state.rooms.findIndex(r => r.id === roomId)
      if (idx >= 0 && room.directSessionId !== sessionId) {
        const rooms = [...this.state.rooms]
        rooms[idx] = { ...room, directSessionId: sessionId, updatedAt: nowIso() }
        this.state = { ...this.state, rooms }
        this.enqueueWrite()
      }
      return { sessionId, isGroup }
    }
    const leaderId = resolveRoomLeader(room)
    if (leaderId === undefined) {
      // A group with no members has no session to name. This used to fabricate
      // `ac-<roomId>` — a THIRD id format that matched neither the runner's scheme nor
      // the sweep's prefix, so such a session could never be hidden. Returning the
      // room's own id keeps the shape callers expect without inventing a session.
      return { sessionId: brandId<SessionId>(`${SessionRunner.ownedIdPrefix()}${roomId}`), isGroup }
    }
    return { sessionId: this.sessionIdFor(roomId, leaderId), isGroup }
  }

  // ── Orchestration (P1-2 / P1-3) ──────────────────────────────────────────

  /** Return the room id for a given session id, or undefined if not found. */
  roomForSession(sessionId: string): string | undefined {
    // Check direct sessions and group sessions
    for (const room of this.state.rooms) {
      if (room.directSessionId === sessionId) return room.id
      if (room.roomSessionId === sessionId) return room.id
    }
    // Also check member sessions in roomAgentSessions
    const entry = this.state.roomAgentSessions.find(s => s.sessionId === sessionId)
    return entry?.roomId
  }

  /** Return a snapshot of the room context as seen by a Bot. */
  getRoomContext(roomId: string): unknown {
    const room = requireRoom(this.state, roomId)
    const members = room.memberIds.map(id => {
      const bot = this.state.bots.find(b => b.id === id)
      return bot ? { id: bot.id, name: bot.name, description: bot.description } : { id }
    })
    const recentMessages = this.state.messages
      .filter(m => m.roomId === roomId)
      .slice(-10)
      .map(m => ({ sender: m.sender.name, text: m.text, createdAt: m.createdAt }))
    const tasks = (room as BotRoom & { tasks?: BotTask[] }).tasks ?? []
    return {
      room: { id: room.id, name: room.name, paused: room.paused },
      members,
      recentMessages,
      tasks: tasks.map(t => ({
        id: t.id, subject: t.subject, status: t.status,
        assigneeName: t.assigneeName,
        report: t.report?.text,
      })),
    }
  }

  /** Post a message from a Bot, with optional a2a direct delivery. */
  async postBotMessage(input: PostBotMessageRequest & { internal?: boolean }): Promise<BotMessage> {
    const room = requireRoom(this.state, input.roomId)
    // Resolve sender bot from session id
    const senderEntry = this.state.roomAgentSessions.find(s => s.sessionId === input.senderSessionId)
    const senderBot = senderEntry ? this.state.bots.find(b => b.id === senderEntry.botId) : undefined
    // ── A BOT MAY ONLY SPEAK IN ITS OWN ROOM ────────────────────────────────────
    //
    // The session identifies the bot AND the room it is working in, and nothing used to compare
    // that room with `input.roomId`: a bot running in group A could post into group B, or into
    // somebody's direct chat, by naming it. The user's rule is explicit (不能将 A 群聊的任务发到
    // B 群聊中), and the session is the only trustworthy source here — it is what the plugin
    // itself created. A session that does not parse is a caller this plugin does not own, which
    // the tool layer already restricts.
    const senderOwner = senderEntry === undefined
      ? undefined
      : SessionRunner.parseSessionId(String(senderEntry.sessionId))
    const crossRoom = crossRoomError(senderOwner?.roomId, input.roomId)
    if (crossRoom !== undefined) throw new Error(`agent-community: ${crossRoom}`)
    if (senderEntry !== undefined && !room.memberIds.some(id => id === senderEntry.botId)) {
      throw new Error(
        `agent-community: bot "${senderEntry.botId}" is not a member of room "${input.roomId}"`,
      )
    }
    const senderName = senderBot?.name ?? 'bot'
    let suppressMessage = false
    // Internal coordination is delivered to the target below and never rendered in the room —
    // but the delivery and the wake must still happen, which is why this is a flag and not an
    // early return. Suppressing the message must never suppress the hand-off.
    if (input.internal === true) suppressMessage = true
    const msg: BotMessage = {
      id: brandId<BotMessageId>(randomUUID()),
      roomId: brandId<BotRoomId>(input.roomId),
      sender: {
        kind: 'bot',
        ...(senderBot?.id !== undefined ? { botId: senderBot.id } : {}),
        name: senderName,
      },
      text: input.text,
      mentions: [],
      createdAt: nowIso(),
      sequence: this.state.messages.filter(m => m.roomId === input.roomId).length,
    }
    if (!suppressMessage) {
      this.state = { ...this.state, messages: [...this.state.messages, msg] }
      this.enqueueWrite()
    }
    // If directed to a specific Bot, nudge executor to wake that Bot.
    //
    // NOTE: this runs even when the room message was suppressed. A suppressed message is one the
    // room should not show; the wake is the whole point of the hand-off.
    //
    // ── ONE HOP, NEVER A LOOP ───────────────────────────────────────────────────
    //
    // A run's reply can be addressed to a peer, and waking that peer starts a run whose
    // OWN reply can be addressed back — so two bots left alone held an unbounded
    // conversation. Observed in a room: the user's "@A 你跟 B 打个招呼" produced
    // A → B → A → B → A, five extra turns of invented collaboration detail
    // ("Token 交付契约 / 差异轴 / 互评机制") that nobody asked for, and every reply was
    // posted twice.
    //
    // The rule: a message sent BY a bot that is itself answering a peer message
    // (`origin: 'a2a'`) is delivered into the room but does NOT start another run. The
    // human stays in the loop — one hand-off per instruction, and the exchange stops
    // there. A user's own @mention always starts a run (its origin is `user`), so
    // asking a bot to greet another bot still works.
    if (input.toBotName !== undefined) {
      const senderRun = this.state.runs
        .filter(r => r.roomId === input.roomId && r.botId === senderBot?.id
          && r.status !== 'completed' && r.status !== 'failed' && r.status !== 'cancelled'
          && r.status !== 'interrupted')
        .slice(-1)[0]
      const answeringPeer = senderRun?.origin === 'a2a'
      const targetBot = findBotByName(this.state, input.toBotName)
      // ── A MEMBER'S REPORT WAKES THE LEADER ONCE, NOT TWICE ──────────────────
      //
      // Measured on a greeting: one member message queued an `a2a` run for the leader here, while
      // the team layer independently queued a `bot-message` run carrying 「[成员汇报]」 for the same
      // event. The leader therefore ran twice, and answered twice — two of the four extra messages
      // the user saw. The team path is the richer one (it carries the report), so a message
      // addressed to the room's own leader does not also create an `a2a` run.
      const leaderRef = room.team?.leader
      // A message addressed to the room's own leader does NOT queue an a2a run: the team layer
      // already wakes the leader when a member's turn settles, and doing both produced two leader
      // runs — and two replies — for one member delivery (measured: 14:55:27 a2a and 14:55:30
      // 成员汇报, same content). Messages between members are unaffected.
      // The room's leader, resolved the same way the rest of the service resolves it.
      //
      // `room.team?.leader` was wrong here: a group created through the proposal flow can carry
      // no `team` at all (measured on the room in question), so the test was always false and the
      // a2a run was queued as well — two wakes for one member delivery, two leader replies.
      const targetIsLeader = targetBot !== undefined && this.leaderOfRoom(String(input.roomId)) === targetBot.id
      if (targetBot !== undefined && answeringPeer !== true && targetIsLeader !== true) {
        // Create a queued run for the target bot to process the message.
        // `publish: 'visible'` is EXPLICIT here even though it is the default: this is the
        // turn of a member that was handed work, and the user's decision is that its
        // output stays visible in the room. Only the leader's integrate turn is internal.
        const run: BotRun = {
          id: brandId<BotRunId>(randomUUID()),
          botId: targetBot.id,
          roomId: brandId<BotRoomId>(input.roomId),
          sessionId: this.ensureStableSession(input.roomId, targetBot.id),
          origin: 'a2a',
          publish: 'visible',
          prompt: `[来自 ${senderName}] ${input.text}`,
          status: 'queued',
          controlRevision: 0,
          attempt: 0,
          maxAttempts: 3,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
        this.state = { ...this.state, runs: [...this.state.runs, run] }
        this.enqueueWrite()
        this.executor?.nudge()
      }
    }
    return msg
  }

  /**
   * Whether the calling Bot is answering the room RIGHT NOW.
   *
   * Used to warn a bot that posts its own reply instead of letting the executor publish it:
   * the answer is appended to the transcript when the turn ends, so an extra
   * `agent_community_post_message` call makes the user see the same reply twice. The tool
   * description and the group system prompt both say so; this is the runtime backstop for a
   * session that learned the old habit (measured: a bot answered a greeting and then posted
   * the same text again — two rows for one message).
   *
   * @param roomId - the room the message was posted into.
   * @param senderSessionId - the calling Bot's session, which identifies the bot.
   * @returns true when that bot has a live run in that room.
   */
  isAnsweringNow(roomId: string, senderSessionId: string): boolean {
    const entry = this.state.roomAgentSessions.find(s => s.sessionId === senderSessionId)
    const botId = entry?.botId
    if (botId === undefined) return false
    return this.state.runs.some(r => r.roomId === roomId && r.botId === botId
      && r.status !== 'completed' && r.status !== 'failed' && r.status !== 'cancelled'
      && r.status !== 'interrupted')
  }

  /** Leader tool: decompose the user request into tasks. */
  async decomposeTasks(input: DecomposeTasksRequest): Promise<BotTask[]> {
    const roomIdx = this.state.rooms.findIndex(r => r.id === input.roomId)
    if (roomIdx < 0) throw new Error(`Room "${input.roomId}" not found`)
    const room = this.state.rooms[roomIdx]!
    const existingTasks: BotTask[] = (room as BotRoom & { tasks?: BotTask[] }).tasks ?? []
    const newTasks: BotTask[] = input.tasks.map(t => {
      const assignee = t.assigneeName
        ? findBotByName(this.state, t.assigneeName)
        : undefined
      return {
        id: randomUUID(),
        round: 0,
        subject: t.subject,
        ...(t.detail !== undefined ? { detail: t.detail } : {}),
        ...(assignee !== undefined ? { assigneeId: assignee.id, assigneeName: assignee.name } : {}),
        status: (assignee !== undefined ? 'assigned' : 'open') as BotTaskStatus,
        attempts: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
    })
    const allTasks = [...existingTasks, ...newTasks]
    const rooms = [...this.state.rooms]
    rooms[roomIdx] = { ...room, tasks: allTasks } as BotRoom & { tasks: BotTask[] }
    this.state = { ...this.state, rooms }
    this.enqueueWrite()
    // Create runs for tasks that have assignees
    const newRuns: BotRun[] = newTasks
      .filter(t => t.assigneeId !== undefined)
      .map(t => ({
        id: brandId<BotRunId>(randomUUID()),
        botId: t.assigneeId!,
        roomId: brandId<BotRoomId>(input.roomId),
        sessionId: this.ensureStableSession(input.roomId, t.assigneeId!),
        origin: 'routine' as const,
        prompt: `[任务] ${t.subject}${t.detail ? '\n' + t.detail : ''}`,
        status: 'queued' as const,
        controlRevision: 0,
        attempt: 0,
        maxAttempts: 3,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }))
    if (newRuns.length > 0) {
      this.state = { ...this.state, runs: [...this.state.runs, ...newRuns] }
      this.enqueueWrite()
      this.executor?.nudge()
    }
    return newTasks
  }

  /** Leader tool: assign or re-assign tasks. */
  async assignTasks(input: AssignTasksRequest): Promise<BotTask[]> {
    const roomIdx = this.state.rooms.findIndex(r => r.id === input.roomId)
    if (roomIdx < 0) throw new Error(`Room "${input.roomId}" not found`)
    const room = this.state.rooms[roomIdx]!
    const assignee = findBotByName(this.state, input.assigneeName)
    if (assignee === undefined) throw new NotFoundError(`Bot named "${input.assigneeName}" not found`)
    const existingTasks: BotTask[] = (room as BotRoom & { tasks?: BotTask[] }).tasks ?? []
    const updated: BotTask[] = existingTasks.map(t =>
      input.taskIds.includes(t.id)
        ? { ...t, assigneeId: assignee.id, assigneeName: assignee.name, status: 'assigned' as BotTaskStatus, updatedAt: nowIso() }
        : t,
    )
    const rooms = [...this.state.rooms]
    rooms[roomIdx] = { ...room, tasks: updated } as BotRoom & { tasks: BotTask[] }
    this.state = { ...this.state, rooms }
    this.enqueueWrite()
    // Create runs for newly assigned tasks
    const assignedIds = new Set(input.taskIds)
    const newRuns: BotRun[] = updated
      .filter(t => assignedIds.has(t.id) && t.assigneeId !== undefined)
      .map(t => ({
        id: brandId<BotRunId>(randomUUID()),
        botId: t.assigneeId!,
        roomId: brandId<BotRoomId>(input.roomId),
        sessionId: this.ensureStableSession(input.roomId, t.assigneeId!),
        origin: 'routine' as const,
        prompt: `[任务] ${t.subject}${t.detail ? '\n' + t.detail : ''}`,
        status: 'queued' as const,
        controlRevision: 0,
        attempt: 0,
        maxAttempts: 3,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }))
    if (newRuns.length > 0) {
      this.state = { ...this.state, runs: [...this.state.runs, ...newRuns] }
      this.enqueueWrite()
      this.executor?.nudge()
    }
    return updated.filter(t => assignedIds.has(t.id))
  }

  /** Return all tasks and their status for the current room. */
  getTaskStatus(roomId: string): BotTask[] {
    const room = requireRoom(this.state, roomId)
    return (room as BotRoom & { tasks?: BotTask[] }).tasks ?? []
  }

  /** Member tool: submit a progress report for a task. */
  async reportTask(input: ReportTaskRequest): Promise<BotTask> {
    // Find the room that owns this task
    let roomIdx = -1
    let taskIdx = -1
    for (let i = 0; i < this.state.rooms.length; i++) {
      const tasks: BotTask[] = (this.state.rooms[i] as BotRoom & { tasks?: BotTask[] }).tasks ?? []
      const tIdx = tasks.findIndex(t => t.id === input.taskId)
      if (tIdx >= 0) { roomIdx = i; taskIdx = tIdx; break }
    }
    if (roomIdx < 0) throw new Error(`Task "${input.taskId}" not found`)
    const room = this.state.rooms[roomIdx]!
    const tasks: BotTask[] = (room as BotRoom & { tasks?: BotTask[] }).tasks ?? []
    const prev = tasks[taskIdx]!
    const updated: BotTask = {
      ...prev,
      status: input.status === 'done' ? 'done' : input.status === 'blocked' ? 'blocked' : 'working',
      report: { text: input.text, at: nowIso() },
      updatedAt: nowIso(),
    }
    const newTasks = [...tasks]
    newTasks[taskIdx] = updated
    const rooms = [...this.state.rooms]
    rooms[roomIdx] = { ...room, tasks: newTasks } as BotRoom & { tasks: BotTask[] }
    this.state = { ...this.state, rooms }
    this.enqueueWrite()
    return updated
  }

  /** Leader tool: finalize the round and post a summary message. */
  async submitFinal(input: SubmitFinalRequest): Promise<BotMessage> {
    const room = requireRoom(this.state, input.roomId)
    const leaderEntry = this.state.roomAgentSessions.find(s => s.sessionId === input.leaderSessionId)
    const leaderBot = leaderEntry ? this.state.bots.find(b => b.id === leaderEntry.botId) : undefined
    const msg: BotMessage = {
      id: brandId<BotMessageId>(randomUUID()),
      roomId: brandId<BotRoomId>(input.roomId),
      sender: {
        kind: 'bot',
        ...(leaderBot?.id !== undefined ? { botId: leaderBot.id } : {}),
        name: leaderBot?.name ?? '负责人',
      },
      text: input.replyToUser,
      mentions: [],
      createdAt: nowIso(),
      sequence: this.state.messages.filter(m => m.roomId === input.roomId).length,
    }
    this.state = { ...this.state, messages: [...this.state.messages, msg] }
    this.enqueueWrite()
    return msg
  }

  // ── Group proposal (P1-4 / §5.4) ──────────────────────────────────────────

  /**
   * Record a group proposal for one direct-chat message.
   *
   * The judgement belongs to the BOT. Either the `propose_group` tool hands over a
   * proposal the model actually wrote (memberIds present), or the direct-chat bot's
   * own model is asked through a direct `llm.stream` call. What no longer happens is
   * the old heuristic — "there are at least two bots, so suggest the first two" —
   * which produced a dialog the user had not been offered by any bot, and whose
   * roster knew nothing about the task.
   *
   * Returns undefined whenever a group is not warranted: fewer than two bots, a
   * group room, no such message, or a model that answered "single bot is enough".
   */
  async proposeGroup(input: ProposeGroupRequest): Promise<GroupProposal | undefined> {
    return this.groupFlow.propose(input)
  }

  /**
   * User confirmed: create the group, move the user's original task into it verbatim,
   * and start ONLY the leader (§5.4).
   *
   * A proposal whose members have since been deleted is re-filtered here — the
   * dialog may have been open across a delete, and a group containing a bot that no
   * longer exists would have no valid members to run.
   */
  async confirmGroup(input: ConfirmGroupRequest): Promise<BotRoom> {
    return this.groupFlow.confirm(input)
  }

  /**
   * User declined (or the dialog timed out): mark it declined and let the direct
   * chat finish the task on its own — the bot must never be left waiting.
   */
  async declineGroup(input: DeclineGroupRequest): Promise<void> {
    await this.groupFlow.decline(input)
  }

  /** The room's pending proposal, if any (expiry applied). Used by the panel. */
  pendingGroupProposal(roomId: string): PendingGroupProposal | undefined {
    return this.groupFlow.pending(roomId)
  }

  // ── Group membership + background task board (§5.6 / §5.7) ─────────────────

  /**
   * `invite_bot` (§5.6): add one bot, enforcing 4 per turn and 20 per room.
   *
   * Returns a failure object instead of throwing: the caller is a model tool, and
   * the model needs the reason in its own turn so it can adapt.
   */
  /**
   * Take bots out of a group (§membership).
   *
   * The single entry point for both callers: `remove_bot` from a bot (leader-only, see
   * `groupFlow.remove`) and the UI's `removeRoomMembers`. Authority is enforced HERE as
   * well, never only in the tool — a tool is a convenience wrapper, not a boundary.
   */
  async removeBots(input: {
    roomId: string
    botIds: readonly string[]
    actorId?: string | undefined
    reason?: string | undefined
  }): Promise<{
    ok: boolean
    removed: readonly string[]
    refused: ReadonlyArray<{ botId: string; reason: string }>
    error?: string | undefined
    memberIds?: readonly string[] | undefined
  }> {
    const result = this.groupFlow.remove({
      roomId: input.roomId,
      botIds: input.botIds,
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    })
    if (!result.ok) {
      return { ok: false, removed: [], refused: result.refused, error: result.error }
    }
    // Stop the removed members' work first (runs cancelled, sessions purged). After that the
    // orchestration state is told they are gone: cleanup writes `state.runs` directly, so
    // `settleRun` never sees those runs and the driver would otherwise keep them as
    // "running" for ever — the fan-out never settles and the leader is never woken again.
    await this.maintenance.cleanupRemovedMembers(input.roomId, result.removed, 'removed by request')
    // A removed LEADER was already handed off by `groupFlow.remove` (leadership is written
    // before this call), so `forgetMember` resolves the NEW leader and lets it continue.
    for (const botId of result.removed) this.groupTask?.forgetMember(input.roomId, botId)
    const dissolved = await this.groupFlow.dissolveIfEmpty(input.roomId)
    // A dissolved room has no room-scoped state left; drop the driver's copy so a later
    // room that reuses nothing is not matched by an old board.
    if (dissolved) this.groupTask?.forget(input.roomId)
    const room = dissolved ? undefined : this.getRoom(input.roomId)
    return {
      ok: true,
      removed: result.removed,
      refused: result.refused,
      memberIds: room?.memberIds ?? [],
    }
  }

  async inviteBot(input: {
    roomId: string
    botId: string
    reason?: string | undefined
    roundToken?: string | undefined
  }): Promise<{ ok: boolean; error?: string | undefined; alreadyMember?: boolean | undefined }> {
    const result = await this.groupFlow.invite(input)
    return result.ok
      ? { ok: true, alreadyMember: result.alreadyMember }
      : { ok: false, error: result.error }
  }

  /** The room's background task board (§5.4: no UI, but the record exists). */
  /**
   * The run a (room, bot) pair is currently executing, if any.
   *
   * Used to hang a question row inside the turn that asked it, so the card renders with the
   * bot's work instead of floating at the bottom of the transcript.
   */
  /**
   * Validate and record the files a bot declared with `agent_community_deliver`.
   *
   * Mirrors DSH's `present` rules instead of inventing new ones: relative paths resolve
   * against the bot's own workspace, absolute paths may point outside it, and only an
   * existing regular file passes (a directory or a final symlink is refused). The paths
   * are canonicalised here, before anything is shown, so a card can never point at a
   * path the host would later refuse to open.
   */
  private async deliverBotFiles(input: {
    roomId: string
    botId: string
    files: ReadonlyArray<{ path: string; description?: string | undefined }>
  }): Promise<{ ok: boolean; files?: readonly DeliveredFile[]; error?: string | undefined }> {
    const runId = this.currentRunIdFor(input.roomId, input.botId)
    if (runId === undefined) {
      return { ok: false, error: '现在没有正在进行的回合：交付只能在本回合内声明。' }
    }
    if (input.files.length === 0) return { ok: false, error: '至少声明 1 个文件。' }
    if (input.files.length > this.cfg.deliverMaxFiles) {
      return { ok: false, error: `一次最多交付 ${this.cfg.deliverMaxFiles} 个文件。` }
    }
    const workspace = this.runWorkspaceDir(input.botId)
    const out: DeliveredFile[] = []
    const seen = new Set<string>()
    for (const file of input.files) {
      const raw = file.path.trim()
      if (raw === '') return { ok: false, error: '文件路径不能为空。' }
      const target = isAbsolute(raw) ? resolve(raw) : resolve(workspace, raw)
      let info
      try {
        info = await lstat(target)
      } catch {
        return {
          ok: false,
          error: `无法交付 ${raw}：文件不存在。先创建文件再声明，或检查路径。`,
        }
      }
      if (info.isSymbolicLink()) {
        return { ok: false, error: `无法交付 ${raw}：最终符号链接不是普通文件。` }
      }
      if (!info.isFile()) return { ok: false, error: `无法交付 ${raw}：不是普通文件。` }
      const canonical = await realpath(target).catch(() => target)
      if (seen.has(canonical)) continue
      seen.add(canonical)
      const description = file.description?.trim() ?? ''
      out.push({
        path: canonical,
        name: basename(canonical),
        ...(description === '' ? {} : { description }),
        ...(Number.isFinite(info.size) ? { size: info.size } : {}),
      })
    }
    if (out.length === 0) return { ok: false, error: '没有可交付的文件。' }
    this.ledger.recordDeliverables(input.roomId, runId, out)
    return { ok: true, files: out }
  }

  /**
   * Act on one declared deliverable with the Host desktop: list its OS applications,
   * open it with one, or reveal it in the file manager.
   *
   * Addressed by (room, run, index) like the preview, so the only paths this can reach
   * are the ones a Bot already delivered. The call goes through the Host's own
   * `sessionController` service, which is the same implementation DSH's chat cards use
   * from the browser — it does not depend on the client Remote surface.
   */
  async deliverableFileAction(input: {
    roomId: string
    runId: string
    index: number
    action: 'applications' | 'open' | 'reveal'
    application?: string | undefined
  }): Promise<
    | { ok: true; applications?: Array<{ id: string; name: string; default: boolean; icon: string | null }> }
    | { ok: false; error: string }
  > {
    const rows = this.listLedger(input.roomId, { force: true })
    const row = rows.find(
      (entry): entry is Extract<LedgerEntry, { type: 'deliverable' }> =>
        entry.type === 'deliverable' && entry.runId === input.runId,
    )
    const file = row?.files[Math.trunc(input.index)]
    if (file === undefined) return { ok: false, error: '这个文件已不在交付记录里。' }
    const controller = (this.ctx as unknown as {
      sessionController?: {
        workspacePathApplications(request: { path: string }, signal?: AbortSignal): Promise<Array<{
          id: string; name: string; default: boolean; icon: string | null
        }>>
        openWorkspacePath(request: {
          path: string
          action?: 'reveal'
          application?: string
        }, signal?: AbortSignal): Promise<{ opened: boolean }>
      }
    }).sessionController
    if (controller === undefined) return { ok: false, error: '当前宿主没有可用的桌面打开能力。' }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 20_000)
    try {
      if (input.action === 'applications') {
        const applications = await controller.workspacePathApplications({ path: file.path }, abort.signal)
        return { ok: true, applications }
      }
      const request = input.action === 'reveal'
        ? { path: file.path, action: 'reveal' as const }
        : input.application !== undefined
          ? { path: file.path, application: input.application }
          : { path: file.path }
      await controller.openWorkspacePath(request, abort.signal)
      return { ok: true }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Convert one delivered Office document to PDF for the in-panel preview.
   *
   * The plugin's own page cannot host DSH's right Sidebar (the Sidebar exists only
   * while a Session surface is mounted), so the preview renders inside the panel.
   * Office fidelity comes from the Host's own `office-to-pdf` provider — the same
   * engine DSH's document preview uses — addressed through the delivery record.
   */
  async renderDeliverableDocument(input: {
    roomId: string
    runId: string
    index: number
  }): Promise<{ ok: true; name: string; dataUrl: string } | { ok: false; error: string }> {
    const rows = this.listLedger(input.roomId, { force: true })
    const row = rows.find(
      (entry): entry is Extract<LedgerEntry, { type: 'deliverable' }> =>
        entry.type === 'deliverable' && entry.runId === input.runId,
    )
    const file = row?.files[Math.trunc(input.index)]
    if (file === undefined) return { ok: false, error: '这个文件已不在交付记录里。' }
    const extension = extname(file.path).slice(1).toLowerCase()
    if (!OFFICE_RENDER_EXT.has(extension)) return { ok: false, error: '该类型不支持文档转换。' }
    const provider = (this.ctx as unknown as {
      get?: (name: string) => unknown
      officeToPdf?: unknown
    })
    const office = (provider.get?.('officeToPdf') ?? provider.officeToPdf) as {
      convert(request: {
        source: {
          key: string
          version: string
          bytes?: number
          read(signal: AbortSignal, maxBytes: number): Promise<{ version: string; bytes: Uint8Array }>
        }
        extension: string
        priority: 'foreground'
      }, signal?: AbortSignal): Promise<{ pdf: Uint8Array }>
    } | undefined
    if (office === undefined) return { ok: false, error: '当前宿主没有 Office 转换服务。' }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 60_000)
    try {
      const info = await stat(file.path)
      const version = `${info.size}:${Math.trunc(info.mtimeMs)}`
      const result = await office.convert({
        source: {
          key: file.path,
          version,
          bytes: info.size,
          read: async () => {
            const bytes = await readFile(file.path)
            return { version, bytes }
          },
        },
        extension,
        priority: 'foreground',
      }, abort.signal)
      const pdf = Buffer.from(result.pdf)
      if (pdf.byteLength > PREVIEW_MAX_BYTES * 4) return { ok: false, error: '转换后的 PDF 过大，无法内嵌预览。' }
      return { ok: true, name: file.name, dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}` }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Read one declared deliverable for the panel's preview.
   *
   * Addressed by `(room, run, index)` and never by a client-supplied path: the only
   * files this can read are the ones a bot already declared for the user. Text is
   * paged and capped; images, PDF and the browser-rendered Word/Excel formats are
   * returned as data URLs under a byte cap; everything else reports its metadata so
   * the card can hand it to a native app. Bot session ids never cross this boundary
   * (the ledger's red line).
   */
  async readDeliverablePreview(input: {
    roomId: string
    runId: string
    index: number
    offset?: number | undefined
  }): Promise<
    | { kind: 'text'; name: string; text: string; offset: number; truncated: boolean }
    | { kind: 'data'; name: string; mime: string; dataUrl: string }
    | { kind: 'binary'; name: string; size: number }
    | { kind: 'missing'; name: string }
  > {
    // Through the service's wrapper, not the projector directly: a room whose ledger has
    // not been hydrated yet (created after startup, or the first open after a restart)
    // answers empty otherwise, and the card would report the file as missing.
    const rows = this.listLedger(input.roomId, { force: true })
    const row = rows.find(
      (entry): entry is Extract<LedgerEntry, { type: 'deliverable' }> =>
        entry.type === 'deliverable' && entry.runId === input.runId,
    )
    const index = Math.trunc(input.index)
    const file = row?.files[index]
    if (file === undefined) return { kind: 'missing', name: '' }
    let info
    try {
      info = await stat(file.path)
    } catch {
      return { kind: 'missing', name: file.name }
    }
    if (!info.isFile()) return { kind: 'missing', name: file.name }
    const ext = extname(file.path).toLowerCase()
    if (PREVIEW_IMAGE_MIME[ext] !== undefined) {
      if (info.size > PREVIEW_MAX_BYTES) return { kind: 'binary', name: file.name, size: info.size }
      const bytes = await readFile(file.path)
      const mime = PREVIEW_IMAGE_MIME[ext]!
      return { kind: 'data', name: file.name, mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
    }
    const documentMime = PREVIEW_DOCUMENT_MIME[ext]
    if (documentMime !== undefined) {
      if (info.size > PREVIEW_MAX_BYTES) return { kind: 'binary', name: file.name, size: info.size }
      const bytes = await readFile(file.path)
      return {
        kind: 'data',
        name: file.name,
        mime: documentMime,
        dataUrl: `data:${documentMime};base64,${bytes.toString('base64')}`,
      }
    }
    if (PREVIEW_BINARY_EXT.has(ext)) return { kind: 'binary', name: file.name, size: info.size }
    const text = await readPreviewText(file.path, input.offset ?? 0)
    if (text === undefined) return { kind: 'binary', name: file.name, size: info.size }
    return { kind: 'text', name: file.name, ...text }
  }

  private currentRunIdFor(roomId: string, botId: string): string | undefined {
    for (const run of [...this.state.runs].reverse()) {
      if (run.roomId === roomId && run.botId === botId && (run.status === 'running' || run.status === 'queued')) {
        return run.id
      }
    }
    return undefined
  }

  /** The newest live run for a (room, bot) pair, or undefined when that bot is idle. */
  private liveRunFor(roomId: string, botId: string): BotRun | undefined {
    for (const run of [...this.state.runs].reverse()) {
      if (run.roomId === roomId && run.botId === botId && (run.status === 'running' || run.status === 'queued')) {
        return run
      }
    }
    return undefined
  }

  /**
   * Publish mode of a run, by id.
   *
   * Read from state rather than captured at creation: the executor asks this from inside
   * the run (skipping the row reservation / final-answer write for an internal run), and
   * the flag lives on the run record. An unknown id stays visible — silencing a bot
   * because a record could not be found would be the worse failure.
   */
  private publishOfRunId(runId: string): RunPublish {
    return publishOf(this.state.runs.find(r => r.id === runId))
  }

  /**
   * The ledger as the run executor sees it — with one gate.
   *
   * The projection is not the only writer of a turn's rows: `runs.ts` reserves a live
   * row before the model runs and writes the final answer afterwards, for EVERY run. An
   * internal run must leave no turn behind (that is the duplicate the user saw), and
   * suppressing only the projection would still leave an empty reserved row — which the
   * panel renders as a bot bubble with no answer. Those two writes are therefore dropped
   * for an internal run; everything else delegates untouched, and the one row the run
   * does owe the user (its finish report) is pushed by `settleRun`.
   */
  private executorLedgerView(): LedgerProjector {
    const ledger = this.ledger
    const service = this
    const internal = (runId: string): boolean => service.publishOfRunId(runId) === 'internal'
    return new Proxy(ledger, {
      get(target, property) {
        if (property === 'reserveLiveRow') {
          return (roomId: string, botId: string, botName: string, runId: string): string =>
            internal(runId) ? '' : target.reserveLiveRow(roomId, botId, botName, runId)
        }
        if (property === 'patchRunText') {
          return (
            roomId: string,
            runId: string,
            text: string,
            identity?: { botId: string; botName: string },
          ): void => {
            if (internal(runId)) return
            target.patchRunText(roomId, runId, text, identity)
          }
        }
        if (property === 'patchRunReasoning') {
          return (
            roomId: string,
            runId: string,
            text: string,
            identity: { botId: string; botName: string },
          ): void => {
            if (internal(runId)) return
            target.patchRunReasoning(roomId, runId, text, identity)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value
      },
    }) as unknown as LedgerProjector
  }

  // ── FINISH GATE (OP-02) ────────────────────────────────────────────────────

  /**
   * The room's task board as the gate sees it.
   *
   * `room.taskState` is the PERSISTED board (assignments carry `done` once a member reported),
   * which is exactly what "this task was really delivered" must be checked against — the
   * in-memory driver has its own copy but this one survives a reload.
   */
  private finishGateBoard(roomId: string): ReadonlyArray<{ readonly id: string; readonly status?: string | undefined }> {
    const assignments = this.state.rooms.find(r => r.id === roomId)?.taskState?.assignments ?? []
    return assignments.map(assignment => ({
      id: assignment.id,
      ...(assignment.status !== undefined ? { status: assignment.status } : {}),
    }))
  }

  /** Signature of the current board, so a rejection streak cannot leak into the NEXT task. */
  private finishGateBoardSignature(roomId: string): string {
    return this.finishGateBoard(roomId)
      .map(assignment => `${assignment.id}:${assignment.status ?? ''}`)
      .join('|')
  }

  /**
   * Gate a `finish_task` declaration, then close the task through the driver.
   *
   * THE GATE IS THE AUTHORITY. Evidence is checked by `checkFinishEvidence` (files on the
   * leader's disk, messages in THIS room, assignments reported on THIS board); every failure
   * is returned at once so the model can fix them in one retry. Three consecutive rejections
   * for the same leader+board are the deadlock guard: the third one closes the task with
   * `gate: 'bypassed'` and a visible notice saying it is UNVERIFIED.
   *
   * `workspaceRoot` is the leader's real working directory (`runWorkspaceDir`): a relative
   * evidence path means "the file the bot actually wrote", not a path relative to the server.
   */
  private async gateFinishTask(input: {
    roomId: string
    leaderId: string
    report: string
    evidence: readonly FinishEvidence[]
  }): Promise<{ ok: boolean; reason?: string; bypassed?: boolean }> {
    const driver = this.groupTask
    if (driver === undefined) return { ok: false, reason: '任务驱动未就绪，不能结束任务。' }
    const room = this.state.rooms.find(r => r.id === input.roomId)
    if (room === undefined) return { ok: false, reason: '房间不存在。' }
    const result = await checkFinishEvidence({
      roomId: input.roomId,
      workspaceRoot: this.runWorkspaceDir(input.leaderId),
      evidence: input.evidence,
    }, {
      lookupMessage: (messageId) => {
        const message = this.state.messages.find(candidate => candidate.id === messageId)
        if (message === undefined) return undefined
        return {
          roomId: String(message.roomId),
          ...(message.runId !== undefined ? { runId: String(message.runId) } : {}),
        }
      },
      listAssignments: () => this.finishGateBoard(input.roomId),
    })

    const key = `${input.roomId}\u0000${input.leaderId}`
    if (result.ok) {
      this.finishGateRejections.delete(key)
      await driver.finish({
        roomId: input.roomId,
        report: input.report,
        evidence: input.evidence,
        gate: 'passed',
      })
      // OP-09: a VERIFIED finish is exactly the signal worth learning from. The card is
      // deterministic (no model call) and stored on the room in one state update.
      this.recordGroupPatternCard(input.roomId, input.report, input.evidence, true)
      this.maybeWarnReputation(input.roomId)
      return { ok: true }
    }

    const board = this.finishGateBoardSignature(input.roomId)
    const previous = this.finishGateRejections.get(key)
    const count = previous !== undefined && previous.board === board ? previous.count + 1 : 1
    this.finishGateRejections.set(key, { count, board })
    const reason = result.failures.join('；')
    this.ctx.logger?.warn?.(
      `agent-community: finish gate rejected room=${input.roomId} leader=${input.leaderId} `
      + `(${count}/3 board=${board.slice(0, 80)}): ${reason}`,
    )
    if (count < 3) {
      this.recordNotice(
        input.roomId,
        `完成未通过证据门（第 ${count}/3 次）：${reason}。任务仍未关闭，等 leader 补齐证据。`,
      )
      return { ok: false, reason }
    }
    // DEADLOCK GUARD: after the third refusal, close it anyway and SAY it is unverified.
    this.finishGateRejections.delete(key)
    await driver.finish({
      roomId: input.roomId,
      report: input.report,
      evidence: input.evidence,
      gate: 'bypassed',
    })
    this.recordNotice(
      input.roomId,
      `证据门连续 3 次未通过：本次完成按 bypassed 放行并标记为「未验证」（原因：${reason}）。`,
    )
    // A bypassed finish still carries a report: keep the pattern, the card's `source:'finish'`
    // plus the room's notice above make its unverified status discoverable.
    this.recordGroupPatternCard(input.roomId, input.report, input.evidence, false)
    this.maybeWarnReputation(input.roomId)
    return { ok: true, bypassed: true }
  }

  /**
   * OP-18 reputation watchdog: derive per-bot completion rates from THIS room's board and,
   * when a bot is genuinely below the threshold with enough samples, write one notice.
   * Advisory only — no roster/assignment/run is changed, and the cooldown lives in memory.
   */
  private maybeWarnReputation(roomId: string): void {
    const room = this.state.rooms.find(candidate => candidate.id === roomId)
    if (room === undefined || room.taskState === undefined) return
    try {
      const notice = this.reputationWatchdog.check({
        roomId,
        rooms: [{ taskState: room.taskState }],
        botName: botId => this.state.bots.find(bot => bot.id === botId)?.name ?? botId,
      })
      if (notice !== undefined) this.recordNotice(roomId, notice)
    } catch (error: unknown) {
      this.ctx.logger?.warn?.(`agent-community: reputation watchdog failed for room=${roomId}: ${String(error)}`)
    }
  }

  /**
   * Fold the settle's inputs into the run's evidence record (OP-04).
   *
   * Pure apart from reading the request: the executor supplies counters, this adds what only
   * the service knows — the wall-clock duration up to settle and the REAL finish path (a
   * `finish_task` report is `finish_task`, not just `reply`). A failed run also gets its
   * `faultSide`, which is persisted both on the run and inside the evidence.
   */
  private finalizeRunEvidence(
    run: BotRun,
    input: SettleBotRunRequest,
    failureKind: ReturnType<typeof classifyFailure> | undefined,
    finishReport: string | undefined,
    durationMs: number,
  ): RunEvidence {
    const finishPath = finishPathOf({
      status: input.status,
      ...(input.reply?.text !== undefined ? { replyText: input.reply.text } : {}),
      ...(finishReport !== undefined ? { finishReport } : {}),
      ...(failureKind !== undefined ? { failureKind } : {}),
    })
    const faultSide = input.status === 'failed'
      ? classifyFaultSide({
          ...(failureKind !== undefined ? { failureKind } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          finishPath,
        })
      : input.status === 'interrupted'
        ? 'user'
        : undefined
    return buildRunEvidence({
      ...input.evidence,
      durationMs,
      finishPath,
      ...(faultSide !== undefined ? { faultSide } : {}),
    })
  }

  /** Remember a `finish_task` report until its run settles (see `pendingFinishReports`). */
  private recordFinishReport(roomId: string, leaderId: string, report: string): void {
    if (report.trim() === '') return
    // One entry per run at most; the cap only bounds a leak from a room deleted while a
    // finish was in flight, and dropping the whole map is the honest failure there.
    if (this.pendingFinishReports.size > 200) this.pendingFinishReports.clear()
    const runId = this.currentRunIdFor(roomId, leaderId)
    if (runId !== undefined) {
      this.pendingFinishReports.set(runId, report)
      return
    }
    // No live run: `finish_task` reached the service outside its own turn (an older
    // caller, or a tool run the executor already let go). The leader will settle a run
    // for this room eventually; keep the report addressable by room+leader.
    this.pendingFinishReports.set(`${roomId}\u0000${leaderId}`, report)
  }

  /** Take (and forget) the finish report belonging to one run, if it called finish_task. */
  private takeFinishReport(run: BotRun): string | undefined {
    const direct = this.pendingFinishReports.get(run.id)
    if (direct !== undefined) {
      this.pendingFinishReports.delete(run.id)
      return direct
    }
    const key = `${run.roomId}\u0000${run.botId}`
    const fallback = this.pendingFinishReports.get(key)
    if (fallback !== undefined) this.pendingFinishReports.delete(key)
    return fallback
  }

  /**
   * Make the ledger show exactly one finished delivery row for a run.
   *
   * The row id is derived from the run id (`run:<id>:bot-text`), so a visible run's row
   * already exists — the executor reserves it before the turn — and is finalised here with
   * the delivered body and its duration. An internal run has no row at all (every writer
   * skipped it), so the report it delivered is pushed here. Either way the panel shows one
   * row per run, with the same metadata a reload would rebuild from the message.
   */
  private writeDeliveredRow(run: BotRun, text: string, usage: BotMessageUsage | undefined): void {
    const rowId = this.ledger.botTextRowForRun(run.roomId, run.id)
    const durationMs = runDurationMs(run)
    // The ledger's usage shape is a subset of the message's: `reasoningTokens` and the
    // routes belong to the turn record, not to the answer row.
    const ledgerUsage = usage === undefined
      ? undefined
      : {
          ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          uncachedInputTokens: usage.uncachedInputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
          ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        }
    if (rowId !== undefined) {
      this.ledger.patch(rowId, run.roomId, {
        text,
        streaming: false,
        durationMs,
        ...(ledgerUsage !== undefined ? { usage: ledgerUsage } : {}),
      } as never)
      return
    }
    this.ledger.push({
      type: 'bot-text',
      roomId: run.roomId as never,
      botId: run.botId as never,
      botName: this.state.bots.find(b => b.id === run.botId)?.name ?? run.botId,
      runId: run.id as never,
      text,
      streaming: false,
      durationMs,
      ...(ledgerUsage !== undefined ? { usage: ledgerUsage } : {}),
    } as never)
  }

  /**
   * Test seam: ask a question exactly as the tool does, without a model turn.
   *
   * Kept deliberately on the service (the harness constructs a real service and drives the real
   * bridge) so the flow is asserted end-to-end rather than through a mock.
   */
  /** The user answered (or dismissed) a bot's question. */
  async answerBotQuestion(input: AnswerBotQuestionRequest): Promise<{ ok: boolean }> {
    const bridge = this.questionBridge
    if (bridge === undefined) return { ok: false }
    const ok = input.skip === true
      ? bridge.skip(input.questionId)
      : bridge.answer(input.questionId, input.answer ?? '')
    return { ok }
  }

  /** Reminders this plugin owns (for tests and for the panel's future schedule view). */
  listBotSchedules(): readonly BotSchedule[] {
    return this.state.botSchedules ?? []
  }

  /**
   * Take over host reminders bound to this plugin's sessions.
   *
   * The host cannot deliver them at all — its resolver refuses `origin: "subagent"` sessions —
   * so the row is imported and then DELETED: leaving it would mean the host keeps a reminder it
   * will never deliver, and the user would see a task in 自动化任务 that never fires.
   */
  private async importHostSchedules(): Promise<void> {
    const schedule = optionalService<{
      catalog?(): Promise<HostScheduleRow[]>
      delete?(request: { sessionId: string; id: string }): Promise<unknown>
    }>(this.ctx, 'schedule')
    if (schedule?.catalog === undefined) return
    let rows: HostScheduleRow[]
    try {
      rows = await schedule.catalog()
    } catch {
      return
    }
    if (!Array.isArray(rows) || rows.length === 0) return
    const existing = new Set((this.state.botSchedules ?? []).map(s => s.hostId).filter(Boolean))
    const delivered = new Set(this.state.firedHostIds ?? [])
    // Skip what we already own AND what we already delivered: the second set is what stops the
    // re-import race (see PersistedState.firedHostIds).
    const plan = planImport(rows.filter(row => {
      const id = row.id ?? row.record?.id ?? ''
      return id !== '' && !existing.has(id) && !delivered.has(id)
    }))
    if (plan.schedules.length === 0) return
    // NOTE: the host row is deliberately NOT deleted here — 自动化任务 lists exactly those rows,
    // and removing them at import time is what made a working reminder invisible in that page.
    this.state = { ...this.state, botSchedules: [...(this.state.botSchedules ?? []), ...plan.schedules] }
    this.enqueueWrite()
    const names = plan.schedules.map(s => `${s.title}（${new Date(s.dueAt).toLocaleTimeString()}）`).join('、')
    this.ledger.push({
      type: 'dispatch',
      roomId: plan.schedules[0]!.roomId,
      text: `已接管 ${plan.schedules.length} 个定时任务（仍会显示在自动化任务里）：${names}`,
      at: nowIso(),
    })
    this.ctx.logger?.info?.(`agent-community: took over ${plan.schedules.length} host reminder(s)`)
    if (plan.calendarOnly.length > 0) {
      this.ctx.logger?.warn?.(
        `agent-community: calendar reminders imported as a single occurrence (daily/weekly/cron not re-derived): ${plan.calendarOnly.join(', ')}`,
      )
    }
  }

  /**
   * Fire every reminder whose time has come, through the plugin's own run pipeline.
   *
   * The run goes into the ROOM, which is what a reminder like "send 你好 in the room" wants: the
   * bot's turn happens where the user can see it, instead of inside a hidden session.
   */
  private fireBotSchedules(): void {
    const all = this.state.botSchedules ?? []
    if (all.length === 0) return
    const due = dueSchedules(all)
    if (due.length === 0) return
    const fired = new Set(due.map(s => s.id))
    const next: BotSchedule[] = []
    for (const schedule of all) {
      if (!fired.has(schedule.id)) { next.push(schedule); continue }
      const advanced = advanceSchedule(schedule)
      if (advanced !== undefined) next.push(advanced)
    }
    const tombstones = [
      ...(this.state.firedHostIds ?? []),
      ...due.map(s => s.hostId).filter((id): id is string => id !== undefined),
    ].slice(-200)
    this.state = { ...this.state, botSchedules: next, firedHostIds: tombstones }
    this.enqueueWrite()
    for (const schedule of due) {
      const advanced = advanceSchedule(schedule)
      const room = this.state.rooms.find(r => r.id === schedule.roomId)
      const bot = this.state.bots.find(b => b.id === schedule.botId)
      if (room === undefined || bot === undefined) continue  // room or bot deleted: drop it
      this.ledger.push({
        type: 'dispatch',
        roomId: schedule.roomId,
        text: advanced === undefined
          ? `定时任务触发（已完成）：${schedule.title}`
          : `定时任务触发（下次 ${new Date(advanced.dueAt).toLocaleTimeString()}）：${schedule.title}`,
        at: nowIso(),
      })
      this.queueRoomRun(schedule.roomId, schedule.botId, schedule.prompt, 'routine')
      void this.settleHostRow(schedule, advanced)
    }
  }

  /**
   * Settle the host row once this plugin has delivered the reminder.
   *
   * The host delivered nothing, so it cannot record a receipt: a finished one-shot would sit in
   * 自动化任务 as a permanently "active" reminder that never fires again, so it is removed. A
   * recurring reminder is re-timed to its next occurrence instead, which keeps it visible in that
   * page with a correct upcoming time — and the host's own delivery attempt for the old instant
   * simply fails and is forgotten (it does not retry refused admissions).
   */
  private async settleHostRow(schedule: BotSchedule, next: BotSchedule | undefined): Promise<void> {
    if (schedule.hostId === undefined) return
    const schedule_ = optionalService<{
      delete?(request: { sessionId: string; id: string }): Promise<unknown>
      update?(request: unknown): Promise<unknown>
    }>(this.ctx, 'schedule')
    if (schedule_ === undefined) return
    // EXACT binding, never a recomputed id: see BotSchedule.hostSessionId.
    const request = {
      sessionId: schedule.hostSessionId ?? this.sessionIdFor(schedule.roomId, schedule.botId),
      id: schedule.hostId,
    }
    try {
      if (next === undefined) {
        await schedule_.delete?.(request)
        return
      }
      if (schedule_.update === undefined) return
      await schedule_.update({
        ...request,
        expected: { id: schedule.hostId, kind: 'every', everySeconds: next.everySeconds ?? 0, scheduledAt: schedule.dueAt },
        change: { kind: 'every', every_seconds: next.everySeconds ?? 0 },
      })
    } catch {
      // Best-effort: the reminder already fired in the room, which is what matters.
    }
  }

  /**
   * Unread bot messages per room, derived from each room's read water mark.
   *
   * `roomReadAt[room]` is the highest message sequence the user has seen; everything ABOVE it that a
   * bot sent (or another bot relayed — anything that is not the user's own line) is unread. Messages,
   * not ledger rows: the room's own list is what the number has to agree with, and it counts a native
   * run's answer and a tool-posted message exactly once each.
   */
  private unreadByRoom(): Record<string, number> {
    return unreadByRoom(this.state.messages, this.state.roomReadAt ?? {})
  }

  /**
   * Unread totals for the plugin's sidebar entry — ONE tiny read, no messages attached.
   *
   * The entry badge is visible on every DSH screen, but the panel that computed it only exists while
   * the plugin is the foreground panel. Updating it from the panel's own snapshot poll therefore
   * stopped the moment the user switched to another panel: a reply that finished while they were
   * elsewhere left the old number on screen. A background poller calls THIS instead, so the count
   * tracks reality regardless of what is on screen.
   */
  unreadTotals(): { readonly total: number; readonly rooms: Readonly<Record<string, number>> } {
    const rooms = this.unreadByRoom()
    return { total: totalUnread(rooms), rooms }
  }

  /**
   * What one Bot remembers about ONE room.
   *
   * THE ONLY READ PATH, and it takes the pair on purpose: no caller can obtain "everything this
   * bot remembers" and therefore cannot mix a 1:1 task into a group (or one group into another).
   * The prompt builder is the only consumer.
   */
  botMemoryFor(roomId: string, botId: string): readonly BotMemoryEntry[] {
    // The mirror, not the disk: this runs inside a turn and must be synchronous. It is a cache
    // of the files, refreshed on every write and loaded at startup.
    return this.memoryMirror.get(memoryKey(roomId, botId)) ?? []
  }


  /**
   * Record one deliberate note for the calling Bot, in the room its SESSION belongs to.
   *
   * The room is derived from the session id and is not a parameter: a model that passes someone
   * else's room id must not be able to write there, and taking the room from the session is what
   * makes that impossible rather than merely refused. Same rule as the read path, from the other
   * side.
   */
  async rememberForSession(input: { readonly sessionId: string; readonly text: string }): Promise<{
    readonly ok: boolean
    readonly reason?: string | undefined
  }> {
    const owner = SessionRunner.parseSessionId(input.sessionId)
    if (owner === undefined) {
      return { ok: false, reason: '只有插件自己创建的 Bot 会话才能写记忆。' }
    }
    const text = input.text.trim()
    if (text === '') return { ok: false, reason: '要记住的内容不能为空。' }
    const now = nowIso()
    const meta = this.memoryMetaFor(owner.roomId, owner.botId)
    if (meta === undefined) return { ok: false, reason: '房间或 Bot 不存在。' }
    const result = await this.memoryWrite({
      meta,
      // An explicit note is not subject to the automatic-task cap being 0: the bot asked for it.
      maxEntries: Math.max(1, this.cfg.memoryEntriesPerRoom),
      // OP-08: a note is the bot's own account — active (injectable, the user can delete it) but
      // never promotable, because self-report is not run-backed evidence.
      entry: { id: randomUUID(), kind: 'note', text, at: now, ...entryMetaForNote() },
    })
    // `ok: true` must mean the file is really there — writing and reporting success regardless
    // is how a bot ends up confidently "remembering" something that was never stored.
    return result.stored
      ? { ok: true }
      : { ok: false, reason: `写记忆失败：${result.error ?? '未知错误'}` }
  }

  /**
   * The panel has this room on screen: everything in it is read.
   *
   * Recorded as the room's newest message sequence, so a message that arrives later is unread again
   * while nothing already displayed can become unread retroactively.
   */
  async markRoomRead(input: MarkRoomReadRequest): Promise<{ readonly roomId: string; readonly cleared: boolean }> {
    const readAt = this.state.roomReadAt ?? {}
    // The whole decision — including the two refusals that used to be wrong or missing — lives in
    // `decideReadMark` so it can be tested without a Cordis runtime. `write: false` means NOTHING
    // changed, and the caller must not paint it as a successful clear: the panel used to delete the
    // room's unread entry for every answer it got, which is what made the badge blink.
    const decision = decideReadMark({
      messages: this.state.messages,
      roomId: input.roomId,
      ...(input.upToId !== undefined ? { upToId: input.upToId } : {}),
      stored: readAt[input.roomId],
    })
    if (!decision.write) return { roomId: input.roomId, cleared: false }
    this.state = { ...this.state, roomReadAt: { ...readAt, [input.roomId]: decision.mark } }
    this.enqueueWrite()
    return { roomId: input.roomId, cleared: true }
  }

  // ── The room's goal and the leader's hand-offs (§4.2 / §4.1) ────────────────

  /**
   * This room's goal, or undefined.
   *
   * The ONLY read path, keyed by the room it is given: there is no "all goals" accessor, so no
   * caller can mix two rooms' objectives — the same structural rule the memory partitions use.
   */
  roomGoal(roomId: string): RoomGoal | undefined {
    return this.state.rooms.find(r => r.id === roomId)?.goal
  }

  /** The `[本房间目标]` block for a turn, or undefined when the room has no goal. */
  roomGoalBlock(roomId: string): string | undefined {
    const room = this.state.rooms.find(r => r.id === roomId)
    if (room === undefined) return undefined
    return goalPromptBlock(room.goal, room.name)
  }

  /**
   * The `[本房间必须遵守的硬性约束]` block for a turn, or undefined when nothing is pinned.
   *
   * OP-03. These are the user's own hard rules, extracted verbatim when a compaction folded the
   * messages they were stated in. Rendering them into EVERY turn's prompt (rather than only
   * inside the summary row, which ages out of the window) is what makes "压缩不丢约束" true at
   * the prompt level. Room-keyed like the goal/memory accessors: a rule pinned in one room can
   * never be rendered for another.
   */
  roomConstraintsBlock(roomId: string): string | undefined {
    const room = this.state.rooms.find(r => r.id === roomId)
    if (room === undefined) return undefined
    return roomConstraintsText(room.pinnedConstraints)
  }

  /**
   * The `[本群经验卡]` block for a room (OP-09).
   *
   * Built from the deterministic pattern cards this room accumulated on previous finishes.
   * Returns undefined when the room has none, so an unused group pays zero prompt cost.
   */
  roomPatternsBlock(roomId: string): string | undefined {
    const room = this.state.rooms.find(r => r.id === roomId)
    if (room === undefined) return undefined
    // ONE editable card wins over the legacy per-pattern list. An EXPLICIT empty user card
    // suppresses the fallback too, so clearing the textarea really removes the block.
    if (room.experienceCard !== undefined) return renderExperienceBlock(room.experienceCard.text)
    return renderGroupPatternsBlock(room.patternCards)
  }

  /**
   * Learn a pattern card from a finished task (OP-09).
   *
   * The task comes from the room's board objective, falling back to the newest user message —
   * i.e. what the user actually asked for, not a bot's paraphrase. `report` supplies the
   * approach/pitfalls and the finish evidence supplies references. One `patchRoom` = one state
   * update (and one coalesced write).
   */
  private recordGroupPatternCard(roomId: string, report: string, evidence: readonly FinishEvidence[], verified: boolean): void {
    const room = this.state.rooms.find(r => r.id === roomId)
    if (room === undefined) return
    const task = this.patternTaskText(room)
    if (task === undefined) return
    const evidenceRefs = evidence.map(item => (
      item.kind === 'file' ? item.path : item.kind === 'message' ? item.messageId : item.taskId
    ))
    const card = buildGroupPatternCard({
      task,
      report,
      ...(evidenceRefs.length > 0 ? { evidence: evidenceRefs } : {}),
      now: nowIso(),
      status: verified ? 'active' : 'pending',
    })
    this.patchRoom(roomId, current => {
      const patternCards = mergeGroupPatterns(current.patternCards, card)
      // Auto-seed the ONE experience card from active patterns until the user takes it over.
      const autoText = composeExperienceText(patternCards)
      const experienceCard = current.experienceCard?.source === 'user' || autoText === undefined
        ? current.experienceCard
        : { text: autoText, updatedAt: nowIso(), source: 'auto' as const }
      return {
        ...current,
        patternCards,
        ...(experienceCard !== undefined ? { experienceCard } : {}),
      }
    })
  }

  /** Remove one learned experience card from a room (user management; no prompt side effects beyond). */
  async deleteRoomPattern(input: RoomPatternRequest): Promise<{ ok: boolean; reason?: string }> {
    const room = this.state.rooms.find(r => r.id === input.roomId)
    if (room === undefined) return { ok: false, reason: '房间不存在。' }
    const cards = room.patternCards ?? []
    if (!cards.some(card => card.id === input.patternId)) return { ok: false, reason: '经验卡不存在。' }
    this.patchRoom(input.roomId, current => ({
      ...current,
      patternCards: (current.patternCards ?? []).filter(card => card.id !== input.patternId),
    }))
    return { ok: true }
  }

  /** Confirm a pending card (from a bypassed finish) so it may enter the prompt. */
  async confirmRoomPattern(input: RoomPatternRequest): Promise<{ ok: boolean; reason?: string }> {
    const room = this.state.rooms.find(r => r.id === input.roomId)
    if (room === undefined) return { ok: false, reason: '房间不存在。' }
    const cards = room.patternCards ?? []
    if (!cards.some(card => card.id === input.patternId)) return { ok: false, reason: '经验卡不存在。' }
    this.patchRoom(input.roomId, current => ({
      ...current,
      patternCards: (current.patternCards ?? []).map(card => card.id === input.patternId
        ? { ...card, status: 'active' as const }
        : card),
    }))
    return { ok: true }
  }

  /**
   * Save the room's ONE editable experience card. Manual text wins over auto-generation; an
   * empty string is a deliberate clear (and suppresses the legacy fallback).
   */
  async updateRoomExperience(input: UpdateRoomExperienceRequest): Promise<{ ok: boolean; reason?: string }> {
    const room = this.state.rooms.find(r => r.id === input.roomId)
    if (room === undefined) return { ok: false, reason: '房间不存在。' }
    const points = [...input.text.replace(/\r\n?/gu, '\n').trim()]
    const text = points.length <= 3000 ? points.join('') : `${points.slice(0, 2999).join('')}…`
    this.patchRoom(input.roomId, current => ({
      ...current,
      experienceCard: { text, updatedAt: nowIso(), source: 'user' },
    }))
    return { ok: true }
  }

  /** What this room was asked to do: the board objective, else the newest user message. */
  private patternTaskText(room: BotRoom): string | undefined {
    const objective = room.taskState?.objective?.trim()
    if (objective !== undefined && objective !== '') return objective
    let newest: BotMessage | undefined
    for (const message of this.state.messages) {
      if (message.roomId !== room.id || message.sender.kind !== 'user') continue
      if (newest === undefined || message.createdAt >= newest.createdAt) newest = message
    }
    const text = newest?.text.trim()
    return text !== undefined && text !== '' ? text : undefined
  }

  /**
   * Warn ONCE per room per window when a completed answer looks off-goal (OP-13).
   *
   * Advisory only: writes a visible notice and nothing else. It never pauses the goal, cancels
   * a run or spends a round — the user (or a later, authorized round) decides what to do.
   */
  private maybeWarnGoalDrift(room: BotRoom, status: string, replyText: string): void {
    if (status !== 'completed') return
    const goal = room.goal
    if (goal === undefined || goal.status !== 'active' || room.paused === true) return
    const now = Date.now()
    const last = this.goalDriftWarnedAt.get(room.id) ?? 0
    if (now - last < GOAL_DRIFT_NOTICE_INTERVAL_MS) return
    const userTexts = this.state.messages
      .filter(message => message.roomId === room.id && message.sender.kind === 'user')
      .map(message => message.text)
      .slice(-5)
    const assessment = assessGoalDrift({
      goalText: goal.text,
      userTexts,
      replyText,
    })
    if (assessment.level === 'none') return
    this.goalDriftWarnedAt.set(room.id, now)
    this.recordNotice(room.id, `目标可能偏移：${assessment.reason}（仅提醒，不自动暂停）`)
  }

  /**
   * In-session failure diagnosis: ONE plain grey line in the room that explains a failure.
   *
   * This replaced the settings-page run-diagnostics panel: the reason is useful exactly where
   * the failure is visible. The line is built by the pure `diagnoseRunFailure` (cause + short
   * error detail + largest context section) and deliberately contains none of the words the UI
   * uses for its coloured, actionable rows (建议复盘/审计/目标可能偏移/bypass).
   *
   * Deduplicated per run id (settles can be observed twice), and nothing else: no retry, no
   * pause, no task changes.
   */
  private maybeDiagnoseRun(run: BotRun): void {
    // Internal coordination turns may legitimately finish with no user-facing text; do not
    // turn that into a grey diagnosis line in the room.
    if (run.publish === 'internal' && run.evidence?.finishPath === 'empty') return
    const runId = String(run.id)
    if (this.diagnosedRunIds.has(runId)) return
    const diagnosis = diagnoseRunFailure({
      status: run.status,
      ...(run.faultSide !== undefined ? { faultSide: run.faultSide } : {}),
      ...(run.failureKind !== undefined ? { failureKind: run.failureKind } : {}),
      ...(run.error !== undefined ? { error: run.error } : {}),
      ...(run.evidence?.finishPath !== undefined ? { finishPath: run.evidence.finishPath } : {}),
      ...(run.evidence?.contextSections !== undefined ? { contextSections: run.evidence.contextSections } : {}),
    })
    if (diagnosis === undefined) return
    this.diagnosedRunIds.add(runId)
    if (this.diagnosedRunIds.size > DIAGNOSED_RUN_IDS_MAX) {
      const oldest = this.diagnosedRunIds.values().next().value
      if (oldest !== undefined) this.diagnosedRunIds.delete(oldest)
    }
    this.recordNotice(run.roomId, diagnosis.text)
  }

  /**
   * Create, edit, pause, resume or finish THIS room's goal.
   *
   * Authority has TWO layers, and the second one is the fix for "the bot started working
   * without me":
   *
   *   · WHO MAY TOUCH THE OBJECTIVE — decided here, as before: in a group only the leader (or
   *     the user); in a 1:1 the room's bot may. The room comes from the calling session, so a
   *     model cannot name another room's goal.
   *   · WHO MAY MAKE IT RUN BY ITSELF — the USER only. A bot's `set`/`resume` becomes
   *     `status:'proposed'` (a suggestion, inert until authorized); it can only refresh the
   *     text of a goal that is already active under a live user grant, preserving that grant
   *     and its spent rounds. `pause`/`done` stay allowed.
   */
  async setRoomGoal(input: {
    readonly roomId: string
    readonly text?: string | undefined
    readonly status?: 'active' | 'paused' | 'done' | undefined
    /** Which tool action this is, for a Bot caller; the legacy status-only call defaults to 'set'. */
    readonly action?: BotGoalAction | undefined
    readonly actorSessionId?: string | undefined
    readonly maxRounds?: number | undefined
  }): Promise<{ readonly ok: boolean; readonly goal?: RoomGoal | undefined; readonly reason?: string | undefined }> {
    const room = this.state.rooms.find(r => r.id === input.roomId)
    if (room === undefined) return { ok: false, reason: '房间不存在。' }
    const actor = this.goalActor(input.actorSessionId)
    const leaderId = this.leaderOfRoom(input.roomId)
    if (!canEditGoal(actor, leaderId)) {
      return { ok: false, reason: '只有 leader（或用户本人）可以修改本房间的目标。' }
    }
    const previous = room.goal
    const now = nowIso()

    if (actor.kind === 'user') {
      const status = input.status ?? 'active'
      const change = applyUserGoalChange(previous, {
        status,
        now,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
      })
      if (change === undefined) {
        return {
          ok: false,
          reason: status === 'active' ? '目标内容不能为空。' : '本房间还没有目标。',
        }
      }
      this.patchRoom(input.roomId, r => ({ ...r, goal: change.goal }))
      this.recordNotice(
        input.roomId,
        change.outcome === 'active'
          ? `目标已设定，并授权自动续跑：最多 ${change.goal.authorization?.maxRounds ?? DEFAULT_GOAL_MAX_ROUNDS} 轮。`
          : change.outcome === 'paused' ? '目标已暂停。' : '目标已完成。',
      )
      return { ok: true, goal: change.goal }
    }

    // ── A BOT: propose, refresh progress, pause or finish — never grant continuation ──
    const action: BotGoalAction = input.action
      ?? (input.status === 'paused' ? 'pause' : input.status === 'done' ? 'done' : 'set')
    const change = applyBotGoalChange(previous, {
      action,
      now,
      botId: brandId<BotId>(actor.botId),
      ...(input.text !== undefined ? { text: input.text } : {}),
    })
    if (change === undefined) {
      return {
        ok: false,
        reason: previous === undefined
          ? '本房间还没有目标：action=set 时请给出 text。'
          : '目标内容不能为空。',
      }
    }
    this.patchRoom(input.roomId, r => ({ ...r, goal: change.goal }))
    if (change.outcome === 'proposed') {
      this.recordNotice(
        input.roomId,
        `目标已提交，等待用户在面板确认（确认前不会自动续跑）：${change.goal.text.slice(0, 120)}`,
      )
    } else if (change.outcome === 'paused') {
      this.recordNotice(input.roomId, '目标已暂停。')
    } else if (change.outcome === 'done') {
      this.recordNotice(input.roomId, '目标已完成。')
    }
    // outcome 'active' = a progress-text refresh of an ALREADY authorized goal: no notice, or
    // every automatic round would add a grey row saying nothing new.
    return { ok: true, goal: change.goal }
  }

  /**
   * Start the FIRST authorized round, or explain why it is not starting yet.
   *
   * A grant would otherwise be useless until something else settled: a bot proposes a goal
   * near the end of its turn, the turn settles (nothing to continue), and the goal the user
   * just authorized would sit active-but-idle until the user typed again. Authorizing is the
   * user's explicit "go", so the grant itself kicks off round 1.
   *
   * THREE CASES, and only one of them queues:
   *   · a live run in the room → authorize only. That run's settle continues the goal through
   *     `afterRunSettled`; queueing now would race its bookkeeping and could duplicate work.
   *   · the room is paused → queueRoomRun refuses every source (returns undefined): authorize,
   *     spend nothing, and say so.
   *   · otherwise → queue round 1 now and count it HERE. `afterRunSettled` counts only the
   *     rounds it queues itself, so the first round is spent exactly once.
   */
  private startFirstAuthorizedRound(input: {
    readonly roomId: string
    readonly goal: RoomGoal
    /** Notice wording only: 授权 (grant) vs 继续 (resume). */
    readonly verb: '授权' | '继续'
  }): { readonly goal: RoomGoal; readonly notice: string; readonly started: boolean } {
    const total = input.goal.authorization?.maxRounds ?? DEFAULT_GOAL_MAX_ROUNDS
    const short = `${input.goal.text.slice(0, 80)}${input.goal.text.length > 80 ? '…' : ''}`
    const head = `目标已${input.verb}`

    const room = this.state.rooms.find(r => r.id === input.roomId)
    const leader = room === undefined
      ? undefined
      : (room.directBotId !== undefined ? room.directBotId : this.leaderOfRoom(input.roomId))
    // PAUSED FIRST: a paused room may still hold a live run (paused mid-turn), and promising
    // "it will continue when that run ends" would be false — `afterRunSettled` refuses auto
    // work in a paused room. The grant stands; nothing starts until the room is unpaused.
    if (room?.paused === true) {
      return {
        goal: input.goal,
        notice: `${head}，但房间当前处于暂停：不会起跑；取消暂停后在房间里发一条消息，就能开始自动续跑。`,
        started: false,
      }
    }
    if (this.liveRunIn(input.roomId)) {
      return {
        goal: input.goal,
        notice: `${head}：当前有任务在运行，它结束后会自动续跑（最多 ${total} 轮）。`,
        started: false,
      }
    }
    if (leader === undefined) {
      return { goal: input.goal, notice: `${head}：本房间没有可执行的 Bot，自动续跑不会起跑。`, started: false }
    }
    const queued = this.queueRoomRun(
      input.roomId,
      leader,
      `[继续目标] ${input.goal.text}\n`
      + '用户已授权你推进这个目标（在授权轮次内）；已经完成就直接说明完成并收尾，不要为了继续而继续。',
      'routine',
    )
    if (queued === undefined) {
      // Defensive: `queueRoomRun` refused (its paused guard is the only refusal here).
      return {
        goal: input.goal,
        notice: `${head}，但房间当前处于暂停：不会起跑；取消暂停后在房间里发一条消息，就能开始自动续跑。`,
        started: false,
      }
    }
    const used = (input.goal.authorization?.roundsUsed ?? 0) + 1
    const goal: RoomGoal = {
      ...input.goal,
      authorization: input.goal.authorization === undefined
        ? undefined
        : { ...input.goal.authorization, roundsUsed: used },
      // Legacy mirror: the loop counter older readers watched.
      continuations: used,
      stalledRounds: 0,
      updatedAt: nowIso(),
    }
    return { goal, notice: `${head}，自动续跑 ${used}/${total}：${short}（可在面板暂停）`, started: true }
  }

  /**
   * USER-ONLY: grant automatic continuation for this room's goal.
   *
   * Carries no `actorSessionId` at all, which is what keeps a Bot out: the panel is the only
   * caller. This is the one act that turns a Bot's proposed goal (or a paused one) into work
   * the plugin may continue without a new user message — and it starts round 1 immediately
   * (see `startFirstAuthorizedRound`).
   */
  async authorizeRoomGoal(input: {
    readonly roomId: string
    readonly maxRounds?: number | undefined
  }): Promise<{ readonly ok: boolean; readonly goal?: RoomGoal | undefined; readonly reason?: string | undefined }> {
    const room = this.state.rooms.find(r => r.id === input.roomId)
    if (room === undefined) return { ok: false, reason: '房间不存在。' }
    if (room.goal === undefined) return { ok: false, reason: '本房间还没有目标，先设定目标再授权。' }
    const authorized = authorizeGoal(room.goal, {
      now: nowIso(),
      ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
    })
    this.patchRoom(input.roomId, r => ({ ...r, goal: authorized }))
    const started = this.startFirstAuthorizedRound({ roomId: input.roomId, goal: authorized, verb: '授权' })
    if (started.goal !== authorized) this.patchRoom(input.roomId, r => ({ ...r, goal: started.goal }))
    this.recordNotice(input.roomId, started.notice)
    // Nudge only after the counted round is persisted, so the settle side cannot race the write.
    if (started.started) this.executor?.nudge()
    return { ok: true, goal: started.goal }
  }

  /** USER-ONLY: pause this room's goal; no automatic continuation until an explicit resume. */
  async pauseRoomGoal(input: {
    readonly roomId: string
  }): Promise<{ readonly ok: boolean; readonly goal?: RoomGoal | undefined; readonly reason?: string | undefined }> {
    const room = this.state.rooms.find(r => r.id === input.roomId)
    if (room === undefined) return { ok: false, reason: '房间不存在。' }
    if (room.goal === undefined) return { ok: false, reason: '本房间还没有目标。' }
    const goal = pauseGoal(room.goal, nowIso())
    this.patchRoom(input.roomId, r => ({ ...r, goal }))
    this.recordNotice(input.roomId, '目标已暂停：不会自动续跑，等你确认后再继续。')
    return { ok: true, goal }
  }

  /**
   * USER-ONLY: resume a paused goal, starting its next authorized round immediately.
   *
   * A grant with rounds left is kept as-is (resume is not a top-up); a spent/expired grant is
   * replaced with a fresh one, because resuming IS an explicit user authorization. Either way
   * the resumed round is queued now unless the room has live work / is paused (the shared
   * helper owns those cases and the single count of that round).
   */
  async resumeRoomGoal(input: {
    readonly roomId: string
    readonly maxRounds?: number | undefined
  }): Promise<{ readonly ok: boolean; readonly goal?: RoomGoal | undefined; readonly reason?: string | undefined }> {
    const room = this.state.rooms.find(r => r.id === input.roomId)
    if (room === undefined) return { ok: false, reason: '房间不存在。' }
    if (room.goal === undefined) return { ok: false, reason: '本房间还没有目标。' }
    const resumed = resumeGoal(room.goal, {
      now: nowIso(),
      ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
    })
    this.patchRoom(input.roomId, r => ({ ...r, goal: resumed }))
    const started = this.startFirstAuthorizedRound({ roomId: input.roomId, goal: resumed, verb: '继续' })
    if (started.goal !== resumed) this.patchRoom(input.roomId, r => ({ ...r, goal: started.goal }))
    this.recordNotice(input.roomId, started.notice)
    if (started.started) this.executor?.nudge()
    return { ok: true, goal: started.goal }
  }

  /**
   * Queue work for several members and return IMMEDIATELY (§4.1).
   *
   * Nothing waits here: the leader's own answer this turn is the progress report, and the
   * plugin wakes it again through `onMemberFinished` when the members settle. An earlier
   * design blocked the leader's run for up to ten minutes, which raced the run timeout —
   * also ten minutes — and dropped the reports whenever the timeout won.
   */
  dispatchToMembers(input: {
    readonly roomId: string
    readonly actorSessionId?: string | undefined
    readonly tasks: readonly DispatchTask[]
    readonly waitMs?: number | undefined
  }): {
    readonly ok: boolean
    readonly queued: readonly string[]
    readonly refused: ReadonlyArray<{ readonly bot: string; readonly reason: string }>
    readonly reason?: string | undefined
  } {
    const room = this.state.rooms.find(r => r.id === input.roomId)
    if (room === undefined) return { ok: false, queued: [], refused: [], reason: '房间不存在。' }
    const actor = this.goalActor(input.actorSessionId)
    const leaderId = this.leaderOfRoom(input.roomId)
    const plan = planDispatch({
      roomKind: room.directBotId !== undefined ? 'direct' : 'group',
      callerId: actor.kind === 'bot' ? actor.botId : '',
      ...(leaderId !== undefined ? { leaderId } : {}),
      memberIds: room.memberIds,
      roster: room.memberIds
        .map(id => this.state.bots.find(b => b.id === id))
        .filter((b): b is NonNullable<typeof b> => b !== undefined)
        .map(b => ({ id: b.id, name: b.name })),
      tasks: input.tasks,
    })
    if (plan.accepted.length === 0) {
      return { ok: false, queued: [], refused: plan.refused, ...(plan.refusal !== undefined ? { reason: plan.refusal } : {}) }
    }
    const result = this.groupTask?.assignEach({ roomId: input.roomId, tasks: plan.accepted })
      ?? { assigned: [], refused: plan.accepted.map(t => t.botId) }
    this.recordNotice(
      input.roomId,
      `已派工：${result.assigned.length} 位成员（${result.assigned.map(id => this.state.bots.find(b => b.id === id)?.name ?? id).join('、')}），等待回报。`,
    )
    return {
      ok: result.assigned.length > 0,
      queued: result.assigned,
      refused: plan.refused,
      ...(result.assigned.length === 0 ? { reason: '派工失败：成员当前无法运行。' } : {}),
    }
  }

  // ── Memory: the file store, its mirror, and promotion ───────────────────────

  /** The meta a partition file records about itself; undefined when room or bot is gone. */
  private memoryMetaFor(roomId: string, botId: string): RoomMemoryMeta | undefined {
    const room = this.state.rooms.find(r => r.id === roomId)
    const bot = this.state.bots.find(b => b.id === botId)
    if (room === undefined || bot === undefined) return undefined
    return {
      roomId,
      roomName: room.name,
      botId,
      kind: room.directBotId !== undefined ? 'direct' : 'group',
    }
  }

  /**
   * One write, through the store, updating the mirror only when the file really changed.
   *
   * THE MIRROR AFTER THE FILE, never before: a failed write must not leave the prompt believing
   * something was remembered.
   */
  private async memoryWrite(input: {
    readonly meta: RoomMemoryMeta
    readonly entry: BotMemoryEntry
    readonly maxEntries: number
  }): Promise<{ readonly stored: boolean; readonly error?: string | undefined }> {
    const store = this.memoryStore
    if (store === undefined) return { stored: false, error: 'memory store unavailable' }
    const result = await store.append({ ...input, now: input.entry.at })
    if (!result.stored) return { stored: false, ...(result.error !== undefined ? { error: result.error } : {}) }
    const key = memoryKey(input.meta.roomId, input.meta.botId)
    const entries = await store.read(input.meta.roomId, input.meta.botId)
    this.memoryMirror.set(key, [...entries])
    return { stored: true }
  }

  /**
   * Record what a finished turn did, then look for something worth learning (§3.3).
   *
   * OP-08 lifecycle, in order:
   *   1. DECAY what the user has since corrected (same task family, last 3-task window). That is
   *      an IN-PLACE edit of existing entries, so the partition must be REWRITTEN
   *      (`writePartition`), not appended to; the mirror is refreshed from the file afterwards.
   *      A failed rewrite is logged and does not block the new line: the decay is best-effort
   *      maintenance, losing a new memory is worse.
   *   2. APPEND this turn's line, carrying provenance from the run's origin (user-driven runs are
   *      active/positive; peer-woken and timer turns are probation/unknown).
   *   3. PROMOTE, now gated by `promotable` inside the scanner.
   *
   * Promotion runs here — after the task line exists — because both of its channels need the
   * run-backed history this line completes.
   */
  private async rememberTask(run: BotRun, replyText: string): Promise<void> {
    const meta = this.memoryMetaFor(run.roomId, run.botId)
    if (meta === undefined) return
    if (this.cfg.memoryEntriesPerRoom === 0) return
    const now = nowIso()
    // 1. Decay corrected task entries, in place. Only for a pair that already has entries, and
    // only when something actually changed (the pure helper returns `changed`).
    const key = memoryKey(run.roomId, run.botId)
    const current = this.memoryMirror.get(key) ?? []
    if (current.length > 0 && this.memoryStore !== undefined) {
      const decayed = decayForCorrections(
        current,
        this.state.messages.filter(m => m.roomId === run.roomId),
        now,
      )
      if (decayed.changed > 0) {
        try {
          await this.memoryStore.writePartition(meta, decayed.entries)
          const reread = await this.memoryStore.read(run.roomId, run.botId)
          this.memoryMirror.set(key, [...reread])
        } catch (error: unknown) {
          this.ctx.logger?.warn?.(
            `agent-community: could not persist decayed memory for room=${run.roomId} bot=${run.botId}: ${String(error)}`,
          )
        }
      }
    }
    // 2. Append this turn's line with its provenance metadata.
    const written = await this.memoryWrite({
      meta,
      maxEntries: this.cfg.memoryEntriesPerRoom,
      entry: {
        id: randomUUID(),
        kind: 'task',
        text: taskMemoryText(run.prompt, replyText),
        at: now,
        runId: String(run.id),
        ...entryMetaForRun(String(run.origin ?? '')),
      },
    })
    if (!written.stored) {
      this.ctx.logger?.warn?.(`agent-community: memory write failed for room=${run.roomId} bot=${run.botId}: ${written.error ?? 'unknown'}`)
      return
    }
    await this.promoteIfEarned(run.roomId, run.botId)
  }

  /**
   * Move what this pair has LEARNED into the bot's own instruction file.
   *
   * Only run-backed candidates get here (the scanner decides), and the block is inside a file
   * the user owns: everything outside the markers is preserved, human-edited lines are never
   * rewritten, and an identical line is never added twice.
   */
  private async promoteIfEarned(roomId: string, botId: string): Promise<void> {
    const store = this.memoryStore
    const bot = this.state.bots.find(b => b.id === botId)
    if (store === undefined || bot === undefined) return
    const workspace = bot.workspace !== undefined && bot.workspace !== ''
      ? bot.workspace
      : await this.defaultBotWorkspace()
    const learned = await store.readLearned(workspace)
    const candidates = scanPromotions({
      entries: this.botMemoryFor(roomId, botId),
      messages: this.state.messages.filter(m => m.roomId === roomId),
      alreadyLearned: learned.lines,
    })
    if (candidates.length === 0) return
    const result = await store.appendLearned(workspace, candidates.map(c => c.line))
    if (!result.stored) {
      this.ctx.logger?.warn?.(`agent-community: could not write the learned block for bot ${botId}`)
      return
    }
    if (result.added.length > 0) {
      this.ctx.logger?.info?.(
        `agent-community: promoted ${result.added.length} learned line(s) for bot ${botId} into ${result.path}`,
      )
    }
  }

  /**
   * Startup: load the mirror, and migrate a board that still carries the old inline field.
   *
   * The migration is idempotent: it writes files only for entries the store does not already
   * have, then clears the field, so a crash halfway through leaves a board that migrates again
   * on the next boot instead of losing the entries.
   */
  private async loadMemory(): Promise<void> {
    const store = this.memoryStore
    if (store === undefined) return
    for (const room of this.state.rooms) {
      for (const botId of room.memberIds) {
        const entries = await store.read(room.id, botId)
        if (entries.length > 0) this.memoryMirror.set(memoryKey(room.id, botId), [...entries])
      }
    }
    const legacy = this.state.botMemories ?? []
    if (legacy.length === 0) return
    let migrated = 0
    for (const record of legacy) {
      const meta = this.memoryMetaFor(record.roomId, record.botId)
      if (meta === undefined) continue
      const existing = this.memoryMirror.get(memoryKey(record.roomId, record.botId)) ?? []
      if (existing.length > 0) continue
      await store.writePartition(meta, record.entries)
      this.memoryMirror.set(memoryKey(record.roomId, record.botId), [...record.entries])
      migrated += record.entries.length
    }
    this.state = { ...this.state, botMemories: [] }
    this.enqueueWrite()
    if (migrated > 0) {
      this.ctx.logger?.info?.(`agent-community: migrated ${migrated} memor(ies) from the board into memory files`)
    }
  }

  /**
   * Archive a room's memory instead of deleting it (the room is gone, the knowledge is not).
   *
   * Called BEFORE the room record disappears, because the member list is what says whose
   * partitions to move.
   */
  private async archiveRoomMemory(roomId: string, botIds: readonly string[]): Promise<void> {
    const store = this.memoryStore
    if (store === undefined) return
    const moved = await store.archiveRoom(roomId, botIds)
    // The archived files are no longer live partitions: drop every mirror row for this room.
    for (const key of [...this.memoryMirror.keys()]) {
      if (key.startsWith(`${roomId}\u0000`)) this.memoryMirror.delete(key)
    }
    for (const botId of botIds) await store.rebuildIndex(botId)
    if (moved.length > 0) {
      this.ctx.logger?.info?.(`agent-community: archived ${moved.length} room memor(ies) for room ${roomId}`)
    }
  }

  /**
   * Archive a bot's GROUP partitions before it is deleted.
   *
   * The user's rule for deleting a bot is "erase it from the device", with one exception: what
   * it wrote inside a group belongs to that group. Those files move to `_archive/<roomId>/`,
   * which is OUTSIDE the bot's directory — so the deletion that follows cannot take them with
   * it. Direct-chat partitions are not archived: a DM is the bot's own memory.
   */
  private async archiveBotGroupMemory(botId: string): Promise<void> {
    const store = this.memoryStore
    if (store === undefined) return
    const groupRooms = this.state.rooms.filter(r => r.directBotId === undefined && r.memberIds.includes(brandId<BotId>(botId)))
    for (const room of groupRooms) {
      await store.archiveRoom(room.id, [botId])
    }
    if (groupRooms.length > 0) {
      this.ctx.logger?.info?.(
        `agent-community: archived group memor(ies) of bot ${botId} from ${groupRooms.length} room(s) before deletion`,
      )
    }
  }


  /** The bot's own workspace, used when a bot record has none. */
  private async defaultBotWorkspace(): Promise<string> {
    return join(this.home, 'agent-community', 'workspaces')
  }

  /**
   * Search THIS room's memory (and the bot's learned lines) for entries matching a query.
   *
   * The result carries PROVENANCE — file, timestamp, run id — because the whole point of the
   * feature is that the model can go back to what actually happened instead of trusting a
   * summary. Scoped to the caller's own room, like every other memory read.
   */
  async recallMemory(input: {
    readonly roomId: string
    readonly botId: string
    readonly query: string
    readonly limit?: number | undefined
  }): Promise<{
    readonly hits: ReadonlyArray<{ readonly text: string; readonly at: string; readonly runId?: string | undefined }>
    readonly learned: readonly string[]
    readonly path: string
  }> {
    const store = this.memoryStore
    const entries = this.botMemoryFor(input.roomId, input.botId)
    const hits = store === undefined
      ? []
      : searchMemory(entries, input.query, input.limit ?? 5).map(row => ({
        text: row.entry.text,
        at: row.entry.at,
        ...(row.entry.runId !== undefined ? { runId: row.entry.runId } : {}),
      }))
    const bot = this.state.bots.find(b => b.id === input.botId)
    const workspace = bot?.workspace ?? await this.defaultBotWorkspace()
    const learned = store === undefined ? [] : (await store.readLearned(workspace)).lines
    const needle = input.query.trim().toLowerCase()
    return {
      hits,
      learned: needle === '' ? learned.slice(-5) : learned.filter(l => l.toLowerCase().includes(needle)).slice(0, 5),
      path: memoryPaths(join(this.home, 'agent-community', 'memory'), input.botId, input.roomId).roomFile,
    }
  }

  /** The goal-writing actor for one call: a plugin bot session, or the user. */
  private goalActor(actorSessionId: string | undefined): GoalActor {
    if (actorSessionId === undefined) return { kind: 'user' }
    const owner = SessionRunner.parseSessionId(actorSessionId)
    if (owner === undefined) return { kind: 'user' }
    const room = this.state.rooms.find(r => r.id === owner.roomId)
    return { kind: 'bot', botId: owner.botId, roomKind: room?.directBotId !== undefined ? 'direct' : 'group' }
  }

  /** Replace one room immutably and persist. No-op when the room is gone. */
  private patchRoom(roomId: string, patch: (room: BotRoom) => BotRoom): void {
    const idx = this.state.rooms.findIndex(r => r.id === roomId)
    if (idx < 0) return
    const rooms = [...this.state.rooms]
    rooms[idx] = patch(rooms[idx]!)
    this.state = { ...this.state, rooms }
    this.enqueueWrite()
  }

  /**
   * Everything that follows a settled run: the leader's hand-off integration, and the room
   * goal's progress/stall bookkeeping.
   *
   * Deliberately NOT async and never awaited by `settleRun`: a settle must not depend on an
   * enqueue that itself may fail, and the run's own state is already durable at this point.
   */
  private afterRunSettled(run: BotRun, status: string, replyText: string, toolCalls: number): void {
    const room = this.state.rooms.find(r => r.id === run.roomId)
    if (room === undefined) return
    // OP-13: an active goal that no longer matches what the room is producing gets ONE visible
    // reminder. It runs before the goal bookkeeping below and changes none of it.
    this.maybeWarnGoalDrift(room, status, replyText)

    // 1. A group turn: members feed the driver's integrate path, the leader's own turn
    //    spends a round and moves the no-progress clock.
    if (room.directBotId === undefined) {
      const leader = this.leaderOfRoom(run.roomId)
      if (leader !== undefined && leader !== run.botId) {
        // A hand-off is a hand-off whichever tool carried it: the leader's `message_member`
        // reaches the member as `[来自 <leader>] …`, which is what marks this turn as given work.
        const leaderName = this.state.bots.find(b => b.id === leader)?.name
        const fromLeader = leaderName !== undefined && (run.prompt ?? '').startsWith(`[来自 ${leaderName}]`)
        void this.groupTask?.onMemberFinished({
          roomId: run.roomId,
          botId: run.botId,
          text: replyText,
          ok: status === 'completed',
          fromLeader,
        })
      } else if (leader !== undefined && leader === run.botId) {
        // ── THE LEADER'S TURN CLOSES A ROUND ──────────────────────────────────────
        //
        // Two guards used to have no caller at all: the round budget (`advanceRound`) and
        // the no-progress stop (`onLeaderIdle`). Both are about a leader TURN, so this is
        // the only place they can be evaluated — on every leader settle, after the member
        // fan-out has already been booked by `onMemberFinished` above.
        this.afterLeaderTurnSettled(run.roomId, run.botId, replyText)
      }
    }

    // 2. The room's goal: continue ONLY inside a live user grant; otherwise stall or pause.
    //
    // THE GATE IS THE POINT. `active` alone is not permission to start a run: a Bot can only
    // PROPOSE a goal, and a goal continues itself only while the user's grant
    // (`authorization`, user-only) still has rounds. Without this the plugin queued a
    // `[继续目标]` run for any tool-using turn, which is how a DM bot kept working for half an
    // hour with no user message.
    const goal = room.goal
    if (goal === undefined || goal.status !== 'active') return
    const leader = room.directBotId !== undefined ? room.directBotId : this.leaderOfRoom(run.roomId)
    if (leader !== run.botId) return
    // The user's pause covers automatic runs too: a paused room never continues itself.
    if (room.paused === true) return

    const nowMs = Date.now()
    const budget = authorizedRoundBudget(goal)
    if (budget === undefined || !goalAuthorizationUsable(goal, nowMs)) {
      // An "active" goal with no user grant cannot be actionable: older persisted goals
      // predate the grant, and a Bot's own set lands as 'proposed'. Pause instead of burning
      // a model call on work the user never allowed.
      this.patchRoom(run.roomId, r => ({
        ...r,
        goal: { ...goal, status: 'paused', updatedAt: nowIso() },
      }))
      this.recordNotice(run.roomId, '目标已暂停：没有你的授权，自动续跑不会发生。请到面板确认或授权。')
      return
    }
    if (budget.remaining <= 0) {
      // THE BUDGET IS THE GUARANTEE: N authorized rounds, then the goal asks again. Pausing
      // here (not after the stall counter) is what makes the number the user granted final.
      this.patchRoom(run.roomId, r => ({
        ...r,
        goal: { ...goal, status: 'paused', updatedAt: nowIso() },
      }))
      this.recordNotice(
        run.roomId,
        `目标已暂停：自动续跑已达授权上限 ${budget.maxRounds} 轮，需要继续请到面板再授权。`,
      )
      return
    }

    if (toolCalls > 0 && goalContinuationDecision({ goal, hadToolActivity: true, nowMs })) {
      const roundsUsed = budget.roundsUsed + 1
      const nextGoal: RoomGoal = {
        ...goal,
        authorization: goal.authorization === undefined
          ? undefined
          : { ...goal.authorization, roundsUsed },
        // Legacy mirror: older readers/UI watched `continuations`; the grant is the authority.
        continuations: roundsUsed,
        stalledRounds: 0,
        updatedAt: nowIso(),
      }
      // Queue FIRST: if the room was paused/deleted between the check and here, the guard in
      // `queueRoomRun` returns undefined and no budget is spent on a run that does not exist.
      const queued = this.queueRoomRun(
        run.roomId,
        run.botId,
        `[继续目标] ${goal.text}\n上一轮有实际进展，请继续推进；已经完成就调用 finish_task 收尾，不要为了继续而继续。`,
        'routine',
      )
      if (queued === undefined) return
      this.patchRoom(run.roomId, r => ({ ...r, goal: nextGoal }))
      this.recordNotice(
        run.roomId,
        `自动续跑 ${roundsUsed}/${budget.maxRounds}：${goal.text.slice(0, 80)}`
        + `${goal.text.length > 80 ? '…' : ''}（可在面板暂停）`,
      )
      this.executor?.nudge()
      return
    }

    const stalled = (goal.stalledRounds ?? 0) + 1
    if (stalled >= GOAL_STALL_LIMIT) {
      // THREE ROUNDS WITHOUT PROGRESS: stop spending the user's tokens and say so in the room.
      // `paused` rather than `done` — the work may still be wanted, it just needs a human.
      this.patchRoom(run.roomId, r => ({
        ...r,
        goal: { ...goal, status: 'paused', stalledRounds: stalled, updatedAt: nowIso() },
      }))
      this.recordNotice(run.roomId, `目标已暂停：连续 ${GOAL_STALL_LIMIT} 轮没有实际进展，等用户确认后再继续。`)
    } else {
      this.patchRoom(run.roomId, r => ({ ...r, goal: { ...goal, stalledRounds: stalled, updatedAt: nowIso() } }))
    }
  }

  /**
   * One leader turn closed: spend a round of the task budget and move the stall clock.
   *
   * WHY HERE AND NOT IN THE DRIVER: the budget lives on the persisted board
   * (`room.taskState.round`, compared against `maxRounds` by `group-flow.advanceRound`), and
   * the stall guard lives in the driver. A leader turn is the unit both count, and the only
   * signal that a turn ended is its run settling — so this is the joint point.
   *
   * Two stop conditions, both ending automation without `finish_task` (the room is told,
   * the driver closes its board, no further integration turn can start):
   *   · the round budget is exhausted (`round > maxRounds`, §5.5);
   *   · nothing moved for three consecutive leader turns (`onLeaderIdle`).
   *
   * A hand-made group may carry no `team.leader`; the board refuses the advance and the
   * fallback leader still coordinates, so that is not an error — the stall guard still runs.
   */
  private afterLeaderTurnSettled(roomId: string, leaderId: string, replyText: string): void {
    // The user paused automation: no new run would start, so closing the task or spending
    // its round budget here would be a decision they did not ask for.
    if (this.state.rooms.find(r => r.id === roomId)?.paused === true) return
    // A closed task spends no round and moves no stall clock: the leader turn that called
    // `finish_task` (and every turn after `stop`) belongs to a task that is already delivered.
    if (this.groupTask?.isFinished(roomId) === true) return
    try {
      const board = this.groupFlow.advanceRound({ roomId, actorBotId: leaderId })
      // The driver writes `round` back on every save; mirror the board's count so the next
      // save cannot roll the budget back (see `GroupTaskDriver.adoptRound`).
      this.groupTask?.adoptRound(roomId, board.round)
      if (board.round > board.maxRounds) {
        const reason = `已达轮次上限 ${board.maxRounds} 轮，协作已暂停；请用户确认下一步。`
        this.recordNotice(roomId, reason)
        this.groupTask?.stop(roomId, reason)
        return
      }
    } catch {
      // No strict leader on the board (a hand-made group): the round budget cannot be spent,
      // but the stall guard below does not depend on it.
    }
    void this.groupTask?.onLeaderIdle({ roomId, producedText: replyText.trim() !== '' })
      .then((result) => {
        if (!result.stalled) return
        const reason = '协作已暂停：连续3轮没有进展，请用户确认下一步'
        this.recordNotice(roomId, reason)
        this.groupTask?.stop(roomId, reason)
      })
      .catch(() => undefined)
  }

  /**
   * The panel's poll payload — TRIMMED, because it is polled every 400 ms.
   *
   * The transcript, reasoning, tool cards and deliverables all reach the panel through the
   * LEDGER (an incremental cursor), not through this snapshot; what the snapshot's messages
   * are actually used for is the unread water mark (newest id/createdAt per room) and nothing
   * else. Serializing the whole community here — every message's reasoning and tool output,
   * every run's full prompt — put megabytes on the wire for fields no surface reads.
   *
   * `summarizeSnapshot*` are structural copies, so a heavy field added later cannot leak into
   * the payload by accident. The declared return type stays `BotCommunitySnapshot` (the state
   * schema is unchanged); the two arrays now carry the documented lite subset, which is a
   * superset of every field the panel reads.
   */
  snapshot(): BotCommunitySnapshot {
    const tasks = this.state.rooms.flatMap(room =>
      ((room as BotRoom & { tasks?: BotTask[] }).tasks ?? []).map(t => ({ ...t, roomId: room.id as string })),
    )
    return {
      // ── PRESENCE IS DERIVED, NOT STORED ──────────────────────────────────────
      //
      // The raw bot row has no presence field, so the sidebar (RoomList) read
      // `undefined` for every bot and painted a green dot with 空闲 even while a run was
      // streaming. Derive it HERE, from the runs the same snapshot is about to ship, so
      // the dot and the run state can never disagree. `getBotPresence` is the one rule
      // (running > queued > idle) and is also exposed as its own RPC.
      bots: this.state.bots.map(bot => ({ ...bot, presence: this.getBotPresence(bot.id) })),
      rooms: this.state.rooms,
      messages: summarizeSnapshotMessages(this.state.messages) as unknown as BotCommunitySnapshot['messages'],
      runs: summarizeSnapshotRuns(this.state.runs) as unknown as BotCommunitySnapshot['runs'],
      mailbox: this.state.mailbox,
      tasks,
      unread: this.unreadByRoom(),
    }
  }

  getBotPresence(botId: string): BotPresence {
    const active = this.state.runs.some(
      r => r.botId === botId && (r.status === 'running' || r.status === 'queued'),
    )
    return active ? (this.state.runs.find(r => r.botId === botId && r.status === 'running') ? 'running' : 'queued') : 'idle'
  }

  // ── P0-2: Ledger RPC ───────────────────────────────────────────────────────

  /**
   * Return up to `limit` ledger entries before `beforeSequence`.
   * Clients use this for initial load and "load earlier" pagination.
   *
   * NOTE: the signature must stay plain identifiers only. The Typert Gateway
   * validates SRC-mode Remote methods and rejects any parameter with a default
   * value ("must use unique identifier parameters without destructuring,
   * defaults, or rest"), which failed the whole method with
   * `gateway/signature-invalid`. The `{}` default now lives in the body.
   */
  /** The host skill registry, when this DSH build provides one. */
  /**
   * The host skill registry.
   *
   * Cordis exposes services as typed properties gated by `static inject`, which is
   * why `ctx.get('skills')` could never resolve here — the native providers use
   * `ctx.skills` and so must we. Optional in the type because a DSH build without
   * the skill packages still runs the rest of the plugin.
   */
  private skillsRegistry(): {
    list(opts: { cwd: string; signal?: AbortSignal }): Promise<Array<{ name: string; description?: string }>>
    get(name: string, opts: { cwd: string; signal?: AbortSignal }): Promise<{ name: string; content: string } | undefined>
  } | undefined {
    try {
      const svc = (this.ctx as unknown as { skills?: unknown }).skills
      if (svc === undefined || svc === null) return undefined
      const candidate = svc as { list?: unknown }
      // Guard the shape too: an unrelated service under this name must not crash us.
      if (typeof candidate.list !== 'function') return undefined
      return svc as ReturnType<AgentCommunityService['skillsRegistry']>
    } catch {
      return undefined
    }
  }

  /**
   * Load a skill's full text.
   *
   * This is what gives skills "strong" semantics: the menu can invoke one directly
   * and the text lands in the conversation, instead of the bot only being told the
   * skill exists.
   */
  async loadSkill(roomId: string, name: string): Promise<{ name: string; content: string } | undefined> {
    // Prefer whichever source discovered this skill: a filesystem SKILL.md (workspace
    // or user root) or the host registry (`skill://`). Reading the file directly is
    // what makes invocation work even when the registry service is unavailable.
    const known = this.listSkillsSync(roomId).find(sk => sk.id === name || sk.name === name)
    if (known !== undefined && !known.path.startsWith('skill://')) {
      try {
        return { name: known.name, content: await readFile(known.path, 'utf8') }
      } catch {
        return undefined
      }
    }

    const room = requireRoom(this.state, roomId)
    const botId = room.directBotId ?? room.memberIds[0]
    const bot = botId !== undefined ? this.state.bots.find(b => b.id === botId) : undefined
    const root = bot?.workspace !== undefined && bot.workspace !== ''
      ? bot.workspace
      : bot !== undefined ? this.botWorkspaceDir(bot.id) : homedir()
    const registry = this.skillsRegistry()
    if (registry === undefined) {
      // Not discovered on disk and no registry: re-scan once in case it is new.
      await this.listSkills(roomId)
      const again = this.listSkillsSync(roomId).find(sk => sk.id === name || sk.name === name)
      if (again === undefined) return undefined
      try {
        return { name: again.name, content: await readFile(again.path, 'utf8') }
      } catch {
        return undefined
      }
    }
    try {
      const skill = await registry.get(name, { cwd: root })
      if (skill === undefined) return undefined
      return { name: skill.name, content: skill.content }
    } catch {
      return undefined
    }
  }


  /**
   * Discover the skills available to a room's bot.
   *
   * Skills follow the same on-disk convention the host uses: a `SKILL.md` file with
   * a YAML frontmatter block holding `name` and `description`, found under
   * `.dsh/skills/<dir>/` or `.agents/skills/<dir>/` inside the bot's workspace.
   * Reading them from disk keeps the plugin's skills declarative — dropping a file
   * in the workspace is all it takes to add one.
   */
  /**
   * Shallow listing of one skill directory.
   *
   * The model needs to know which reference files exist; without this it explored
   * with bash/glob, which was slow and wandered outside the workspace (raising a
   * macOS folder-access prompt). One listing removes that whole round trip.
   */
  async listSkillFiles(dir: string): Promise<Array<{ path: string; isDir: boolean }>> {
    const resolved = resolve(dir)
    const roots = [join(homedir(), '.agents', 'skills'), join(homedir(), '.dsh', 'skills')]
    const allowed = roots.some(r => resolved === r || resolved.startsWith(r + '/'))
      // The bot's own workspace is also a legitimate skill root.
      || this.state.bots.some(b => {
        const ws = b.workspace !== undefined && b.workspace !== '' ? b.workspace : this.botWorkspaceDir(b.id)
        return resolved === ws || resolved.startsWith(ws + '/')
      })
    if (!allowed) return []
    const walk = async (base: string, prefix: string, depth: number): Promise<Array<{ path: string; isDir: boolean }>> => {
      if (depth > 2) return []
      let entries
      try {
        entries = await readdir(join(base, prefix), { withFileTypes: true })
      } catch {
        return []
      }
      const out: Array<{ path: string; isDir: boolean }> = []
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
        if (e.isDirectory()) {
          out.push({ path: rel, isDir: true })
          out.push(...await walk(base, rel, depth + 1))
        } else {
          out.push({ path: rel, isDir: false })
        }
      }
      return out
    }
    const all = await walk(resolved, '', 0)
    return all.slice(0, 60)
  }

  async listSkills(roomId: string): Promise<Array<{
    id: string
    name: string
    description: string
    path: string
  }>> {
    const room = requireRoom(this.state, roomId)
    const botId = room.directBotId ?? room.memberIds[0]
    const bot = botId !== undefined ? this.state.bots.find(b => b.id === botId) : undefined
    if (bot === undefined) return []
    const root = bot.workspace !== undefined && bot.workspace !== ''
      ? bot.workspace
      : this.botWorkspaceDir(bot.id)

    const found: Array<{ id: string; name: string; description: string; path: string }> = []

    // DSH's own registry first — that is what "the skills DSH already has" means, and
    // it includes every installed skill package with no file layout assumptions.
    // `cwd` scopes project-level skills to the bot's workspace, exactly as the host
    // does for a real session.
    const registry = this.skillsRegistry()
    if (registry === undefined) {
      // Not a silent fallback: an empty 技能 group is otherwise indistinguishable
      // from "this build has no skills".
      this.ctx.logger?.info?.(
        'agent-community: no "skills" service on ctx; falling back to workspace SKILL.md scan',
      )
    } else {
      try {
        const summaries = await registry.list({ cwd: root })
        this.ctx.logger?.info?.(
          `agent-community: skill registry returned ${summaries.length} skill(s) for cwd=${root}`,
        )
        for (const sk of summaries) {
          if (typeof sk?.name !== 'string' || sk.name === '') continue
          found.push({
            id: sk.name,
            name: sk.name,
            description: typeof sk.description === 'string' ? sk.description : '',
            // Registry skills resolve through ctx.skills.get, not a filesystem path.
            path: `skill://${sk.name}`,
          })
        }
      } catch (error: unknown) {
        this.ctx.logger?.warn?.(
          `agent-community: skill registry list failed for cwd=${root}: ${String(error)}`,
        )
      }
    }
    this.ctx.logger?.info?.(
      `agent-community: room ${roomId} has ${found.length} skill(s) after registry + workspace scan`,
    )

    const seen = new Set<string>()
    // The roots DSH's own filesystem provider scans, in its order:
    //   project .dsh/skills, project .agents/skills,
    //   user    ~/.dsh/skills,  user    ~/.agents/skills
    // Skills overwhelmingly live in the USER roots — scanning only the bot workspace
    // (which has neither) is why the 技能 group came back empty.
    const scanDirs = [
      join(root, '.dsh/skills'),
      join(root, '.agents/skills'),
      join(homedir(), '.dsh', 'skills'),
      join(homedir(), '.agents', 'skills'),
    ]
    for (const dir of scanDirs) {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const file = join(dir, entry.name, 'SKILL.md')
        let raw: string
        try {
          raw = await readFile(file, 'utf8')
        } catch {
          continue
        }
        const meta = parseSkillFrontmatter(raw)
        const name = meta.name !== '' ? meta.name : entry.name
        if (seen.has(name)) continue
        seen.add(name)
        found.push({
          id: name,
          name,
          description: meta.description,
          path: file,
        })
      }
    }
    found.sort((a, b) => a.name.localeCompare(b.name))
    // Cached per room with a signature + TTL (§5.3): the prompt builder runs on every
    // model round and must not hit the filesystem each time, but the cache must also
    // expire — the old map was never invalidated, so a skill added to the workspace
    // stayed invisible until DSH restarted and a deleted one stayed in the prompt.
    return [...await this.skills.record(roomId, found)]
  }

  /**
   * Cached skills for a room, for synchronous callers such as the prompt builder.
   *
   * Never blocks and never throws: a stale entry is served while a background scan
   * runs, and a missing one returns empty for this round and fills in for the next.
   */
  listSkillsSync(roomId: string): SkillEntry[] {
    return [...this.skills.skillsFor(roomId)]
  }

  /**
   * The `[可用技能]` block for one bot (§5.3 prompt 三态): the profile's picks first,
   * then the full name list, plus the explicit note that any skill can be loaded.
   *
   * Exposed for the prompt builder; undefined when the room has no skills, so a
   * skill-less room's prompt is byte-identical to before.
   */
  skillPromptFor(roomId: string, botId: string): string | undefined {
    return this.skills.promptBlock(roomId, botId)
  }

  /** Force a profile re-analysis (background, never throws). */
  async refreshSkillProfile(roomId: string, botId: string): Promise<void> {
    await this.skills.refreshProfile(roomId, botId)
  }

  /**
   * The bot's profile when it still matches its identity AND the room's skill set.
   *
   * Undefined means "stale": the prompt then serves the full list and re-analyses in
   * the background. Exposed so callers (and the acceptance harness) can see the
   * freshness decision rather than infer it from prompt text.
   */
  currentSkillProfile(roomId: string, botId: string): BotSkillProfile | undefined {
    return this.skills.matchingProfile(roomId, botId)
  }

  /** Signature of the room's current skill set, for diagnostics and tests. */
  skillSignature(roomId: string): string | undefined {
    return this.skills.signatureOf(roomId)
  }

  /** Re-scan every room's skills; called at startup so the cache is warm. */
  private async refreshSkillCache(): Promise<void> {
    for (const room of this.state.rooms) {
      try {
        await this.listSkills(room.id)
      } catch {
        // A room without a resolvable bot simply has no skills.
      }
    }
  }

  listLedger(
    roomId: string,
    opts?: {
      beforeSequence?: number
      afterSequence?: number
      changedAfterSequence?: number
      /** Monotonic change cursor; unlike sequence it also re-delivers patched old rows. */
      changedAfterChangeSeq?: number
      limit?: number
      /** Ignore cursors and return the room's current rows. */
      force?: boolean
    },
  ): LedgerEntry[] {
    // Lazily hydrate a room whose ledger has never been built in this process.
    // Rooms created after startup (a fork, a new bot's DM) have persisted messages
    // but no ledger entries, and the panel renders from the ledger alone.
    if (!this.ledgerHydrated.has(roomId)) {
      this.ledgerHydrated.add(roomId)
      // ── ONLY WHEN THERE IS NOTHING TO LOSE ────────────────────────────────────
      //
      // `seedLedgerRoom` REPLACES the room's rows with ones rebuilt from the persisted
      // messages, silently dropping every row a live turn has already created: the
      // reserved row the projection streams into, its reasoning deltas, its tool cards.
      // The panel polls this method every few tens of milliseconds, so for a room
      // created after startup (a new group, a new DM, a fork) the rebuild landed right
      // as the first runs started — measured live, such a room showed ZERO streaming
      // rows for the whole turn and each reply appeared only once it settled, which
      // reads as "one bot after another" even though the runs started together. A room
      // that already holds rows is therefore left alone.
      if (this.ledger.listLedger(roomId, { force: true }).length > 0) {
        return this.ledger.listLedger(roomId, opts ?? {})
      }
      const n = this.maintenance.seedLedgerRoom(roomId)
      if (n > 0) {
        this.ctx.logger?.info?.(`agent-community: hydrated ${n} ledger entries for room ${roomId}`)
      }
    }
    return this.ledger.listLedger(roomId, opts ?? {})
  }

  // ── P0-3: Approval RPC ────────────────────────────────────────────────────

  /**
   * Called by the client when the user clicks Allow/Reject on an approval card.
   * Routes the decision to the ApprovalBridge which resolves the pending promise.
   */
  approveBotToolCall(callId: string, outcome: 'allowed-once' | 'rejected'): void {
    this.approvalBridge?.resolveApproval(callId, outcome)
  }

  // ── P0-1: Session visibility RPC ──────────────────────────────────────────

  /**
   * Return visibility records for all known bot sessions.
   * The UI surfaces sessions with lastError so users can trigger a retry.
   */
  getSessionVisibility(): import('./visibility.ts').SessionVisibilityRecord[] {
    return this.executor
      ? Array.from(this.executor['visibility']?.listVisibility?.() ?? [])
      : []
  }

  /**
   * Trigger a full reconcile of session visibility.
   * Idempotent — safe to call from a UI retry button.
   */
  async reconcileSessionVisibility(): Promise<void> {
    const vis = this.executor?.['visibility'] as import('./visibility.ts').VisibilityController | undefined
    if (vis !== undefined) {
      await vis.reconcile(this.listKnownSessionIds())
    }
  }

  // ── Extracted Maintenance ───────────────────────────────────────────────────
  //
  // The destructive/repair paths live in `Maintenance` (src/maintenance.ts). This
  // adapter is the only bridge: every member is live (accessors and closures), so
  // building it during field initialization is safe even though `ledger`,
  // `sessionsDir` and `statePath` are assigned later in the constructor.
  private readonly maintenance = new Maintenance(this.maintenanceHost())

  private maintenanceHost(): MaintenanceHost {
    // Captured so the accessors below read the service's fields, not the literal's.
    const service = this
    return {
      get statePath() { return service.statePath },
      get sessionsDir() { return service.sessionsDir },
      get ctx() { return service.ctx },
      get ledger() { return service.ledger },
      get ledgerHydrated() { return service.ledgerHydrated },
      get defaultWorkspaceCache() { return service.defaultWorkspaceCache },
      get state() { return service.state },
      set state(next: PersistedState) { service.state = next },
      enqueueWrite: () => this.enqueueWrite(),
      sessionIdFor: (roomId, botId) => this.sessionIdFor(roomId, botId),
      botWorkspaceDir: (botId) => this.botWorkspaceDir(botId),
      botWorkspaceRoot: () => this.botWorkspaceRoot(),
      nowIso: () => nowIso(),
      runDurationMs: (run) => runDurationMs(run),
      flushNow: () => this.flushNow(),
      disposeBotAgents: (roomId, botId) => this.disposeBotAgents(roomId, botId),
    }
  }
}

// The loader instantiates the default export itself, exactly as the in-box
// Agent Teams service does; wrapping it in `apply` would register the service
// twice.
export default AgentCommunityService

/**
 * Register one Remote method marker without decorator syntax.
 *
 * tsdown/rolldown passes TC39 decorators through unchanged and Node cannot
 * parse decorator syntax at runtime, so `@Remote` is unusable in this package.
 * `Remote` is the same entry point a decorator uses; the fabricated context
 * only needs to satisfy the decorator contract, and the protocol invokes
 * `addInitializer` synchronously.
 */
function markRemote(prototype: object, method: string): void {
  const fn = (prototype as Record<string, unknown>)[method]
  if (typeof fn !== 'function') throw new TypeError(`agent-community: no method ${method}`)
  const context = {
    kind: 'method' as const,
    name: method,
    static: false,
    private: false,
    // The protocol's mark() reads Object.getPrototypeOf(this) to locate the
    // class prototype, so the initializer must run with `this` being an object
    // whose prototype IS the class prototype — exactly what an instance
    // initializer produces.
    addInitializer(init: (this: unknown) => void): void {
      init.call(Object.create(prototype))
    },
  }
  ;(Remote as unknown as (m: unknown, c: unknown) => void)(fn, context)
}

/** Largest file whose bytes the in-panel preview returns (images, PDF and the client-rendered Office formats). */
const PREVIEW_MAX_BYTES = 8 * 1024 * 1024
/** Largest text window the preview reads; the panel says so when it hits this. */
const PREVIEW_TEXT_BYTES = 512 * 1024
const PREVIEW_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
}
/**
 * Office formats the panel renders in the browser from the original bytes (0.3.1).
 *
 * Word goes to docx-preview and Excel to SheetJS, so these are returned as `data`
 * like images and PDF. PowerPoint and the legacy binary formats stay on the host
 * office-to-pdf conversion path (`renderDeliverableDocument`).
 */
const PREVIEW_DOCUMENT_MIME: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
/** Office extensions the Host office-to-pdf provider can convert for the preview. */
const OFFICE_RENDER_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])

/**
 * Formats with no in-panel viewer; the card offers the native app instead.
 *
 * `.docx`/`.xlsx` are no longer listed: the panel renders them from bytes. Oversized
 * ones still answer `binary` — that check runs before this set is consulted.
 */
const PREVIEW_BINARY_EXT = new Set([
  '.doc', '.ppt', '.pptx', '.xls', '.xlsm', '.odt', '.ods', '.odp',
  '.zip', '.gz', '.tgz', '.tar', '.rar', '.7z', '.jar',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.mp3', '.wav', '.m4a', '.flac', '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi',
])

/**
 * Read a text window for the preview, starting at a line offset.
 *
 * Returns undefined when the bytes are not text (a NUL byte in the head), which is
 * how an unrecognised extension still ends up as "open me in an app" instead of a
 * mojibake wall.
 */
async function readPreviewText(
  path: string,
  lineOffset: number,
): Promise<{ text: string; offset: number; truncated: boolean } | undefined> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(PREVIEW_TEXT_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, PREVIEW_TEXT_BYTES, 0)
    const head = buffer.subarray(0, bytesRead)
    if (head.includes(0)) return undefined
    const lines = head.toString('utf8').split('\n')
    const from = Math.max(0, Math.trunc(lineOffset))
    return {
      text: lines.slice(from).join('\n'),
      offset: from,
      truncated: bytesRead === PREVIEW_TEXT_BYTES,
    }
  } finally {
    await handle.close()
  }
}

/** Methods the Bot Community browser UI calls through ctx.remote.agentCommunity. */
const REMOTE_METHODS = [
  'snapshot', 'listBots', 'getBot', 'createBot', 'updateBot', 'deleteBot',
  'listRooms', 'createRoom', 'updateRoom', 'deleteRoom', 'listMessages', 'sendMessage',
  'listRuns', 'getBotPresence', 'ensureRoomAgentSession', 'getDefaults',
  'controlRun', 'retryRun', 'ensureRoomSession',
  'proposeGroup', 'confirmGroup', 'declineGroup',
  // P1-2/P0-3/P0-1 new RPCs
  'listLedger', 'approveBotToolCall', 'getSessionVisibility', 'reconcileSessionVisibility',
  // Deliverable cards: in-panel preview of a declared file (never a client-supplied path).
  'readDeliverablePreview',
  // Host desktop actions for a delivered file (applications / open / reveal).
  'deliverableFileAction',
  // Office → PDF rendering for the in-panel preview (host office-to-pdf provider).
  'renderDeliverableDocument',
  // P-clear: clear room messages + cancel stale failed runs
  'clearMessages',
  // Fork: copy a bot into a new bot + its own direct room
  'copyBot',
  // Skills: discovery for the composer menu, and loading one for direct invocation.
  // These MUST be listed here: markRemote only exposes allowlisted methods, so a
  // descriptor on the client without an entry here fails as an unknown remote.
  'listSkills', 'loadSkill', 'listSkillFiles',
  // Membership: a bot's `remove_bot` reaches the same service method, and the UI can
  // take members out without going through the room-edit form.
  'removeBots',
  // A bot's question card answers back through here.
  'answerBotQuestion',
  // Unread badges: the panel clears a room's count as soon as that room is on screen, and the
  // sidebar entry polls the totals on its own so it stays right while another panel is in front.
  'markRoomRead', 'unreadTotals',
  // Notices: the panel's model/permission/command feedback, recorded as a durable transcript row
  // (the same `dispatch` row the group-flow notes use).
  'noticeRoom',
  // Compaction: replace a room's older messages with one summary so every later turn carries
  // the summary + the recent tail instead of the whole transcript.
  'compactRoom',
  // Room goal authorization (S3): the panel is the user's only way to grant, pause or resume
  // automatic continuation. A Bot's own tool can only PROPOSE a goal, never authorize it.
  'authorizeRoomGoal', 'pauseRoomGoal', 'resumeRoomGoal',
  // Experience-card management from room settings (delete / confirm pending).
  'deleteRoomPattern', 'confirmRoomPattern', 'updateRoomExperience',
] as const

for (const method of REMOTE_METHODS) {
  markRemote(AgentCommunityService.prototype, method)
}

/**
 * Read `name` / `description` out of a SKILL.md frontmatter block.
 *
 * Deliberately a tiny line parser rather than a YAML dependency: the frontmatter
 * these files use is flat `key: value`, and the plugin ships with no runtime deps.
 */
function parseSkillFrontmatter(raw: string): { name: string; description: string } {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(raw)
  if (m === null) return { name: '', description: '' }
  const out: { name: string; description: string } = { name: '', description: '' }
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^\s*(name|description)\s*:\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = kv[1] as 'name' | 'description'
    // Strip surrounding quotes the way YAML readers would.
    out[key] = (kv[2] ?? '').trim().replace(/^["']|["']$/g, '')
  }
  return out
}
