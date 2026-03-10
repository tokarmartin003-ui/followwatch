require("dotenv").config();
"use strict";
var express = require("express");
var session = require("express-session");
var FileStore = require("session-file-store")(session);
var cors = require("cors");
var cron = require("node-cron");
var path = require("path");
var fs = require("fs");
var helmet = require("helmet");
var rateLimit = require("express-rate-limit");
var igModule = require("instagram-private-api");
var IgApiClient = igModule.IgApiClient;
var IgCheckpointError = igModule.IgCheckpointError;
var IgLoginTwoFactorRequiredError = igModule.IgLoginTwoFactorRequiredError;
var PORT = process.env.PORT || 3000;
var IS_PROD = process.env.NODE_ENV === "production";
var DB_PATH = path.join(__dirname, "db.json");
var SESSIONS_PATH = path.join(__dirname, "sessions");
var PROXY_URL = process.env.PROXY_URL || null;
var SUPABASE_URL = process.env.SUPABASE_URL || "";
var SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
var SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";
var STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
var STRIPE_PRO_LINK = "https://buy.stripe.com/eVqcN5gi5e0JdysgS91B600";

function log(tag, msg) {
  var t = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log("[" + t + "] [" + tag + "] " + msg);
}
function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}
function fmtDate(ts) {
  return new Date(ts).toLocaleString("en-US", {
    weekday: "short", month: "long", day: "numeric",
    year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}

// ── DB ──────────────────────────────────────────────────────────
function dbRead() {
  if (!fs.existsSync(DB_PATH)) {
    var blank = { accounts: {}, spyTargets: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(blank, null, 2));
    return blank;
  }
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
  catch (e) { log("db", "Read error: " + e.message); return { accounts: {}, spyTargets: {} }; }
}
function dbWrite(data) {
  var tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

var igSessions = {};
var pendingLogins = {};
var syncLocks = {};

// ── IG CLIENT ────────────────────────────────────────────────────
function makeIgClient(username) {
  var ig = new IgApiClient();
  ig.state.generateDevice(username);
  if (PROXY_URL) { ig.state.proxyUrl = PROXY_URL; log("proxy", "@" + username + " routed through proxy"); }
  return ig;
}

async function fetchAllFollowers(ig, userId, onCount) {
  var feed = ig.feed.accountFollowers(userId);
  var results = [];
  var page = 0;
  do {
    var items;
    var lastErr;
    for (var attempt = 1; attempt <= 3; attempt++) {
      try { items = await feed.items(); lastErr = null; break; }
      catch (err) {
        lastErr = err;
        if (attempt < 3) { log("fetch", "Page " + page + " attempt " + attempt + " failed, retrying..."); await sleep(2000); }
      }
    }
    if (lastErr) throw lastErr;
    for (var i = 0; i < items.length; i++) {
      var u = items[i];
      results.push({ pk: String(u.pk), username: u.username || "", full_name: u.full_name || "", profile_pic_url: u.profile_pic_url || "" });
    }
    page++;
    if (onCount) onCount(results.length);
    await sleep(page % 5 === 0 ? 2000 : 900);
    if (page > 300) break;
  } while (feed.isMoreAvailable());
  return results;
}

function compareFollowers(oldList, newList) {
  var newPKs = new Set(newList.map(function(u) { return u.pk; }));
  var oldPKs = new Set(oldList.map(function(u) { return u.pk; }));
  var ts = Date.now();
  var fmt = fmtDate(ts);
  var unfollowers = oldList.filter(function(u) { return !newPKs.has(u.pk); }).map(function(u) {
    return Object.assign({}, u, { unfollowedAt: ts, unfollowedAtFormatted: fmt, dismissed: false });
  });
  var gained = newList.filter(function(u) { return !oldPKs.has(u.pk); }).map(function(u) {
    return Object.assign({}, u, { followedAt: ts, followedAtFormatted: fmt });
  });
  return { unfollowers: unfollowers, gained: gained };
}

async function finalizeIgLogin(ig, user, igUsername, appUser) {
  var serialized = await ig.state.serialize();
  delete serialized.constants;
  igSessions[appUser] = { ig: ig, userId: String(user.pk), igUsername: igUsername };
  delete pendingLogins[appUser];
  var db = dbRead();
  var existing = db.accounts[appUser] || {};
  db.accounts[appUser] = {
    appUser: appUser,
    igUsername: igUsername,
    userId: String(user.pk),
    fullName: user.full_name || existing.fullName || "",
    profilePic: user.profile_pic_url || existing.profilePic || "",
    currentFollowers: existing.currentFollowers || [],
    unfollowers: existing.unfollowers || [],
    gainedFollowers: existing.gainedFollowers || [],
    snapshots: existing.snapshots || [],
    tracking: existing.tracking || false,
    lastChecked: existing.lastChecked || null,
    sessionState: serialized,
    isPro: existing.isPro || false,
    reviewGiven: existing.reviewGiven || false,
    unlockedSlots: existing.unlockedSlots || 0,
    credits: existing.credits || 0,
    adWatched: existing.adWatched || false,
    email: existing.email || ""
  };
  dbWrite(db);
  log("auth", "IG @" + igUsername + " connected for app user " + appUser);
}

function isValidUserId(uid) {
  return uid && uid !== "undefined" && uid !== "null" && uid !== "";
}

async function rehydrate(appUser) {
  if (igSessions[appUser] && isValidUserId(igSessions[appUser].userId)) {
    return igSessions[appUser];
  }
  var db = dbRead();
  var account = db.accounts[appUser];
  if (!account || !account.sessionState) return null;
  try {
    var ig = makeIgClient(account.igUsername);
    await ig.state.deserialize(account.sessionState);
    var userId = account.userId;
    if (!isValidUserId(userId)) {
      log("session", "@" + account.igUsername + " userId missing - fetching from Instagram");
      try {
        var currentUser = await ig.account.currentUser();
        userId = String(currentUser.pk);
        db.accounts[appUser].userId = userId;
        dbWrite(db);
        log("session", "@" + account.igUsername + " userId recovered: " + userId);
      } catch (fetchErr) {
        log("session", "@" + account.igUsername + " userId recovery failed: " + fetchErr.message);
        return null;
      }
    }
    igSessions[appUser] = { ig: ig, userId: userId, igUsername: account.igUsername };
    log("session", "IG @" + account.igUsername + " restored from disk");
    return igSessions[appUser];
  } catch (e) {
    log("session", "Restore failed: " + e.message);
    return null;
  }
}

async function runSync(appUser, onProgress) {
  if (syncLocks[appUser]) throw new Error("SYNC_IN_PROGRESS");
  syncLocks[appUser] = true;
  function notify(msg, pct) { if (onProgress) onProgress(msg, pct); }
  try {
    var s = await rehydrate(appUser);
    if (!s) throw new Error("SESSION_EXPIRED");
    if (!isValidUserId(s.userId)) throw new Error("USER_ID_MISSING");
    notify("Connecting to Instagram...", 5);
    var db = dbRead();
    var account = db.accounts[appUser];
    if (!account) throw new Error("Account not found in database");
    notify("Fetching your followers...", 10);
    var newFollowers = await fetchAllFollowers(s.ig, s.userId, function(count) {
      notify("Fetching followers... " + count + " loaded", Math.min(10 + Math.floor(count / 50), 75));
    });
    notify("Comparing with previous snapshot...", 80);
    var oldFollowers = account.currentFollowers || [];
    var isBaseline = oldFollowers.length === 0;
    var compared = isBaseline ? { unfollowers: [], gained: [] } : compareFollowers(oldFollowers, newFollowers);
    var existingUMap = {};
    (account.unfollowers || []).forEach(function(u) { existingUMap[u.pk] = u; });
    compared.unfollowers.forEach(function(u) { if (!existingUMap[u.pk]) existingUMap[u.pk] = u; });
    var mergedUnfollowers = Object.values(existingUMap);
    var existingGMap = {};
    (account.gainedFollowers || []).forEach(function(u) { existingGMap[u.pk] = u; });
    compared.gained.forEach(function(u) { existingGMap[u.pk] = u; });
    var mergedGained = Object.values(existingGMap).slice(-200);
    var ts = Date.now();
    account.currentFollowers = newFollowers;
    account.unfollowers = mergedUnfollowers;
    account.gainedFollowers = mergedGained;
    account.snapshots = (account.snapshots || []).slice(-49).concat([{
      timestamp: ts, count: newFollowers.length,
      unfollowed: compared.unfollowers.length, gained: compared.gained.length
    }]);
    account.lastChecked = ts;
    account.tracking = true;
    dbWrite(db);
    notify("Done!", 100);
    log("sync", "@" + account.igUsername + ": " + newFollowers.length + " followers | -" + compared.unfollowers.length + " | +" + compared.gained.length);
    return {
      isBaseline: isBaseline,
      followerCount: newFollowers.length,
      newUnfollowers: compared.unfollowers.length,
      gained: compared.gained.length,
      totalUnfollowers: mergedUnfollowers.filter(function(u) { return !u.dismissed; }).length
    };
  } finally {
    delete syncLocks[appUser];
  }
}

async function verifySupabaseToken(token) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) { log("auth", "Supabase not configured"); return null; }
  try {
    var https = require("https");
    var http = require("http");
    var url = new URL(SUPABASE_URL + "/auth/v1/user");
    var mod = url.protocol === "https:" ? https : http;
    return new Promise(function(resolve) {
      var req = mod.request(url, { method: "GET", headers: { "Authorization": "Bearer " + token, "apikey": SUPABASE_SECRET_KEY } }, function(res) {
        var body = "";
        res.on("data", function(chunk) { body += chunk; });
        res.on("end", function() {
          try { var user = JSON.parse(body); resolve(user && user.id ? user : null); }
          catch (e) { resolve(null); }
        });
      });
      req.on("error", function() { resolve(null); });
      req.end();
    });
  } catch (e) { log("auth", "Token verify error: " + e.message); return null; }
}

function authMiddleware(req, res, next) {
  var appUser = req.session && req.session.appUser;
  if (appUser) { req.appUser = appUser; return next(); }
  return res.status(401).json({ error: "Not logged in" });
}

var app = express();
app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", function(req, res) {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

app.get("/app", function(req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (!fs.existsSync(SESSIONS_PATH)) fs.mkdirSync(SESSIONS_PATH, { recursive: true });
app.use(session({
  store: new FileStore({ path: SESSIONS_PATH, ttl: 30 * 24 * 60 * 60, reapInterval: 3600, logFn: function() {} }),
  secret: "fw-" + (process.env.SESSION_SECRET || "followwatch2024xK9"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? "none" : "lax"
  }
}));

var authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: "Too many requests, please try again later." } });
var igLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: "Too many login attempts, please try again later." } });
app.use("/api/auth/login", authLimiter);
app.use("/api/ig/connect", igLimiter);
app.use("/api/ig/verify-checkpoint", igLimiter);
app.use("/api/ig/verify-2fa", igLimiter);

