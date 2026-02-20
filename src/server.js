const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { Server } = require("socket.io");
const { PrismaClient, OrderStatus, UserRole } = require("@prisma/client");

require("dotenv").config();

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const ENV_PATH = path.join(__dirname, "../.env");

const PORT = Number(process.env.SERVER_PORT || process.env.PORT) || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "file:./dev.db";
const PRISMA_DIR = path.join(__dirname, "../prisma");
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString("hex");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "gastro-admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "bar-123";
const MANAGER_USERNAME = process.env.MANAGER_USERNAME || "gastro";
const MANAGER_PASSWORD = process.env.MANAGER_PASSWORD || "bar-123";
const LEGACY_ARCHIVE_DELETE_PASSWORD = process.env.ARCHIVE_DELETE_PASSWORD || "archive-delete";
const MAX_ORDER_QUANTITY = Number(process.env.MAX_ORDER_QUANTITY) || 99;

if (!process.env.SESSION_SECRET) {
  console.warn("[security] SESSION_SECRET fehlt. Es wurde ein zufälliger temporärer Secret generiert.");
}

const uploadDir = path.join(__dirname, "../public/uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const dbImportDir = path.join(__dirname, "../tmp");
fs.mkdirSync(dbImportDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const safeBase = file.originalname
        .toLowerCase()
        .replace(/[^a-z0-9.-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      cb(null, `${Date.now()}-${safeBase}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
    if (!ok) {
      cb(new Error("Nur PNG, JPG oder WebP erlaubt."));
      return;
    }
    cb(null, true);
  }
});

const dbUpload = multer({
  dest: dbImportDir,
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax"
    }
  })
);
app.use(express.static(path.join(__dirname, "../public")));

function sessionRole(req) {
  return req.session?.role || null;
}

function isAuthenticated(req) {
  return Boolean(req.session && req.session.userId);
}

function requireAdmin(req, res, next) {
  if (!isAuthenticated(req) || sessionRole(req) !== UserRole.ADMIN) {
    return res.status(401).json({ error: "Nicht eingeloggt" });
  }
  next();
}

function requireBoard(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: "Nicht eingeloggt" });
  }
  const role = sessionRole(req);
  if (![UserRole.ADMIN, UserRole.MANAGER].includes(role)) {
    return res.status(403).json({ error: "Keine Berechtigung" });
  }
  next();
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return Boolean(value);
}

function normalizeText(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeEnvValue(value) {
  return String(value ?? "").replace(/"/g, '\\"');
}

function setEnvValue(key, value) {
  const line = `${key}="${normalizeEnvValue(value)}"`;
  let content = "";
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, "utf8");
  }
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = `${content.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, content, "utf8");
}

function resolveDatabaseFilePath() {
  if (!DATABASE_URL.startsWith("file:")) {
    throw new Error("Nur SQLite DATABASE_URL mit file: wird unterstützt.");
  }
  const rawPath = decodeURIComponent(DATABASE_URL.slice(5));
  if (!rawPath) {
    throw new Error("DATABASE_URL enthält keinen gültigen SQLite-Dateipfad.");
  }
  // Prisma resolves relative SQLite paths from the prisma schema directory.
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(PRISMA_DIR, rawPath);
}

function emitProductsChanged() {
  io.emit("products:changed");
}

function emitOrdersChanged() {
  io.emit("orders:changed");
}

function emitSettingsChanged() {
  io.emit("settings:changed");
}

function mapOrder(order) {
  return {
    id: order.id,
    customerName: order.customerName,
    tableLabel: order.tableLabel,
    note: order.note,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: order.items.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      productId: item.productId,
      name: item.snapshotName,
      price: item.snapshotPrice,
      isFree: item.snapshotIsFree
    }))
  };
}

async function withSettings() {
  return prisma.settings.findUnique({ where: { id: 1 } });
}

async function passwordMatches(settings, inputPassword) {
  if (!inputPassword) {
    return false;
  }

  if (settings?.archiveDeletePasswordHash) {
    return bcrypt.compare(inputPassword, settings.archiveDeletePasswordHash);
  }

  return inputPassword === LEGACY_ARCHIVE_DELETE_PASSWORD;
}

async function ensureDefaults() {
  if (ADMIN_USERNAME === MANAGER_USERNAME) {
    throw new Error("ADMIN_USERNAME und MANAGER_USERNAME müssen unterschiedlich sein.");
  }

  // Migrate legacy order status values to current enum values used by Prisma.
  await prisma.$executeRawUnsafe(`
    UPDATE "Order"
    SET "status" = CASE
      WHEN "status" IS NULL THEN 'LIVE'
      WHEN UPPER("status") IN ('OPEN', 'PENDING', 'IN_PROGRESS', 'LIVE') THEN 'LIVE'
      WHEN UPPER("status") IN ('ARCHIVE', 'ARCHIVED', 'DONE', 'FINISHED', 'FERTIG', 'COMPLETED', 'CLOSED') THEN 'ARCHIVE'
      ELSE 'LIVE'
    END
    WHERE "status" IS NULL
      OR UPPER("status") NOT IN ('LIVE', 'ARCHIVE')
  `);

  await prisma.settings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      tableCount: 20,
      siteName: "GastroDash",
      siteTitle: "GastroBar bestellen",
      siteDescription: "Einfach bestellen was sie möchten bei der GastroBar.",
      productLimit: 200
    }
  });

  const adminPasswordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const existingAdmin = await prisma.user.findUnique({ where: { username: ADMIN_USERNAME } });
  if (!existingAdmin) {
    await prisma.user.create({ data: { username: ADMIN_USERNAME, passwordHash: adminPasswordHash, role: UserRole.ADMIN } });
  } else {
    await prisma.user.update({
      where: { id: existingAdmin.id },
      data: { role: UserRole.ADMIN, passwordHash: adminPasswordHash }
    });
  }

  const managerPasswordHash = await bcrypt.hash(MANAGER_PASSWORD, 10);
  const existingManager = await prisma.user.findUnique({ where: { username: MANAGER_USERNAME } });
  if (!existingManager) {
    await prisma.user.create({ data: { username: MANAGER_USERNAME, passwordHash: managerPasswordHash, role: UserRole.MANAGER } });
  } else {
    await prisma.user.update({
      where: { id: existingManager.id },
      data: { role: UserRole.MANAGER, passwordHash: managerPasswordHash }
    });
  }

  const settings = await withSettings();
  if (!settings.archiveDeletePasswordHash) {
    const hash = await bcrypt.hash(LEGACY_ARCHIVE_DELETE_PASSWORD, 10);
    await prisma.settings.update({
      where: { id: 1 },
      data: { archiveDeletePasswordHash: hash }
    });
  }
}

