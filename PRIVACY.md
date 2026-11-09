[PRIVACY.md](https://github.com/user-attachments/files/34558207/PRIVACY.md)

# Fishingbot Desktop – Datenschutzerklärung

Stand: 9. November 2026


## 1. Verantwortlicher und Kontakt

Verantwortlich für die Verarbeitung im Sinne der DSGVO ist: Fishingsys Desktop, Deutschland. Kontakt ausschließlich per E-Mail. Kontakt für Datenschutzfragen und Anfragen: <fishingsyshub@gmail.com>.

## 2. Grundprinzip: lokale Anwendung

Fishingbot Desktop ist eine Windows-Anwendung, die auf dem Computer des Nutzers (in der Regel des Streamers) läuft. Spieldaten werden in einer lokalen SQLite-Datenbank auf diesem Computer gespeichert. Der integrierte Webserver ist nur über die Loopback-Adresse (127.0.0.1) des eigenen Computers erreichbar. Der Anbieter erhält keine Kopie dieser lokalen Daten, außer der unten beschriebenen Berichte und optionalen Dienste.

## 3. Welche Daten verarbeitet werden

**a) Twitch-Anmeldung.** Bei der Anmeldung mit Twitch werden Twitch-Benutzer-ID, Login-Name, Anzeigename und ggf. Profilbild verarbeitet und lokal gespeichert, damit das Spiel Spieler zuordnen kann.

**b) Streamer-Verbindung (optional).** Verbindet ein Streamer seinen Twitch-Account im Broadcaster-Bereich, speichert die App lokal Twitch-Benutzer-ID, Login-Name, die erteilten Berechtigungen (moderation:read, channel:read:vips, channel:read:subscriptions) sowie ein OAuth-Refresh-Token. Damit prüft die App, ob Zuschauer im Chat des Streamers Moderatoren, VIPs oder Abonnenten sind, um Spielboni anzuwenden. Ergebnisse dieser Abfragen werden nur kurz zwischengespeichert (IDs höchstens 7 Tage, Ergebnisse höchstens 5 Minuten) und nicht für andere Zwecke verwendet.

**c) Spieldaten.** Fangergebnisse, Inventar, Fortschritt, Fishdex, Statistiken, Handel bzw. Geschenke, Einstellungen und Chat-Befehlsdaten. Alle Daten bleiben lokal auf dem Computer des Streamers.

**d) Berichte und Ideen (optional).** Wenn du das Formular „Problem melden“ oder „Idee einreichen“ nutzt, werden der eingegebene Titel und Text, ein optionaler Screenshot, Datum und Uhrzeit sowie – sofern du nicht „Anonym senden“ wählst – dein Twitch-Login-Name verarbeitet. Die Nachricht wird per E-Mail an fishingsyshub@gmail.com gesendet (siehe Abschnitt 5). Bitte gib in Berichten keine persönlichen Daten von dir oder anderen Personen an.

**e) Twitch-Erweiterung (optional).** Wenn der Streamer die Twitch-Erweiterung aktiviert, werden nur öffentliche Kanal-Summen und die Namen der besten Angler an den Erweiterungs-Relay-Dienst übermittelt. Private Inventare, Guthaben und Datenbankinhalte werden nicht übermittelt. Zuschauer können optional ihre Identität teilen; dies geschieht nur nach ausdrücklicher Zustimmung über Twitch.

**f) Technische Daten.** Beim Zugriff auf externe Dienste (siehe Abschnitt 5) können IP-Adresse, Zeitpunkt und technische Angaben wie die Version der App an den jeweiligen Dienst übermittelt werden. Die App selbst erhebt keine Nutzungs-, Analyse- oder Telemetriedaten.

## 4. Zwecke und Rechtsgrundlagen

Die Verarbeitung dient der Twitch-Anmeldung, dem Betrieb des Spiels auf dem lokalen Computer, der Prüfung von Moderator-, VIP- und Abonnentenstatus für Spielboni, der Bearbeitung von Berichten sowie der Sicherheit des Dienstes. Soweit die DSGVO anwendbar ist, kommen insbesondere Art. 6 Abs. 1 lit. b (Vertrag/Nutzung der Funktion) und lit. f DSGVO (berechtigtes Interesse am sicheren Betrieb) in Betracht. Soweit du Berichte freiwillig sendest, erfolgt die Verarbeitung auf Grundlage deiner Einwilligung (Art. 6 Abs. 1 lit. a DSGVO).

## 5. Drittdienste