// ── AUTH ─────────────────────────────────────────────────────────
app.post("/api/auth/login", async function(req, res) {
  var token = req.body.token;
  var email = req.body.email;
  var userId = req.body.userId;
  if (!token || !userId) return res.status(400).json({ error: "Missing authentication data." });
  var user = await verifySupabaseToken(token);
  if (!user || user.id !== userId) return res.status(401).json({ error: "Invalid session. Please log in again." });
  req.session.appUser = userId;
  req.session.email = email || user.email || "";
  var db = dbRead();
  if (db.accounts[userId]) {
    db.accounts[userId].email = email || user.email || "";
    dbWrite(db);
  }
  var account = db.accounts[userId];
  var igConnected = !!(account && account.igUsername);
  log("auth", "App login: " + (email || userId));
  return res.json({
    success: true,
    appUser: userId,
    email: email || user.email || "",
    igConnected: igConnected,
    igUsername: igConnected ? account.igUsername : null,
    isPro: account ? (account.isPro || false) : false
  });
});

app.get("/api/auth/status", function(req, res) {
  var appUser = req.session.appUser;
  if (!appUser) return res.json({ loggedIn: false });
  var db = dbRead();
  var account = db.accounts[appUser];
  var igConnected = !!(account && account.igUsername);
  return res.json({
    loggedIn: true, appUser: appUser, email: req.session.email || "",
    igConnected: igConnected, igUsername: igConnected ? account.igUsername : null,
    isPro: account ? (account.isPro || false) : false,
    reviewGiven: account ? (account.reviewGiven || false) : false
  });
});

