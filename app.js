// Stock Watchlist — static dashboard
// When signed in, edits auto-commit to GitHub. When signed out, edits stay local.

const STATE = {
  data: null,
  filtered: [],
  sortKey: "ticker",
  sortDir: 1,
  notes: JSON.parse(localStorage.getItem("watchlist_notes") || "{}"),
  prevSnap: null,
};

// Apply a fresh remote stocks payload into local STATE. Called after every successful
// commit and on the periodic refresh — keeps tabs across devices in sync without losing
// the user's in-flight edits (those go through the patch queue separately).
window.applyRemoteData = function applyRemoteData(remote) {
  if (!remote || !Array.isArray(remote.stocks)) return;
  const oldCount = STATE.data ? STATE.data.stocks.length : 0;
  // Replace whole STATE.data with remote — patches in flight are already in remote because
  // commitPatches applied them server-side. Local-only state (notes typed but not yet
  // committed) lives in STATE.notes and is layered on top during render.
  STATE.data = remote;
  // Layer in any locally typed notes that haven't been committed yet
  for (const s of STATE.data.stocks) {
    if (STATE.notes[s.ticker] !== undefined) s.notes = STATE.notes[s.ticker];
  }
  if (typeof render === "function") render();
  if (oldCount !== STATE.data.stocks.length) {
    console.log(`Watchlist refreshed from remote: ${oldCount} -> ${STATE.data.stocks.length} tickers`);
  }
};

function applyEditMode() {
  const banner = document.getElementById("readOnlyBanner");
  if (GH.isSignedIn()) {
    document.body.classList.remove("readonly");
    document.getElementById("signInBtn").textContent = "Account";
    GH.setStatus("saved");
    if (banner) banner.hidden = true;
  } else {
    document.body.classList.add("readonly");
    document.getElementById("signInBtn").textContent = "Sign in";
    GH.setStatus("signed-out");
    if (banner) banner.hidden = false;
  }
}

