# GastroDash

![GastroDash Banner](logo/GastroDash_logo_banner.png)

Digitales Bestell- und Live-Board-System für Gastronomie, Vereinsheime und Events.

GastroDash bietet eine öffentliche Bestellseite, ein Admin-Panel, eine Live-Verwaltung mit Echtzeit-Updates und eine Statistikansicht. Die App ist leichtgewichtig und läuft nur mit Node.js + SQLite.

## Tech Stack
- Backend: `Node.js` + `Express`
- ORM/DB: `Prisma` + `SQLite`
- Realtime: `Socket.IO`
- Frontend: `HTML` + `Tailwind CSS`
- Auth: Session-basiert (`express-session`)

## Hauptfunktionen

### Öffentliche Bestellseite (`/`)
- Konfigurierbarer Seitenname, Seitentitel und Seitenbeschreibung
- Produktanzeige mit Kategorien
- Suche nach Produkten/Kategorien
- Mengenwahl mit Buttons (`+1`, `-1`, `+5`, `-5`)
- Produktstatus berücksichtigt:
  - deaktiviert/ausverkauft => nicht bestellbar
- Bestellung per Overlay mit Pflichtregel:
  - `Name` oder `Tisch` muss ausgefüllt sein
- Optionaler Zusatztext/Details

### Adminbereich (`/admin`)
- Login mit Rolle `ADMIN`
- Getrennte Bereiche:
  - `Produktliste`
  - `Produkt erstellen`
  - `Bestellungen verwalten` (externe Seite `/admin/live`)
  - `Statistiken`
  - `Einstellungen`

### Produktverwaltung
- Produktfelder:
  - Name
  - Kategorie
  - Preis + Preis anzeigen/ausblenden
  - Bild per Upload (PNG/JPG/WebP) oder Bild-URL
  - Sortierung
  - Aktiv/Inaktiv
  - Ausverkauft
  - Bestelllimit pro Produkt
- Kategorieauswahl:
  - bestehende Kategorien per Dropdown
  - neue Kategorie frei eintragbar
- Dynamische Quick-Buttons (nur sinnvolle Aktionen sichtbar)

### Bestellungen verwalten (`/admin/live`)
- Login für `ADMIN` und `MANAGER`
- Echtzeit-Board mit Status:
  - `Noch offen` (LIVE)
  - `Abgeschlossene` (ARCHIVE), optional einblendbar
- Globale Suche über:
  - Name
  - Details
  - Tisch
  - Produktnamen
- Tischfilter per Dropdown
- Bestellungen umschalten zwischen LIVE/ARCHIVE
- Passwortgeschütztes Löschen abgeschlossener Einträge
- `Short Produkt Settings` Overlay für schnelle Produktstatus-Änderung
  - dynamische Buttons je nach aktuellem Status

### Einstellungen
- Tischanzahl
- Globales Produktlimit
- Seitenname / Seitentitel / Seitenbeschreibung
- Passwort für Löschen abgeschlossener Bestellungen
- User-Einstellungen:
  - Admin und Manager Username/Passwort im Web änderbar
  - wird in DB gespeichert und in `.env` synchronisiert
- Wartung:
  - Alle Produkte löschen (mit Bestätigungs-Overlay)
  - Alle Archiv-Bestellungen löschen (mit Bestätigungs-Overlay)

### Statistiken
- Gesamtbestellungen
- Bestellungen heute
- LIVE vs ARCHIVE
- Durchschnittliche Bearbeitungszeit
- Bestellungen pro Tag (letzte 14 Tage)
- Zuletzt bearbeitete Bestellungen
- `Top verkauft` (meistbestellte Produkte)

## Rollen und Rechte
- `ADMIN`
  - Vollzugriff auf Adminbereich und Live-Verwaltung
- `MANAGER`
  - Zugriff auf Live-Verwaltung (`/admin/live`)
  - kein Zugriff auf kompletten Adminbereich