- **Twitch (Amazon / Twitch Interactive):** Anmeldung (id.twitch.tv), Abfragen der Twitch-API (api.twitch.tv). Es gelten zusätzlich die Datenschutzhinweise von Twitch.
- **GitHub:** Wenn die Update-Prüfung aktiviert ist oder du manuell nach Updates suchst, ruft die App die öffentliche Release-Schnittstelle von GitHub (api.github.com) auf und lädt bei einem Update das Installationspaket herunter. Dabei fallen technische Verbindungsdaten wie die IP-Adresse an.
- **Resend (Resend Inc., USA):** Versand von Berichten und Ideen per E-Mail an das Postfach des Anbieters. Der Dienst verarbeitet die Nachricht nur zur Zustellung.
- **Render (Render Services, Inc., USA):** Hosting des Erweiterungs-Relays (fishingbot-extension-relay.onrender.com). Dieser leitet authentifizierte Anfragen weiter. Es werden keine Inventare, Guthaben oder SQLite-Daten dort gespeichert. Technische Verbindungsdaten wie IP-Adressen können beim Hosting-Anbieter anfallen.
- **GIPHY (Shutterstock, Inc., USA):** Wenn du eine animierte Hintergrundvorlage auswählst, lädt die App die GIF-Datei von media.giphy.com. Dabei wird deine IP-Adresse an GIPHY übermittelt.

Der Anbieter verkauft keine Daten, setzt keine Werbe- oder Tracking-Dienste ein und überträgt keine Daten an Dritte außer den oben genannten Diensten zu den genannten Zwecken.

## 6. Berechtigungen und Systemzugriff

Die App kann nach Wunsch beim Start von Windows bzw. beim Start von OBS automatisch starten. Dafür wird ein Eintrag im Autostart des aktuellen Windows-Benutzers angelegt. Diese Option kann in den Einstellungen deaktiviert werden. Die App liest Systemwerte (z. B. CPU- und RAM-Auslastung) nur lokal, um Überwachungsanzeigen zu füllen; diese Werte werden nicht übertragen.

## 7. Speicherdauer

- **Lokale Spieldaten:** bleiben auf dem Computer, bis sie in der App gelöscht werden oder die Datenbank bzw. die App-Daten entfernt werden. Automatische Sicherungen werden nach den Einstellungen aufbewahrt (Anzahl ist einstellbar) und lassen sich löschen.
- **Twitch-Token:** bleiben gespeichert, bis du die Verbindung trennst. Beim Trennen wird das Token lokal gelöscht und bei Twitch widerrufen.
- **Zwischengespeicherte Twitch-Abfragen:** laufen automatisch nach höchstens 7 Tagen (IDs) bzw. 5 Minuten (Ergebnisse) ab.
- **Berichte und Ideen:** werden im E-Mail-Postfach des Anbieters aufbewahrt, bis sie gelöscht werden.

## 8. Löschung deiner Daten

Du kannst lokale Daten jederzeit in der App löschen oder die Datenbank auf deinem Computer entfernen. Die Twitch-Verbindung kannst du unter „Verbindung trennen“ beenden oder direkt in deinen Twitch-Einstellungen unter „Verbundene Anwendungen“ entziehen. Für Daten im Relay oder in E-Mails an den Anbieter wende dich an <fishingsyshub@gmail.com>. Wir löschen die Daten nach Prüfung der Identität, soweit keine gesetzlichen Aufbewahrungspflichten bestehen.

## 9. Deine Rechte

Soweit die DSGVO anwendbar ist, hast du das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch gegen Verarbeitungen auf Grundlage berechtigter Interessen. Eine erteilte Einwilligung kannst du jederzeit mit Wirkung für die Zukunft widerrufen. Du hast außerdem das Recht, dich bei einer Datenschutz-Aufsichtsbehörde zu beschweren.

## 10. Kinder

Die App richtet sich nicht an Kinder unter 13 Jahren. Die Nutzung von Twitch richtet sich nach den Altersvorgaben von Twitch.

## 11. Änderungen

Diese Datenschutzerklärung wird angepasst, wenn sich die App oder die Datenverarbeitung ändert. Die jeweils aktuelle Fassung ist unter dieser Adresse abrufbar.


------------------------------------------------------------------------


# Fishingbot Desktop – Privacy Policy

Last updated: 9 November 2026

## 1. Controller and contact

The controller within the meaning of the GDPR is: Fishingsys Desktop, Germany. Contact by email only. Contact for privacy questions and requests: <fishingsyshub@gmail.com>.

## 2. Core principle: local application

Fishingbot Desktop is a Windows application that runs on the user's own computer (typically the streamer's). Game data is stored in a local SQLite database on that computer. The built-in web server is reachable only through the computer's own loopback address (127.0.0.1). The provider does not receive a copy of this local data, except for the reports and optional services described below.