function withOrderSearch(orders, query, tableFilter) {
  const q = String(query || "").trim().toLowerCase();
  const t = String(tableFilter || "").trim().toLowerCase();

  const normalizeTable = (value) => {
    const raw = String(value || "").trim().toLowerCase();
    const m = raw.match(/^tisch\s*(\d+)$/i);
    if (m) return m[1];
    return raw;
  };
  const normalizedFilter = normalizeTable(t);

  return orders.filter((order) => {
    const byTable = !normalizedFilter || normalizeTable(order.tableLabel) === normalizedFilter;
    if (!byTable) {
      return false;
    }

    if (!q) {
      return true;
    }

    const nameHit = (order.customerName || "").toLowerCase().includes(q);
    const noteHit = (order.note || "").toLowerCase().includes(q);
    const tableHit = (order.tableLabel || "").toLowerCase().includes(q);
    const productHit = order.items.some((item) => item.snapshotName.toLowerCase().includes(q));
    return nameHit || noteHit || tableHit || productHit;
  });
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.get("/admin", (req, res) => {
  if (sessionRole(req) === UserRole.MANAGER) {
    return res.redirect("/admin/live");
  }
  res.sendFile(path.join(__dirname, "../public/admin.html"));
});

app.get("/admin/live", (req, res) => {
  res.sendFile(path.join(__dirname, "views/admin-live.html"));
});

app.get("/live", (req, res) => {
  res.redirect("/admin/live");
});

app.get("/board", (req, res) => {
  res.redirect("/admin/live");
});

app.get("/api/public/config", async (req, res) => {
  const settings = await withSettings();
  const products = await prisma.product.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
  });

  res.json({
    tableCount: settings?.tableCount ?? 20,
    siteName: settings?.siteName || "GastroDash",
    siteTitle: settings?.siteTitle || "GastroBar bestellen",
    siteDescription: settings?.siteDescription || "Einfach bestellen was sie möchten bei der GastroBar.",
    maxOrderQuantity: MAX_ORDER_QUANTITY,
    products
  });
});

