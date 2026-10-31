/**
 * Web half of `dsh-attention-reminder`.
 *
 * Polls the host route for requests that are waiting on a human, and turns a
 * newly appeared one into: a chime (WebAudio), a card floating above the whole
 * frame, a raised window and - when the browser allows it - an OS toast.
 *
 * Sound and popup are two independent switches, stored on the host so they
 * survive reloads and apply to every session.
 *
 * Nothing here may break the page: every entry point is guarded.
 */
window.__ModuleLoader__.load({
  id: 'dsh-attention-reminder',
  factory: (require) => {
    var module = { exports: {} }

    const React = require('react')
    const h = React.createElement

    const ROUTE = '/api/attention-reminder'
    const POLL_MS = 1000
    const SHOW_MAX = 3
    const OVERLAY_SLOT = 'shell.overlay'
    const HEADER_SLOT = 'conversation.session.header.utilities'

    /* ------------------------------------------------------------------ text */

    const TEXT = {
      zh: {
        bell: '提醒设置',
        sound: '提示音',
        soundHint: '需要你处理时响铃',
        popup: '弹窗提示',
        popupHint: '置顶窗口并弹出提醒卡片',
        test: '发一条测试提醒',
        testTitle: '这是一条测试提醒',
        testDetail: '提醒通道正常，声音与弹窗会按上面的开关生效。',
        approval: (tool) => (tool ? `工具「${tool}」需要你授权` : '有操作需要你授权'),
        question: '有事项需要你确认',
        pendingNote: 'DSH 正在等待你的回应',
        dismiss: '知道了',
        more: (n) => `另有 ${n} 项待处理`,
        extraQuestions: (n) => `以及另外 ${n} 个问题`,
      },
      en: {
        bell: 'Reminder settings',
        sound: 'Sound',
        soundHint: 'Chime when something needs you',
        popup: 'Popup',
        popupHint: 'Raise the window and float a card',
        test: 'Send a test reminder',
        testTitle: 'This is a test reminder',
        testDetail: 'The channel works; sound and popup follow the switches above.',
        approval: (tool) => (tool ? `Tool "${tool}" needs your approval` : 'An action needs your approval'),
        question: 'Something needs your confirmation',
        pendingNote: 'DSH is waiting for your response',
        dismiss: 'Got it',
        more: (n) => `${n} more waiting`,
        extraQuestions: (n) => `plus ${n} more questions`,
      },
    }

    let localeService = null

    function lang() {
      try {
        const active = localeService?.getLocale?.()?.active
        if (typeof active === 'string' && active !== '') {
          return active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
        }
      } catch {
        /* fall through to the default */
      }
      return 'zh'
    }

    function tr() {
      return TEXT[lang()] || TEXT.zh
    }

    function localizedReason(map) {
      if (!map || typeof map !== 'object') return ''
      const current = lang()
      if (typeof map[current] === 'string' && map[current] !== '') return map[current]
      if (typeof map.en === 'string' && map.en !== '') return map.en
      for (const value of Object.values(map)) {
        if (typeof value === 'string' && value !== '') return value
      }
      return ''
    }

    function headline(item) {
      const t = tr()
      if (!item || typeof item !== 'object') return t.question
      if (item.kind === 'approval') return t.approval(item.tool)
      if (item.kind === 'question') {
        const first = Array.isArray(item.questions) ? item.questions[0] : null
        if (first && typeof first.header === 'string' && first.header !== '') return first.header
        return t.question
      }
      return t.testTitle
    }

    function bodyText(item) {
      const t = tr()
      if (!item || typeof item !== 'object') return ''
      if (item.kind === 'approval') {
        const localized = localizedReason(item.displayReason)
        if (localized !== '') return localized
        return typeof item.reason === 'string' ? item.reason : ''
      }
      if (item.kind === 'question') {
        const list = Array.isArray(item.questions) ? item.questions : []
        const first = list[0] || {}
        const lines = []
        if (typeof first.question === 'string' && first.question !== '') lines.push(first.question)
        if (list.length > 1) lines.push(t.extraQuestions(list.length - 1))
        return lines.join('\n')
      }
      return t.testDetail
    }

    /* ----------------------------------------------------------- tiny store */

    const dismissed = new Set()

    const store = {
      state: { revision: 0, settings: { sound: true, popup: true }, pending: [] },
      listeners: new Set(),
      emit() {
        for (const fn of [...this.listeners]) {
          try {
            fn()
          } catch {
            /* a broken subscriber must not stop the others */
          }
        }
      },
      set(next) {
        this.state = next
        this.emit()
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => {
          this.listeners.delete(fn)
        }
      },
    }

    function useAttentionState() {
      const [state, setState] = React.useState(store.state)
      React.useEffect(() => store.subscribe(() => setState(store.state)), [])
      return state
    }

    function livePending(state) {
      const list = Array.isArray(state?.pending) ? state.pending : []
      return list.filter((item) => item && !dismissed.has(item.id))
    }

    /* --------------------------------------------------------------- sound */

    let audioContext = null

    function ensureAudio() {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return null
        if (!audioContext) audioContext = new Ctor()
        if (audioContext.state === 'suspended') audioContext.resume().catch(() => {})
        return audioContext
      } catch {
        return null
      }
    }

    /**
     * Play the alert chime once.
     *
     * There is deliberately no repeat timer here any more: the previous version
     * kept re-chiming every 4 s (up to 6 times) while anything stayed pending,
     * which made a single approval ring three or more times before it was
     * answered. One chime plus the on-screen card is the whole alert.
     */
    function chime(attempt) {
      const audio = ensureAudio()
      if (!audio) return
      if (audio.state !== 'running') {
        // The context was created inside a user gesture but is still warming up.
        if ((attempt || 0) < 2) {
          window.setTimeout(() => chime((attempt || 0) + 1), 150)
        }
        return
      }
      try {
        const at = audio.currentTime
        // One strike only: a soft bell with an octave below for body.
        const partials = [
          [880, 0.2, 0.55],
          [440, 0.07, 0.5],
        ]
        for (const [frequency, peak, decay] of partials) {
          const oscillator = audio.createOscillator()
          const gain = audio.createGain()
          oscillator.type = 'sine'
          oscillator.frequency.value = frequency
          gain.gain.setValueAtTime(0.0001, at)
          gain.gain.exponentialRampToValueAtTime(peak, at + 0.012)
          gain.gain.exponentialRampToValueAtTime(0.0001, at + decay)
          oscillator.connect(gain)
          gain.connect(audio.destination)
          oscillator.start(at)
          oscillator.stop(at + decay + 0.05)
        }
      } catch {
        /* audio is a nicety, never a blocker */
      }
    }

    /* -------------------------------------------------------------- popups */

    function requestNotificationPermission() {
      try {
        if (typeof Notification === 'undefined') return
        if (Notification.permission === 'default') Notification.requestPermission().catch(() => {})
      } catch {
        /* ignore */
      }
    }

    function toast(items) {
      try {
        if (typeof Notification === 'undefined') return
        if (Notification.permission !== 'granted') return
        const first = items[0]
        const title = items.length > 1 ? `${items.length} × ${tr().bell}` : headline(first)
        const body = items.length > 1 ? items.map((item) => headline(item)).join('\n') : bodyText(first)
        const notification = new Notification(title, {
          body: body || undefined,
          tag: 'dsh-attention-reminder',
          silent: true,
        })
        notification.onclick = () => {
          try {
            window.focus()
            notification.close()
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* a denied or unsupported toast must not break the alert */
      }
    }

    function raiseWindow(items) {
      try {
        window.focus()
      } catch {
        /* ignore */
      }
      toast(items)
    }

    /**
     * Announce a batch of newly seen requests.
     *
     * Exactly one strike per batch: the pending card stays on screen until it is
     * answered, so a second ring would only repeat what the card already says.
     */
    function announce(items) {
      if (!Array.isArray(items) || items.length === 0) return
      const settings = store.state.settings
      if (settings.sound) chime()
      if (settings.popup) raiseWindow(items)
    }

    function dismiss(id) {
      dismissed.add(id)
      store.emit()
    }

    /* ------------------------------------------------------------ transport */

    let knownIds = new Set()
    let pollTimer = 0
    let inflight = false

    function isItem(item) {
      return !!item && typeof item === 'object' && typeof item.id === 'string' && item.id !== ''
    }

    function applySnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return
      const pending = (Array.isArray(snapshot.pending) ? snapshot.pending : []).filter(isItem)
      const settings = {
        sound: snapshot.settings?.sound !== false,
        popup: snapshot.settings?.popup !== false,
      }
      const fresh = pending.filter((item) => !knownIds.has(item.id))
      knownIds = new Set(pending.map((item) => item.id))
      for (const id of [...dismissed]) {
        if (!knownIds.has(id)) dismissed.delete(id)
      }
      store.set({ revision: typeof snapshot.revision === 'number' ? snapshot.revision : 0, settings, pending })
      if (fresh.length > 0) announce(fresh)
    }

    async function tick() {
      if (inflight) return
      inflight = true
      try {
        const response = await fetch(ROUTE, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        if (response.ok) applySnapshot(await response.json())
      } catch {
        /* the host half may not be mounted yet; the next tick retries */
      } finally {
        inflight = false
      }
    }

    function startPolling() {
      if (pollTimer) return
      tick()
      pollTimer = window.setInterval(tick, POLL_MS)
    }

    function stopPolling() {
      if (pollTimer) {
        window.clearInterval(pollTimer)
        pollTimer = 0
      }
    }

    async function push(body) {
      try {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (response.ok) applySnapshot(await response.json())
      } catch {
        /* the switch simply stays where it was */
      }
    }

    /* ------------------------------------------------------------ components */

    function BellIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7' }),
        h('path', { d: 'M10.3 20a2 2 0 0 0 3.4 0' }),
      )
    }

    function SwitchRow(props) {
      const on = props.on === true
      return h(
        'button',
        {
          type: 'button',
          className: `arm-row${on ? ' is-on' : ''}`,
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          onClick: props.onClick,
        },
        h(
          'span',
          { className: 'arm-row-text' },
          h('span', { className: 'arm-row-label' }, props.label),
          h('span', { className: 'arm-row-hint' }, props.hint),
        ),
        h('span', { className: 'arm-track', 'aria-hidden': 'true' }, h('span', { className: 'arm-knob' })),
      )
    }

    function AttentionToggle() {
      const state = useAttentionState()
      const t = tr()
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const element = rootRef.current
          if (element && !element.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const count = livePending(state).length
      const sound = state.settings.sound
      const popup = state.settings.popup

      return h(
        'div',
        { className: 'arm-widget', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            className: `arm-bell${count > 0 ? ' is-alert' : ''}`,
            onClick: () => setOpen((value) => !value),
            title: t.bell,
            'aria-label': t.bell,
            'aria-expanded': open ? 'true' : 'false',
          },
          BellIcon(),
          count > 0 ? h('span', { className: 'arm-badge' }, count > 9 ? '9+' : String(count)) : null,
        ),
        open
          ? h(
              'div',
              { className: 'arm-panel', role: 'dialog', 'aria-label': t.bell },
              SwitchRow({
                label: t.sound,
                hint: t.soundHint,
                on: sound,
                onClick: () => {
                  ensureAudio()
                  push({ sound: !sound })
                },
              }),
              SwitchRow({
                label: t.popup,
                hint: t.popupHint,
                on: popup,
                onClick: () => {
                  if (!popup) requestNotificationPermission()
                  push({ popup: !popup })
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'arm-test',
                  onClick: () => {
                    ensureAudio()
                    requestNotificationPermission()
                    push({ ping: true })
                  },
                },
                t.test,
              ),
            )
          : null,
      )
    }

    function AttentionOverlay() {
      const state = useAttentionState()
      const t = tr()
      if (!state.settings.popup) return null
      const live = livePending(state)
      if (live.length === 0) return null
      const shown = live.slice(0, SHOW_MAX)
      return h(
        'div',
        { className: 'arm-overlay' },
        h(
          'div',
          { className: 'arm-stack' },
          shown.map((item) =>
            h(
              'div',
              { className: 'arm-card', key: item.id },
              h(
                'div',
                { className: 'arm-head' },
                h('span', { className: 'arm-pulse', 'aria-hidden': 'true' }),
                h('span', { className: 'arm-title' }, headline(item)),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'arm-close',
                    onClick: () => dismiss(item.id),
                    title: t.dismiss,
                    'aria-label': t.dismiss,
                  },
                  '×',
                ),
              ),
              bodyText(item) ? h('div', { className: 'arm-body' }, bodyText(item)) : null,
              h(
                'div',
                { className: 'arm-foot' },
                h('span', { className: 'arm-note' }, t.pendingNote),
                h('button', { type: 'button', className: 'arm-ack', onClick: () => dismiss(item.id) }, t.dismiss),
              ),
            ),
          ),
          live.length > shown.length ? h('div', { className: 'arm-more' }, t.more(live.length - shown.length)) : null,
        ),
      )
    }

    /* ---------------------------------------------------------------- style */

    const CSS = `
.arm-widget { position: relative; display: inline-flex; align-items: center; }
.arm-bell {
  display: inline-flex; align-items: center; justify-content: center; position: relative;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-secondary, #6b7280);
  transition: background 120ms ease, color 120ms ease;
}
.arm-bell:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, #111); }
.arm-bell.is-alert { color: var(--dsw-alias-link, #2563eb); }
.arm-bell:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #2563eb); outline-offset: 1px; }
.arm-badge {
  position: absolute; top: -1px; right: -2px; min-width: 14px; height: 14px; padding: 0 3px;
  border-radius: 999px; background: #ef4444; color: #fff; font-size: 9px; font-weight: 600;
  line-height: 14px; text-align: center;
}
.arm-panel {
  position: absolute; top: calc(100% + 8px); right: 0; z-index: 2147481000; width: 248px; padding: 6px;
  display: flex; flex-direction: column; gap: 2px;
  background: var(--dsw-specific-menu, #fff); color: var(--dsw-alias-label-primary, #111);
  border: 1px solid var(--dsw-alias-border, rgba(0,0,0,.08));
  border-radius: var(--dsw-radius-lg, 12px);
  box-shadow: var(--dsw-elevation-panel, 0 12px 32px rgba(0,0,0,.18));
}
.arm-row {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border: 0;
  border-radius: 8px; background: transparent; cursor: pointer; text-align: left; color: inherit;
}
.arm-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.arm-row-text { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }
.arm-row-label { font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary, #111); }
.arm-row-hint { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.arm-track {
  flex: 0 0 auto; width: 32px; height: 18px; border-radius: 999px; position: relative;
  background: var(--dsw-alias-track, rgba(0,0,0,.16)); transition: background 140ms ease;
}
.arm-row.is-on .arm-track { background: var(--dsw-alias-link, #2563eb); }
.arm-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform 140ms ease;
}
.arm-row.is-on .arm-knob { transform: translateX(14px); }
.arm-test {
  margin: 4px 2px 2px; padding: 7px 10px; border: 1px solid var(--dsw-alias-border, rgba(0,0,0,.1));
  border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #4b5563);
  font-size: 12px; cursor: pointer;
}
.arm-test:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.arm-overlay {
  position: fixed; left: 0; right: 0; top: 0; z-index: 2147482000; display: flex;
  justify-content: center; padding: 12px 12px 0; pointer-events: none;
}
.arm-stack { display: flex; flex-direction: column; gap: 8px; width: min(460px, 100%); }
.arm-card {
  pointer-events: auto; padding: 11px 13px 9px;
  background: var(--dsw-specific-menu, #fff); color: var(--dsw-alias-label-primary, #111);
  border: 1px solid var(--dsw-alias-border, rgba(0,0,0,.08));
  border-left: 3px solid #f59e0b;
  border-radius: var(--dsw-radius-lg, 12px);
  box-shadow: var(--dsw-elevation-panel, 0 14px 34px rgba(0,0,0,.22));
  animation: arm-in 220ms cubic-bezier(.2,.9,.3,1.2);
}
@keyframes arm-in { from { opacity: 0; transform: translateY(-10px) scale(.98); } to { opacity: 1; transform: none; } }
.arm-head { display: flex; align-items: center; gap: 8px; }
.arm-pulse {
  flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: #f59e0b;
  box-shadow: 0 0 0 0 rgba(245,158,11,.55); animation: arm-pulse 1.6s ease-out infinite;
}
@keyframes arm-pulse {
  0% { box-shadow: 0 0 0 0 rgba(245,158,11,.5); }
  70% { box-shadow: 0 0 0 7px rgba(245,158,11,0); }
  100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); }
}
.arm-title {
  flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-primary, #111);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.arm-close {
  flex: 0 0 auto; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-tertiary, #8b93a1); font-size: 15px;
  line-height: 18px; cursor: pointer;
}
.arm-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, #111); }
.arm-body {
  margin: 6px 0 0 16px; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary, #4b5563);
  white-space: pre-wrap; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
}
.arm-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding-left: 16px; }
.arm-note { flex: 1 1 auto; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-caption, #9aa1ad); }
.arm-ack {
  flex: 0 0 auto; padding: 4px 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border, rgba(0,0,0,.12));
  background: transparent; color: var(--dsw-alias-label-primary, #111); font-size: 12px; cursor: pointer;
}
.arm-ack:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.arm-more {
  pointer-events: none; align-self: center; padding: 2px 8px; border-radius: 999px;
  font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b93a1);
  background: var(--dsw-specific-menu, #fff);
  box-shadow: var(--dsw-elevation-panel, 0 6px 18px rgba(0,0,0,.14));
}
`

    function installStyles() {
      try {
        if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') {
          return styles.insert(CSS)
        }
      } catch {
        /* fall back to a plain style tag */
      }
      const element = document.createElement('style')
      element.dataset.plugin = 'dsh-attention-reminder'
      element.textContent = CSS
      document.head.appendChild(element)
      return () => {
        try {
          element.remove()
        } catch {
          /* ignore */
        }
      }
    }

    /* ----------------------------------------------------------------- apply */

    function apply(ctx) {
      try {
        ctx.effect(() => installStyles(), 'attention-reminder: styles')
      } catch (error) {
        console.warn('[dsh-attention-reminder] styles', error)
      }

      try {
        localeService = ctx.get('locale')
      } catch {
        localeService = null
      }

      try {
        ctx.on('locale/change', () => store.emit())
      } catch {
        /* no locale service in this build */
      }

      try {
        const unlock = () => {
          ensureAudio()
        }
        document.addEventListener('pointerdown', unlock, { passive: true })
        document.addEventListener('keydown', unlock)
        ctx.effect(
          () => () => {
            document.removeEventListener('pointerdown', unlock)
            document.removeEventListener('keydown', unlock)
          },
          'attention-reminder: audio unlock',
        )
      } catch {
        /* ignore */
      }

      try {
        ctx.effect(() => {
          startPolling()
          return stopPolling
        }, 'attention-reminder: polling')
      } catch (error) {
        console.warn('[dsh-attention-reminder] polling', error)
      }

      try {
        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register(
            { name: OVERLAY_SLOT, id: 'dsh-attention-reminder-overlay', order: 100 },
            AttentionOverlay,
          ),
        )
        ctx.slots.inject(HEADER_SLOT, () =>
          ctx.slots.register(
            { name: HEADER_SLOT, id: 'dsh-attention-reminder-bell', order: 60 },
            AttentionToggle,
          ),
        )
      } catch (error) {
        console.warn('[dsh-attention-reminder] slots', error)
      }
    }

    module.exports.inject = ['slots']
    module.exports.apply = apply
    return module.exports
  },
})
