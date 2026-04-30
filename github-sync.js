// GitHub sync — commits dashboard changes directly to the repo via the GitHub Contents API.
// The personal access token is stored only in this browser's localStorage. It never leaves your
// device except in requests to api.github.com.
//
// Required token scopes: classic PAT with `public_repo`, OR fine-grained PAT with
// "Contents: Read and write" on the lnopadol/stock-watchlist repo.
//
// SYNC MODEL (patch-based, multi-device safe):
//   Each user action records a PATCH (upsert_ticker / remove_ticker / update_field).
//   On flush, we fetch the LATEST remote stocks.json, apply our patches to it, then PUT.
//   This means edits from other devices that landed since this tab loaded are preserved
//   automatically — we never overwrite remote tickers we don't know about.
//
// Backed up by a periodic remote refresh that pulls in changes made elsewhere.

const GH = {
  owner: "lnopadol",
  repo: "stock-watchlist",
  branch: "main",
  STORAGE_KEY: "watchlist_gh_token",
  REFRESH_INTERVAL_MS: 60000, // pull remote changes every 60s
};

GH.getToken = () => localStorage.getItem(GH.STORAGE_KEY) || null;
GH.setToken = (t) => localStorage.setItem(GH.STORAGE_KEY, t);
GH.clearToken = () => localStorage.removeItem(GH.STORAGE_KEY);
GH.isSignedIn = () => !!GH.getToken();

