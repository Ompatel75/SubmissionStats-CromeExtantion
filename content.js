// ─── PARSE PROBLEM FROM URL ───────────────────────────────────────────────────
function getProblemFromURL() {
  const href = location.href;
  let match = href.match(/\/contest\/(\d+)\/problem\/([A-Z0-9]+)/i);
  if (match) return { contestId: match[1], problemIndex: match[2].toUpperCase() };
  match = href.match(/\/problemset\/problem\/(\d+)\/([A-Z0-9]+)/i);
  if (match) return { contestId: match[1], problemIndex: match[2].toUpperCase() };
  match = href.match(/\/gym\/(\d+)\/problem\/([A-Z0-9]+)/i);
  if (match) return { contestId: match[1], problemIndex: match[2].toUpperCase() };
  return null;
}

// ─── GET HANDLE FROM PAGE ─────────────────────────────────────────────────────
function getMyHandle() {
  const el = document.querySelector("a[href^='/profile/']");
  if (el) {
    const match = el.href.match(/\/profile\/([^/]+)/);
    if (match) return match[1];
  }
  return null;
}

// ─── FETCH MY LAST AC ─────────────────────────────────────────────────────────
async function getMyLastAC(handle, contestId, problemIndex) {

  // Strategy 1: scrape /contest/XXX/my?filterByIndex=G
  // Most reliable — scoped exactly to this contest + problem
  try {
    const url = `https://codeforces.com/contest/${contestId}/my?filterByIndex=${problemIndex}`;
    const res  = await fetch(url, { credentials: "same-origin" });
    const html = await res.text();
    const doc  = new DOMParser().parseFromString(html, "text/html");
    const rows = doc.querySelectorAll("table.status-frame-datatable tr[data-submission-id]");
    for (const row of rows) {
      const verdictCell = row.querySelector("td.status-verdict-cell");
      if (!verdictCell || !verdictCell.textContent.includes("Accepted")) continue;
      const timeText = row.querySelector(".time-consumed-cell")?.textContent || "";
      const memText = row.querySelector(".memory-consumed-cell")?.textContent || "";
      const timeMs = parseInt(timeText.trim(), 10);
      const memKB  = parseInt(memText.trim(), 10);
      if (!isNaN(timeMs) && timeMs > 0) {
        console.log(`[CF Stats] My AC (page): ${timeMs}ms ${memKB}KB`);
        return { timeMs, memKB: isNaN(memKB) ? 0 : memKB };
      }
    }
  } catch (e) { console.log("[CF Stats] Strategy 1 error:", e); }

  // Strategy 2: API with exact contestId + problemIndex match
  try {
    for (let from = 1; from <= 5000; from += 500) {
      const res  = await fetch(`https://codeforces.com/api/user.status?handle=${handle}&from=${from}&count=500`);
      const data = await res.json();
      if (data.status !== "OK" || !data.result || data.result.length === 0) break;
      const ac = data.result.find(
        (s) =>
          s.verdict === "OK" &&
          String(s.problem.contestId) === String(contestId) &&
          s.problem.index.toUpperCase() === problemIndex
      );
      if (ac) {
        console.log(`[CF Stats] My AC (API): ${ac.timeConsumedMillis}ms ${Math.round(ac.memoryConsumedBytes/1024)}KB`);
        return { timeMs: ac.timeConsumedMillis, memKB: Math.round(ac.memoryConsumedBytes / 1024) };
      }
      if (data.result.length < 500) break;
    }
  } catch (e) { console.log("[CF Stats] Strategy 2 error:", e); }

  console.log("[CF Stats] No AC found");
  return null;
}

