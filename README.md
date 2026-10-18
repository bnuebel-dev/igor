# IGOR

**I**ntelligenter **G**ehilfe **O**hne **R**uhepause: ein KI-Assistent für die Datenbrille Even Realities G2. Man spricht, IGOR antwortet auf der Brille und nennt einen dabei immer „Boss“. Die Modelle kommen von [OpenRouter](https://openrouter.ai), man bringt seinen eigenen Schlüssel mit.

Stand: **Phase 0 (Diagnose)**. Die App prüft, ob OpenRouter aus der Even-App heraus funktioniert, und enthält bereits den ganzen Sprachablauf.

## Auf der Brille testen

1. Even-App auf dem Handy öffnen, Entwicklermodus aktivieren (laut Community: im About-Bildschirm siebenmal auf die Versionsnummer tippen).
2. Diesen QR-Code mit dem Scanner der Even-App scannen. Er enthält `https://bnuebel-dev.github.io/igor/`.

   ![QR-Code](docs/qr.png)

3. Auf dem Handy erscheint die Diagnoseseite, auf der Brille „Zu Diensten, Boss.“
4. OpenRouter-Schlüssel eintragen und **Speichern**. Der Schlüssel bleibt im Speicher der Even-App auf dem Handy.
5. **Tests 1 bis 4 nacheinander** antippen.
6. An der Brille tippen, eine Frage sprechen, erneut tippen. Alternativ lange drücken, sprechen, loslassen.
7. **Protokoll kopieren** und das Ergebnis zurückmelden.

| Test | Prüft |
|---|---|
| 1 Verbindung | Ist `openrouter.ai` aus der WebView erreichbar (CORS)? |
| 2 Schlüssel | Ist der Schlüssel gültig? |
| 3 Chat | Antwort am Stück, mit Dauer und Kosten |
| 4 Chat-Stream | Kommt die Antwort gestreamt an? Zeit bis zum ersten Wort |
| 5 Sprache | Brillenmikrofon, Spracherkennung (`pcm` oder `wav`), Antwort auf der Brille |

## Bedienung auf der Brille

| Geste | Wirkung |
|---|---|
| Tippen | Aufnahme starten, nochmals tippen: senden |
| Lange drücken, loslassen | Sprechen, solange gedrückt |
| Doppeltippen | Während der Aufnahme: abbrechen. Sonst: Beenden-Dialog |

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
| `src/main.ts` | Start, Diagnose-Tests, Sprachablauf und Gesten |
| `src/glasses.ts` | Alle Brillen-Aufrufe seriell mit Zeitlimit, Text-Updates zusammengefasst |
| `src/openrouter.ts` | Modelle, Schlüssel, Chat (mit Streaming), Spracherkennung |
| `src/events.ts` | Gesten aus SDK-Ereignissen, Duplikatfilter |
| `src/pcm.ts` | Mikrofonpuffer, WAV-Kopf, Base64 |
| `src/text.ts` | Klartext für die Brille, Byte-Limit pro Container |
| `src/persona.ts` | Systemprompt: IGOR nennt dich Boss |
