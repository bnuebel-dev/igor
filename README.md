# IGOR

**I**ntelligenter **G**ehilfe **O**hne **R**uhepause: ein KI-Assistent für die Datenbrille Even Realities G2. Man spricht, IGOR antwortet auf der Brille und nennt einen dabei immer „Boss“. Die Modelle kommen von [OpenRouter](https://openrouter.ai), man bringt seinen eigenen Schlüssel mit.

Stand: **Version 0.5.3**. IGOR hört zu, antwortet in Seiten, die auf die Brille passen, hat ein Gedächtnis mit Notizen und Themen, beantwortet Fragen zu Ihren eigenen Unterlagen und kann bei Bedarf im Internet suchen.

## Bedienung an der Brille

| Wo | Geste | Wirkung |
|---|---|---|
| Startseite | Tippen | sprechen, nochmals tippen: senden |
| Startseite | Gedrückt halten | sprechen, loslassen: senden |
| Startseite | Wisch runter | Menü |
| Startseite | Doppeltippen | Beenden-Dialog |
| Aufnahme | Doppeltippen | abbrechen |
| Antwort | Wisch runter / hoch | nächste / vorige Seite |
| Antwort | Tippen | neue Frage |
| Antwort | Doppeltippen | zurück zur Startseite |
| Merk-Vorschlag | Tippen / Doppeltippen | ja / nein |
| Menü | Tippen | Eintrag wählen |

Menü: Neuer Chat, Thema wählen, Modell wählen (die zehn Favoriten), Notizen ansehen, Beenden.

## Gedächtnis

- **Gespräch:** Die letzten Fragen und Antworten gehen mit. „Neuer Chat“ beginnt leer.
- **Notizen:** Sagen Sie „Merk dir: Mein Hund heißt Rex“. IGOR speichert es sofort. Er kann auch selbst vorschlagen („Merken, Boss?“), Tippen bestätigt.
- **Themen:** „Thema Garten“ legt ein Thema an oder wählt es. Jedes Thema hat eigene Notizen, einen Verlauf und eine laufende Zusammenfassung, die IGOR nach drei Fragen und beim Verlassen erneuert. „Kein Thema“ geht zurück zum allgemeinen Chat.
- **Handy-Seite:** Reiter „Gedächtnis“ zeigt alles, zum Ändern und Löschen, mit Sicherung als Text.
- **Datenschutz:** Das Gedächtnis liegt im Speicher der Even-App auf dem Handy. Notizen und Zusammenfassungen gehen mit jeder Anfrage an OpenRouter und das gewählte Modell.

## Unterlagen

Auf der Handy-Seite unter **Unterlagen** fügen Sie Dateien hinzu (MD, TXT, PDF, auch aus pCloud über die Android-Dateiauswahl). IGOR zerlegt sie in Abschnitte (Markdown nach Überschriften, PDF nach Seiten), merkt sich Titel und Tags aus dem Kopf einer Markdown-Datei und sucht bei jeder Frage die passenden Abschnitte heraus. Nur diese Auszüge gehen mit der Frage an das Modell, mit Quellenangabe („laut Mietvertrag, Seite 4“). Steht die Antwort nicht darin, sagt IGOR das.

- Jede Datei lässt sich einem Thema zuordnen; Dokumente des aktuellen Themas werden bevorzugt.
- Eine Datei mit gleichem Pfad ersetzt die ältere Fassung.
- Grenzen: 2 Mio. Zeichen je Datei, 8 Mio. insgesamt. Eingescannte PDFs ohne Text werden abgelehnt.
- Die Suche läuft auf dem Handy und kostet nichts. **Suche ausprobieren** zeigt, was IGOR zu einer Frage finden würde.
- Datenschutz: Die Dokumente liegen im Speicher der Even-App. Die gefundenen Auszüge gehen mit der Frage an OpenRouter und das gewählte Modell.

### pCloud

Unter **Unterlagen → pCloud** melden Sie sich einmal bei pCloud an (OAuth, IGOR bekommt nur Lesezugriff) und wählen einen Ordner. IGOR liest daraus alle MD-, TXT- und PDF-Dateien samt Unterordnern und gleicht bei jedem Start ab: neue und geänderte Dateien werden nachgeladen, gelöschte entfernt (von Hand hochgeladene Dateien bleiben unberührt). Der Pfad bleibt erhalten, so heißt eine Quelle zum Beispiel „Notizen/Haus/angebot.md“.

Einrichtung bei pCloud: App unter https://docs.pcloud.com/my_apps/ anlegen, **Redirect URI** `https://bnuebel-dev.github.io/igor/`, **Allow implicit grant** an. Die Client-ID steht in `src/pcloud.ts`; im Reiter Diagnose lässt sich eine andere eintragen.

## Websuche

Standardmäßig aus.

Braucht eine Frage aktuelle Infos (Nachrichten, Wetter, Preise, Ergebnisse, Öffnungszeiten), sucht das Modell selbst über die Websuche von OpenRouter (`openrouter:web_search`). Bei allgemeinem Wissen sucht es nicht. Höchstens zwei Suchen pro Frage. Eine Suche kostet etwa 1 Cent extra und dauert ein bis drei Sekunden. Einstellbar unter **Einstellungen → Websuche**. Modelle ohne Werkzeug-Unterstützung antworten automatisch ohne Suche. **Diagnose → 6 Websuche** prüft, ob das gewählte Modell sucht.

## Ohne Brille

Die Handy-Seite hat eine „Brillen-Anzeige“ mit Tasten für Tippen, Wischen und Halten. Damit lässt sich IGOR im Browser bedienen, auch mit dem Browser-Mikrofon.

## Auf der Brille starten

1. Am Rechner unter https://hub.evenrealities.com/login mit dem Konto der Even-App anmelden (schaltet den Entwicklerbereich frei), die Even-App neu starten.
2. In der Even-App: **Even Hub** → Symbol oben rechts → **Entwickler-Hub** → **Prototyp-Modus** → **QR-Code scannen**.
3. Diesen QR-Code scannen. Er enthält `https://bnuebel-dev.github.io/igor/`.

   ![QR-Code](docs/qr.png)

4. Auf dem Handy unter **Einstellungen** den OpenRouter-Schlüssel einfügen und **Speichern**.
5. Auf der Brille tippen und sprechen.

Der Reiter **Diagnose** enthält die Verbindungstests und das Protokoll (**Protokoll kopieren**), falls etwas nicht klappt.

## Entwickeln

```bash
npm install
npm run check      # Typprüfung und Tests
npm run dev        # Dev-Server auf Port 5173
npm run simulate   # Even-Simulator gegen den Dev-Server
npm run pack       # Build und igor.ehpk
```

Ohne Netz zu OpenRouter, mit lokalem Nachbau der benötigten Endpunkte:

```bash
node scripts/mock-openrouter.mjs 8787
VITE_OPENROUTER_API=http://localhost:8787/api/v1 npm run dev
```

Bei jedem Push auf `main` baut GitHub Actions die App, prüft sie, erzeugt `igor.ehpk` als Artefakt und veröffentlicht sie auf GitHub Pages. Dafür muss unter **Settings → Pages → Source** „GitHub Actions“ gewählt sein.

## Aufbau

| Datei | Aufgabe |
|---|---|
| `src/main.ts` | Verdrahtung: Brille, Handy-Seite, Speicher, Dienste |
| `src/assistant.ts` | Zustandsautomat der Brille: Gesten, Aufnahme, Antworten, Menü, Merk-Vorschläge |
| `src/library.ts`, `src/libraryStore.ts`, `src/ingest.ts` | Unterlagen: Abschnitte, Stichwortsuche, Speicher, Einlesen von MD/TXT/PDF |
| `src/pcloud.ts`, `src/pcloudSync.ts` | pCloud: Anmeldung, Ordnerliste, Download, Abgleich mit der Bibliothek |
| `src/memory.ts` | Notizen, Themen, Zusammenfassungen, Speicherung |
| `src/prompt.ts` | Aufbau der Anfrage aus Persona, Gedächtnis und Verlauf |
| `src/pager.ts` | Seitenteilung mit der Schrift der Brille (`@evenrealities/pretext`) |
| `src/marker.ts` | Merk-Vorschläge des Modells und gesprochene Befehle |
| `src/phone.ts` | Handy-Seite mit Start, Gedächtnis, Einstellungen, Diagnose |
| `src/glasses.ts` | Alle Brillen-Aufrufe seriell mit Zeitlimit, Text-Updates zusammengefasst |
| `src/catalog.ts` | Kuratierte Top-10-Listen für Chat und Spracherkennung: kurze Namen mit Eigenschaft in Klammern, jeweils die neueste Version aus der echten Modellliste |
| `src/openrouter.ts` | Modelle, Schlüssel, Chat (mit Streaming), Spracherkennung |
| `src/events.ts` | Gesten aus SDK-Ereignissen, Duplikatfilter |
| `src/pcm.ts` | Mikrofonpuffer, WAV-Kopf, Base64 |
| `src/text.ts` | Klartext für die Brille, Byte-Limit pro Container |
| `src/persona.ts` | Standard-Persona: IGOR siezt und nennt Sie „Boss“ |