// ─── SCRAPE ONE PAGE ──────────────────────────────────────────────────────────
// NO custom sort — use default CF order to avoid 403
// We collect all pages and compute stats from the full dataset ourselves
async function scrapeACPage(contestId, problemIndex, page) {
  // Default URL — no order param — avoids 403
  const url = `https://codeforces.com/contest/${contestId}/status/${problemIndex}?verdict=OK&page=${page}`;
  let res;
  try {
    res = await fetch(url, { credentials: "same-origin" });
  } catch (e) {
    console.log(`[CF Stats] Fetch error page ${page}:`, e);
    return { results: [], maxPage: 1 };
  }

  if (res.status === 403) {
    console.log(`[CF Stats] 403 on page ${page} — skipping`);
    return { results: [], maxPage: 1 };
  }

  const html = await res.text();
  const doc  = new DOMParser().parseFromString(html, "text/html");

  const rows    = doc.querySelectorAll("table.status-frame-datatable tr[data-submission-id]");
  const results = [];

  for (const row of rows) {
    const timeText = row.querySelector(".time-consumed-cell")?.textContent || "";
    const memText = row.querySelector(".memory-consumed-cell")?.textContent || "";
    const timeMs = parseInt(timeText.trim(), 10);
    const memKB  = parseInt(memText.trim(), 10);
    // strict validation — no zeros, no NaN, realistic upper bounds
    if (
      !isNaN(timeMs) && timeMs > 0 && timeMs < 20000 &&
      !isNaN(memKB)  && memKB  > 0 && memKB  < 1000000
    ) {
      results.push({ timeMs, memKB });
    }
  }

  // Read total pages from pagination
  const pageLinks = doc.querySelectorAll(".pagination li a");
  let maxPage = 1;
  for (const a of pageLinks) {
    const n = parseInt(a.textContent.trim());
    if (!isNaN(n) && n > maxPage) maxPage = n;
  }

  console.log(`[CF Stats] Page ${page}: ${results.length} valid AC rows, maxPage=${maxPage}`);
  return { results, maxPage };
}