## Projektstruktur
- `src/` Backend (Express, API, Socket.IO)
- `src/views/` HTML-Views für geschützte Bereiche
- `prisma/` Prisma-Schema
- `public/` Öffentliche Frontend-Dateien

## Installation
1. Abhängigkeiten installieren
```bash
npm install
```

2. ENV-Datei anlegen (kopieren/umbenennen)
```bash
copy .env.example .env
```

Danach die `.env` öffnen und eigene, echte Werte eintragen (Benutzer, Passwörter, Ports etc.).

3. Prisma Client generieren
```bash
npm run prisma:generate
```

4. Datenbank-Schema anwenden
```bash
npm run prisma:push
```

5. App starten
```bash
npm run start
```

Oder als All-in-One Start (Prisma Generate + DB Push + Serverstart):
```bash
npm run master
```

Hinweis zu `master.js`:
- `master.js` ist eine optionale Komfort-Startdatei.
- Sie startet nicht nur den Server, sondern führt davor `prisma generate` und `prisma db push` aus.
- Bei jedem Neustart mit `master.js` laufen diese Schritte erneut.
- Für Produktion meist besser: normal mit `npm run start` starten und `npm run master` nur bei Setup/Updates nutzen.

Entwicklung mit Auto-Reload:
```bash
npm run dev
```

## Wichtige ENV Variablen
Siehe `.env.example`:

- `DATABASE_URL` SQLite-Pfad (z. B. `file:./dev.db`)
- `SERVER_PORT` bevorzugter Server-Port
- `PORT` Fallback-Server-Port (z. B. für Pterodactyl)
- `SESSION_SECRET` Session-Secret (optional: leer lassen, dann wird beim Start ein zufälliger temporärer Secret erzeugt)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`
- `MANAGER_USERNAME` / `MANAGER_PASSWORD`
- `ARCHIVE_DELETE_PASSWORD` Fallback für Archiv-Löschpasswort
- `MAX_ORDER_QUANTITY` maximale Menge pro Produktposition bei Bestellung

## Standardzugänge (Default)
Wenn nichts anderes in `.env` gesetzt ist:

- `ADMIN_USERNAME="gastro-admin"`
- `ADMIN_PASSWORD="bar-123"`
- `MANAGER_USERNAME="gastro"`
- `MANAGER_PASSWORD="bar-123"`

## NPM Skripte
- `npm run dev` Start mit `nodemon`
- `npm run start` Produktionsstart
- `npm run master` Generate + DB Push + Serverstart
- `npm run prisma:generate` Prisma Client erzeugen
- `npm run prisma:push` Schema in SQLite anwenden
- `npm run prisma:studio` Datenbank im Prisma Studio öffnen

## API (Auszug)
- Public:
  - `GET /api/public/config`
  - `POST /api/public/orders`
- Admin:
  - `POST /api/admin/login`
  - `GET /api/admin/products`
  - `POST /api/admin/products`
  - `PUT /api/admin/products/:id`
  - `PATCH /api/admin/products/:id/quick`
  - `GET /api/admin/settings`
  - `PUT /api/admin/settings`
  - `PUT /api/admin/users`
  - `GET /api/admin/stats`
- Live/Board:
  - `POST /api/live/login`
  - `GET /api/live/orders`
  - `PATCH /api/live/orders/:id/status`
  - `PATCH /api/live/products/:id/quick`

## Troubleshooting

### Prisma Error `EPERM ... query_engine-windows.dll.node`
Kann bei Netzwerkpfaden/UNC-Freigaben auf Windows auftreten.

Typische Lösung:
1. Laufende Node-Prozesse beenden
```powershell
taskkill /F /IM node.exe
```
2. Danach erneut:
```bash
npm run prisma:generate
```

### Prisma Enum-Fehler bei alten Statuswerten
Falls alte Werte wie `OPEN` in Bestellungen existieren, normalisiert der Server diese beim Start automatisch auf `LIVE`/`ARCHIVE`.

## Lizenz
Privates/Projektinternes Repository. Lizenz nach Bedarf ergänzen.
