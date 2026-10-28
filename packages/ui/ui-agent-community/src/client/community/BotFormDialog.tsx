/**
 * BotFormDialog — the create/edit surface for a Bot, and the create surface for a group.
 *
 * Both live in one dialog because they are one dialog in the product: the left column's ＋ opens
 * "新建 Bot" while the Bots tab is showing and "新建群聊" while 群聊 is showing, and only the form
 * inside changes. The shell mounts this component when the form is open and passes `isBotMode`,
 * so the dialog's field state is born and dies with the form: opening it is what initialises the
 * fields (from `editingBot` when editing), and the shell never has to reset them.
 *
 * The dialog owns its edit buffer and both submit paths (`createBot`/`updateBot`, `createRoom`);
 * the shell keeps the snapshot reload (`onSaved`), the notice bar (`setNotice`) and the shared
 * `busy` flag. The model-group list is read here but stored by the shell, because the open room's
 * composer renders the same list.
 *
 * Markup: unchanged — this dialog already rode `NativeDialog`. The tab strip, the avatar picker,
 * every field, every validation message and the footer's `form=` submit wiring are as they were;
 * what moved is the form state and both submit paths.
 */
import { useEffect, useState } from 'react'
import type { Dispatch, FormEvent, SetStateAction } from 'react'
import type { BotId, BotIdentity } from '@dsh-plugin/agent-community'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { NativeDialog } from '../conversation/NativeDialog.tsx'
import { DialogTabs } from '../conversation/DialogTabs.tsx'
import { NativeCheckbox, NativeSegmentedControl } from '../conversation/NativeControls.tsx'
import { IconFolderOpenRegular } from '../conversation/NativeIcons.tsx'
import { css } from '../styles.ts'
import type { CommunityRemote, ModelCatalogFailure, ModelGroup } from './types.ts'
import { describe } from './types.ts'

const AVATAR_EMOJIS = ['🤖', '🧠', '🦊', '🐙', '🐼', '🐸', '🚀', '🌟', '🎯', '🛠️', '🧭', '🔥', '🌈', '🪐', '🦉', '🐳'] as const

export interface BotFormDialogProps {
  /** True on the Bots tab (create/edit a bot); false on 群聊 (create a group). */
  isBotMode: boolean
  /** Set → the dialog edits this bot; undefined → it creates one. */
  editingBot: BotIdentity | undefined
  /** Live bot directory: the group form's member checkboxes. */
  visibleBots: BotIdentity[]
  /** The shell's shared busy flag: a submit in flight holds every dialog's primary button. */
  busy: boolean
  setBusy: (busy: boolean) => void
  remote: CommunityRemote
  /** Provider/model list, shared with the open room's composer. */
  modelGroups: ModelGroup[]
  setModelGroups: Dispatch<SetStateAction<ModelGroup[]>>
  /** Host default workspace, fetched once by the shell. */
  defaultWorkspace: string
  /** The shell's notice bar: submitting clears it, a failed direct room sets it. */
  setNotice: Dispatch<SetStateAction<string | undefined>>
  /** Cancel / close: the shell drops `editingBot` and unmounts this component. */
  onClose: () => void
  /** Saved: the shell closes the dialog and reloads the snapshot. */
  onSaved: () => void
}