// ---- Helpers ----
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function verdictPill(v) {
  if (!v) return `<span class="pill gray">—</span>`;
  const l = v.toLowerCase();
  if (l.includes("attract")) return `<span class="pill green">${v}</span>`;
  if (l.includes("reason")) return `<span class="pill amber">${v}</span>`;
  if (l.includes("premium") || l.includes("expens")) return `<span class="pill red">${v}</span>`;
  return `<span class="pill gray">${v}</span>`;
}
function statusPill(s) {
  if (!s) return `<span class="pill gray">—</span>`;
  const l = s.toLowerCase();
  if (l.includes("monitor")) return `<span class="pill blue">${s}</span>`;
  if (l.includes("review")) return `<span class="pill amber">${s}</span>`;
  if (l.includes("buy")) return `<span class="pill green">${s}</span>`;
  if (l.includes("trim") || l.includes("sell")) return `<span class="pill red">${s}</span>`;
  return `<span class="pill gray">${s}</span>`;
}
function riskBadge(r) {
  return `<span class="risk r${r}">${r}</span>`;
}
function upsideCell(pct) {
  if (pct === null || pct === undefined) return `<span class="muted">—</span>`;
  const dir = pct >= 0 ? "pos" : "neg";
  const abs = Math.min(Math.abs(pct), 50); // cap bar at ±50%
  const w = (abs / 50) * 50; // 50% of half-bar
  return `
    <div class="upside-cell">
      <span class="upside-val ${dir}">${pct > 0 ? "+" : ""}${pct.toFixed(1)}%</span>
      <div class="upside-bar">
        <div class="center"></div>
        <div class="fill ${dir}" style="width: ${w}%"></div>
      </div>
    </div>`;
}
function mdLink(s) {
  if (!s) return "";
  // Convert [text](url) → <a> ; supports multiple in one string
  return s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function escape(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function deltaSpan(curr, prev) {
  if (prev == null || curr == null) return "";
  const diff = curr - prev;
  if (Math.abs(diff) < 0.001) return `<span class="delta-flat">·</span>`;
  const pct = (diff / prev) * 100;
  const cls = diff > 0 ? "delta-up" : "delta-down";
  const arrow = diff > 0 ? "▲" : "▼";
  return `<span class="${cls}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
}

// ---- Loading ----
async function loadData() {
  const res = await fetch("data/stocks.json?t=" + Date.now());
  STATE.data = await res.json();

  // Local-only notes are a fallback for signed-out browsing.
  if (!GH.isSignedIn()) {
    STATE.data.stocks.forEach(s => {
      if (STATE.notes[s.ticker] !== undefined) s.notes = STATE.notes[s.ticker];
    });
  }

  // Try to load previous week snapshot for diff
  try {
    const list = await fetch("data/snapshots/index.json").then(r => r.ok ? r.json() : null);
    if (list && list.weeks && list.weeks.length > 1) {
      const prevWeek = list.weeks[list.weeks.length - 2];
      const prev = await fetch(`data/snapshots/${prevWeek}.json`).then(r => r.json());
      STATE.prevSnap = prev;
    }
  } catch (e) { /* no prior snapshot yet */ }

  $("#subline").textContent = `${STATE.data.stocks.length} tickers · Updated ${STATE.data.updated} · Week ${STATE.data.week_label}`;
  render();
}

// ---- Render ----
function render() {
  renderSummary();
  renderTable();
}

function renderSummary() {
  const stocks = STATE.data.stocks;
  const counts = { attract: 0, reason: 0, premium: 0 };
  let totalUpside = 0, withTarget = 0;
  stocks.forEach(s => {
    const v = (s.verdict || "").toLowerCase();
    if (v.includes("attract")) counts.attract++;
    else if (v.includes("reason")) counts.reason++;
    else if (v.includes("premium")) counts.premium++;
    if (s.upside_pct !== null && s.upside_pct !== undefined) {
      totalUpside += s.upside_pct;
      withTarget++;
    }
  });
  const avgUpside = withTarget ? (totalUpside / withTarget) : 0;
  const buyZone = stocks.filter(s => s.upside_pct !== null && s.upside_pct >= 10).length;

  $("#summary").innerHTML = `
    <div class="card"><div class="label">Total tickers</div><div class="val">${stocks.length}</div></div>
    <div class="card"><div class="label">Attractively priced</div><div class="val" style="color:var(--green-fg)">${counts.attract}</div></div>
    <div class="card"><div class="label">Reasonably priced</div><div class="val" style="color:var(--amber-fg)">${counts.reason}</div></div>
    <div class="card"><div class="label">Premium priced</div><div class="val" style="color:var(--red-fg)">${counts.premium}</div></div>
    <div class="card"><div class="label">Avg upside to target</div><div class="val">${avgUpside >= 0 ? "+" : ""}${avgUpside.toFixed(1)}%</div></div>
    <div class="card"><div class="label">Buy zone (≥10% upside)</div><div class="val">${buyZone}</div></div>
  `;
}

function renderTable() {
  const q = ($("#search").value || "").toLowerCase().trim();
  let rows = STATE.data.stocks.slice();
  if (q) {
    rows = rows.filter(s =>
      (s.ticker + " " + s.company + " " + s.sector + " " + (s.verdict||"")).toLowerCase().includes(q)
    );
  }
  rows.sort((a, b) => {
    const k = STATE.sortKey;
    let va = a[k], vb = b[k];
    if (k === "pe_ratio") {
      const na = parseFloat(va), nb = parseFloat(vb);
      va = isNaN(na) ? Infinity : na; vb = isNaN(nb) ? Infinity : nb;
    }
    if (va == null) va = STATE.sortDir > 0 ? Infinity : -Infinity;
    if (vb == null) vb = STATE.sortDir > 0 ? Infinity : -Infinity;
    if (typeof va === "string") return va.localeCompare(vb) * STATE.sortDir;
    return (va - vb) * STATE.sortDir;
  });

  STATE.filtered = rows;

  const prevByTicker = {};
  if (STATE.prevSnap) {
    STATE.prevSnap.stocks.forEach(s => prevByTicker[s.ticker] = s);
  }

  $("#tbody").innerHTML = rows.map(s => {
    const prev = prevByTicker[s.ticker];
    const priceDelta = prev ? deltaSpan(s.price_num, prev.price_num) : "";
    return `
    <tr class="row" data-ticker="${escape(s.ticker)}">
      <td>
        <div class="ticker-cell">${escape(s.ticker)}</div>
      </td>
      <td>
        <div>${escape(s.company)}</div>
      </td>
      <td>${escape(s.sector || "—")}</td>
      <td class="num">${escape(s.price || "—")}${priceDelta}</td>
      <td class="num">${escape(s.market_cap || "—")}</td>
      <td class="num">${escape(s.pe_ratio || "—")}</td>
      <td class="num">${upsideCell(s.upside_pct)}</td>
      <td>${verdictPill(s.verdict)}</td>
      <td>${statusPill(s.status)}</td>
      <td class="num">${riskBadge(s.risk_score || 5)}</td>
      <td>
        <input class="notes-input" data-ticker="${escape(s.ticker)}" type="text"
               value="${escape(s.notes || "")}" placeholder="Add note…" />
      </td>
      <td>
        <button class="btn danger del-btn" data-ticker="${escape(s.ticker)}" title="Remove">×</button>
      </td>
    </tr>`;
  }).join("");

  // Wire events
  $$("#tbody tr.row").forEach(tr => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("input,button")) return;
      openDetail(tr.dataset.ticker);
    });
  });
  $$(".notes-input").forEach(inp => {
    inp.addEventListener("input", (e) => {
      const t = inp.dataset.ticker;
      STATE.notes[t] = inp.value;
      const stock = STATE.data.stocks.find(x => x.ticker === t);
      if (stock) stock.notes = inp.value;
      localStorage.setItem("watchlist_notes", JSON.stringify(STATE.notes));
      GH.updateField(t, "notes", inp.value, `update note for ${t}`);
    });
    inp.addEventListener("click", e => e.stopPropagation());
  });
  $$(".del-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = btn.dataset.ticker;
      if (confirm(`Remove ${t} from watchlist?`)) {
        STATE.data.stocks = STATE.data.stocks.filter(s => s.ticker !== t);
        delete STATE.notes[t];
        localStorage.setItem("watchlist_notes", JSON.stringify(STATE.notes));
        GH.removeTicker(t, `remove ${t}`);
        render();
      }
    });
  });
}

// ---- Detail modal ----
function openDetail(ticker) {
  const s = STATE.data.stocks.find(x => x.ticker === ticker);
  if (!s) return;
  const housesHtml = (s.houses || []).map(h => `
    <tr>
      <td><strong>${escape(h.name)}</strong></td>
      <td>${escape(h.rating)}</td>
      <td><strong>${escape(h.target)}</strong></td>
      <td>${mdLink(h.source)}</td>
    </tr>`).join("") || `<tr><td colspan="4" class="muted">No analyst coverage on file. Run weekly refresh.</td></tr>`;

  $("#detailContent").innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${escape(s.company)} <span class="muted" style="font-size:14px">${escape(s.ticker)}</span></h2>
        <div class="meta">${escape(s.sector || "—")} · ${escape(s.currency || "")} · ${escape(s.market_cap || "")}</div>
      </div>
      <div class="pricewrap">
        <div class="big">${escape(s.price || "—")}</div>
        <div class="meta">P/E ${escape(s.pe_ratio || "—")} · Risk ${riskBadge(s.risk_score || 5)}</div>
      </div>
    </div>

    <div class="detail-section">
      <h3>Verdict & Signal</h3>
      <p>${verdictPill(s.verdict)} ${statusPill(s.status)}
      &nbsp; <strong>Upside to consensus:</strong> ${s.upside_pct != null ? (s.upside_pct >= 0 ? "+" : "") + s.upside_pct.toFixed(1) + "%" : "—"}
      &nbsp; <strong>Consensus target:</strong> ${escape(s.consensus_target || "—")}</p>
    </div>

    <div class="detail-section">
      <h3>1. What this stock is about</h3>
      <p>${mdLink(escape(s.what_it_does))}</p>
    </div>

    <div class="detail-section">
      <h3>2. Is it a good bet? (Bull vs bear)</h3>
      <p>${mdLink(escape(s.is_good_bet))}</p>
    </div>

    <div class="detail-section">
      <h3>3. Is now a good time to buy?</h3>
      <p>${mdLink(escape(s.buy_now_signal))}</p>
    </div>

    <div class="detail-section">
      <h3>Cross-reference: Investment houses</h3>
      <table class="house-table">
        <thead><tr><th>House</th><th>Rating</th><th>Target</th><th>Source</th></tr></thead>
        <tbody>${housesHtml}</tbody>
      </table>
    </div>

    <div class="detail-section">
      <h3>Key catalysts (3-6 months)</h3>
      <p>${mdLink(escape(s.key_catalysts || "—"))}</p>
    </div>

    <div class="detail-section">
      <h3>Key risks</h3>
      <p>${mdLink(escape(s.key_risks || "—"))}</p>
    </div>

    <div class="detail-section">
      <h3>My notes</h3>
      <input id="detailNotes" type="text" value="${escape(s.notes || "")}" placeholder="Add a note…"
             style="width:100%;padding:9px 12px;border:1px solid var(--line-strong);border-radius:6px;font-size:14px;font-family:inherit" />
    </div>

    <div class="detail-actions">
      <div class="muted" style="font-size:12px">Status:
        <select id="statusSel" style="padding:6px;border:1px solid var(--line-strong);border-radius:4px">
          <option ${s.status==="Monitoring"?"selected":""}>Monitoring</option>
          <option ${s.status==="Under Review"?"selected":""}>Under Review</option>
          <option ${s.status==="Buy Zone"?"selected":""}>Buy Zone</option>
          <option ${s.status==="Trim"?"selected":""}>Trim</option>
          <option ${s.status==="Hold"?"selected":""}>Hold</option>
        </select>
      </div>
      <div class="right">
        <button class="btn" id="closeDetail">Close</button>
      </div>
    </div>
  `;
  $("#detailModal").hidden = false;

  $("#closeDetail").onclick = () => $("#detailModal").hidden = true;
  $("#detailNotes").oninput = (e) => {
    s.notes = e.target.value;
    STATE.notes[s.ticker] = e.target.value;
    localStorage.setItem("watchlist_notes", JSON.stringify(STATE.notes));
    renderTable();
    GH.updateField(s.ticker, "notes", e.target.value, `update note for ${s.ticker}`);
  };
  $("#statusSel").onchange = (e) => {
    s.status = e.target.value;
    renderTable();
    GH.updateField(s.ticker, "status", e.target.value, `status → ${e.target.value} for ${s.ticker}`);
  };
}

// ---- Add ticker ----
$("#addBtn").onclick = () => {
  $("#newTicker").value = "";
  $("#newCompany").value = "";
  $("#addModal").hidden = false;
  setTimeout(() => $("#newTicker").focus(), 50);
};
$("#cancelAdd").onclick = () => $("#addModal").hidden = true;
$("#confirmAdd").onclick = () => {
  const t = $("#newTicker").value.trim().toUpperCase();
  const c = $("#newCompany").value.trim();
  if (!t) return;
  if (STATE.data.stocks.some(s => s.ticker === t)) {
    alert(`${t} is already on the watchlist.`);
    return;
  }
  STATE.data.stocks.push({
    ticker: t,
    company: c || t,
    sector: "—",
    currency: "",
    price: "—",
    price_num: null,
    market_cap: "—",
    pe_ratio: "—",
    what_it_does: "Pending research. Run weekly refresh prompt to populate.",
    is_good_bet: "",
    buy_now_signal: "",
    verdict: "Reasonably Priced",
    status: "Under Review",
    risk_score: 5,
    houses: [],
    consensus_target: "",
    consensus_target_num: null,
    upside_pct: null,
    key_catalysts: "",
    key_risks: "",
    notes: "Newly added — needs research",
  });
  $("#addModal").hidden = true;
  // Find the just-added ticker so we can patch the FULL entry to remote
  const newStock = STATE.data.stocks.find(s => s.ticker === t);
  if (newStock) GH.upsertTicker(t, newStock, `add ${t}`);
  render();
};

// ---- Sign in / out ----
$("#signInBtn").onclick = () => {
  $("#tokenInput").value = GH.isSignedIn() ? "•••••••• (saved)" : "";
  $("#signOutBtn").hidden = !GH.isSignedIn();
  $("#signInError").hidden = true;
  $("#signInModal").hidden = false;
  setTimeout(() => $("#tokenInput").focus(), 50);
};
$("#cancelSignIn").onclick = () => $("#signInModal").hidden = true;
$("#signOutBtn").onclick = () => {
  GH.clearToken();
  $("#signInModal").hidden = true;
  applyEditMode();
};
$("#confirmSignIn").onclick = async () => {
  const tok = $("#tokenInput").value.trim();
  if (!tok || tok.startsWith("•")) { $("#signInModal").hidden = true; return; }
  GH.setToken(tok);
  try {
    const user = await GH.verify();
    $("#signInModal").hidden = true;
    applyEditMode();
    await loadData();
    GH.setStatus("saved", `Signed in as ${user.login}`);
  } catch (e) {
    GH.clearToken();
    $("#signInError").textContent = e.message;
    $("#signInError").hidden = false;
  }
};

// ---- Export ----
$("#exportBtn").onclick = () => {
  const payload = {
    updated: new Date().toISOString().slice(0, 10),
    week_label: STATE.data.week_label,
    stocks: STATE.data.stocks,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "stocks.json";
  a.click();
  URL.revokeObjectURL(url);
  alert("stocks.json downloaded.\n\nCommit it to data/stocks.json on GitHub to persist changes.");
};

// ---- History ----
$("#historyBtn").onclick = async () => {
  let html = "<h2>Weekly history</h2>";
  try {
    const list = await fetch("data/snapshots/index.json").then(r => r.json());
    if (!list.weeks || list.weeks.length === 0) {
      html += "<p class='muted'>No snapshots yet. The first one is created on this week's refresh.</p>";
    } else {
      const snaps = await Promise.all(list.weeks.map(w =>
        fetch(`data/snapshots/${w}.json`).then(r => r.json()).then(d => ({ week: w, data: d }))
      ));
      // Compare consecutive weeks
      for (let i = snaps.length - 1; i >= 0; i--) {
        const curr = snaps[i];
        const prev = i > 0 ? snaps[i-1] : null;
        let changes = [];
        if (prev) {
          curr.data.stocks.forEach(s => {
            const p = prev.data.stocks.find(x => x.ticker === s.ticker);
            if (!p) { changes.push(`<span class="change-up">+ ${s.ticker} added</span>`); return; }
            if (p.verdict !== s.verdict) changes.push(`${s.ticker}: verdict ${p.verdict} → ${s.verdict}`);
            if (p.price_num && s.price_num) {
              const d = ((s.price_num - p.price_num)/p.price_num)*100;
              if (Math.abs(d) >= 3) {
                const cls = d > 0 ? "change-up" : "change-down";
                changes.push(`<span class="${cls}">${s.ticker}: ${d>0?"+":""}${d.toFixed(1)}%</span>`);
              }
            }
          });
          prev.data.stocks.forEach(p => {
            if (!curr.data.stocks.find(x => x.ticker === p.ticker)) {
              changes.push(`<span class="change-down">− ${p.ticker} removed</span>`);
            }
          });
        }
        html += `<div class="history-row">
          <div class="week">${curr.week}</div>
          <div class="changes">
            <strong>${curr.data.stocks.length} tickers</strong> · ${curr.data.updated}<br/>
            ${changes.length ? changes.join(" · ") : "<span class='muted'>Initial snapshot</span>"}
          </div>
        </div>`;
      }
    }
  } catch (e) {
    html += "<p class='muted'>No snapshot index found yet. Run the weekly refresh to start tracking history.</p>";
  }
  html += `<div class="detail-actions"><div></div><div class="right"><button class="btn" id="closeHist">Close</button></div></div>`;
  $("#historyContent").innerHTML = html;
  $("#historyModal").hidden = false;
  $("#closeHist").onclick = () => $("#historyModal").hidden = true;
};

// ---- Quarterly Review ----
$("#reviewBtn").onclick = async () => {
  $("#reviewContent").innerHTML = "<p class='muted'>Loading review…</p>";
  $("#reviewModal").hidden = false;
  let idx;
  try {
    idx = await fetch("data/reviews/index.json?t=" + Date.now()).then(r => r.ok ? r.json() : null);
  } catch (e) { idx = null; }
  if (!idx || !idx.quarters || idx.quarters.length === 0) {
    $("#reviewContent").innerHTML = `
      <h2>Quarterly Review</h2>
      <p class='muted'>No review available yet. Quarterly reviews are generated on demand and saved to <code>data/reviews/</code>.</p>
      <div class='detail-actions'><div></div><div class='right'><button class='btn' onclick='document.getElementById("reviewModal").hidden = true'>Close</button></div></div>`;
    return;
  }
  const latest = idx.quarters[idx.quarters.length - 1];
  const review = await fetch(`data/reviews/${latest}.json?t=${Date.now()}`).then(r => r.json());
  renderReview(review, idx.quarters);
};

function renderReview(r, allQuarters) {
  const tabs = [
    ["summary", "Executive Summary"],
    ["macro", "Macro Context"],
    ["buckets", "Buckets"],
    ["angle1", "Angle 1: Macro"],
    ["angle2", "Angle 2: Fundamentals"],
    ["angle3", "Angle 3: Risk Sizing"],
    ["clusters", "Factor Clusters"],
    ["priority", "High Priority"],
    ["actions", "Actions"],
  ];

  const tabBar = `<div class="review-tabs">${tabs.map(([k,n],i)=>`<button class="review-tab ${i===0?'active':''}" data-tab="${k}">${n}</button>`).join("")}</div>`;

  const summaryPane = `
    <div class="review-pane active" data-pane="summary">
      <h2>Executive Summary — ${escape(r.quarter)}</h2>
      <div class="review-meta">Generated ${escape(r.review_date)} · ${r.by_ticker.length} names reviewed</div>
      <div class="exec-summary"><ul>${(r.executive_summary||[]).map(b=>`<li>${mdLink(escape(b))}</li>`).join("")}</ul></div>
    </div>`;

  const macroPane = `
    <div class="review-pane" data-pane="macro">
      <h2>Macro Context — ${escape(r.quarter)}</h2>
      <p>${mdLink(escape(r.macro_context.summary || ""))}</p>
      <div class="macro-grid">
        ${(r.macro_context.key_drivers||[]).map(d=>`
          <div class="macro-card">
            <div class="driver">${escape(d.driver)}</div>
            <div class="level">${escape(d.level)}</div>
            <div class="impl">${mdLink(escape(d.implication))}</div>
          </div>`).join("")}
      </div>
      ${(r.macro_context.sources||[]).length ? `<div class="source-list"><strong>Sources:</strong> ${r.macro_context.sources.map(s=>mdLink(escape(s))).join(" · ")}</div>` : ""}
    </div>`;

  const bucketLabels = {
    core_compounders: "Core compounders",
    cyclicals: "Cyclicals",
    defensives: "Defensives",
    turnaround_special_situations: "Turnaround / special situations",
    deep_value: "Deep value",
    quality_growth: "Quality growth",
    income_plays: "Income plays",
    thematic_structural: "Thematic / structural",
  };
  const bucketsPane = `
    <div class="review-pane" data-pane="buckets">
      <h2>Buckets</h2>
      <p class="muted">Each name's primary role in a portfolio context.</p>
      ${Object.entries(r.buckets||{}).map(([k,arr])=>`
        <div class="bucket-row">
          <div class="bucket-name">${escape(bucketLabels[k]||k)}</div>
          <div class="bucket-tickers">${(arr||[]).map(t=>`<span class="tk">${escape(t)}</span>`).join("")}${(!arr||arr.length===0)?"<span class='muted'>—</span>":""}</div>
        </div>`).join("")}
    </div>`;

  const tagClass = (t) => {
    if (!t) return "tag-mixed";
    const l = t.toLowerCase();
    if (l.includes("lead")) return "tag-good";
    if (l.includes("compensat")) return "tag-mixed";
    if (l.includes("vulnerable")) return "tag-bad";
    return "tag-mixed";
  };

  const tickerCards = (angleKey, angleTitle, fields) => {
    return r.by_ticker.map(t => {
      const a = t[angleKey] || {};
      const inner = fields.map(([fkey, flabel]) => {
        const v = a[fkey];
        if (!v) return "";
        if (Array.isArray(v)) return `<div class="angle"><b>${flabel}:</b> ${v.map(x=>escape(x)).join(" · ")}</div>`;
        return `<div class="angle"><b>${flabel}:</b> ${mdLink(escape(v))}</div>`;
      }).join("");
      const extra = angleKey === "angle2_fundamental" && a.tag
        ? `<span class="tag ${tagClass(a.tag)}">${escape(a.tag)}</span>`
        : "";
      const sizing = angleKey === "angle3_quant" && a.sizing_tier
        ? `<span class="sizing">Sizing: ${escape(a.sizing_tier)}</span>`
        : "";
      return `
        <div class="ticker-card">
          <div class="head">
            <div>
              <span class="tkname">${escape(t.ticker)}</span>
              <span class="role">· ${escape(t.bucket || "")}</span>
              ${extra}${sizing}
            </div>
          </div>
          <div class="angles">${inner}</div>
        </div>`;
    }).join("");
  };

  const angle1Pane = `
    <div class="review-pane" data-pane="angle1">
      <h2>Angle 1 — Macro & Regime Fit</h2>
      ${tickerCards("angle1_macro", "Macro", [["regime_fit","Regime fit"],["drivers","Drivers"],["sensitivity","Sensitivity"]])}
    </div>`;
  const angle2Pane = `
    <div class="review-pane" data-pane="angle2">
      <h2>Angle 2 — Fundamentals & Valuation</h2>
      ${tickerCards("angle2_fundamental", "Fundamentals", [["summary","Business"],["drivers","Drivers"],["valuation","Valuation"]])}
    </div>`;
  const angle3Pane = `
    <div class="review-pane" data-pane="angle3">
      <h2>Angle 3 — Risk Profile & Sizing</h2>
      ${tickerCards("angle3_quant", "Risk", [["vol_drawdown","Vol / drawdown"],["factor_clusters","Factor clusters"],["diversification","Diversification"]])}
    </div>`;

  const clustersPane = `
    <div class="review-pane" data-pane="clusters">
      <h2>Factor Clusters</h2>
      <p class="muted">Names that move together in stress scenarios.</p>
      ${(r.factor_clusters||[]).map(c=>`
        <div class="cluster-card">
          <div class="cluster-name">${escape(c.cluster)}</div>
          <div class="members">${(c.members||[]).map(t=>`<span class="tk" style="display:inline-block;padding:2px 8px;background:var(--bg);border:1px solid var(--line);border-radius:4px;margin:2px 3px 2px 0;font-size:11.5px;font-weight:500">${escape(t)}</span>`).join("")}</div>
          <div style="font-size:12.5px;line-height:1.5"><b>Shared risks:</b> ${mdLink(escape(c.shared_risks||""))}</div>
          ${c.concentration_warning ? `<div class="warning">⚠ ${mdLink(escape(c.concentration_warning))}</div>` : ""}
        </div>`).join("")}
    </div>`;

  const priorityPane = `
    <div class="review-pane" data-pane="priority">
      <h2>High-Priority Names</h2>
      <p class="muted">Where all three angles align, or where they sharply conflict.</p>
      ${(r.high_priority_names||[]).map(p=>`
        <div class="priority-card ${p.type==='sharp_conflict'?'conflict':''}">
          <div><span class="pname">${escape(p.ticker)}</span><span class="ptype">${p.type==='all_three_align'?'All angles align':'Sharp conflict'}</span></div>
          <div class="case">${mdLink(escape(p.case||""))}</div>
          <h4>Entry triggers</h4>
          <ul>${(p.entry_triggers||[]).map(e=>`<li>${mdLink(escape(e))}</li>`).join("")}</ul>
          <h4>Risks by angle</h4>
          <ul>
            <li><b>Macro:</b> ${mdLink(escape(p.thesis_risks?.macro||"—"))}</li>
            <li><b>Fundamental:</b> ${mdLink(escape(p.thesis_risks?.fundamental||"—"))}</li>
            <li><b>Quantitative:</b> ${mdLink(escape(p.thesis_risks?.quantitative||"—"))}</li>
          </ul>
        </div>`).join("")}
    </div>`;

  const a = r.actions_to_consider || {};
  const lst = (arr) => (arr||[]).length ? `<ul>${arr.map(x=>`<li>${mdLink(escape(x))}</li>`).join("")}</ul>` : "<p class='muted'>—</p>";
  const actionsPane = `
    <div class="review-pane" data-pane="actions">
      <h2>Actions to Consider</h2>
      <div class="actions-grid">
        <div class="action-card"><h4>Upgrade priority</h4>${lst(a.upgrade_priority)}</div>
        <div class="action-card"><h4>Downgrade priority</h4>${lst(a.downgrade_priority)}</div>
        <div class="action-card"><h4>Themes to add</h4>${lst(a.themes_to_add)}</div>
        <div class="action-card"><h4>Themes to trim</h4>${lst(a.themes_to_trim)}</div>
      </div>
      <h4>Research to clarify</h4>
      ${lst(a.research_to_clarify)}
    </div>`;

  $("#reviewContent").innerHTML = `
    ${tabBar}
    ${summaryPane}${macroPane}${bucketsPane}${angle1Pane}${angle2Pane}${angle3Pane}${clustersPane}${priorityPane}${actionsPane}
    <div class="detail-actions"><div class="muted" style="font-size:12px">${allQuarters.length} quarter${allQuarters.length>1?'s':''} on file</div><div class="right"><button class="btn" id="closeReview">Close</button></div></div>
  `;

  $$("#reviewContent .review-tab").forEach(t => {
    t.addEventListener("click", () => {
      $$("#reviewContent .review-tab").forEach(x => x.classList.remove("active"));
      $$("#reviewContent .review-pane").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      const target = $(`#reviewContent .review-pane[data-pane="${t.dataset.tab}"]`);
      if (target) target.classList.add("active");
    });
  });
  $("#closeReview").onclick = () => $("#reviewModal").hidden = true;
}

// ---- Sort handlers ----
$$("th[data-sort]").forEach(th => {
  th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (STATE.sortKey === k) STATE.sortDir *= -1;
    else { STATE.sortKey = k; STATE.sortDir = 1; }
    renderTable();
  });
});

$("#search").addEventListener("input", renderTable);

// Modal close on backdrop click
$$(".modal").forEach(m => {
  m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; });
});

applyEditMode();
loadData();

// Start periodic remote refresh so multi-device edits propagate within 60s
GH.startRefreshLoop();

// Warn before closing if there are unsaved changes
window.addEventListener("beforeunload", (e) => {
  if (document.querySelector(".sync-pending")) {
    GH.flushPatches();
    e.preventDefault();
    e.returnValue = "";
  }
});