app.post("/api/auth/logout", function(req, res) {
  var appUser = req.session.appUser;
  if (appUser) { delete igSessions[appUser]; delete pendingLogins[appUser]; log("auth", "Logged out: " + appUser); }
  req.session.destroy(function() {});
  return res.json({ success: true });
});

// ── IG CONNECT ────────────────────────────────────────────────────
app.post("/api/ig/connect", async function(req, res) {
  var appUser = req.session.appUser;
  if (!appUser) return res.status(401).json({ error: "Not logged in" });
  var username = req.body.username;
  var password = req.body.password;
  if (!username || !password) return res.status(400).json({ error: "Username and password are required." });
  var clean = username.trim().toLowerCase().replace(/^@/, "");
  var ig = makeIgClient(clean);
  try {
    await ig.simulate.preLoginFlow();
    var user = await ig.account.login(clean, password);
    try { await ig.simulate.postLoginFlow(); } catch (e) {}
    await finalizeIgLogin(ig, user, clean, appUser);
    return res.json({ success: true, igUsername: clean, fullName: user.full_name || "" });
  } catch (err) {
    var errMsg = (err.message || "").toLowerCase();
    var errBody = {};
    try { errBody = err.response && err.response.body ? err.response.body : {}; } catch (e) {}
    log("ig-login", "Error for @" + clean + ": " + err.message);
    var isCheckpoint = (err instanceof IgCheckpointError || errMsg.includes("checkpoint") || errMsg.includes("challenge"));
    if (isCheckpoint) {
      var triggered = false;
      if (!triggered) { try { await ig.challenge.auto(true); triggered = true; } catch (e1) {} }
      if (!triggered) { try { await ig.challenge.selectVerifyMethod("1"); triggered = true; } catch (e2) {} }
      if (!triggered) { try { await ig.challenge.selectVerifyMethod("0"); triggered = true; } catch (e3) {} }
      if (triggered) {
        pendingLogins[appUser] = { ig: ig, type: "checkpoint", igUsername: clean };
        return res.json({ status: "checkpoint", message: "Instagram sent a verification code. Check your email or SMS." });
      }
      return res.status(403).json({ error: "Instagram is blocking this login. Open the Instagram app to verify." });
    }
    var isTwoFactor = (err instanceof IgLoginTwoFactorRequiredError || errMsg.includes("two_factor"));
    if (isTwoFactor) {
      var info = {};
      try { info = err.response.body.two_factor_info || {}; } catch (e) {}
      var methods = [];
      if (info.totp_two_factor_on) methods.push("totp");
      if (info.sms_two_factor_on) methods.push("sms");
      if (info.whatsapp_two_factor_on) methods.push("whatsapp");
      if (methods.length === 0) methods.push("sms");
      pendingLogins[appUser] = { ig: ig, type: "twofactor", twoFactorInfo: info, igUsername: clean };
      return res.json({ status: "twofactor", methods: methods });
    }
    var isBadPassword = (errMsg.includes("bad_password") || errMsg.includes("invalid_user") || errMsg.includes("incorrect"));
    if (isBadPassword) return res.status(401).json({ error: "Incorrect username or password." });
    return res.status(500).json({ error: "Login failed: " + (err.message || "Unknown error") });
  }
});