export function BotFormDialog({
  isBotMode, editingBot, visibleBots, busy, setBusy, remote,
  modelGroups, setModelGroups, defaultWorkspace, setNotice, onClose, onSaved,
}: BotFormDialogProps) {
  // Bot form fields
  const [botName, setBotName] = useState(editingBot?.name ?? '')
  const [botDesc, setBotDesc] = useState(editingBot?.description ?? '')
  const [botPrompt, setBotPrompt] = useState(editingBot?.systemPrompt ?? '')
  // `''` = "ask the provider for its own default" — the only choice that is valid on every
  // route. A model that publishes no reasoning levels rejects EVERY explicit level with
  // UNSUPPORTED_REASONING_EFFORT, so a non-empty default here creates bots that cannot answer.
  const [botEffort, setBotEffort] = useState(editingBot?.reasoningEffort ?? '')
  const [botAvatar, setBotAvatar] = useState(editingBot?.avatar.seed ?? '🤖')
  const [botMentionOnly, setBotMentionOnly] = useState(editingBot?.mentionOnly ?? false)
  const [botPermission, setBotPermission] = useState<'read-only' | 'workspace-write' | 'full-access'>(editingBot?.permission ?? 'full-access')
  /**
   * Which tab of the bot dialog is showing. Identity first: that is what a new bot needs,
   * and the model route is prefilled from the deployment defaults.
   */
  const [botTab, setBotTab] = useState<'identity' | 'runtime'>('identity')
  const [botProvider, setBotProvider] = useState(editingBot?.provider ?? '')
  const [botModel, setBotModel] = useState(editingBot?.model ?? '')
  const [botWorkspace, setBotWorkspace] = useState(editingBot?.workspace ?? '')
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelError, setModelError] = useState<string>()
  /** Providers Settings configured but whose catalog could not be built. */
  const [modelFailures, setModelFailures] = useState<readonly ModelCatalogFailure[]>([])

  // Full-access risk confirmation. Full access is a ONE-TIME authorization: the bot is already
  // persisted with `permission: 'full-access'`, so the user granted it when they saved that.
  // Asking again on every visit to the settings form made a standing grant look like it had been
  // forgotten. The checkbox stays visible so it can still be revoked.
  const [fullAccessConfirm, setFullAccessConfirm] = useState((editingBot?.permission ?? '') === 'full-access')

  const [formError, setFormError] = useState<string>()

  // Room form fields
  const [roomName, setRoomName] = useState('')
  const [roomMembers, setRoomMembers] = useState<BotId[]>([])

  // Load the model catalog when the create/edit form opens.
  //
  // `modelCatalog()` rather than `listModelGroups()`: the form also needs the deployment
  // default (so a new Bot starts where Settings says) and the providers Settings has
  // configured but that are currently unavailable (so a missing one can be explained
  // instead of silently disappearing).
  useEffect(() => {
    if (!isBotMode) return
    let cancelled = false
    void (async () => {
      setModelsLoading(true)
      try {
        const catalog = await remote.modelCatalog()
        if (cancelled) return
        setModelGroups([...catalog.groups])
        setModelFailures(catalog.failures)
        // Pre-select provider/model/effort only when creating; editing keeps existing values.
        if (editingBot === undefined) {
          const defaultGroup = catalog.default !== undefined
            ? catalog.groups.find(g => g.id === catalog.default?.provider)
            : undefined
          const defaultModel = catalog.default !== undefined
            ? defaultGroup?.models.find(m => m.id === catalog.default?.model)
            : undefined
          const fallbackGroup = defaultGroup ?? catalog.groups[0]
          const fallbackModel = defaultModel ?? fallbackGroup?.models[0]
          setBotProvider(prev => (prev !== '' && catalog.groups.some(g => g.id === prev) ? prev : fallbackGroup?.id ?? ''))
          setBotModel(prev => (prev !== '' ? prev : fallbackModel?.id ?? ''))
          // The level a new Bot starts with is the one its default model publishes.
          const published = fallbackModel?.reasoning?.efforts ?? []
          const publishedDefault = fallbackModel?.reasoning?.defaultEffort
          if (publishedDefault !== undefined && published.some(e => e.id === publishedDefault)) {
            setBotEffort(publishedDefault)
          } else if (published.length > 0) {
            setBotEffort(published[0]!.id)
          } else if (catalog.default?.reasoningEffort !== undefined) {
            setBotEffort(catalog.default.reasoningEffort)
          }
        }
        setModelError(undefined)
      } catch (e) {
        if (!cancelled) setModelError(describe(e))
      }
      if (!cancelled) setModelsLoading(false)
    })()
    return () => { cancelled = true }
  }, [isBotMode, remote, editingBot, setModelGroups])

  // When opening the create-bot form, pre-fill workspace with DSH default
  useEffect(() => {
    if (isBotMode && editingBot === undefined && botWorkspace === '' && defaultWorkspace !== '') {
      setBotWorkspace(defaultWorkspace)
    }
  }, [isBotMode, editingBot, botWorkspace, defaultWorkspace])

  async function handlePickWorkspace() {
    try {
      const picked = await remote.pickDirectory()
      if (picked !== null) setBotWorkspace(picked)
    } catch (e) {
      setFormError(describe(e))
    }
  }

  /**
   * Display rules for everything model-related in this form.
   *
   * A provider label is Settings' display name, disambiguated by provider id only when two
   * routes share one name. A model name is Settings' name. Reasoning levels are the ones
   * THIS model publishes. Nothing here names a vendor, a model or a fixed set of levels.
   */
  function providerLabelOf(group: ModelGroup): string {
    const name = group.name ?? group.label ?? group.id
    const clashes = modelGroups.filter(other => (other.name ?? other.label ?? other.id) === name).length > 1
    return clashes ? `${name}（${group.id}）` : name
  }

  /** The reasoning levels `provider`/`model` publishes, and that model's own default. */
  function effortsFor(provider: string, model: string): {
    options: Array<{ id: string; name: string }>
    fallback: string
  } {
    const group = modelGroups.find(g => g.id === provider)
    const entry = group?.models.find(m => m.id === model)
    const efforts = entry?.reasoning?.efforts ?? []
    return {
      options: efforts.map(e => ({ id: e.id, name: e.name ?? e.id })),
      fallback: entry?.reasoning?.defaultEffort ?? '',
    }
  }

  /**
   * Move to the model's own default level when the current one is not offered.
   *
   * A model that publishes nothing falls back to `''` (provider default): keeping the previous
   * value there would preserve a level the route is guaranteed to reject, so opening the form
   * and saving would still leave a bot that cannot answer.
   */
  function alignEffort(provider: string, model: string, previous: string): string {
    const { options, fallback } = effortsFor(provider, model)
    if (options.some(option => option.id === previous)) return previous
    if (fallback !== '') return fallback
    return options.length === 0 ? '' : previous
  }

  function handleSelectProvider(next: string) {
    setBotProvider(next)
    const group = modelGroups.find(g => g.id === next)
    const firstModel = group?.models[0]?.id ?? ''
    setBotModel(firstModel)
    setBotEffort(prev => alignEffort(next, firstModel, prev))
  }

  async function handleCreateBot(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (botName.trim() === '') { setFormError('请填写名称'); return }
    if (botProvider === '' || botModel === '') { setFormError('请选择 Provider 和 Model'); return }
    if (botPermission === 'full-access' && !fullAccessConfirm) { setFormError('完全权限需要勾选风险确认'); return }
    setBusy(true)
    setFormError(undefined)
    setNotice(undefined)
    try {
      if (editingBot !== undefined) {
        await remote.updateBot({
          id: editingBot.id,
          name: botName.trim(),
          description: botDesc,
          systemPrompt: botPrompt,
          avatarSeed: botAvatar,
          mentionOnly: botMentionOnly,
          permission: botPermission,
          reasoningEffort: botEffort,
          ...(botProvider.trim() !== '' ? { provider: botProvider.trim() } : {}),
          ...(botModel.trim() !== '' ? { model: botModel.trim() } : {}),
          ...(botWorkspace.trim() !== '' ? { workspace: botWorkspace.trim() } : {}),
        })
      } else {
        const bot = await remote.createBot({
          name: botName.trim(),
          description: botDesc,
          systemPrompt: botPrompt,
          avatarSeed: botAvatar,
          mentionOnly: botMentionOnly,
          permission: botPermission,
          reasoningEffort: botEffort,
          ...(botProvider.trim() !== '' ? { provider: botProvider.trim() } : {}),
          ...(botModel.trim() !== '' ? { model: botModel.trim() } : {}),
          ...(botWorkspace.trim() !== '' ? { workspace: botWorkspace.trim() } : {}),
        })
        try {
          await remote.createRoom({ name: bot.name, directBotId: bot.id, memberIds: [bot.id] })
        } catch (roomError) {
          setNotice(`Bot「${bot.name}」已创建，但直聊房间创建失败：${describe(roomError)}`)
        }
      }
      onSaved()
    } catch (e) {
      setFormError(describe(e))
    }
    setBusy(false)
  }

  async function handleCreateRoom(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setFormError(undefined)
    setNotice(undefined)
    try {
      await remote.createRoom({ name: roomName.trim(), memberIds: roomMembers })
      onSaved()
    } catch (e) {
      setFormError(describe(e))
    }
    setBusy(false)
  }

  const toggleMember = (id: BotId) => {
    setRoomMembers(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id])
  }

  return (
    <NativeDialog
      open
      onClose={onClose}
      title={isBotMode ? (editingBot !== undefined ? `编辑 Bot：${editingBot.name}` : '新建 Bot') : '新建群聊'}
      description={isBotMode ? '身份决定它叫什么、怎么被路由；运行决定它用哪个模型、能改哪些文件。' : undefined}
      closeLabel="关闭"
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="outline" onClick={onClose}>取消</Button>
          {/* `type` must come after the primitive's own defaults — Button spreads rest over them. */}
          <Button variant="primary" type="submit" form={isBotMode ? 'bot-form' : 'room-form'} disabled={busy}>
            {busy ? (editingBot !== undefined ? '保存中…' : '创建中…') : (editingBot !== undefined ? '保存' : '创建')}
          </Button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
        {isBotMode ? (
          <form id="bot-form" className={css.form} onSubmit={handleCreateBot}>
            <DialogTabs
              idPrefix="ac-bot"
              label="Bot 设置"
              value={botTab}
              onChange={next => setBotTab(next === 'runtime' ? 'runtime' : 'identity')}
              tabs={[
                {
                  value: 'identity',
                  label: '身份',
                  content: (
                    <div className={css.form}>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>头像</span>
                        <div className={css.avatarRow}>
                          {AVATAR_EMOJIS.map(emoji => (
                            <button
                              key={emoji}
                              type="button"
                              className={css.avatarChoice}
                              data-active={botAvatar === emoji ? 'true' : undefined}
                              aria-pressed={botAvatar === emoji}
                              aria-label={`使用头像 ${emoji}`}
                              onClick={() => setBotAvatar(emoji)}
                            >{emoji}</button>
                          ))}
                        </div>
                        <span className={css.fieldHint}>用于区分不同成员</span>
                      </div>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>名称</span>
                        <Input className={css.textInput} type="text" value={botName} onChange={e => setBotName(e.target.value)} placeholder="例如：视觉设计师" required />
                        <span className={css.fieldHint}>出现在会话与成员列表里</span>
                      </div>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>描述</span>
                        <Input className={css.textInput} type="text" value={botDesc} onChange={e => setBotDesc(e.target.value)} placeholder="一句话说明它负责什么" />
                        <span className={css.fieldHint}>路由据此判断谁该回复</span>
                      </div>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>系统提示词</span>
                        <textarea className={css.textarea} value={botPrompt} onChange={e => setBotPrompt(e.target.value)} placeholder="你是一名…" />
                        <span className={css.fieldHint}>留空用默认人设，只影响这一个 Bot</span>
                      </div>
                    </div>
                  ),
                },
                {
                  value: 'runtime',
                  label: '运行',
                  content: (
                    <div className={css.form}>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>Provider</span>
                        <span className={css.rowControl}><select className={css.select} value={botProvider} onChange={e => handleSelectProvider(e.target.value)} disabled={modelsLoading || modelGroups.length === 0}>
                          {modelGroups.length === 0 && <option value="">{modelsLoading ? '加载中…' : '没有已配置的 Provider'}</option>}
                          {modelGroups.map(group => (
                            <option key={group.id} value={group.id}>{providerLabelOf(group)}</option>
                          ))}
                          {botProvider !== '' && !modelGroups.some(g => g.id === botProvider) && (
                            <option value={botProvider}>{botProvider}（当前值，设置中未列出）</option>
                          )}
                        </select></span>
                        {modelFailures.length > 0 && (
                          <span className={css.fieldHint}>
                            设置中另有 {modelFailures.length} 个提供方当前不可用：
                            {modelFailures.map(f => `${f.name ?? f.id}${f.message !== undefined ? `（${f.message}）` : ''}`).join('；')}
                          </span>
                        )}
                      </div>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>Model</span>
                        <span className={css.rowControl}><select
                          className={css.select}
                          value={botModel}
                          onChange={e => {
                            setBotModel(e.target.value)
                            setBotEffort(prev => alignEffort(botProvider, e.target.value, prev))
                          }}
                          disabled={modelsLoading || botProvider === ''}
                        >
                          {(modelGroups.find(g => g.id === botProvider)?.models ?? []).map(model => (
                            <option key={model.id} value={model.id}>{model.name ?? model.id}</option>
                          ))}
                          {botModel !== '' && !(modelGroups.find(g => g.id === botProvider)?.models ?? []).some(m => m.id === botModel) && (
                            <option value={botModel}>{botModel}（当前值，设置中未列出）</option>
                          )}
                        </select></span>
                        <span className={css.fieldHint}>{modelError !== undefined ? `读取失败：${modelError}` : '模型与提供方来自 DSH 设置，可随时切换'}</span>
                      </div>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>思考强度</span>
                        <span className={css.rowControl}><select className={css.select} value={botEffort} onChange={e => setBotEffort(e.target.value)}>
                          {(() => {
                            const published = effortsFor(botProvider, botModel).options
                            // Offer exactly what the route accepts. A model that publishes no
                            // levels accepts NONE of the classic off/low/high/max set — the host
                            // throws UNSUPPORTED_REASONING_EFFORT for any explicit value — so
                            // listing them here only lets the user create a bot that can never
                            // answer. '默认' (the empty id) is then the single valid choice.
                            const options = published
                            const items = [...options]
                            if (!items.some(o => o.id === '')) items.unshift({ id: '', name: '默认' })
                            if (botEffort !== '' && !items.some(o => o.id === botEffort)) {
                              items.unshift({ id: botEffort, name: `${botEffort}（当前值，设置中未列出）` })
                            }
                            return items.map(o => <option key={o.id === '' ? '__default' : o.id} value={o.id}>{o.name}</option>)
                          })()}
                        </select></span>
                        <span className={css.fieldHint}>档位由该模型在 DSH 设置中提供；越高越稳，也越慢</span>
                      </div>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>工作目录</span>
                        <div className={css.rowPair}>
                          <Input className={css.textInput} type="text" value={botWorkspace} onChange={e => setBotWorkspace(e.target.value)} placeholder={defaultWorkspace !== '' ? defaultWorkspace : '选择目录'} />
                          <Button className={css.pick} variant="outline" onClick={() => void handlePickWorkspace()} disabled={busy} icon={<IconFolderOpenRegular size={16} />}>选择</Button>
                        </div>
                        <span className={css.fieldHint}>读写文件与执行命令的根目录</span>
                      </div>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>权限</span>
                        <NativeSegmentedControl
                          id="ac-bot-permission"
                          label="权限"
                          value={botPermission}
                          onChange={(next: string) => { setBotPermission(next as 'read-only' | 'workspace-write' | 'full-access'); if (next !== 'full-access') setFullAccessConfirm(false) }}
                          options={[
                            { value: 'read-only', label: '仅查看' },
                            { value: 'workspace-write', label: '工作区内' },
                            { value: 'full-access', label: '完全权限' },
                          ]}
                        />
                        <span className={css.fieldHint}>
                          {botPermission === 'read-only'
                            ? '只能读取文件，不能写文件或执行命令'
                            : botPermission === 'workspace-write'
                              ? '只能在 Bot 工作目录内写文件'
                              : '无沙箱限制：可执行任意命令、修改任意文件'}
                        </span>
                        {botPermission === 'full-access' && (
                          <NativeCheckbox
                            checked={fullAccessConfirm}
                            onChange={setFullAccessConfirm}
                            label="我已了解风险：可执行任意命令、修改任意文件"
                          />
                        )}
                      </div>
                      <div className={css.field}>
                        <NativeCheckbox checked={botMentionOnly} onChange={setBotMentionOnly} label="仅在被 @ 时响应" />
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          </form>
        ) : (
          <form id="room-form" className={css.formLegacy} onSubmit={handleCreateRoom}>
            <label>群聊名称 <input type="text" value={roomName} onChange={e => setRoomName(e.target.value)} required /></label>
            <fieldset className={css.members}>
              <legend>添加成员</legend>
              {visibleBots.length === 0
                ? <p className={css.formHint} style={{ margin: '4px 0' }}>还没有 Bot。先切到「Bots」标签创建一个，再回来把它加进群聊。</p>
                : visibleBots.map(bot => (
                  <label key={bot.id} className={css.check}>
                    <input type="checkbox" checked={roomMembers.includes(bot.id)} onChange={() => toggleMember(bot.id)} />
                    {bot.avatar.seed} {bot.name}
                    <small>{bot.description}</small>
                  </label>
                ))}
            </fieldset>
          </form>
        )}
        {formError !== undefined && (
          <div className={css.error} style={{ marginTop: 12 }}>{formError}</div>
        )}
      </div>
    </NativeDialog>
  )
}