app.post("/api/public/orders", async (req, res) => {
  const { customerName, tableLabel, note, items } = req.body || {};
  const safeName = normalizeText(customerName);
  const safeTable = normalizeText(tableLabel);
  const safeNote = normalizeText(note);

  if (!safeName && !safeTable) {
    return res.status(400).json({ error: "Name oder Tisch muss angegeben werden." });
  }

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "Keine Produkte ausgewählt" });
  }

  const filteredItems = items
    .filter((item) => Number.isInteger(item.productId) && Number.isInteger(item.quantity) && item.quantity > 0)
    .map((item) => ({
      productId: item.productId,
      quantity: item.quantity
    }));

  if (!filteredItems.length) {
    return res.status(400).json({ error: "Keine gültigen Mengen angegeben" });
  }

  const productIds = [...new Set(filteredItems.map((item) => item.productId))];
  const products = await prisma.product.findMany({ where: { id: { in: productIds }, isActive: true } });
  const productMap = new Map(products.map((p) => [p.id, p]));

  for (const item of filteredItems) {
    const product = productMap.get(item.productId);
    if (!product || product.isSoldOut) {
      return res.status(400).json({ error: `Produkt nicht verfügbar (ID ${item.productId})` });
    }
    const maxAllowed = Math.max(1, Math.min(MAX_ORDER_QUANTITY, product.orderLimit || MAX_ORDER_QUANTITY));
    if (item.quantity > maxAllowed) {
      return res.status(400).json({ error: `${product.name}: Maximal ${maxAllowed} pro Bestellung.` });
    }
  }

  const order = await prisma.order.create({
    data: {
      customerName: safeName,
      tableLabel: safeTable,
      note: safeNote,
      status: OrderStatus.LIVE,
      items: {
        create: filteredItems.map((item) => {
          const product = productMap.get(item.productId);
          const hasPrice = product.showPrice && product.price != null;
          return {
            productId: product.id,
            quantity: item.quantity,
            snapshotName: product.name,
            snapshotPrice: hasPrice ? product.price : null,
            snapshotIsFree: !hasPrice
          };
        })
      }
    },
    include: { items: true }
  });

  emitOrdersChanged();
  res.status(201).json({ success: true, order: mapOrder(order) });
});

app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Benutzername und Passwort sind erforderlich" });
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    return res.status(401).json({ error: "Ungültige Zugangsdaten" });
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    return res.status(401).json({ error: "Ungültige Zugangsdaten" });
  }
  if (![UserRole.ADMIN, UserRole.MANAGER].includes(user.role)) {
    return res.status(403).json({ error: "Keine Berechtigung" });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  res.json({ success: true, username: user.username, role: user.role });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get("/api/admin/me", (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ authenticated: false });
  }
  const role = sessionRole(req);
  if (![UserRole.ADMIN, UserRole.MANAGER].includes(role)) {
    return res.status(403).json({ authenticated: false });
  }
  res.json({ authenticated: true, username: req.session.username, role, isAdmin: role === UserRole.ADMIN });
});

app.post("/api/live/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Benutzername und Passwort sind erforderlich" });
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    return res.status(401).json({ error: "Ungültige Zugangsdaten" });
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    return res.status(401).json({ error: "Ungültige Zugangsdaten" });
  }
  if (![UserRole.ADMIN, UserRole.MANAGER].includes(user.role)) {
    return res.status(403).json({ error: "Keine Berechtigung fürs Live-Board" });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  res.json({ success: true, username: user.username, role: user.role });
});