app.post("/api/ig/verify-checkpoint", async function(req, res) {
  var appUser = req.session.appUser;
  if (!appUser) return res.status(401).json({ error: "Not logged in" });
  var code = req.body.code;
  if (!code) return res.status(400).json({ error: "Code is required." });
  var pending = pendingLogins[appUser];
  if (!pending || pending.type !== "checkpoint") return res.status(400).json({ error: "No pending checkpoint." });
  try {
    var user = await pending.ig.challenge.sendSecurityCode(code.trim());
    try { await pending.ig.simulate.postLoginFlow(); } catch (e) {}
    await finalizeIgLogin(pending.ig, user, pending.igUsername, appUser);
    return res.json({ success: true, igUsername: pending.igUsername, fullName: user.full_name || "" });
  } catch (err) {
    var msg = (err.message || "").toLowerCase();
    if (msg.includes("wrong") || msg.includes("incorrect") || msg.includes("invalid") || msg.includes("code")) return res.status(400).json({ error: "Wrong code. Please try again." });
    return res.status(500).json({ error: "Verification failed: " + err.message });
  }
});

app.post("/api/ig/verify-2fa", async function(req, res) {
  var appUser = req.session.appUser;
  if (!appUser) return res.status(401).json({ error: "Not logged in" });
  var code = req.body.code;
  var method = req.body.method;
  if (!code) return res.status(400).json({ error: "Code is required." });
  var pending = pendingLogins[appUser];
  if (!pending || pending.type !== "twofactor") return res.status(400).json({ error: "No pending 2FA." });
  try {
    var ig = pending.ig;
    var twoFactorInfo = pending.twoFactorInfo || {};
    var verificationMethod = "1";
    if (method === "totp") verificationMethod = "0";
    if (method === "whatsapp") verificationMethod = "2";
    var user = await ig.account.twoFactorLogin({
      username: twoFactorInfo.username || pending.igUsername,
      verificationCode: code.trim().replace(/\s+/g, ""),
      twoFactorIdentifier: twoFactorInfo.two_factor_identifier || "",
      verificationMethod: verificationMethod,
      trustThisDevice: "1"
    });
    try { await ig.simulate.postLoginFlow(); } catch (e) {}
    await finalizeIgLogin(ig, user, pending.igUsername, appUser);
    return res.json({ success: true, igUsername: pending.igUsername, fullName: user.full_name || "" });
  } catch (err) {
    var msg = (err.message || "").toLowerCase();
    if (msg.includes("wrong") || msg.includes("incorrect") || msg.includes("invalid") || msg.includes("code")) return res.status(400).json({ error: "Wrong code. Please try again." });
    return res.status(500).json({ error: "2FA failed: " + err.message });
  }
});

