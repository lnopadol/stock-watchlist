// GitHub sync — commits dashboard changes directly to the repo via the GitHub Contents API.
// The personal access token is stored only in this browser's localStorage. It never leaves your
// device except in requests to api.github.com.
//
// Required token scopes: classic PAT with `public_repo`, OR fine-grained PAT with
// "Contents: Read and write" on the lnopadol/stock-watchlist repo.

const GH = {
  owner: "lnopadol",
  repo: "stock-watchlist",
  branch: "main",
  STORAGE_KEY: "watchlist_gh_token",
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
  // Quick repo write check — fetch repo metadata
  const repoRes = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}`, { headers: GH.headers() });
  if (!repoRes.ok) throw new Error(`Cannot access ${GH.owner}/${GH.repo}. Token may lack repo scope.`);
  const repoData = await repoRes.json();
  if (!repoData.permissions || !repoData.permissions.push) {
    throw new Error("Token has no write access to this repo. You need 'public_repo' scope (classic) or Contents:read-write (fine-grained).");
  }
  return user;
};

// Fetch a file's current SHA + content
GH.getFile = async (path) => {
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${path}?ref=${GH.branch}`;
  const res = await fetch(url, { headers: GH.headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getFile ${path} failed: ${res.status}`);
  const data = await res.json();
  return { sha: data.sha, content: atob(data.content.replace(/\n/g, "")) };
};

// Encode UTF-8 string to base64 safely (handles unicode)
GH.b64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
};

// Sleep helper
GH.sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Commit a single file (create or update) with automatic retry on SHA conflicts.
// Conflicts (409/422) happen when another commit landed between our getFile() and PUT —
// e.g. when the user fires several edits rapidly. We refetch the SHA and retry.
GH.putFile = async (path, content, message, attempt = 1) => {
  const MAX_ATTEMPTS = 5;
  const existing = await GH.getFile(path);
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${path}`;
  const body = {
    message,
    content: GH.b64(content),
    branch: GH.branch,
    ...(existing && { sha: existing.sha }),
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...GH.headers(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return res.json();

  const errText = await res.text();

  // 409 = SHA mismatch, 422 = validation (often stale SHA), 5xx = transient — all retryable
  const retryable = [409, 422, 500, 502, 503, 504].includes(res.status);
  if (retryable && attempt < MAX_ATTEMPTS) {
    const delay = Math.min(2000, 200 * Math.pow(2, attempt)); // 400, 800, 1600, 2000ms
    console.warn(`commit ${path} got ${res.status}, retrying in ${delay}ms (attempt ${attempt+1}/${MAX_ATTEMPTS})`);
    await GH.sleep(delay);
    return GH.putFile(path, content, message, attempt + 1);
  }

  // Rate-limited — honor the Retry-After header if present
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = parseInt(res.headers.get("x-ratelimit-reset") || "0", 10) * 1000;
    const waitMs = Math.max(reset - Date.now(), 60000);
    throw new Error(`Rate limited. Try again in ${Math.ceil(waitMs/60000)} minute(s).`);
  }

  throw new Error(`Commit failed (${res.status}): ${errText.slice(0, 200)}`);
};

// Debounced + mutex-guarded save queue. The mutex prevents two concurrent flushes
// from racing each other when the user edits faster than commits land.
GH.SAVE_DELAY_MS = 1500;
let saveTimer = null;
let pendingSaves = new Map(); // path -> {content, message}
let isFlushing = false;
let rerunAfterFlush = false;

GH.queueSave = (path, content, message) => {
  pendingSaves.set(path, { content, message });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(GH.flushSaves, GH.SAVE_DELAY_MS);
  GH.setStatus("pending");
};

GH.flushSaves = async () => {
  if (isFlushing) { rerunAfterFlush = true; return; }
  if (pendingSaves.size === 0) return;
  isFlushing = true;
  GH.setStatus("saving");
  try {
    // Drain the queue. New edits during the await will overwrite map entries by path,
    // so we always commit the LATEST content (not stale partial states).
    while (pendingSaves.size > 0) {
      const batch = Array.from(pendingSaves.entries());
      pendingSaves.clear();
      for (const [path, { content, message }] of batch) {
        await GH.putFile(path, content, message);
      }
    }
    GH.setStatus("saved");
  } catch (e) {
    console.error(e);
    GH.setStatus("error", e.message);
    // Schedule one retry in 5s if it wasn't a hard error like rate-limit
    if (!/rate limit/i.test(e.message)) {
      setTimeout(() => { if (pendingSaves.size > 0) GH.flushSaves(); }, 5000);
    }
  } finally {
    isFlushing = false;
    if (rerunAfterFlush) {
      rerunAfterFlush = false;
      setTimeout(GH.flushSaves, 100);
    }
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