app.get("/api/live/me", (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ authenticated: false });
  }
  const role = sessionRole(req);
  if (![UserRole.ADMIN, UserRole.MANAGER].includes(role)) {
    return res.status(403).json({ authenticated: false });
  }
  res.json({ authenticated: true, username: req.session.username, role });
});

app.post("/api/live/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get("/api/live/config", requireBoard, async (req, res) => {
  const settings = await withSettings();
  res.json({
    tableCount: settings?.tableCount ?? 20,
    siteName: settings?.siteName || "GastroDash",
    siteTitle: settings?.siteTitle || "GastroBar bestellen",
    siteDescription: settings?.siteDescription || "Einfach bestellen was sie möchten bei der GastroBar."
  });
});

app.get("/api/admin/settings", requireAdmin, async (req, res) => {
  const settings = await withSettings();
  const adminUser = await prisma.user.findFirst({ where: { role: UserRole.ADMIN } });
  const managerUser = await prisma.user.findFirst({ where: { role: UserRole.MANAGER } });
  res.json({
    id: settings.id,
    tableCount: settings.tableCount,
    siteName: settings.siteName,
    siteTitle: settings.siteTitle,
    siteDescription: settings.siteDescription,
    productLimit: settings.productLimit,
    maxOrderQuantity: MAX_ORDER_QUANTITY,
    adminUsername: adminUser?.username || ADMIN_USERNAME,
    managerUsername: managerUser?.username || MANAGER_USERNAME
  });
});

app.put("/api/admin/settings", requireAdmin, async (req, res) => {
  const { tableCount, siteName, siteTitle, siteDescription, productLimit, archiveDeletePassword } = req.body || {};

  const data = {};

  if (tableCount !== undefined) {
    if (!Number.isInteger(tableCount) || tableCount < 1 || tableCount > 500) {
      return res.status(400).json({ error: "tableCount muss zwischen 1 und 500 liegen" });
    }
    data.tableCount = tableCount;
  }

  if (siteName !== undefined) {
    const safeName = normalizeText(siteName);
    if (!safeName) {
      return res.status(400).json({ error: "Seitenname darf nicht leer sein" });
    }
    data.siteName = safeName;
  }

  if (siteTitle !== undefined) {
    const safeTitle = normalizeText(siteTitle);
    if (!safeTitle) {
      return res.status(400).json({ error: "Seitentitel darf nicht leer sein" });
    }
    data.siteTitle = safeTitle;
  }

  if (siteDescription !== undefined) {
    const safeDescription = normalizeText(siteDescription);
    if (!safeDescription) {
      return res.status(400).json({ error: "Seitenbeschreibung darf nicht leer sein" });
    }
    data.siteDescription = safeDescription;
  }

  if (productLimit !== undefined) {
    if (!Number.isInteger(productLimit) || productLimit < 1 || productLimit > 5000) {
      return res.status(400).json({ error: "productLimit muss zwischen 1 und 5000 liegen" });
    }
    data.productLimit = productLimit;
  }

  if (archiveDeletePassword !== undefined) {
    const safePassword = String(archiveDeletePassword || "").trim();
    if (safePassword.length < 4) {
      return res.status(400).json({ error: "Passwort muss mindestens 4 Zeichen lang sein" });
    }
    data.archiveDeletePasswordHash = await bcrypt.hash(safePassword, 10);
  }

  if (!Object.keys(data).length) {
    return res.status(400).json({ error: "Keine Änderungen übergeben" });
  }

  const settings = await prisma.settings.update({ where: { id: 1 }, data });
  emitSettingsChanged();

  res.json({
    id: settings.id,
    tableCount: settings.tableCount,
    siteName: settings.siteName,
    siteTitle: settings.siteTitle,
    siteDescription: settings.siteDescription,
    productLimit: settings.productLimit
  });
});

app.post("/api/admin/check-archive-password", requireAdmin, async (req, res) => {
  const { password } = req.body || {};
  const settings = await withSettings();
  const ok = await passwordMatches(settings, password);
  if (!ok) {
    return res.status(401).json({ error: "Passwort ist falsch" });
  }
  res.json({ success: true });
});

