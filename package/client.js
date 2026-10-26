/* eslint-disable no-undef */
/**
 * Kiro settings panel.
 *
 * The card exists because Kiro's sign-in is not an API key you can paste into a
 * generic provider field: a device code has to be opened in a browser, a Google or
 * GitHub login ends on a `kiro://` callback, and an enterprise IdP needs its token
 * endpoint. So the panel drives the plugin's own endpoints (`/api/kiro.signin`)
 * and shows what state the account pool is in — which account is active, when its
 * token expires, how much of the monthly allowance is left, and where the local
 * bridge is listening.
 *
 * Model capability editing deliberately stays on the host's Models page (the
 * `providers.kiro` settings route this plugin declares): one place to change a
 * context window, not two.
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-kiro',
  factory: require => {
    const React = require('react')
    const { IconArrowRightSmallOutlineRegular, IconRefreshOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const NS = 'settings.kiro'

    const en = {
      title: 'Kiro models',
      description: 'Use the models your Kiro IDE is signed in to, with per-model endpoints, context, output and reasoning settings.',
      loading: 'Reading Kiro state…',
      reload: 'Reload',
      signIn: 'Sign in to Kiro',
      method: 'Sign-in method',
      start: 'Start',
      cancel: 'Cancel',
      continue: 'Continue',
      done: 'Signed in.',
      noAccount: 'No Kiro account is connected yet. Sign in, or import the session your Kiro IDE already has.',
      importLocal: 'Use my local Kiro session',
      importing: 'Looking for a local Kiro session…',
      accounts: 'Accounts',
      active: 'Active',
      makeActive: 'Use this account',
      enable: 'Enable',
      disable: 'Disable',
      remove: 'Remove',
      tokenExpires: 'Token expires',
      tokenValid: 'Token valid',
      noRefresh: 'No refresh token — this account will need to sign in again',
      quota: 'Quota',
      quotaLine: '{used} of {limit} used · resets {reset}',
      quotaUnlimited: 'Unlimited for this plan ({plan})',
      quotaUnavailable: 'Quota unavailable for this account',
      models: 'Models',
      modelsHint: '{count} models available. Edit context, output and reasoning per model on the Models page.',
      refreshModels: 'Refresh from Kiro',
      refreshing: 'Asking Kiro for your model list…',
      bridge: 'Local API bridge',
      bridgeHint: 'Point any OpenAI or Anthropic client at this URL to use the same Kiro models through the same rules.',
      bridgeDisabled: 'The bridge is off. Enable it in settings (`bridge.enable`) to expose an OpenAI/Anthropic endpoint on loopback.',
      bridgeToken: 'A bridge token is required by this deployment.',
      advanced: 'Advanced',
      error: 'Kiro sign-in failed',
      declined: 'Sign-in was cancelled.',
      waiting: 'Waiting for you to finish in the browser…',
      openUrl: 'Open {url}',
      enterCode: 'Code: {code}',
      answers: 'Answer the questions below to continue.',
      readOnly: 'The credential store is read-only, so accounts cannot be changed here.',
      AUTH: 'Kiro refused the credentials. Sign in again.',
      kiro_not_configured: 'No Kiro account is connected yet.',
      kiro_refresh_expired: 'The saved refresh token no longer works. Sign in again.',
      endpoint: 'Kiro could not be reached. Check your network or proxy, then retry.',
      timeout: 'Kiro did not answer in time. Retry, or raise the timeout in settings.',
      rejected: 'Kiro rejected that input. Check the value and try again.',
      rate_limit: 'Kiro rate-limited this account. Try the other account or wait a moment.',
      quota: 'This Kiro account has used its allowance for the current period.',
      upstream: 'Kiro returned an unexpected answer. Retry, and check the plugin log if it repeats.',
    }
    const de = {
      title: 'Kiro-Modelle',
      description: 'Die Modelle aus deinem Kiro-IDE-Login nutzen — mit Endpunkt, Kontext, Ausgabe und Reasoning pro Modell.',
      loading: 'Kiro-Status wird gelesen…',
      reload: 'Neu laden',
      signIn: 'Bei Kiro anmelden',
      method: 'Anmeldemethode',
      start: 'Start',
      cancel: 'Abbrechen',
      continue: 'Weiter',
      done: 'Angemeldet.',
      noAccount: 'Noch kein Kiro-Konto verbunden. Melde dich an oder übernimm die Session deiner Kiro-IDE.',
      importLocal: 'Lokale Kiro-Session übernehmen',
      importing: 'Lokale Kiro-Session wird gesucht…',
      accounts: 'Konten',
      active: 'Aktiv',
      makeActive: 'Dieses Konto verwenden',
      enable: 'Aktivieren',
      disable: 'Deaktivieren',
      remove: 'Entfernen',
      tokenExpires: 'Token läuft ab',
      tokenValid: 'Token gültig',
      noRefresh: 'Kein Refresh-Token — dieses Konto muss sich erneut anmelden',
      quota: 'Kontingent',
      quotaLine: '{used} von {limit} genutzt · Reset {reset}',
      quotaUnlimited: 'Unbegrenzt in diesem Plan ({plan})',
      quotaUnavailable: 'Kontingent für dieses Konto nicht verfügbar',
      models: 'Modelle',
      modelsHint: '{count} Modelle verfügbar. Kontext, Ausgabe und Reasoning pro Modell auf der Modelle-Seite bearbeiten.',
      refreshModels: 'Von Kiro aktualisieren',
      refreshing: 'Modellliste wird bei Kiro abgefragt…',
      bridge: 'Lokaler API-Bridge',
      bridgeHint: 'Jeden OpenAI- oder Anthropic-Client auf diese URL richten — gleiche Kiro-Modelle, gleiche Regeln.',
      bridgeDisabled: 'Der Bridge ist aus. Aktiviere ihn in den Einstellungen (`bridge.enable`) für einen Loopback-Endpunkt.',
      bridgeToken: 'Für diese Installation ist ein Bridge-Token nötig.',
      advanced: 'Erweitert',
      error: 'Kiro-Anmeldung fehlgeschlagen',
      declined: 'Anmeldung abgebrochen.',
      waiting: 'Warten auf die Bestätigung im Browser…',
      openUrl: '{url} öffnen',
      enterCode: 'Code: {code}',
      answers: 'Beantworte die folgenden Fragen, um fortzufahren.',
      AUTH: 'Kiro hat die Zugangsdaten abgelehnt. Bitte neu anmelden.',
      kiro_not_configured: 'Noch kein Kiro-Konto verbunden.',
      kiro_refresh_expired: 'Das gespeicherte Refresh-Token funktioniert nicht mehr. Bitte neu anmelden.',
      endpoint: 'Kiro war nicht erreichbar. Netzwerk oder Proxy prüfen und erneut versuchen.',
      timeout: 'Kiro hat nicht rechtzeitig geantwortet. Erneut versuchen oder Timeout erhöhen.',
      rejected: 'Kiro hat diese Eingabe abgelehnt. Wert prüfen und erneut versuchen.',
      rate_limit: 'Kiro hat dieses Konto gedrosselt. Anderes Konto nutzen oder kurz warten.',
      quota: 'Dieses Kiro-Konto hat sein Kontingent im aktuellen Zeitraum genutzt.',
      upstream: 'Kiro lieferte eine unerwartete Antwort. Erneut versuchen, sonst Plugin-Log prüfen.',
    }
    const zh = {
      title: 'Kiro 模型',
      description: '使用 Kiro IDE 已登录的模型，并按模型配置端点、上下文、输出与推理参数。',
      loading: '正在读取 Kiro 状态…', reload: '重新读取', signIn: '登录 Kiro', method: '登录方式',
      start: '开始', cancel: '取消', continue: '继续', done: '已登录。',
      noAccount: '尚未连接 Kiro 账号。请登录，或导入 Kiro IDE 已有的会话。',
      importLocal: '使用本机 Kiro 会话', importing: '正在查找本机 Kiro 会话…',
      accounts: '账号', active: '当前', makeActive: '使用该账号', enable: '启用', disable: '停用', remove: '移除',
      tokenExpires: '令牌到期', tokenValid: '令牌有效', noRefresh: '没有刷新令牌，该账号稍后需要重新登录',
      quota: '额度', quotaLine: '已用 {used} / {limit} · {reset} 重置', quotaUnlimited: '当前套餐不限量（{plan}）',
      quotaUnavailable: '无法获取该账号的额度', models: '模型',
      modelsHint: '可用模型 {count} 个。上下文、输出与推理参数请在模型页面按模型修改。',
      refreshModels: '从 Kiro 刷新', refreshing: '正在向 Kiro 请求模型列表…',
      bridge: '本地 API 桥接', bridgeHint: '把 OpenAI 或 Anthropic 客户端指向此地址，即可用相同规则调用同一批 Kiro 模型。',
      bridgeDisabled: '桥接未开启。请在设置中开启 `bridge.enable` 以在回环地址提供端点。',
      bridgeToken: '此部署需要桥接令牌。', advanced: '高级', error: 'Kiro 登录失败', declined: '登录已取消。',
      waiting: '等待你在浏览器中完成确认…', openUrl: '打开 {url}', enterCode: '验证码：{code}',
      answers: '请回答以下问题以继续。', readOnly: '凭据存储为只读，无法在此更改账号。',
      AUTH: 'Kiro 拒绝了该凭据，请重新登录。', kiro_not_configured: '尚未连接 Kiro 账号。',
      kiro_refresh_expired: '保存的刷新令牌已失效，请重新登录。', endpoint: '无法访问 Kiro，请检查网络或代理后重试。',
      timeout: 'Kiro 响应超时，请重试或在设置中提高超时。', rejected: 'Kiro 拒绝了该输入，请检查后重试。',
      rate_limit: '该账号被限流，请改用其他账号或稍后重试。', quota: '该 Kiro 账号本期额度已用完。',
      upstream: 'Kiro 返回了无法识别的结果，请重试；持续出现请查看插件日志。',
    }

    const css = `
      .k2dCard{list-style:none;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
      .k2dHead{display:flex;align-items:flex-start;gap:12px}
      .k2dTitles{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0}
      .k2dTitle{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
      .k2dDescription{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
      .k2dRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .k2dSection{display:flex;flex-direction:column;gap:8px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px}
      .k2dLabel{font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
      .k2dAccount{display:flex;align-items:center;gap:10px;padding:8px 0;font-size:13px;line-height:1.5}
      .k2dAccount+.k2dAccount{border-top:.5px solid var(--dsw-alias-border-l2)}
      .k2dAccountName{display:flex;flex:1;flex-direction:column;min-width:0;color:var(--dsw-alias-label-primary)}
      .k2dAccountMeta{color:var(--dsw-alias-label-tertiary);font-size:12px}
      .k2dBadge{border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
      .k2dButton{appearance:none;font:inherit;font-size:13px;line-height:1.5;border:1px solid transparent;border-radius:8px;padding:5px 12px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
      .k2dButton:disabled{opacity:.4;cursor:default}
      .k2dButtonQuiet{background:transparent;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}
      .k2dSelect,.k2dInput{box-sizing:border-box;width:100%;min-width:0;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-weight:400}
      .k2dField{display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--dsw-alias-label-primary)}
      .k2dHint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:0}
      .k2dError{font-size:12px;line-height:1.5;color:var(--dsw-alias-status-negative,#c64c4c);margin:0}
      .k2dCode{font-family:var(--dsw-alias-font-mono,ui-monospace,monospace);font-size:12px;background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:2px 6px;word-break:break-all}
      .k2dUrl{display:flex;align-items:center;gap:8px;font-size:12px}
    `

    const METHODS = [
      { id: 'auto-import', label: 'Use my local Kiro session' },
      { id: 'builder-id', label: 'AWS Builder ID (device code)' },
      { id: 'idc', label: 'AWS IAM Identity Center' },
      { id: 'google', label: 'Google' },
      { id: 'github', label: 'GitHub' },
      { id: 'external_idp', label: 'Enterprise IdP (Entra / Okta)' },
      { id: 'api_key', label: 'Kiro API key' },
      { id: 'import', label: 'Paste a refresh token' },
    ]

    /** Call one plugin endpoint; panel errors arrive as `{code,error}`. */
    function createApi() {
      return async (endpoint, payload, signal) => {
        const isRead = endpoint === 'status' || endpoint === 'models'
        const response = await fetch(`/api/kiro.${endpoint}`, {
          method: isRead ? 'GET' : 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          ...(signal ? { signal } : {}),
          ...(isRead ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}) }),
        })
        const text = await response.text()
        let data
        try {
          data = text ? JSON.parse(text) : {}
        } catch {
          data = {}
        }
        if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { code: data.code || 'upstream' })
        return data
      }
    }

    function whenReady(ready, body) {
      if (!ready) return null
      return h('div', { className: 'k2dSection' }, body)
    }

    function AccountRow({ account, active, t, onAction, busy }) {
      const expires = account.expiresAt ? new Date(account.expiresAt) : null
      const expired = expires ? expires.getTime() < Date.now() : false
      return h('div', { className: 'k2dAccount', key: account.id },
        h('div', { className: 'k2dAccountName' },
          h('span', {}, account.label || account.id),
          h('span', { className: 'k2dAccountMeta' },
            `${account.authMethod}${account.email ? ` · ${account.email}` : ''}${account.region ? ` · ${account.region}` : ''}`,
            expires ? ` · ${expired ? t('tokenExpires') : t('tokenValid')} ${expires.toLocaleString()}` : '',
            account.hasRefreshToken ? '' : ` · ${t('noRefresh')}`)),
        active ? h('span', { className: 'k2dBadge' }, t('active')) : null,
        h('button', {
          type: 'button', className: 'k2dButton k2dButtonQuiet', disabled: busy || active,
          onClick: () => onAction({ action: 'active', id: account.id }),
        }, t('makeActive')),
        h('button', {
          type: 'button', className: 'k2dButton k2dButtonQuiet', disabled: busy,
          onClick: () => onAction({ action: 'enable', id: account.id, enabled: !account.enabled }),
        }, account.enabled ? t('disable') : t('enable')),
        h('button', {
          type: 'button', className: 'k2dButton k2dButtonQuiet', disabled: busy,
          onClick: () => onAction({ action: 'remove', id: account.id }),
        }, t('remove')))
    }

    /**
     * One sign-in round trip per click.
     *
     * The plugin parks a round between questions, so the panel keeps only the
     * opaque `stateId` plus whatever a device code or `kiro://` callback still has
     * to collect. Nothing here knows Kiro's protocol.
     */
    function SignIn({ t, onDone }) {
      const api = React.useContext(ApiContext)
      const [method, setMethod] = React.useState('auto-import')
      const [round, setRound] = React.useState(null)
      const [answers, setAnswers] = React.useState({})
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const submit = async extra => {
        setBusy(true)
        setError(null)
        try {
          const result = await api('signin', {
            method,
            ...(round?.stateId ? { stateId: round.stateId } : {}),
            input: { ...answers, ...(extra || {}) },
          })
          setAnswers({})
          if (result.status === 'authorized') {
            setRound(null)
            onDone(result)
            return
          }
          setRound(result)
        } catch (caught) {
          setError(caught?.code ? t(caught.code) || caught.message || caught.code : caught?.message || String(caught))
        } finally {
          setBusy(false)
        }
      }

      if (method === 'auto-import' && !round) {
        return h('div', { className: 'k2dRow' },
          h('button', { type: 'button', className: 'k2dButton', disabled: busy, onClick: () => submit() },
            h(IconArrowRightSmallOutlineRegular, { size: 14 }), busy ? t('importing') : t('importLocal')),
          error ? h('p', { className: 'k2dError' }, error) : null)
      }

      const notices = round?.notices || []
      const prompt = round?.prompt
      return h(React.Fragment, {},
        h('div', { className: 'k2dRow' },
          h('select', {
            className: 'k2dSelect', value: method, disabled: busy,
            onChange: event => {
              setMethod(event.target.value)
              setRound(null)
              setAnswers({})
            },
          }, METHODS.map(entry => h('option', { value: entry.id, key: entry.id }, entry.label)))),
        notices.map((notice, index) => h('p', { className: 'k2dHint', key: index },
          notice.url ? h('a', { href: notice.url, target: '_blank', rel: 'noreferrer' }, t('openUrl', { url: notice.url })) : null,
          notice.code ? ` ${t('enterCode', { code: notice.code })}` : '',
          notice.message ? ` ${notice.message}` : '')),
        prompt ? h('label', { className: 'k2dField' },
          h('span', {}, prompt.message),
          h('input', {
            className: 'k2dInput', type: prompt.kind === 'secret' ? 'password' : 'text',
            value: answers[prompt.field] || '', autoFocus: true,
            onChange: event => setAnswers(value => ({ ...value, [prompt.field]: event.target.value })),
            onKeyDown: event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            },
          })) : null,
        error ? h('p', { className: 'k2dError' }, error) : null,
        h('div', { className: 'k2dRow' },
          h('button', { type: 'button', className: 'k2dButton', disabled: busy, onClick: () => submit() }, busy ? '…' : t('continue')),
          round?.userCode ? h('span', { className: 'k2dCode' }, round.userCode) : null,
          round?.stateId ? h('button', {
            type: 'button', className: 'k2dButton k2dButtonQuiet', disabled: busy,
            onClick: async () => {
              await api('signin.cancel', { stateId: round.stateId }).catch(() => {})
              setRound(null)
            },
          }, t('cancel')) : null))
    }

    const ApiContext = React.createContext(null)

    function KiroCard({ t }) {
      const api = React.useContext(ApiContext)
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [modelCount, setModelCount] = React.useState(0)

      const load = React.useCallback(async () => {
        setError(null)
        try {
          const status = await api('status')
          setState(status)
          setModelCount((await api('models').catch(() => ({ models: { data: [] } })))?.models?.data?.length || 0)
        } catch (caught) {
          setError(caught?.code ? t(caught.code) || caught.message : caught?.message || String(caught))
        }
      }, [api, t])

      React.useEffect(() => {
        void load()
      }, [load])

      const act = async payload => {
        setBusy(true)
        try {
          await api(payload.endpoint || 'account', payload)
          await load()
        } catch (caught) {
          setError(caught?.code ? t(caught.code) || caught.message : caught?.message || String(caught))
        } finally {
          setBusy(false)
        }
      }

      const accounts = state?.accounts?.accounts || []
      const activeId = state?.accounts?.activeId
      const usage = state?.usage
      const bridge = state?.bridge || {}
      const reset = usage?.resetAt ? new Date(usage.resetAt).toLocaleDateString() : null

      return h('div', { className: 'k2dCard' },
        h('div', { className: 'k2dHead' },
          h('div', { className: 'k2dTitles' },
            h('div', { className: 'k2dTitle' }, t('title')),
            h('div', { className: 'k2dDescription' }, t('description'))),
          h('button', { type: 'button', className: 'k2dButton k2dButtonQuiet', onClick: () => void load(), disabled: busy },
            h(IconRefreshOutlineRegular, { size: 14 }), t('reload'))),
        error ? h('p', { className: 'k2dError' }, error) : null,
        !state && !error ? h('p', { className: 'k2dHint' }, t('loading')) : null,

        whenReady(state, h('div', { className: 'k2dSection' },
          h('div', { className: 'k2dLabel' }, t('signIn')),
          h(SignIn, { t, onDone: () => void load() }))),

        accounts.length > 0 ? h('div', { className: 'k2dSection' },
          h('div', { className: 'k2dLabel' }, t('accounts')),
          accounts.map(account => h(AccountRow, {
            key: account.id, account, t, busy, active: account.id === activeId,
            onAction: payload => void act({ ...payload, endpoint: 'account' }),
          })),
          usage?.error ? h('p', { className: 'k2dHint' }, t('quotaUnavailable'))
            : usage?.unlimited ? h('p', { className: 'k2dHint' }, t('quotaUnlimited', { plan: usage.plan || 'Kiro' }))
              : Number.isFinite(usage?.limit) ? h('p', { className: 'k2dHint' }, t('quotaLine', { used: usage.used, limit: usage.limit, reset: reset || '—' }))
                : null) : null,

        whenReady(state, h('div', { className: 'k2dSection' },
          h('div', { className: 'k2dLabel' }, t('models')),
          h('p', { className: 'k2dHint' }, t('modelsHint', { count: modelCount })),
          h('div', { className: 'k2dRow' },
            h('button', {
              type: 'button', className: 'k2dButton k2dButtonQuiet', disabled: busy,
              onClick: async () => {
                setBusy(true)
                await api('refresh', {}).catch(caught => setError(caught?.message || String(caught)))
                await load().catch(() => {})
                setBusy(false)
              },
            }, t('refreshModels'))))),

        whenReady(state, h('details', { className: 'k2dSection' },
          h('summary', { className: 'k2dLabel' }, t('bridge')),
          bridge.enabled && bridge.url
            ? h('div', { className: 'k2dUrl' }, h('code', { className: 'k2dCode' }, bridge.url), bridge.protected ? h('span', { className: 'k2dBadge' }, t('bridgeToken')) : null)
            : h('p', { className: 'k2dHint' }, t('bridgeDisabled')),
          h('p', { className: 'k2dHint' }, t('bridgeHint')))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const callApi = createApi()
        ctx.effect(() => ctx.locale.register(NS, { en, de, zh }), 'kiro locale')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.pluginCss = 'dsh-desktop-kiro'
          style.textContent = css
          document.head.appendChild(style)
          return () => style.remove()
        }, 'kiro styles')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'kiro',
          order: -90,
          locale: NS,
          label: () => t('title'),
          inject: () => ({ callApi }),
        }, () => h(ApiContext.Provider, { value: callApi }, h(KiroCard, { t: (key, values) => t(key, values) }))))
      },
    }
  },
})
