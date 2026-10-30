/**
 * Host half of `dsh-attention-reminder`.
 *
 * An approval request and a user question both arrive on the host, and both
 * block until a human answers. This half records every request that is still
 * waiting, and publishes the list over a small HTTP route. The web half polls
 * that route and turns newly appeared entries into sound / popup alerts.
 *
 * Host plugins have no push channel into the page, so the page polls - the same
 * pattern the first-party sidebar plugins use.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const ROUTE = '/api/attention-reminder'
const MAX_PENDING = 24
const PING_LIFETIME = 8000

const STATE_FILE = join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'plugin-data',
  'dsh-attention-reminder',
  'state.json',
)

const DEFAULTS = { sound: true, popup: true }

function loadSettings() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return { sound: raw?.sound !== false, popup: raw?.popup !== false }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveSettings(settings) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

function text(value) {
  return typeof value === 'string' ? value : ''
}

/** Best-effort session label; the Agent shape is not part of the public API. */
function agentLabel(agent) {
  if (!agent || typeof agent !== 'object') return ''
  for (const key of ['sessionId', 'id', 'title', 'name']) {
    const value = agent[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/** `displayReason` is a locale -> text map; keep only usable entries. */
function displayReasonMap(reason) {
  if (!reason || typeof reason !== 'object') return null
  const result = {}
  for (const [locale, value] of Object.entries(reason)) {
    if (typeof value === 'string' && value !== '') result[locale] = value
  }
  return Object.keys(result).length > 0 ? result : null
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) return []
  return questions.slice(0, 8).map((question, index) => ({
    id: text(question?.id) || `q${index + 1}`,
    question: text(question?.question),
    header: text(question?.header),
    detail: text(question?.detail),
    multiSelect: question?.multiSelect === true,
    intent: text(question?.intent?.kind),
    options: Array.isArray(question?.options)
      ? question.options.slice(0, 12).map((option) => text(option?.label)).filter(Boolean)
      : [],
  }))
}

export function apply(ctx) {
  const pending = new Map()
  const settings = loadSettings()
  let revision = 1
  let sequence = 0

  const snapshot = () => ({
    revision,
    settings: { ...settings },
    pending: [...pending.values()],
  })

  /**
   * Register a waiting request. The returned `settle` is idempotent: an abort
   * and a resolved outcome may both fire.
   */
  function track(kind, payload) {
    sequence += 1
    const id = `${kind}-${sequence}-${Date.now()}`
    pending.set(id, { id, kind, at: Date.now(), ...payload })
    while (pending.size > MAX_PENDING) {
      const oldest = pending.keys().next().value
      if (oldest === undefined) break
      pending.delete(oldest)
    }
    revision += 1
    let settled = false
    return () => {
      if (settled) return
      settled = true
      if (pending.delete(id)) revision += 1
    }
  }

  function watchSignal(signal, settle) {
    if (!signal || typeof signal.addEventListener !== 'function') return
    try {
      signal.addEventListener('abort', () => settle(), { once: true })
    } catch {
      /* a foreign AbortSignal-like object is not worth failing the request over */
    }
  }

  // A tool wants to run something that needs the user's permission.
  ctx.on('approval/request', (request, next) => {
    const settle = track('approval', {
      tool: text(request?.toolName),
      reason: text(request?.reason),
      displayReason: displayReasonMap(request?.displayReason),
      agent: agentLabel(request?.agent),
    })
    watchSignal(request?.signal, settle)

    let outcome
    try {
      outcome = next()
    } catch (error) {
      settle()
      throw error
    }
    Promise.resolve(outcome).then(settle, settle)
    return outcome
  })

  // The model asked the user a structured question.
  ctx.on('user-questions/request', (request, next) => {
    const questions = normalizeQuestions(request?.questions)
    const settle = track('question', {
      agent: agentLabel(request?.agent),
      timed: request?.wait?.timed === true,
      questions,
    })
    watchSignal(request?.signal ?? request?.questions?.[0]?.signal, settle)

    let answer
    try {
      answer = next()
    } catch (error) {
      settle()
      throw error
    }
    Promise.resolve(answer).then(settle, settle)
    return answer
  })

  function respond() {
    return Response.json(snapshot(), {
      headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
    })
  }

  async function handle(request) {
    try {
      if (request.method === 'POST') {
        const body = await request.json().catch(() => null)
        if (body && typeof body === 'object') {
          let changed = false
          if (typeof body.sound === 'boolean' && body.sound !== settings.sound) {
            settings.sound = body.sound
            changed = true
          }
          if (typeof body.popup === 'boolean' && body.popup !== settings.popup) {
            settings.popup = body.popup
            changed = true
          }
          if (changed) {
            saveSettings(settings)
            revision += 1
          }
          if (body.ping === true) {
            const settle = track('test', { agent: '' })
            const timer = setTimeout(settle, PING_LIFETIME)
            if (timer && typeof timer.unref === 'function') timer.unref()
          }
        }
      }
    } catch {
      /* fall through: the current snapshot is still a useful answer */
    }
    return respond()
  }

  ctx.inject(['connection', 'webServer'], (scope) => {
    try {
      const dispose = scope.connection.fetch.register({
        path: ROUTE,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: handle,
      })
      if (typeof dispose === 'function') {
        ctx.effect(() => dispose, 'attention-reminder: route')
      }
    } catch (error) {
      console.warn('[dsh-attention-reminder] could not register', ROUTE, error)
    }
  })
}