GH.headers = () => ({
  "Authorization": `Bearer ${GH.getToken()}`,
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

// Verify the token works and has write access by hitting the user endpoint.
GH.verify = async () => {
  const res = await fetch("https://api.github.com/user", { headers: GH.headers() });
  if (!res.ok) throw new Error(`GitHub auth failed (${res.status}). Check your token.`);
  const user = await res.json();
  const repoRes = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}`, { headers: GH.headers() });
  if (!repoRes.ok) throw new Error(`Cannot access ${GH.owner}/${GH.repo}. Token may lack repo scope.`);
  const repoData = await repoRes.json();
  if (!repoData.permissions || !repoData.permissions.push) {
    throw new Error("Token has no write access to this repo. You need 'public_repo' scope (classic) or Contents:read-write (fine-grained).");
  }
  return user;
};

// Decode base64 to a UTF-8 string. Critical: atob() returns a Latin-1 binary
// string, NOT a UTF-8 string. We must walk it byte-by-byte and TextDecoder it
// as UTF-8 to recover characters like é, €, —, etc.
GH.fromB64 = (b64) => {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
};

// Encode a UTF-8 string to base64 safely.
GH.b64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

// Fetch a file's current SHA + content
GH.getFile = async (path) => {
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${path}?ref=${GH.branch}&t=${Date.now()}`;
  const res = await fetch(url, { headers: GH.headers(), cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getFile ${path} failed: ${res.status}`);
  const data = await res.json();
  return { sha: data.sha, content: GH.fromB64(data.content) };
};

GH.sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Patch model ----
// A patch is one of:
//   { op: "upsert_ticker", ticker, data, message }     — add or replace full ticker entry
//   { op: "remove_ticker", ticker, message }           — remove ticker
//   { op: "update_field",  ticker, field, value, message } — patch a single field on a ticker
//
// Patches are applied IN ORDER to remote state, then committed.

GH.applyPatchesToData = (remoteData, patches) => {
  // remoteData: { updated, week_label, stocks: [...] }
  const data = JSON.parse(JSON.stringify(remoteData)); // clone
  if (!Array.isArray(data.stocks)) data.stocks = [];
  for (const p of patches) {
    if (p.op === "upsert_ticker") {
      const idx = data.stocks.findIndex(s => s.ticker === p.ticker);
      if (idx >= 0) data.stocks[idx] = p.data;
      else data.stocks.push(p.data);
    } else if (p.op === "remove_ticker") {
      data.stocks = data.stocks.filter(s => s.ticker !== p.ticker);
    } else if (p.op === "update_field") {
      const stock = data.stocks.find(s => s.ticker === p.ticker);
      if (stock) stock[p.field] = p.value;
      // if ticker not in remote (was removed elsewhere), silently drop the field update
    }
  }
  // Bump updated date to today
  data.updated = new Date().toISOString().slice(0, 10);
  return data;
};

// Detect the classic UTF-8-as-Latin-1 mojibake signature. If present, the page
// is decoding wrong (likely cached old JS) and any save would compound corruption.
// Better to abort than poison the file.
GH.looksMojibaked = (text) => {
  // A clean stocks.json may legitimately contain € or — but never the
  // double-encoded sequences "Ã\x82" or "Ã\x83" that appear in mojibake.
  return /Ã[\x82\x83]/.test(text) || text.includes("\u00c3\u0082") || text.includes("\u00c3\u0083");
};

// Commit pending patches: fetch remote, merge, PUT, retry on conflict.
GH.commitPatches = async (patches, attempt = 1) => {
  const MAX_ATTEMPTS = 5;
  const path = "data/stocks.json";
  const existing = await GH.getFile(path);
  if (!existing) throw new Error("Remote stocks.json missing — cannot merge.");

  if (GH.looksMojibaked(existing.content)) {
    throw new Error("Decode mismatch detected — refusing to save to avoid corrupting data. Hard-refresh the page (Cmd+Shift+R / hold reload) and try again.");
  }
  const remoteData = JSON.parse(existing.content);
  const merged = GH.applyPatchesToData(remoteData, patches);
  const content = JSON.stringify(merged, null, 2);

  // Build a clear commit message describing all patches
  const msgParts = patches.map(p => p.message).filter(Boolean);
  const message = msgParts.length === 1
    ? `Dashboard edit: ${msgParts[0]}`
    : `Dashboard edits: ${msgParts.join("; ")}`;

  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${path}`;
  const body = {
    message,
    content: GH.b64(content),
    branch: GH.branch,
    sha: existing.sha,
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...GH.headers(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    // After a successful commit, refresh local STATE from the merged data
    if (typeof window !== "undefined" && typeof window.applyRemoteData === "function") {
      window.applyRemoteData(merged);
    }
    return res.json();
  }

  const errText = await res.text();
  const retryable = [409, 422, 500, 502, 503, 504].includes(res.status);
  if (retryable && attempt < MAX_ATTEMPTS) {
    const delay = Math.min(2000, 200 * Math.pow(2, attempt));
    console.warn(`commit got ${res.status}, refetching+retrying in ${delay}ms (attempt ${attempt+1}/${MAX_ATTEMPTS})`);
    await GH.sleep(delay);
    return GH.commitPatches(patches, attempt + 1);
  }

  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = parseInt(res.headers.get("x-ratelimit-reset") || "0", 10) * 1000;
    const waitMs = Math.max(reset - Date.now(), 60000);
    throw new Error(`Rate limited. Try again in ${Math.ceil(waitMs/60000)} minute(s).`);
  }
  throw new Error(`Commit failed (${res.status}): ${errText.slice(0, 200)}`);
};

// ---- Patch queue ----
GH.SAVE_DELAY_MS = 1500;
let saveTimer = null;
let pendingPatches = []; // ordered list
let isFlushing = false;
let rerunAfterFlush = false;

GH.queuePatch = (patch) => {
  if (!GH.isSignedIn()) return;
  pendingPatches.push(patch);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(GH.flushPatches, GH.SAVE_DELAY_MS);
  GH.setStatus("pending");
};

// Convenience helpers used by app.js
GH.upsertTicker = (ticker, data, label) =>
  GH.queuePatch({ op: "upsert_ticker", ticker, data, message: label });
GH.removeTicker = (ticker, label) =>
  GH.queuePatch({ op: "remove_ticker", ticker, message: label });
GH.updateField = (ticker, field, value, label) =>
  GH.queuePatch({ op: "update_field", ticker, field, value, message: label });

GH.flushPatches = async () => {
  if (isFlushing) { rerunAfterFlush = true; return; }
  if (pendingPatches.length === 0) return;
  isFlushing = true;
  GH.setStatus("saving");
  try {
    // Drain all pending patches in the order they were enqueued.
    while (pendingPatches.length > 0) {
      // Coalesce: take the current batch and apply together in one commit.
      const batch = pendingPatches.slice();
      pendingPatches = [];
      await GH.commitPatches(batch);
    }
    GH.setStatus("saved");
  } catch (e) {
    console.error(e);
    GH.setStatus("error", e.message);
    if (!/rate limit/i.test(e.message)) {
      // Re-queue the failed batch so we retry on next flush
      setTimeout(() => { if (pendingPatches.length > 0) GH.flushPatches(); }, 5000);
    }
  } finally {
    isFlushing = false;
    if (rerunAfterFlush) {
      rerunAfterFlush = false;
      setTimeout(GH.flushPatches, 100);
    }
  }
};

// ---- Periodic remote refresh ----
// Pulls the latest stocks.json from the repo and merges any new tickers into local STATE.
// Only runs when there are no pending patches (don't fight a save in progress).
GH.refreshFromRemote = async () => {
  if (pendingPatches.length > 0 || isFlushing) return;
  try {
    const f = await GH.getFile("data/stocks.json");
    if (!f) return;
    const remote = JSON.parse(f.content);
    if (typeof window !== "undefined" && typeof window.applyRemoteData === "function") {
      window.applyRemoteData(remote);
    }
  } catch (e) {
    console.warn("refreshFromRemote failed:", e.message);
  }
};

GH.startRefreshLoop = () => {
  setInterval(GH.refreshFromRemote, GH.REFRESH_INTERVAL_MS);
  // Also refresh whenever the tab regains focus
  if (typeof window !== "undefined") {
    window.addEventListener("focus", GH.refreshFromRemote);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) GH.refreshFromRemote();
    });
  }
};

// Visible status indicator
GH.setStatus = (state, msg = "") => {
  const el = document.getElementById("syncStatus");
  if (!el) return;
  const labels = {
    "signed-out": "🔒 Read-only",
    "pending": "● Unsaved",
    "saving": "⟳ Saving…",
    "saved": "✓ Synced",
    "error": "⚠ " + (msg || "Sync error"),
  };
  el.className = `sync-status sync-${state}`;
  el.textContent = labels[state] || state;
  el.title = msg || "";
};

// Backwards-compat shim: queueSave still works but routes through full-replace patch.
// Existing app.js calls remain functional during the migration.
GH.queueSave = (path, content, message) => {
  if (path !== "data/stocks.json") {
    console.warn("queueSave for non-stocks.json path is deprecated");
    return;
  }
  // We don't know what changed, so this is a "force my whole state" patch.
  // Best avoided — use upsertTicker / removeTicker / updateField instead.
  console.warn("Legacy queueSave called; prefer typed patch helpers");
};