## 3. Data we process

**a) Twitch sign-in.** When you sign in with Twitch, the Twitch user ID, login name, display name and, where provided, profile picture are processed and stored locally so the game can associate your play data with your account.

**b) Streamer connection (optional).** If a streamer connects their Twitch account in the broadcaster area, the app stores locally the Twitch user ID, login name, the granted permissions (moderation:read, channel:read:vips, channel:read:subscriptions) and an OAuth refresh token. This lets the app check whether viewers in the streamer's chat are moderators, VIPs or subscribers so that game bonuses can be applied. Results are cached only briefly (IDs for up to 7 days, results for up to 5 minutes) and are not used for any other purpose.

**c) Game data.** Catch results, inventory, progress, Fishdex, statistics, trades/gifts, settings and chat command data. All of it stays locally on the streamer's computer.

**d) Reports and ideas (optional).** If you use the “Report a problem” or “Submit an idea” form, the title and text you enter, an optional screenshot, the date and time, and, unless you choose “Send anonymously”, your Twitch login name are processed. The message is sent by email to fishingsyshub@gmail.com (see section 5). Please do not include personal data about yourself or others in reports.

**e) Twitch Extension (optional).** If a streamer enables the Twitch Extension, only public channel totals and the names of the top anglers are sent to the Extension relay service. Private inventories, balances and database contents are not sent. Viewers may optionally share their identity; this happens only after explicit consent through Twitch.

**f) Technical data.** When external services are contacted (see section 5), your IP address, the time of the request and technical details such as the app version may be transmitted to that service. The app itself collects no usage, analytics or telemetry data.

## 4. Purposes and legal bases

Processing serves Twitch sign-in, running the game on the local computer, checking moderator, VIP and subscriber status for game bonuses, handling reports, and keeping the service secure. Where the GDPR applies, the relevant legal bases are in particular Art. 6(1)(b) (performance of a contract / use of the requested feature) and Art. 6(1)(f) (legitimate interests in secure operation). Reports you choose to send are processed on the basis of your consent (Art. 6(1)(a)).

## 5. Third-party services

- **Twitch (Twitch Interactive / Amazon):** sign-in (id.twitch.tv) and Twitch API requests (api.twitch.tv). Twitch's own privacy notice also applies.
- **GitHub:** if update checks are enabled or you check for updates manually, the app calls GitHub's public release API (api.github.com) and downloads the installer when an update is available. Connection data such as your IP address is involved.
- **Resend (Resend Inc., USA):** sends reports and ideas by email to the provider's mailbox. The service processes the message only for delivery.
- **Render (Render Services, Inc., USA):** hosts the Extension relay (fishingbot-extension-relay.onrender.com), which forwards authenticated requests. No inventories, balances or SQLite data are stored there. Connection data such as IP addresses may be processed by the hosting provider.
- **GIPHY (Shutterstock, Inc., USA):** when you choose an animated wallpaper, the app loads the GIF from media.giphy.com, which transmits your IP address to GIPHY.

The provider does not sell data, uses no advertising or tracking services, and does not share data with third parties other than the services listed above for the purposes stated.

## 6. Permissions and system access

If you choose, the app starts automatically with Windows or when OBS starts. This adds an entry to the autostart of the current Windows user. You can turn this off in the settings. The app reads system values (for example CPU and RAM usage) locally to show monitoring displays; these values are not transmitted.

## 7. Retention

- **Local game data:** stays on your computer until you delete it in the app or remove the database or app data. Automatic backups are kept according to your settings (the number is adjustable) and can be deleted.
- **Twitch token:** is kept until you disconnect. Disconnecting deletes the token locally and asks Twitch to revoke it.
- **Cached Twitch lookups:** expire automatically after at most 7 days (IDs) or 5 minutes (results).
- **Reports and ideas:** are kept in the provider's mailbox until deleted.

## 8. Deleting your data

You can delete local data at any time in the app or by removing the database from your computer. You can end the Twitch connection with “Disconnect” in the app, or revoke access directly in your Twitch settings under connected applications. For data held by the relay or in emails sent to the provider, contact <fishingsyshub@gmail.com>. We will delete the data after verifying your identity, unless legal retention obligations apply.

## 9. Your rights

Where the GDPR applies, you have the right of access, rectification, erasure, restriction of processing, data portability, and the right to object to processing based on legitimate interests. You may withdraw any consent at any time with effect for the future. You also have the right to lodge a complaint with a data protection supervisory authority.

## 10. Children

The app is not directed at children under 13. Use of Twitch is subject to Twitch's age requirements.

## 11. Changes

This policy will be updated when the app or its data processing changes. The current version is always available at this address.