// ── SYNC ─────────────────────────────────────────────────────────
app.get("/api/sync", authMiddleware, async function(req, res) {
  var appUser = req.appUser;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  var keepAlive = setInterval(function() { try { res.write(": ping\n\n"); } catch (e) { clearInterval(keepAlive); } }, 20000);
  function send(payload) { try { res.write("data: " + JSON.stringify(payload) + "\n\n"); } catch (e) {} }
  try {
    var result = await runSync(appUser, function(message, pct) { send({ type: "progress", message: message, pct: pct }); });
    send({ type: "done", result: result });
  } catch (err) {
    var errMsg = err.message || "Unknown error";
    if (errMsg === "SESSION_EXPIRED") send({ type: "error", message: "Instagram session expired. Please reconnect." });
    else if (errMsg === "SYNC_IN_PROGRESS") send({ type: "error", message: "A sync is already running." });
    else if (errMsg === "USER_ID_MISSING") send({ type: "error", message: "Could not retrieve your Instagram user ID. Please reconnect." });
    else send({ type: "error", message: "Sync failed: " + errMsg });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

// ── DATA ─────────────────────────────────────────────────────────
app.get("/api/data", authMiddleware, function(req, res) {
  var appUser = req.appUser;
  var db = dbRead();
  var account = db.accounts[appUser];
  if (!account) return res.status(404).json({ error: "Account not found" });
  var allUnfollowers = (account.unfollowers || []).filter(function(u) { return !u.dismissed; });
  var isPro = account.isPro || false;
  var unlockedSlots = account.unlockedSlots || 0;
  var visibleCount = isPro ? allUnfollowers.length : unlockedSlots;
  var visibleUnfollowers = allUnfollowers.slice(0, visibleCount);
  var hiddenCount = isPro ? 0 : Math.max(0, allUnfollowers.length - visibleCount);
  return res.json({
    igUsername: account.igUsername,
    fullName: account.fullName || "",
    profilePic: account.profilePic || "",
    followerCount: (account.currentFollowers || []).length,
    unfollowers: visibleUnfollowers,
    totalUnfollowers: allUnfollowers.length,
    hiddenUnfollowers: hiddenCount,
    reviewGiven: account.reviewGiven || false,
    unlockedSlots: unlockedSlots,
    dismissedCount: (account.unfollowers || []).filter(function(u) { return u.dismissed; }).length,
    gainedFollowers: (account.gainedFollowers || []).slice(-50).reverse(),
    snapshots: account.snapshots || [],
    lastChecked: account.lastChecked || null,
    tracking: account.tracking || false,
    isBaseline: (account.currentFollowers || []).length === 0,
    syncInProgress: !!syncLocks[appUser],
    isPro: isPro
  });
});

// ── CREDITS ───────────────────────────────────────────────────────
app.get("/api/credits", authMiddleware, function(req, res) {
  var db = dbRead();
  var account = db.accounts[req.appUser];
  if (!account) return res.status(404).json({ error: "Not found" });
  return res.json({
    credits: account.credits || 0,
    adWatched: account.adWatched || false,
    reviewGiven: account.reviewGiven || false,
    unlockedSlots: account.unlockedSlots || 0
  });
});

app.post("/api/credits/ad-watched", authMiddleware, function(req, res) {
  var db = dbRead();
  var account = db.accounts[req.appUser];
  if (!account) return res.status(404).json({ error: "Not found" });
  account.credits = (account.credits || 0) + 2;
  account.adWatched = true;
  dbWrite(db);
  log("credits", req.appUser + " earned 2 credits via ad");
  return res.json({ success: true, credits: account.credits });
});

app.post("/api/credits/review-given", authMiddleware, function(req, res) {
  var db = dbRead();
  var account = db.accounts[req.appUser];
  if (!account) return res.status(404).json({ error: "Not found" });
  if (account.reviewGiven) return res.json({ success: false, error: "Review bonus already claimed" });
  account.credits = (account.credits || 0) + 3;
  account.reviewGiven = true;
  dbWrite(db);
  log("credits", req.appUser + " earned 3 credits via review");
  return res.json({ success: true, credits: account.credits });
});

app.post("/api/credits/unlock-unfollower", authMiddleware, function(req, res) {
  var db = dbRead();
  var account = db.accounts[req.appUser];
  if (!account) return res.status(404).json({ error: "Not found" });
  if ((account.credits || 0) < 5) return res.status(400).json({ error: "Not enough credits" });
  account.credits = (account.credits || 0) - 5;
  account.unlockedSlots = (account.unlockedSlots || 0) + 1;
  dbWrite(db);
  log("credits", req.appUser + " spent 5 credits to unlock 1 slot");
  return res.json({ success: true, credits: account.credits, unlockedSlots: account.unlockedSlots });
});

// ── DISMISS ───────────────────────────────────────────────────────
app.post("/api/dismiss/:pk", authMiddleware, function(req, res) {
  var db = dbRead();
  var account = db.accounts[req.appUser];
  if (!account) return res.status(404).json({ error: "Not found" });
  var entry = (account.unfollowers || []).find(function(u) { return u.pk === req.params.pk; });
  if (entry) entry.dismissed = true;
  dbWrite(db);
  return res.json({ success: true });
});

app.post("/api/dismiss-all", authMiddleware, function(req, res) {
  var db = dbRead();
  var account = db.accounts[req.appUser];
  if (!account) return res.status(404).json({ error: "Not found" });
  (account.unfollowers || []).forEach(function(u) { u.dismissed = true; });
  dbWrite(db);
  return res.json({ success: true });
});

// ── DATA MANAGEMENT ───────────────────────────────────────────────
app.post("/api/clear-data", authMiddleware, function(req, res) {
  var db = dbRead();
  var account = db.accounts[req.appUser];
  if (!account) return res.status(404).json({ error: "Not found" });
  account.currentFollowers = [];
  account.unfollowers = [];
  account.gainedFollowers = [];
  account.snapshots = [];
  account.tracking = false;
  account.lastChecked = null;
  dbWrite(db);
  log("data", req.appUser + " cleared all data");
  return res.json({ success: true });
});

app.delete("/api/delete-account", authMiddleware, function(req, res) {
  var appUser = req.appUser;
  var db = dbRead();
  delete db.accounts[appUser];
  if (db.spyTargets) delete db.spyTargets[appUser];
  dbWrite(db);
  delete igSessions[appUser];
  req.session.destroy(function() {});
  log("data", appUser + " deleted account");
  return res.json({ success: true });
});

// ── PRO ───────────────────────────────────────────────────────────
app.post("/api/activate-pro", authMiddleware, function(req, res) {
  var db = dbRead();
  var account = db.accounts[req.appUser];
  if (!account) return res.status(404).json({ error: "Not found" });
  account.isPro = true;
  dbWrite(db);
  log("pro", req.appUser + " activated Pro");
  return res.json({ success: true });
});

// kept for backwards compat
app.post("/api/unlock/review", authMiddleware, function(req, res) {
  var db = dbRead();
  var account = db.accounts[req.appUser];
  if (!account) return res.status(404).json({ error: "Not found" });
  if (account.reviewGiven) return res.json({ success: true, already: true, reviewGiven: true });
  account.reviewGiven = true;
  account.unlockedSlots = (account.unlockedSlots || 0) + 1;
  account.credits = (account.credits || 0) + 3;
  dbWrite(db);
  log("unlock", req.appUser + " unlocked 1 slot via review");
  return res.json({ success: true, reviewGiven: true, unlockedSlots: account.unlockedSlots });
});

// ── STRIPE ────────────────────────────────────────────────────────
app.post("/api/stripe/webhook", function(req, res) {
  var sig = req.headers["stripe-signature"];
  var event;
  if (STRIPE_WEBHOOK_SECRET) {
    var crypto = require("crypto");
    try {
      var payload = req.body.toString("utf8");
      var parts = sig.split(",").reduce(function(acc, part) {
        var kv = part.split("="); acc[kv[0]] = kv[1]; return acc;
      }, {});
      var ts = parts["t"];
      var v1 = parts["v1"];
      var signed = ts + "." + payload;
      var expected = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(signed, "utf8").digest("hex");
      if (expected !== v1) { log("stripe", "Invalid signature"); return res.status(400).json({ error: "Invalid signature" }); }
      event = JSON.parse(payload);
    } catch (e) { log("stripe", "Webhook parse error: " + e.message); return res.status(400).json({ error: "Parse error" }); }
  } else {
    try { event = JSON.parse(req.body.toString("utf8")); }
    catch (e) { return res.status(400).json({ error: "Bad payload" }); }
    log("stripe", "WARNING: webhook secret not set - skipping signature verification");
  }
  if (event.type === "checkout.session.completed") {
    var checkoutSession = event.data.object;
    var userId = checkoutSession.client_reference_id || null;
    var email = (checkoutSession.customer_details && checkoutSession.customer_details.email) ? checkoutSession.customer_details.email : null;
    var db = dbRead();
    var activated = false;
    if (userId && db.accounts[userId]) {
      db.accounts[userId].isPro = true;
      activated = true;
      log("stripe", "Pro activated by userId: " + userId);
    }
    if (!activated && email) {
      Object.values(db.accounts).forEach(function(acc) {
        if (!activated && acc.appUser && acc.email && acc.email.toLowerCase() === email.toLowerCase()) {
          db.accounts[acc.appUser].isPro = true;
          activated = true;
          log("stripe", "Pro activated by email: " + email);
        }
      });
    }
    if (activated) dbWrite(db);
    else log("stripe", "Could not match payment to account. Email: " + email + " userId: " + userId);
  }
  return res.json({ received: true });
});

// ── SPY ───────────────────────────────────────────────────────────
app.post("/api/spy/add", authMiddleware, async function(req, res) {
  var appUser = req.appUser;
  var targetUser = (req.body.targetUser || "").trim().toLowerCase().replace(/^@/, "");
  if (!targetUser) return res.status(400).json({ error: "Target username is required." });
  var db = dbRead();
  var account = db.accounts[appUser];
  if (!account || !account.isPro) return res.status(403).json({ error: "Pro feature. Upgrade to use Spy mode." });
  var s = await rehydrate(appUser);
  if (!s) return res.status(401).json({ error: "Instagram session expired. Please reconnect." });
  try {
    var targetInfo = await s.ig.user.searchExact(targetUser);
    if (!targetInfo) return res.status(404).json({ error: "User @" + targetUser + " not found." });
    var targetId = String(targetInfo.pk);
    var feed = s.ig.feed.userFollowing(targetId);
    var results = [];
    var page = 0;
    do {
      var items = await feed.items();
      for (var i = 0; i < items.length; i++) {
        results.push({ pk: String(items[i].pk), username: items[i].username || "", full_name: items[i].full_name || "", profile_pic_url: items[i].profile_pic_url || "" });
      }
      page++;
      await sleep(900);
      if (page > 100) break;
    } while (feed.isMoreAvailable());
    if (!db.spyTargets) db.spyTargets = {};
    if (!db.spyTargets[appUser]) db.spyTargets[appUser] = {};
    var existing = db.spyTargets[appUser][targetUser];
    var now = Date.now();
    var oneMonth = 30 * 24 * 60 * 60 * 1000;
    if (existing && existing.following) {
      var oldPKs = new Set(existing.following.map(function(u) { return u.pk; }));
      var newFollows = results.filter(function(u) { return !oldPKs.has(u.pk); }).map(function(u) { return Object.assign({}, u, { followedAt: now }); });
      var merged = (existing.recentFollows || []).filter(function(u) { return now - u.followedAt < oneMonth; }).concat(newFollows);
      var seen = {};
      merged = merged.filter(function(u) { if (seen[u.pk]) return false; seen[u.pk] = true; return true; });
      db.spyTargets[appUser][targetUser].following = results;
      db.spyTargets[appUser][targetUser].recentFollows = merged;
      db.spyTargets[appUser][targetUser].lastChecked = now;
    } else {
      db.spyTargets[appUser][targetUser] = { targetUser: targetUser, targetId: targetId, displayName: targetInfo.full_name || targetUser, profilePic: targetInfo.profile_pic_url || "", following: results, recentFollows: [], followingCount: results.length, lastChecked: now, isBaseline: true };
    }
    dbWrite(db);
    return res.json({ success: true, targetUser: targetUser, followingCount: results.length, isBaseline: !existing });
  } catch (err) {
    if ((err.message || "").toLowerCase().includes("not found") || (err.message || "").toLowerCase().includes("user not found")) return res.status(404).json({ error: "User @" + targetUser + " not found." });
    return res.status(500).json({ error: "Could not fetch data for @" + targetUser + ": " + err.message });
  }
});

app.get("/api/spy/list", authMiddleware, function(req, res) {
  var db = dbRead();
  var targets = db.spyTargets && db.spyTargets[req.appUser] ? db.spyTargets[req.appUser] : {};
  var now = Date.now();
  var oneMonth = 30 * 24 * 60 * 60 * 1000;
  var list = Object.values(targets).map(function(t) {
    return { targetUser: t.targetUser, displayName: t.displayName, profilePic: t.profilePic, followingCount: t.followingCount, lastChecked: t.lastChecked, recentFollows: (t.recentFollows || []).filter(function(u) { return now - u.followedAt < oneMonth; }) };
  });
  return res.json({ targets: list });
});

app.delete("/api/spy/remove/:target", authMiddleware, function(req, res) {
  var db = dbRead();
  if (db.spyTargets && db.spyTargets[req.appUser]) { delete db.spyTargets[req.appUser][req.params.target]; dbWrite(db); }
  return res.json({ success: true });
});

// ── CONFIG ────────────────────────────────────────────────────────
app.get("/api/config", function(req, res) {
  res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY, stripeProLink: STRIPE_PRO_LINK });
});

// ── CRON ──────────────────────────────────────────────────────────
cron.schedule("*/5 * * * *", async function() {
  var db = dbRead();
  var accounts = Object.entries(db.accounts);
  for (var i = 0; i < accounts.length; i++) {
    var appUser = accounts[i][0];
    var account = accounts[i][1];
    if (!account.tracking || !account.igUsername || syncLocks[appUser]) continue;
    try {
      log("cron", "Checking " + appUser + " (@" + account.igUsername + ")");
      var r = await runSync(appUser);
      log("cron", "@" + account.igUsername + ": " + r.followerCount + " followers | -" + r.newUnfollowers + " | +" + r.gained);
    } catch (err) { log("cron", appUser + " error: " + err.message); }
    if (i < accounts.length - 1) await sleep(10000);
  }
});

// ── SHUTDOWN ──────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  log("server", signal + " received - shutting down gracefully");
  process.exit(0);
}
process.on("SIGTERM", function() { gracefulShutdown("SIGTERM"); });
process.on("SIGINT", function() { gracefulShutdown("SIGINT"); });

app.listen(PORT, function() {
  console.log("");
  console.log("======================================");
  console.log(" FollowWatch is running!");
  console.log(" URL: http://localhost:" + PORT);
  console.log(" Proxy: " + (PROXY_URL ? "enabled" : "disabled"));
  console.log(" Supabase: " + (SUPABASE_URL ? "configured" : "NOT configured"));
  console.log(" Stripe webhook: " + (STRIPE_WEBHOOK_SECRET ? "configured" : "NOT configured"));
  console.log(" Sessions: persistent (file store)");
  console.log(" Auto-sync: every 5 minutes");
  console.log("======================================");
  console.log("");
});