/**
 * ApprovalBridge — intercepts approval/request events for group-chat member
 * sessions and routes them through the ledger as 'approval' entries rather
 * than surfacing native approval cards in the UI.
 *
 * Design (v5 §5, V-8):
 *  - Registers a prepend:true, global:true approval/request waterfall listener.
 *  - Only handles requests whose agent belongs to a known member session.
 *  - All other requests get next() and reach the native approval UI unchanged.
 *  - Hard limit: strategies.setPolicy(agent, {default:'ask'}) must already be
 *    called for the member session; 'never' policy short-circuits before listeners.
 *  - R-19: in 'danger-full-access' permission mode the policy may be forced to
 *    'never'; the bridge then never fires. The UI should surface an explanation.
 *
 * Concurrency: each pending approval gets a stable resolveMap entry so
 * resolve(outcome) is safe to call from any concurrent path.
 *
 * ── OP-06: THE APPROVAL IS BOUND TO THE EXECUTION (not just to a tool name) ──────
 *
 * The host's approval request carries `agent`, `toolName`, `callId` and `reason` — but NO
 * arguments. The arguments exist only on the `tools/pre-execute` execution, which runs BEFORE
 * the approval. So this bridge:
 *
 *   1. listens to `tools/pre-execute` (prepend, global) and captures each MEMBER call's frozen
 *      arguments as a sha256 keyed by `callId` (`executions`, bounded to 200 entries);
 *   2. builds an `ApprovalBinding` when the approval dialog opens: `verified-args` when the
 *      capture has the arguments, `args-unavailable` otherwise (a host that never offers them
 *      must still be usable);
 *   3. on `allowed-once`, stores the binding in a one-shot `approved` map keyed by callId;
 *   4. registers a global, synchronous `ctx.tools.guard()` — the host runs guards AFTER the
 *      approval and BEFORE the body — which checks the execution about to run against the
 *      granted binding, spends it, and denies on a tool/args/expiry mismatch.
 *
 * The guard NEVER denies a call that has no approved token: ordinary tools, the user's own
 * session, and non-approval-gated calls are untouched. A mismatch consumes the token too, so a
 * corrected retry needs a fresh user decision.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LedgerProjector } from './ledger.ts'
import type { BotId, BotRoomId } from './types.ts'
import {
  APPROVAL_BINDING_TTL_MS,
  canonicalArgsHash,
  consumeApproval,
  createApprovalBinding,
  pruneExpiredApprovals,
  type ApprovalBinding,
} from './approval-binding.ts'
import { optionalService, SessionRunner } from './session-runner.ts'

type ApprovalOutcome = 'allowed-once' | 'rejected'

/**
 * How long an approval dialog may stay open before it is automatically REJECTED.
 *
 * A bot session is a hidden `subagent` session: nothing in the user's window can render a
 * native approval card for it. An unanswered dialog is therefore not a "waiting for the user"
 * state, it is a hung turn — observed in the field as 19m49s of「深度求索中」that only ended when
 * an unrelated timeout cancelled the run. Refusing on a timer turns that into a visible
 * refusal the model can react to. Set 0 to wait forever (previous behaviour).
 */
export const APPROVAL_TIMEOUT_MS = 120_000

/** One `tools/pre-execute` call captured for a member session, keyed by its callId. */
interface CapturedExecution {
  readonly sessionId: string
  readonly toolName: string
  /** sha256 of the frozen arguments; absent when they could not be hashed. */
  readonly argsHash?: string | undefined
  readonly at: number
}

interface PendingApproval {
  readonly entryId: string
  readonly roomId: BotRoomId
  /** The binding this decision will grant, built while the dialog is open. */
  readonly binding: ApprovalBinding
  resolve(outcome: ApprovalOutcome): void
}

/** Accessor used by the bridge to look up which room a session belongs to. */
export interface ApprovalBridgeAccessor {
  /** Return the roomId for this sessionId, or undefined if not a member session. */
  memberRoomId(sessionId: string): { roomId: BotRoomId; botId: BotId } | undefined
}