app.post("/api/admin/upload", requireAdmin, upload.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Datei fehlt" });
  }
  res.json({ success: true, imageUrl: `/uploads/${req.file.filename}` });
});

app.get("/api/admin/db/export", requireAdmin, (req, res) => {
  try {
    const dbPath = resolveDatabaseFilePath();
    if (!fs.existsSync(dbPath)) {
      return res.status(404).json({ error: "Datenbankdatei nicht gefunden." });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.download(dbPath, `gastrodash-backup-${stamp}.db`);
  } catch (error) {
    res.status(400).json({ error: error.message || "Export fehlgeschlagen." });
  }
});

app.post("/api/admin/db/import", requireAdmin, dbUpload.single("database"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Bitte eine Datenbankdatei auswählen." });
  }
  const extension = path.extname(req.file.originalname || "").toLowerCase();
  if (extension && ![".db", ".sqlite", ".sqlite3"].includes(extension)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "Nur .db, .sqlite oder .sqlite3 Dateien sind erlaubt." });
  }

  let backupPath = null;
  try {
    const dbPath = resolveDatabaseFilePath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    backupPath = `${dbPath}.bak-${Date.now()}`;

    await prisma.$disconnect();

    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, backupPath);
    }
    fs.copyFileSync(req.file.path, dbPath);

    emitProductsChanged();
    emitOrdersChanged();
    emitSettingsChanged();
    res.json({ success: true, backup: backupPath ? path.basename(backupPath) : null });
  } catch (error) {
    try {
      if (backupPath && fs.existsSync(backupPath)) {
        const dbPath = resolveDatabaseFilePath();
        fs.copyFileSync(backupPath, dbPath);
      }
    } catch {}
    res.status(500).json({ error: "Import fehlgeschlagen. Backup wurde wiederhergestellt." });
  } finally {
    try {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch {}
  }
});

app.put("/api/admin/users", requireAdmin, async (req, res) => {
  const {
    adminUsername,
    adminPassword,
    managerUsername,
    managerPassword
  } = req.body || {};

  const safeAdminUsername = normalizeText(adminUsername);
  const safeManagerUsername = normalizeText(managerUsername);
  const safeAdminPassword = normalizeText(adminPassword);
  const safeManagerPassword = normalizeText(managerPassword);

  if (!safeAdminUsername || !safeManagerUsername) {
    return res.status(400).json({ error: "Benutzernamen sind erforderlich" });
  }
  if (safeAdminUsername === safeManagerUsername) {
    return res.status(400).json({ error: "Admin- und Manager-Benutzername müssen unterschiedlich sein" });
  }
  if (!safeAdminPassword || safeAdminPassword.length < 4) {
    return res.status(400).json({ error: "Admin-Passwort muss mindestens 4 Zeichen haben" });
  }
  if (!safeManagerPassword || safeManagerPassword.length < 4) {
    return res.status(400).json({ error: "Manager-Passwort muss mindestens 4 Zeichen haben" });
  }

  const adminHash = await bcrypt.hash(safeAdminPassword, 10);
  const managerHash = await bcrypt.hash(safeManagerPassword, 10);

  await prisma.$transaction(async (tx) => {
    const existingAdmin = await tx.user.findFirst({ where: { role: UserRole.ADMIN } });
    const existingManager = await tx.user.findFirst({ where: { role: UserRole.MANAGER } });

    if (existingAdmin) {
      await tx.user.update({
        where: { id: existingAdmin.id },
        data: {
          username: safeAdminUsername,
          passwordHash: adminHash,
          role: UserRole.ADMIN
        }
      });
    } else {
      await tx.user.create({
        data: {
          username: safeAdminUsername,
          passwordHash: adminHash,
          role: UserRole.ADMIN
        }
      });
    }

    if (existingManager) {
      await tx.user.update({
        where: { id: existingManager.id },
        data: {
          username: safeManagerUsername,
          passwordHash: managerHash,
          role: UserRole.MANAGER
        }
      });
    } else {
      await tx.user.create({
        data: {
          username: safeManagerUsername,
          passwordHash: managerHash,
          role: UserRole.MANAGER
        }
      });
    }
  });

  setEnvValue("ADMIN_USERNAME", safeAdminUsername);
  setEnvValue("ADMIN_PASSWORD", safeAdminPassword);
  setEnvValue("MANAGER_USERNAME", safeManagerUsername);
  setEnvValue("MANAGER_PASSWORD", safeManagerPassword);

  res.json({
    success: true,
    adminUsername: safeAdminUsername,
    managerUsername: safeManagerUsername
  });
});

