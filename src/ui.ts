import type { Settings } from './storage.ts'
import type { ModelInfo } from './openrouter.ts'

export type Action = 'save' | 'cors' | 'key' | 'chat-plain' | 'chat-stream' | 'all' | 'ask' | 'copy'

type Level = 'info' | 'ok' | 'fail'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

export function mountUi(onAction: (action: Action) => void) {
  const app = $('app')
  app.innerHTML = `
    <main>
      <header>
        <h1>IGOR <span class="sub">Diagnose</span></h1>
        <div id="status" class="chip">Starte…</div>
      </header>
      <p class="lead">Intelligenter Gehilfe Ohne Ruhepause. Phase 0 prüft, ob OpenRouter aus der Even-App heraus erreichbar ist.</p>

      <section>
        <h2>OpenRouter</h2>
        <label>API-Schlüssel<input id="apiKey" type="password" autocomplete="off" placeholder="sk-or-…"></label>
        <label>Chat-Modell<input id="chatModel" list="chatModels" autocomplete="off"></label>
        <datalist id="chatModels"></datalist>
        <label>Spracherkennung<select id="sttModel"></select></label>
        <div class="row">
          <label>Audioformat<select id="sttFormat"><option value="pcm">pcm (roh)</option><option value="wav">wav</option></select></label>
          <label>Sprache<input id="language" maxlength="5"></label>
        </div>
        <button data-action="save" class="primary">Speichern</button>
      </section>

      <section>
        <h2>Tests</h2>
        <div class="grid">
          <button data-action="cors">1 Verbindung</button>
          <button data-action="key">2 Schlüssel</button>
          <button data-action="chat-plain">3 Chat</button>
          <button data-action="chat-stream">4 Chat-Stream</button>
        </div>
        <button data-action="all" class="primary">Tests 1 bis 4 nacheinander</button>
        <p class="hint">Test 5, Sprache: an der Brille tippen, sprechen, erneut tippen. Oder lange drücken, sprechen, loslassen.</p>
      </section>

      <section>
        <h2>Frage per Text</h2>
        <textarea id="question" rows="2" placeholder="Wie spät ist es auf dem Mars, Igor?"></textarea>
        <button data-action="ask">An IGOR senden</button>
      </section>

      <section>
        <h2>Protokoll</h2>
        <button data-action="copy">Protokoll kopieren</button>
        <ol id="log"></ol>
      </section>
    </main>`
  injectStyles()
  app.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')
    if (btn) onAction(btn.dataset.action as Action)
  })

  const lines: string[] = []

  return {
    setStatus(text: string, kind: 'ok' | 'warn' | 'fail' = 'ok') {
      const el = $('status')
      el.textContent = text
      el.className = `chip chip-${kind}`
    },
    log(level: Level, msg: string) {
      const time = new Date().toLocaleTimeString('de-DE')
      const mark = level === 'ok' ? '✓' : level === 'fail' ? '✗' : '·'
      lines.push(`${time} ${mark} ${msg}`)
      const li = document.createElement('li')
      li.className = level
      li.innerHTML = `<time>${time}</time> ${escapeHtml(msg)}`
      $('log').prepend(li)
    },
    logText: () => lines.join('\n'),
    read(): Settings {
      return {
        apiKey: $<HTMLInputElement>('apiKey').value.trim(),
        chatModel: $<HTMLInputElement>('chatModel').value.trim(),
        sttModel: $<HTMLSelectElement>('sttModel').value,
        sttFormat: $<HTMLSelectElement>('sttFormat').value as Settings['sttFormat'],
        language: $<HTMLInputElement>('language').value.trim(),
      }
    },
    write(s: Settings) {
      $<HTMLInputElement>('apiKey').value = s.apiKey
      $<HTMLInputElement>('chatModel').value = s.chatModel
      $<HTMLSelectElement>('sttFormat').value = s.sttFormat
      $<HTMLInputElement>('language').value = s.language
      this.setSttModels([], s.sttModel)
    },
    setChatModels(models: ModelInfo[]) {
      $('chatModels').innerHTML = models
        .map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}${m.inputModalities.includes('audio') ? ' (Audio)' : ''}</option>`)
        .join('')
    },
    setSttModels(models: ModelInfo[], selected: string) {
      const ids = [...new Set([selected, ...models.map(m => m.id)].filter(Boolean))]
      $('sttModel').innerHTML = ids
        .map(id => `<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(id)}</option>`)
        .join('')
    },
    question: () => $<HTMLTextAreaElement>('question').value.trim(),
    setBusy(busy: boolean) {
      document.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(b => {
        if (b.dataset.action !== 'copy') b.disabled = busy
      })
    },
  }
}

export type Ui = ReturnType<typeof mountUi>

function injectStyles() {
  // Even app dark tokens; the glasses green (#3CFA44) stays on the glasses.
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; background: #111; color: #fff;
      font: 16px/1.45 system-ui, -apple-system, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
    main { max-width: 640px; margin: 0 auto; padding: 20px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    h1 { font-size: 24px; font-weight: 600; letter-spacing: -0.02em; margin: 0; }
    h1 .sub { color: #8a8a8a; font-weight: 400; }
    h2 { font-size: 13px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; color: #8a8a8a; margin: 0 0 12px; }
    .lead, .hint { color: #8a8a8a; font-size: 14px; }
    section { background: #1a1a1a; border-radius: 16px; padding: 16px; margin: 16px 0; }
    label { display: block; font-size: 13px; color: #8a8a8a; margin-bottom: 12px; }
    input, select, textarea { display: block; width: 100%; box-sizing: border-box; margin-top: 4px;
      background: rgba(255,255,255,0.08); color: #fff; border: 0; border-radius: 10px;
      padding: 10px 12px; font: inherit; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
    button { width: 100%; padding: 12px; border: 0; border-radius: 12px; font: inherit; font-weight: 500;
      background: #2a2a2a; color: #fff; margin-top: 4px; }
    button.primary { background: #fef991; color: #111; }
    button:disabled { opacity: 0.4; }
    .chip { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid #3e3e3e; white-space: nowrap; }
    .chip-ok { color: #9be89e; border-color: #4a7a4c; }
    .chip-warn { color: #fef991; border-color: #7a7646; }
    .chip-fail { color: #ff6b61; border-color: #7a3a36; }
    #log { list-style: none; padding: 0; margin: 12px 0 0; font: 13px/1.4 ui-monospace, monospace; }
    #log li { padding: 6px 0; border-top: 1px solid #262626; word-break: break-word; }
    #log li.ok { color: #9be89e; } #log li.fail { color: #ff6b61; }
    #log time { color: #6a6a6a; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