export class ApprovalBridge {
  private readonly ctx: Context
  private readonly ledger: LedgerProjector
  private readonly accessor: ApprovalBridgeAccessor
  private readonly pending = new Map<string, PendingApproval>()
  /**
   * Frozen arguments of member tool calls, captured at `tools/pre-execute` and keyed by callId.
   *
   * The approval request has no arguments, so this is the only place they can be read before the
   * user decides. Bounded because a long turn can issue many tool calls and nothing prunes a map
   * that only ever grows; entries also expire with the binding window.
   */
  private readonly executions = new Map<string, CapturedExecution>()
  /** One-shot grants: `allowed-once` bindings waiting for their execution to reach the guard. */
  private readonly approved = new Map<string, ApprovalBinding>()
  /** Pending auto-reject timers, keyed by callId (cleared by any real decision). */
  private readonly approvalTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** How long a dialog may stay open before it is rejected on the user's behalf. */
  private readonly timeoutMs: number
  /** Observability: captured calls / executions that matched a grant / grants that did not. */
  private capturedCount = 0
  private boundCount = 0
  private mismatchCount = 0

  constructor(
    ctx: Context,
    ledger: LedgerProjector,
    accessor: ApprovalBridgeAccessor,
    options?: { readonly timeoutMs?: number | undefined },
  ) {
    this.ctx = ctx
    this.ledger = ledger
    this.accessor = accessor
    const configured = options?.timeoutMs
    this.timeoutMs = typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
      ? configured
      : APPROVAL_TIMEOUT_MS
  }

  /**
   * The room/bot a bot-owned session id names, or undefined when the id is not ours.
   *
   * The mapping is IN the id — `SessionRunner.sessionIdFor` builds `ac:<roomId>:<botId>` — so this
   * needs no state and still works when the persisted membership table is missing the entry.
   */
  static parseBotSession(sessionId: string): { roomId: BotRoomId; botId: BotId } | undefined {
    const parsed = SessionRunner.parseSessionId(sessionId)
    if (parsed === undefined) return undefined
    return { roomId: parsed.roomId as BotRoomId, botId: parsed.botId as BotId }
  }