// ─── FETCH ALL PAGES ──────────────────────────────────────────────────────────
async function fetchAllAC(contestId, problemIndex, onProgress) {
  try {
    onProgress(10, "Fetching via Codeforces API...");
    
    // Smooth fake progress while waiting for the heavy CF API response
    let fakePct = 10;
    const fakeInterval = setInterval(() => {
      fakePct += (90 - fakePct) * 0.15; // Asymptotically approach 90%
      onProgress(Math.round(fakePct), "Fetching via Codeforces API...");
    }, 400);

    const res = await fetch(`https://codeforces.com/api/contest.status?contestId=${contestId}`);
    clearInterval(fakeInterval);
    
    onProgress(90, "Parsing data...");
    const data = await res.json();
    
    if (data.status === "OK") {
      onProgress(95, "Processing submissions...");
      const allAC = [];
      for (const s of data.result) {
        if (s.verdict === "OK" && s.problem.index.toUpperCase() === problemIndex) {
          allAC.push({
            timeMs: s.timeConsumedMillis,
            memKB: Math.round(s.memoryConsumedBytes / 1024)
          });
        }
      }
      if (allAC.length > 0) {
        console.log(`[CF Stats] Total valid AC collected via API: ${allAC.length}`);
        onProgress(100, "Done!");
        return allAC;
      }
    }
  } catch (e) {
    console.log("[CF Stats] API fetch failed, falling back to scraping", e);
  }

  onProgress(20, "API failed. Scraping page 1…");
  const first = await scrapeACPage(contestId, problemIndex, 1);
  let allAC   = [...first.results];

  const totalPages = Math.min(first.maxPage, 50); // limit to 50 pages so it doesn't take forever
  console.log(`[CF Stats] Total pages to scrape: ${totalPages}`);

  if (totalPages > 1) {
    const remaining = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const batchSize = 5; 
    for (let i = 0; i < remaining.length; i += batchSize) {
      const batch = remaining.slice(i, i + batchSize);
      const pct   = Math.round(((i + batchSize) / remaining.length) * 100);
      onProgress(pct, `Scraping pages ${batch[0]}–${batch[batch.length - 1]} of ${totalPages} · ${allAC.length} AC…`);
      const batchResults = await Promise.all(
        batch.map((p) => scrapeACPage(contestId, problemIndex, p))
      );
      for (const r of batchResults) allAC = allAC.concat(r.results);
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`[CF Stats] Total valid AC collected: ${allAC.length}`);
  if (allAC.length > 0) {
    console.log(`[CF Stats] Time range: ${Math.min(...allAC.map(s=>s.timeMs))}ms – ${Math.max(...allAC.map(s=>s.timeMs))}ms`);
  }
  return allAC;
}

// ─── MATH ─────────────────────────────────────────────────────────────────────
function computePercentile(val, arr) {
  if (val == null || arr.length === 0) return null;
  const beaten = arr.filter((v) => v > val).length;
  const tied   = arr.filter((v) => v === val).length;
  return Math.round(((beaten + tied * 0.5) / arr.length) * 100);
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function avg(arr) {
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function getStats(mine, submissions) {
  const times = submissions.map((s) => s.timeMs);
  const mems  = submissions.map((s) => s.memKB);

  console.log(`[CF Stats] Computing stats over ${submissions.length} submissions`);
  console.log(`[CF Stats] Mine:`, mine);
  console.log(`[CF Stats] Time — min:${Math.min(...times)} max:${Math.max(...times)} avg:${avg(times)} median:${median(times)}`);
  console.log(`[CF Stats] Mem  — min:${Math.min(...mems)}  max:${Math.max(...mems)}  avg:${avg(mems)}  median:${median(mems)}`);

  return {
    timePct: computePercentile(mine?.timeMs, times),
    memPct:  computePercentile(mine?.memKB,  mems),
    time: {
      yours:  mine?.timeMs ?? null,
      best:   Math.min(...times),
      median: median(times),
      avg:    avg(times),
      worst:  Math.max(...times),
    },
    mem: {
      yours:  mine?.memKB ?? null,
      best:   Math.min(...mems),
      median: median(mems),
      avg:    avg(mems),
      worst:  Math.max(...mems),
    },
    total: submissions.length,
  };
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
function pctColor(pct) {
  if (pct == null) return "#555";
  if (pct >= 75) return "#00e676";
  if (pct >= 40) return "#ffb300";
  return "#ff5252";
}

function pctLabel(pct) {
  if (pct == null) return "";
  if (pct >= 75) return "🔥 Top " + (100 - pct) + "%";
  if (pct >= 40) return "✅ Average";
  return "⚠️ Below avg";
}

function buildBar(pct) {
  const c = pctColor(pct);
  return `
    <div class="cf-bar-track">
      <div class="cf-bar-fill" style="width:${pct ?? 0}%;background:${c};box-shadow:0 0 8px ${c}88"></div>
    </div>`;
}

function buildCard(icon, title, pct, t, unit) {
  const color = pctColor(pct);
  const badge = pctLabel(pct);

  const yoursRow = t.yours != null ? `
    <div class="cf-row cf-row-yours">
      <span class="cf-lbl">⭐ Yours</span>
      <span class="cf-val" style="color:${color}">${t.yours} ${unit}</span>
    </div>` : "";

  const pctSection = pct != null ? `
    <div class="cf-pct-num" style="color:${color}">${pct}<span class="cf-pct-sym">%</span></div>
    <div class="cf-pct-badge" style="color:${color};border-color:${color}33;background:${color}11">${badge}</div>
    <div class="cf-pct-sub">better than ${pct}% of all AC submissions</div>
    ${buildBar(pct)}
  ` : `
    <div class="cf-pct-num" style="color:#555">—</div>
    <div class="cf-pct-sub" style="color:#555;margin-top:6px">no AC found for this problem</div>
  `;

  return `
    <div class="cf-card">
      <div class="cf-card-head">${icon} ${title}</div>
      <div class="cf-card-pct">${pctSection}</div>
      <div class="cf-divider"></div>
      <div class="cf-rows">
        ${yoursRow}
        <div class="cf-row"><span class="cf-lbl">🏆 Best</span>  <span class="cf-val cf-val-best">${t.best} ${unit}</span></div>
        <div class="cf-row"><span class="cf-lbl">⚖️ Median</span><span class="cf-val">${t.median} ${unit}</span></div>
        <div class="cf-row"><span class="cf-lbl">📊 Avg</span>   <span class="cf-val">${t.avg} ${unit}</span></div>
        <div class="cf-row"><span class="cf-lbl">🐢 Worst</span> <span class="cf-val cf-val-worst">${t.worst} ${unit}</span></div>
      </div>
    </div>`;
}

function renderStatsBox(stats, container, handle) {
  container.innerHTML = `
    <div class="cf-box">
      <div class="cf-box-header">
        <div class="cf-box-left">
          <span class="cf-box-title">📊 Submission Stats</span>
          ${handle
            ? `<span class="cf-handle-badge">@${handle}</span>`
            : `<span class="cf-handle-badge cf-no-login">not logged in</span>`}
        </div>
        <div class="cf-box-right">
          <span class="cf-sample-badge">${stats.total.toLocaleString()} AC submissions</span>
        </div>
      </div>
      <div class="cf-grid">
        ${buildCard("⚡", "Runtime", stats.timePct, stats.time, "ms")}
        ${buildCard("🧠", "Memory",  stats.memPct,  stats.mem,  "KB")}
      </div>
    </div>`;
}

function renderProgress(pct, msg, container) {
  container.innerHTML = `
    <div class="cf-progress-box">
      <div class="cf-progress-msg">${msg}</div>
      <div class="cf-progress-track">
        <div class="cf-progress-fill" style="width:${Math.min(pct, 100)}%"></div>
      </div>
      <div class="cf-progress-pct">${Math.min(pct, 100)}%</div>
    </div>`;
}

// ─── FIND ANCHOR ─────────────────────────────────────────────────────────────
function findAnchor() {
  return (
    document.querySelector(".submitForm") ||
    document.querySelector("#submitForm") ||
    document.querySelector("form[action*='submit']") ||
    document.querySelector(".problem-statement")
  );
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  const problem = getProblemFromURL();
  if (!problem) return;
  const anchor = findAnchor();
  if (!anchor) return;

  const wrapper = document.createElement("div");
  wrapper.id = "cf-stats-wrapper";

  const btn = document.createElement("button");
  btn.id = "cf-stats-btn";
  btn.innerHTML = `<span class="cf-btn-icon">📊</span> Analyze Submissions`;

  const output = document.createElement("div");
  output.id = "cf-stats-output";

  wrapper.appendChild(btn);
  wrapper.appendChild(output);
  anchor.insertAdjacentElement("afterend", wrapper);

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.innerHTML = `<span class="cf-btn-icon">⏳</span> Fetching…`;

    const handle = getMyHandle();
    const t0     = Date.now();

    const [submissions, mine] = await Promise.all([
      fetchAllAC(problem.contestId, problem.problemIndex, (pct, msg) => {
        renderProgress(pct, msg, output);
        btn.innerHTML = `<span class="cf-btn-icon">⏳</span> ${msg}`;
      }),
      handle
        ? getMyLastAC(handle, problem.contestId, problem.problemIndex)
        : Promise.resolve(null),
    ]);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (submissions.length === 0) {
      output.innerHTML = `<div class="cf-error">❌ No AC submissions found. Contest may not be public yet.</div>`;
      btn.innerHTML = `<span class="cf-btn-icon">🔄</span> Retry`;
      btn.disabled = false;
      return;
    }

    renderStatsBox(getStats(mine, submissions), output, handle);
    btn.innerHTML = `<span class="cf-btn-icon">🔄</span> Refresh · ${elapsed}s · ${submissions.length.toLocaleString()} AC`;
    btn.disabled = false;
  });
}

init();