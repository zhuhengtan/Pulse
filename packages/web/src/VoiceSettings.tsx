import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, AutoComplete, Button, Card, Collapse, Input, InputNumber, Select, Switch, Tag, Progress, Tabs } from 'antd'
import { usePulseDialogs } from './PulseControls.js'
import type { PulseWebTransport } from './transport.js'
import './voice-settings.css'

type Connection = { backend?: 'local' | 'external'; baseURL: string; model: string; voice?: string; language?: string; speed?: number; credentialRef?: string }
type Config = { enabled: boolean; wakeEnabled?: boolean; autoSpeak?: boolean; name: string; microphoneId: string; speakerId?: string; followupSeconds: number; speakerThreshold: number; wakeThreshold: number; asr: Connection; tts: Connection }
type LocalInstall = { upgradeAvailable?: boolean; ready: boolean; installing: boolean; stage?: string; received?: number; total?: number; error?: string }
type Status = { outputDevices?: Array<{ id: string; label: string }>; outputState?: { state: 'ready' | 'unavailable' | 'error'; deviceId: string }; wakeEnabled?: boolean; localSpeech?: { asr: LocalInstall; tts: LocalInstall; voices: Array<{ id: string; name: string }>; models: { asr: string; tts: string } }; connection?: Connection; status: string; running: boolean; modelsReady: boolean; enrolled: boolean; paused: boolean; devices: Array<{ id: string; label: string }>; capturePeak?: number; maxAudioPeak?: number; samplesReceived?: number; lastAudioAt?: number }
type Keys = { asrKey?: string | null; ttsKey?: string | null }
type Kind = 'asr' | 'tts'

function failure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/VOICE_LOCAL_BACKEND_UPDATE_REQUIRED/.test(text)) return '当前后台尚未加载本地模型安装功能，请更新并重启后台后重试。仅重新打开桌面窗口不会更新后台。'
  if (/VOICE_ACTION_INVALID|VOICE_WAKE_SETTING_UPDATE_REQUIRED/.test(text)) return '当前桌面或后台尚未加载独立唤醒开关，请运行 restart-dev 后重试。'
  if (/VOICE_DESKTOP_REQUIRED/.test(text)) return '本地模型请在 Pulse 桌面客户端使用。'
  if (/VOICE_LOCAL_MODEL_NOT_INSTALLED/.test(text)) return '请先完成本地模型安装。'
  if (/VOICE_LOCAL_NODE_REQUIRED/.test(text)) return '未找到本地推理运行时，请使用完整桌面安装包或配置 PULSE_VOICE_NODE。'
  if (/VOICE_LOCAL_(PROCESS_STOPPED|START_TIMEOUT|REQUEST_TIMEOUT)/.test(text)) return '本地语音进程已停止或超时，请重试；未发送的语音不会自动重发。'
  if (/VOICE_LOCAL_LANGUAGE_INVALID/.test(text)) return '请检查识别语言。SenseVoice 支持中文、英文、粤语、日语和韩语；其他语言可连接已有识别服务。'
  if (/VOICE_LOCAL_VOICE_INVALID/.test(text)) return '请从本地音色列表重新选择回复音色。'
  if (/VOICE_MODEL_(DOWNLOAD_FAILED|SIZE_INVALID)/.test(text)) return '模型下载失败，请检查网络后重试。'
  if (/VOICE_MODEL_DOWNLOAD_TIMEOUT/.test(text)) return '下载超时，请检查网络后重试。'
  if (/VOICE_MODEL_CHECKSUM_MISMATCH/.test(text)) return '模型校验失败，请重新安装。'
  if (/VOICE_REMOTE_SERVICE_REQUIRES_HTTPS/.test(text)) return '线上服务请使用 HTTPS，本机服务可使用 HTTP。'
  if (/VOICE_SERVICE_URL_INVALID/.test(text)) return '请检查服务地址，不要包含账号、密码或查询参数。'
  if (/VOICE_.*_HTTP_401/.test(text)) return '服务认证失败，请检查 API Key。'
  if (/VOICE_.*_HTTP_404/.test(text)) return '未找到服务接口，请检查服务地址是否包含 /v1。'
  return text
}