  /**
   * Register the bridge's hooks. Call once on service start.
   *
   * Three registrations, in the order the host pipeline uses them:
   *   1. `tools/pre-execute` — capture the frozen arguments of a member call by callId;
   *   2. `approval/request` — claim the dialog and build the binding from that capture;
   *   3. `ctx.tools.guard()` — after the approval, deny an execution whose tool/args/expiry no
   *      longer matches the granted binding.
   *
   * Each registration degrades on its own: a host without the tools service still gets the
   * ledger approval rows, and a host without `guard` still gets the other two. Returns one
   * disposer for all of them.
   */
  install(): () => void {
    const disposers: Array<() => void> = []
    this.installPreExecuteCapture(disposers)
    this.installApprovalListener(disposers)
    this.installApprovalGuard(disposers)
    return () => {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* teardown is best-effort */ }
      }
    }
  }

  /** Capture member tool-call arguments before the approval decision (see `executions`). */
  private installPreExecuteCapture(disposers: Array<() => void>): void {
    const bus = this.ctx as unknown as {
      on?(
        event: string,
        handler: (exec: unknown, next: () => unknown) => unknown,
        opts?: { prepend?: boolean; global?: boolean },
      ): () => void
    }
    if (bus.on === undefined) {
      this.note('pre-execute capture unavailable (no ctx.on on this runtime)')
      return
    }
    try {
      disposers.push(bus.on(
        'tools/pre-execute',
        (exec, next) => {
          // CAPTURE IS BEST-EFFORT; the waterfall decision is NOT ours. Returning next() is the
          // contract every non-owning listener owes the host (a waterfall listener that swallows
          // the decision would break every tool call on the host).
          try {
            this.captureExecution(exec)
          } catch (error: unknown) {
            this.note(`capture failed: ${String(error)}`)
          }
          return next()
        },
        { prepend: true, global: true },
      ))
    } catch (error: unknown) {
      this.note(`pre-execute capture failed to register: ${String(error)}`)
    }
  }

  /** The approval dialog itself: ledger row + binding, awaiting the user's decision. */
  private installApprovalListener(disposers: Array<() => void>): void {
    // dsh-user-approval exposes waterfall on 'approval/request'.
    // prepend:true ensures we run before dsh-api-remotes forwards to the browser.
    // global:true is required for cross-scope session agents.
    const approvalSvc = (this.ctx as unknown as {
      approval?: {
        on(
          event: string,
          handler: (req: ApprovalRequest, next: () => Promise<ApprovalOutcome | 'unavailable'>) => Promise<ApprovalOutcome | 'unavailable'>,
          opts: { prepend: boolean; global: boolean },
        ): () => void
      }
    }).approval

    if (approvalSvc?.on === undefined) {
      // approval service not available — bridge is a no-op, native UI handles all
      return
    }

    try {
      disposers.push(approvalSvc.on(
        'approval/request',
        async (req, next) => {
          const sessionId = (req.agent as unknown as { session?: { id?: string } })?.session?.id
          if (sessionId === undefined) return next()

          // ── EVERY BOT-OWNED SESSION IS OURS, NOT JUST THE ONES IN THE MEMBERSHIP TABLE ──
          //
          // `memberRoomId` reads the persisted `roomAgentSessions` table, which is written when a
          // pair's agent is created. A session that exists but is missing from that table (a
          // restored/older generation id, a table rewritten after a clear) used to fall through
          // to `next()` — and the native approval UI can never render for a hidden bot session,
          // so the turn hung forever. The session id itself is the authoritative mapping
          // (`ac:<roomId>:<botId>`), so fall back to parsing it.
          const membership = this.accessor.memberRoomId(sessionId)
            ?? ApprovalBridge.parseBotSession(sessionId)
          if (membership === undefined) return next()  // not a bot session — pass through

          return this.handle(req, membership.roomId, membership.botId)
        },
        { prepend: true, global: true },
      ))
    } catch (error: unknown) {
      this.note(`approval listener failed to register: ${String(error)}`)
    }
  }

  /**
   * The post-approval gate: a global, synchronous guard.
   *
   * `tools.guard()` runs after the extensible `tools/pre-execute` waterfall and after the
   * approval decision, and before the tool body — the only plugin-level hook that can still stop
   * a call the user already approved. It acts ONLY when this exact callId holds a grant, so
   * ordinary calls (and other agents' calls) are never touched.
   */
  private installApprovalGuard(disposers: Array<() => void>): void {
    type ToolGuardHost = { guard?(check: (exec: unknown) => string | undefined): unknown }
    // `tools` is not in the service's inject list: read it opportunistically so the plugin still
    // loads on a host without it (degraded: no post-approval check, every row still recorded).
    const tools = optionalService<ToolGuardHost>(this.ctx, 'tools')
    if (tools?.guard === undefined) {
      this.note('approval guard unavailable (no ctx.tools.guard on this runtime)')
      return
    }
    try {
      const dispose = tools.guard(exec => this.checkApprovedExecution(exec))
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      this.note('approval guard installed (post-approval, pre-execution)')
    } catch (error: unknown) {
      this.note(`approval guard failed to register: ${String(error)}`)
    }
  }

  /**
   * Claim an approval event: push an 'approval' ledger entry and wait for the
   * user to call resolveApproval(). Returns the outcome the waterfall expects.
   */
  private async handle(
    req: ApprovalRequest,
    roomId: BotRoomId,
    botId: BotId,
  ): Promise<ApprovalOutcome | 'unavailable'> {
    const requestedCallId = (req as unknown as { callId?: unknown }).callId
    const callId = typeof requestedCallId === 'string' && requestedCallId !== ''
      ? requestedCallId
      : (req as unknown as { id?: string }).id ?? `approval-${Date.now()}-${this.fallbackSeq++}`
    const toolName = (req as unknown as { tool?: string; toolName?: string }).tool
      ?? (req as unknown as { tool?: string; toolName?: string }).toolName
      ?? 'unknown'
    const args = safeSerialize((req as unknown as { args?: unknown; input?: unknown }).args
      ?? (req as unknown as { args?: unknown; input?: unknown }).input)
    const sessionId = (req.agent as unknown as { session?: { id?: string } })?.session?.id

    // ── THE CAPTURE IS THE BINDING ───────────────────────────────────────────────
    //
    // `tools/pre-execute` ran first and recorded this call's frozen arguments. The host's
    // approval request only names a tool, so without the capture an "Allow" would authorise
    // whatever happens to run under that callId. The capture is keyed by the same callId and
    // consumed here (it belongs to exactly one dialog).
    const captured = this.takeExecution(callId)
    const verified = captured !== undefined
      && captured.toolName === toolName
      && (sessionId === undefined || captured.sessionId === sessionId)
      && captured.argsHash !== undefined
    const binding = createApprovalBinding({
      callId,
      toolName,
      ...(verified && captured.argsHash !== undefined ? { argsHash: captured.argsHash } : {}),
      now: Date.now(),
    }, APPROVAL_BINDING_TTL_MS)
    if (!verified) {
      this.note(
        `approval ${callId.slice(0, 12)} binding=args-unavailable`
        + (captured === undefined ? ' (no pre-execute capture)' : ' (capture did not match the request)'),
      )
    }

    const botName = this.ledger.botName(botId)

    const entry = this.ledger.push({
      type: 'approval',
      roomId,
      botId,
      botName,
      callId,
      toolName,
      args,
      // Additive fields: a reader that predates OP-06 ignores them; this bridge and the panel
      // can now tell whether the grant was verified against the concrete arguments.
      ...(binding.argsHash !== undefined ? { argsHash: binding.argsHash } : {}),
      binding: binding.binding,
      expiresAt: new Date(binding.expiresAt).toISOString(),
      at: new Date().toISOString(),
    })

    return new Promise<ApprovalOutcome | 'unavailable'>(resolve => {
      this.pending.set(callId, { entryId: entry.id, roomId, binding, resolve })
      // ── AN UNANSWERED DIALOG IS A HUNG TURN, NOT A WAITING ONE ──────────────────
      //
      // Nothing renders a native approval card for a hidden bot session, and the panel card is
      // easy to miss behind a running turn. Without a timer the dialog simply outlives every
      // deadline the run has (in the field: 19m49s), so refuse it on the user's behalf and say so
      // in the transcript — a refusal the model can react to beats a spinner.
      if (this.timeoutMs > 0) {
        const timer = setTimeout(() => {
          this.approvalTimers.delete(callId)
          if (!this.pending.has(callId)) return
          const seconds = Math.round(this.timeoutMs / 1000)
          this.note(`approval ${callId.slice(0, 12)} timed out after ${seconds}s — rejected`)
          try {
            this.ledger.push({
              type: 'dispatch',
              roomId,
              text: `审批超时 ${seconds}s，已自动拒绝：${toolName}。`
                + '若希望 bot 能执行这类操作，请在 Bot 设置里提高权限后重发消息。',
              at: new Date().toISOString(),
            })
          } catch { /* the notice is best-effort, the rejection is not */ }
          this.resolveApproval(callId, 'rejected')
        }, this.timeoutMs)
        timer.unref?.()
        this.approvalTimers.set(callId, timer)
      }
    })
  }

  /**
   * Called by the RPC handler when the user clicks Allow/Reject in the UI.
   * Updates the ledger entry's outcome and resolves the pending approval.
   *
   * On Allow the binding becomes executable: it is stored in the one-shot `approved` map BEFORE
   * the waterfall promise resolves, because the host runs the guard immediately after that
   * resolution — a grant stored later would be missed and the approved call denied.
   */
  resolveApproval(callId: string, outcome: ApprovalOutcome): void {
    const timer = this.approvalTimers.get(callId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.approvalTimers.delete(callId)
    }
    const pending = this.pending.get(callId)
    if (pending === undefined) return
    this.pending.delete(callId)
    this.ledger.patch(pending.entryId, pending.roomId, { outcome } as never)
    if (outcome === 'allowed-once') {
      pruneExpiredApprovals(this.approved)
      this.approved.set(callId, pending.binding)
      this.note(
        `approval allowed callId=${callId.slice(0, 12)} tool=${pending.binding.toolName} `
        + `binding=${pending.binding.binding}`,
      )
    } else {
      // A rejected dialog must leave nothing executable behind (defence in depth: a stale grant
      // for the same callId would otherwise authorise a later execution).
      this.approved.delete(callId)
      this.note(`approval ${outcome} callId=${callId.slice(0, 12)}`)
    }
    pending.resolve(outcome)
  }

  /** Number of approvals currently waiting for a user decision. */
  pendingCount(): number {
    return this.pending.size
  }

  /** Counters for logs/tests: captured calls, matched grants, refused grants. */
  bindingStats(): { captured: number; bound: number; mismatch: number; approved: number } {
    return {
      captured: this.capturedCount,
      bound: this.boundCount,
      mismatch: this.mismatchCount,
      approved: this.approved.size,
    }
  }

  private fallbackSeq = 0

  /** Record one member session's frozen arguments for the upcoming approval, keyed by callId. */
  private captureExecution(exec: unknown): void {
    if (exec === null || typeof exec !== 'object') return
    const view = exec as {
      callId?: unknown
      name?: unknown
      arguments?: unknown
      agent?: { session?: { id?: unknown } }
    }
    const callId = typeof view.callId === 'string' && view.callId !== '' ? view.callId : undefined
    if (callId === undefined) return
    const sessionId = typeof view.agent?.session?.id === 'string' ? view.agent.session.id : undefined
    // Only MEMBER sessions are bridged; the user's own tools must not enter this map at all.
    if (sessionId === undefined || this.accessor.memberRoomId(sessionId) === undefined) return
    const toolName = typeof view.name === 'string' && view.name !== '' ? view.name : 'unknown'
    let argsHash: string | undefined
    try {
      argsHash = canonicalArgsHash(view.arguments)
    } catch (error: unknown) {
      this.note(`capture hash failed callId=${callId.slice(0, 12)}: ${String(error)}`)
    }
    const now = Date.now()
    this.pruneExecutions(now)
    this.executions.set(callId, {
      sessionId,
      toolName,
      ...(argsHash !== undefined ? { argsHash } : {}),
      at: now,
    })
    this.capturedCount += 1
    // Bounded FIFO: delete the oldest insertion while over the cap.
    while (this.executions.size > MAX_CAPTURED_EXECUTIONS) {
      const oldest = this.executions.keys().next()
      if (oldest.done === true) break
      this.executions.delete(oldest.value)
    }
  }

  /** Drop captures whose dialog will never come (or arrived too late to bind). */
  private pruneExecutions(now: number): void {
    for (const [callId, captured] of this.executions) {
      if (now - captured.at > APPROVAL_BINDING_TTL_MS) this.executions.delete(callId)
    }
  }

  /** Read-and-forget one capture: a dialog consumes its call's arguments exactly once. */
  private takeExecution(callId: string): CapturedExecution | undefined {
    const captured = this.executions.get(callId)
    if (captured === undefined) return undefined
    this.executions.delete(callId)
    return captured
  }

  /**
   * The guard: verify the execution about to run against its granted binding.
   *
   * Returns `undefined` for every call without an approved token — the guard must be invisible to
   * normal traffic. A token is spent on EVERY outcome (allowed or denied), so one Allow authorises
   * at most one execution and a mismatch cannot be retried with the same grant.
   */
  private checkApprovedExecution(exec: unknown): string | undefined {
    try {
      if (exec === null || typeof exec !== 'object') return undefined
      const view = exec as { callId?: unknown; name?: unknown; arguments?: unknown }
      const callId = typeof view.callId === 'string' && view.callId !== '' ? view.callId : undefined
      if (callId === undefined || !this.approved.has(callId)) return undefined
      const decision = consumeApproval({
        tokens: this.approved,
        exec: {
          callId,
          ...(typeof view.name === 'string' ? { name: view.name } : {}),
          args: view.arguments,
        },
      })
      if (decision.kind === 'none') return undefined
      if (decision.kind === 'allowed') {
        this.boundCount += 1
        return undefined
      }
      this.mismatchCount += 1
      this.note(`MISMATCH callId=${callId.slice(0, 12)} reason=${decision.reason}`)
      return `审批绑定校验失败：${decision.reason}。本次工具调用已拒绝；如仍需要执行，请让用户重新确认。`
    } catch (error: unknown) {
      // A guard bug must not break unrelated tools: fail open ONLY for the non-token path (the
      // fast checks above); a token genuinely present and failing consumes it as a denial via
      // consumeApproval's own guards, so this catch is for pathological argument encodings.
      this.note(`guard error: ${String(error)}`)
      return undefined
    }
  }

  private note(line: string): void {
    try {
      this.ctx.logger?.info?.(`agent-community: approval-binding ${line}`)
    } catch {
      // Logging must never be able to stop a tool call.
    }
  }
}

/** Hard cap on captured executions; a long turn can issue many calls and nothing else prunes. */
const MAX_CAPTURED_EXECUTIONS = 200

// Minimal type for an approval request; the actual shape is DSH-internal.
// We only read from it, so a liberal unknown-based cast is safe.
type ApprovalRequest = Record<string, unknown>

function safeSerialize(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}
