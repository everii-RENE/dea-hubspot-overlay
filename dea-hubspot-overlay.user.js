// ==UserScript==
// @name         [DEA] HubSpot Overlay Customizer
// @version      6.2.2
// @updateURL    https://raw.githubusercontent.com/everii-RENE/dea-hubspot-overlay/master/dea-hubspot-overlay.user.js
// @downloadURL  https://raw.githubusercontent.com/everii-RENE/dea-hubspot-overlay/master/dea-hubspot-overlay.user.js
// @description  Stable release: compact DEA / clone / terminal / YouTrack / GitHub bar for HubSpot
// @author       RENE
// @match        https://app-eu1.hubspot.com/*
// @match        https://production.teambox-deployment-tool.service.de1.everii/teamboxes/*/delete
// @match        https://production.teambox-deployment-tool.service.de1.everii/teamboxes/*/custom_deployment
// @match        https://production.teambox-deployment-tool.service.de1.everii/teamboxes/*
// @match        https://production.teambox-deployment-tool.service.de1.everii/tickets*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      production.teambox-deployment-tool.service.de1.everii
// @connect      customerbox.intevo
// @run-at       document-idle
// ==/UserScript==

// OPTIONEN: Werden jetzt persistent über Violentmonkey gespeichert (GM_getValue/GM_setValue)
// und lassen sich ohne Code-Änderung über das Violentmonkey-Menü ("Modus umschalten" /
// "Hintergrundfarbe umschalten" am Skript-Icon) umschalten. Ein Seiten-Reload nach dem
// Umschalten übernimmt die neue Einstellung.

const SETTINGS_KEY_CLONE_ACTION_MODE = 'dea_clone_action_mode';
const SETTINGS_KEY_BAR_BACKGROUND = 'dea_bar_background';
const BAR_BACKGROUND_GRAU = '#333333';
const BAR_BACKGROUND_BLAU = '#2d3e50';

function readPersistentSetting(key, fallback) {
    try {
        if (typeof GM_getValue === 'function') {
            const value = GM_getValue(key, fallback);
            return value === undefined || value === null ? fallback : value;
        }
    } catch (error) {
        // Fällt auf den Default zurück, falls GM_getValue nicht verfügbar ist.
    }
    return fallback;
}

function writePersistentSetting(key, value) {
    try {
        if (typeof GM_setValue === 'function') GM_setValue(key, value);
    } catch (error) {
        // Einstellung kann nicht gespeichert werden; betrifft nur den Komfort-Schalter.
    }
}

// Variante auswählen: 'dropdown' (Rechtsklick auf [TBX]-Icon) oder 'permanent' (dauerhaft angezeigt)
const CLONE_ACTION_MODE = readPersistentSetting(SETTINGS_KEY_CLONE_ACTION_MODE, 'dropdown');

// Hintergrundfarbe auswählen
const BAR_BACKGROUND = readPersistentSetting(SETTINGS_KEY_BAR_BACKGROUND, BAR_BACKGROUND_GRAU);

if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand(`Modus umschalten (aktuell: ${CLONE_ACTION_MODE})`, () => {
        const next = CLONE_ACTION_MODE === 'dropdown' ? 'permanent' : 'dropdown';
        writePersistentSetting(SETTINGS_KEY_CLONE_ACTION_MODE, next);
        window.location.reload();
    });
    GM_registerMenuCommand(
        `Hintergrundfarbe umschalten (aktuell: ${BAR_BACKGROUND === BAR_BACKGROUND_GRAU ? 'grau' : 'blau'})`,
        () => {
            const next = BAR_BACKGROUND === BAR_BACKGROUND_GRAU ? BAR_BACKGROUND_BLAU : BAR_BACKGROUND_GRAU;
            writePersistentSetting(SETTINGS_KEY_BAR_BACKGROUND, next);
            window.location.reload();
        }
    );
}