app.use((error, req, res, next) => {
  if (error && error.message) {
    return res.status(400).json({ error: error.message });
  }
  next(error);
});

app.get("/api/admin/products", requireAdmin, async (req, res) => {
  const products = await prisma.product.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  res.json(products);
});

app.get("/api/admin/categories", requireAdmin, async (req, res) => {
  const products = await prisma.product.findMany({
    where: { category: { not: null } },
    select: { category: true }
  });
  const categories = [...new Set(products.map((p) => (p.category || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  res.json(categories);
});

async function validateAndBuildProductData(raw, existingImageUrl = null) {
  const { name, category, price, showPrice, imageUrl, orderLimit, sortOrder, isActive, isSoldOut } = raw || {};

  if (!name || !String(name).trim()) {
    return { error: "Name ist erforderlich" };
  }

  const parsedPrice = price == null || price === "" ? null : Number(price);
  if (parsedPrice != null && Number.isNaN(parsedPrice)) {
    return { error: "Preis ist ungültig" };
  }

  const safeImageUrl = normalizeText(imageUrl) || existingImageUrl;
  if (!safeImageUrl) {
    return { error: "Produktbild per Upload oder URL ist Pflicht." };
  }

  const parsedOrderLimit = Number(orderLimit);
  if (!Number.isInteger(parsedOrderLimit) || parsedOrderLimit < 1 || parsedOrderLimit > MAX_ORDER_QUANTITY) {
    return { error: `Bestelllimit muss zwischen 1 und ${MAX_ORDER_QUANTITY} liegen.` };
  }

  return {
    data: {
      name: String(name).trim(),
      category: normalizeText(category),
      price: parsedPrice,
      showPrice: parseBool(showPrice, true),
      imageUrl: safeImageUrl,
      orderLimit: parsedOrderLimit,
      sortOrder: Number.isInteger(sortOrder) ? sortOrder : Number(sortOrder) || 0,
      isActive: parseBool(isActive, true),
      isSoldOut: parseBool(isSoldOut, false)
    }
  };
}

app.post("/api/admin/products", requireAdmin, async (req, res) => {
  const settings = await withSettings();
  const count = await prisma.product.count();
  if (count >= settings.productLimit) {
    return res.status(400).json({ error: `Produktlimit (${settings.productLimit}) erreicht.` });
  }

  const validated = await validateAndBuildProductData(req.body, null);
  if (validated.error) {
    return res.status(400).json({ error: validated.error });
  }

  const product = await prisma.product.create({ data: validated.data });
  emitProductsChanged();
  res.status(201).json(product);
});

app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Ungültige Produkt-ID" });
  }

  const current = await prisma.product.findUnique({ where: { id } });
  if (!current) {
    return res.status(404).json({ error: "Produkt nicht gefunden" });
  }

  const validated = await validateAndBuildProductData(req.body, current.imageUrl);
  if (validated.error) {
    return res.status(400).json({ error: validated.error });
  }

  const product = await prisma.product.update({ where: { id }, data: validated.data });
  emitProductsChanged();
  res.json(product);
});

app.patch("/api/admin/products/:id/quick", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Ungültige Produkt-ID" });
  }

  const data = {};
  if (req.body.isActive !== undefined) {
    data.isActive = parseBool(req.body.isActive, true);
  }
  if (req.body.isSoldOut !== undefined) {
    data.isSoldOut = parseBool(req.body.isSoldOut, false);
  }

  if (!Object.keys(data).length) {
    return res.status(400).json({ error: "Keine Änderungen übergeben" });
  }

  try {
    const product = await prisma.product.update({ where: { id }, data });
    emitProductsChanged();
    res.json(product);
  } catch {
    res.status(404).json({ error: "Produkt nicht gefunden" });
  }
});

