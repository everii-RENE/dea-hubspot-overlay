# [DEA] HubSpot Overlay Customizer

Ein Userscript (Violentmonkey / Tampermonkey), das in HubSpot-Tickets eine kompakte, verschiebbare Leiste einblendet. Sie bündelt alle wichtigen Teambox-Aktionen auf einen Blick: **DEA**, **Clones**, **Terminal**, **TablePlus**, **Custom Deployment**, **YouTrack** und **GitHub** – inklusive automatischer Erkennung des **Old Stack** (Customerbox).

Zusätzlich automatisiert das Script wiederkehrende Klickfolgen im Teambox Deployment Tool (Teambox löschen, Custom Deployment starten, HubSpot-Sync auslösen) und passt zwei Elemente der HubSpot-Oberfläche an.

| | |
|---|---|
| **Autor** | RENE |
| **Läuft auf** | `app-eu1.hubspot.com` und dem Teambox Deployment Tool |
| **Ausführung** | `document-idle` |

---

## Inhaltsverzeichnis

- [Installation](#installation)
- [Voraussetzungen](#voraussetzungen)
- [Die Leiste im Überblick](#die-leiste-im-überblick)
- [Funktionen im Detail](#funktionen-im-detail)
  - [1. Ticket-Erkennung und DEA-Ansicht](#1-ticket-erkennung-und-dea-ansicht)
  - [2. Clone-Verwaltung](#2-clone-verwaltung)
  - [3. DEA-Icon-Menü](#3-dea-icon-menü)
  - [4. Old-Stack-Ansicht (Customerbox)](#4-old-stack-ansicht-customerbox)
  - [5. Ticketbesitz-Schloss und HubSpot-Sync](#5-ticketbesitz-schloss-und-hubspot-sync)
  - [6. Fehleranzeigen](#6-fehleranzeigen)
  - [7. Automatisierungen im Deployment Tool](#7-automatisierungen-im-deployment-tool)
  - [8. Anpassungen der HubSpot-Oberfläche](#8-anpassungen-der-hubspot-oberfläche)
  - [9. Bedienung der Leiste](#9-bedienung-der-leiste)
- [Einstellungen](#einstellungen)
- [Gespeicherte Daten](#gespeicherte-daten)
- [Angesprochene Systeme](#angesprochene-systeme)
- [Technische Hinweise](#technische-hinweise)
- [Fehlersuche](#fehlersuche)

---

## Installation

1. Einen Userscript-Manager installieren, z. B. [Violentmonkey](https://violentmonkey.github.io/) (empfohlen) oder Tampermonkey.
2. Das Script über diesen Link installieren:

   ```
   https://raw.githubusercontent.com/everii-RENE/dea-hubspot-overlay/master/dea-hubspot-overlay.user.js
   ```

3. HubSpot neu laden. Sobald ein Ticket geöffnet ist, erscheint die Leiste oben links.

Updates werden über `@updateURL` / `@downloadURL` automatisch vom `master`-Branch bezogen.

## Voraussetzungen

- Zugriff auf die internen Systeme (Netzwerk bzw. VPN):
  - Teambox Deployment Tool (`production.teambox-deployment-tool.service.de1.everii`)
  - Customerbox (`customerbox.intevo`) – nur für Old-Stack-Tickets
- Angemeldet im **Teambox Deployment Tool** (sonst erscheint ein entsprechender Hinweis in der Leiste).
- Für Old-Stack-Tickets: eine aktive Session in **[C] Customerbox**.
- Für das TablePlus-Icon: ein registrierter `tableplus://`-Protokollhandler im Betriebssystem.

### Benötigte Rechte (`@grant`)

`GM_xmlhttpRequest`, `unsafeWindow`, `GM_setClipboard`, `GM_getValue`, `GM_setValue`, `GM_registerMenuCommand`
Erlaubte Verbindungsziele (`@connect`): Deployment Tool und Customerbox.

---

## Die Leiste im Überblick

```
[DEA-Icon]  kundenname ⚿     [T] [T II] [+]  [YouTrack] [GitHub]
            3.4.2 (MIBA)
```

- **Erste Zeile:** Kundenname (Teambox-Token), ggf. mit rotem Schloss
- **Zweite Zeile:** Release-Nummer und Kürzel des zuständigen Support-Agents
- **Rechts:** Icons für Clones, Create Clone, YouTrack und GitHub

Hat ein Ticket mehrere Teamboxen, werden sie nebeneinander dargestellt und durch einen Trenner getrennt.

### Icon-Legende

| Icon | Bedeutung |
|---|---|
| **DEA-Logo** | Öffnet die Teambox im Deployment Tool. Rechtsklick öffnet das [DEA-Icon-Menü](#3-dea-icon-menü) |
| **Grünes T** | Clone läuft – Klick öffnet den Clone (`/app/auth`) |
| **Graues T** | Clone läuft nicht (z. B. gestoppt) – Klick lädt die Leiste neu |
| **Graues T, sich grün füllend** | Clone wird gerade erstellt – Klick öffnet die Progress-Seite |
| **Graues T, sich rot füllend** | Clone wird gerade gelöscht – Klick öffnet die Lösch-Operation |
| **Römische Zahl am T** | Laufende Nummer des Clones, beginnend ab **II** (der erste Clone trägt keine Zahl) |
| **Create-Clone-Icon** | Neuen Clone anlegen (bzw. „weiteren Clone“, wenn schon einer existiert) |
| **Terminal** | Terminal des Clones im Deployment Tool |
| **TablePlus** | Öffnet die Clone-Datenbank in TablePlus (nur wenn die API eine TablePlus-URL liefert) |
| **Upgrade-Icon** | Custom Deployment der Teambox |
| **Papierkorb** | Teambox löschen |
| **YouTrack** | Bestehendes Issue öffnen oder neues Issue vorausgefüllt anlegen |
| **GitHub** | Commit-Verlauf des Kunden-Repositorys (`teambox-custom-<kunde>`) |
| **Rotes Schloss** | Ticket gehört (laut API) nicht dir – Klick startet den HubSpot-Sync |
| **Drehende Pfeile** | HubSpot-Sync läuft |

---

## Funktionen im Detail

### 1. Ticket-Erkennung und DEA-Ansicht

- Erkennt Tickets anhand der URL (`/record/0-5/<id>` oder `/ticket/<id>`) und lädt die Daten über die DEA-API.
- Reagiert auf Navigation innerhalb der HubSpot-Single-Page-App: Wechselst du das Ticket, wird die Leiste neu aufgebaut; verlässt du ein Ticket, verschwindet sie.
- Anzeige pro Teambox:
  - Kundenname (Token)
  - Release-Nummer (`core_release.revision`), sonst „Unbekannt“
  - Agent-Kürzel: erste zwei Buchstaben von Vor- und Nachname in Großbuchstaben (z. B. `MIBA`). Für einzelne Personen gibt es feste Ausnahmen. Ist kein Agent bekannt, steht dort „Unbekannt“.
- **GitHub-Link** zum Repository `everii-Group/teambox-custom-<kunde>` (Branch `master`, Commits).
- **YouTrack-Link:** genau ein verknüpftes Issue → direkter Link; mehrere → Issue-Liste; keines → „Neues Issue“-Link. Die Issues werden nachgeladen, ohne die Leiste zu blockieren.
- Die Deployment-Tool-URL einer Teambox wird pro Ticket „eingefroren“, damit der Link bei Neuladevorgängen stabil bleibt.
- Hat ein Ticket keine Teambox, erscheint „Keine Teambox für dieses Ticket gefunden“.

### 2. Clone-Verwaltung

**Clones anzeigen**
- Jeder Clone bekommt ein T-Icon, dessen Zustand (läuft / läuft nicht / wird erstellt / wird gelöscht) farblich und animiert dargestellt wird.
- Die Reihenfolge und die römische Nummerierung richten sich nach der Deployment-ID des Clones (Fallback: Erstellungszeitpunkt, dann API-Reihenfolge). Enthält der Clone-Name ein Muster wie `hs2-3`, wird die Nummer daraus abgeleitet.

**Aktionen pro Clone** (Rechtsklick auf das T öffnet ein Dropdown)

| Zustand | Menüeinträge |
|---|---|
| Läuft (Modus *dropdown*) | Teambox öffnen, TablePlus, Terminal, Custom Deployment, Löschen |
| Läuft (Modus *permanent*) | TablePlus und Terminal dauerhaft sichtbar; Dropdown mit Teambox, Custom Deployment, Löschen |
| Läuft nicht / wird erstellt | Teambox öffnen, Progress, Löschen |

Das Dropdown schließt sich bei Klick außerhalb, mit `Esc` und beim Verlassen des Fensters.

**Clone erstellen**
1. Klick auf das Create-Clone-Icon sendet die Anfrage an die DEA-API (`hubspot/clone`).
2. Es öffnet sich **kein** neuer Tab. Stattdessen fragt das Script jede Sekunde (bis zu 15 Minuten) den Status der Teambox-Seite ab.
3. Sobald der Clone `running` meldet, wird die Leiste neu geladen – einmal sofort und einmal nach 2,5 Sekunden, falls die API leicht hinterherhinkt.
4. Ein Klick auf das ladende T öffnet bei Bedarf die Progress-Seite.

**Clone löschen**
- Der Klick auf den Papierkorb öffnet die Löschseite in einem neuen Tab und startet im Hintergrund ein Polling (jede Sekunde, bis zu 15 Minuten).
- Währenddessen zeigt das T die rote Lösch-Animation; ein Klick darauf öffnet die zugehörige Operation.
- Existiert die Teambox nicht mehr, wird die Leiste automatisch aktualisiert.

### 3. DEA-Icon-Menü

Rechtsklick auf das DEA-Logo öffnet ein Menü mit:

- **Teambox-Domain** – öffnet `/app/auth` der Teambox-Domain (Domain wird von der Detailseite der Teambox gelesen)
- **Upgrade / Custom Deployment**
- **[C] Old-Stack-Leiste laden** – schaltet das aktuelle Ticket manuell auf die Old-Stack-Ansicht um

### 4. Old-Stack-Ansicht (Customerbox)

Tickets von Kunden, die noch auf dem alten Stack laufen, werden automatisch mit der Customerbox-Daten­quelle dargestellt.

**Wann wird der Old Stack verwendet?**
1. Die DEA-API kennzeichnet eine Teambox mit dem Badge **„Old stack“**, oder
2. **alle** Teamboxen des Tickets haben auf ihrer Detailseite den Status **Stopped** (Kunden, die bereits auf der neuen Infrastruktur angelegt sind, aber real noch auf dem Old Stack laufen), oder
3. du schaltest manuell um – über das DEA-Icon im Fehlerfall oder das DEA-Icon-Menü.

**Was wird angezeigt?**
- Kopfzeile: `<token>: <release>`
- Zweite Zeile: `(<Servicetyp>:<Server>) <Account-Manager>:<Land>` (Servicetypen: SaaS, OnP, Premium)
- Icons: Live-Teambox, Supportbox (bzw. „Create Clone im alten Stack“, falls noch keine existiert), Featurebox, YouTrack (mit vorausgefülltem Bug-Template inkl. Ticket-ID, Release und Kunde) und GitHub.
- Das Customerbox-Logo ist mit der Teambox in der Customerbox verlinkt.

**Parallele Abfrage:** Die Customerbox wird schon beim Öffnen des Tickets parallel zur DEA-Abfrage angefragt. Antwortet sie zuerst, wird sofort angezeigt; die DEA-Antwort bleibt aber für die endgültige Modus-Entscheidung maßgeblich.

**Session-Handling**
- Erfolgreiche Antworten werden 20 Sekunden im Tab zwischengespeichert.
- Mehrere HubSpot-Tabs reihen ihre Customerbox-Anfragen **tabübergreifend** hintereinander ein (Web Locks API, mit `localStorage`-Lock als Fallback), damit sich nicht zehn Tabs gleichzeitig an derselben Session anmelden.
- Bei „abgelaufener Session“ wird bis zu fünfmal mit steigender Wartezeit und Zufallsversatz wiederholt.
- Bei HTTP 401 oder dem Text „Anmeldung in [C] erforderlich“ wird sofort **ohne** Wiederholungen der Hinweis **„Anmeldung in [C] erforderlich“** angezeigt. Ein Klick öffnet die Customerbox in einem neuen Tab (der Tab bleibt für die Anmeldung offen) und lädt danach die Leiste neu.
- Nach 120 Sekunden ohne Ergebnis (und ohne laufende Anfrage) erscheint „Abgelaufene Session. Bitte [C] öffnen um Session zu aktualisieren.“ – der Klick öffnet die Customerbox kurz und schließt den Tab wieder.

### 5. Ticketbesitz-Schloss und HubSpot-Sync

Meldet die DEA-API, dass das Ticket **nicht zu dir gehört** („This ticket is not an open ticket of yours“), erscheint neben dem Kundennamen ein **rotes Schloss**. Ohne eindeutiges Signal der API wird *kein* Schloss angezeigt.

**Klick auf das Schloss startet den HubSpot-Sync:**
1. Die Ticketübersicht des Deployment Tools wird im Hintergrund geladen; CSRF-Token und Ziel des „Sync now“-Buttons werden ausgelesen.
2. Der Sync wird genau wie beim Klick im Tool ausgelöst. Das Schloss wird durch **drehende Pfeile** ersetzt.
3. **Fallback:** Schlägt der Hintergrund-Request fehl (z. B. nicht angemeldet), öffnet sich ein Tab (`/tickets#dea-auto-sync`), der „Sync now“ klickt und sich danach schließt.
4. Nach dem Sync prüft das Script nach 3, 6 und 10 Sekunden, ob das Ticket jetzt freigegeben ist, und zeichnet die Leiste nur dann neu, wenn sich etwas geändert hat (kein Flackern).

Ist der Sync-Button nicht verfügbar (läuft evtl. schon), wird das im Tooltip des Schlosses angezeigt.

### 6. Fehleranzeigen

Fehler erscheinen direkt in der Leiste. Das DEA-Icon wird in bestimmten Fällen zur Aktion:

| Fehler | Aktion beim Klick auf das DEA-Icon |
|---|---|
| „This ticket has not been synced from HubSpot yet“ | Lädt die Old-Stack-Ansicht |
| „Sign in to the Teambox Deployment Tool first“ | Öffnet das Deployment Tool |
| „DEA-Tool nicht erreichbar“ | Öffnet das Deployment Tool |
| „Ticket is not an open ticket of yours“ | Zusätzlicher **↻-Button** lädt die Leiste neu |

Die Sync-Meldung wird zusätzlich im sichtbaren Seitentext erkannt, falls sie vom separaten HubSpot-Overlay direkt gerendert wird.

### 7. Automatisierungen im Deployment Tool

Auf den Seiten des Teambox Deployment Tools übernimmt das Script folgende Schritte:

**Teambox löschen** (`/teamboxes/<id>/delete`)
- Liest den Teambox-Namen aus dem Seitentext, trägt ihn in das Bestätigungsfeld ein und kopiert ihn in die Zwischenablage.
- Klickt automatisch auf **„Delete all data“**. Das Formular wird per `fetch` gesendet, damit der Tab erst nach der Serverantwort geschlossen wird.
- Bei Ablehnung durch den Server (z. B. bei mehreren parallelen Löschungen) bis zu 3 Wiederholungen im Abstand von 1,5 s; danach bleibt der Tab offen und der Titel zeigt `[Löschen fehlgeschlagen: HTTP …]`.
- Der Tab wird zuverlässig geschlossen (mehrere Versuche), auch wenn kein Löschformular mehr existiert.

**Custom Deployment** (`/teamboxes/<id>/custom_deployment`)
- Merkt sich vor dem Absenden alle bereits vorhandenen Operation-IDs (Baseline).
- Klickt automatisch auf **„Submit“**.
- Leitet danach direkt auf die **neue** Operation weiter – erkannt über den Toast „Custom deployment … scheduled as Operation #N“ oder, falls dieser fehlt, durch regelmäßiges Neuladen der Teambox-Seite. Alte Operationen (z. B. ein vorheriger Sync) werden dank der Baseline ignoriert. Zeitlimit: 120 Sekunden.

**Teambox-Detailseite** (`/teamboxes/<id>`)
- Setzt die Weiterleitung auf die neue Operation fort, wenn ein Custom Deployment angestoßen wurde.

**Ticketübersicht** (`/tickets#dea-auto-sync`)
- Wird nur für den Sync-Fallback genutzt: klickt „Sync now“ und schließt den Tab.

### 8. Anpassungen der HubSpot-Oberfläche

- **Globale Suche:** Das Suchfeld „Find in HubSpot“ wird auf die **halbe Breite** (mindestens 160 px) verkleinert. Bis die Breite gesetzt ist, bleibt das Feld unsichtbar, damit es nicht springt.
- **Breeze-Assistent:** In der globalen Toolbar wird nur noch das **Icon** angezeigt; der Text ist als Tooltip/ARIA-Label weiterhin vorhanden.

### 9. Bedienung der Leiste

| Aktion | Wirkung |
|---|---|
| Ziehen am Text (Kundenname / Release / Agent) | Leiste verschieben |
| Mausrad über der Leiste | Zoom von 50 % bis 300 % (in 5-%-Schritten) |
| Linksklick auf Icons | Öffnet Ziel in neuem Tab |
| Rechtsklick auf DEA-Logo oder T | Dropdown-Menü |
| Klick auf graues T | Leiste neu laden (ohne den HubSpot-Tab neu zu laden) |
| Klick auf rotes Schloss | HubSpot-Sync starten |

Position und Zoom werden gespeichert und beim nächsten Ticket wiederhergestellt. Auf schmalen Fenstern (≤ 700 px) wird die Leiste horizontal scrollbar.

**Neuladen:** Beim Neuladen bleibt die aktuelle Leiste stehen und wird nur leicht abgedunkelt, bis die neuen Daten da sind. Mehrfachauslösungen innerhalb einer Sekunde werden ignoriert.

---

## Einstellungen

Die Einstellungen werden dauerhaft über den Userscript-Manager gespeichert und sind über das Menü des Script-Icons umschaltbar. **Nach dem Umschalten wird die Seite automatisch neu geladen.**

| Menüeintrag | Optionen | Standard |
|---|---|---|
| **Modus umschalten** | `dropdown` – Aktionen im Rechtsklick-Menü des T<br>`permanent` – TablePlus und Terminal dauerhaft sichtbar | `dropdown` |
| **Hintergrundfarbe umschalten** | grau (`#333333`) / blau (`#2d3e50`) | grau |

Für die Fehlersuche kann im Code die Konstante `DEBUG` auf `true` gesetzt werden. Dann schreibt das Script Debug- und Timing-Meldungen in die Browser-Konsole.

---

## Gespeicherte Daten

| Speicher | Schlüssel | Inhalt |
|---|---|---|
| Userscript-Manager | `dea_clone_action_mode` | Modus der Clone-Aktionen |
| Userscript-Manager | `dea_bar_background` | Hintergrundfarbe der Leiste |
| `localStorage` | `dea_hubspot_bar_position` | Position der Leiste |
| `localStorage` | `dea_hubspot_bar_zoom` | Zoomfaktor |
| `localStorage` | `dea_hubspot_bar_revisions` | Verlauf der zuletzt geladenen Tickets (max. 30 Einträge) |
| `localStorage` | `dea_customerbox_rt_data_lock_v1` | Tabübergreifende Warteschlange für Customerbox-Anfragen |
| `sessionStorage` | `rt_data/<ticket>_ttl` / `_response` | 20-Sekunden-Cache der Customerbox-Antwort |
| `sessionStorage` | `dea_custom_deployment_pending` / `dea_custom_deployment_baseline_ops` | Zwischenstand für die Weiterleitung nach Custom Deployment |

Sämtliche Speicherzugriffe sind fehlertolerant: Ist ein Speicher nicht verfügbar, arbeitet das Script mit Standardwerten weiter.

---

## Angesprochene Systeme

**Teambox Deployment Tool (DEA)** – `https://production.teambox-deployment-tool.service.de1.everii`

| Aufruf | Zweck |
|---|---|
| `GET /api/overlays/hubspot/ticket` | Teamboxen, Clones, Agent, Release, Besitz, Konfiguration für YouTrack |
| `GET /api/overlays/hubspot/youtrack` | Verknüpfte YouTrack-Issues |
| `POST /api/overlays/hubspot/clone` | Neuen Clone anlegen |
| `GET /teamboxes/<id>` | Status, Domain und Operationen einer Teambox |
| `GET /tickets` + `PUT /hubspot/sync` | HubSpot-Sync auslösen |

Alle API-Aufrufe senden den Header `X-Overlay-Ticket` mit der HubSpot-Ticket-ID (Timeout 90 s).

**Customerbox** – `https://customerbox.intevo/index.php/api/rt_data/<ticket>` für die Old-Stack-Ansicht.

Daraus werden Links zu Live-Teambox, Supportbox, Install/Create Clone, Featurebox und YouTrack abgeleitet.

---

## Technische Hinweise

- **Eine Datei, mehrere Module:** Das Script besteht aus der Hauptleiste, der Anpassung der HubSpot-Suche und der Breeze-Icon-Anpassung. Auf den Seiten des Deployment Tools wird nur die jeweils passende Automatisierung gestartet, nie die HubSpot-Leiste.
- **Gemeinsamer Heartbeat:** Ein Timer (500 ms) prüft URL-Wechsel und sichtbare Fehlermeldungen; zusätzlich beobachten `MutationObserver` Änderungen am DOM.
- **Robuste Helfer:** `pollUntil` (Warten auf Bedingungen mit Observer, Intervall und Timeout), `safeStorage` (fehlertoleranter Storage-Zugriff) und `findButtonByLabel` (Buttons anhand des Texts finden).
- **Icons ohne externe Abhängigkeiten:** Die meisten Icons sind als Data-URIs bzw. SVG eingebettet und damit unabhängig von der HubSpot-CSP. Nur das Lade-GIF der Customerbox wird von GitHub geladen.
- **Ereignisbehandlung:** Klicks werden in der Capture-Phase abgefangen, damit HubSpot-eigene Handler sie nicht verschlucken. Mehrfach-Events (`pointerdown` + `click`) werden entprellt.
- **Race-Conditions:** Jede Ticket-Ladung hat eine laufende Nummer; veraltete Antworten (z. B. nach Ticketwechsel) werden verworfen.
- **Versionsanzeige:** Die Version wird zur Laufzeit aus dem Script-Header gelesen und nicht doppelt gepflegt.

---

## Fehlersuche

| Problem | Mögliche Ursache / Lösung |
|---|---|
| Leiste erscheint nicht | Ticket-URL muss `/record/0-5/<id>` oder `/ticket/<id>` enthalten; Script im Manager aktiviert? Seite neu laden |
| „DEA-Tool nicht erreichbar“ | VPN/Netzwerk prüfen; DEA-Icon anklicken öffnet das Tool |
| „Sign in to the Teambox Deployment Tool first“ | Im Deployment Tool anmelden, danach ↻ bzw. Ticket neu laden |
| „Anmeldung in [C] erforderlich“ | Auf das Customerbox-Icon klicken und dort anmelden |
| „Abgelaufene Session“ | Customerbox-Icon klicken – die Session wird aufgefrischt |
| Rotes Schloss bleibt | Sync läuft evtl. schon oder ist nicht verfügbar – Tooltip beachten, später erneut klicken |
| TablePlus öffnet sich nicht | `tableplus://`-Handler im Betriebssystem registrieren; die API muss eine TablePlus-URL liefern |
| Popup wird blockiert | Pop-ups für `app-eu1.hubspot.com` im Browser erlauben |
| Tab schließt sich nach dem Löschen nicht | Browser erlaubt `window.close()` nur unter Bedingungen; das Script versucht es mehrfach |
| Leiste an falscher Position | Am Text ziehen; Position wird automatisch gespeichert |

---

## Hinweis

Das Script ist für den **internen Gebrauch** gedacht und setzt Zugriff auf die genannten internen Systeme voraus. Es greift ausschließlich lesend auf die Oberfläche von HubSpot zu und verändert nur die oben beschriebenen Darstellungselemente.