export function VoiceSettings({ transport, canManage, onDirtyChange }: { transport: PulseWebTransport; canManage: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const dialogs = usePulseDialogs()
  const preview = useRef<HTMLAudioElement | undefined>(undefined)
  const desktopPreview = useRef(false)
  const previewRevision = useRef(0)
  const stopPreview = () => { previewRevision.current++; const audio = preview.current; preview.current = undefined; audio?.pause(); if (desktopPreview.current) { desktopPreview.current = false; void transport.request('/api/desktop/voice/preview-stop', { method: 'POST', body: '{}' }).catch(() => {}) } }
  const alive = useRef(true)
  const statusRevision = useRef(0)
  const [config, setConfig] = useState<Config>()
  const [saved, setSaved] = useState<Config>()
  const [status, setStatus] = useState<Status>()
  const [keys, setKeys] = useState<Keys>({})
  const [busy, setBusy] = useState('')
  const [activeTab, setActiveTab] = useState('models')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [models, setModels] = useState<Partial<Record<Kind, string[]>>>({})
  const desktop = Boolean(window.pulseDesktop)
  const dirty = Boolean(config && saved && (JSON.stringify(config) !== JSON.stringify(saved) || Object.values(keys).some(value => value === null || Boolean(value?.trim()))))
  useEffect(() => { alive.current = true; return () => { alive.current = false; stopPreview() } }, [])
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  const api = useCallback(async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await transport.request(path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? `请求失败 ${response.status}`)
    return result as T
  }, [transport])
  const load = useCallback(async () => {
    setError('')
    try { const value = await api<Config>('/api/voice/config'); if (alive.current) { setConfig(value); setSaved(value) } }
    catch (cause) { if (alive.current) setError(failure(cause)) }
  }, [api])
  useEffect(() => { if (canManage) void load() }, [canManage, load])
  useEffect(() => {
    if (!canManage || !desktop) return
    let cancelled = false, pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      const revision = statusRevision.current
      try { const value = await api<Status>('/api/desktop/voice/status'); if (!cancelled && revision === statusRevision.current) setStatus(value) }
      catch { if (!cancelled && revision === statusRevision.current) setStatus(undefined) }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [api, canManage, desktop])

  const run = async (name: string, work: () => Promise<void>) => {
    if (busy) return
    setBusy(name); setError(''); setNotice('')
    try { await work() } catch (cause) { if (alive.current) setError(failure(cause)) }
    finally { if (alive.current) setBusy('') }
  }
  const patch = (value: Partial<Config>) => { setConfig(current => current ? { ...current, ...value } : current); setNotice('') }
  const connection = (kind: Kind, value: Partial<Connection>) => { if (config) patch({ [kind]: { ...config[kind], ...value } }) }
  const persist = async (configToSave = config) => {
    const config = configToSave
    if (!config || !dirty && JSON.stringify(config) === JSON.stringify(saved)) return
    if (config.name.trim().length < 2) throw new Error('助手名字请填写 2–30 个字符。')
    for (const kind of ['asr', 'tts'] as const) {
      if (config[kind].backend === 'local') continue
      let url: URL
      try { url = new URL(config[kind].baseURL) } catch { throw new Error(`${kind === 'asr' ? '语音识别' : '语音播报'}的服务地址格式不正确。`) }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('VOICE_SERVICE_URL_INVALID')
      if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('VOICE_REMOTE_SERVICE_REQUIRES_HTTPS')
    }
    const credentials: Keys = {}
    for (const kind of ['asr', 'tts'] as const) {
      const value = keys[`${kind}Key`]
      if (value === null) credentials[`${kind}Key`] = null
      else if (value?.trim()) credentials[`${kind}Key`] = value.trim()
    }
    const value = await api<Config>('/api/voice/config', { ...config, ...credentials })
    if (alive.current) { setConfig(value); setSaved(value); setKeys({}); setNotice('设置已保存') }
  }
  const toggleEnabled = (enabled: boolean) => run('toggle', async () => {
    if (!saved) return
    // The switch takes effect immediately without saving unrelated, unfinished fields.
    const value = await api<Config>('/api/voice/config', { ...saved, enabled })
    if (!alive.current) return
    setSaved(value)
    setConfig(current => current ? { ...current, enabled } : value)
    if (!enabled) stopPreview()
    if (desktop) {
      statusRevision.current++
      const next = await api<Status>(`/api/desktop/voice/${enabled ? 'resume' : 'pause'}`, {})
      if (alive.current) setStatus(next)
    }
  })
  const setupAction = (name: string) => run(name, async () => {
    await persist()
    statusRevision.current++
    const value = await api<Status>(`/api/desktop/voice/${name}`, {})
    if (alive.current) setStatus(value)
  })
  const runtimeAction = (name: string) => run(name, async () => {
    if (name === 'stop') stopPreview()
    statusRevision.current++
    const value = await api<Status>(`/api/desktop/voice/${name}`, {})
    if (alive.current) setStatus(value)
  })
  const toggleAutoSpeak = (autoSpeak: boolean) => run('auto-speak', async () => {
    if (!saved) return
    const value = await api<Config>('/api/voice/config', { ...saved, autoSpeak })
    if (!alive.current) return
    setSaved(value)
    setConfig(current => current ? { ...current, autoSpeak: value.autoSpeak ?? autoSpeak } : value)
    if (!autoSpeak) stopPreview()
    statusRevision.current++
    const next = await api<Status>('/api/desktop/voice/speech-settings', {})
    if (alive.current) setStatus(next)
  })
  const toggleWake = (wakeEnabled: boolean) => run('wake', async () => {
    statusRevision.current++
    const next = await api<Status>('/api/desktop/voice/wake-settings', { enabled: wakeEnabled })
    if (next.wakeEnabled !== wakeEnabled) throw new Error('VOICE_WAKE_SETTING_UPDATE_REQUIRED')
    if (!alive.current) return
    setStatus(next)
    setSaved(current => current ? { ...current, wakeEnabled } : current)
    setConfig(current => current ? { ...current, wakeEnabled } : current)
  })
  const install = (kind: Kind) => run(`install-${kind}`, async () => {
    statusRevision.current++
    const result = await api<Status>(`/api/desktop/voice/install-${kind}`, {})
    if (!alive.current) return
    setStatus(result)
    if (result.connection) {
      const value = result.connection
      setConfig(current => current ? { ...current, [kind]: value } : current)
      setSaved(current => current ? { ...current, [kind]: value } : current)
      setKeys(current => { const next = { ...current }; delete next[`${kind}Key`]; return next })
    }
  })
  const test = (kind: Kind) => run(kind, async () => {
    await persist()
    const result = await api<{ models: string[] }>('/api/voice/test', { kind })
    if (alive.current) { setModels(current => ({ ...current, [kind]: result.models })); setNotice(`${kind === 'asr' ? '语音识别' : '语音播报'}连接成功${result.models.length ? '，可从模型列表选择模型。' : '。服务未返回模型列表，可手动填写。'}`) }
  })
  const start = () => run('resume', async () => {
    if (!config) return
    if (!config.asr.model.trim() || !config.tts.model.trim() || !config.tts.voice?.trim()) throw new Error('请先填写识别模型、播报模型和音色。')
    await persist()
    statusRevision.current++
    const persistentWake = saved?.wakeEnabled !== undefined && status?.wakeEnabled !== undefined
    const value = await api<Status>(persistentWake ? '/api/desktop/voice/wake-settings' : '/api/desktop/voice/resume', persistentWake ? { enabled: true } : {})
    if (alive.current) {
      setStatus(value)
      const wakeEnabled = value.wakeEnabled
      if (wakeEnabled !== undefined) {
        setConfig(current => current ? { ...current, wakeEnabled } : current)
        setSaved(current => current ? { ...current, wakeEnabled } : current)
      }
    }
  })
  const listen = () => run('preview', async () => {
    stopPreview()
    const revision = previewRevision.current
    await persist()
    const result = await api<{ audio: string; mime: string }>('/api/voice/speech', { text: '你好，我是你的语音助手。' })
    if (!alive.current || previewRevision.current !== revision) return
    if (desktop && config?.speakerId) {
      desktopPreview.current = true
      try { await api('/api/desktop/voice/preview-output', result) } finally { desktopPreview.current = false }
      if (alive.current && previewRevision.current === revision) setNotice('试听已完成')
      return
    }
    const audio = preview.current = new Audio(`data:${result.mime};base64,${result.audio}`)
    if (config?.speakerId) {
      const routed = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
      if (!routed.setSinkId) throw new Error('当前环境不支持指定扬声器，请选择系统默认。')
      await routed.setSinkId(config.speakerId)
      if (!alive.current || preview.current !== audio || previewRevision.current !== revision) return
    }
    await audio.play()
    if (alive.current) setNotice('正在试听音色')
  })

  if (!canManage) return <Alert type="info" title="请在本机设置语音助手。" />
  if (!config) return <div className="voice-settings"><Alert type={error ? 'error' : 'info'} title={error || '正在读取语音设置…'} />{error && <Button onClick={() => void load()}>重新加载</Button>}</div>
  const savedAction = (text: string) => dirty ? `保存并${text}` : text
  const operationDisabled = Boolean(busy)
  const wakeSettingsSupported = saved?.wakeEnabled !== undefined && status?.wakeEnabled !== undefined
  return <div className="voice-settings">
    <Card className="settings-card" variant="outlined">
      <div className="voice-overview"><div><h2 id="voice-enabled-label">启用语音助手</h2><p>开启后配置模型与语音服务，默认仅按住说话，不持续占用麦克风。</p></div><Switch aria-labelledby="voice-enabled-label" checked={config.enabled} loading={busy === 'toggle'} disabled={operationDisabled} onChange={enabled => void toggleEnabled(enabled)}/></div>
      <div className="voice-status" role="status"><Tag>{saved?.enabled ? status?.paused ? '已暂停' : status?.running ? '已开启' : '等待启动' : '已关闭'}</Tag><span>{!config.enabled ? '语音助手已关闭' : desktop ? status?.status ?? '正在连接桌面后台…' : '当前是网页端，可配置服务；唤醒和声纹录入请在桌面客户端完成。'}</span></div>
      {config.enabled && <p className="voice-hint">运行开关立即生效；标签页内的配置修改需保存。聊天中按住说话，松开释放麦克风；只有单独开启后台名字唤醒后，关闭窗口仍会持续收听。</p>}
      {!config.enabled && dirty && <p className="voice-hint">有未保存的配置，重新开启后可继续编辑。</p>}
      {config.enabled && desktop && <div className="voice-runtime-controls" role="group" aria-label="语音运行设置">
        <div className="voice-runtime-control"><span id="voice-listening-label">后台名字唤醒</span><Switch aria-labelledby="voice-listening-label" checked={!wakeSettingsSupported ? Boolean(status?.running && !status.paused) : config.wakeEnabled === true} loading={['wake', 'pause', 'resume'].includes(busy)} disabled={operationDisabled || !status} onChange={enabled => void (!wakeSettingsSupported ? runtimeAction(enabled ? 'resume' : 'pause') : toggleWake(enabled))}/><small>{!wakeSettingsSupported ? '当前旧版桌面或后台可临时暂停收听；重启开发版后支持保存选择。' : '默认关闭；开启后持续使用麦克风，系统会显示使用提示。选择会保存，重启后仍生效。'}</small></div>
        <div className="voice-runtime-control"><span id="voice-auto-speak-label">自动播报</span><Switch aria-labelledby="voice-auto-speak-label" checked={config.autoSpeak !== false} loading={busy === 'auto-speak'} disabled={operationDisabled || saved?.autoSpeak === undefined} onChange={enabled => void toggleAutoSpeak(enabled)}/><small>{saved?.autoSpeak === undefined ? '当前后台需更新并重启后才能切换；目前仍自动播报。' : '仅播报语音提问的回复；关闭时停止当前播放。'}</small></div>
      </div>}
    </Card>
    {error && <Alert type="error" showIcon title={error} role="alert" />}
    {notice && <Alert type="success" showIcon title={notice} role="status" />}
    {config.enabled && <Tabs className="voice-tabs" aria-label="语音助手设置" activeKey={activeTab} onChange={setActiveTab} animated={false} destroyOnHidden items={[
      { key: 'models', label: '模型配置', children: <div className="voice-tab-content">
    <Card className="settings-card" variant="outlined" title="唤醒与声纹模型">
      <div className="voice-setup-row"><div><strong>唤醒与声纹模型 <Tag>{status?.modelsReady ? '已就绪' : '未准备'}</Tag></strong><p>约 73 MB，仅包含唤醒、声纹和语音活动检测，不含语音识别或语音合成模型。可直接下载，无需先填写其他配置。</p></div><Button loading={busy === 'models'} disabled={operationDisabled || !desktop} type={status?.modelsReady ? 'default' : 'primary'} onClick={() => void runtimeAction('models')}>{status?.modelsReady ? '校验本地模型' : '下载唤醒与声纹模型'}</Button></div>
    </Card>
    <Card className="settings-card" variant="outlined" title="语音识别与播报">
      <p className="voice-hint">可以一键安装免费本地识别与播报模型，也可以连接已有的语音服务。首次安装需要联网，安装后可离线使用。</p>
      <div className="voice-services">{(['asr', 'tts'] as const).map(kind => <section className="voice-service" key={kind} aria-label={kind === 'asr' ? '语音识别服务' : '语音播报服务'}>
        <h3>{kind === 'asr' ? '语音识别' : '语音播报'}</h3>
        <div className="voice-local-install">
          <div className="voice-setup-row"><div><strong>{kind === 'asr' ? 'SenseVoice Small · 语音识别' : 'Kokoro · 中文与英文播报'}<Tag>{status?.localSpeech?.[kind].installing ? '安装中' : status?.localSpeech?.[kind].upgradeAvailable ? kind === 'asr' ? 'Whisper Base · 可升级' : '紧凑版 · 可升级' : status?.localSpeech?.[kind].ready ? '已安装' : '未安装'}</Tag></strong><p>{kind === 'asr' ? '约 163 MB，支持中文、英文、粤语、日语和韩语。默认按中文识别并输出简体。' : '约 350 MB，标准音质，提供多种中文和英文音色。'}本地运行无需 API Key。</p></div><Button type={config[kind].backend === 'local' ? 'default' : 'primary'} loading={busy === `install-${kind}` || Boolean(status?.localSpeech?.[kind].installing)} disabled={operationDisabled || !desktop || !status?.localSpeech || status.localSpeech[kind].installing} onClick={() => void install(kind)}>{status?.localSpeech?.[kind].upgradeAvailable ? kind === 'asr' ? '升级中文识别' : '升级播报音质' : status?.localSpeech?.[kind].ready ? '使用本地模型' : status?.localSpeech?.[kind].error ? '重试安装' : kind === 'asr' ? '一键安装识别模型' : '一键安装播报模型'}</Button></div>
          {!desktop && <p className="voice-hint">请在桌面客户端安装本地模型。</p>}
          {status?.localSpeech?.[kind].installing && <div role="status"><Progress size="small" percent={Math.min(100, Math.round((status.localSpeech[kind].received ?? 0) / (status.localSpeech[kind].total || 1) * 100))}/><p className="voice-hint">{status.localSpeech[kind].stage ?? '准备安装…'}</p></div>}
          {status?.localSpeech?.[kind].error && <Alert type="error" title={failure(status.localSpeech[kind].error)} />}
        </div>
        <fieldset disabled={operationDisabled || Boolean(status?.localSpeech?.[kind].installing)} className="voice-fields">
          <label htmlFor={`voice-${kind}-backend`}>运行方式<Select id={`voice-${kind}-backend`} disabled={operationDisabled || Boolean(status?.localSpeech?.[kind].installing)} value={config[kind].backend === 'local' ? 'local' : 'external'} options={[{ value: 'local', label: 'Pulse 本地模型', disabled: !status?.localSpeech?.[kind].ready }, { value: 'external', label: '连接已有服务' }]} onChange={(backend: 'local' | 'external') => connection(kind, { backend, model: backend === 'local' ? kind === 'asr' ? status?.localSpeech?.asr.upgradeAvailable ? 'pulse-whisper-base' : 'pulse-sensevoice-small' : 'pulse-kokoro-zh-en' : '', ...(kind === 'tts' ? { voice: backend === 'local' ? '45' : 'af_heart' } : {}) })}/></label>
          {config[kind].backend !== 'local' && <>

          <label htmlFor={`voice-${kind}-url`}>服务地址<Input id={`voice-${kind}-url`} value={config[kind].baseURL} placeholder="http://127.0.0.1:8000/v1" onChange={event => connection(kind, { baseURL: event.target.value })}/></label>
          <label htmlFor={`voice-${kind}-key`}>API Key<Input.Password id={`voice-${kind}-key`} autoComplete="off" value={keys[`${kind}Key`] ?? ''} placeholder={keys[`${kind}Key`] === null ? '保存后删除已存密钥' : config[kind].credentialRef ? '已保存；留空保留' : '本地服务可留空'} onChange={event => { setKeys(current => ({ ...current, [`${kind}Key`]: event.target.value })); setNotice('') }}/></label>
          {config[kind].credentialRef && <Button type="link" danger={keys[`${kind}Key`] !== null} onClick={() => setKeys(current => ({ ...current, [`${kind}Key`]: current[`${kind}Key`] === null ? undefined : null }))}>{keys[`${kind}Key`] === null ? '撤销删除密钥' : '删除已保存的 Key'}</Button>}
          <label htmlFor={`voice-${kind}-model`}>模型<AutoComplete disabled={operationDisabled} id={`voice-${kind}-model`} value={config[kind].model} options={(models[kind] ?? []).map(value => ({ value }))} placeholder={kind === 'asr' ? '例如 whisper-1' : '例如 kokoro'} onChange={model => connection(kind, { model })}/></label>
          </>}
          <div className="voice-actions"><Button loading={busy === kind} disabled={operationDisabled || Boolean(status?.localSpeech?.[kind].installing) || config[kind].backend === 'local' && !status?.localSpeech?.[kind].ready} onClick={() => void test(kind)}>{savedAction('测试连接')}</Button></div>
          {kind === 'tts' && <><label htmlFor="voice-tone">回复音色{config.tts.backend === 'local' ? <Select id="voice-tone" disabled={operationDisabled || Boolean(status?.localSpeech?.tts.installing)} value={config.tts.voice ?? '45'} options={(status?.localSpeech?.voices ?? []).map(voice => ({ value: voice.id, label: voice.name }))} onChange={voice => connection('tts', { voice })}/> : <Input id="voice-tone" value={config.tts.voice ?? ''} placeholder="例如 af_heart" onChange={event => connection('tts', { voice: event.target.value })}/>}</label><div className="voice-actions"><Button loading={busy === 'preview'} disabled={operationDisabled || Boolean(status?.localSpeech?.tts.installing) || config.tts.backend === 'local' && !status?.localSpeech?.tts.ready || !config.tts.model.trim() || !config.tts.voice?.trim()} onClick={() => void listen()}>{savedAction('试听音色')}</Button></div></>}
        </fieldset>
      </section>)}</div>
    </Card>
    <Card className="settings-card" variant="outlined"><Collapse ghost items={[
      { key: 'parameters', label: '模型参数', children: <fieldset disabled={operationDisabled} className="voice-fields voice-advanced">
      <label htmlFor="voice-language">识别语言{config.asr.backend === 'local' ? <Select id="voice-language" disabled={operationDisabled} value={config.asr.language?.trim() || 'zh'} options={[{ value: 'zh', label: '中文（简体，默认）' }, { value: 'zh-Hant', label: '中文（繁体）' }, { value: 'auto', label: '自动检测语言' }, { value: 'en', label: 'English' }, { value: 'yue', label: '粤语' }, { value: 'ja', label: '日本語' }, { value: 'ko', label: '한국어' }]} onChange={language => connection('asr', { language })}/> : <Input id="voice-language" value={config.asr.language ?? ''} placeholder="留空由服务自动识别，例如 zh" onChange={event => connection('asr', { language: event.target.value })}/>}</label>
      <label htmlFor="voice-speed">播报语速<InputNumber id="voice-speed" min={0.25} max={4} step={0.05} value={config.tts.speed ?? 1} onChange={value => { if (value !== null) connection('tts', { speed: value }) }}/></label>
      </fieldset> },
      { key: 'help', label: '服务接入与隐私说明', children: <div className="voice-help"><p>可连接 OpenAI 兼容服务；服务地址需包含 /v1。两项可使用不同的服务和密钥。</p><p>本地部署可参考 <a href="https://speaches.ai/installation/" target="_blank" rel="noreferrer">Speaches 安装说明</a>，如果使用其服务，安装模型后在此填写模型与音色。上方一键安装使用 Pulse 自带的推理运行时，不依赖 Speaches、Python 或 Ollama。</p><p>本地模式的识别与播报均在本机运行。选择外部服务时，唤醒后且匹配主人声纹的语句会发送给识别服务，回复文字会发送给播报服务。环境音仅在本机处理，原始录音默认不保存。</p><p>说“停止”可停止播报；说“结束对话”返回等待唤醒。停止播放不会取消聊天任务。</p></div> },
    ]} /></Card>
      </div> },
      { key: 'wake', label: '唤醒与声纹', children: <div className="voice-tab-content">
        {desktop && status && !status.modelsReady && <Alert type="info" showIcon title="请先下载唤醒与声纹模型，再启动后台并录入声纹。" action={<Button onClick={() => setActiveTab('models')}>前往模型配置</Button>}/>}
    <Card className="settings-card" variant="outlined" title="唤醒设置">
      <fieldset disabled={operationDisabled} className="voice-fields">
        <label htmlFor="voice-name">助手名字<Input id="voice-name" aria-label="助手名字" value={config.name} maxLength={30} onChange={event => patch({ name: event.target.value })}/><small>叫出这个名字后开始对话，支持中文和英文。</small></label>
        <label htmlFor="voice-microphone">麦克风<Select disabled={operationDisabled} id="voice-microphone" value={config.microphoneId} options={[{ value: '', label: '系统默认' }, ...(status?.devices ?? []).map(device => ({ value: device.id, label: device.label || '未命名麦克风' }))]} onChange={microphoneId => patch({ microphoneId })}/></label>
        <label htmlFor="voice-speaker">播报扬声器<Select disabled={operationDisabled || !desktop} id="voice-speaker" value={config.speakerId ?? ''} options={[{ value: '', label: '系统默认' }, ...(status?.outputDevices ?? []).map(device => ({ value: device.id, label: device.label || '未命名扬声器' })), ...(config.speakerId && !(status?.outputDevices ?? []).some(device => device.id === config.speakerId) ? [{ value: config.speakerId, label: '已保存的扬声器（当前不可用）' }] : [])]} onChange={speakerId => patch({ speakerId })}/><small>独立于麦克风。指定设备断开时停止播报，不自动改用其他扬声器，也不重播旧回复。</small></label>
        {desktop && <Button disabled={operationDisabled} loading={busy === 'list-devices'} onClick={() => void runtimeAction('list-devices')}>刷新音频设备（不打开麦克风）</Button>}
        {status?.outputState?.state === 'unavailable' && config.speakerId && <small role="status">指定输出尚未在线；重新连接后刷新，或选择系统默认。麦克风断线后请使用恢复收听。</small>}
      </fieldset>
      {desktop && status && <div className="voice-capture-status" role="status" aria-label="麦克风收音状态">
        <strong>麦克风输入 <Tag>{!status.running ? '未收听' : !status.lastAudioAt || Date.now() - status.lastAudioAt > 5000 ? '未收到音频' : status.capturePeak === 0 ? '输入静音' : '正在采集'}</Tag></strong>
        <Progress aria-label="麦克风输入强度" size="small" percent={Math.min(100, Math.round((status.capturePeak ?? 0) * 100))}/>
        <p className="voice-hint">累计收到 {((status.samplesReceived ?? 0) / 16000).toFixed(1)} 秒音频，最近输入峰值 {(status.capturePeak ?? 0).toFixed(4)}，最高峰值 {(status.maxAudioPeak ?? 0).toFixed(4)}。说出助手名字时应看到输入强度变化。</p>
      </div>}
    </Card>
    <Card className="settings-card" variant="outlined" title="主人声纹">
      {!status?.running && <div className="voice-start"><p className="voice-hint">如后台尚未运行，准备模型后可在这里启动；启动时会申请麦克风权限。</p><Button type="primary" loading={busy === 'resume'} disabled={operationDisabled || !desktop || !status?.modelsReady} onClick={() => void start()}>{dirty ? '保存并启动助手' : '启动语音后台'}</Button></div>}
      <div className="voice-setup-row"><div><strong>主人声纹 <Tag>{status?.enrolled ? '已录入' : '未录入'}</Tag></strong><p>{!desktop ? '请在桌面客户端录入。' : !status?.running ? '启动语音后台后，可录入声纹。录入前不会提交语音指令。' : '点击录入后连续说话至少两秒，再停顿。录入成功后，叫出助手名字即可测试唤醒。'}</p></div><div className="voice-actions"><Button loading={busy === 'enroll'} disabled={operationDisabled || !desktop || !status?.running} onClick={() => void setupAction('enroll')}>{savedAction(status?.enrolled ? '重新录入' : '录入声纹')}</Button>{status?.enrolled && <Button danger disabled={operationDisabled} onClick={() => void run('forget', async () => { if (await dialogs.confirm('删除主人声纹？删除后需要重新录入才能使用语音对话。')) { statusRevision.current++; setStatus(await api<Status>('/api/desktop/voice/forget', {})) } })}>删除声纹</Button>}</div></div>
      <div className="voice-actions"><Button disabled={operationDisabled || !desktop || !status?.running} onClick={() => void setupAction('record-test')}>{savedAction('录音测试')}</Button><span className="voice-hint">录音 5 秒后显示转写结果，不发送聊天。</span></div>
    </Card>
    <Card className="settings-card" variant="outlined"><Collapse ghost items={[{ key: 'advanced', label: '高级设置', children: <fieldset disabled={operationDisabled} className="voice-fields voice-advanced">
      <label htmlFor="voice-followup">连续追问时间（秒）<InputNumber id="voice-followup" min={5} max={120} value={config.followupSeconds} onChange={value => { if (value !== null) patch({ followupSeconds: value }) }}/></label>
      <label htmlFor="voice-speaker-threshold">声纹匹配阈值<InputNumber id="voice-speaker-threshold" min={0.1} max={0.95} step={0.05} value={config.speakerThreshold} onChange={value => { if (value !== null) patch({ speakerThreshold: value }) }}/></label>
      <label htmlFor="voice-wake-threshold">唤醒阈值<InputNumber id="voice-wake-threshold" min={0.05} max={0.95} step={0.05} value={config.wakeThreshold} onChange={value => { if (value !== null) patch({ wakeThreshold: value }) }}/></label>
    </fieldset> }]} /></Card>
      </div> },
    ]} />}
    {config.enabled && <footer className="settings-actions voice-footer"><span>{dirty ? '有未保存的修改' : '设置已保存'}</span><Button disabled={!dirty || operationDisabled} onClick={() => { setConfig(saved); setKeys({}); setError(''); setNotice('') }}>取消修改</Button><Button type="primary" disabled={!dirty || operationDisabled} loading={busy === 'save'} onClick={() => void run('save', persist)}>保存语音设置</Button></footer>}
  </div>
}