app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Ungültige Produkt-ID" });
  }

  try {
    await prisma.product.delete({ where: { id } });
    emitProductsChanged();
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: "Produkt nicht gefunden" });
  }
});

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  const status = String(req.query.status || "LIVE").toUpperCase();
  const safeStatus = status === "ARCHIVE" ? OrderStatus.ARCHIVE : OrderStatus.LIVE;

  const orders = await prisma.order.findMany({
    where: { status: safeStatus },
    orderBy: [{ createdAt: "desc" }],
    include: { items: true }
  });

  const filtered = withOrderSearch(orders, req.query.q, req.query.table);
  res.json(filtered.map(mapOrder));
});

app.get("/api/live/orders", requireBoard, async (req, res) => {
  const status = String(req.query.status || "LIVE").toUpperCase();
  const safeStatus = status === "ARCHIVE" ? OrderStatus.ARCHIVE : OrderStatus.LIVE;
  const orders = await prisma.order.findMany({
    where: { status: safeStatus },
    orderBy: [{ createdAt: "desc" }],
    include: { items: true }
  });
  const filtered = withOrderSearch(orders, req.query.q, req.query.table);
  res.json(filtered.map(mapOrder));
});

app.patch("/api/admin/orders/:id/status", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Ungültige Bestell-ID" });
  }
  if (![OrderStatus.LIVE, OrderStatus.ARCHIVE].includes(status)) {
    return res.status(400).json({ error: "Status muss LIVE oder ARCHIVE sein" });
  }

  try {
    const order = await prisma.order.update({ where: { id }, data: { status }, include: { items: true } });
    emitOrdersChanged();
    res.json(mapOrder(order));
  } catch {
    res.status(404).json({ error: "Bestellung nicht gefunden" });
  }
});

app.patch("/api/live/orders/:id/status", requireBoard, async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Ungültige Bestell-ID" });
  }
  if (![OrderStatus.LIVE, OrderStatus.ARCHIVE].includes(status)) {
    return res.status(400).json({ error: "Status muss LIVE oder ARCHIVE sein" });
  }
  try {
    const order = await prisma.order.update({ where: { id }, data: { status }, include: { items: true } });
    emitOrdersChanged();
    res.json(mapOrder(order));
  } catch {
    res.status(404).json({ error: "Bestellung nicht gefunden" });
  }
});

app.delete("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body || {};

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Ungültige Bestell-ID" });
  }

  const settings = await withSettings();
  const ok = await passwordMatches(settings, password);
  if (!ok) {
    return res.status(401).json({ error: "Passwort ist falsch" });
  }

  try {
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order || order.status !== OrderStatus.ARCHIVE) {
      return res.status(400).json({ error: "Nur abgeschlossene Einträge können gelöscht werden" });
    }

    await prisma.order.delete({ where: { id } });
    emitOrdersChanged();
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: "Bestellung nicht gefunden" });
  }
});

app.delete("/api/live/orders/:id", requireBoard, async (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body || {};
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Ungültige Bestell-ID" });
  }
  const settings = await withSettings();
  const ok = await passwordMatches(settings, password);
  if (!ok) {
    return res.status(401).json({ error: "Passwort ist falsch" });
  }
  try {
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order || order.status !== OrderStatus.ARCHIVE) {
      return res.status(400).json({ error: "Nur abgeschlossene Einträge können gelöscht werden" });
    }
    await prisma.order.delete({ where: { id } });
    emitOrdersChanged();
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: "Bestellung nicht gefunden" });
  }
});

app.patch("/api/live/products/overall", requireBoard, async (req, res) => {
  const { mode } = req.body || {};
  if (!["ENABLE_ALL", "DISABLE_ALL"].includes(mode)) {
    return res.status(400).json({ error: "mode muss ENABLE_ALL oder DISABLE_ALL sein" });
  }
  if (mode === "ENABLE_ALL") {
    await prisma.product.updateMany({ data: { isActive: true, isSoldOut: false } });
  } else {
    await prisma.product.updateMany({ data: { isActive: false, isSoldOut: true } });
  }
  emitProductsChanged();
  res.json({ success: true, mode });
});

