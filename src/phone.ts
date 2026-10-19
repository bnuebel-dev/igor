import { CUSTOM, withSelected, type Choice } from './catalog.ts'
import type { Gesture } from './events.ts'
import type { DocMeta } from './library.ts'
import type { Memory } from './memory.ts'
import { DEFAULT_PERSONA } from './persona.ts'
import type { Settings } from './storage.ts'

export type Screen = { kind: 'text'; text: string } | { kind: 'list'; title: string; items: string[] }
type Level = 'info' | 'ok' | 'fail'
type Picker = 'chatModel' | 'sttModel'
export type Tab = 'start' | 'memory' | 'docs' | 'settings' | 'diag'

export type Handlers = {
  /** Every button on the page; `data` carries ids and the contents of related input fields. */
  action(name: string, data: Record<string, string>): void
  /** Virtual glasses: the same gestures the temples send. */
  gesture(g: Gesture, index?: number): void
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// ---- Model pickers ----------------------------------------------------------------------------

function fillPicker(which: Picker, choices: Choice[], selected: string) {
  const list = withSelected(choices, selected)
  const select = $<HTMLSelectElement>(which)
  select.innerHTML =
    list.map(c => `<option value="${esc(c.id)}">${esc(c.text)}</option>`).join('') + `<option value="${CUSTOM}">Andere …</option>`
  select.value = list.some(c => c.id === selected) ? selected : list[0]?.id ?? CUSTOM
  select.dataset.info = JSON.stringify(Object.fromEntries(list.map(c => [c.id, c.price ?? ''])))
  syncPicker(which)
}

function syncPicker(which: Picker) {
  const select = $<HTMLSelectElement>(which)
  const custom = $<HTMLInputElement>(`${which}Custom`)
  const customOn = select.value === CUSTOM
  custom.hidden = !customOn
  const prices: Record<string, string> = JSON.parse(select.dataset.info ?? '{}')
  $(`${which}Info`).textContent = customOn ? '' : [select.value, prices[select.value]].filter(Boolean).join(' · ')
}

const pickedId = (which: Picker): string => {
  const select = $<HTMLSelectElement>(which)
  return select.value === CUSTOM ? $<HTMLInputElement>(`${which}Custom`).value.trim() : select.value
}

// ---- Page -------------------------------------------------------------------------------------

export function mountPhone(h: Handlers) {
  $('app').innerHTML = `
    <main>
      <header>
        <h1>IGOR <small id="version"></small></h1>
        <div id="status" class="chip">Starte…</div>
      </header>
      <nav id="tabs">
        <button data-tab="start">Start</button>
        <button data-tab="memory">Gedächtnis</button>
        <button data-tab="docs">Unterlagen</button>
        <button data-tab="settings">Einstellungen</button>
        <button data-tab="diag">Diagnose</button>
      </nav>

      <section data-panel="start">
        <p id="info" class="info"></p>
        <div class="row">
          <label>Thema<select id="topicSelect"></select></label>
          <button data-action="newChat" class="quiet">Neuer Chat</button>
        </div>
        <div id="transcript" class="transcript"><p class="hint">Hier erscheinen Ihre Gespräche. Fragen Sie an der Brille oder tippen Sie hier.</p></div>
        <textarea id="question" rows="2" placeholder="Frage an IGOR …"></textarea>
        <button data-action="ask" class="primary">An IGOR senden</button>
        <h2>Brillen-Anzeige</h2>
        <div id="preview" class="glass"></div>
        <div id="virtual" class="keys" hidden>
          <button data-gesture="scroll-up">▲ Wisch hoch</button>
          <button data-gesture="scroll-down">▼ Wisch runter</button>
          <button data-gesture="tap">Tippen</button>
          <button data-gesture="double-tap">Doppeltippen</button>
          <button data-hold="1" class="wide">Gedrückt halten zum Sprechen</button>
        </div>
      </section>

      <section data-panel="memory">
        <h2>Allgemeine Notizen</h2>
        <ul id="notes" class="list"></ul>
        <div class="add"><input id="noteNew" placeholder="Neue Notiz, z. B. Hund heißt Rex" maxlength="200"><button data-action="note:add">+</button></div>
        <h2>Themen</h2>
        <div id="topics"></div>
        <div class="add"><input id="topicNew" placeholder="Neues Thema, z. B. Garten" maxlength="40"><button data-action="topic:add">+</button></div>
        <h2>Sicherung</h2>
        <p class="hint">Das Gedächtnis liegt nur im Speicher der Even-App. Sichern Sie es gelegentlich.</p>
        <textarea id="backup" rows="4" placeholder="Hier erscheint die Sicherung, oder fügen Sie eine ein."></textarea>
        <div class="row"><button data-action="backup:export">Exportieren</button><button data-action="backup:import">Importieren</button></div>
        <button data-action="memory:reset" class="danger">Gedächtnis löschen</button>
      </section>

      <section data-panel="docs">
        <button data-action="lib:add" class="primary">Dateien oder ZIP hinzufügen</button>
        <input type="file" id="libFiles" multiple accept=".md,.markdown,.txt,.pdf,.zip,text/markdown,text/plain,application/pdf,application/zip" hidden>
        <p class="hint">MD, TXT und PDF, auch viele auf einmal. <strong>Ganze Ordner:</strong> in der Dateien-App den Ordner (auch aus pCloud) markieren, „Komprimieren“ bzw. „ZIP erstellen“ wählen und die ZIP-Datei hier auswählen. Unterordner bleiben erhalten, versteckte Ordner wie .trash werden übersprungen. Dieselbe Datei erneut hinzufügen ersetzt die ältere Fassung. Eingescannte PDFs ohne Text werden nicht gelesen.</p>
        <p id="libInfo" class="info"></p>
        <div id="libList"></div>
        <h2>Suche ausprobieren</h2>
        <div class="row"><label>Frage oder Stichwort<input id="libQuery" autocomplete="off"></label><button data-action="lib:search" class="quiet">Suchen</button></div>
        <div id="libResults"></div>
      </section>

      <section data-panel="settings">
        <label>OpenRouter-API-Schlüssel<input id="apiKey" type="password" autocomplete="off" placeholder="sk-or-…"></label>
        <label>Chat-Modell<select id="chatModel"></select></label>
        <input id="chatModelCustom" class="custom" placeholder="Modell-ID, z. B. vendor/modell" autocomplete="off" hidden>
        <p id="chatModelInfo" class="info"></p>
        <label>Spracherkennung<select id="sttModel"></select></label>
        <input id="sttModelCustom" class="custom" placeholder="Modell-ID" autocomplete="off" hidden>
        <p id="sttModelInfo" class="info"></p>
        <div class="row">
          <label>Audioformat<select id="sttFormat"><option value="wav">wav (empfohlen)</option><option value="pcm">pcm (roh, oft abgelehnt)</option></select></label>
          <label>Sprache<input id="language" maxlength="5"></label>
        </div>
        <label>Websuche<select id="webSearch"><option value="on">an: sucht, wenn die Frage aktuelle Infos braucht</option><option value="off">aus</option></select></label>
        <p class="info">Eine Suche kostet etwa 1 Cent zusätzlich und dauert ein bis drei Sekunden.</p>
        <label>Persönlichkeit von IGOR<textarea id="persona" rows="6"></textarea></label>
        <div class="row"><button data-action="persona:reset" class="quiet">Standard</button><button data-action="save" class="primary">Speichern</button></div>
      </section>

      <section data-panel="diag">
        <div class="grid">
          <button data-action="cors">1 Verbindung</button>
          <button data-action="key">2 Schlüssel</button>
          <button data-action="chat-plain">3 Chat</button>
          <button data-action="chat-stream">4 Chat-Stream</button>
        </div>
        <button data-action="all" class="primary">Tests 1 bis 4 nacheinander</button>
        <button data-action="mic">5 Sprachtest (5 s sprechen)</button>
        <button data-action="search">6 Websuche</button>
        <p class="hint">Test 5 spricht in die Brille (im Browser: ins Mikrofon) und prüft Mikrofon, Erkennung und Antwort. Test 6 fragt nach den Nachrichten des Tages und zeigt, ob das Modell gesucht hat.</p>
        <h2>Protokoll</h2>
        <button data-action="copy">Protokoll kopieren</button>
        <ol id="log"></ol>
      </section>
    </main>`
  injectStyles()

  const lines: string[] = []
  const open = new Set<string>()
  let tab: Tab = 'start'
  let libListOpen = false
  const showTab = (t: Tab) => {
    tab = t
    document.querySelectorAll<HTMLElement>('[data-panel]').forEach(p => (p.hidden = p.dataset.panel !== t))
    document.querySelectorAll<HTMLElement>('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t))
  }
  showTab('start')

  const app = $('app')
  app.addEventListener('change', e => {
    const id = (e.target as HTMLElement).id
    if (id === 'chatModel' || id === 'sttModel') syncPicker(id)
    if (id === 'libFiles') h.action('lib:picked', {})
    const docSel = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-doc-topic]')
    if (docSel) h.action('lib:topic', { id: docSel.dataset.docTopic!, topic: docSel.value })
    if (id === 'topicSelect') h.action('topic:select', { id: (e.target as HTMLSelectElement).value })
  })
  app.addEventListener('toggle', e => {
    const d = e.target as HTMLDetailsElement
    if (d.id === 'libDetails') libListOpen = d.open
    if (d.dataset?.topic) d.open ? open.add(d.dataset.topic) : open.delete(d.dataset.topic)
  }, true)
  app.addEventListener('click', e => {
    const el = e.target as HTMLElement
    const tabBtn = el.closest<HTMLElement>('[data-tab]')
    if (tabBtn) return showTab(tabBtn.dataset.tab as Tab)
    const g = el.closest<HTMLElement>('[data-gesture]')
    if (g) return h.gesture(g.dataset.gesture as Gesture)
    const item = el.closest<HTMLElement>('[data-list-index]')
    if (item) return h.gesture('tap', Number(item.dataset.listIndex))
    const btn = el.closest<HTMLButtonElement>('button[data-action]')
    if (!btn) return
    const data: Record<string, string> = { ...btn.dataset } as Record<string, string>
    // Buttons inside a topic read that topic's fields; the others read the general ones.
    const scope = btn.closest<HTMLElement>('[data-topic]')
    const inner = (sel: string) => scope?.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)?.value ?? ''
    data.text = scope ? inner('.f-note') : $<HTMLInputElement>('noteNew').value
    data.name = scope ? inner('.f-name') : $<HTMLInputElement>('topicNew').value
    data.summary = inner('.f-summary')
    data.backup = $<HTMLTextAreaElement>('backup').value
    data.question = $<HTMLTextAreaElement>('question').value
    data.query = $<HTMLInputElement>('libQuery').value
    h.action(btn.dataset.action!, data)
  })
  // Push-to-talk on the virtual glasses.
  const hold = app.querySelector<HTMLElement>('[data-hold]')!
  hold.addEventListener('pointerdown', () => h.gesture('long-press'))
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) hold.addEventListener(ev, () => h.gesture('long-release'))

  return {
    setVersion(v: string) {
      $('version').textContent = v
    },
    setStatus(text: string, kind: 'ok' | 'warn' | 'fail' = 'ok') {
      const el = $('status')
      el.textContent = text
      el.className = `chip chip-${kind}`
    },
    log(level: Level, msg: string) {
      const time = new Date().toLocaleTimeString('de-DE')
      lines.push(`${time} ${level === 'ok' ? '✓' : level === 'fail' ? '✗' : '·'} ${msg}`)
      const li = document.createElement('li')
      li.className = level
      li.innerHTML = `<time>${time}</time> ${esc(msg)}`
      $('log').prepend(li)
    },
    logText: () => lines.join('\n'),

    // settings
    readSettings(): Settings {
      const persona = $<HTMLTextAreaElement>('persona').value.trim()
      return {
        apiKey: $<HTMLInputElement>('apiKey').value.trim(),
        chatModel: pickedId('chatModel'),
        sttModel: pickedId('sttModel'),
        sttFormat: $<HTMLSelectElement>('sttFormat').value as Settings['sttFormat'],
        language: $<HTMLInputElement>('language').value.trim(),
        persona: persona === DEFAULT_PERSONA ? '' : persona,
        webSearch: $<HTMLSelectElement>('webSearch').value === 'on',
      }
    },
    writeSettings(s: Settings) {
      $<HTMLInputElement>('apiKey').value = s.apiKey
      $<HTMLSelectElement>('sttFormat').value = s.sttFormat
      $<HTMLInputElement>('language').value = s.language
      $<HTMLTextAreaElement>('persona').value = s.persona || DEFAULT_PERSONA
      $<HTMLSelectElement>('webSearch').value = s.webSearch ? 'on' : 'off'
    },
    resetPersona: () => ($<HTMLTextAreaElement>('persona').value = DEFAULT_PERSONA),
    setChatChoices: (c: Choice[], selected: string) => fillPicker('chatModel', c, selected),
    setSttChoices: (c: Choice[], selected: string) => fillPicker('sttModel', c, selected),

    // start tab
    setInfo: (text: string) => ($('info').textContent = text),
    addExchange(q: string, a: string) {
      const box = $('transcript')
      box.querySelector('.hint')?.remove()
      box.insertAdjacentHTML('beforeend', `<p class="q">${esc(q)}</p><p class="a">${esc(a)}</p>`)
      box.scrollTop = box.scrollHeight
    },
    clearTranscript: () => ($('transcript').innerHTML = ''),
    question: () => $<HTMLTextAreaElement>('question').value.trim(),
    clearQuestion: () => ($<HTMLTextAreaElement>('question').value = ''),
    setPreview(screen: Screen) {
      const box = $('preview')
      if (screen.kind === 'text') box.innerHTML = `<pre>${esc(screen.text)}</pre>`
      else {
        box.innerHTML =
          `<pre>${esc(screen.title)}</pre><ul>` +
          screen.items.map((t, i) => `<li data-list-index="${i}">${esc(t)}</li>`).join('') +
          '</ul>'
      }
    },
    /** Virtual glasses controls: only shown when no real glasses are connected. */
    setVirtual: (on: boolean) => (($('virtual').hidden = !on)),

    // memory tab
    renderMemory(mem: Memory) {
      const sel = $<HTMLSelectElement>('topicSelect')
      sel.innerHTML = ['<option value="">Kein Thema</option>', ...mem.topics.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`)].join('')
      sel.value = mem.currentTopicId ?? ''

      $('notes').innerHTML = mem.notes.length
        ? mem.notes.map(n => `<li>${esc(n.text)}<button class="x" data-action="note:del" data-id="${esc(n.id)}" aria-label="Löschen">×</button></li>`).join('')
        : '<li class="hint">Noch keine Notizen. Sagen Sie „Merk dir …“ oder lassen Sie IGOR etwas vorschlagen.</li>'

      $('topics').innerHTML = mem.topics.length
        ? mem.topics
            .map(t => {
              const current = t.id === mem.currentTopicId
              return `<details data-topic="${esc(t.id)}"${open.has(t.id) ? ' open' : ''}>
                <summary>${current ? '● ' : ''}${esc(t.name)} <span class="hint">${t.notes.length} Notizen</span></summary>
                <div class="row">
                  <button data-action="topic:select" data-id="${esc(t.id)}">${current ? 'Aktiv' : 'Aktivieren'}</button>
                  <button data-action="topic:clearHistory" data-id="${esc(t.id)}" class="quiet">Verlauf leeren</button>
                </div>
                <label>Stand (Zusammenfassung)<textarea class="f-summary" rows="4">${esc(t.summary)}</textarea></label>
                <button data-action="topic:summary" data-id="${esc(t.id)}">Zusammenfassung speichern</button>
                <ul class="list">${t.notes.map(n => `<li>${esc(n.text)}<button class="x" data-action="note:del" data-id="${esc(n.id)}" aria-label="Löschen">×</button></li>`).join('')}</ul>
                <div class="add"><input class="f-note" placeholder="Notiz zu diesem Thema" maxlength="200"><button data-action="note:add" data-topic-id="${esc(t.id)}">+</button></div>
                <div class="add"><input class="f-name" value="${esc(t.name)}" maxlength="40"><button data-action="topic:rename" data-id="${esc(t.id)}">Umbenennen</button></div>
                <button data-action="topic:del" data-id="${esc(t.id)}" class="danger">Thema löschen</button>
              </details>`
            })
            .join('')
        : '<p class="hint">Noch keine Themen. Sagen Sie „Thema Garten“ oder legen Sie eines an.</p>'
    },
    renderLibrary(docs: DocMeta[], topics: { id: string; name: string }[], summary: string, clearArmed = false) {
      $('libInfo').textContent = summary
      const list = docs.length
        ? docs
            .map(d => {
              const where = d.pages ? `${d.pages} Seite${d.pages > 1 ? 'n' : ''}` : `${Math.max(1, Math.round(d.chars / 1000))}k Zeichen`
              const opts = [`<option value="">kein Thema</option>`, ...topics.map(t => `<option value="${esc(t.id)}"${t.id === d.topicId ? ' selected' : ''}>${esc(t.name)}</option>`)]
              return `<div class="doc"><strong>${esc(d.path)}</strong>
                <span class="hint">${d.kind.toUpperCase()} · ${where}${d.tags.length ? ` · ${esc(d.tags.slice(0, 4).join(', '))}` : ''}</span>
                <div class="row"><select data-doc-topic="${esc(d.id)}">${opts.join('')}</select>
                <button data-action="lib:remove" data-id="${esc(d.id)}" class="quiet">Löschen</button></div></div>`
            })
            .join('')
        : '<p class="hint">Noch keine Unterlagen.</p>'
      // A long list would push everything else off the screen: fold it up beyond a dozen.
      $('libList').innerHTML =
        (docs.length > 12 ? `<details id="libDetails"${libListOpen ? ' open' : ''}><summary>Alle ${docs.length} Dokumente anzeigen</summary>${list}</details>` : list) +
        (docs.length ? `<button data-action="lib:clear" class="danger">${clearArmed ? 'Wirklich alles löschen? Nochmal tippen' : 'Alle Unterlagen löschen'}</button>` : '')
    },
    setLibraryInfo(text: string) {
      $('libInfo').textContent = text
    },
    renderSearch(passages: { source: string; text: string }[]) {
      $('libResults').innerHTML = passages.length
        ? passages.map(p => `<div class="doc"><strong>${esc(p.source)}</strong><span class="hint">${esc(p.text.length > 320 ? `${p.text.slice(0, 320)}…` : p.text)}</span></div>`).join('')
        : '<p class="hint">Nichts gefunden.</p>'
    },
    clearInputs() {
      $<HTMLInputElement>('noteNew').value = ''
      $<HTMLInputElement>('topicNew').value = ''
    },
    backupText: (text?: string) => (text === undefined ? $<HTMLTextAreaElement>('backup').value : (($<HTMLTextAreaElement>('backup').value = text), text)),
    showTab,
    get tab() {
      return tab
    },
    setBusy(busy: boolean) {
      document.querySelectorAll<HTMLButtonElement>('[data-panel="diag"] button[data-action]:not([data-action="copy"])').forEach(b => (b.disabled = busy))
    },
  }
}

export type Phone = ReturnType<typeof mountPhone>

function injectStyles() {
  // Even app dark tokens; the glasses green (#3CFA44) is used only for the glasses preview.
  const css = `
    :root { color-scheme: dark; }
    [hidden] { display: none !important; }
    html, body { margin: 0; background: #111; color: #fff; font: 16px/1.45 system-ui, -apple-system, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
    main { max-width: 640px; margin: 0 auto; padding: 16px 16px 48px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    h1 small { font-size: 13px; font-weight: 400; color: #8a8a8a; letter-spacing: 0; }
    h1 { font-size: 24px; font-weight: 600; letter-spacing: -0.02em; margin: 0; }
    h2 { font-size: 13px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; color: #8a8a8a; margin: 24px 0 8px; }
    nav { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; margin: 12px 0 16px; background: #1a1a1a; border-radius: 12px; padding: 4px; }
    nav button { margin: 0; padding: 8px 2px; font-size: 13px; background: transparent; border-radius: 9px; }
    nav button.on { background: #2e2e2e; }
    nav button:nth-child(-n+3) { grid-column: span 2; }
    nav button:nth-child(n+4) { grid-column: span 3; }
    .doc { background: #232323; border-radius: 12px; padding: 10px 12px; margin-top: 8px; }
    .doc strong { display: block; font-weight: 500; overflow-wrap: anywhere; }
    .doc .hint { display: block; margin: 2px 0 4px; overflow-wrap: anywhere; white-space: pre-line; }
    .doc .row { align-items: end; }
    section { background: #1a1a1a; border-radius: 16px; padding: 16px; }
    label { display: block; font-size: 13px; color: #8a8a8a; margin-bottom: 12px; }
    input, select, textarea { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; background: rgba(255,255,255,0.08);
      color: #fff; border: 0; border-radius: 10px; padding: 10px 12px; font: inherit; }
    textarea { resize: vertical; }
    button { width: 100%; padding: 11px; border: 0; border-radius: 12px; font: inherit; font-weight: 500; background: #2a2a2a; color: #fff; margin-top: 6px; }
    button.primary { background: #fef991; color: #111; }
    button.quiet { background: #232323; color: #bbb; }
    button.danger { background: #3a1f1d; color: #ff8a80; margin-top: 12px; }
    button:disabled { opacity: 0.4; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: end; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
    .add { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin: 8px 0; }
    .add input { margin: 0; } .add button { width: auto; margin: 0; padding: 10px 14px; }
    .chip { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid #3e3e3e; white-space: nowrap; }
    .chip-ok { color: #9be89e; border-color: #4a7a4c; } .chip-warn { color: #fef991; border-color: #7a7646; } .chip-fail { color: #ff6b61; border-color: #7a3a36; }
    .info { margin: 0 0 12px; font-size: 13px; color: #8a8a8a; overflow-wrap: anywhere; }
    label + .info, .custom + .info { margin-top: -6px; font-size: 12px; color: #6a6a6a; }
    .custom { margin: -4px 0 8px; }
    .hint { color: #8a8a8a; font-size: 13px; }
    .transcript { max-height: 38vh; overflow-y: auto; margin: 8px 0; padding: 4px 0; }
    .transcript p { margin: 6px 0; padding: 8px 12px; border-radius: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }
    .transcript .q { background: #2a2a2a; margin-left: 24px; }
    .transcript .a { background: #20261f; margin-right: 24px; }
    .list { list-style: none; padding: 0; margin: 0; }
    .list li { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 8px 0; border-top: 1px solid #262626; overflow-wrap: anywhere; }
    .x { width: 32px; height: 32px; padding: 0; margin: 0; flex: none; background: #2a2a2a; border-radius: 16px; }
    details { border-top: 1px solid #262626; padding: 10px 0; }
    summary { cursor: pointer; font-weight: 500; }
    .glass { background: #000; border: 1px solid #1f3a20; border-radius: 10px; padding: 10px; color: #3cfa44; min-height: 120px; }
    .glass pre { margin: 0; white-space: pre-wrap; font: 14px/1.5 ui-monospace, monospace; overflow-wrap: anywhere; }
    .glass ul { list-style: none; margin: 8px 0 0; padding: 0; border: 1px solid #1f3a20; border-radius: 6px; }
    .glass li { padding: 6px 8px; font: 14px ui-monospace, monospace; cursor: pointer; }
    .keys { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
    .keys .wide { grid-column: 1 / -1; }
    #log { list-style: none; padding: 0; margin: 12px 0 0; font: 13px/1.4 ui-monospace, monospace; }
    #log li { padding: 6px 0; border-top: 1px solid #262626; word-break: break-word; }
    #log li.ok { color: #9be89e; } #log li.fail { color: #ff6b61; } #log time { color: #6a6a6a; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
