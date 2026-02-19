# GastroDash

Digitales Bestell- und Live-Board-System fuer Gastronomie, Vereinsheime und Events.

GastroDash bietet eine oeffentliche Bestellseite, ein Admin-Panel, eine Live-Verwaltung mit Echtzeit-Updates und eine Statistikansicht. Die App ist leichtgewichtig und laeuft nur mit Node.js + SQLite.

## Tech Stack
- Backend: `Node.js` + `Express`
- ORM/DB: `Prisma` + `SQLite`
- Realtime: `Socket.IO`
- Frontend: `HTML` + `Tailwind CSS`
- Auth: Session-basiert (`express-session`)

## Hauptfunktionen

### Oeffentliche Bestellseite (`/`)
- Konfigurierbarer Seitenname, Seitentitel und Seitenbeschreibung
- Produktanzeige mit Kategorien
- Suche nach Produkten/Kategorien
- Mengenwahl mit Buttons (`+1`, `-1`, `+5`, `-5`)
- Produktstatus beruecksichtigt:
  - deaktiviert/ausverkauft => nicht bestellbar
- Bestellung per Overlay mit Pflichtregel:
  - `Name` oder `Tisch` muss ausgefuellt sein
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
- Login fuer `ADMIN` und `MANAGER`
- Echtzeit-Board mit Status:
  - `Noch offen` (LIVE)
  - `Abgeschlossene` (ARCHIVE), optional einblendbar
- Globale Suche ueber:
  - Name
  - Details
  - Tisch
  - Produktnamen
- Tischfilter per Dropdown
- Bestellungen umschalten zwischen LIVE/ARCHIVE
- Passwortgeschuetztes Loeschen abgeschlossener Eintraege
- `Short Produkt Settings` Overlay fuer schnelle Produktstatus-Aenderung
  - dynamische Buttons je nach aktuellem Status

### Einstellungen
- Tischanzahl
- Globales Produktlimit
- Seitenname / Seitentitel / Seitenbeschreibung
- Passwort fuer Loeschen abgeschlossener Bestellungen
- User-Einstellungen:
  - Admin und Manager Username/Passwort im Web aenderbar
  - wird in DB gespeichert und in `.env` synchronisiert
- Wartung:
  - Alle Produkte loeschen (mit Bestaetigungs-Overlay)
  - Alle Archiv-Bestellungen loeschen (mit Bestaetigungs-Overlay)

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
- `src/views/` HTML-Views fuer geschuetzte Bereiche
- `prisma/` Prisma-Schema
- `public/` Oeffentliche Frontend-Dateien

## Installation
1. Abhaengigkeiten installieren
```bash
npm install
```

2. ENV-Datei anlegen
```bash
copy .env.example .env
```

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

Entwicklung mit Auto-Reload:
```bash
npm run dev
```

## Wichtige ENV Variablen
Siehe `.env.example`:

- `DATABASE_URL` SQLite-Pfad (z. B. `file:./dev.db`)
- `PORT` Server-Port (z. B. fuer Pterodactyl)
- `SESSION_SECRET` Session-Secret
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`
- `MANAGER_USERNAME` / `MANAGER_PASSWORD`
- `ARCHIVE_DELETE_PASSWORD` Fallback fuer Archiv-Loeschpasswort
- `MAX_ORDER_QUANTITY` maximale Menge pro Produktposition bei Bestellung

## NPM Skripte
- `npm run dev` Start mit `nodemon`
- `npm run start` Produktionsstart
- `npm run prisma:generate` Prisma Client erzeugen
- `npm run prisma:push` Schema in SQLite anwenden
- `npm run prisma:studio` Datenbank im Prisma Studio oeffnen

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

Typische Loesung:
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
Privates/Projektinternes Repository. Lizenz nach Bedarf ergaenzen.
"# GastroDash" 