(function () {
    'use strict';

    // Zentrales Debug-Logging: auf true setzen, um die bisherigen console.debug-
    // Meldungen wieder einzuschalten (z. B. während der Fehlersuche).
    const DEBUG = false;
    function log(...args) {
        if (DEBUG) console.debug(...args);
    }

    // Temporäres Timing-Log für die Performance-Analyse des Ticket-Ladevorgangs.
    // Nur aktiv, wenn DEBUG = true gesetzt ist (siehe oben). Zeigt in der
    // Konsole, wie viel Zeit zwischen "Ticket erkannt" und den einzelnen
    // Zwischenschritten (Lock, Netzwerk-Antwort, Rendering) vergeht.
    function markTiming(label, startTime) {
        if (!DEBUG) return;
        const elapsed = Math.round(performance.now() - startTime);
        log(`[Timing] ${label}: ${elapsed}ms`);
    }

    // Gemeinsamer, fehlertoleranter Zugriff auf localStorage/sessionStorage.
    // Ersetzt die bisher an vielen Stellen einzeln nachgebauten try/catch-Blöcke.
    const safeStorage = {
        get(storage, key) {
            try {
                return storage.getItem(key);
            } catch (error) {
                return null;
            }
        },
        set(storage, key, value) {
            try {
                storage.setItem(key, value);
                return true;
            } catch (error) {
                return false;
            }
        },
        remove(storage, key) {
            try {
                storage.removeItem(key);
                return true;
            } catch (error) {
                return false;
            }
        }
    };

    // Gemeinsamer "warte bis Bedingung erfüllt"-Helfer: ersetzt die zuvor
    // dreifach fast identisch kopierte Kombination aus MutationObserver +
    // optionalem Poll-Interval + Timeout (Delete-Teambox, Custom-Deployment-
    // Submit, Current-Operation-Redirect).
    function pollUntil(conditionFn, { intervalMs = null, timeoutMs = 15000, observeTarget } = {}) {
        return new Promise(resolve => {
            let finished = false;
            let observer = null;
            let interval = null;
            let timeout = null;

            const cleanup = () => {
                if (observer) observer.disconnect();
                if (interval !== null) window.clearInterval(interval);
                if (timeout !== null) window.clearTimeout(timeout);
            };

            const attempt = () => {
                if (finished) return;
                let result = false;
                try {
                    result = conditionFn();
                } catch (error) {
                    result = false;
                }
                if (result) {
                    finished = true;
                    cleanup();
                    resolve(result);
                }
            };

            attempt();
            if (finished) return;

            const target = observeTarget || document.documentElement;
            if (target) {
                observer = new MutationObserver(attempt);
                observer.observe(target, { childList: true, subtree: true, characterData: true });
            }
            if (intervalMs) {
                interval = window.setInterval(attempt, intervalMs);
            }
            timeout = window.setTimeout(() => {
                finished = true;
                cleanup();
                resolve(false);
            }, timeoutMs);
        });
    }

    const DELETE_TEAMBOX_PAGE_PATTERN = /^\/teamboxes\/[^/]+\/delete\/?$/i;

    function getDeleteTeamboxName() {
        const text = String(document.body && (document.body.innerText || document.body.textContent) || '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!text) return null;

        const patterns = [
            /deletion\s+of\s+Teambox\s*[“"]([^”"]+)[”"]/i,
            /deletion\s+of\s+Teambox\s*[‘']([^’']+)[’']/i,
            /Teambox\s*[“"]([^”"]+)[”"]/i,
            /Teambox\s*[‘']([^’']+)[’']/i
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match && match[1]) return match[1].trim();
        }
        return null;
    }

    function fillDeleteTeamboxName(value) {
        if (!value) return false;
        const input = document.querySelector(
            'input#form_name, input[name="form_name"], form input[type="text"]'
        );
        if (!input) return false;

        if (input.value !== value) input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return input.value === value;
    }

    function copyDeleteTeamboxName(value) {
        if (!value) return false;
        try {
            if (typeof GM_setClipboard === 'function') {
                GM_setClipboard(value, 'text');
                return true;
            }
        } catch (error) {
            log('Teambox name could not be copied with GM_setClipboard', error);
        }

        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(value).catch(error => {
                    log('Teambox name could not be copied with Clipboard API', error);
                });
                return true;
            }
        } catch (error) {
            log('Clipboard API unavailable', error);
        }
        return false;
    }

    // Sucht einen Submit-Button/Input anhand seines sichtbaren Textes (case-
    // insensitive, Whitespace normalisiert). Gemeinsam genutzt von der
    // "Delete all data"- und der "Submit"-Erkennung, die zuvor beide dieselbe
    // Kandidaten-/Label-Logik dupliziert hatten.
    function findButtonByLabel(label) {
        const normalizedLabel = label.trim().toLowerCase();
        const candidates = Array.from(document.querySelectorAll(
            'form button[type="submit"], form input[type="submit"], button[type="submit"], input[type="submit"]'
        ));
        return candidates.find(element => {
            const text = String(element.value || element.textContent || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
            return text === normalizedLabel;
        }) || null;
    }

    // Schließt den Tab zuverlässig. window.close() wird vom Browser nur unter
    // Bedingungen erlaubt (Tab per Script geöffnet bzw. nur 1 History-Eintrag) und
    // schlägt sonst stillschweigend fehl -> mehrfach mit Pausen versuchen.
    function closeTabReliably() {
        let attempts = 0;
        const tryClose = () => {
            attempts += 1;
            try { window.close(); } catch (error) { /* ignorieren */ }
            try { if (typeof unsafeWindow !== 'undefined') unsafeWindow.close(); } catch (error) { /* ignorieren */ }
            if (attempts < 10) window.setTimeout(tryClose, 300);
        };
        tryClose();
    }

    let deleteSubmitStarted = false;

    function clickDeleteAllDataButton(retryCount = 0) {
        const button = findButtonByLabel('delete all data');
        if (!button || button.disabled) return false;
        if (deleteSubmitStarted) return true;
        deleteSubmitStarted = true;

        const form = button.form || button.closest('form');
        const canFetch = form && typeof fetch === 'function' && typeof FormData === 'function';

        if (!canFetch) {
            // Fallback: normaler Submit, Tab nach der Navigation schließen.
            button.click();
            window.setTimeout(closeTabReliably, 1500);
            return true;
        }

        // Formular per fetch absenden statt per Navigation: Der Tab bleibt auf
        // einem einzigen History-Eintrag (dann darf der Browser ihn schließen),
        // und er wird erst geschlossen, wenn der Server geantwortet hat. Vorher
        // konnte das feste 500-ms-Timeout den Request abbrechen oder zu früh/spät
        // feuern.
        let data;
        try {
            data = new FormData(form);
            if (button.name) data.set(button.name, button.value || '');
        } catch (error) {
            data = null;
        }
        if (!data) {
            button.click();
            window.setTimeout(closeTabReliably, 1500);
            return true;
        }

        fetch(form.action || window.location.href, {
            method: (form.method || 'POST').toUpperCase(),
            body: data,
            credentials: 'same-origin',
            redirect: 'manual'
        }).then(response => {
            // Redirect (opaqueredirect, Status 0) oder 2xx = Löschung angestoßen.
            if (response.type === 'opaqueredirect' || response.ok) {
                closeTabReliably();
            } else if (retryCount < 3) {
                // Z. B. wenn gleichzeitig mehrere Löschvorgänge laufen und der
                // Server kurz ablehnt: nach kurzer Pause erneut versuchen.
                retryCount += 1;
                log(`Delete submit failed: HTTP ${response.status}; retry ${retryCount}`);
                window.setTimeout(() => {
                    deleteSubmitStarted = false;
                    clickDeleteAllDataButton(retryCount);
                }, 1500);
            } else {
                log(`Delete submit failed: HTTP ${response.status}; tab stays open`);
                document.title = `[Löschen fehlgeschlagen: HTTP ${response.status}] ${document.title}`;
                deleteSubmitStarted = false;
            }
        }).catch(error => {
            log('Delete fetch failed; falling back to native submit', error);
            button.click();
            window.setTimeout(closeTabReliably, 1500);
        });
        return true;
    }

    function initializeDeleteTeamboxClipboard() {
        let fieldFilled = false;
        let clipboardCopied = false;
        let deleteClicked = false;

        const tryCopy = () => {
            const name = getDeleteTeamboxName();
            if (!name) return false;
            if (!fieldFilled) fieldFilled = fillDeleteTeamboxName(name);
            if (!clipboardCopied) clipboardCopied = copyDeleteTeamboxName(name);
            if (!deleteClicked && fieldFilled) deleteClicked = clickDeleteAllDataButton();
            if (fieldFilled && clipboardCopied && deleteClicked) {
                log(`Teambox name copied, inserted, and deletion submitted: ${name}`);
                return true;
            }
            return false;
        };

        const start = () => {
            pollUntil(tryCopy, { timeoutMs: 15000 }).then(done => {
                // Kein Löschformular (z. B. Teambox schon gelöscht / zweiter Tab
                // für dieselbe Teambox): Tab nicht offen liegen lassen.
                if (!done && !deleteSubmitStarted && !findButtonByLabel('delete all data')) {
                    closeTabReliably();
                }
            });
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }
    }

    const CUSTOM_DEPLOYMENT_PAGE_PATTERN = /^\/teamboxes\/[^/]+\/custom_deployment\/?$/i;
    const TEAMBOX_DETAIL_PAGE_PATTERN = /^\/teamboxes\/[^/]+\/?$/i;
    const CUSTOM_DEPLOYMENT_PENDING_KEY = 'dea_custom_deployment_pending';

    function setCustomDeploymentPending() {
        if (!safeStorage.set(sessionStorage, CUSTOM_DEPLOYMENT_PENDING_KEY, 'true')) {
            log('Could not store custom deployment redirect state');
        }
    }

    function hasCustomDeploymentPending() {
        return safeStorage.get(sessionStorage, CUSTOM_DEPLOYMENT_PENDING_KEY) === 'true';
    }

    function clearCustomDeploymentPending() {
        if (!safeStorage.remove(sessionStorage, CUSTOM_DEPLOYMENT_PENDING_KEY)) {
            log('Could not clear custom deployment redirect state');
        }
    }

    // Operation-IDs, die schon VOR dem Custom-Deployment-Submit existierten (z. B. die
    // Operation eines vorherigen HubSpot-Syncs). Ohne diese Baseline würde der Redirect
    // direkt auf die alte Sync-Operation springen, weil die neue Operation beim ersten
    // Rendern der Teambox-Seite noch nicht gelistet ist.
    const CUSTOM_DEPLOYMENT_BASELINE_KEY = 'dea_custom_deployment_baseline_ops';
    const OPERATION_HREF_PATTERN = /(?:^|\/)operations\/(\d+)(?:\/|$|\?|#)/i;

    function collectOperationLinks(root) {
        const result = [];
        root.querySelectorAll('a[href]').forEach(candidate => {
            const href = String(candidate.getAttribute('href') || '').trim();
            const match = OPERATION_HREF_PATTERN.exec(href);
            if (!match) return;
            result.push({ id: Number(match[1]), href });
        });
        return result;
    }

    async function captureOperationBaseline() {
        safeStorage.remove(sessionStorage, CUSTOM_DEPLOYMENT_BASELINE_KEY);
        const teamboxPath = new URL(
            window.location.pathname.replace(/\/custom_deployment\/?$/i, ''),
            window.location.href
        ).href;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? window.setTimeout(() => controller.abort(), 5000) : null;
        try {
            const response = await fetch(teamboxPath, {
                credentials: 'same-origin',
                cache: 'no-store',
                signal: controller ? controller.signal : undefined
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
            const ids = Array.from(new Set(collectOperationLinks(doc).map(entry => entry.id)));
            safeStorage.set(sessionStorage, CUSTOM_DEPLOYMENT_BASELINE_KEY, JSON.stringify(ids));
            log(`Operation baseline captured before custom deployment: [${ids.join(', ')}]`);
            return true;
        } catch (error) {
            log('Could not capture operation baseline; falling back to newest operation', error);
            return false;
        } finally {
            if (timer !== null) window.clearTimeout(timer);
        }
    }

    function readOperationBaseline() {
        const raw = safeStorage.get(sessionStorage, CUSTOM_DEPLOYMENT_BASELINE_KEY);
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? new Set(parsed.map(Number)) : null;
        } catch (error) {
            return null;
        }
    }

    function clearOperationBaseline() {
        safeStorage.remove(sessionStorage, CUSTOM_DEPLOYMENT_BASELINE_KEY);
    }

    // Wählt aus den gefundenen Operation-Links die neueste Operation, die nicht zur
    // Baseline (= Zustand vor dem Submit) gehört.
    function pickNewOperationUrl(links) {
        const baseline = readOperationBaseline();
        const candidates = links.filter(entry => !baseline || !baseline.has(entry.id));
        if (!candidates.length) return null;

        const newest = candidates.reduce((best, entry) => (entry.id > best.id ? entry : best));
        try {
            return new URL(newest.href, window.location.href).href;
        } catch (error) {
            log('Could not resolve current operation URL', error);
            return null;
        }
    }

    // Nach dem Submit zeigt das Tool einen Toast: "Custom deployment of Teambox "…"
    // scheduled as Operation #N". Dieser Link ist eindeutig die Operation des Custom
    // Deployments (die Sync-Meldung hat einen anderen Text) und erscheint unabhängig
    // davon, auf welcher URL Turbo die Seite gerade anzeigt.
    function getCustomDeploymentToastUrl() {
        const baseline = readOperationBaseline();
        const links = Array.from(document.querySelectorAll(
            '#toasts-container a[href], .toast a[href], .alert a[href], [role="alert"] a[href]'
        ));
        const matches = [];
        links.forEach(link => {
            const href = String(link.getAttribute('href') || '').trim();
            const match = OPERATION_HREF_PATTERN.exec(href);
            if (!match) return;
            const id = Number(match[1]);
            if (baseline && baseline.has(id)) return;
            const container = link.closest('.alert, .toast, [role="alert"]') || link.parentElement;
            const text = String((container && container.textContent) || '').replace(/\s+/g, ' ');
            if (!/custom\s+deployment/i.test(text)) return;
            matches.push({ id, href });
        });
        if (!matches.length) return null;
        const newest = matches.reduce((best, entry) => (entry.id > best.id ? entry : best));
        try {
            return new URL(newest.href, window.location.href).href;
        } catch (error) {
            return null;
        }
    }

    function getCurrentOperationUrl() {
        return pickNewOperationUrl(collectOperationLinks(document));
    }

    function initializeCurrentOperationRedirect() {
        log(`Operation redirect init: pending=${hasCustomDeploymentPending()}, path=${window.location.pathname}`);
        if (!hasCustomDeploymentPending()) return;

        // Die neue Operation steht evtl. nicht im aktuell gerenderten DOM (z. B. weil sie
        // hinter einem noch laufenden Sync in der Warteschlange hängt und die Seite sich
        // nicht selbst aktualisiert). Deshalb wird die Teambox-Seite zusätzlich
        // regelmäßig frisch vom Server geholt und nach neuen Operation-Links durchsucht.
        let remoteOperationUrl = null;
        let remoteFetchRunning = false;
        let lastRemoteFetch = 0;

        const refreshFromServer = async () => {
            if (remoteFetchRunning || Date.now() - lastRemoteFetch < 2000) return;
            remoteFetchRunning = true;
            lastRemoteFetch = Date.now();
            try {
                const teamboxPath = new URL(
                    window.location.pathname.replace(/\/+$/, ''),
                    window.location.href
                ).href;
                const response = await fetch(teamboxPath, { credentials: 'same-origin', cache: 'no-store' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
                const url = pickNewOperationUrl(collectOperationLinks(doc));
                if (url) remoteOperationUrl = url;
                log(`Operation poll: new operation ${url || 'not found yet'}`);
            } catch (error) {
                log('Operation poll failed', error);
            } finally {
                remoteFetchRunning = false;
            }
        };

        const tryRedirect = () => {
            let operationUrl = getCustomDeploymentToastUrl();
            if (!operationUrl && TEAMBOX_DETAIL_PAGE_PATTERN.test(window.location.pathname)) {
                operationUrl = getCurrentOperationUrl() || remoteOperationUrl;
                if (!operationUrl) refreshFromServer();
            }
            if (!operationUrl) return false;

            clearCustomDeploymentPending();
            clearOperationBaseline();
            log(`Custom deployment completed; redirecting to ${operationUrl}`);
            window.location.assign(operationUrl);
            return true;
        };

        const start = () => {
            // intervalMs deckt Turbo/History-Style-Navigation ab, bei der sich
            // URL und Inhalt ohne erneuten Userscript-Start ändern.
            pollUntil(tryRedirect, { intervalMs: 250, timeoutMs: 120000 }).then(redirected => {
                if (!redirected) {
                    log('No new operation found for the custom deployment; staying on the teambox page');
                    clearCustomDeploymentPending();
                    clearOperationBaseline();
                }
            });
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }
    }

    function clickCustomDeploymentSubmit() {
        const submit = findButtonByLabel('submit');
        if (!submit || submit.disabled) return false;
        setCustomDeploymentPending();
        initializeCurrentOperationRedirect();
        submit.click();
        return true;
    }

    function initializeCustomDeploymentSubmit() {
        const start = async () => {
            // Wichtig: Baseline muss feststehen, bevor submit.click() ausgelöst wird.
            await captureOperationBaseline();
            pollUntil(clickCustomDeploymentSubmit, { timeoutMs: 15000 }).then(submitted => {
                if (submitted) log('Custom deployment submitted; waiting for the current operation link');
            });
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }
    }

    // Fallback-Tab für den "Sync now"-Klick des roten Schloss-Symbols: Die
    // Ticketübersicht wird mit diesem Hash geöffnet, klickt selbst auf "Sync now"
    // (Turbo sendet dann den PUT mit CSRF-Token) und schließt den Tab wieder.
    const TICKETS_PAGE_PATTERN = /^\/tickets\/?$/i;
    const AUTO_SYNC_HASH = '#dea-auto-sync';

    function initializeAutoSyncNow() {
        const findSyncLink = () => Array.from(document.querySelectorAll('a[href$="/hubspot/sync"]'))
            .find(link => !link.classList.contains('disabled') &&
                link.getAttribute('aria-disabled') !== 'true') || null;

        const start = () => {
            let closed = false;
            const closeTab = () => {
                if (closed) return;
                closed = true;
                window.setTimeout(() => window.close(), 500);
            };

            pollUntil(() => {
                const link = findSyncLink();
                if (!link) return false;
                document.addEventListener('turbo:submit-end', closeTab, { once: true });
                // Sicherheitsnetz, falls Turbo das Event nicht auslöst.
                window.setTimeout(closeTab, 6000);
                link.click();
                log('Sync now clicked in fallback tab');
                return true;
            }, { timeoutMs: 20000 }).then(clicked => {
                if (!clicked) log('Sync now button not found; tab stays open');
            });
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }
    }

    if (CUSTOM_DEPLOYMENT_PAGE_PATTERN.test(window.location.pathname)) {
        initializeCustomDeploymentSubmit();
        return;
    }

    if (TEAMBOX_DETAIL_PAGE_PATTERN.test(window.location.pathname)) {
        initializeCurrentOperationRedirect();
        return;
    }

    if (DELETE_TEAMBOX_PAGE_PATTERN.test(window.location.pathname)) {
        initializeDeleteTeamboxClipboard();
        return;
    }

    if (TICKETS_PAGE_PATTERN.test(window.location.pathname)) {
        // Auf der Tool-Domain nie die HubSpot-Leiste starten.
        if (window.location.hash === AUTO_SYNC_HASH) initializeAutoSyncNow();
        return;
    }


    const TOOL = 'https://production.teambox-deployment-tool.service.de1.everii';
    const DEA_SYNC_URL = `${TOOL}/hubspot/sync`;
    const DEA_TICKETS_URL = `${TOOL}/tickets`;
    const DEA_SYNC_REQUEST_URL = `${TOOL}/hubspot/sync?method=put`;
    // Sync-Symbol (zwei kreisförmige Pfeile). Wird beim Klick auf das Schloss als
    // echtes SVG-Element (kein CSS-Bild, daher unabhängig von der HubSpot-CSP)
    // drehend anstelle des Schlosses angezeigt.
    function createSyncSpinner() {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'dea-sync-spinner');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        const strokes = document.createElementNS(NS, 'g');
        strokes.setAttribute('fill', 'none');
        strokes.setAttribute('stroke', '#d8d8d8');
        strokes.setAttribute('stroke-width', '3');
        ['M5.66 9.04A7 7 0 0 1 19 12', 'M18.34 14.96A7 7 0 0 1 5 12'].forEach(d => {
            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', d);
            strokes.appendChild(path);
        });
        const heads = document.createElementNS(NS, 'g');
        heads.setAttribute('fill', '#d8d8d8');
        ['15.6,11.2 22.4,11.2 19,16.6', '8.4,12.8 1.6,12.8 5,7.4'].forEach(points => {
            const polygon = document.createElementNS(NS, 'polygon');
            polygon.setAttribute('points', points);
            heads.appendChild(polygon);
        });
        svg.append(strokes, heads);
        return svg;
    }
    const BAR_ID = 'dea_hubspot_info_bar';
    const STYLE_ID = 'dea_hubspot_bar_style';
    // Liest die Version primär aus GM_info (identisch mit dem @version-Header),
    // damit sie nicht mehr manuell an zwei Stellen im Skript gepflegt werden muss.
    const REVISION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '6.0.0';
    const MAX_REVISIONS = 30;
    const REVISION_KEY = 'dea_hubspot_bar_revisions';
    const DEA_DOMAIN_URL_CACHE = new Map();
    const POSITION_KEY = 'dea_hubspot_bar_position';
    const ZOOM_KEY = 'dea_hubspot_bar_zoom';
    const DEA_ICON = 'data:image/webp;base64,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';
    const CLONE_RUNNING_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAs0lEQVR42u2UoQ7CMBCGv+u2QhZwCOxeAsEz7AH2vhAEdnZqCoFDLawtZoO2YkEQEOxy5r/rffnbXCrkfCQUzKBvgdJIn86BFEEUgLM4F7T2u0nQau1j6O90HcBiSZqBe9vR8fDy4no2W4oCoGm4XpA09uVFHqYaMwMoK+qWuqWsAMi8A+Fg7EiNi54kmBtaD1JrlCLJMWaoWDt5tWdbBOs9sHNYi9h4ft7sX4Bk/tj+GfQADCotIOGCbFMAAAAASUVORK5CYII=';
    const CLONE_NOT_RUNNING_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAA1UlEQVR42u2UMQrCQBBF/+xuIIg2Qq5h5THsPIe1Z7D2Huk8hVXqgAcI2JhGcJlvoSZhFVk02JgpFv4sPP7MflYwQi9lgAH0K5AL9Hq1FpFWPwQBkE2b5Ga7eQdK07QLUlXvPYDEOuMMGO2oPJQ3kECoHE/G2TQDUB2r+lQ3myBDpISB9J3tnTGbz5aLJYB8lxf7Aimgrz2EjiS5z2WM0Ys65wACYq0VKyYxqvrSVAhqrvmou2ob/PD52VeOpDm+DyQjbLkIjsgHyX4upcasSoaP7Z9BVwooUQUMOP9TAAAAAElFTkSuQmCC';
    // Lade-Icon: graues T, das sich von unten nach oben mit dem Grün des
    // laufenden T füllt und danach wieder von unten beginnt.
    const CLONE_LOADING_ICON = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24">' +
        '<defs><clipPath id="fill"><rect x="0" width="24" y="24" height="0">' +
        '<animate attributeName="y" values="24;0;0" keyTimes="0;0.85;1" dur="3s" repeatCount="indefinite"/>' +
        '<animate attributeName="height" values="0;24;24" keyTimes="0;0.85;1" dur="3s" repeatCount="indefinite"/>' +
        '</rect></clipPath></defs>' +
        '<image width="24" height="24" href="' + CLONE_NOT_RUNNING_ICON + '" xlink:href="' + CLONE_NOT_RUNNING_ICON + '"/>' +
        '<image width="24" height="24" clip-path="url(#fill)" href="' + CLONE_RUNNING_ICON + '" xlink:href="' + CLONE_RUNNING_ICON + '"/>' +
        '</svg>'
    );
    // Lösch-Icon: graues T, das sich langsam von unten nach oben rot füllt
    // (Rot per Farbmatrix aus dem Grün des T), danach beginnt es von vorn.
    const CLONE_DELETING_ICON = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24">' +
        '<defs><filter id="red" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0.6 0.6 0 0 0  0.1 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter>' +
        '<clipPath id="fill"><rect x="0" width="24" y="24" height="0">' +
        '<animate attributeName="y" values="24;0;0" keyTimes="0;0.85;1" dur="3s" repeatCount="indefinite"/>' +
        '<animate attributeName="height" values="0;24;24" keyTimes="0;0.85;1" dur="3s" repeatCount="indefinite"/>' +
        '</rect></clipPath></defs>' +
        '<image width="24" height="24" href="' + CLONE_NOT_RUNNING_ICON + '" xlink:href="' + CLONE_NOT_RUNNING_ICON + '"/>' +
        '<g clip-path="url(#fill)"><image width="24" height="24" filter="url(#red)" href="' + CLONE_RUNNING_ICON + '" xlink:href="' + CLONE_RUNNING_ICON + '"/></g>' +
        '</svg>'
    );
    const CLONE_PROGRESS_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAD1klEQVR42tVVX2hbVRj/vnPubRJiL1lLRSIiWNxcY1VUtOimFxUE++DwTVQwLclNCza+9MWXey8+FSysrCY5SSFvjjUy8UUQprZTmHtZt7FIEVlHt6XdWhKbYNOmzfl8uZG7LAl1+OJ5PN93vu87vz/nAPzfF+8UJCIMhUJ8YGCALywskG3bQEQIAEzXdVxcXHzwzvPz8/wgeaZpsk5x7BScmprq7uvrewMR36rValnDMC5lMpn3AKC7Xq+vIOIVwzC2OtVQmiGxLAuDwWA3AHzMOf9EUZT+3t5eWF1d/REALkkp+3w+3zeVSuURRVFOpNPp64FA4GI+n9+3bVs2N7jvek7SYa/Xe1LTtP6dnZ2N9fX1HOc87+C/sr29PYyIXFGU76SUb29tbR1yzmE7iJCIIJfLqfl8HmzbrgkhTnR1dR2v1WpfGIax5j40Ozv7EOf8WcbYECKeiUajt5LJ5KNjY2O3nZrUktBUKnUqk8mcy2QyPc1xZ/qGiu5Zc3NzTwshPhdCvNJMPJqmyWzblolE4oiiKFcDgUBXsVj8aG1t7auenh51YmKihojUTj3BYJAT0aeIeBIRP6hWq2fj8Xj5Hw50XWcAAJzzDzVN48Vi8bLH4/nasiyKx+Mti7u4AsMw9hDxAmPsKBH97PV6n3EPwHRdrzsQva9pGgeAXDgc3rEsi9+HZZsm5XJ5CQBe8Pv9+4h49B4VISKVSiUGAKc2Nzc/Y4yddoiSBzEaEeHk5ORfAPA753yIiFYAACzLov/yycGOgWw2693d3X3H6/WyWq32azQavU1E0A7/5hsgIiWTyZc0TXusUqlsxGKx8439hpy8iNhHRNfq9frrAECWZeGBRkeE6elpHwAM1uv1KwDwlAMRAgAw0zRZOBz+ExFL4XB4GRH3s9lsoJXt20iV/H7/c4yxpXK5vAcAy+2eilUhxMuMsaW9vb1hIkIhhNrKWI3ioVAIhRAqABwrFAqXVVXVPR7PVbfC0J1cKpXCAOBXVfXsyMjITTcSDU4axnQ3E0I8T0TvAsAPsVjsvDsHXWRTIpE4pKpqVyQSuZNIJI4rihJCxHORSOQPd8GZmRmPx+MZBIBjnPPTkUjkjhCiv1AorNi2TW7/tLx+KpV6DQAGpZQ5zvkQADwMAD9Fo9Hr6XRaR8QnpJS/IeINIopJKb8cHx+/26oWa8bVNE0mpVwGgE1FUV6tVqsXEfEaY+yII9vDRPStlLJIRG8S0S8+n6/sEI4dPxwXtncB4EwymXzS5/O9yBh7HAAuOLEiY2yYc34LEb8fHR3deCBntlPPv/2T/wbd+8Un6gkbJwAAAABJRU5ErkJggg==';
    const CUSTOMERBOX_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAASeElEQVR42rVba7AcxXX+TvfM7O59S0IyEq/ojZF4GFBFQGREKCkYEJTDj6QwJE6cVCWpcpVCpXg44F+AwaFiiIuy/8Q4xBBI5SFACAiGUGXMG8kB8ZCRAEtISLzulXQfOzvd5+RH9+zOzM7eO5JhtrZmZmd2pk/36XO+853TBEBwhBsRIAI0hoA7tqPZPwy0mu6aiHsi+72w+50FAPuX2c717L0Q/38GGP7+7D3++WIBFQBTh4HbLka9Od5p05FuQZlwVTqgvReAfUMJGSGk06C0E1LhpYfwyN7HJc8pnEN8G8h3QBWJZYYOqNKL6T02KTQuHaHMyLfPM8JLr5H390lBeEH5OVvAmryG/HYaQEBjcGZ1InIvr/X7weJM47PC8wzCZ+7rKXz6f//ctnb4/9b6IUQgUp1nTLfFk3ktIACSm9NbETdmQ0xc0vPZkbIAFBDWC9ezI88VR54rjDx3d4SwE6h4LX0/p8feZjQPg37856jFk6nkBQ0gBTRmQ/qHgaTZmTOMggCpYWPAtroNnmuQMxTE3QJT4ZjRuU7IqHN6XQCBdDQl820MdHceF/cGCEJAuN2s8ikgDJjYCd9qul7qqZaSUSUvPEFBhABhMEtnFIr/KYy4SI+R585UVCAoKDAEAm7fn/gBENt7GjG7r2lV8AKSnRzU+YEKBjQ9d6OoAVg0LSOxkBBASDVSqAFKAyJdAkIA0YUpUOwMIrBYGBujmcTSshaaQHUFKGhYsTntTTsB5DRHCqJUcoNdhqfHyLMAJAoQxpSxUADmR6toYf3SYG50lhoJl1BNzyJNUU/LJIWGCfz0yJyztDBlRuXTqZ3y0eRr/NYnj/Cew89zYq00NIhEAZY7HZhxoTkt6GEgg7JWpWqU9evFBypoxNZCBLKkviE4fWijPq6xRimE+Ly3vnAezWksp2WzL1HnHX8t3h/7BT+/7y6zff8mK8xUDzWMsV3C5wYv4zmqaYCUnLf3GpPGytxwhVoz8oPoxMY6lf6fYUBtpSPQbyG4ZI7EN0BRgIUja9XCkbXRO8c+yZt/fU2y9+B27g81WbYdgywltke6gZAqBTlS8Ovth5ETPrFySv/V+op5z0QnNtYpAUPgJqBCAIIGQeU64mi+nY+CIg1FgW+jhYCxdPY69VdnPROtOu5P9FjTijMqlHedUpgSqNABWZ+eH3mFKWOxeviGcP2ce6O6PobciCsQ9DSm5vPdiFwHsxg0wjn0Ryv/JbpoyXfC8aYHJ9PYsUo2oAzbk2hMJFZWD18fnjNya+BGnKBKHlEKuo/oat7bFI/ao0eBd4mCry27JYAAj759azIUaWKxOYTZCypPrwEZ4SeNlRUDV+lzRr4XCKwfdVUimIDFHoF6T/9J72exkJJuc9NDgcXia8tvCc498Rv6cGxFie5gCu4d53QbQc7bAIhCbC2OCZer82fdFQm4p2cVsU49SQMAWnwYkvHVZd5mpk2RRqQHofwzWWz7ONsNBIKA8fWVP4x2j74S7z+4Q2qBgrXcEZ6rusFCyClCsnbk7qimZsONvi75G4NIYzzZK9tH77G7xh+3Y82dYjju6U16+e0sjFWoYaS2hJbOvkifveDP9FDtOBJhH/1k7YLTgkY4C1esvDv8p2fXxZb9LK5sA7IWk13vN42VJX2X6uMbF6pphYfCW2M/s0/vvy4ZjfeJduCsEzsUYKpko8AUqGTvs502fTZxQN755JfJc7t/ZC5ddnt4xvyrdPrOorawWCydd6E6Y8El+tUPNtv+UJOIdXC4ROu6JnGeqWFoKHxl4Nqgl8KKOHvw4sc3m//afXUyYfZhQAcUKQXFBCWEKCJENUIt9MeRO65HnfN6RGjUCLUaoR66vQaBmFDTCv1hQOPNfbjn1auTp3bdbFzcYXua2LVLrg0CpcCWcx5h5imQxvce6S2IVqn5jXOVm2m6VO3fGrvf/vzDm0xDO3CfWAMI0BhxAcjEZx3P0qbIbCfSBOc7X7yZ6R8GSAMTY+7HQCn0h4RN228ycxqL6IwFV+ridFCkIRAsnHOuOmnkbLXr45ekprV7oVREgqnqJRaysLEhIOgu45Oq4HiyT57evzGJFIFEYC1DKSCIgFcegnrhPxDsfRPKtKaBCZKPDQQufJ2/DHzmBpgVF4BbU4A1DEUKdU3479c3Jotmr1VD9QVdNkGEoUhjxfwN+q19LyV1BToiHODoJkYAYG54lurJixHw+ug/29HWxzKgAjLWgLQLAH92PcJXNpUYjIpbDGDnS1A7X0J0+nrYDdcjUQLYhBHpAJ9Ofiwv/uYndt3yGwPpDvMBACcMn6kCBTC7QSmLBXrYAIIVQUQRDYeLyFnZfNxGpCFgvDu+xWohsj7kDSLgPi88aUAHR4/4dOCmwP/9D/TDtyIMAieEFYEmojcOPGoF7DVTck4RAOYOLKJGGJGxAmE6Mg0QARTVUdezeiIxYycwFr8nCgJrGP2zIC8/BP3qw9A68IyRdRpR63PnVCAWpAfn6FTevVZp4LWfQy85B/bUdbATo0wagtHJ96RlJlALBvOhtR+svmg2NNURS6sn6CgnRDzjCtJQFBF6TF+GIyvgBTMt4Nn73DPZ84CLV8FecSNM3zDEmAzclh4cnqe6Jw6CNt+B4P1t0ORp762PIjjlfNi0D42JwWx7a5CKiKC7o8LppgC4w/l1/MfMNLkKgPHPQJ/tBdX63Yj3DQNX3AQzfxkkqDvGuTEA1Abcvj7gfqv54/qg+wYRcOxiyCV/C6ODTmd+9C7UxBhIBQ4nCByD0vMjAvHUXBYSz+wFpHf4WBo7kFPXIAQ2PoA4BTaKHGt86FNv3bOgp8jhIQ/CJg8C9UFIUAPiCZ+HaHU6w2kqQSPMxA15G6B1CAE5wflIKTEu1Q/MxB/UB/PssUnyz20Lj95wOBeK92ifwyuCSTMmAiYLCxJqB2SKNJrJIRGWHC9QzQhy9SxRej/73ELS6ghjrdOCIMgYVgGgO4kRztqctJMMUB8CRg+ATNxJ1OjQk58iUABicxC3PrEyhqg28dohWQnCjFZyCFq5zmI5gikAdqpdaQpkcoApry/ikJxNgPFR1xkocnRlVLjnNEb3gx67E4E1zh2yBeYtBDeGIM1xD2wgmIoP5mj21MCmz9aUT7BM2wHFTNCMbG5JBofZjVIYAdu2QL28CcG+t6HSqVA1+9ya9MaYOgKdfhGMUq4z0lRYQJQqgLuXnJZ1stKClJ6ojgM4g9NnYHVy+N4LrzTw799FuHXz0SNBwHmWNB2+4gLY5WvA4wc7eUA3hcozRllNm44T7GkEWSryVunI+x4OI+DBGxFu2+KQoPIe4mg29v9b+fuwF21EksSZNvEMucus8Fmi54hoca5uA6wF+kYg2zZDb9sCrbRHguI0ImpUL2AQcS71S4vBp66HOXkNOGm6dxDyQhGo08w0t5hGmGlOcRqvEvQa0aqUVdu6ez/94n8iSJEbBFh4Juxl18LUB1343jMXWCBNoIC+AR8OH+oIVxz5lpWc4ebMnqTTjl7EaFAWDMkMRrDYAWyd6o9/Btq/Eyr9TYfA5dfCzFsCmRzrxLqlZTTZc//ceBIwpmPwst5GfNDWiIaQWkHOpu5BYGHE8SGwCLRUnAJlDZwRB/hDazsZWBEgrAG1QSe8TaaZs9ydhEnfH0R59+nsCcGyoB4M47uXvl6rR0PEYtsIUESglEazdUhufPDUeKI5Bk3ks0sVcQAfQblMNpAp8yjdJGuhmALd6XbrPUpr0hnD9FIQ+nnOXgNqI1QLBnq4U0UAwVpAgoqkaI4/k1ybSiPC1E1Bu+tB6MgMIocKJw+Bjp3rtIBUgfxU3XlIiDOcfUPAR++B7r8WNTa+GGIQcuXtiKOGf2cgsJy0g5+2BvhjwwnYSh7gzUSI5JEaVXODcML2zYJ8aQmYfAxvE2DzHQg+fAfUagKTh4HmuPtOjXeO4wm/PwxMHXLFGR+9B3rybgTNw65gI2kCQ/Mg9SGITTr2qkpiRbIGslKVGKdYwIKl1WvwoUhDo9ZGgEoBZ18O8+4riFJk9v426B99E7rLDU6HMskJzNYdp8UPp/2BR4JeIwJVK0mSdNTV2ljYk6G9WOHS1FjqLqxtYjIZ7Wpx2huh6sdwtJCMJZBSGB8FrbgAfNp62BSuKo/j05FufyfLv61Jd509kwRfkXbyGthlq8FTh0BKKxhDmN2/iKKgH+jiBF1bx5tjSEyzk++swgm60RdoEKaSlozGuyS1rNlUFIsFkcLSORfrxIqQLyhqTQGXXYfktPWugoXN0UNhtq7RX/4q7Lq/cUjQCUFoGZFTT7hYu4wQ55Q0beuBsV0y0WxJoKhndjToHeMrtKzF/vGtvHTWxQol2TgAWDX/W/q53T804/EnCEjBGgYp4PLrkSxZDfurLQj2vwNlk5JCo14zwSPBuYvAp1wAs2w12LScTVFKoRlbHDM4l7667Fsa05RhvP/xVo4ToC9UENhSgmtaRigg0I7PHrHnHX9DoEpycSKMwfoCunTZneE9r34j6Q9dptYmjGYCnHYh+Mtr0Jo8WGRyMjxCoYQurSsEOXKFFNA87FN1SoENYTJm/OUFd4bD/fPL84TK5Qm37XrEhhpk2RVkVQJCbH1ZmVjUFGHPoVd4z6Hn+KTh31Np9jffCRZnzL9SX3byu7LpzZtMXQORp4THRwVEQNgoR3JSFL5Q2dGaAsQApAlKKzRjg4kYuPK8m4PfXXKlLssUu98Udux9jnfue4UbERGzbdcbVs4MsQW0ctPg2T3fNycNr4l6VWsIGBcuuTGY3fgd2vTGdcmnE/skII9gBZDmNHWGRURYUnFqmoKWYTlm8Dj6i7W3hauXXqVZuNwD+Am65dXvm6ZhDIQ+q1U1GkSGPbVi0dCKth941O5a8BQvnn2hKut1l6hkfOW4q/TiOReoF3f/1L554HH76cQ7Yk3cVeLKMwifNpQF0FTDnL6ldOqJFwVrln1Tj/S79HhxSmZrB97Y/RQ/t+NR21dTZI1FWtJQhgRztcL1fuDvHkKzMeC5PbhawKmEMbdvOf31qudq9WDEc/e9G9BOb5nDvlrEFy5SIQFYsR6oHg72fEc2HwgAU/FB3Phv58QffLJD6oGCZZcdVsq52YduQT1p9qgVziYtmH2IC0Yj0Pjw0A5+6K1vt/741PsihnWkXMH6ppnZNDlZCwY/t8Io9mn4crWXdgD0k6e/3Xpv/w4eamgy1ub4zZ5VYlJSHyCesRUGEmPRCDW9sOd++9ivbzCuEIHbvV50j2mu7vP6wNPcRFQ68i75qfHAs98xT/7qPpsVvlh8UT0c9lUaHcLCYiDU9MSO2wyz4JKTb3MpMDHt+r1ypPDFbcwGSgUgAh549u/Ng7/8nhluuILJsnSYVGKFuZAbQDaQYPSFGo/tuD0Zm9rHX1/xj2FfdAyJ/5OzC198rWAa+ysVYKL5qfz0f69Jnth2rx1paGLhLjcr00Dh8gqRtDyOUFi742LfoUjTC7/5V7t7dKv84cofhMvnZUplxbSrtiotQKoUbfqpIAKlgrYdeO39J/neZ65Jdn24nWf15dW+q0S2aolMdu1Or8JjFjcdDhx8Q+5+dn182vwN+vzFG4PFc9coRZ9zsTRlphO5mqS3P/gFP77tLvP8jk0WABXnfBFUsQCKu0mXciTI+SVuXQgNaZGCRaQVRJi27n3EvrbvET5heBWtnH+pPmHWmWruwFLqr80iraIjWphXXJNgbAvjzVHZP7ZT9nzyGr+662F+Z+8LHBtIXw1EUJhO+Bz0rgqEei1VExRXd7lJ1R84w/PeJy/L2/tfTkIFNIIaKVVzhVWZFDU4XxxVXESVR4wEZgtjYoy3YoljINSgegiE/p3MPKPw0+U5uqeAD2GZ8yntXguiyBslEaAeKjQCImaG4Rhs4hwTk2Vmsm6JOT9fbfb53oc3NFFfn4KIwAiD3VqFXG1zlkztSpBUrQ/QgQtFOZvoLOPw/HIXm2SmhgcPArQriVllcnVp7s66Z6WNVSqvCSpFjQywdnvrDXBOczySUZTPTSopeC+4d5SA125SdOowiBnSprdRUjafcZc6ysyzXBpKZly5kVtX2NPgdrvkXP1Bq2CvuITa9wxz0sytyOnEAtmzWl816yQMhHXIn/4Qca3hskLtgKPCshWRksqQGYTPJlBIAckksPkfUEuapaFJV7sFblXctBqQlqNUQ2I+MVfQii9i5LNaiEzaPGmCypbDVd2Ccr9bwTf7wihItSytFJfXTnP/dMK364/SijKdiWoEFfi2KsnRqg47G8tzeZFFl9oXlrJUFh7lREoO2BzFAur/Bxf47vd3pwiOAAAAAElFTkSuQmCC';
    const CUSTOMERBOX_LOADING_ICON = 'https://raw.githubusercontent.com/everii-RENE/dea-hubspot-overlay/refs/heads/master/img/loading-indicator.gif';
    const CUSTOMERBOX_TEAMBOXES_URL = 'https://customerbox.intevo/index.php/teamboxes/index/';
    const CUSTOMERBOX_API = 'https://customerbox.intevo/index.php/api/';
    const CUSTOMERBOX_LOADING_URL = 'https://customerbox.intevo/';
    // Several tabs may wait in the cross-tab request queue. The timeout is
    // only a safety net and must not expire while a request is still pending.
    const CUSTOMERBOX_LOADING_TIMEOUT_MS = 120000;
    const BAR_HOVER_BACKGROUND = BAR_BACKGROUND === '#2d3e50' ? '#536477' : '#3d3d3d';

    const ICONS = {
        openClone: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANUlEQVR42mNk4GL4z0ABYGKgEAy8ASzInBNnidNkYUxFFzDiiwWYi5BtHIaxMPAGMI7mBQYA4PYHOxE7cMkAAAAASUVORK5CYII=',
        upgrade: 'data:image/png;base64,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',
        tableplus: 'data:image/png;base64,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',
        createClone: 'data:image/png;base64,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',
        terminal: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAEDklEQVR4nO3dS07kMBAG4HI5PISQ2HDHvgOINXAEXw5YIx5iwwIl9ixG7gHmEZqUXZWp/1uNRpq0Rf1tF4njCURUCNxi7QGALgTAOQTAOQTAOQTAOQTAOQTAOQTAOQTAOQTAOQTAOQTAOQTAOQTAOQTAOQTAOQTAOd7b29MeAyji4+Nj7TGAIs45a48BFKEHcA4BcA4BcA4BcI5DCNpjAEVdZwBmJmZMOpZ0qUadZXLOlHNGCAzhUtq+Gvh+iUkpUUqJcs40DEPTz4WvadoDhBAohEClFEopbf8+pUTjOCIEBjSbAWrxc84fil8hBDY0WYznil8hBPrEl4CvFr9CCHSJLgG7Fr9CCPSILQHfLX6FEOgQCUDt9L9b/Aoh6G9xAOo3/+joaFHxK4SgL5EmsJRCBwcHAsP5CSHoZ3ETWP/98/MznZ2dSYyJiBCCXkR6gFIKMTM9Pj7S+fm5xCWJCCHoQew+QH3I8/DwgBCsiOidQIRgfcSfBeScKcaIEKxEk2cB0zQhBCvRbGcGQrAOTbfmTNOEnsC45ptC0Rja1nxLGBFCYFm33ZkIgU1dt+ciBPZ035+NENiiskEfIbBD7Q0NhMAG1Vd0WocA7z3OU39H630ILi4uxK6bUqIQAl5Dm2Hip5Nzpv39fbq/vxe97uHhIZVSMBP8g4kAxBjp7e1NZE9hdX19Ta+vr0T0a9cS/E79fIAYI03TJFr8q6srurm5IWZG8WeozgCtin97e0sxRsIJaPPUAjAMg3jxLy8vt8Wfpknsuv+zLg+DPhuGgcZxFP/m393dofg76t4DtCo+vvnf03UGQPHt6dYDoPg2dVkCUHy7mi8BKL5tTZcAFN++ZgFA8dehSQBQ/PUQbwJR/HURbQJR/PUR2zfFzOaKH2MUG8tS9QAtaw+oBoklgJkXHxD1mcQ3HzPGvMUzQE326empxHiISG7alwyklM1msz1VzQKRM4KYmZ6enkQGtLT4dUbT3ujyL5b2KYqMJOdMpRTabDaLroOGrz+xKJZSaBiGb4cAxdchOhfVFzJ2DQGKr0f8RtCuIUDxdTV5GvjVEKD4+pq1o3MhQPFtaPr7yN9CgOLb0fwX0nEcKcb4IQQ9im/lRsufWBpbODk5KS8vL80/qN4u/vxn0NXtJfp6gmj9jyV6YObtbVfNO4P18+sNM0u6nqLQe73HLDPPzk1pUIEAOIcAOKd+PgDowgzgHALgnMr5AGAHegDnMAM4hx7AOSwBzmEJcA5LgHMIgHMIgHNoAp1DE+gclgDnsAQ4hxnAOfQAzmEGcA4BcC4wc8H+eb8CEaEJcAxLgHMIgHMIgHMIgHMIgHMIgHMIgHMIgHMIgHMIgHMIgHMIgHMIgHMIgHMIgHMIgHMIgHM/ALle6t6MG6GqAAAAAElFTkSuQmCC',
        delete: 'data:image/svg+xml;charset=UTF-8,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23999999" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"%3E%3Cpath d="M4 7h16"/%3E%3Cpath d="M9 7V4h6v3"/%3E%3Cpath d="M6 7l1 13h10l1-13"/%3E%3Cpath d="M10 11v5M14 11v5"/%3E%3C/svg%3E',
        youtrack: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAJUklEQVR42uWbXWgc1xXHf/fOjD52tbtyVhJNTVODTSkNhLQPpSmFQMmDoG1eSpLWz3lJ7KDEIspDCWJDIjvQh4YY+a0PtaOHikKIKTHEDaT5aOLSFuyWusU2bWKUktpejWZHm52Ze08f9sO7kiJpV7srJb2woJ2duXPO/57zPx/3Cv7Ph/qsHwRRyC4K0PUXqe1pI4iSWdFftJWeFdGIqG0vwH+ffjWz6oSu70Mu1wOJfPBzcOKuH+DneqS1D+TAKeeS1x5VwaYWKDV0Lj2+MJpOcVI5+vuxSQZERHXbTAXQAqE7wPGv3c+q6+GI9MjjlCh3ILLWvGlX1dHfPpZbbnYJt37b4sOL+uHFh80/j52eH8+O/eQ/yzdwUKC676UCOAguClEuRnlV5+uV/ScJmfy+w6G9qVHqpw/9WpxFMA0LEEQplPz96VczKvb/bW+G2UpQBkVPuEAAVyy+N8SRe37EijeEK7ZnAAjKZlMD3Jm2K3fCV3/56HiAiEIpcZtvTH9pyLv1xw9RYeSIqt7RM1YSAS0YUSSi6GnQEdE3QqtMbPj6XUNe808tACz/6ZrYcoTnaIyYvsRAxe1PL4enIahYzl9txdltZU0fXG9L8+2GC0hjrtZvvc4s/DXf3Xand1ComridrpoFXFSNZF1EuQjd4QDVpuW67a5cKNGOBa2TYCgKFa3gSISzYxIUUArrptpaGnfbAqMoScTPg99TkqgawnbOzuz7w5uMdsHslRiMl+Hj+05gBjIoSbYFREcWEEiEVwOg2RXqf8sm3rnWdXRU3iDWqq1ll2ZGUjWF2+eSjjig7r8WcLQmSap+57kOxtrPlF3W3O+6DsbqFpG11hiTYMzW8ziOh7W2AamottVpH4BmzlZKUQpDcrViwfd90ul0Taj1Q2tNKQzJZrMopfB9n1QqhYjUslPF6mrIyMgI2eHhTeUol8sEQdD0fGeRxO3U6+rKPPDAAzzxxBMAnDx5knPnzpHL5TCmlY0dx8H3fSYnJzl69CgAL7/8MufPnyedTgMQ1uY7cuQI6XQapRRqTS4mIogIYRgyPz/PG2+8QTo9Qqdpi9sZ5UBiDNlslunpae64445qyTk7y0cffcTly5cZGRlpgOA4DqVSibvvvpvZ2Vk8r5prTE9Pc+HCBaIoAiCbzXLs2DHy+fyWMuRyOZ566ik++OADKlFUDamdLORO+ddai7WWOI7xPI9CoUA6nSaO48YKxnFMKpWiUCjgeR5xHDeeW9+32HjF65/N7u0bAAJ4rkuxWGR+fh6tdY28DAcOHGBmZoYwDBvXwzDkmWee4cCBAxhjGtdPnTrFrVu3cF234SJzc3Ncv36d5eVlgiBoKFpXNggClpeXuX79OnNzc/i+j+u6HdeSHXOAqbnAK6+8wr333suDDz6IMQZjDJOTk1y8eJHFxUUAHnnkESYnJ1tc4uzZs5w5c4b9+/c3rqfTaV5//XXeeecdBgYGyOVyLCwskMlkACiVShw+fBjf94miiCAImJiYwBrbXwtojsD5fJ7nnnuOq1ev4jhOwy2mpqY4ePAgBw8eZGpqqmHujuNw7do1CoVCgzuaRz6fJ0kSisUiKysrLWYvIqysrFAsFkmShHw+fzuCQH8tQNUUTaVShGHIzMwMCwsLeJ6HiDA4OMjzzz8PwODgIMYYlFJUKhVmZmaI45jR0VGSJGlR0HEcMpkMw8PDjXDZ7PPZbBZrLa7rNp7pOwe0NlsSxsfHuXTpEidOnEBr3RDs0KFDHDp0qCGk1poXX3yRixcvMj4+3qJ8MwjbL/Nld0hwIz7Yv38/Z86c4ezZsziOs469635/+vTpFr/f7dEVAEQEpRRjY2MUCgWuXLmC1rqhvNaaK1euUCgUGBsbQynVldXbMwDUiS+dThNFEc8++yxRFDXCV/O1zVLlzzUAdVcYHR1laWmJcrncAKBcLrO0tMTo6OieMf2eAFB3h0wms469M5nMnjH7TcPgRnVVu7XW2iJmo6JmzwLgieBiEbG17t/tjpC7B1dw3QJWO+wbJi4b7Xi66zqm7iCu1sRi1gFQWtO82IvDS8DRoNaYsBKwBiJvAwBUrU/1+Pcew8ZFtB5ATNy0LSaIctHxCvve+x1u9Gmt+yLbSlJ24vvbnceqqvL3/cPgKINgWpp1WmmstQw5Pqeacud1FmC9oSoA2lkHgCOVbTUw6z7f3OnphAM6mcdLwFXrl0YrMBZwtuIAKyhV5YBmBAWLs42VrJe/9TwAIIqiRnncTsepk3nqHCDb5Aa9WRTY6LOVubquSxAEzM3NsbS0xNLSEsePHycIgmrdvg0QuzVPT6vBzZKhdDrNuXPnePfddxtNjImJibaSoG7N0/dEqLmuj+OYOI5b6vbdmqdvFrC2rq+TVyeCd2ueXbGAfofBPQfA52V0xQW6lefvRrG0YwDq7fCd1vhaaxzH6XuvwN3pyodh2Ghi7mSs3+vb4wBUM7VSy15eO5ne2m5S615f/7pGHQKgSEzS1l7eVqN5ry+KokZPcc93hLrZ6NiNpklHFiAIrus19vKefPLJdW2wdtk/CAJeeuklfN9nZGRkr7sAWGMbe3lvv/12g7zaBaH+zOrqKqVSqbrX18dI4Hbi/wqFoBCE/NgYYSmkWFzuaINOSe3Ii+OQz4/d7l+1KVOnxy3d9gVOageSark6iuzIcEfnBoXbNXq9+WYl6YiUhQQh6TUACuNlqy9UzpoOQWf+75nmXL/TWaoAOCrTthzuts1eDNYb5uPvHq9KusPTvaJgIIHvXDZ4pgblDoOAQqHV8Jp+YE8soAt5vwKrwdEG135GK7ujCGV6zwHdq5mrAnfzqHSPXIAd+3r/5ttBJmg/ZW/uX3VxRHFrotJiAeXUx3HGjArUWKTXuXjLed8evkYQNFYpRCphvB4ApQQRdVOpIPWzv703+OVv/DBZ+QSletgwUtUkSGuNVt0jwY0J16rhoQluFv/63q9euycQEaXW/tcYWgvM6hu/mXph7Me/0M7I+LdtUvF6JZookASSxKJNz94CKHG0F98sXrrw1vvTL8Cs1krbjRiofpr9LmDf0Fe+lRUv7UFCj5rHAIyFSY8dwKVSCeMby39eAYrAh026bkB699/v8v5fDlBZGe6Lg/ZnqMHBbLlS+ea/4K1kezHooYccPvmk91HhrX7oPyGwaNqkqC/c2FCn/wGdCdwQg8mgtgAAAABJRU5ErkJggg==',
        github: 'data:image/png;base64,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',
        reload: '↻',
        customerTeambox: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAEkElEQVR42u2bTYgcRRTHf9U7s4miSUxccUNCDoGQIB48CYp6EBU8KXiJh0DIISE5xEPIITl7FUFvfoAHvagHwS/UgwdFMFFCDiaQEEI+IGtIou4m2Z2d7vaw77HFMN3TPVNVXcNOQVHL9EzV63+99/7vvaqFldYCLgE5kMo4Dj2T8RawSd7FUKO1Cj5XIGJuUy4mKQLAlDyLqeU+ADDADeBHIHGxiONmRDufB3a4mtT2ATnw/Rjs/ieWvM59QFueJeJoYrP9FFjn0wfkQDdSAGymGrklrPG25gGoS3WmQbWPAoB8LWtAIlRjBIiQ2vCPr8i0VfHFM2AWOA2sbwCAZ4G/fPisuhqwGZge17h/VABMQy9fxFZ2NpiFAGAJ+EUisNAmcLcgWlVgHvIJgKI7BzzXsNPOLHO4BZwDbkvUmvvWgFjiAGWDt4DFPrLlPgGIIQ4wovqdHt9gpGd1fMI4FD36ZYJphe9lVTZsnABI5MVbwEvAy8ATQs0d4BrwG/A1cKEHsNoFkZ8K6CcJ1Omj2gBvAGcpL5TeBz4CttaJIaoC0JS9G+B9S74usCxjKqN+pt+5DrwwCIRWTYe5NQATGOCK2LCq/cfAfqtIMzXAUXdF1u+AF8U0Sos7ZRqgWrAN+Feo576MLvtdGb+VNduy7hGRaYl6ZwYaG1wTP5GUbV4VALYD9wTF1KIbV13V93Vr7ccF9JThDmx0zneKTCGp6YUf6LFLl70FzLNajs+AA8AGyxyGoc1c5pkREE1dH6Bceg/4RhIi17mA0tsfwIIIboDXRlxLzxA2CHV+JnN3Y2YBXXMG+K8n68uHNIMMeLffpreGFC5Em7GyPOOAWbb1C+frApAF1IDEkZmZss2LuSx+R+h21CRMf/t3P22KEYCM1QPayw6z0DMukqFQgCXiqX8A9oxAg7l4/WWZq9CMY8sFNGDZY8X5wzCBBkKfFwVCdTSgDezynAsYEfq8CHsOeE+qPx3qFWVVaxaBE6yeZ4wUCi/h/85PCrxigb4e+FWedypqQtcKnfdVSYurArAgO9SR0XVfEuHPA1usiHAz8HOPand7cgk7LVYwD1etCVQBYAdhb4Ads7RAx7clXxj021NVagF1c4EF4FNPuYC9zjzwgdCW1vbaMp5k5WrMXimJ7QQelt2fA/4EvgC+Ei1dJ88G1ghjrQhVadNUPzobiQXA4xldTwywLH/vFuZ50Nq9xEqXl63AacoyF/sKTQ7cZOVgd76oMhSLBuh6s8CXosaufMpV4GCZJjQNgBZatgj/qyfvOuh2Nel4PxBiAEAF+lBkWHTMKqlFnU/q+yUDdiREtys3s8CbIuS0B/NS9jqkn5XdEwx5YVrL309J3THzFHIrCE+rsyy7KboR/xcljcQX2h61bD/xuOYmMbm+AGTAM8DFAHn/FPAq8LvjKlAVTTC9cYDtJFqyGz6b2mO7ySjKBuARwp4Wm4DB1UAAconzHyPc/R9dZ25Qrh4CgBQ42vBGdJs2gaZUMYvFB8T+T1Jek4812yYATACYADABYALABIB4mgm9TmwAdAKto9Vk/gfCq2hYx7a0EwAAAABJRU5ErkJggg==',
        featurebox: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAEnUlEQVR42u2aTYwUVRDHf93TI7Ic+DIhJLiYKBgTEg+GhJuJAiIXhQS9eFgjB8PNeEI5eECvGgMm3kz0QCBssoknIwQ4oQfCgQQCXvAzRuMXDiLb081hqrLFy+z0zvTreb1Dv+Sle3peV7/6V716/6pu8N8SOc4AOTAvx1G63jvjyPY+2cVaBMRDyOsyntYaYmwmII4EQD5GpQgBdDLA8jmwEXhKzqMBIEXAbeDimADYAUwtcV5XgV+MTkMBc3CI9XrTcc8qYoDKvjmEjIODjF20BOZlDaUDxmYSJzp9rqfSR22pkWVbR65lA2KUznneRxCMC4Jhv/9XivzEwxJdOeB5ccGcojIAjNLUWt8A7xVYaSmyYpHVzxMq3wZHaRp8Lkv31YYKYqEAiM1kIwlaeZEbLgHMrglqtQUg6+OiKdW0rE4AqHU3A2fGxAM2O8+uBQBTwHNjZoRR3WJAHXOBsQLQYpm1mAe8NQA0ADQAVN6yKjh8nXOBfskMfZIin1tmKzQAuSjYchRsAVeAf6WKY+sKrUnxgNwkPmplVfQGsAv4BzgHbDdjLtIro42a5el9UwJuJcDMMLispVnaz8BxOb8rx+vAtJnsWuAsC5WiaU9znTbzyRiypJ54WN9/AS8D3wI/Ae+L5XcC38szMuBP4HfD31cDKzx4wOoql8ZiHqCR/Vdgm4xty/EQ8KS5pstj1vGaDZ7muiGUB+Ry/3rzOwY+MUEulWsngX1OEDxiPKKMBzwSwgMs2neBF8x9Lelq+dNObBhXX5IHlCFCkYDQBuYEhNTZDU4C+2Uy7T7VIl+dULuAXdN3gD1m7Yey/NhigPWiTCL6HHAAeNVYPqFcYXRZUOFYlHxIQNBtMjGKuyD4rPBGoQFwS9a5mVhHlsFaJx+IJskDIhMUY7Ml3gH2An8A54F1xhP+9pQlxmXIUOLB8urul4FnTMT/XxjiBRmzFzhBr6SdAbuFMcYjAqH3bWHh1Zm3WDMMD8iBNxy2d9twg7YESIBjRt7WkktB79tahgmWocJd4JZ5gL6N/UIsr8qrrHedbXOTp+W3KRQV1nX8pQEgBV4zVDiXa4eBo04QfB74wQMVfjQUEVJLfmdS28R4gso4bGRkk0SFYwHhceBrASE1AKjlPzAUOepTK/TRgxVFNePb4oBQpLyNGT560KpwYkA4IyC8XaD8xFFhrfo8AVySGkFuCp8TnwvY9Hj9Ivt17vz2+a4gDg1AbrYlVbQr8t+Sys/nzth4UjzAfie4ioUXHomQn4/k9yrgY/PM1z3ygM9CUGHLBY4LJb1h/nvHyHpYzj808mrBBMsSoRT41JnMNXrfB6ocLYW9CPxm9u5a5AJJCbeP6NX93zS8/0fJCDssfKU5L5nfrHiCuukaqRGUzQbXhIgB+vDHpPb3itnzOybIqfJzorzNBb7yWA8oXRkqGwNmub8UrvfvBv5zxk5MLoCx8j7glJGXDrC8W0bz0YNS4bYB4bRYemeB8raM5qMHZ4JtUfwleq/Bny5QfiKpsL4Reta4eO2/QYorkNetc/JTpQdYT1g2rflMrgGgAaABoAGgAeABbvcAvzOEl9zFAoAAAAAASUVORK5CYII=',
        supportbox: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANklEQVR42mNkWPX/PwMFgImBQjDwBrAgc/6HEqeJcTWtXIBsMrKL0MWHWSwMsnSAL76HcRgAABF5CCaTH5ImAAAAAElFTkSuQmCC'
    };

    const state = {
        ticketId: null,
        data: null,
        youtrackIssues: new Map(),
        customerboxData: null,
        customerboxSessionError: null,
        customerboxLoading: false,
        customerboxLoadingTimeout: null,
        renderMode: null,
        lockedDeaUrls: new Map(),
        loading: false,
        ticketOwnerAccess: null,
        requestNumber: 0,
        lastPath: location.pathname + location.search,
        linkNavigationReady: false
    };

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* The old [C] bar is intentionally kept as a separate visual language. */
            #${BAR_ID},
            #${BAR_ID} * {
                box-sizing: border-box;
            }

            #${BAR_ID} {
                position: fixed !important;
                top: 12px;
                left: 12px;
                right: auto;
                bottom: auto;
                z-index: 2147483647 !important;
                display: flex !important;
                align-items: center !important;
                gap: 8px !important;
                min-height: 34px !important;
                height: 34px !important;
                width: max-content !important;
                max-width: calc(100vw - 24px) !important;
                padding: 0 12px !important;
                overflow: visible !important;
                color: #cbd6e2 !important;
                background: ${BAR_BACKGROUND} !important;
                border: 0 !important;
                border-radius: 6px !important;
                box-shadow: none !important;
                font: 13px/1.2 Arial, Helvetica, sans-serif !important;
                user-select: none !important;
                transform-origin: top left !important;
                cursor: default !important;
            }

            #${BAR_ID}.is-loading {
                opacity: 0.88 !important;
            }

            #${BAR_ID},
            #${BAR_ID} * {
                cursor: default !important;
            }

            #${BAR_ID} .dea-brand,
            #${BAR_ID} .dea-context,
            #${BAR_ID} .dea-links,
            #${BAR_ID} .dea-cluster {
                display: inline-flex !important;
                align-items: center !important;
                flex: 0 0 auto !important;
                gap: 12px !important;
            }

            #${BAR_ID} .dea-brand {
                gap: 5px !important;
                margin-right: -6px !important;
                color: #ffd100 !important;
                font-weight: 700 !important;
                text-decoration: none !important;
                pointer-events: auto !important;
            }

            #${BAR_ID} a.dea-brand,
            #${BAR_ID} a.dea-brand img {
                cursor: pointer !important;
            }

            #${BAR_ID} .dea-brand img {
                width: 22px !important;
                height: 22px !important;
                object-fit: contain !important;
                display: block !important;
                pointer-events: none !important;
            }

            /* Oldstack uses the same effective brand-to-context spacing as DEA.
               Keep this purely presentational so it cannot affect loading. */
            #${BAR_ID} .dea-brand.dea-customerbox-link {
                margin-right: -6px !important;
            }

            #${BAR_ID}.is-loading .dea-brand {
                /* Same effective spacing as DEA and loaded Oldstack brand:
                   12px flex gap plus -6px right margin = 6px. */
                margin-right: -6px !important;
            }

            #${BAR_ID} .dea-login-link {
                display: inline-flex !important;
                align-items: center !important;
                gap: 5px !important;
                min-height: 24px !important;
                color: #cbd6e2 !important;
                font: 12px/1.2 Arial, Helvetica, sans-serif !important;
                text-decoration: none !important;
                pointer-events: auto !important;
                cursor: pointer !important;
            }

            #${BAR_ID} .dea-session-expired {
                color: #ff6b6b !important;
                font-style: normal !important;
            }

            #${BAR_ID} .dea-login-link,
            #${BAR_ID} .dea-login-link *,
            #${BAR_ID} .dea-login-link:hover,
            #${BAR_ID} .dea-login-link:hover *,
            #${BAR_ID} .dea-login-link:focus-visible,
            #${BAR_ID} .dea-login-link:focus-visible * {
                cursor: pointer !important;
            }

            #${BAR_ID} .dea-login-link:hover,
            #${BAR_ID} .dea-login-link:hover *,
            #${BAR_ID} .dea-login-link:focus-visible,
            #${BAR_ID} .dea-login-link:focus-visible * {
                color: #ffd100 !important;
                text-decoration: none !important;
                font-style: italic !important;
            }

            #${BAR_ID} .dea-login-link img {
                width: 22px !important;
                height: 22px !important;
                object-fit: contain !important;
                display: block !important;
                pointer-events: none !important;
            }

            #${BAR_ID} .dea-context {
                display: inline-flex !important;
                flex-direction: column !important;
                align-items: flex-start !important;
                justify-content: center !important;
                gap: 0 !important;
                min-height: 28px !important;
                color: #cbd6e2 !important;
                font-size: 12px !important;
                font-weight: 400 !important;
                white-space: nowrap !important;
            }

            #${BAR_ID} .dea-context-row {
                display: inline-flex !important;
                align-items: center !important;
                min-height: 14px !important;
                gap: 5px !important;
                white-space: nowrap !important;
            }

            #${BAR_ID} .dea-context-row-bottom {
                gap: 4px !important;
            }

            #${BAR_ID} .dea-context strong,
            #${BAR_ID} .dea-context .support-agent {
                cursor: move !important;
            }

            #${BAR_ID} .dea-links,
            #${BAR_ID} .dea-links *,
            #${BAR_ID} .dea-brand,
            #${BAR_ID} .dea-brand *,
            #${BAR_ID} .dea-separator {
                cursor: default !important;
            }

            #${BAR_ID} .dea-links,
            #${BAR_ID} .dea-links * {
                cursor: default !important;
            }

            #${BAR_ID} .dea-context strong {
                color: #ffffff !important;
                font-size: 12px !important;
                font-weight: 400 !important;
            }

            #${BAR_ID} .dea-owner-status {
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                width: 13px !important;
                height: 13px !important;
                min-width: 13px !important;
                margin-left: -2px !important;
                font-family: Arial, Helvetica, sans-serif !important;
                font-size: 12px !important;
                line-height: 13px !important;
                font-weight: 700 !important;
                cursor: default !important;
                user-select: none !important;
            }

            #${BAR_ID} .dea-owner-status.is-owner {
                color: #32d583 !important;
            }

            #${BAR_ID} .dea-owner-status.is-not-owner {
                position: relative !important;
                display: inline-block !important;
                width: 12px !important;
                height: 14px !important;
                min-width: 12px !important;
                margin-left: 0 !important;
                color: #c96a6a !important;
                font-size: 0 !important;
                line-height: 14px !important;
                border: 0 !important;
                border-radius: 0 !important;
                cursor: pointer !important;
            }

            /* Small, monochrome padlock; deliberately subtler than an emoji. */
            #${BAR_ID} .dea-owner-status.is-not-owner::before {
                content: '' !important;
                position: absolute !important;
                left: 2px !important;
                top: 5px !important;
                width: 8px !important;
                height: 8px !important;
                background: currentColor !important;
                border-radius: 1.5px !important;
            }

            #${BAR_ID} .dea-owner-status.is-not-owner::after {
                content: '' !important;
                position: absolute !important;
                left: 4px !important;
                top: 1px !important;
                width: 4px !important;
                height: 7px !important;
                border: 1.5px solid currentColor !important;
                border-bottom: 0 !important;
                border-radius: 4px 4px 0 0 !important;
                box-sizing: border-box !important;
            }

            #${BAR_ID} .dea-owner-status.is-not-owner:hover,
            #${BAR_ID} .dea-owner-status.is-not-owner:focus-visible {
                color: #ffffff !important;
                background: ${BAR_HOVER_BACKGROUND} !important;
                outline: none !important;
            }

            /* Neuladen: Leiste bleibt stehen und wird nur leicht abgedunkelt. */
            #${BAR_ID}.dea-reloading {
                opacity: 0.6 !important;
                cursor: progress !important;
            }

            /* Sync läuft: Schloss wird durch ein drehendes Pfeil-Symbol ersetzt. */
            #${BAR_ID} .dea-owner-status .dea-sync-spinner {
                display: none !important;
            }

            #${BAR_ID} .dea-owner-status.is-syncing,
            #${BAR_ID} .dea-owner-status.is-syncing:hover,
            #${BAR_ID} .dea-owner-status.is-syncing:focus-visible {
                cursor: progress !important;
                background: transparent !important;
            }

            #${BAR_ID} .dea-owner-status.is-syncing::before,
            #${BAR_ID} .dea-owner-status.is-syncing::after {
                content: none !important;
                display: none !important;
            }

            #${BAR_ID} .dea-owner-status.is-syncing .dea-sync-spinner {
                display: block !important;
                position: absolute !important;
                left: 0 !important;
                top: 1px !important;
                width: 13px !important;
                height: 13px !important;
                animation: dea-sync-spin 0.9s linear infinite !important;
            }

            @keyframes dea-sync-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }

            #${BAR_ID} .dea-context .support-agent {
                color: #cbd6e2 !important;
                font-size: 12px !important;
                font-weight: 400 !important;
            }

            /* 2.4.4 DEA reference: Customerbox loading must match this exactly. */
            #${BAR_ID} .dea-context,
            #${BAR_ID} .dea-context strong,
            #${BAR_ID} .dea-context .support-agent {
                font-family: Arial, Helvetica, sans-serif !important;
                font-size: 12px !important;
                line-height: 1.2 !important;
                font-weight: 400 !important;
                letter-spacing: normal !important;
                text-rendering: auto !important;
            }

            #${BAR_ID} .dea-context strong {
                color: #ffffff !important;
            }

            #${BAR_ID} .dea-context .support-agent {
                color: #cbd6e2 !important;
            }

            #${BAR_ID} .dea-context .support-agent.kam-fallback {
                color: #ff6b6b !important;
            }

            #${BAR_ID} .dea-separator {
                width: 1px !important;
                height: 20px !important;
                margin: 0 2px !important;
                background: ${BAR_HOVER_BACKGROUND} !important;
            }

            #${BAR_ID} .dea-links {
                gap: 4px !important;
                list-style: none !important;
                margin: 0 !important;
                padding: 0 !important;
            }

            #${BAR_ID} .dea-link,
            #${BAR_ID} .dea-customerbox-link {
                pointer-events: auto !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                width: 24px !important;
                height: 24px !important;
                margin: 0 !important;
                padding: 2px !important;
                color: #cbd6e2 !important;
                background: transparent !important;
                border: 0 !important;
                border-radius: 2px !important;
                text-decoration: none !important;
                cursor: pointer !important;
            }

            #${BAR_ID} .dea-link:hover,
            #${BAR_ID} .dea-customerbox-link:hover,
            #${BAR_ID} .dea-link:focus-visible,
            #${BAR_ID} .dea-customerbox-link:focus-visible {
                background: ${BAR_HOVER_BACKGROUND} !important;
                outline: none !important;
            }

            #${BAR_ID} .dea-link img {
                pointer-events: none !important;
                display: block !important;
                width: 20px !important;
                height: 20px !important;
                object-fit: contain !important;
                border: 0 !important;
            }

            /* Roman index for the green Open-Clone state icon. */
            #${BAR_ID} .dea-clone-state-indexed {
                position: relative !important;
                overflow: visible !important;
            }

            #${BAR_ID} .dea-clone-spinner-badge {
                position: absolute !important;
                right: -4px !important;
                bottom: -4px !important;
                z-index: 3 !important;
                width: 13px !important;
                height: 13px !important;
                background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><rect x='1.5' y='0.5' width='9' height='1.6' rx='0.4' fill='%23bdbdbd'/><rect x='1.5' y='9.9' width='9' height='1.6' rx='0.4' fill='%23bdbdbd'/><path d='M2.6 2.1h6.8c0 2.2-1.6 3-2.6 3.9 1 0.9 2.6 1.7 2.6 3.9H2.6c0-2.2 1.6-3 2.6-3.9C4.2 5.1 2.6 4.3 2.6 2.1z' fill='%23dcdcdc' stroke='%23808080' stroke-width='0.7'/><path d='M3.9 2.9h4.2c-0.3 1.1-1.2 1.6-2.1 2.4c-0.9-0.8-1.8-1.3-2.1-2.4z' fill='%23666666'/><path d='M4.2 9.3c0.4-1.2 1-1.6 1.8-2.2c0.8 0.6 1.4 1 1.8 2.2z' fill='%23999999'/></svg>") center / contain no-repeat !important;
                transform-origin: 50% 50% !important;
                animation: dea-clone-hourglass 1.6s ease-in-out infinite !important;
                pointer-events: none !important;
            }
            @keyframes dea-clone-hourglass {
                0% { transform: rotate(0deg); }
                50% { transform: rotate(180deg); }
                100% { transform: rotate(360deg); }
            }

            #${BAR_ID} .dea-clone-index-badge {
                position: absolute !important;
                right: -2px !important;
                bottom: -3px !important;
                z-index: 2 !important;
                min-width: 9px !important;
                height: 11px !important;
                padding: 0 1px !important;
                color: #999999 !important;
                background: ${BAR_BACKGROUND} !important;
                border-radius: 1px !important;
                font: 700 9px/11px Arial, Helvetica, sans-serif !important;
                letter-spacing: -0.2px !important;
                text-align: center !important;
                pointer-events: none !important;
            }

            /* YouTrack and GitHub are intentionally one pixel larger in both
               DEA and Customerbox/Oldstack views. */
            #${BAR_ID} a[data-service-icon="youtrack"],
            #${BAR_ID} a[data-service-icon="github"],
            #${BAR_ID} a[data-service-icon="youtrack"] img,
            #${BAR_ID} a[data-service-icon="github"] img {
                border-radius: 0 !important;
            }

            #${BAR_ID} a[data-service-icon="youtrack"] img,
            #${BAR_ID} a[data-service-icon="github"] img {
                width: 22px !important;
                height: 22px !important;
            }

            #${BAR_ID} .dea-link.is-disabled {
                opacity: 0.35 !important;
                cursor: default !important;
            }

            #${BAR_ID} .dea-clone-state-image {
                display: block !important;
                width: 20px !important;
                height: 20px !important;
                object-fit: contain !important;
                pointer-events: none !important;
                border: 0 !important;
            }

            #${BAR_ID} .dea-clone-state-disabled,
            #${BAR_ID} .dea-clone-state-disabled img,
            #${BAR_ID} .dea-clone-state-wrap[role="button"] {
                pointer-events: auto !important;
                cursor: pointer !important;
            }

            #${BAR_ID} .dea-clone-state-disabled {
                opacity: 1 !important;
            }

            #${BAR_ID} .dea-clone-state-wrap {
                position: relative !important;
                display: inline-flex !important;
                align-items: center !important;
                flex: 0 0 auto !important;
            }

            #${BAR_ID} .dea-clone-state-dropdown {
                display: none !important;
                position: absolute !important;
                top: calc(100% + 3px) !important;
                left: 0 !important;
                z-index: 2147483647 !important;
                flex-direction: column !important;
                align-items: center !important;
                gap: 4px !important;
                min-width: 28px !important;
                padding: 4px !important;
                background: ${BAR_BACKGROUND} !important;
                border: 1px solid ${BAR_HOVER_BACKGROUND} !important;
                border-radius: 2px !important;
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35) !important;
            }

            #${BAR_ID} .dea-clone-state-wrap.is-open .dea-clone-state-dropdown {
                display: flex !important;
            }

            #${BAR_ID} .dea-clone-state-dropdown .dea-link {
                margin: 0 !important;
                width: 24px !important;
                height: 24px !important;
            }

            #${BAR_ID} .dea-clone-state-dropdown .dea-link img {
                width: 20px !important;
                height: 20px !important;
            }

            #${BAR_ID} .dea-clone-state-dropdown {
                background: #000000 !important;
            }


            /* One shared tile hover for DEA and legacy icons. */
            #${BAR_ID} .dea-links a:hover,
            #${BAR_ID} .dea-customerbox-link:hover,
            #${BAR_ID} .dea-brand:hover {
                background: ${BAR_HOVER_BACKGROUND} !important;
                outline: 0 !important;
                outline-offset: 0 !important;
                border-radius: 1px !important;
                opacity: 1 !important;
                box-shadow: none !important;
                transform: none !important;
            }

            #${BAR_ID} .dea-links a,
            #${BAR_ID} .dea-brand {
                transition: none !important;
            }

            #${BAR_ID} .dea-context strong,
            #${BAR_ID} .dea-context .support-agent {
                cursor: move !important;
            }

            #${BAR_ID} .dea-error {
                color: #ff8f8f !important;
                white-space: nowrap !important;
                display: inline-flex !important;
                align-items: center !important;
                gap: 7px !important;
            }

            #${BAR_ID} .dea-error-icon {
                width: 22px !important;
                height: 22px !important;
                min-width: 22px !important;
                min-height: 22px !important;
                object-fit: contain !important;
                display: block !important;
                flex: 0 0 22px !important;
                transform: none !important;
                transform-origin: center center !important;
            }

            #${BAR_ID} .dea-error-icon-button {
                pointer-events: auto !important;
                position: relative !important;
                z-index: 2147483647 !important;
                width: 22px !important;
                height: 22px !important;
                min-width: 22px !important;
                min-height: 22px !important;
                padding: 0 !important;
                margin: 0 !important;
                border: 0 !important;
                background: transparent !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                cursor: pointer !important;
            }

            #${BAR_ID} .dea-error-icon-button:focus-visible {
                outline: 2px solid #ffffff !important;
                outline-offset: 2px !important;
                border-radius: 2px !important;
            }

            #${BAR_ID} .dea-error-icon-button,
            #${BAR_ID} .dea-error-icon-button *,
            #${BAR_ID} .dea-error-icon-button:hover,
            #${BAR_ID} .dea-error-icon-button:focus-visible {
                cursor: pointer !important;
            }

            #${BAR_ID} .dea-reload-button {
                margin-left: -4px !important;
                transform: translateY(-1px) !important;
            }

            @media (max-width: 700px) {
                #${BAR_ID} {
                    max-width: calc(100vw - 12px) !important;
                    left: 6px !important;
                    top: 6px !important;
                    overflow-x: auto !important;
                }
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }


    function getTicketId() {
        const path = window.location.pathname;
        const record = path.match(/\/record\/0-5\/(\d+)/);
        if (record) return record[1];
        const ticket = path.match(/\/ticket\/(\d+)/);
        return ticket ? ticket[1] : null;
    }

    function readJson(text) {
        try {
            return JSON.parse(text);
        } catch (error) {
            const parseError = new Error('Ungültige Antwort vom DEA-Tool');
            parseError.responseText = String(text || '');
            throw parseError;
        }
    }

    function isCustomerboxSessionExpiredResponse(value) {
        const text = String(value || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return /Anmeldung\s+in\s+\[C\]\s+erforderlich/i.test(text);
    }

    function isCustomerboxSessionExpiredError(error) {
        return Boolean(error && error.customerboxSessionExpired) ||
            isCustomerboxSessionExpiredResponse(error && error.responseText) ||
            isCustomerboxSessionExpiredResponse(error && error.message);
    }

    function apiRequest(method, endpoint, ticketId, payload, requestOptions = {}) {
        return new Promise((resolve, reject) => {
            const options = {
                method,
                url: requestOptions.url || `${TOOL}/api/overlays/${endpoint}`,
                timeout: requestOptions.timeout || 90000,
                headers: {
                    'Content-Type': 'application/json',
                    ...(requestOptions.headers || {}),
                    ...(ticketId ? { 'X-Overlay-Ticket': ticketId } : {})
                },
                onload(response) {
                    // WORKAROUND-SYNC-LOGIK START
                    // Prüfe den Roh-Response vor dem JSON-Parsing. Der DEA-Endpunkt
                    // kann die Sync-Meldung auch als HTML/Text zurückgeben.
                    if (isHubSpotSyncWorkaroundError(response.responseText)) {
                        const syncError = new Error('This ticket has not been synced from HubSpot yet!');
                        syncError.responseText = response.responseText;
                        syncError.status = response.status;
                        reject(syncError);
                        return;
                    }
                    // WORKAROUND-SYNC-LOGIK END

                    let body;
                    try {
                        body = readJson(response.responseText);
                    } catch (error) {
                        reject(error);
                        return;
                    }
                    if (body.status !== 'success') {
                        const apiMessage = body.message || body.error || body.detail || body.description ||
                            (body.errors && JSON.stringify(body.errors)) ||
                            `DEA-Abfrage fehlgeschlagen (${response.status})`;
                        const apiError = new Error(
                            typeof apiMessage === 'string' ? apiMessage : JSON.stringify(apiMessage)
                        );
                        apiError.body = body;
                        apiError.responseText = response.responseText;
                        apiError.status = response.status;
                        reject(apiError);
                        return;
                    }
                    resolve(body);
                },
                onerror() {
                    reject(new Error(`DEA-Tool nicht erreichbar: ${TOOL}`));
                },
                ontimeout() {
                    reject(new Error('DEA-Tool hat nicht rechtzeitig geantwortet'));
                },
                onabort() {
                    reject(new Error('DEA-Abfrage wurde abgebrochen'));
                }
            };

            if (method === 'POST') {
                options.data = JSON.stringify(payload || {});
            }
            GM_xmlhttpRequest(options);
        });
    }

    // Customerbox uses one shared browser session. Serialize rt_data
    // requests across HubSpot tabs so ten simultaneously opened tabs do not
    // authenticate against the same session at the exact same time.
    // Match the legacy Customerbox overlay: successful rt_data responses are
    // reusable in this tab for 20 seconds and can be rendered immediately.
    const CUSTOMERBOX_CACHE_TTL_SECONDS = 20;
    const CUSTOMERBOX_SESSION_RETRY_DELAYS_MS = [400, 1000, 2200, 4500, 8000];
    const CUSTOMERBOX_REQUEST_LOCK_NAME = 'dea-customerbox-rt-data-session';
    const CUSTOMERBOX_REQUEST_LOCK_KEY = 'dea_customerbox_rt_data_lock_v1';
    const CUSTOMERBOX_REQUEST_LOCK_TTL_MS = 120000;
    const CUSTOMERBOX_REQUEST_LOCK_POLL_MS = 120;
    const CUSTOMERBOX_REQUEST_LOCK_OWNER = `dea-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    function waitForCustomerboxRetry(delayMs) {
        return new Promise(resolve => window.setTimeout(resolve, delayMs));
    }

    function readCustomerboxStorageLock() {
        const raw = safeStorage.get(localStorage, CUSTOMERBOX_REQUEST_LOCK_KEY);
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (error) {
            return null;
        }
    }

    function acquireCustomerboxStorageLock() {
        return new Promise(resolve => {
            const deadline = Date.now() + CUSTOMERBOX_REQUEST_LOCK_TTL_MS;
            let timer = null;
            let finished = false;

            const fail = () => {
                if (finished) return;
                finished = true;
                if (timer !== null) window.clearTimeout(timer);
                // null means that localStorage is unavailable or the fallback
                // lock could not be acquired. The caller then uses the request
                // without this optional coordination layer.
                resolve(null);
            };

            const attempt = () => {
                if (finished) return;
                if (Date.now() > deadline) {
                    fail();
                    return;
                }

                const current = readCustomerboxStorageLock();
                const now = Date.now();
                if (!current || Number(current.expiresAt || 0) <= now) {
                    const candidate = {
                        owner: CUSTOMERBOX_REQUEST_LOCK_OWNER,
                        token: `${now}-${Math.random().toString(36).slice(2)}`,
                        expiresAt: now + CUSTOMERBOX_REQUEST_LOCK_TTL_MS
                    };
                    const written = safeStorage.set(localStorage, CUSTOMERBOX_REQUEST_LOCK_KEY, JSON.stringify(candidate));
                    if (!written) {
                        fail();
                        return;
                    }
                    const confirmed = readCustomerboxStorageLock();
                    if (confirmed && confirmed.owner === candidate.owner && confirmed.token === candidate.token) {
                        finished = true;
                        const heartbeat = window.setInterval(() => {
                            // Bei Storage-Fehlern läuft die eigentliche Anfrage trotzdem
                            // weiter; die TTL schützt den Lock, falls der Storage-Zugriff
                            // fehlschlägt.
                            const active = readCustomerboxStorageLock();
                            if (active && active.owner === candidate.owner && active.token === candidate.token) {
                                safeStorage.set(
                                    localStorage,
                                    CUSTOMERBOX_REQUEST_LOCK_KEY,
                                    JSON.stringify({ ...candidate, expiresAt: Date.now() + CUSTOMERBOX_REQUEST_LOCK_TTL_MS })
                                );
                            }
                        }, Math.max(1000, Math.floor(CUSTOMERBOX_REQUEST_LOCK_TTL_MS / 3)));

                        resolve(() => {
                            window.clearInterval(heartbeat);
                            // TTL-Ablauf ist der Fallback, falls das Entfernen fehlschlägt.
                            const active = readCustomerboxStorageLock();
                            if (active && active.owner === candidate.owner && active.token === candidate.token) {
                                safeStorage.remove(localStorage, CUSTOMERBOX_REQUEST_LOCK_KEY);
                            }
                        });
                        return;
                    }
                }

                timer = window.setTimeout(attempt, CUSTOMERBOX_REQUEST_LOCK_POLL_MS + Math.floor(Math.random() * 80));
            };

            attempt();
        });
    }

    function withCustomerboxRequestLock(task) {
        if (navigator.locks && typeof navigator.locks.request === 'function') {
            return navigator.locks.request(CUSTOMERBOX_REQUEST_LOCK_NAME, { mode: 'exclusive' }, task);
        }

        return acquireCustomerboxStorageLock().then(release => {
            if (typeof release !== 'function') return task();
            return Promise.resolve()
                .then(task)
                .finally(release);
        });
    }

    function createCustomerboxSessionError(response) {
        const status = Number(response && response.status);
        const responseText = String(response && response.responseText || '');
        const authRequired = status === 401 || isCustomerboxSessionExpiredResponse(responseText);
        const sessionError = new Error(authRequired
            ? 'Anmeldung in [C] erforderlich'
            : 'Abgelaufene Session');
        sessionError.customerboxSessionExpired = true;
        sessionError.customerboxAuthRequired = authRequired;
        sessionError.responseText = responseText;
        sessionError.status = status;
        return sessionError;
    }

    function getCustomerboxCacheKey(ticketId) {
        return `rt_data/${String(ticketId || '').trim()}`;
    }

    function readCustomerboxCache(ticketId) {
        const key = getCustomerboxCacheKey(ticketId);
        if (!key || key === 'rt_data/') return null;

        const ttl = Number(safeStorage.get(sessionStorage, `${key}_ttl`));
        const response = safeStorage.get(sessionStorage, `${key}_response`);
        const now = Math.round(Date.now() / 1000);
        if (!response || !Number.isFinite(ttl) || ttl < now) return null;

        const data = readJson(response);
        return data && typeof data === 'object' ? data : null;
    }

    function writeCustomerboxCache(ticketId, data) {
        const key = getCustomerboxCacheKey(ticketId);
        if (!key || key === 'rt_data/' || !data || typeof data !== 'object') return;

        const now = Math.round(Date.now() / 1000);
        const ok = safeStorage.set(sessionStorage, `${key}_ttl`, String(now + CUSTOMERBOX_CACHE_TTL_SECONDS))
            && safeStorage.set(sessionStorage, `${key}_response`, JSON.stringify(data));
        if (!ok) log('Customerbox session cache unavailable');
    }

    function customerboxRequestOnce(ticketId) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${CUSTOMERBOX_API}rt_data/${encodeURIComponent(ticketId)}`,
                timeout: 90000,
                withCredentials: true,
                onload(response) {
                    try {
                        // Customerbox's original Oldstack overlay treats
                        // HTTP 401 as an authentication requirement, even when
                        // the response body contains no readable message.
                        if (response.status === 401 || isCustomerboxSessionExpiredResponse(response.responseText)) {
                            reject(createCustomerboxSessionError(response));
                            return;
                        }
                        if (response.status < 200 || response.status >= 300) {
                            throw new Error(`Customerbox-Abfrage fehlgeschlagen (${response.status})`);
                        }
                        const data = readJson(response.responseText);
                        writeCustomerboxCache(ticketId, data);
                        resolve(data);
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror() {
                    reject(new Error('Customerbox nicht erreichbar'));
                },
                ontimeout() {
                    reject(new Error('Customerbox hat nicht rechtzeitig geantwortet'));
                },
                onabort() {
                    reject(new Error('Customerbox-Abfrage wurde abgebrochen'));
                }
            });
        });
    }

    function customerboxRequest(ticketId, attempt = 0) {
        const lockStart = performance.now();
        // A confirmed authentication failure is final. Retrying a 401 only
        // delayed the legacy "Anmeldung in [C] erforderlich" indication.
        return withCustomerboxRequestLock(() => {
            markTiming(`Customerbox-Lock erhalten (Versuch ${attempt + 1})`, lockStart);
            return customerboxRequestOnce(ticketId);
        }).catch(error => {
            if (error && error.customerboxAuthRequired) throw error;
            if (!isCustomerboxSessionExpiredError(error) || attempt >= CUSTOMERBOX_SESSION_RETRY_DELAYS_MS.length) {
                throw error;
            }
            const baseDelay = CUSTOMERBOX_SESSION_RETRY_DELAYS_MS[attempt];
            const jitter = Math.floor(Math.random() * 250);
            const retryDelay = baseDelay + jitter;
            log(
                `Customerbox session response; retrying request ${attempt + 1}/${CUSTOMERBOX_SESSION_RETRY_DELAYS_MS.length} in ${retryDelay} ms`
            );
            return waitForCustomerboxRetry(retryDelay)
                .then(() => customerboxRequest(ticketId, attempt + 1));
        });
    }

    function getCustomerboxToken(data, teambox) {
        return String(
            (teambox && (teambox.token || teambox.customer || teambox.customer_token)) ||
            (data && data.teambox && (data.teambox.token || data.teambox.customer)) ||
            ''
        ).trim();
    }

    function getCustomerboxInstallUrl(data, teambox, ticketId) {
        const token = getCustomerboxToken(data, teambox);
        if (!token || !ticketId) return null;
        return `https://live.teambox-supermaint.service.de1.everii/api/api.py?customer=${encodeURIComponent(token)}&rt_ticket=${encodeURIComponent(ticketId)}&module=install`;
    }

    function getCustomerboxInstances(data) {
        return Array.isArray(data && data.instances) ? data.instances : [];
    }

    function getCustomerboxSupportInstance(data) {
        const instances = getCustomerboxInstances(data);
        return instances.find(instance => {
            const target = String(instance && (instance.target || instance.host || instance.domain) || '').toLowerCase();
            return target === 'support12' || target.includes('support12');
        }) || instances[0] || null;
    }

    function getCustomerboxSupportUrl(data, teambox, ticketId) {
        const token = getCustomerboxToken(data, teambox);
        if (!token || !ticketId) return null;

        const instance = getCustomerboxSupportInstance(data);
        if (!instance) return null;

        const target = String(instance.target || '').toLowerCase();
        if (target === 'support12' || target.includes('support12')) {
            return `https://${encodeURIComponent(token)}_${encodeURIComponent(ticketId)}.support12.everii.at`;
        }

        const instanceTarget = String(instance.target || '').trim();
        return instanceTarget
            ? `https://${encodeURIComponent(token)}_${encodeURIComponent(ticketId)}.${instanceTarget}.intevo`
            : null;
    }

    function getCustomerboxLiveUrl(data, teambox) {
        const token = getCustomerboxToken(data, teambox);
        if (!token) return null;
        return `https://live.teambox-supermaint.service.de1.everii/index.php?customer=${encodeURIComponent(token)}`;
    }

    function isCustomerboxMode() {
        // The mode is selected once per ticket. A successful DEA response
        // permanently owns the bar until the ticket changes.
        return state.renderMode === 'customerbox';
    }

    function joinUrl(base, path) {
        if (!path) return base;
        if (/^https?:\/\//i.test(path)) return path;
        return `${base.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
    }

    function asName(value) {
        if (!value) return null;
        if (typeof value === 'string' || typeof value === 'number') return String(value);
        if (typeof value === 'object') {
            const first = value.first_name || value.firstName || '';
            const last = value.last_name || value.lastName || '';
            return value.name || value.display_name || value.displayName || value.full_name || value.fullName || `${first} ${last}`.trim() || value.email || null;
        }
        return null;
    }

    function findField(objects, keys) {
        for (const object of objects) {
            if (!object || typeof object !== 'object') continue;
            for (const key of keys) {
                const result = asName(object[key]);
                if (result) return result;
            }
        }
        return null;
    }

    function getSupportAgent(data, teambox) {
        const agentKeys = [
            'support_agent', 'supportAgent', 'support_agent_name', 'supportAgentName',
            'assigned_agent', 'assignedAgent', 'agent_name', 'agentName',
            'supportAgentUser', 'owner', 'assignee'
        ];
        const result = findField([
            teambox,
            data,
            data && data.ticket,
            data && data.customer,
            data && data.profile
        ], agentKeys);
        return result || '---';
    }

    function normalizeApiOwnerText(value) {
        return String(value || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLocaleLowerCase('de-DE');
    }

    function apiIdentityValues(value) {
        if (value == null || value === '') return [];
        if (typeof value === 'string' || typeof value === 'number') return [String(value)];
        if (typeof value !== 'object') return [];
        return [
            value.id,
            value.user_id,
            value.userId,
            value.owner_id,
            value.ownerId,
            value.email,
            value.user_email,
            value.userEmail,
            value.name,
            value.display_name,
            value.displayName,
            value.full_name,
            value.fullName,
            value.first_name && value.last_name ? `${value.first_name} ${value.last_name}` : null,
            value.firstName && value.lastName ? `${value.firstName} ${value.lastName}` : null
        ].filter(item => item !== null && item !== undefined && item !== '')
            .map(String);
    }

    function apiIdentitiesMatch(left, right) {
        const leftValues = apiIdentityValues(left).map(normalizeApiOwnerText).filter(Boolean);
        const rightValues = apiIdentityValues(right).map(normalizeApiOwnerText).filter(Boolean);
        return leftValues.some(leftValue => rightValues.some(rightValue => {
            if (leftValue === rightValue) return true;
            const leftWords = leftValue.split(' ').filter(Boolean).sort().join(' ');
            const rightWords = rightValue.split(' ').filter(Boolean).sort().join(' ');
            return leftWords.length >= 5 && leftWords === rightWords;
        }));
    }

    function getApiOwnershipState(data) {
        if (!data || typeof data !== 'object') return null;
        const positiveKeys = new Set([
            'is_ticket_owner', 'isTicketOwner', 'ticket_owner_match', 'ticketOwnerMatch',
            'owner_match', 'ownerMatch', 'is_open_ticket_of_yours', 'isOpenTicketOfYours'
        ]);
        const negativeKeys = new Set([
            'is_not_ticket_owner', 'isNotTicketOwner', 'not_ticket_owner', 'notTicketOwner',
            'is_not_open_ticket_of_yours', 'isNotOpenTicketOfYours'
        ]);
        const currentUserKeys = [
            'current_user', 'currentUser', 'logged_in_user', 'loggedInUser',
            'authenticated_user', 'authenticatedUser', 'api_user', 'apiUser', 'user'
        ];
        const ownerKeys = [
            'ticket_owner', 'ticketOwner', 'ticket_owner_user', 'ticketOwnerUser',
            'owner', 'assignee', 'assigned_to', 'assignedTo'
        ];
        const seen = new Set();
        let explicitState = null;
        let currentUser = null;
        let ticketOwner = null;

        function visit(value, key = '', depth = 0) {
            if (value == null || depth > 8) return;
            const normalizedKey = String(key || '');
            if (positiveKeys.has(normalizedKey) && typeof value === 'boolean') {
                explicitState = value;
            } else if (negativeKeys.has(normalizedKey) && typeof value === 'boolean' && value) {
                explicitState = false;
            }
            if (currentUserKeys.includes(normalizedKey)) currentUser = value;
            if (ownerKeys.includes(normalizedKey)) ticketOwner = value;
            if (typeof value === 'string') {
                const text = normalizeApiOwnerText(value);
                if (text.includes('this ticket is not an open ticket of yours') ||
                    text.includes('not an open ticket of yours')) {
                    explicitState = false;
                } else if (text.includes('open ticket of yours')) {
                    explicitState = true;
                }
                return;
            }
            if (typeof value !== 'object' || seen.has(value)) return;
            seen.add(value);
            if (Array.isArray(value)) {
                value.forEach(item => visit(item, '', depth + 1));
                return;
            }
            Object.keys(value).forEach(childKey => visit(value[childKey], childKey, depth + 1));
        }

        visit(data);
        if (explicitState !== null) return explicitState;
        if (currentUser !== null && ticketOwner !== null) {
            return apiIdentitiesMatch(currentUser, ticketOwner);
        }
        // No affirmative API signal: never assume ownership from a normal
        // ticket response. The indicator remains red until the API confirms it.
        return null;
    }

    // true von Klick bis Ende von Sync + Ticket-Neuladen (steuert das Dreh-Symbol)
    let syncNowActive = false;
    let syncRecheckId = 0;

    function toolRequest(options) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                timeout: 30000,
                ...options,
                onload: resolve,
                onerror() {
                    reject(new Error(`DEA-Tool nicht erreichbar: ${TOOL}`));
                },
                ontimeout() {
                    reject(new Error('DEA-Tool hat nicht rechtzeitig geantwortet'));
                },
                onabort() {
                    reject(new Error('Sync-Anfrage wurde abgebrochen'));
                }
            });
        });
    }

    function isToolUrl(url) {
        return typeof url === 'string' && (url === TOOL || url.startsWith(`${TOOL}/`));
    }

    // /hubspot/sync ist nur per PUT (Turbo "data-turbo-method") mit CSRF-Token
    // erreichbar; ein direkter GET liefert 404. Deshalb erst die Ticketübersicht
    // laden, Token + Button-Ziel auslesen und dann dieselbe Anfrage senden,
    // die Turbo beim Klick auf "Sync now" schicken würde.
    async function runHubSpotSyncInBackground() {
        const page = await toolRequest({
            method: 'GET',
            url: DEA_TICKETS_URL,
            headers: { Accept: 'text/html' }
        });
        if (page.status < 200 || page.status >= 300 || (page.finalUrl && !isToolUrl(page.finalUrl))) {
            // Z. B. Weiterleitung auf auth.everii.io (nicht angemeldet).
            throw new Error(`Ticketübersicht nicht abrufbar (${page.status})`);
        }

        const doc = new DOMParser().parseFromString(page.responseText, 'text/html');
        const link = doc.querySelector('a[href$="/hubspot/sync"]');
        if (!link) {
            const missing = new Error('Sync-Button in der Ticketübersicht nicht verfügbar (läuft evtl. bereits)');
            missing.syncButtonMissing = true;
            throw missing;
        }

        const metaContent = name => {
            const meta = doc.querySelector(`meta[name="${name}"]`);
            return meta ? meta.getAttribute('content') || '' : '';
        };
        const token = metaContent('csrf-token');
        const tokenParam = metaContent('csrf-param') || 'authenticity_token';
        const method = String(link.getAttribute('data-turbo-method') || 'post').toLowerCase();

        const body = new URLSearchParams();
        if (method !== 'post') body.set('_method', method);
        if (token) body.set(tokenParam, token);

        const response = await toolRequest({
            method: 'POST',
            url: new URL(link.getAttribute('href'), `${TOOL}/`).href,
            data: body.toString(),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'text/vnd.turbo-stream.html, text/html, application/xhtml+xml',
                ...(token ? { 'X-CSRF-Token': token } : {}),
                Origin: TOOL,
                Referer: DEA_TICKETS_URL
            }
        });
        if (response.status < 200 || response.status >= 400 || (response.finalUrl && !isToolUrl(response.finalUrl))) {
            throw new Error(`HubSpot-Sync wurde abgelehnt (${response.status})`);
        }
        log(`HubSpot sync triggered in background (${response.status})`);
    }

    function openSyncTabFallback() {
        const popup = window.open(`${DEA_TICKETS_URL}${AUTO_SYNC_HASH}`, '_blank', 'noopener,noreferrer');
        if (!popup) log('DEA tickets popup blocked', DEA_TICKETS_URL);
    }

    // Prüft nach dem Sync im Hintergrund (max. 3 Versuche), ob das Ticket jetzt
    // freigegeben ist. Bewusst OHNE loadTicket()/renderLoading(): Die Leiste wird
    // nur neu gezeichnet, wenn sich das Schloss tatsächlich erledigt hat, sonst
    // bleibt sie unverändert (kein Flackern, das Dreh-Symbol läuft weiter).
    async function recheckTicketAfterSync(ticketId) {
        const recheckId = ++syncRecheckId;
        const stillCurrent = () => recheckId === syncRecheckId &&
            getTicketId() === ticketId && state.ticketId === ticketId;

        for (const delayMs of [3000, 6000, 10000]) {
            await new Promise(resolve => window.setTimeout(resolve, delayMs));
            if (!stillCurrent()) return;

            let data;
            try {
                data = await apiRequest('GET', 'hubspot/ticket', ticketId);
            } catch (error) {
                log('Ticket after sync not available yet', error);
                continue;
            }
            if (!stillCurrent()) return;
            if (getApiOwnershipState(data) === false) continue;

            const resolvedMode = await resolveRenderMode(data);
            if (!stillCurrent()) return;

            state.data = data;
            state.ticketOwnerAccess = getApiOwnershipState(data);
            state.renderMode = resolvedMode;
            rememberRevision(data, ticketId);
            if (state.renderMode === 'customerbox') {
                renderCustomerboxMode();
            } else {
                renderData(data);
            }
            loadYouTrack(data, ticketId);
            return;
        }
    }

    function markSyncing(status) {
        status.classList.add('is-syncing');
        status.title = 'HubSpot-Sync läuft …';
        status.setAttribute('aria-label', status.title);
        status.setAttribute('aria-busy', 'true');
        if (!status.querySelector('.dea-sync-spinner')) status.appendChild(createSyncSpinner());
    }

    async function startSyncNow(status) {
        if (!status || syncNowActive) return;
        syncNowActive = true;
        const ticketId = getTicketId();
        const originalTitle = status.title;
        markSyncing(status);

        try {
            try {
                await runHubSpotSyncInBackground();
            } catch (error) {
                if (error && error.syncButtonMissing) throw error;
                // Hintergrund-Request nicht möglich (Login, CSRF, Netzwerk):
                // Fallback über einen Tab, der "Sync now" klickt und sich schließt.
                log('Background sync failed, using tab fallback', error);
                openSyncTabFallback();
            }
            if (ticketId) await recheckTicketAfterSync(ticketId);
        } catch (error) {
            log('HubSpot sync not started', error);
            status.title = `Sync nicht möglich: ${error.message}`;
            status.setAttribute('aria-label', status.title);
            window.setTimeout(() => { status.title = originalTitle; }, 6000);
        } finally {
            syncNowActive = false;
            // Die Leiste kann zwischenzeitlich neu gerendert worden sein.
            document.querySelectorAll(`#${BAR_ID} .dea-owner-status.is-syncing`).forEach(element => {
                element.classList.remove('is-syncing');
                element.removeAttribute('aria-busy');
                element.querySelectorAll('.dea-sync-spinner').forEach(spinner => spinner.remove());
            });
        }
    }

    function createTicketOwnerStatus(data, teambox) {
        const apiState = state.ticketOwnerAccess;
        // Unknown is not the same as "not owner". Only an explicit API
        // rejection is allowed to render the red X. This avoids false
        // negatives when the ticket endpoint omits the owner field.
        if (apiState !== false) return null;

        const status = document.createElement('span');
        status.className = 'dea-owner-status is-not-owner';
        status.textContent = '';
        status.title = 'Ticketbesitz nicht erkannt – Klick startet den HubSpot-Sync';
        status.setAttribute('aria-label', status.title);
        if (syncNowActive) markSyncing(status);

        {
            status.setAttribute('role', 'button');
            status.setAttribute('tabindex', '0');
            const openSyncNow = event => {
                const keyboardActivation = event.type === 'keydown' &&
                    (event.key === 'Enter' || event.key === ' ' || event.code === 'Space');
                const pointerActivation = event.type !== 'keydown' && isPlainLeftClick(event);
                if (!keyboardActivation && !pointerActivation) return;
                event.preventDefault();
                event.stopPropagation();
                if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                }
                startSyncNow(status);
            };
            status.addEventListener('click', openSyncNow, true);
            status.addEventListener('keydown', openSyncNow, true);
        }
        return status;
    }

    function getCustomerName(teambox) {
        return String(
            (teambox && (teambox.name || teambox.token || teambox.customer_name)) ||
            'Teambox'
        );
    }

    function getReleaseNumber(teambox) {
        // The original HubSpot overlay receives core_release as an object and
        // renders its revision property: <Release release={teambox.core_release}>
        // -> children: release.revision.
        const release = teambox && teambox.core_release;
        if (!release || typeof release !== 'object') return '';
        const revision = release.revision;
        return revision === undefined || revision === null ? '' : String(revision).trim();
    }

    function getAgentShortName(agent) {
        const normalized = String(agent || '').trim().replace(/\s+/g, ' ');
        if (!normalized) return '';

        const exceptions = {
            'max steensma': 'MAXS',
            'katharina r\u00fcckert': 'KARU'
        };
        const exception = exceptions[normalized.toLocaleLowerCase('de-DE')];
        if (exception) return exception;

        const parts = normalized.split(' ').filter(Boolean);
        if (parts.length >= 2) {
            const first = Array.from(parts[0]).slice(0, 2).join('');
            const last = Array.from(parts[parts.length - 1]).slice(0, 2).join('');
            return `${first}${last}`.toUpperCase();
        }
        return Array.from(normalized.replace(/[^\p{L}]/gu, '')).slice(0, 4).join('').toUpperCase();
    }

    function getTeamboxPath(teambox) {
        return teambox && (teambox.path || teambox.href || teambox.url);
    }

    function getTeamboxId(teambox) {
        if (!teambox) return null;

        // The Customerbox id and the DEA/Deployment Tool id are not always
        // identical. Prefer the deployment-side id for DEA and terminal URLs.
        const deployment = teambox.deployment || teambox.deployment_tool || teambox.deploymentTool || {};
        return teambox.deployment_id ||
            teambox.deploymentId ||
            teambox.deployment_tool_id ||
            teambox.deploymentToolId ||
            teambox.dea_id ||
            teambox.deaId ||
            deployment.id ||
            deployment.teambox_id ||
            deployment.teamboxId ||
            teambox.id ||
            teambox.teambox_id ||
            teambox.teamboxId ||
            null;
    }

    function getTeamboxToolUrl(teambox, suffix = '') {
        const id = getTeamboxId(teambox);
        return id ? `${TOOL}/teamboxes/${encodeURIComponent(id)}${suffix}` : null;
    }

    function getTeamboxIdFromToolUrl(value) {
        try {
            const url = new URL(String(value || ''), TOOL);
            const match = url.pathname.match(/^\/teamboxes\/([^/]+)/i);
            return match ? decodeURIComponent(match[1]) : '';
        } catch (error) {
            return '';
        }
    }

    function parseTeamboxDomainUrl(html, detailUrl) {
        const parser = new DOMParser();
        const documentFromResponse = parser.parseFromString(String(html || ''), 'text/html');
        const info = documentFromResponse.querySelector('#teambox-info');
        if (!info) return null;

        const domainRow = Array.from(info.querySelectorAll('dl.row')).find(row => {
            const label = row.querySelector('dt');
            return label && label.textContent.replace(/\s+/g, ' ').trim().toLowerCase() === 'domain:';
        });
        if (!domainRow) return null;

        const domainLink = domainRow.querySelector('dd a[href]');
        if (!domainLink) return null;

        try {
            const domainUrl = new URL(domainLink.getAttribute('href'), detailUrl);
            if (!/^https?:$/i.test(domainUrl.protocol)) return null;
            domainUrl.pathname = '/app/auth';
            domainUrl.search = '';
            domainUrl.hash = '';
            return domainUrl.href;
        } catch (error) {
            return null;
        }
    }

    function getTeamboxDomainUrl(teamboxId) {
        const id = String(teamboxId || '').trim();
        if (!id) return Promise.resolve(null);
        if (DEA_DOMAIN_URL_CACHE.has(id)) return DEA_DOMAIN_URL_CACHE.get(id);

        const detailUrl = `${TOOL}/teamboxes/${encodeURIComponent(id)}`;
        const request = new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: detailUrl,
                timeout: 30000,
                withCredentials: true,
                onload(response) {
                    if (response.status < 200 || response.status >= 300) {
                        resolve(null);
                        return;
                    }
                    resolve(parseTeamboxDomainUrl(response.responseText, detailUrl));
                },
                onerror() {
                    resolve(null);
                },
                ontimeout() {
                    resolve(null);
                },
                onabort() {
                    resolve(null);
                }
            });
        }).then(domainUrl => {
            // Do not permanently cache an unavailable result. A later
            // render can then retry after the deployment tool is ready.
            if (!domainUrl) DEA_DOMAIN_URL_CACHE.delete(id);
            return domainUrl;
        });
        DEA_DOMAIN_URL_CACHE.set(id, request);
        return request;
    }

    function getRepositoryUrl(teambox, data) {
        const customer = getCustomerName(teambox);
        const repositoryName = String(customer || '').trim();
        if (repositoryName) {
            return `https://github.com/everii-Group/teambox-custom-${encodeURIComponent(repositoryName)}/commits/master`;
        }

        const repository = teambox && teambox.repository;
        if (!repository) return null;
        if (typeof repository === 'string') return repository;
        return repository.url || repository.html_url || null;
    }

    function getCloneUrl(clone) {
        return clone && (clone.url || clone.website || clone.href);
    }

    function getCloneAuthUrl(cloneUrl) {
        if (!cloneUrl) return null;
        try {
            const url = new URL(String(cloneUrl), location.href);
            url.pathname = '/app/auth';
            return url.href;
        } catch (error) {
            return String(cloneUrl);
        }
    }

    // Same data contract as the HubSpot overlay: TablePlus is available
    // only when clone.tableplus.url is present.
    function getCloneTablePlusUrl(clone) {
        const tableplus = clone && clone.tableplus;
        return tableplus && tableplus.url ? tableplus.url : null;
    }

    function getCloneId(clone) {
        if (!clone) return null;
        const deployment = clone.deployment || clone.deployment_tool || clone.deploymentTool || {};
        return clone.deployment_id ||
            clone.deploymentId ||
            clone.deployment_tool_id ||
            clone.deploymentToolId ||
            clone.dea_id ||
            clone.deaId ||
            deployment.id ||
            deployment.teambox_id ||
            deployment.teamboxId ||
            clone.teambox_id ||
            clone.teamboxId ||
            clone.id ||
            null;
    }

    function getTeamboxIdFromCloneUrl(url) {
        if (!url) return null;
        const match = String(url).match(/(?:^|\/)teamboxes\/([A-Za-z0-9_-]+)(?:\/|$|\?|#)/i);
        return match ? match[1] : null;
    }

    function getCloneDeploymentId(clone, cloneUrl) {
        const directId = getCloneId(clone);
        if (directId) return directId;

        // The DEA API exposes the clone website in `url`, while the
        // deployment path is normally in `path` (for example /teamboxes/1225).
        // Use every known path/URL field before giving up.
        const candidates = [
            clone && clone.path,
            clone && clone.href,
            clone && clone.setup_path,
            clone && clone.setupPath,
            clone && clone.terminal_path,
            clone && clone.terminalPath,
            cloneUrl
        ];
        for (const candidate of candidates) {
            const id = getTeamboxIdFromCloneUrl(candidate);
            if (id) return id;
        }
        return null;
    }

    function findDeploymentIdInValue(value, depth = 0, seen = new Set()) {
        if (value === null || value === undefined || depth > 7) return null;
        if (typeof value === 'string') return getTeamboxIdFromCloneUrl(value);
        if (typeof value !== 'object' || seen.has(value)) return null;
        seen.add(value);

        const directKeys = [
            'deployment_id', 'deploymentId', 'deployment_tool_id', 'deploymentToolId',
            'teambox_id', 'teamboxId', 'dea_id', 'deaId'
        ];
        for (const key of directKeys) {
            const candidate = value[key];
            if (candidate !== null && candidate !== undefined && String(candidate).trim()) {
                return String(candidate).trim();
            }
        }

        for (const child of Object.values(value)) {
            const found = findDeploymentIdInValue(child, depth + 1, seen);
            if (found) return found;
        }
        return null;
    }

    function getCloneCreationDeploymentId(response, setupPath) {
        const responseClone = response && response.clone;
        // The setup path is the authoritative deployment-side identifier.
        // Prefer it over a generic clone.id, which can identify another API object.
        const fromSetupPath = getTeamboxIdFromCloneUrl(setupPath);
        if (fromSetupPath) return String(fromSetupPath);

        const fromClone = getCloneDeploymentId(responseClone, setupPath);
        if (fromClone) return String(fromClone);
        return findDeploymentIdInValue(responseClone || response) || null;
    }

    function attachCreatedCloneDeploymentId(data, responseClone, setupPath, deploymentId) {
        if (!data || !deploymentId) return false;
        const teamboxes = Array.isArray(data.teamboxes) ? data.teamboxes : [];
        const clones = teamboxes.flatMap(teambox =>
            Array.isArray(teambox && teambox.clones) ? teambox.clones : []
        );
        if (!clones.length) return false;

        const responseUrl = getCloneUrl(responseClone) || setupPath || '';
        const responseName = getCloneName(responseClone);
        let target = null;

        if (responseUrl) {
            const normalizedResponseUrl = String(responseUrl).replace(/\/$/, '').toLowerCase();
            target = clones.find(clone => {
                const cloneUrl = getCloneUrl(clone);
                return cloneUrl && String(cloneUrl).replace(/\/$/, '').toLowerCase() === normalizedResponseUrl;
            }) || null;
        }

        if (!target && responseName && responseName !== 'Clone') {
            target = clones.find(clone => getCloneName(clone) === responseName) || null;
        }

        // The newly created clone is normally the last unresolved entry while
        // the asynchronous ticket refresh is still catching up.
        if (!target) {
            target = [...clones].reverse().find(clone =>
                !getCloneDeploymentId(clone, getCloneUrl(clone))
            ) || clones[clones.length - 1];
        }

        if (!target || getCloneDeploymentId(target, getCloneUrl(target))) return false;
        target.deployment_id = String(deploymentId);
        if (!target.path) target.path = `/teamboxes/${encodeURIComponent(deploymentId)}`;
        return true;
    }

    function getCloneTerminalUrl(clone, cloneId) {
        if (clone && (clone.terminal_url || clone.terminalUrl || clone.terminal)) {
            return clone.terminal_url || clone.terminalUrl || clone.terminal;
        }
        return cloneId ? `${TOOL}/teamboxes/${encodeURIComponent(cloneId)}/terminal` : null;
    }

    function getCloneName(clone) {
        return String((clone && (clone.name || clone.label)) || 'Clone');
    }

    function getCloneBadgeIndex(clone, fallbackIndex) {
        const cloneName = getCloneName(clone);
        const match = cloneName.match(/\bhs\d+(?:-(\d+))?\b/i);
        if (!match) return fallbackIndex;
        const suffix = match[1];
        const number = suffix ? Number(suffix) : 1;
        return Number.isInteger(number) && number > 0 ? number : fallbackIndex;
    }

    function isCloneRunning(clone) {
        return String(clone && clone.state || '').trim().toLowerCase() === 'running';
    }

    function isCloneDropdownEvent(event) {
        const target = event && event.target;
        return Boolean(target && typeof target.closest === 'function' &&
            target.closest('.dea-clone-state-dropdown'));
    }

    function addCloneStateIcon(parent, clone, index) {
        const running = isCloneRunning(clone);
        const badgeIndex = getCloneBadgeIndex(clone, index + 1);
        const title = running
            ? `Open Clone ${index + 1}: ${getCloneName(clone)}`
            : `Open Clone ${index + 1} nicht verfügbar (Status: ${String(clone && clone.state || 'unbekannt')})`;
        const cloneDeploymentId = String(getCloneDeploymentId(clone, getCloneUrl(clone)) || '');
        if (running && cloneDeploymentId && pendingCloneIds.has(cloneDeploymentId)) {
            stopCloneStatePolling(cloneDeploymentId);
        }
        const isDeleting = Boolean(cloneDeploymentId) && deletePollers.has(cloneDeploymentId);
        const showSpinner = !running && !isDeleting && cloneDeploymentId && pendingCloneIds.has(cloneDeploymentId);
        const icon = isDeleting
            ? CLONE_DELETING_ICON
            : (running ? CLONE_RUNNING_ICON : (showSpinner ? CLONE_LOADING_ICON : CLONE_NOT_RUNNING_ICON));
        const wrapper = document.createElement('span');
        // Ladendes T: Klick öffnet die Progress-Seite statt die Leiste neu zu laden.
        const activateIcon = () => {
            if (isDeleting) {
                const now = Date.now();
                if (now - (activateIcon.last || 0) < 600) return;
                activateIcon.last = now;
                window.open(getDeleteTargetUrl(cloneDeploymentId), '_blank', 'noopener,noreferrer');
            } else if (showSpinner) {
                const now = Date.now();
                if (now - (activateIcon.last || 0) < 600) return; // pointerdown + click entprellen
                activateIcon.last = now;
                const progressUrl = `${TOOL}/teamboxes/${encodeURIComponent(cloneDeploymentId)}/progress`;
                window.open(progressUrl, '_blank', 'noopener,noreferrer');
            } else {
                reloadOverlay();
            }
        };
        wrapper.className = 'dea-clone-state-wrap';

        const reloadCurrentPage = event => {
            // The wrapper uses capture handlers. Never treat an event from
            // the progress/TablePlus/terminal dropdown as a T-icon reload.
            if (isCloneDropdownEvent(event)) return;
            const keyboardActivation = event.type === 'keydown' &&
                (event.key === 'Enter' || event.key === ' ' || event.code === 'Space');
            const pointerActivation = event.type !== 'keydown' &&
                (event.button === 0 || event.button === undefined);
            if (!keyboardActivation && !pointerActivation) return;
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
            activateIcon();
        };

        if (running) {
            const link = document.createElement('a');
            link.className = 'dea-link dea-clone-state-running';
            link.href = getCloneAuthUrl(getCloneUrl(clone)) || '#';
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.title = title;
            link.setAttribute('aria-label', title);
            link.setAttribute('aria-haspopup', 'menu');
            if (isDeleting) {
                // Rotes T: Link zeigt auf die Lösch-Operation statt auf den Clone.
                // Der href wird sofort gesetzt und vor jeder Interaktion erneuert,
                // damit auch der native Browser-Klick (neuer Tab) dorthin geht.
                link.dataset.deleteId = cloneDeploymentId;
                link.href = getDeleteTargetUrl(cloneDeploymentId);
                link.title = 'Löschung läuft - Klick öffnet die Operation';
                link.setAttribute('aria-label', link.title);
                const refreshHref = () => { link.href = getDeleteTargetUrl(cloneDeploymentId); };
                ['mouseenter', 'focus', 'pointerdown', 'mousedown', 'click'].forEach(type => {
                    link.addEventListener(type, refreshHref, true);
                });
            }
            const image = document.createElement('img');
            image.src = icon;
            image.alt = '';
            image.className = 'dea-clone-state-image';
            link.appendChild(image);
            addCloneIndexBadge(link, badgeIndex);
            wrapper.appendChild(link);
        } else {
            const disabled = document.createElement('span');
            disabled.className = 'dea-link dea-clone-state-disabled';
            disabled.title = (showSpinner ? `${title}. Klicken öffnet den Fortschritt` : `${title}. Klicken zum Neuladen`);
            disabled.setAttribute('aria-label', (showSpinner ? `${title}. Klicken öffnet den Fortschritt` : `${title}. Klicken zum Neuladen`));
            disabled.setAttribute('aria-disabled', 'true');
            disabled.setAttribute('role', 'button');
            disabled.setAttribute('tabindex', '0');
            const reloadPage = event => {
                if (isCloneDropdownEvent(event)) return;
                const keyboardActivation = event.type === 'keydown' &&
                    (event.key === 'Enter' || event.key === ' ' || event.code === 'Space');
                const pointerActivation = event.type !== 'keydown' && isPlainLeftClick(event);
                if (!keyboardActivation && !pointerActivation) return;
                event.preventDefault();
                event.stopPropagation();
                if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                }
                activateIcon();
            };
            wrapper.setAttribute('role', 'button');
            wrapper.setAttribute('tabindex', '0');
            wrapper.setAttribute('aria-label', (showSpinner ? `${title}. Klicken öffnet den Fortschritt` : `${title}. Klicken zum Neuladen`));
            wrapper.addEventListener('pointerdown', reloadCurrentPage, true);
            wrapper.addEventListener('mousedown', reloadCurrentPage, true);
            wrapper.addEventListener('click', reloadCurrentPage, true);
            wrapper.addEventListener('keydown', reloadCurrentPage, true);
            disabled.addEventListener('pointerdown', reloadPage, true);
            disabled.addEventListener('mousedown', reloadPage, true);
            disabled.addEventListener('click', reloadPage, true);
            disabled.addEventListener('keydown', reloadPage, true);
            const image = document.createElement('img');
            image.src = icon;
            image.alt = '';
            image.className = 'dea-clone-state-image';
            disabled.appendChild(image);
            wrapper.appendChild(disabled);
        }

        parent.appendChild(wrapper);
        return wrapper;
    }

    function addCloneDropdown(wrapper, clone, index, cloneId) {
        if (CLONE_ACTION_MODE !== 'dropdown' || !isCloneRunning(clone)) return null;
        if (!wrapper || !cloneId) return null;
        const tableplusUrl = getCloneTablePlusUrl(clone);

        const dropdown = document.createElement('span');
        dropdown.className = 'dea-clone-state-dropdown';
        dropdown.setAttribute('role', 'menu');
        dropdown.setAttribute('aria-hidden', 'true');

        const customerTeamboxUrl = `${TOOL}/teamboxes/${encodeURIComponent(cloneId)}`;
        addIconLink(dropdown, {
            href: customerTeamboxUrl,
            icon: ICONS.customerTeambox,
            title: `Teambox ${index + 1} öffnen: ${getCloneName(clone)}`
        });

        if (tableplusUrl) {
            addExternalAppLink(dropdown, {
                href: tableplusUrl,
                icon: ICONS.tableplus,
                title: `TablePlus ${index + 1}: ${getCloneName(clone)}`
            });
        }

        const terminalUrl = getCloneTerminalUrl(clone, cloneId);
        if (terminalUrl) {
            addIconLink(dropdown, {
                href: terminalUrl,
                icon: ICONS.terminal,
                title: `Terminal ${index + 1}: ${getCloneName(clone)}`
            });
        }

        if (cloneId) {
            const customDeploymentUrl = `${TOOL}/teamboxes/${encodeURIComponent(cloneId)}/custom_deployment`;
            addIconLink(dropdown, {
                href: customDeploymentUrl,
                icon: ICONS.upgrade,
                title: `Custom Deployment ${index + 1}: ${getCloneName(clone)}`
            });

            const deleteUrl = `${TOOL}/teamboxes/${encodeURIComponent(cloneId)}/delete`;
            addIconLink(dropdown, {
                href: deleteUrl,
                icon: ICONS.delete,
                title: `Teambox ${index + 1} löschen: ${getCloneName(clone)}`
            });
        }

        const link = wrapper.querySelector('.dea-clone-state-running');
        if (!link) return null;
        link.addEventListener('contextmenu', event => {
            event.preventDefault();
            event.stopPropagation();
            closeCloneDropdowns(wrapper);
            const open = !wrapper.classList.contains('is-open');
            wrapper.classList.toggle('is-open', open);
            dropdown.setAttribute('aria-hidden', String(!open));
        }, true);

        wrapper.appendChild(dropdown);
        return dropdown;
    }

    function addInactiveCloneProgressDropdown(wrapper, clone, index, cloneId) {
        if (!cloneId || !wrapper || isCloneRunning(clone)) return null;

        const dropdown = document.createElement('span');
        dropdown.className = 'dea-clone-state-dropdown dea-clone-state-progress-dropdown';
        dropdown.setAttribute('role', 'menu');
        dropdown.setAttribute('aria-hidden', 'true');

        const customerTeamboxUrl = `${TOOL}/teamboxes/${encodeURIComponent(cloneId)}`;
        addIconLink(dropdown, {
            href: customerTeamboxUrl,
            icon: ICONS.customerTeambox,
            title: `Teambox ${index + 1} öffnen: ${getCloneName(clone)}`
        });

        const progressUrl = `${TOOL}/teamboxes/${encodeURIComponent(cloneId)}/progress`;
        addIconLink(dropdown, {
            href: progressUrl,
            icon: CLONE_PROGRESS_ICON,
            title: `Progress ${index + 1}: ${getCloneName(clone)}`
        });

        const deleteUrl = `${TOOL}/teamboxes/${encodeURIComponent(cloneId)}/delete`;
        addIconLink(dropdown, {
            href: deleteUrl,
            icon: ICONS.delete,
            title: `Teambox ${index + 1} löschen: ${getCloneName(clone)}`
        });

        const disabled = wrapper.querySelector('.dea-clone-state-disabled');
        if (!disabled) return null;
        const toggleDropdown = event => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
            closeCloneDropdowns(wrapper);
            const open = !wrapper.classList.contains('is-open');
            wrapper.classList.toggle('is-open', open);
            dropdown.setAttribute('aria-hidden', String(!open));
        };
        disabled.addEventListener('contextmenu', toggleDropdown, true);

        wrapper.appendChild(dropdown);
        return dropdown;
    }

    function addPermanentCloneDeleteMenu(wrapper, clone, index, cloneId) {
        if (CLONE_ACTION_MODE !== 'permanent' || !isCloneRunning(clone) || !cloneId) return null;

        const dropdown = document.createElement('span');
        dropdown.className = 'dea-clone-state-dropdown dea-clone-state-permanent-menu';
        dropdown.setAttribute('role', 'menu');
        dropdown.setAttribute('aria-hidden', 'true');

        const customerTeamboxUrl = `${TOOL}/teamboxes/${encodeURIComponent(cloneId)}`;
        addIconLink(dropdown, {
            href: customerTeamboxUrl,
            icon: ICONS.customerTeambox,
            title: `Teambox ${index + 1} öffnen: ${getCloneName(clone)}`
        });

        const customDeploymentUrl = `${TOOL}/teamboxes/${encodeURIComponent(cloneId)}/custom_deployment`;
        addIconLink(dropdown, {
            href: customDeploymentUrl,
            icon: ICONS.upgrade,
            title: `Custom Deployment ${index + 1}: ${getCloneName(clone)}`
        });

        const deleteUrl = `${TOOL}/teamboxes/${encodeURIComponent(cloneId)}/delete`;
        addIconLink(dropdown, {
            href: deleteUrl,
            icon: ICONS.delete,
            title: `Teambox ${index + 1} löschen: ${getCloneName(clone)}`
        });

        const link = wrapper.querySelector('.dea-clone-state-running');
        if (!link) return null;
        link.addEventListener('contextmenu', event => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
            closeCloneDropdowns(wrapper);
            const open = !wrapper.classList.contains('is-open');
            wrapper.classList.toggle('is-open', open);
            dropdown.setAttribute('aria-hidden', String(!open));
        }, true);

        wrapper.appendChild(dropdown);
        return dropdown;
    }

    function closeCloneDropdowns(except = null) {
        document.querySelectorAll(`#${BAR_ID} .dea-clone-state-wrap.is-open`).forEach(wrapper => {
            if (wrapper === except) return;
            wrapper.classList.remove('is-open');
            const dropdown = wrapper.querySelector('.dea-clone-state-dropdown');
            if (dropdown) dropdown.setAttribute('aria-hidden', 'true');
        });
    }

    function rememberRevision(data, ticketId) {
        let old = [];
        try {
            old = JSON.parse(safeStorage.get(localStorage, REVISION_KEY) || '[]');
        } catch (error) {
            old = [];
        }
        const teamboxes = (data && data.teamboxes || []).map(teambox => ({
            id: teambox.id || null,
            name: getCustomerName(teambox),
            cloneCount: Array.isArray(teambox.clones) ? teambox.clones.length : 0
        }));
        const entry = {
            revision: REVISION,
            timestamp: new Date().toISOString(),
            ticketId,
            teamboxes
        };
        const next = [entry, ...old.filter(item =>
            !(item.revision === entry.revision && item.ticketId === entry.ticketId)
        )].slice(0, MAX_REVISIONS);
        if (!safeStorage.set(localStorage, REVISION_KEY, JSON.stringify(next))) {
            log('DEA bar revision history unavailable');
        }
    }

    function readNumber(key, fallback) {
        const value = Number(safeStorage.get(localStorage, key));
        return Number.isFinite(value) ? value : fallback;
    }

    function applyPosition(bar) {
        let position = { top: 12, left: 12 };
        try {
            position = { ...position, ...JSON.parse(safeStorage.get(localStorage, POSITION_KEY) || '{}') };
        } catch (error) {
            // Use defaults.
        }
        const zoom = Math.min(Math.max(readNumber(ZOOM_KEY, 1), 0.5), 3);
        bar.style.top = `${Math.max(0, position.top)}px`;
        bar.style.left = `${Math.max(0, position.left)}px`;
        bar.style.transform = `scale(${zoom})`;
    }

    function savePosition(bar) {
        const rect = bar.getBoundingClientRect();
        const zoom = Math.min(Math.max(readNumber(ZOOM_KEY, 1), 0.5), 3);
        safeStorage.set(localStorage, POSITION_KEY, JSON.stringify({
            top: Math.round(rect.top),
            left: Math.round(rect.left)
        }));
        safeStorage.set(localStorage, ZOOM_KEY, String(zoom));
    }

    function makeDraggable(bar) {
        if (bar.dataset.dragReady === 'true') return;
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;

        const move = event => {
            if (!dragging) return;
            bar.style.left = `${Math.max(0, Math.round(startLeft + event.clientX - startX))}px`;
            bar.style.top = `${Math.max(0, Math.round(startTop + event.clientY - startY))}px`;
        };
        const stop = () => {
            if (!dragging) return;
            dragging = false;
            document.removeEventListener('pointermove', move, true);
            document.removeEventListener('pointerup', stop, true);
            savePosition(bar);
        };

        bar.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const target = event.target instanceof Element ? event.target : event.target.parentElement;
            if (!target || target.closest('a, button, input, select, textarea, [role=button]')) return;
            // Dragging is limited to the information text and never handles links.
            const dragTarget = target.closest('.dea-context strong, .dea-context .support-agent');
            if (!dragTarget || !bar.contains(dragTarget)) return;
            const rect = bar.getBoundingClientRect();
            dragging = true;
            startX = event.clientX;
            startY = event.clientY;
            startLeft = rect.left;
            startTop = rect.top;
            event.preventDefault();
            document.addEventListener('pointermove', move, true);
            document.addEventListener('pointerup', stop, true);
        });
        bar.dataset.dragReady = 'true';
    }

    function makeZoomable(bar) {
        if (bar.dataset.zoomReady === 'true') return;
        bar.addEventListener('wheel', event => {
            event.preventDefault();
            let zoom = readNumber(ZOOM_KEY, 1);
            zoom += event.deltaY < 0 ? 0.05 : -0.05;
            zoom = Math.min(Math.max(Number(zoom.toFixed(2)), 0.5), 3);
            bar.style.transform = `scale(${zoom})`;
            localStorage.setItem(ZOOM_KEY, String(zoom));
            savePosition(bar);
        }, { passive: false });
        bar.dataset.zoomReady = 'true';
    }

    function createBar() {
        let bar = document.getElementById(BAR_ID);
        if (bar) return bar;
        bar = document.createElement('div');
        bar.id = BAR_ID;
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'DEA HubSpot Links');
        document.body.appendChild(bar);
        applyPosition(bar);
        makeDraggable(bar);
        makeZoomable(bar);
        return bar;
    }

    function clearBar() {
        const bar = document.getElementById(BAR_ID);
        if (bar) bar.remove();
    }

    function addSeparator(parent) {
        const separator = document.createElement('span');
        separator.className = 'dea-separator';
        separator.setAttribute('aria-hidden', 'true');
        parent.appendChild(separator);
    }

    function activateOldStackView() {
        state.renderMode = 'customerbox';
        state.customerboxData = null;
        renderCustomerboxMode();
    }

    function addDeaUpgradeDropdown(wrapper, link, target, teamboxId) {
        if (!wrapper || !link || !target) return null;

        const dropdown = document.createElement('span');
        dropdown.className = 'dea-clone-state-dropdown dea-dea-upgrade-dropdown';
        dropdown.setAttribute('role', 'menu');
        dropdown.setAttribute('aria-hidden', 'true');

        // Create the Teambox icon immediately. Its href is filled in after
        // the detail page has been read, so the icon cannot disappear merely
        // because the cross-origin request is still pending.
        const domainLink = addIconLink(dropdown, {
            href: '#',
            icon: ICONS.openClone,
            title: teamboxId ? 'Teambox-Domain wird geladen' : 'Teambox-Domain nicht verfügbar'
        });
        domainLink.dataset.deaDomainLink = 'true';
        domainLink.dataset.deaDomainLoading = teamboxId ? 'true' : 'false';
        domainLink.classList.add('is-disabled');

        const customDeploymentLink = addIconLink(dropdown, {
            href: target,
            icon: ICONS.upgrade,
            title: 'Upgrade / Custom Deployment'
        });

        // [C] loads the Old Stack bar in the current HubSpot tab. It is
        // intentionally placed directly below Custom Deployment.
        addActionLink(dropdown, {
            href: '#',
            icon: CUSTOMERBOX_ICON,
            title: 'Old Stack-Leiste laden',
            onClick: event => {
                event.stopPropagation();
                activateOldStackView();
            }
        });

        if (teamboxId) {
            getTeamboxDomainUrl(teamboxId).then(domainUrl => {
                if (!domainLink.isConnected) return;
                if (domainUrl) {
                    domainLink.href = domainUrl;
                    domainLink.title = 'Teambox-Domain öffnen';
                    domainLink.setAttribute('aria-label', 'Teambox-Domain öffnen');
                    domainLink.dataset.deaDomainLoading = 'false';
                    domainLink.classList.remove('is-disabled');
                } else {
                    domainLink.title = 'Teambox-Domain nicht verfügbar';
                    domainLink.setAttribute('aria-label', 'Teambox-Domain nicht verfügbar');
                    domainLink.dataset.deaDomainLoading = 'false';
                }
            });
        }

        link.addEventListener('contextmenu', event => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
            closeCloneDropdowns(wrapper);
            const open = !wrapper.classList.contains('is-open');
            wrapper.classList.toggle('is-open', open);
            dropdown.setAttribute('aria-hidden', String(!open));
        }, true);

        wrapper.appendChild(dropdown);
        return dropdown;
    }

    function toRomanNumeral(value) {
        let number = Number(value);
        if (!Number.isInteger(number) || number < 1) return '';
        const numerals = [
            [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
            [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
            [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
        ];
        let result = '';
        for (const [unit, symbol] of numerals) {
            while (number >= unit) {
                result += symbol;
                number -= unit;
            }
        }
        return result;
    }

    function addCloneIndexBadge(link, cloneIndex) {
        // The first clone keeps no visible badge. Badges start at II.
        if (Number(cloneIndex) <= 1) return;
        const roman = toRomanNumeral(cloneIndex);
        if (!roman) return;
        link.classList.add('dea-clone-state-indexed');
        link.dataset.cloneIndex = roman;
        const badge = document.createElement('span');
        badge.className = 'dea-clone-index-badge';
        badge.textContent = roman;
        badge.setAttribute('aria-hidden', 'true');
        link.appendChild(badge);
    }

    // Erzeugt das <img>-Icon für einen Link/ein Element inkl. gemeinsamem
    // Fehlerfall (Icon lädt nicht -> is-disabled-Klasse + Titel-Hinweis).
    // Ersetzt die zuvor vierfach fast identisch kopierte <img>-Erzeugung in
    // addNativeIconLink / addExternalAppLink / addCustomerboxIconLink / addBrandLink.
    function attachIconImage(target, icon, title, { pointerEventsNone = false, altFromTitle = false } = {}) {
        const image = document.createElement('img');
        image.src = icon;
        image.alt = altFromTitle ? (title || '') : '';
        if (pointerEventsNone) image.style.pointerEvents = 'none';
        image.addEventListener('error', () => {
            target.classList.add('is-disabled');
            target.title = `${title} - Icon konnte nicht geladen werden`;
        });
        target.appendChild(image);
        return image;
    }

    function addNativeIconLink(parent, {
        href,
        icon,
        title,
        className = 'dea-link',
        serviceIcon = null,
        deaAction = false,
        currentTab = false,
        cloneIndex = null
    }) {
        const link = document.createElement('a');
        if (serviceIcon) link.dataset.serviceIcon = serviceIcon;
        if (deaAction) link.dataset.deaAction = 'true';
        link.className = className;
        const isDeaIcon = deaAction === false && className === 'dea-brand' && icon === DEA_ICON;
        link.href = href || '#';
        if (!currentTab) {
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
        }
        link.title = title || '';
        link.setAttribute('aria-label', title || 'Link öffnen');

        if (isDeaIcon) {
            link.dataset.deaIcon = 'true';
            const iconHost = document.createElement('span');
            iconHost.className = 'dea-clone-state-wrap dea-dea-action-wrap';
            const deaUrl = normalizeUrl(link.href).replace(/\/+$/, '');
            const target = deaUrl ? `${deaUrl}/custom_deployment` : '';
            const teamboxId = getTeamboxIdFromToolUrl(deaUrl);
            iconHost.appendChild(link);
            addDeaUpgradeDropdown(iconHost, link, target, teamboxId);
            link.__deaIconHost = iconHost;
        }
        // Route a normal icon click explicitly so the browser cannot perform
        // a second native navigation after window.open(). The action link
        // (Create Clone) opts out and opens its one popup in onClick instead.
        link.addEventListener('click', event => {
            if (!isPlainLeftClick(event) || link.dataset.deaAction === 'true') return;
            if (link.dataset.deaDomainLoading === 'true') {
                event.preventDefault();
                event.stopPropagation();
                if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                }
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
            const target = normalizeUrl(link.href);
            if (!target || target === '#') return;
            if (currentTab) {
                window.location.assign(target);
                return;
            }
            const popup = window.open(target, '_blank', 'noopener,noreferrer');
            if (!popup) {
                log('DEA icon popup blocked', target);
            }
            const deleteMatch = /\/teamboxes\/(\d+)\/delete\/?(?:[?#].*)?$/i.exec(target);
            if (deleteMatch) startDeletePolling(deleteMatch[1]);
        }, true);

        const image = attachIconImage(link, icon, title);
        if (icon === ICONS.customerTeambox) {
            // Turn the black Teambox pictogram gray while preserving transparency.
            image.style.filter = 'brightness(0) saturate(100%) invert(63%)';
        }
        if (link.__deaIconHost) {
            parent.appendChild(link.__deaIconHost);
            delete link.__deaIconHost;
        } else {
            parent.appendChild(link);
        }
        return link;
    }

    function addIconLink(parent, options) {
        return addNativeIconLink(parent, { ...options, className: 'dea-link' });
    }

    function addExternalAppLink(parent, { href, icon, title }) {
        const link = document.createElement('a');
        link.className = 'dea-link';
        link.href = href || '#';
        link.title = title || '';
        link.setAttribute('aria-label', title || 'Verknüpftes Programm öffnen');

        // Keep the native protocol navigation intact (for example tableplus://)
        // so the operating system can launch the registered desktop app. Stop
        // only HubSpot/bar handlers; do not prevent the browser default action.
        link.addEventListener('click', event => {
            if (!isPlainLeftClick(event)) return;
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
        }, true);

        attachIconImage(link, icon, title, { pointerEventsNone: true });
        parent.appendChild(link);
        return link;
    }

    function isPlainLeftClick(event) {
        return event.button === 0 &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            !event.altKey;
    }

    function openCustomerboxUrl(url) {
        const target = normalizeUrl(url);
        if (!target || target === '#') return;
        const popup = window.open(target, '_blank', 'noopener,noreferrer');
        if (!popup) {
            // Never navigate the current HubSpot tab. If the browser blocks
            // the popup, leave the original tab unchanged.
            log('Customerbox icon popup blocked', target);
        }
    }

    function addCustomerboxIconLink(parent, { href, icon, title, className = 'dea-link', serviceIcon = null }) {
        const link = document.createElement('a');
        if (serviceIcon) link.dataset.serviceIcon = serviceIcon;
        link.className = `${className} dea-customerbox-link`;
        link.href = normalizeUrl(href || '#');
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = title || '';
        link.setAttribute('aria-label', title || 'Customerbox-Link öffnen');
        link.dataset.oldstackLink = 'true';

        // Oldstack links have their own interaction path. Only an unmodified
        // primary-button activation is routed explicitly; context-menu,
        // middle-click and modifier-click remain native browser actions.
        let openedOnPointerDown = false;
        const consume = event => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
        };
        link.addEventListener('pointerdown', event => {
            if (!isPlainLeftClick(event)) return;
            openedOnPointerDown = true;
            consume(event);
            openCustomerboxUrl(link.href);
        }, true);
        link.addEventListener('click', event => {
            if (!isPlainLeftClick(event)) return;
            consume(event);
            if (!openedOnPointerDown) openCustomerboxUrl(link.href);
            openedOnPointerDown = false;
        }, true);
        link.addEventListener('pointercancel', () => {
            openedOnPointerDown = false;
        }, true);
        link.addEventListener('mouseup', event => {
            if (event.button === 0) {
                // Keep the flag only until the click generated by this press.
                setTimeout(() => { openedOnPointerDown = false; }, 0);
            }
        }, true);

        attachIconImage(link, icon, title, { pointerEventsNone: true });
        parent.appendChild(link);
        return link;
    }

    function addActionLink(parent, { href = '#', icon, title, onClick }) {
        const link = addNativeIconLink(parent, {
            href,
            icon,
            title,
            className: 'dea-link',
            deaAction: true
        });
        link.addEventListener('click', event => {
            event.preventDefault();
            onClick(event, link);
        });
        return link;
    }

    function addBrandLink(parent, { href, icon, title, loading = false, customerboxLink = false }) {
        if (href) {
            return customerboxLink
                ? addCustomerboxIconLink(parent, {
                    href,
                    icon,
                    title,
                    className: 'dea-brand'
                })
                : addNativeIconLink(parent, {
                    href,
                    icon,
                    title,
                    className: 'dea-brand'
                });
        }

        const brand = document.createElement('span');
        brand.className = 'dea-brand';
        brand.title = title || '';
        brand.setAttribute('aria-label', title || 'Customerbox wird geladen');
        brand.dataset.loading = loading ? 'true' : 'false';
        attachIconImage(brand, icon, title, { pointerEventsNone: true, altFromTitle: true });
        parent.appendChild(brand);
        return brand;
    }

    function renderLoading() {
        const bar = createBar();
        bar.classList.add('is-loading');
        bar.replaceChildren();
        const label = document.createElement('span');
        label.className = 'dea-context';
        label.textContent = 'DEA wird geladen ...';
        bar.appendChild(label);
    }

    function isTicketNotOpenError(value) {
        const seen = new Set();
        function contains(candidate, depth = 0) {
            if (candidate == null || depth > 8) return false;
            if (typeof candidate === 'string' || typeof candidate === 'number') {
                return normalizeApiOwnerText(candidate).includes('this ticket is not an open ticket of yours') ||
                    normalizeApiOwnerText(candidate).includes('not an open ticket of yours');
            }
            if (typeof candidate !== 'object' || seen.has(candidate)) return false;
            seen.add(candidate);
            if (Array.isArray(candidate)) return candidate.some(item => contains(item, depth + 1));
            return Object.keys(candidate).some(key => contains(candidate[key], depth + 1));
        }
        return contains(value);
    }

    function normalizeDetectionText(value) {
        return String(value || '')
            .replace(/[\u2012\u2013\u2014\u2015]/g, '-')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function clearCustomerboxLoadingTimeout() {
        if (state.customerboxLoadingTimeout !== null) {
            clearTimeout(state.customerboxLoadingTimeout);
            state.customerboxLoadingTimeout = null;
        }
    }

    function renderCustomerboxSessionExpired(error = null) {
        if (state.renderMode !== 'customerbox') return;

        clearCustomerboxLoadingTimeout();
        const authRequired = Boolean(error && error.customerboxAuthRequired);
        const bar = createBar();
        bar.classList.remove('is-loading');
        bar.replaceChildren();

        const cluster = document.createElement('span');
        cluster.className = 'dea-cluster';

        const loginLink = document.createElement('a');
        loginLink.className = 'dea-login-link';
        loginLink.href = CUSTOMERBOX_LOADING_URL;
        loginLink.target = '_blank';
        loginLink.rel = 'noopener noreferrer';
        loginLink.title = authRequired
            ? 'Anmeldung in [C] erforderlich'
            : 'Customerbox-Session konnte nicht verifiziert werden';
        loginLink.setAttribute('aria-label', authRequired
            ? 'Anmeldung in [C] erforderlich. Bitte [C] öffnen.'
            : 'Customerbox-Session konnte nicht verifiziert werden. Bitte [C] öffnen oder erneut versuchen.');

        const image = document.createElement('img');
        image.src = CUSTOMERBOX_ICON;
        image.alt = '';
        loginLink.appendChild(image);

        const expiredLabel = document.createElement('span');
        expiredLabel.className = 'dea-session-expired';
        expiredLabel.textContent = authRequired
            ? 'Anmeldung in [C] erforderlich'
            : 'Session nicht verifiziert.';
        loginLink.appendChild(expiredLabel);

        const actionLabel = document.createElement('span');
        actionLabel.textContent = authRequired
            ? ''
            : ' Bitte [C] öffnen oder erneut versuchen.';
        loginLink.appendChild(actionLabel);

        loginLink.addEventListener('click', event => {
            if (!isPlainLeftClick(event)) return;
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
            // Open a real script-created blank window first. Navigating an
            // already-created window keeps a reliable Window reference, so the
            // browser allows this exact tab to be closed automatically.
            const popup = window.open('about:blank', '_blank');
            if (!popup) {
                log('Customerbox login popup blocked');
            } else {
                try {
                    popup.location.href = CUSTOMERBOX_LOADING_URL;
                } catch (error) {
                    log('Customerbox login tab could not be navigated', error);
                }

                // Ist eine Anmeldung erforderlich (Weiterleitung auf
                // auth.everii.io), muss der neue Tab offen bleiben, damit man
                // sich dort einloggen kann. Nur beim reinen Session-Refresh
                // ("Session nicht verifiziert") wird der Tab wieder geschlossen.
                if (!authRequired) {
                    const closePopup = () => {
                        try {
                            popup.close();
                        } catch (error) {
                            log('Customerbox tab could not be closed automatically', error);
                        }
                    };
                    window.setTimeout(closePopup, 500);
                }
            }
            setTimeout(() => refreshCustomerboxOverlay(), 1000);
        }, true);

        cluster.appendChild(loginLink);
        bar.appendChild(cluster);
    }

    function renderCustomerboxLoginTimeout() {
        if (state.renderMode !== 'customerbox') return;
        if (getCustomerboxTeambox(state.customerboxData)) return;

        const bar = createBar();
        bar.classList.add('is-loading');
        bar.replaceChildren();

        const cluster = document.createElement('span');
        cluster.className = 'dea-cluster';

        const loginLink = document.createElement('a');
        loginLink.className = 'dea-login-link';
        loginLink.href = CUSTOMERBOX_LOADING_URL;
        loginLink.target = '_blank';
        loginLink.rel = 'noopener noreferrer';
        loginLink.title = 'Bitte [C] öffnen um Session zu aktualisieren';
        loginLink.setAttribute('aria-label', 'Abgelaufene Session. Bitte [C] öffnen um Session zu aktualisieren.');

        const image = document.createElement('img');
        image.src = CUSTOMERBOX_ICON;
        image.alt = '';
        loginLink.appendChild(image);

        const expiredLabel = document.createElement('span');
        expiredLabel.className = 'dea-session-expired';
        expiredLabel.textContent = 'Abgelaufene Session.';
        loginLink.appendChild(expiredLabel);

        const actionLabel = document.createElement('span');
        actionLabel.textContent = ' Bitte [C] öffnen um Session zu aktualisieren.';
        loginLink.appendChild(actionLabel);

        // Route only an unmodified primary click explicitly. This keeps the
        // original HubSpot tab unchanged even when the host event layer
        // interferes with ordinary anchor navigation.
        loginLink.addEventListener('click', event => {
            if (!isPlainLeftClick(event)) return;
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
            const popup = window.open(CUSTOMERBOX_LOADING_URL, '_blank', 'noopener,noreferrer');
            if (!popup) {
                log('Customerbox login popup blocked');
            } else {
                // Let Customerbox initialize the session in the newly opened
                // tab, then close only that script-created tab again.
                setTimeout(() => {
                    try {
                        popup.close();
                    } catch (error) {
                        log('Customerbox tab could not be closed automatically', error);
                    }
                }, 1200);
            }
            // Refresh only the overlay after the Customerbox tab had a moment to
            // initialize the session; keep the original HubSpot page intact.
            setTimeout(() => refreshCustomerboxOverlay(), 1500);
        }, true);

        cluster.appendChild(loginLink);
        bar.appendChild(cluster);
    }

    function startCustomerboxLoadingTimeout(ticketId, requestNumber) {
        clearCustomerboxLoadingTimeout();
        const expectedTicketId = String(ticketId || state.ticketId || '').trim();
        const expectedRequestNumber = requestNumber == null ? state.requestNumber : requestNumber;
        state.customerboxLoadingTimeout = setTimeout(() => {
            state.customerboxLoadingTimeout = null;
            if (state.requestNumber !== expectedRequestNumber) return;
            if (String(state.ticketId || '').trim() !== expectedTicketId) return;
            if (state.renderMode !== 'customerbox') return;
            if (getCustomerboxTeambox(state.customerboxData)) return;

            // A tab can still be waiting for the shared Web Lock/localStorage
            // queue. Never call that an expired session while the request is
            // still active or queued; wait for its actual result instead.
            if (state.customerboxLoading) {
                startCustomerboxLoadingTimeout(expectedTicketId, expectedRequestNumber);
                return;
            }
            renderCustomerboxLoginTimeout();
        }, CUSTOMERBOX_LOADING_TIMEOUT_MS);
    }

    function loadCustomerboxData(ticketId) {
        const id = String(ticketId || state.ticketId || '').trim();
        const expectedRequestNumber = state.requestNumber;
        const cbStart = performance.now();
        if (!id || state.customerboxLoading) return;
        if (getCustomerboxTeambox(state.customerboxData)) return;

        // Reproduce the old overlay's fast path before making a network call.
        const cached = readCustomerboxCache(id);
        if (getCustomerboxTeambox(cached)) {
            state.customerboxData = cached;
            state.customerboxSessionError = null;
            if (state.renderMode === null) state.renderMode = 'customerbox';
            if (state.renderMode === 'customerbox') renderCustomerboxData(cached, id);
            markTiming('Customerbox-Cache-Treffer gerendert', cbStart);
            return;
        }

        state.customerboxLoading = true;
        customerboxRequest(id).then(data => {
            state.customerboxLoading = false;
            markTiming('Customerbox-Netzwerkantwort erhalten', cbStart);
            if (state.requestNumber !== expectedRequestNumber) return;
            if (String(state.ticketId || '').trim() !== id) return;
            if (!getCustomerboxTeambox(data)) return;
            clearCustomerboxLoadingTimeout();
            state.customerboxData = data;
            state.customerboxSessionError = null;
            // Customerbox is intentionally probed in parallel with DEA. If
            // it answers first, show the result immediately; DEA can still
            // correct the mode when its response arrives.
            if (state.renderMode === null) state.renderMode = 'customerbox';
            if (state.renderMode === 'customerbox') renderCustomerboxData(data, id);
            markTiming('Customerbox-Bar gerendert', cbStart);
        }).catch(error => {
            state.customerboxLoading = false;
            markTiming('Customerbox-Request fehlgeschlagen/beendet', cbStart);
            if (state.requestNumber !== expectedRequestNumber) return;
            if (String(state.ticketId || '').trim() !== id) return;
            if (isCustomerboxSessionExpiredError(error)) {
                state.customerboxData = null;
                state.customerboxSessionError = error;
                // Display a confirmed 401 immediately. If DEA later proves
                // that this is not an Oldstack ticket, its response replaces
                // this provisional view with the normal DEA bar.
                if (state.renderMode === null) state.renderMode = 'customerbox';
                if (state.renderMode === 'customerbox') renderCustomerboxSessionExpired(error);
                return;
            }
            log('Customerbox rt_data unavailable', error);
        });
    }





    const OLD_STACK_DETECTION_WINDOW_MS = 30000;




    function renderCustomerboxLoading() {
        const bar = createBar();
        bar.classList.add('is-loading');
        bar.replaceChildren();

        // Keep the context already known from DEA while the legacy record is
        // loading. Only the Customerbox identity/link remains pending.
        const deaData = state.data || {};
        const deaTeambox = Array.isArray(deaData.teamboxes) ? deaData.teamboxes.find(Boolean) : null;
        const cluster = document.createElement('span');
        cluster.className = 'dea-cluster';

        const context = document.createElement('span');
        context.className = 'dea-context';
        const customer = getCustomerName(deaTeambox);
        const agent = getSupportAgent(deaData, deaTeambox);
        if (customer) {
            const topRow = document.createElement('span');
            topRow.className = 'dea-context-row dea-context-row-top';
            const customerText = document.createElement('strong');
            customerText.textContent = customer;
            topRow.appendChild(customerText);
            context.appendChild(topRow);
        }
        if (agent) {
            const bottomRow = document.createElement('span');
            bottomRow.className = 'dea-context-row dea-context-row-bottom';
            const agentText = document.createElement('span');
            const agentUnknown = agent === '---' || !String(agent || '').trim();
            agentText.className = 'support-agent';
            agentText.textContent = agentUnknown ? 'Unbekannt' : agent;
            bottomRow.appendChild(agentText);
            context.appendChild(bottomRow);
        }

        addBrandLink(cluster, {
            href: CUSTOMERBOX_LOADING_URL,
            icon: CUSTOMERBOX_LOADING_ICON,
            title: 'Customerbox öffnen (Daten werden geladen)',
            loading: true,
            // Use the same explicit navigation router as the corrected
            // Oldstack links. This prevents the HubSpot/bar event layer from
            // swallowing a normal left click while the data is loading.
            customerboxLink: true
        });
        if (customer || agent) cluster.appendChild(context);

        const repositoryUrl = getRepositoryUrl(deaTeambox, deaData);
        if (repositoryUrl) {
            const links = document.createElement('span');
            links.className = 'dea-links';
            addIconLink(links, {
                href: repositoryUrl,
                icon: ICONS.github,
                title: 'GitHub Repository',
                serviceIcon: 'github'
            });
            cluster.appendChild(links);
        }
        bar.appendChild(cluster);
        startCustomerboxLoadingTimeout(state.ticketId, state.requestNumber);
    }


    function isDeploymentToolSignInError(value) {
        const expected = 'sign in to the teambox deployment tool first';
        const seen = new Set();

        function normalize(valueToCheck) {
            return String(valueToCheck || '')
                .replace(/<[^>]*>/g, ' ')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
        }

        function contains(candidate, depth = 0) {
            if (candidate == null || depth > 8) return false;
            if (typeof candidate === 'string' || typeof candidate === 'number') {
                return normalize(candidate).includes(expected);
            }
            if (typeof candidate !== 'object' || seen.has(candidate)) return false;
            seen.add(candidate);
            if (normalize(candidate.message).includes(expected)) return true;
            if (normalize(candidate.responseText).includes(expected)) return true;
            if (Array.isArray(candidate)) {
                return candidate.some(item => contains(item, depth + 1));
            }
            return Object.keys(candidate).some(key => contains(candidate[key], depth + 1));
        }

        return contains(value);
    }

    function isDeploymentToolUnavailableError(value) {
        const expected = 'dea-tool nicht erreichbar';
        const seen = new Set();

        function normalize(valueToCheck) {
            return String(valueToCheck || '')
                .replace(/<[^>]*>/g, ' ')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
        }

        function contains(candidate, depth = 0) {
            if (candidate == null || depth > 8) return false;
            if (typeof candidate === 'string' || typeof candidate === 'number') {
                return normalize(candidate).includes(expected);
            }
            if (typeof candidate !== 'object' || seen.has(candidate)) return false;
            seen.add(candidate);
            if (normalize(candidate.message).includes(expected)) return true;
            if (normalize(candidate.responseText).includes(expected)) return true;
            if (Array.isArray(candidate)) {
                return candidate.some(item => contains(item, depth + 1));
            }
            return Object.keys(candidate).some(key => contains(candidate[key], depth + 1));
        }

        return contains(value);
    }

    function renderError(error) {
        const syncError = isHubSpotSyncWorkaroundError(error) && Boolean(state.ticketId);
        const deploymentToolSignInError = isDeploymentToolSignInError(error);
        const deploymentToolUnavailableError = isDeploymentToolUnavailableError(error);
        const bar = createBar();
        bar.classList.remove('is-loading');
        bar.replaceChildren();
        bar.dataset.syncErrorAction = syncError ? 'true' : 'false';
        bar.dataset.deploymentToolSignInAction = deploymentToolSignInError ? 'true' : 'false';
        bar.dataset.deploymentToolUnavailableAction = deploymentToolUnavailableError ? 'true' : 'false';

        const label = document.createElement('span');
        label.className = 'dea-error';

        const icon = document.createElement('img');
        icon.className = 'dea-error-icon';
        icon.src = DEA_ICON;
        icon.alt = 'DEA';
        // Keep the button as the pointer target; the image must not override
        // the button cursor with the global bar cursor rule.
        icon.style.pointerEvents = 'none';
        icon.style.cursor = 'pointer';

        if (syncError || deploymentToolSignInError || deploymentToolUnavailableError) {
            const iconButton = document.createElement('button');
            iconButton.type = 'button';
            iconButton.className = 'dea-error-icon-button';
            iconButton.style.cursor = 'pointer';
            const actionLabel = syncError
                ? 'OldStack-Ansicht laden'
                : 'Teambox Deployment Tool öffnen';
            iconButton.title = actionLabel;
            iconButton.setAttribute('aria-label', actionLabel);

            const activateErrorAction = event => {
                // HubSpot can stop a bubbling click on elements inside its own
                // overlay. Handle the primary pointer activation in capture
                // phase so the action is already complete before HubSpot sees
                // the event. The click fallback also supports keyboard users.
                const keyboardActivation = event && event.type === 'keydown' &&
                    (event.key === 'Enter' || event.key === ' ' || event.code === 'Space');
                const pointerActivation = event && event.type !== 'keydown' &&
                    isPlainLeftClick(event);
                if (!keyboardActivation && !pointerActivation) return;

                event.preventDefault();
                event.stopPropagation();
                if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                }

                if (iconButton.dataset.errorActionActivated === 'true') return;
                iconButton.dataset.errorActionActivated = 'true';

                if (syncError) {
                    activateOldStackView();
                    return;
                }

                const popup = window.open(TOOL, '_blank', 'noopener,noreferrer');
                if (!popup) log('Teambox Deployment Tool popup blocked');
            };

            iconButton.addEventListener('pointerdown', activateErrorAction, true);
            iconButton.addEventListener('mousedown', activateErrorAction, true);
            iconButton.addEventListener('click', activateErrorAction, true);
            iconButton.addEventListener('keydown', activateErrorAction, true);
            iconButton.appendChild(icon);
            label.appendChild(iconButton);
        } else {
            label.appendChild(icon);
        }

        const message = document.createElement('span');
        message.textContent = error.message || 'Abfrage fehlgeschlagen';
        label.appendChild(message);
        bar.appendChild(label);

        if (isTicketNotOpenError(error)) {
            const reloadButton = document.createElement('button');
            reloadButton.type = 'button';
            reloadButton.className = 'dea-reload-button';
            reloadButton.title = 'Neu laden';
            reloadButton.setAttribute('aria-label', 'Neu laden');
            reloadButton.textContent = ICONS.reload;
            reloadButton.style.width = '24px';
            reloadButton.style.height = '24px';
            reloadButton.style.padding = '0';
            reloadButton.style.marginLeft = '-4px';
            reloadButton.style.color = '#8c959f';
            reloadButton.style.background = 'transparent';
            reloadButton.style.border = '0';
            reloadButton.style.font = '20px/24px Arial, Helvetica, sans-serif';
            reloadButton.style.textAlign = 'center';
            reloadButton.style.cursor = 'pointer';
            reloadButton.style.opacity = '0.82';
            reloadButton.style.display = 'inline-flex';
            reloadButton.style.alignItems = 'center';
            reloadButton.style.justifyContent = 'center';
            reloadButton.addEventListener('click', event => {
                event.stopPropagation();
                // Refresh only the overlay data; keep the HubSpot page intact.
                reloadOverlay();
            });
            bar.appendChild(reloadButton);
        }
    }

    function getLegacyDisplayValues(data, teambox) {
        const source = data || {};
        const sourceTeambox = source.teambox || {};
        const profile = source.profile || {};
        const server = source.server || {};
        const customer = source.customer || {};

        const token = String(
            sourceTeambox.token || teambox && (teambox.token || teambox.name) || ''
        ).trim();
        const release = String(
            profile.tbx_rel_target || profile.release || sourceTeambox.tbx_rel_target || ''
        ).trim();
        const serviceTypes = {
            0: '?',
            1: 'SaaS',
            2: 'OnP',
            3: 'Premium'
        };
        const serviceTypeValue = sourceTeambox.service_type ?? sourceTeambox.serviceType;
        const serviceType = serviceTypes[serviceTypeValue] || String(
            sourceTeambox.service_type_name || sourceTeambox.serviceTypeName || ''
        ).trim();
        const serverName = String(server.name || server.hostname || sourceTeambox.server_name || '').trim();
        const accountManager = String(
            customer.acc_manager || customer.account_manager || customer.accountManager || ''
        ).trim();
        const country = String(
            customer.country_code || customer.countryCode || ''
        ).trim();

        if (!token || !release || !serviceType || !serverName || !accountManager || !country) {
            return null;
        }

        return {
            topLine: `${token}: ${release}`,
            bottomLine: `(${serviceType}:${serverName}) ${accountManager}:${country}`
        };
    }

    function normalizeUrl(value) {
        try {
            return new URL(String(value || ''), location.href).href;
        } catch (error) {
            return String(value || '');
        }
    }

    function getLockedDeaUrl(teambox, fallbackUrl) {
        const ticketId = state.ticketId;
        const key = String(ticketId || '');
        if (!key) return fallbackUrl;
        const existing = state.lockedDeaUrls.get(key);
        if (existing) return existing;
        const url = normalizeUrl(fallbackUrl);
        if (/^https:\/\/production\.teambox-deployment-tool\.service\.de1\.everii\/teamboxes\/\d+(?:[/?#].*)?$/i.test(url)) {
            state.lockedDeaUrls.set(key, url);
        }
        return url;
    }

    function renderTeambox(bar, data, teambox) {
        const customer = getCustomerName(teambox);
        const agent = getSupportAgent(data, teambox);
        const path = getTeamboxPath(teambox);
        const isCustomerbox = isCustomerboxMode() && data === state.customerboxData;
        const customerboxSource = state.customerboxData || data;
        const customerboxTeambox = getCustomerboxTeambox(customerboxSource);
        const customerboxUrl = isCustomerbox && customerboxTeambox && customerboxTeambox.id
            ? getCustomerboxLink(customerboxSource)
            : null;
        const isCustomerboxLoading = isCustomerbox && !customerboxUrl;
        const calculatedDeaUrl = getTeamboxToolUrl(teambox) || joinUrl(TOOL, path);
        const deaUrl = isCustomerbox
            ? calculatedDeaUrl
            : getLockedDeaUrl(teambox, calculatedDeaUrl);
        const ticketId = state.ticketId;

        const cluster = document.createElement('span');
        cluster.className = 'dea-cluster';

        addBrandLink(cluster, {
            href: customerboxUrl || (!isCustomerbox ? deaUrl : null),
            icon: isCustomerboxLoading
                ? CUSTOMERBOX_LOADING_ICON
                : (isCustomerbox ? CUSTOMERBOX_ICON : DEA_ICON),
            title: isCustomerboxLoading
                ? 'Customerbox-Link wird geladen'
                : (isCustomerbox ? 'Customerbox Teambox öffnen' : `DEA Teambox ${customer}`),
            loading: isCustomerboxLoading,
            customerboxLink: isCustomerbox
        });

        const context = document.createElement('span');
        context.className = 'dea-context';
        const legacyDisplay = isCustomerbox
            ? getLegacyDisplayValues(customerboxSource, teambox)
            : null;

        if (legacyDisplay) {
            const topRow = document.createElement('span');
            topRow.className = 'dea-context-row dea-context-row-top legacy-context-row';
            const topText = document.createElement('span');
            topText.className = 'support-agent';
            topText.textContent = legacyDisplay.topLine;
            topRow.appendChild(topText);
            context.appendChild(topRow);

            const bottomRow = document.createElement('span');
            bottomRow.className = 'dea-context-row dea-context-row-bottom legacy-context-row';
            const bottomText = document.createElement('span');
            bottomText.className = 'support-agent';
            bottomText.textContent = legacyDisplay.bottomLine;
            bottomRow.appendChild(bottomText);
            context.appendChild(bottomRow);
        } else {
            // DEA format: DEA-Icon <customer code> <release> (<agent initials>).
            // Example: DEA vanderlicht 3.4.2 (MIBA)
            const topRow = document.createElement('span');
            topRow.className = 'dea-context-row dea-context-row-top';

            const customerText = document.createElement('strong');
            customerText.textContent = customer;
            topRow.appendChild(customerText);
            const ownerStatus = createTicketOwnerStatus(data, teambox);
            if (ownerStatus) topRow.appendChild(ownerStatus);
            context.appendChild(topRow);

            const bottomRow = document.createElement('span');
            bottomRow.className = 'dea-context-row dea-context-row-bottom';

            const release = getReleaseNumber(teambox);
            const releaseText = document.createElement('span');
            releaseText.className = 'support-agent';
            releaseText.textContent = release || 'Unbekannt';
            bottomRow.appendChild(releaseText);

            const agentText = document.createElement('span');
            const agentUnknown = agent === '---' || !String(agent || '').trim();
            const agentLabel = agentUnknown ? 'Unbekannt' : (getAgentShortName(agent) || agent);
            // Unknown customer responsibility uses the same neutral color as
            // the release number instead of the red fallback styling.
            agentText.className = 'support-agent';
            agentText.textContent = `(${agentLabel})`;
            bottomRow.appendChild(agentText);
            context.appendChild(bottomRow);
        }
        cluster.appendChild(context);

        const links = document.createElement('span');
        links.className = 'dea-links';
        const addModeIconLink = isCustomerbox ? addCustomerboxIconLink : addIconLink;

        const clones = Array.isArray(teambox.clones) ? [...teambox.clones] : [];

        if (isCustomerbox) {
            const liveTeamboxUrl = getCustomerboxLiveUrl(customerboxSource, teambox);
            const supportboxUrl = getCustomerboxSupportUrl(customerboxSource, teambox, state.ticketId);
            const customerboxLinkInstallUrl = getCustomerboxInstallUrl(customerboxSource, teambox, state.ticketId) ||
                getCustomerboxInstallUrl(data, teambox, state.ticketId);

            if (liveTeamboxUrl) {
                addModeIconLink(links, {
                    href: liveTeamboxUrl,
                    icon: ICONS.openClone,
                    title: 'Live-Teambox öffnen'
                });
            }

            if (supportboxUrl) {
                // A clone already exists on the old stack: replace Create Clone
                // with the actual Supportbox link.
                addModeIconLink(links, {
                    href: supportboxUrl,
                    icon: ICONS.supportbox,
                    title: 'Supportbox öffnen'
                });
            } else if (customerboxLinkInstallUrl) {
                addModeIconLink(links, {
                    href: customerboxLinkInstallUrl,
                    icon: ICONS.createClone,
                    title: 'Create Clone im alten Stack'
                });
            }

            const featureboxUrl = getCustomerboxFeatureboxLink(customerboxSource);
            if (featureboxUrl) {
                addModeIconLink(links, {
                    href: featureboxUrl,
                    icon: ICONS.featurebox,
                    title: 'Featurebox öffnen'
                });
            }
        } else {
            // The green T icon and the Teambox icon use the same deployment
            // ID. Sort by that exact ID first, because it is the reliable
            // creation-order key for the DEA Teambox records. Do not sort by
            // clone.id/deployment_id independently: those fields can represent
            // another object and can produce the wrong Roman-number order.
            const cloneEntries = clones.map((clone, originalIndex) => {
                const cloneUrl = getCloneUrl(clone);
                const deploymentId = getCloneDeploymentId(clone, cloneUrl);
                const numericDeploymentId = Number(deploymentId);
                return {
                    clone,
                    originalIndex,
                    deploymentId,
                    numericDeploymentId: Number.isFinite(numericDeploymentId) ? numericDeploymentId : null
                };
            });

            const allHaveDeploymentIds = cloneEntries.length > 0 &&
                cloneEntries.every(entry => entry.numericDeploymentId !== null);

            const getCloneTimestamp = clone => {
                if (!clone) return null;
                const dateFields = [
                    clone.created_at,
                    clone.createdAt,
                    clone.created,
                    clone.created_on,
                    clone.createdOn,
                    clone.timestamp,
                    clone.date,
                    clone.started_at,
                    clone.startedAt
                ];
                for (const value of dateFields) {
                    if (value === null || value === undefined || value === '') continue;
                    const numeric = typeof value === 'number' ? value : Number(value);
                    if (Number.isFinite(numeric) && numeric > 0) {
                        return numeric < 100000000000 ? numeric * 1000 : numeric;
                    }
                    const parsed = Date.parse(String(value));
                    if (Number.isFinite(parsed)) return parsed;
                }
                return null;
            };

            const allHaveTimestamps = cloneEntries.length > 0 &&
                cloneEntries.every(entry => getCloneTimestamp(entry.clone) !== null);

            cloneEntries.sort((left, right) => {
                if (allHaveDeploymentIds) {
                    return left.numericDeploymentId - right.numericDeploymentId ||
                        left.originalIndex - right.originalIndex;
                }
                if (allHaveTimestamps) {
                    return getCloneTimestamp(left.clone) - getCloneTimestamp(right.clone) ||
                        left.originalIndex - right.originalIndex;
                }
                // Last-resort stable order only when the API provides neither
                // a usable deployment ID nor a complete timestamp set.
                return left.originalIndex - right.originalIndex;
            });

            clones.splice(0, clones.length, ...cloneEntries.map(entry => entry.clone));

            // Each clone is immediately followed by the terminal for that clone.
            clones.forEach((clone, index) => {
                const cloneUrl = getCloneUrl(clone);
                const cloneId = getCloneDeploymentId(clone, cloneUrl);
                // The Teambox link is part of the clone dropdown in both
                // action modes. Keep the green T as the only visible trigger.
                if (cloneUrl) {
                    const stateWrapper = addCloneStateIcon(links, clone, index);
                    const tableplusUrl = getCloneTablePlusUrl(clone);

                    if (isCloneRunning(clone)) {
                        if (CLONE_ACTION_MODE === 'dropdown') {
                            addCloneDropdown(stateWrapper, clone, index, cloneId);
                        } else {
                            addPermanentCloneDeleteMenu(stateWrapper, clone, index, cloneId);
                            if (tableplusUrl) {
                                addExternalAppLink(links, {
                                    href: tableplusUrl,
                                    icon: ICONS.tableplus,
                                    title: `TablePlus ${index + 1}: ${getCloneName(clone)}`
                                });

                                // Terminal is only meaningful when the corresponding
                                // database/TablePlus link is available.
                                const terminalUrl = getCloneTerminalUrl(clone, cloneId);
                                if (terminalUrl) {
                                    addModeIconLink(links, {
                                        href: terminalUrl,
                                        icon: ICONS.terminal,
                                        title: `Terminal ${index + 1}: ${getCloneName(clone)}`
                                    });
                                }
                            }
                        }
                    } else {
                        addInactiveCloneProgressDropdown(stateWrapper, clone, index, cloneId);
                    }
                }
            });

            // If there are no clones, only Create Clone remains. No T or terminal icon
            // is created in that case.
            addActionLink(links, {
                href: '#',
                icon: ICONS.createClone,
                title: clones.length ? 'Create another Clone' : 'Create Clone',
                onClick: event => createClone(event, teambox, links)
            });
        }

        const youtrack = getYouTrackConfig(data);
        const youtrackUrl = isCustomerbox
            ? getLegacyYouTrackUrl(customerboxSource, ticketId)
            : getYouTrackUrl(youtrack, state.youtrackIssues.get(ticketId));
        if (youtrackUrl) {
            addModeIconLink(links, {
                href: youtrackUrl,
                icon: ICONS.youtrack,
                title: 'YouTrack Issue',
                serviceIcon: 'youtrack'
            });
        }

        const repositoryUrl = getRepositoryUrl(teambox, data);
        if (repositoryUrl) {
            addModeIconLink(links, {
                href: repositoryUrl,
                icon: ICONS.github,
                title: `GitHub Repository: ${customer}`,
                serviceIcon: 'github'
            });
        }

        cluster.appendChild(links);
        bar.appendChild(cluster);
    }

    function getLegacyYouTrackUrl(data, fallbackTicketId) {
        const source = data || {};
        const sourceTeambox = source.teambox || {};
        const profile = source.profile || {};
        const ticket = source.ticket || {};

        const ticketId = String(ticket.id || fallbackTicketId || '').trim();
        const release = String(profile.tbx_rel_target || profile.release || '').trim();
        const customer = String(sourceTeambox.token || sourceTeambox.customer || '').trim();
        if (!ticketId || !release || !customer) return null;

        const description =
            `%7C%20%20%7C%20%20%7C%0A` +
            `%7C%20---%20%7C%20---%20%7C%0A` +
            `%7C%20Support%20Ticket:%20%7C%20${encodeURIComponent(ticketId)}%20%7C%0A` +
            `%7C%20Reproducible%20in:%20%7C%20%20%7C%0A` +
            `%7C%20Release:%20%7C%20${encodeURIComponent(release)}%20%7C%0A` +
            `%0A%23%23%20Reproduction%20Steps%0A%0A*%20` +
            `%0A%0A%23%23%20Results%0A%0A*%20` +
            `%0A%0A%23%23%20Expected%20Result%0A%0A*%20`;

        return `https://youtrack.everii.io/newIssue?project=TEAMBOX&description=${description}` +
            `&c=Type%20Bug&c=Clients+${encodeURIComponent(customer)}` +
            `&c=HubspotTicketId+${encodeURIComponent(ticketId)}`;
    }

    function getYouTrackConfig(data) {
        return data && data.youtrack;
    }

    function getYouTrackUrl(config, issues) {
        if (!config) return null;
        const list = Array.isArray(issues) ? issues : [];
        if (list.length === 1 && list[0].idReadable && config.base_url) {
            return `${config.base_url.replace(/\/$/, '')}/issue/${encodeURIComponent(list[0].idReadable)}`;
        }
        if (list.length > 1 && config.issues_url) return config.issues_url;
        if (list.length === 0 && config.create_url) return config.create_url;
        return config.issues_url || config.create_url || null;
    }

    // --- Delete-Polling: wartet, bis die Teambox nicht mehr existiert ---------
    const deletePollers = new Map();
    // Operation, die die Löschung der jeweiligen Teambox ausführt (id -> URL).
    const deleteOperationUrls = new Map();

    function getDeleteTargetUrl(deploymentId) {
        return deleteOperationUrls.get(String(deploymentId)) ||
            `${TOOL}/teamboxes/${encodeURIComponent(deploymentId)}`;
    }

    // Sucht in der Antwort die Operation der Löschung: bevorzugt den Toast
    // "Deletion of Teambox ... scheduled as Operation #N", sonst die neueste
    // Operation, die auf der Teambox-Seite verlinkt ist.
    function rememberDeleteOperation(deploymentId, html) {
        const id = String(deploymentId);
        let url = null;
        const toast = /Deletion of Teambox[\s\S]{0,300}?scheduled as[\s\S]{0,200}?href="([^"]*\/operations\/\d+)[^"]*"/i.exec(html);
        if (toast) {
            url = toast[1];
            deleteOperationUrls.set(`${id}:toast`, '1');
        } else if (!deleteOperationUrls.has(`${id}:toast`)) {
            let best = -1;
            const re = /href="([^"]*\/operations\/(\d+))(?:[/?#"][^"]*)?"/gi;
            let m;
            while ((m = re.exec(html))) {
                if (Number(m[2]) > best) { best = Number(m[2]); url = m[1]; }
            }
        }
        if (!url) return;
        try {
            const href = new URL(url, TOOL).href;
            deleteOperationUrls.set(id, href);
            document.querySelectorAll(`a[data-delete-id="${id}"]`).forEach(link => { link.href = href; });
        } catch (error) { /* ignorieren */ }
    }

    const DELETE_POLL_INTERVAL_MS = 1000;
    const DELETE_POLL_TIMEOUT_MS = 15 * 60 * 1000;

    function checkTeamboxGone(deploymentId) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${TOOL}/teamboxes/${encodeURIComponent(deploymentId)}`,
                withCredentials: true,
                anonymous: false,
                timeout: 8000,
                onload: res => {
                    const text = String(res.responseText || '');
                    rememberDeleteOperation(deploymentId, text);
                    // Enthält die Antwort noch die Teambox-Detailseite, existiert sie
                    // sicher noch - auch wenn ein alter Flash-Hinweis ("does not
                    // exist") aus der Session mitgeliefert wird.
                    const stillThere = text.indexOf(`teambox_${deploymentId}`) !== -1 ||
                        /<dt[^>]*>\s*State:/i.test(text);
                    resolve(!stillThere &&
                        (res.status === 404 || /The requested resource does not exist/i.test(text)));
                },
                onerror: () => resolve(false),
                ontimeout: () => resolve(false)
            });
        });
    }

    function startDeletePolling(deploymentId) {
        const id = String(deploymentId || '');
        if (!id || deletePollers.has(id)) return;
        const startedAt = Date.now();
        let busy = false;
        const timer = window.setInterval(async () => {
            if (busy) return;
            if (Date.now() - startedAt > DELETE_POLL_TIMEOUT_MS) {
                window.clearInterval(timer);
                deletePollers.delete(id);
                return;
            }
            busy = true;
            try {
                // Mindestens ein Animationsdurchlauf (3 s) bleibt das rote T sichtbar.
                if (Date.now() - startedAt >= 3000 && await checkTeamboxGone(id)) {
                    window.clearInterval(timer);
                    deletePollers.delete(id);
                    // Nur die Leiste neu laden, nicht den Tab.
                    lastOverlayReloadAt = 0;
                    reloadOverlay();
                }
            } finally {
                busy = false;
            }
        }, DELETE_POLL_INTERVAL_MS);
        deletePollers.set(id, timer);
        // Leiste ohne Neuladen aus den vorhandenen Daten neu zeichnen, damit das
        // T sofort die Lösch-Animation zeigt.
        try {
            if (state.data && canRenderDea()) renderData(state.data);
        } catch (error) {
            log('Could not redraw bar for delete animation', error);
        }
    }

    // --- Clone-Status-Polling (ersetzt den Progress-Tab) -------------------
    const pendingCloneIds = new Set();
    const cloneStatePollers = new Map();
    const CLONE_POLL_INTERVAL_MS = 1000;
    const CLONE_POLL_TIMEOUT_MS = 15 * 60 * 1000;

    function fetchTeamboxPageState(deploymentId) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${TOOL}/teamboxes/${encodeURIComponent(deploymentId)}`,
                withCredentials: true,
                anonymous: false,
                timeout: 8000,
                onload: res => {
                    try {
                        const doc = new DOMParser().parseFromString(String(res.responseText || ''), 'text/html');
                        const dt = Array.from(doc.querySelectorAll('dt'))
                            .find(el => /^\s*State:?\s*$/i.test(el.textContent || ''));
                        const dd = dt && dt.nextElementSibling;
                        resolve(dd ? dd.textContent.replace(/\s+/g, ' ').trim() : null);
                    } catch (error) {
                        resolve(null);
                    }
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null)
            });
        });
    }

    function stopCloneStatePolling(deploymentId) {
        const poller = cloneStatePollers.get(String(deploymentId));
        if (poller) window.clearInterval(poller.timer);
        cloneStatePollers.delete(String(deploymentId));
        pendingCloneIds.delete(String(deploymentId));
    }

    function startCloneStatePolling(deploymentId) {
        const id = String(deploymentId);
        pendingCloneIds.add(id);
        if (cloneStatePollers.has(id)) return;
        const startedAt = Date.now();
        let busy = false;
        const timer = window.setInterval(async () => {
            if (busy) return;
            if (Date.now() - startedAt > CLONE_POLL_TIMEOUT_MS || !pendingCloneIds.has(id)) {
                stopCloneStatePolling(id);
                return;
            }
            busy = true;
            try {
                const pageState = await fetchTeamboxPageState(id);
                if (pageState && /running/i.test(pageState)) {
                    // Polling sofort beenden (sonst lädt die Leiste endlos neu, falls
                    // die DEA-API den Clone nicht unter derselben ID als "running"
                    // meldet). Danach nur Leiste neu laden - einmal sofort und
                    // einmal verzögert, falls die API dem Tool kurz hinterherhinkt.
                    stopCloneStatePolling(id);
                    lastOverlayReloadAt = 0;
                    reloadOverlay();
                    window.setTimeout(() => {
                        lastOverlayReloadAt = 0;
                        reloadOverlay();
                    }, 2500);
                }
            } finally {
                busy = false;
            }
        }, CLONE_POLL_INTERVAL_MS);
        cloneStatePollers.set(id, { timer });
        const poller = cloneStatePollers.get(id);
        poller.timer = timer;
    }

    async function createClone(event, teambox, links) {
        if (!state.ticketId || !teambox || !teambox.id) return;
        const source = event.currentTarget;
        source.classList.add('is-disabled');
        try {
            const response = await apiRequest('POST', 'hubspot/clone', state.ticketId, {
                teambox_id: teambox.id
            });
            const setupPath = response.clone && (response.clone.setup_path || response.clone.path || response.clone.url);
            if (!setupPath) throw new Error('DEA lieferte keinen Clone-Link zurück');
            const createdCloneDeploymentId = getCloneCreationDeploymentId(response, setupPath);
            // Kein neuer Tab mehr: Der Status wird im Hintergrund jede Sekunde geprüft.
            if (createdCloneDeploymentId) startCloneStatePolling(createdCloneDeploymentId);
            const refreshed = await apiRequest('GET', 'hubspot/ticket', state.ticketId);
            attachCreatedCloneDeploymentId(
                refreshed,
                response.clone,
                setupPath,
                createdCloneDeploymentId
            );
            state.data = refreshed;
            const refreshedApiState = getApiOwnershipState(refreshed);
            state.ticketOwnerAccess = refreshedApiState === null ? true : refreshedApiState;
            rememberRevision(refreshed, state.ticketId);
            if (canRenderDea()) {
                renderData(refreshed);
            } else {
                renderCustomerboxMode();
            }
        } catch (error) {
            if (isTicketNotOpenError(error)) state.ticketOwnerAccess = false;
            renderError(error);
        } finally {
            source.classList.remove('is-disabled');
        }
    }

    function getCustomerboxTeambox(data) {
        return data && data.teambox && typeof data.teambox === 'object' ? data.teambox : null;
    }

    function getCustomerboxCustomerName(data) {
        const teambox = getCustomerboxTeambox(data);
        return String(
            (teambox && (teambox.token || teambox.customer || teambox.name)) ||
            (data && data.customer && (data.customer.token || data.customer.name)) ||
            'Teambox'
        );
    }

    function getCustomerboxLink(data) {
        const teambox = getCustomerboxTeambox(data);
        const id = teambox && teambox.id;
        return id
            ? `${CUSTOMERBOX_TEAMBOXES_URL}${encodeURIComponent(id)}`
            : CUSTOMERBOX_TEAMBOXES_URL;
    }

    function getCustomerboxFeatureboxLink(data) {
        const teambox = getCustomerboxTeambox(data);
        const id = teambox && teambox.id;
        return id
            ? `${CUSTOMERBOX_TEAMBOXES_URL.replace(/teamboxes\/index\/$/, 'featurebox/index/')}${encodeURIComponent(id)}`
            : null;
    }

    // ---- Stack selection -------------------------------------------------
    // The current Original Overlay exposes the stack as DEA response data:
    // a teambox with the exact badge label "Old stack" belongs to Customerbox.
    // A parallel Customerbox probe may render a provisional result earlier;
    // this DEA badge remains the authoritative final mode decision.
    function getBadgeText(badge) {
        if (badge == null) return '';
        if (typeof badge === 'string' || typeof badge === 'number') return String(badge);
        if (typeof badge !== 'object') return '';
        return String(badge.label || badge.name || badge.text || badge.title || badge.value || '');
    }

    function hasCustomerboxBadge(teambox) {
        const badges = Array.isArray(teambox && teambox.badges) ? teambox.badges : [];
        return badges.some(badge => getBadgeText(badge).trim().toLowerCase() === 'old stack');
    }

    function hasCustomerboxTeambox(data) {
        const teamboxes = Array.isArray(data && data.teamboxes) ? data.teamboxes : [];
        return teamboxes.some(hasCustomerboxBadge);
    }

    // ---- STOPPED-STATE-LOGIK START ---------------------------------------
    // Kunden, die bereits auf der neuen Infrastruktur angelegt sind, aber
    // noch real auf dem Old Stack laufen, haben in der DEA-API weder Badge
    // noch State-Feld. Der State ("Stopped") steht nur auf der Detailseite
    // der Teambox. Sind alle Teamboxen des Tickets gestoppt, wird daher
    // die Old-Stack-/Customerbox-Ansicht geladen.
    function fetchTeamboxState(teamboxId) {
        return new Promise(resolve => {
            if (teamboxId == null || typeof GM_xmlhttpRequest !== 'function') {
                resolve(null);
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${TOOL}/teamboxes/${encodeURIComponent(teamboxId)}`,
                timeout: 8000,
                onload(response) {
                    try {
                        const doc = new DOMParser().parseFromString(response.responseText || '', 'text/html');
                        const dt = Array.from(doc.querySelectorAll('dt'))
                            .find(el => /^state\b/i.test(el.textContent.trim()));
                        const dd = dt && dt.nextElementSibling;
                        const value = dd ? dd.textContent.trim().toLowerCase() : '';
                        resolve(value || null);
                    } catch (error) {
                        resolve(null);
                    }
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null),
                onabort: () => resolve(null)
            });
        });
    }

    async function areAllTeamboxesStopped(data) {
        const teamboxes = Array.isArray(data && data.teamboxes) ? data.teamboxes : [];
        if (teamboxes.length === 0) return false;
        const states = await Promise.all(teamboxes.map(tb => fetchTeamboxState(tb && tb.id)));
        // Bei unbekanntem State (Fehler, Login-Seite, ...) bleibt es bei DEA.
        return states.every(value => value === 'stopped');
    }

    async function resolveRenderMode(data) {
        if (hasCustomerboxTeambox(data)) return 'customerbox';
        return (await areAllTeamboxesStopped(data)) ? 'customerbox' : 'dea';
    }
    // ---- STOPPED-STATE-LOGIK END -----------------------------------------

    function canRenderDea() {
        return state.renderMode !== 'customerbox';
    }

    function renderCustomerboxMode() {
        const customerboxData = state.customerboxData;
        if (customerboxData && getCustomerboxTeambox(customerboxData)) {
            renderCustomerboxData(customerboxData, state.ticketId);
            return;
        }
        if (state.customerboxSessionError) {
            renderCustomerboxSessionExpired(state.customerboxSessionError);
            return;
        }
        renderCustomerboxLoading();
        loadCustomerboxData(state.ticketId);
    }

    function renderCustomerboxData(data, ticketId) {
        if (state.renderMode !== 'customerbox') return;
        clearCustomerboxLoadingTimeout();
        const teambox = getCustomerboxTeambox(data);
        if (!teambox || !teambox.id) {
            renderCustomerboxLoading();
            return;
        }

        state.customerboxData = data;
        state.ticketId = ticketId || state.ticketId;
        const bar = createBar();
        bar.classList.remove('is-loading');
        bar.replaceChildren();
        renderTeambox(bar, data, teambox);
    }

    function renderData(data) {
        if (!canRenderDea()) {
            renderCustomerboxMode();
            return;
        }

        const bar = createBar();
        bar.classList.remove('is-loading');
        bar.replaceChildren();
        const teamboxes = Array.isArray(data && data.teamboxes) ? data.teamboxes : [];
        if (teamboxes.length === 0) {
            const message = document.createElement('span');
            message.className = 'dea-error';
            message.textContent = 'Keine Teambox für dieses Ticket gefunden';
            bar.appendChild(message);
            return;
        }
        teamboxes.forEach((teambox, index) => {
            if (index > 0) addSeparator(bar);
            renderTeambox(bar, data, teambox);
        });
    }

    async function loadYouTrack(data, ticketId) {
        if (!getYouTrackConfig(data)) return;
        try {
            const response = await apiRequest('GET', 'hubspot/youtrack', ticketId);
            state.youtrackIssues.set(ticketId, response.issues || []);
            if (state.data !== data || state.ticketId !== ticketId) return;
            if (!canRenderDea()) {
                renderCustomerboxMode();
                return;
            }
            renderData(data);
        } catch (error) {
            log('DEA YouTrack link unavailable', error);
        }
    }

    // =====================================================================
    // WORKAROUND-SYNC-LOGIK START
    // Entfernen mit dem Befehl: "ENTFERNE WORKAROUND-SYNC-LOGIK"
    // Zweck: Wenn DEA meldet, dass das Ticket noch nicht aus HubSpot
    // synchronisiert wurde, die OldStack-/Customerbox-Ansicht laden.
    function isHubSpotSyncWorkaroundError(value) {
        // HubSpot liefert die Meldung je nach Fehlerpfad mit oder ohne
        // abschließendes Ausrufezeichen. Die Satzzeichen gehören daher nicht
        // zur Erkennungsbedingung.
        const expected = 'this ticket has not been synced from hubspot yet';
        const seen = new Set();

        function normalize(valueToCheck) {
            return String(valueToCheck || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
        }

        function containsExpectedMessage(candidate, depth = 0) {
            if (candidate == null || depth > 8) return false;
            if (typeof candidate === 'string' || typeof candidate === 'number') {
                return normalize(candidate).includes(expected);
            }
            if (typeof candidate !== 'object') return false;
            if (seen.has(candidate)) return false;
            seen.add(candidate);

            if (normalize(candidate.message).includes(expected)) return true;
            if (normalize(candidate.responseText).includes(expected)) return true;

            if (Array.isArray(candidate)) {
                return candidate.some(item => containsExpectedMessage(item, depth + 1));
            }

            return Object.keys(candidate).some(key =>
                containsExpectedMessage(candidate[key], depth + 1)
            );
        }

        // containsExpectedMessage() durchsucht bereits rekursiv jeden Objekt-Key
        // (inkl. message/body/responseText auf jeder Verschachtelungsebene), ein
        // erneutes gezieltes Prüfen dieser Felder wäre daher redundant.
        return containsExpectedMessage(value);
    }
    // WORKAROUND-SYNC-LOGIK END

    // keepView: Beim Neuladen (Klick auf das T-Icon / Reload-Button) bleibt die
    // aktuell angezeigte Leiste stehen, statt kurz "DEA wird geladen ..." oder
    // die vorläufige [C]-Leiste zu zeigen. Sie wird erst durch die DEA-Antwort
    // ersetzt.
    async function loadTicket(ticketId, { keepView = false } = {}) {
        const requestNumber = ++state.requestNumber;
        const loadStart = performance.now();
        const previousMode = keepView && state.ticketId === ticketId ? state.renderMode : null;
        clearCustomerboxLoadingTimeout();
        state.ticketId = ticketId;
        state.data = null;
        state.customerboxData = null;
        state.customerboxSessionError = null;
        state.customerboxLoading = false;
        state.ticketOwnerAccess = null;
        // Mit gemerktem Modus wird die vorläufige Customerbox-Anzeige unterdrückt
        // (renderCustomerboxData rendert nur bei renderMode === 'customerbox').
        state.renderMode = previousMode;
        state.lockedDeaUrls.delete(String(ticketId));
        if (previousMode) {
            setBarReloading(true);
        } else {
            setBarReloading(false);
            renderLoading();
        }
        markTiming('Ticket erkannt, Loading-Ansicht gerendert', loadStart);

        // Start the legacy Customerbox request immediately instead of waiting
        // for the DEA response. This restores the old overlay's fast 401/cache
        // behavior while the DEA request continues in parallel.
        loadCustomerboxData(ticketId);

        try {
            const data = await apiRequest('GET', 'hubspot/ticket', ticketId);
            markTiming('DEA-Ticket-Daten erhalten', loadStart);
            if (requestNumber !== state.requestNumber || state.ticketId !== ticketId) return;
            state.data = data;
            state.ticketOwnerAccess = getApiOwnershipState(data);

            // New Original Overlay contract: the exact DEA badge label
            // "Old stack" selects Customerbox for the current ticket.
            // Zusätzlich: Sind alle Teamboxen "Stopped", gilt ebenfalls Old Stack.
            const resolvedMode = await resolveRenderMode(data);
            if (requestNumber !== state.requestNumber || state.ticketId !== ticketId) return;
            state.renderMode = resolvedMode;
            rememberRevision(data, ticketId);

            setBarReloading(false);
            if (state.renderMode === 'customerbox') {
                renderCustomerboxMode();
            } else {
                renderData(data);
            }
            markTiming('DEA-Bar gerendert', loadStart);
            loadYouTrack(data, ticketId);
        } catch (error) {
            markTiming('DEA-Request fehlgeschlagen', loadStart);
            if (requestNumber !== state.requestNumber || state.ticketId !== ticketId) return;

            // WORKAROUND-SYNC-LOGIK START
            // Die Sync-Meldung bleibt ein DEA-Fehler. Nur ein Klick auf das
            // DEA-Icon startet anschließend den OldStack-/Customerbox-Modus.
            // WORKAROUND-SYNC-LOGIK END

            state.ticketOwnerAccess = isTicketNotOpenError(error) ? false : null;
            state.renderMode = null;
            setBarReloading(false);
            renderError(error);
        }
    }

    // WORKAROUND-SYNC-LOGIK START
    // Letzte DOM-Absicherung für den Fall, dass das separate HubSpot-Overlay
    // die Sync-Meldung selbst rendert und der Fehler nicht durch diesen
    // Userscript-API-Callback läuft.
    function getVisiblePageText() {
        try {
            return document.body ? document.body.innerText || document.body.textContent || '' : '';
        } catch (error) {
            return '';
        }
    }

    function checkVisibleErrors() {
        if (!state.ticketId) return;

        const pageText = getVisiblePageText();
        if (!isHubSpotSyncWorkaroundError(pageText)) return;

        // The separate HubSpot overlay may render the sync message directly
        // in the page instead of returning it through this userscript's API
        // callback. Mirror that error in the DEA bar so the same explicit
        // DEA-icon click action is available in both paths.
        const bar = document.getElementById(BAR_ID);
        if (bar && bar.dataset.syncErrorAction === 'true') return;

        const syncError = new Error('This ticket has not been synced from HubSpot yet!');
        renderError(syncError);
    }

    function startSyncErrorObserver() {
        const observer = new MutationObserver(() => checkVisibleErrors());
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }
    // WORKAROUND-SYNC-LOGIK END

    function refreshCustomerboxOverlay() {
        const ticketId = getTicketId();
        if (!ticketId) return;

        // Invalidate the previous Customerbox callback and keep the current
        // ticket in OldStack mode. This re-renders only the [C] view instead
        // of reloading the HubSpot page or waiting for the DEA API again.
        state.requestNumber += 1;
        clearCustomerboxLoadingTimeout();
        state.ticketId = ticketId;
        state.customerboxData = null;
        state.customerboxSessionError = null;
        state.customerboxLoading = false;
        state.renderMode = 'customerbox';
        renderCustomerboxMode();
    }

    function setBarReloading(active) {
        const bar = document.getElementById(BAR_ID);
        if (bar) bar.classList.toggle('dea-reloading', Boolean(active));
    }

    let lastOverlayReloadAt = 0;

    function reloadOverlay() {
        // Ein physischer Klick löst über die Capture-Handler pointerdown UND click
        // aus. Ohne Sperre startet das zwei komplette Ladezyklen direkt
        // hintereinander (die Leiste springt mehrfach zwischen DEA- und [C]-Ansicht).
        const now = Date.now();
        if (now - lastOverlayReloadAt < 1000) return;
        lastOverlayReloadAt = now;

        const ticketId = getTicketId();
        if (!ticketId) {
            checkLocation();
            return;
        }

        // Invalidate pending Customerbox/DEA callbacks and rerun only the
        // overlay data flow. The HubSpot document itself is not reloaded.
        clearCustomerboxLoadingTimeout();
        loadTicket(ticketId, { keepView: true });
    }

    function checkLocation() {
        const currentPath = location.pathname + location.search;
        if (currentPath === state.lastPath && state.ticketId) return;
        state.lastPath = currentPath;
        const ticketId = getTicketId();
        if (!ticketId) {
            clearCustomerboxLoadingTimeout();
            state.ticketId = null;
            state.data = null;
            state.customerboxLinkConfirmed = false;
            state.renderMode = null;
            state.customerboxLinkRequestNumber = 0;
            state.lockedDeaUrls.clear();
            state.requestNumber += 1;
            clearBar();
            return;
        }
        if (ticketId !== state.ticketId) loadTicket(ticketId);
    }

    injectStyle();
    checkLocation();
    startSyncErrorObserver();
    // Ein gemeinsamer Heartbeat statt zweier unabhängiger setInterval-Timer
    // (zuvor: checkLocation alle 1000ms + checkVisibleErrors alle 500ms).
    // Der Sicherheitsnetz-Charakter von checkVisibleErrors bleibt bei 500ms
    // erhalten; checkLocation() ist ein reiner Pfad-Vergleich und damit auch
    // beim doppelten Takt vernachlässigbar günstig.
    setInterval(() => {
        checkLocation();
        checkVisibleErrors();
    }, 500);
})();

// HubSpot global search: reduce the search field to half of its original width.
(function () {
    'use strict';

    const ORIGINAL_WIDTH_ATTRIBUTE = 'data-vm-original-width';
    const APPLIED_ATTRIBUTE = 'data-vm-half-width-applied';
    const EARLY_STYLE_ID = 'vm-hubspot-search-half-width-style';

    // This override is installed immediately. The first rendering is hidden
    // until the final half width has been applied.
    function installEarlyStyle() {
        const style = document.createElement('style');
        style.id = EARLY_STYLE_ID;
        style.textContent = `
            /* Keep hidden until the final half width has been set. */
            #hs-global-toolbar [class*="SearchInputWrapper"]:has(#global-search-input) {
                visibility: hidden !important;
            }
        `;

        (document.head || document.documentElement).appendChild(style);
        return style;
    }

    const earlyStyle = installEarlyStyle();

    function findSearchWrapper() {
        const input = document.querySelector(
            '#global-search-input[aria-label="Find in HubSpot"], ' +
            '#global-search-input[placeholder="Find in HubSpot"], ' +
            '#global-search-input'
        );

        if (!input) return null;

        // HubSpot classes contain changing hashes; the stable part
        // "SearchInputWrapper" remains available.
        return input.closest('[class*="SearchInputWrapper"]') || input.parentElement;
    }

    function applyHalfWidth() {
        const wrapper = findSearchWrapper();
        if (!wrapper) return false;

        const measuredWidth = wrapper.getBoundingClientRect().width;
        if (!measuredWidth) return false;

        let originalWidth = parseFloat(wrapper.getAttribute(ORIGINAL_WIDTH_ATTRIBUTE));
        if (!originalWidth || originalWidth <= 0) {
            originalWidth = measuredWidth;
            wrapper.setAttribute(ORIGINAL_WIDTH_ATTRIBUTE, String(originalWidth));
        }

        const halfWidth = Math.max(160, Math.round(originalWidth / 2));
        const width = `${halfWidth}px`;

        // After the first successful measurement the early override can be
        // removed; inline rules take over from here.
        if (earlyStyle && earlyStyle.parentNode) {
            earlyStyle.remove();
        }

        wrapper.style.setProperty('width', width, 'important');
        wrapper.style.setProperty('min-width', '0', 'important');
        wrapper.style.setProperty('max-width', width, 'important');
        wrapper.style.setProperty('flex', `0 0 ${width}`, 'important');
        wrapper.setAttribute(APPLIED_ATTRIBUTE, 'true');

        // In case HubSpot sets the form width internally.
        const form = wrapper.querySelector('form');
        if (form) {
            form.style.setProperty('width', '100%', 'important');
            form.style.setProperty('max-width', '100%', 'important');
        }

        return true;
    }

    function scheduleApply() {
        // Several passes are needed because HubSpot renders the global toolbar
        // dynamically and rebuilds it during navigation.
        [0, 100, 500, 1200, 2500].forEach((delay) => {
            window.setTimeout(applyHalfWidth, delay);
        });
    }

    function start() {
        scheduleApply();

        const observer = new MutationObserver(() => {
            scheduleApply();
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        window.addEventListener('resize', applyHalfWidth, { passive: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();

// HubSpot Breeze assistant: show only its icon in the global toolbar.
(function () {
    'use strict';

    const BUTTON_SELECTOR =
        '[data-test-id="hs-global-toolbar-copilot-list-item"]';

    const LABEL_TEXT = 'Breeze-Assistent';

    function makeIconOnly() {
        document.querySelectorAll(BUTTON_SELECTOR).forEach((button) => {
            // Find the label using HubSpot's class or the visible text.
            const labels = button.querySelectorAll(
                'span[class*="LabelText"], i18n-string, span'
            );

            labels.forEach((element) => {
                const text = element.textContent.trim();

                if (
                    text === LABEL_TEXT ||
                    element.className.toString().includes('LabelText')
                ) {
                    element.style.setProperty('display', 'none', 'important');
                    element.setAttribute('aria-hidden', 'true');
                }
            });

            // Keep an accessible label for screen readers and tooltips.
            button.setAttribute('aria-label', LABEL_TEXT);
            button.setAttribute('title', LABEL_TEXT);

            // Set the button to a compact icon size.
            button.classList.add('vm-breeze-icon-only');
        });
    }

    function addStyles() {
        if (document.getElementById('vm-breeze-icon-only-styles')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'vm-breeze-icon-only-styles';

        style.textContent = `
            ${BUTTON_SELECTOR}.vm-breeze-icon-only {
                width: 48px !important;
                min-width: 48px !important;
                padding-left: 12px !important;
                padding-right: 12px !important;
                justify-content: center !important;
                gap: 0 !important;
            }

            ${BUTTON_SELECTOR}.vm-breeze-icon-only
            span[class*="LabelText"] {
                display: none !important;
            }
        `;

        document.head.appendChild(style);
    }

    function update() {
        addStyles();
        makeIconOnly();
    }

    // Initial execution.
    update();

    // HubSpot loads parts of the interface dynamically.
    const observer = new MutationObserver(update);

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
})();