app.post("/api/admin/maintenance/clear-products", requireAdmin, async (req, res) => {
  await prisma.$transaction(async (tx) => {
    await tx.orderItem.deleteMany({});
    await tx.product.deleteMany({});
  });
  emitProductsChanged();
  emitOrdersChanged();
  res.json({ success: true });
});

app.post("/api/admin/maintenance/clear-archive", requireAdmin, async (req, res) => {
  await prisma.order.deleteMany({ where: { status: OrderStatus.ARCHIVE } });
  emitOrdersChanged();
  res.json({ success: true });
});

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  const orders = await prisma.order.findMany({
    orderBy: [{ createdAt: "desc" }],
    include: { items: true }
  });

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const liveCount = orders.filter((o) => o.status === OrderStatus.LIVE).length;
  const archiveOrders = orders.filter((o) => o.status === OrderStatus.ARCHIVE);
  const todayCount = orders.filter((o) => new Date(o.createdAt) >= todayStart).length;

  const avgArchiveMinutes = archiveOrders.length
    ? archiveOrders.reduce((acc, o) => acc + (new Date(o.updatedAt) - new Date(o.createdAt)) / 60000, 0) / archiveOrders.length
    : 0;

  const perDayMap = new Map();
  for (let i = 0; i < 14; i += 1) {
    const d = new Date(todayStart);
    d.setDate(d.getDate() - i);
    perDayMap.set(d.toISOString().slice(0, 10), 0);
  }
  for (const o of orders) {
    const key = new Date(o.createdAt).toISOString().slice(0, 10);
    if (perDayMap.has(key)) {
      perDayMap.set(key, perDayMap.get(key) + 1);
    }
  }

  const perDay = [...perDayMap.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const topProductsMap = new Map();
  for (const order of orders) {
    for (const item of order.items) {
      const key = item.snapshotName || "Unbekannt";
      topProductsMap.set(key, (topProductsMap.get(key) || 0) + item.quantity);
    }
  }
  const topProducts = [...topProductsMap.entries()]
    .map(([name, quantity]) => ({ name, quantity }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 10);

  const recentOrders = orders.slice(0, 200).map((o) => ({
    id: o.id,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    status: o.status,
    customerName: o.customerName,
    tableLabel: o.tableLabel,
    note: o.note,
    itemCount: o.items.reduce((acc, i) => acc + i.quantity, 0),
    durationMinutes: Number(((new Date(o.updatedAt) - new Date(o.createdAt)) / 60000).toFixed(1))
  }));

  res.json({
    summary: {
      totalOrders: orders.length,
      todayOrders: todayCount,
      liveOrders: liveCount,
      archivedOrders: archiveOrders.length,
      avgArchiveMinutes: Number(avgArchiveMinutes.toFixed(1))
    },
    topProducts,
    perDay,
    recentOrders
  });
});

app.get("/api/live/products", requireBoard, async (req, res) => {
  const products = await prisma.product.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
  });
  res.json(products);
});

app.patch("/api/live/products/:id/quick", requireBoard, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Ungültige Produkt-ID" });
  }
  const data = {};
  if (req.body.isActive !== undefined) {
    data.isActive = parseBool(req.body.isActive, true);
  }
  if (req.body.isSoldOut !== undefined) {
    data.isSoldOut = parseBool(req.body.isSoldOut, false);
  }
  if (!Object.keys(data).length) {
    return res.status(400).json({ error: "Keine Änderungen übergeben" });
  }
  try {
    const product = await prisma.product.update({ where: { id }, data });
    emitProductsChanged();
    res.json(product);
  } catch {
    res.status(404).json({ error: "Produkt nicht gefunden" });
  }
});

io.on("connection", () => {});

async function start() {
  try {
    await ensureDefaults();
    server.listen(PORT, () => {
      console.log(`Server läuft auf Port ${PORT}`);
    });
  } catch (error) {
    console.error("Serverstart fehlgeschlagen", error);
    process.exit(1);
  }
}

start();

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
