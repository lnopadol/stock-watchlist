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

// Commit a single file (create or update)
GH.putFile = async (path, content, message) => {
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
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`commit ${path} failed: ${res.status} ${err}`);
  }
  return res.json();
};

// Debounced save queue — avoids one commit per keystroke when typing notes
GH.SAVE_DELAY_MS = 1500;
let saveTimer = null;
let pendingSaves = new Map(); // path -> {content, message}

GH.queueSave = (path, content, message) => {
  pendingSaves.set(path, { content, message });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(GH.flushSaves, GH.SAVE_DELAY_MS);
  GH.setStatus("pending");
};

GH.flushSaves = async () => {
  if (pendingSaves.size === 0) return;
  const batch = Array.from(pendingSaves.entries());
  pendingSaves.clear();
  GH.setStatus("saving");
  try {
    for (const [path, { content, message }] of batch) {
      await GH.putFile(path, content, message);
    }
    GH.setStatus("saved");
  } catch (e) {
    console.error(e);
    GH.setStatus("error", e.message);
    // Re-queue for retry
    batch.forEach(([p, v]) => pendingSaves.set(p, v));
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
