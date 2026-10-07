import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { scaleLinear } from "d3-scale";
import { line as d3line, curveStepAfter } from "d3-shape";
import {
  METRICS, DOMAINS, aggregate, fmt, status, statusLabel, pChart, STRATA, COMPLETENESS,
} from "./metrics.js";
import { Sparkline, RunChart, BarBreakdown, StrataLines, Funnel, Lane, useWidth, monthLabel } from "./charts.jsx";
import "./styles.css";

const DATA = window.__DASHBOARD_DATA__;
const D = DATA ? DATA.decisions : null;
const MIN_N = D ? (D.shared.find((d) => d.id === "small_cell_n") || {}).value || 11 : 11;
const MBYID = Object.fromEntries(METRICS.map((m) => [m.id, m]));

// LTVV can be viewed at several thresholds (decisions.yaml: thresholds_selectable).
// The route arg carries the choice, e.g. #/metric/ltvv@7, so links and the back button keep it.
const LTVV_THRS = DATA ? DATA.meta.ltvv_thresholds || [] : [];
const ltvvKey = (t) => "ltvv_num_" + String(t).replace(".", "_");
function resolveMetric(raw) {
  const [id, t] = String(raw || "").split("@");
  const base = MBYID[id] || METRICS[0];
  const meta = D.metrics[base.id];
  if (base.id !== "ltvv") return { m: base, meta, thr: null, routeId: base.id };
  const def = meta.decisions.find((d) => d.id === "threshold_ml_kg").value;
  const thr = t != null && LTVV_THRS.includes(+t) ? +t : def;
  const key = LTVV_THRS.includes(thr) ? ltvvKey(thr) : "ltvv_num";
  const m = { ...base, agg: { kind: "ratio", num: key, den: "ltvv_den" }, missed: (e) => e.ltvv_den > 0 && e[key] / e.ltvv_den < 0.8, numKey: key };
  const decisions = meta.decisions.map((d) => (d.id === "threshold_ml_kg"
    ? { ...d, display: `≤ ${thr} mL/kg PBW — selected on this page${thr !== def ? ` (default ≤ ${def}, used on the Overview)` : " (default)"}` }
    : d));
  const meta2 = {
    ...meta, decisions,
    title: `Low tidal volume ventilation (≤ ${thr} mL/kg PBW)`,
    numerator: `IMV hours with set tidal volume ≤ ${thr} mL/kg predicted body weight`,
  };
  return { m, meta: meta2, thr, def, routeId: `ltvv@${thr}` };
}

// ----------------------------------------------------------------------------
// Routing (hash) so the browser back button works between pages
// ----------------------------------------------------------------------------
function useRoute() {
  const parse = () => {
    const [page, arg] = (window.location.hash.replace(/^#\/?/, "") || "overview").split("/");
    return { page: page || "overview", arg: arg ? decodeURIComponent(arg) : null };
  };
  const [r, setR] = useState(parse);
  useEffect(() => {
    const f = () => { setR(parse()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return r;
}
const go = (page, arg) => { window.location.hash = `/${page}${arg ? "/" + encodeURIComponent(arg) : ""}`; };

// ----------------------------------------------------------------------------
// Filters
// ----------------------------------------------------------------------------
const FILTER_FIELDS = [
  ["hospital", "Hospital"], ["unit", "ICU"], ["age_band", "Age band"], ["sex", "Sex"],
  ["race_eth", "Race / ethnicity"], ["code_status", "Code status at IMV start"],
];
const uniq = (rows, f) => [...new Set(rows.map((r) => r[f]).filter((v) => v != null))].sort();

function applyFilters(rows, F) {
  return rows.filter((r) => {
    if (F.from && r.month < F.from) return false;
    if (F.to && r.month > F.to) return false;
    for (const [f] of FILTER_FIELDS) if (F[f] && F[f].length && !F[f].includes(r[f])) return false;
    if (F.trach === "yes" && r.trach === false) return false;
    if (F.trach === "no" && r.trach === true) return false;
    return true;
  });
}

function MultiSelect({ label, options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const sel = value || [];
  const text = sel.length === 0 ? "All" : sel.length === 1 ? sel[0] : `${sel.length} selected`;
  return (
    <div className="ms">
      <label className="f-lab">{label}</label>
      <button className="ms-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{text}</span><span className="chev">▾</span>
      </button>
      {open && (
        <div className="ms-pop" onMouseLeave={() => setOpen(false)}>
          <button className="ms-clear" onClick={() => onChange([])}>All</button>
          {options.map((o) => (
            <label key={o} className="ms-opt">
              <input type="checkbox" checked={sel.includes(o)}
                onChange={(e) => onChange(e.target.checked ? [...sel, o] : sel.filter((x) => x !== o))} />
              {o}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterRail({ F, setF, nEp, nTot }) {
  const months = DATA.meta.months;
  const all = DATA.episodes;
  const active = Object.entries(F).filter(([k, v]) => (Array.isArray(v) ? v.length : v)).length;
  return (
    <aside className="rail" aria-label="Filters">
      <div className="rail-head">
        <h2>Filters</h2>
        {active > 0 && <button className="link" onClick={() => setF({})}>Reset</button>}
      </div>
      <div className="rail-count"><b>{nEp}</b> of {nTot} IMV episodes</div>
      <label className="f-lab">From</label>
      <select value={F.from || ""} onChange={(e) => setF({ ...F, from: e.target.value || null })}>
        <option value="">Earliest ({monthLabel(months[0])})</option>
        {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
      </select>
      <label className="f-lab">To</label>
      <select value={F.to || ""} onChange={(e) => setF({ ...F, to: e.target.value || null })}>
        <option value="">Latest ({monthLabel(months[months.length - 1])})</option>
        {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
      </select>
      {FILTER_FIELDS.map(([f, lab]) => (
        <MultiSelect key={f} label={lab} options={uniq(all, f)} value={F[f]} onChange={(v) => setF({ ...F, [f]: v })} />
      ))}
      <label className="f-lab">Tracheostomy during episode</label>
      <select value={F.trach || ""} onChange={(e) => setF({ ...F, trach: e.target.value || null })}>
        <option value="">All</option><option value="yes">Yes</option><option value="no">No</option>
      </select>
      <p className="rail-note">Scope: invasive mechanical ventilation in adult ICU patients. Filters apply to every page.</p>
    </aside>
  );
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function rowsFor(m, ep, pr) { return m.source === "proning" ? pr : ep; }

function monthly(m, rows, months) {
  const by = {};
  for (const r of rows) (by[r.month] = by[r.month] || []).push(r);
  return months.map((mo) => ({ month: mo, ...aggregate(m, by[mo] || []) }));
}

function byStratum(m, rows, field) {
  const by = {};
  for (const r of rows) { const k = r[field] ?? "Unknown"; (by[k] = by[k] || []).push(r); }
  return Object.entries(by).map(([key, rs]) => ({ key, ...aggregate(m, rs) }))
    .sort((a, b) => (b.n || 0) - (a.n || 0));
}

function StatusChip({ s, meta }) {
  const icon = { good: "✓", warning: "!", critical: "✕", none: "–" }[s];
  return <span className={`chip chip-${s}`}><span className="chip-ic" aria-hidden="true">{icon}</span>{statusLabel(s, meta)}</span>;
}

function downloadCSV(name, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = name;
  a.click();
}

// ----------------------------------------------------------------------------
// Overview
// ----------------------------------------------------------------------------
function Overview({ ep, pr }) {
  const months = useMemo(() => [...new Set(ep.map((r) => r.month).concat(pr.map((r) => r.month)))].sort(), [ep, pr]);
  return (
    <div>
      <div className="page-head">
        <h1>Overview</h1>
        <p className="lede">{ep.length} IMV episodes and {pr.length} {pr.length === 1 ? "patient" : "patients"} in the proning cohort for the current filters. Click any measure for its run chart, breakdowns and the full list of decisions behind it.</p>
      </div>
      {DOMAINS.map((dom) => {
        const ms = METRICS.filter((m) => D.metrics[m.id].domain === dom);
        return (
          <section key={dom} className="domain">
            <h2 className="domain-title">{dom}</h2>
            <div className="tiles">
              {ms.map((m) => {
                const meta = D.metrics[m.id];
                const rows = rowsFor(m, ep, pr);
                const a = aggregate(m, rows);
                const s = status(a.value, meta);
                const series = monthly(m, rows, months);
                const small = (a.n || 0) < MIN_N;
                return (
                  <button key={m.id} className="tile" onClick={() => go("metric", m.id)}>
                    <div className="tile-top">
                      <span className="tile-num">{meta.number}</span>
                      <span className="tile-title">{meta.short}</span>
                    </div>
                    <div className="tile-val">{fmt(a.value, meta)}</div>
                    <div className="tile-sub">
                      {m.agg.kind === "ratio" ? `${a.num ?? 0} / ${a.den ?? 0} ${m.denLabel}` : `n ${a.n} ${m.denLabel}`}
                      {a.oe != null && <span> · O/E {a.oe.toFixed(2)}</span>}
                    </div>
                    <div className="tile-foot">
                      <StatusChip s={s} meta={meta} />
                      <Sparkline points={series} domain={meta.unit === "%" ? [0, 100] : null} />
                    </div>
                    {small && <div className="tile-warn">⚠ n &lt; {MIN_N}: interpret with caution</div>}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Decisions panel
// ----------------------------------------------------------------------------
function DecisionTable({ rows }) {
  return (
    <table className="dtable">
      <thead><tr><th>Decision</th><th>Choice used</th><th>Alternatives</th><th>Source</th></tr></thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.id}>
            <td className="d-lab">{d.label}</td>
            <td>{d.display}</td>
            <td className="muted">{(d.alternatives || []).length ? d.alternatives.join("; ") : "—"}</td>
            <td className="muted">{d.source}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DecisionsPanel({ meta, agg, m }) {
  const [shared, setShared] = useState(false);
  return (
    <section className="card decisions" aria-labelledby="dec-h">
      <h2 id="dec-h">How this is calculated</h2>
      <div className="numden">
        <div><span className="nd-k">Numerator</span><span>{meta.numerator}</span>{m.agg.kind === "ratio" && <b className="nd-v">{agg.num}</b>}</div>
        <div><span className="nd-k">Denominator</span><span>{meta.denominator}</span>{m.agg.kind === "ratio" ? <b className="nd-v">{agg.den}</b> : <b className="nd-v">n {agg.n}</b>}</div>
        <div><span className="nd-k">Target</span><span>{meta.target != null ? `${meta.direction === "lower" ? "≤" : "≥"} ${fmt(meta.target, meta)}` : "None set — add one under this metric in decisions.yaml"}</span></div>
      </div>
      <h3>Decisions for this measure</h3>
      <DecisionTable rows={meta.decisions} />
      <button className="link" onClick={() => setShared(!shared)} aria-expanded={shared}>
        {shared ? "Hide" : "Show"} the {D.shared.length} decisions shared by every measure
      </button>
      {shared && <DecisionTable rows={D.shared} />}
      <p className="muted small">Every choice above is read from <code>decisions.yaml</code>; change a value there and re-run <code>python build_dashboard.py</code> to update both the numbers and this panel.</p>
    </section>
  );
}

// ----------------------------------------------------------------------------
// Metric detail
// ----------------------------------------------------------------------------
function MetricPage({ id, ep, pr }) {
  const { m, meta, thr, def, routeId } = resolveMetric(id);
  const rows = rowsFor(m, ep, pr);
  const agg = aggregate(m, rows);
  const months = useMemo(() => [...new Set(rows.map((r) => r.month))].sort(), [rows]);
  const series = monthly(m, rows, months);
  const independent = ["episodes", "patients", "encounters", "extubations", "ICU transfers out"].includes(m.denLabel);
  const control = m.agg.kind === "ratio" && independent ? pChart(series) : null;
  const [strat, setStrat] = useState("unit");
  const [view, setView] = useState("bars");
  const strata = byStratum(m, rows, strat);
  const f = (v) => fmt(v, meta);
  const s = status(agg.value, meta);
  const ix = METRICS.findIndex((x) => x.id === m.id);

  const topKeys = strata.slice(0, 6).map((r) => r.key);
  const lines = topKeys.map((k) => ({ key: k, points: monthly(m, rows.filter((r) => (r[strat] ?? "Unknown") === k), months) }));

  const oeRows = m.oe ? byStratum(m, rows, strat) : [];
  const funnel = m.source === "proning" ? DATA.proning_funnel : DATA.funnel;
  const comp = COMPLETENESS.filter(([k]) => m.needs.includes(k));

  return (
    <div>
      <nav className="crumbs"><a href="#/overview">Overview</a> / {meta.domain}</nav>
      <div className="page-head metric-head">
        <div>
          <h1><span className="h-num">{meta.number}</span>{meta.title}</h1>
          {thr != null && LTVV_THRS.length > 1 && (
            <div className="thr-pick" role="group" aria-label="Tidal volume threshold">
              <span className="thr-lab">Threshold</span>
              {LTVV_THRS.map((t) => {
                const a = aggregate({ ...m, agg: { kind: "ratio", num: ltvvKey(t), den: "ltvv_den" } }, rows);
                return (
                  <button key={t} className={t === thr ? "on" : ""} aria-pressed={t === thr}
                    onClick={() => go("metric", `ltvv@${t}`)}>
                    ≤ {t} mL/kg<span className="thr-v">{fmt(a.value, meta)}</span>{t === def && <span className="thr-def">default</span>}
                  </button>
                );
              })}
            </div>
          )}
          <div className="headline">
            <span className="big">{f(agg.value)}</span>
            <StatusChip s={s} meta={meta} />
            <span className="muted">
              {m.agg.kind === "ratio" ? `${agg.num} of ${agg.den} ${m.denLabel}` : `${m.agg.kind} of ${agg.n} ${m.denLabel}${agg.q1 != null ? ` · IQR ${f(agg.q1)}–${f(agg.q3)}` : ""}`}
            </span>
          </div>
          {agg.oe != null && (
            <div className="oe-line">
              Observed {f(agg.value)} vs expected {f(agg.expected)} · <b>O/E {agg.oe.toFixed(2)}</b>
              <span className="muted"> ({m.id === "mortality" ? "site-fitted model; compares groups with this site's average" : "CLIF consortium global coefficients"})</span>
            </div>
          )}
          {m.extra && (
            <div className="oe-line">
              {m.extra.map((k) => {
                const a = aggregate({ ...m, agg: { kind: "ratio", num: k, den: null } }, rows);
                return <span key={k} className="pill">{k === "proned" ? "Ever proned" : `Proned ≤ ${k.slice(1)} h`}: <b>{f(a.value)}</b> ({a.num}/{a.den})</span>;
              })}
            </div>
          )}
          {m.parts && (
            <div className="oe-line">
              {m.parts.map(([k, lab]) => {
                const a = aggregate({ ...m, agg: { kind: "ratio", num: k, den: m.agg.den } }, rows);
                return <span key={k} className="pill">{lab}: <b>{f(a.value)}</b> ({a.num}/{a.den})</span>;
              })}
            </div>
          )}
        </div>
        <div className="pager">
          {ix > 0 && <button className="btn" onClick={() => go("metric", METRICS[ix - 1].id)}>← {D.metrics[METRICS[ix - 1].id].short}</button>}
          {ix < METRICS.length - 1 && <button className="btn" onClick={() => go("metric", METRICS[ix + 1].id)}>{D.metrics[METRICS[ix + 1].id].short} →</button>}
        </div>
      </div>

      <DecisionsPanel meta={meta} agg={agg} m={m} />

      <section className="card">
        <div className="card-head">
          <h2>By month</h2>
          <button className="btn" onClick={() => downloadCSV(`${routeId.replace("@", "_le")}_by_month.csv`, series.map((p) => ({ month: p.month, value: p.value, numerator: p.num, denominator: p.den, n: p.n })))}>Download CSV</button>
        </div>
        <p className="muted small">
          {control ? "p-chart: the shaded bar behind each month is its 3-sigma control limit around the overall mean; red points fall outside it. " : m.agg.kind === "ratio" ? `Control limits are not drawn because ${m.denLabel} are clustered within patients, which would make limits falsely narrow. ` : `Monthly ${m.agg.kind}. `}
          Hollow points have n &lt; {MIN_N}.
        </p>
        {series.some((p) => p.value != null) ? (
          <RunChart points={series} meta={meta} control={control} target={meta.target} format={f} minN={MIN_N} />
        ) : <p className="empty">No data for this measure under the current filters.</p>}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Breakdown</h2>
          <div className="seg">
            <select value={strat} onChange={(e) => setStrat(e.target.value)} aria-label="Group by">
              {STRATA.map((x) => <option key={x.id} value={x.id}>By {x.label}</option>)}
            </select>
            <div className="toggle" role="tablist">
              <button className={view === "bars" ? "on" : ""} onClick={() => setView("bars")}>Overall</button>
              <button className={view === "lines" ? "on" : ""} onClick={() => setView("lines")}>Over time</button>
              <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>Table</button>
            </div>
          </div>
        </div>
        {view === "bars" && <BarBreakdown rows={strata} meta={meta} target={meta.target} format={f} minN={MIN_N}
          onPick={(k) => go("patients", `${routeId}|${strat}|${k}`)} />}
        {view === "lines" && (
          <>
            <div className="legend">
              {lines.map((l, i) => <span key={l.key}><i className="swatch" style={{ background: `var(--series-${i + 1})` }} />{l.key}</span>)}
              {strata.length > 6 && <span className="muted">Showing the 6 largest groups</span>}
            </div>
            <StrataLines series={lines} months={months} meta={meta} format={f} />
          </>
        )}
        {view === "table" && (
          <table className="dtable num">
            <thead><tr><th>{STRATA.find((x) => x.id === strat).label}</th><th>Value</th>{m.agg.kind === "ratio" && <th>Numerator</th>}<th>{m.agg.kind === "ratio" ? "Denominator" : "n"}</th>{m.oe && <th>Expected</th>}{m.oe && <th>O/E</th>}</tr></thead>
            <tbody>{strata.map((r) => (
              <tr key={r.key} className={(r.n || 0) < MIN_N ? "row-small" : ""}>
                <td>{r.key}</td><td>{f(r.value)}</td>{m.agg.kind === "ratio" && <td>{r.num}</td>}<td>{m.agg.kind === "ratio" ? r.den : r.n}</td>
                {m.oe && <td>{f(r.expected)}</td>}{m.oe && <td>{r.oe != null ? r.oe.toFixed(2) : "—"}</td>}
              </tr>))}
            </tbody>
          </table>
        )}
        <p className="muted small">Click a bar to list the episodes behind it. Groups with n &lt; {MIN_N} are greyed (⚠).</p>
      </section>

      {m.oe && (
        <section className="card">
          <h2>Observed vs expected by {STRATA.find((x) => x.id === strat).label}</h2>
          <p className="muted small">{m.id === "mortality"
            ? "Expected = logistic model fitted on this site's own encounters (age, sex, SOFA in the 24 h before IMV, Charlson index). O/E > 1 means more deaths than this site's case mix predicts."
            : "Expected = CLIF proning study global model (age, sex, BMI, norepinephrine-equivalent category, SOFA, minimum P/F). O/E < 1 means less proning than predicted for these patients."}</p>
          <table className="dtable num">
            <thead><tr><th>Group</th><th>{m.denLabel[0].toUpperCase() + m.denLabel.slice(1)}</th><th>Observed</th><th>Expected</th><th>O/E</th></tr></thead>
            <tbody>{oeRows.map((r) => (
              <tr key={r.key} className={(r.n || 0) < MIN_N ? "row-small" : ""}>
                <td>{r.key}</td><td>{r.den}</td><td>{r.num} ({f(r.value)})</td><td>{r.expectedCount != null ? r.expectedCount.toFixed(1) : "—"} ({f(r.expected)})</td><td><b>{r.oe != null ? r.oe.toFixed(2) : "—"}</b></td>
              </tr>))}
            </tbody>
          </table>
        </section>
      )}

      <div className="two-col">
        <section className="card">
          <h2>Cohort</h2>
          <p className="muted small">{m.source === "proning" ? "Proning cohort (CLIF proning study definition, ported to Python)." : "IMV episode cohort shared by all non-proning measures."} Counts are for the full data, before the filters on the left.</p>
          <Funnel steps={funnel} />
        </section>
        <section className="card">
          <h2>Input completeness</h2>
          <p className="muted small">Share of filtered IMV episodes with each input this measure depends on. Low completeness usually explains odd values better than practice does.</p>
          {comp.length ? (
            <table className="dtable num">
              <tbody>{comp.map(([k, lab]) => {
                const n = ep.filter((e) => e[k]).length;
                return <tr key={k}><td>{lab}</td><td>{ep.length ? Math.round((100 * n) / ep.length) : 0}%</td><td className="muted">{n} / {ep.length}</td></tr>;
              })}</tbody>
            </table>
          ) : <p className="muted small">Uses ventilator, ADT and discharge data only.</p>}
          <p className="small">Provenance: {DATA.meta.clifpy}; pipeline {DATA.meta.pipeline_version}; data folder <code>{DATA.meta.data_folder}</code>, built {DATA.meta.generated_at}.</p>
          <button className="link" onClick={() => go("patients", `${routeId}|missed|1`)}>List episodes that missed this measure →</button>
        </section>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Unit comparison heatmap
// ----------------------------------------------------------------------------
function Units({ ep, pr }) {
  const units = uniq(ep, "unit");
  return (
    <div>
      <div className="page-head">
        <h1>ICU comparison</h1>
        <p className="lede">Each cell is the measure for one ICU under the current filters. Icons show target status; grey cells have fewer than {MIN_N} in the denominator. Click a cell to see its episodes.</p>
      </div>
      <div className="card scroll-x">
        <table className="heat">
          <thead>
            <tr><th>Measure</th><th>All ICUs</th>{units.map((u) => <th key={u}>{u}</th>)}</tr>
          </thead>
          <tbody>
            {METRICS.map((m) => {
              const meta = D.metrics[m.id];
              const rows = rowsFor(m, ep, pr);
              const all = aggregate(m, rows);
              return (
                <tr key={m.id}>
                  <th scope="row"><a href={`#/metric/${m.id}`}><span className="h-num sm">{meta.number}</span>{meta.short}</a></th>
                  <HeatCell a={all} meta={meta} />
                  {units.map((u) => {
                    const a = aggregate(m, rows.filter((r) => r.unit === u));
                    return <HeatCell key={u} a={a} meta={meta} onClick={() => go("patients", `${m.id}|unit|${u}`)} />;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HeatCell({ a, meta, onClick }) {
  const s = status(a.value, meta);
  const small = (a.n || 0) < MIN_N;
  const icon = { good: "✓", warning: "!", critical: "✕", none: "" }[s];
  return (
    <td className={`hc hc-${a.value == null ? "na" : small ? "small" : s}`} onClick={onClick} title={statusLabel(s, meta)}>
      {a.value == null ? <span className="muted">—</span> : (
        <>
          <span className="hc-v">{fmt(a.value, meta)}</span>
          {icon && !small && <span className="hc-ic" aria-label={statusLabel(s, meta)}>{icon}</span>}
          <span className="hc-n">n {a.n}</span>
        </>
      )}
    </td>
  );
}

// ----------------------------------------------------------------------------
// Patient (episode) list
// ----------------------------------------------------------------------------
function Patients({ ep, pr, arg }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState(["start", -1]);
  let [mid, field, val] = (arg || "").split("|");
  const R = mid && MBYID[mid.split("@")[0]] ? resolveMetric(mid) : null;
  const m = R ? R.m : null;
  const ltvvCol = R && R.thr != null ? R.m.numKey : "ltvv_num";
  const ltvvThr = R && R.thr != null ? R.thr : null;
  let rows = ep;
  let note = null;
  if (m) {
    const meta = R.meta;
    if (m.source === "proning") {
      const ids = new Set(pr.filter((p) => (field === "missed" ? m.missed(p) : (p[field] ?? "Unknown") === val)).map((p) => p.episode_id));
      rows = rows.filter((e) => ids.has(e.episode_id));
    } else if (field === "missed") rows = rows.filter(m.missed);
    else rows = rows.filter((e) => (e[field] ?? "Unknown") === val);
    note = field === "missed" ? `Episodes that missed: ${meta.short}` : `${meta.short} · ${val}`;
  }
  if (q) rows = rows.filter((e) => Object.values(e).some((v) => String(v).toLowerCase().includes(q.toLowerCase())));
  const [sk, sd] = sort;
  rows = [...rows].sort((a, b) => ((a[sk] ?? -1e9) > (b[sk] ?? -1e9) ? sd : -sd));
  const cols = [
    ["label_id", "Hospitalization"], ["start", "IMV start"], ["unit", "ICU"], ["imv_days", "IMV days"],
    ["vt_pbw_median", "Median Vt/PBW"], ["ltvv", ltvvThr != null ? `LTVV hours (≤ ${ltvvThr})` : "LTVV hours"], ["plat", "Plateau ≤ 30"], ["sat", "SAT days"],
    ["sbt", "SBT days"], ["reint_num", "Reintubated"], ["vfd28", "VFD-28"], ["discharge", "Discharge"],
  ];
  const cell = (e, c) => {
    switch (c) {
      case "ltvv": return e.ltvv_den ? `${Math.round((100 * (e[ltvvCol] ?? e.ltvv_num)) / e.ltvv_den)}% of ${e.ltvv_den} h` : <span className="muted">{e.has_height ? "—" : "no height"}</span>;
      case "plat": return e.plat_den ? `${e.plat_num}/${e.plat_den}` : "—";
      case "sat": return e.sat_den ? `${e.sat_num}/${e.sat_den}` : "—";
      case "sbt": return e.sbt_den ? `${e.sbt_num}/${e.sbt_den}` : "—";
      case "reint_num": return e.ext_den ? (e.reint_num ? "Yes" : "No") : "—";
      default: return e[c] ?? "—";
    }
  };
  return (
    <div>
      <div className="page-head">
        <h1>Episodes</h1>
        <p className="lede">One row per IMV episode. Only hospitalization IDs are shown. Click a row for its hourly timeline.</p>
      </div>
      <div className="card">
        <div className="card-head">
          <div className="seg">
            <input type="search" placeholder="Search ID, ICU, discharge…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={m ? `${m.id}|missed|1` : ""} onChange={(e) => go("patients", e.target.value || null)} aria-label="Show episodes that missed a measure">
              <option value="">All episodes</option>
              {METRICS.map((x) => <option key={x.id} value={`${x.id}|missed|1`}>Missed: {D.metrics[x.id].short}</option>)}
            </select>
          </div>
          <button className="btn" onClick={() => downloadCSV("episodes.csv", rows.map(({ episode_id, ...r }) => r))}>Download CSV</button>
        </div>
        {note && <p className="filter-note">{note} · <a href="#/patients">clear</a></p>}
        <div className="scroll-x">
          <table className="dtable list">
            <thead><tr>{cols.map(([c, lab]) => (
              <th key={c} onClick={() => setSort([c, sk === c ? -sd : 1])} className="sortable">
                {lab}{sk === c ? (sd > 0 ? " ▲" : " ▼") : ""}
              </th>))}</tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.episode_id} onClick={() => go("timeline", e.episode_id)} className="clickable">
                {cols.map(([c]) => <td key={c}>{cell(e, c)}</td>)}
              </tr>))}
            </tbody>
          </table>
        </div>
        <p className="muted small">{rows.length} episodes</p>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Timeline
// ----------------------------------------------------------------------------
const DEV_COLOR = { imv: "var(--series-1)", nippv: "var(--series-2)", cpap: "var(--series-2)", "high flow nc": "var(--series-3)", "trach collar": "var(--series-4)", "nasal cannula": "var(--seq-250)", "face mask": "var(--seq-250)", "room air": "var(--surface-3)" };

function Timeline({ ep, arg }) {
  const fallback = (ep[0] || DATA.episodes[0] || {}).episode_id;
  const id = arg && DATA.timelines[arg] ? arg : fallback;
  const e = DATA.episodes.find((x) => x.episode_id === id);
  const T = DATA.timelines[id];
  const [ref, w] = useWidth(900);
  const pr = DATA.proning.find((p) => p.episode_id === id);
  if (!e || !T) return (
    <div><div className="page-head"><h1>Timeline</h1></div>
      <div className="card"><p className="empty">{e ? "No timeline stored for this episode (only the most recent episodes are embedded; raise timeline_max_episodes in config.yaml)." : "Pick an episode from the Episodes page."}</p></div></div>
  );
  const iw = w - 92;
  const t0 = Math.min(-6, ...T.t), t1 = Math.max(T.end_h + 6, ...T.t);
  const x = scaleLinear().domain([t0, t1]).range([0, iw]);
  const ticks = x.ticks(Math.max(4, Math.floor(iw / 90)));
  const xAxis = (h) => ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={0} y2={h} className="grid" /></g>);
  const segs = [];
  T.device.forEach((d, i) => {
    if (i === 0 || d !== T.device[i - 1]) segs.push({ d, s: T.t[i], e: T.t[i + 1] ?? T.t[i] + 1 });
    else segs[segs.length - 1].e = T.t[i + 1] ?? T.t[i] + 1;
  });
  const lineOf = (vals, y) => d3line().defined((v) => v != null).x((_, i) => x(T.t[i])).y((v) => y(v))(vals);
  const yVt = scaleLinear().domain([4, 12]).range([60, 0]);
  const yPeep = scaleLinear().domain([0, 20]).range([50, 0]);
  const yFio2 = scaleLinear().domain([0.2, 1]).range([50, 0]);
  const yPf = scaleLinear().domain([0, 500]).range([50, 0]);
  const yR = scaleLinear().domain([-5, 4]).range([60, 0]);
  const neeMax = Math.max(0.1, ...T.nee.map((p) => p[1]));
  const yN = scaleLinear().domain([0, neeMax]).nice().range([40, 0]);
  const idx = DATA.episodes.findIndex((x) => x.episode_id === id);
  return (
    <div>
      <nav className="crumbs"><a href="#/patients">Episodes</a> / {e.label_id}</nav>
      <div className="page-head metric-head">
        <div>
          <h1>Hospitalization {e.label_id}</h1>
          <p className="lede">{e.unit} · IMV {e.start} → {e.end} ({e.imv_days} days) · {e.sex}, {e.age_band} · {e.code_status} · discharge: {e.discharge}{e.pbw ? ` · PBW ${e.pbw} kg` : " · no height recorded"}</p>
        </div>
        <div className="pager">
          <select value={id} onChange={(ev) => go("timeline", ev.target.value)} aria-label="Episode">
            {DATA.episodes.filter((x) => DATA.timelines[x.episode_id]).map((x) => <option key={x.episode_id} value={x.episode_id}>{x.label_id} · {x.start.slice(0, 10)}</option>)}
          </select>
        </div>
      </div>
      <div className="two-col tight">
        <div className="card mini"><b>{e.ltvv_den ? `${Math.round((100 * e.ltvv_num) / e.ltvv_den)}%` : "—"}</b><span>LTVV hours</span></div>
        <div className="card mini"><b>{e.sat_den ? `${e.sat_num}/${e.sat_den}` : "—"}</b><span>SAT days</span></div>
        <div className="card mini"><b>{e.sbt_den ? `${e.sbt_num}/${e.sbt_den}` : "—"}</b><span>SBT days</span></div>
        <div className="card mini"><b>{e.vfd28}</b><span>VFD-28</span></div>
        <div className="card mini"><b>{pr ? (pr.proned ? `${pr.hours_to_prone} h` : "Not proned") : "Not in cohort"}</b><span>Proning</span></div>
      </div>
      <section className="card" ref={ref}>
        <p className="muted small">Hours from IMV start (0). Each lane has its own scale; values come from the clifpy waterfall (forward-filled within mode blocks), so flat stretches mean "no new setting documented".</p>
        <div className="xaxis" style={{ marginLeft: 76, width: iw }}>
          {ticks.map((t) => <span key={t} style={{ left: x(t) }}>{t} h</span>)}
        </div>
        <Lane title="Device" w={w} height={30}>
          {segs.filter((s) => s.d).map((s, i) => (
            <rect key={i} x={x(s.s)} y={2} width={Math.max(1, x(s.e) - x(s.s) - 1)} height={18} rx="3"
              fill={DEV_COLOR[s.d] || "var(--surface-3)"}><title>{s.d} {s.s}–{s.e} h</title></rect>
          ))}
        </Lane>
        <div className="legend small">
          {["imv", "nippv", "high flow nc", "trach collar", "nasal cannula"].map((d) => <span key={d}><i className="swatch" style={{ background: DEV_COLOR[d] }} />{d === "imv" ? "IMV" : d}</span>)}
        </div>
        <Lane title="Set tidal volume ÷ PBW" unit="mL/kg; dashed = 8" w={w} height={70} y={yVt} yTicks={[4, 6, 8, 10, 12]}>
          {xAxis(60)}
          <line x1={0} x2={iw} y1={yVt(8)} y2={yVt(8)} className="target-line" />
          <path d={lineOf(T.vt_pbw.map((v) => (v == null ? null : Math.min(12, Math.max(4, v)))), yVt)} fill="none" stroke="var(--series-1)" strokeWidth="2" />
        </Lane>
        <Lane title="PEEP" unit="cmH2O" w={w} height={60} y={yPeep} yTicks={[0, 10, 20]}>
          {xAxis(50)}
          <path d={lineOf(T.peep, yPeep)} fill="none" stroke="var(--series-1)" strokeWidth="2" />
        </Lane>
        <Lane title="FiO2" w={w} height={60} y={yFio2} yTicks={[0.2, 0.6, 1]}>
          {xAxis(50)}
          <path d={lineOf(T.fio2, yFio2)} fill="none" stroke="var(--series-1)" strokeWidth="2" />
        </Lane>
        <Lane title="P/F ratio (ABG) and plateau pressure" unit="P/F; dashed = 150" w={w} height={60} y={yPf} yTicks={[0, 150, 300, 500]}>
          {xAxis(50)}
          <line x1={0} x2={iw} y1={yPf(150)} y2={yPf(150)} className="target-line" />
          {T.pf.map(([t, v], i) => <circle key={i} cx={x(t)} cy={yPf(Math.min(500, v))} r="4" fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth="1.5"><title>P/F {v} at {t} h</title></circle>)}
        </Lane>
        <Lane title="Plateau pressure" unit="cmH2O; dashed = 30" w={w} height={60} y={scaleLinear().domain([0, 40]).range([50, 0])} yTicks={[0, 20, 40]}>
          {xAxis(50)}
          <line x1={0} x2={iw} y1={50 - 50 * 30 / 40} y2={50 - 50 * 30 / 40} className="target-line" />
          {T.plateau.map(([t, v], i) => <circle key={i} cx={x(t)} cy={50 - 50 * Math.min(40, v) / 40} r="4" fill={v > 30 ? "var(--status-critical)" : "var(--series-1)"} stroke="var(--surface-1)" strokeWidth="1.5"><title>Plateau {v} at {t} h</title></circle>)}
        </Lane>
        <Lane title="RASS" unit="band = −2 to +1" w={w} height={70} y={yR} yTicks={[-5, -2, 0, 1, 4]}>
          {xAxis(60)}
          <rect x={0} y={yR(1)} width={iw} height={yR(-2) - yR(1)} className="target-band" />
          {T.rass.map(([t, v], i) => <circle key={i} cx={x(t)} cy={yR(v)} r="4" fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth="1.5"><title>RASS {v} at {t} h</title></circle>)}
        </Lane>
        <Lane title="Infusions, proning, trials" w={w} height={86}>
          {xAxis(80)}
          {[["sedative", "Sedative", 4], ["paralytic", "Paralytic", 24], ["prone", "Prone", 44]].map(([k, lab, yy]) => (
            <g key={k}>
              <text x={-6} y={yy + 8} dy="0.32em" textAnchor="end" className="tick">{lab}</text>
              {(T.bands[k] || []).map(([a, b], i) => <rect key={i} x={x(a)} y={yy} width={Math.max(2, x(b) - x(a))} height={14} rx="3" className={`band-${k}`}><title>{lab} {a}–{b} h</title></rect>)}
            </g>
          ))}
          <text x={-6} y={72} dy="0.32em" textAnchor="end" className="tick">Trials</text>
          {(() => { let last = -1e9; return T.events.map(([t, k, v], i) => {
            const show = x(t) - last > 64; if (show) last = x(t);
            return (
              <g key={i}><line x1={x(t)} x2={x(t)} y1={64} y2={80} stroke={k === "SAT" ? "var(--series-1)" : "var(--series-4)"} strokeWidth="2"><title>{k} {v} at {t} h</title></line>
                {show && <text x={x(t) + 3} y={72} dy="0.32em" className="tick">{k} {v}</text>}</g>
            ); }); })()}
        </Lane>
        <Lane title="Vasopressors (norepinephrine equivalent)" unit="mcg/kg/min" w={w} height={50} y={yN} yTicks={yN.ticks(2)}>
          {xAxis(40)}
          {T.nee.length > 0 && <path d={d3line().curve(curveStepAfter).x((p) => x(p[0])).y((p) => yN(p[1]))(T.nee)} fill="none" stroke="var(--series-1)" strokeWidth="2" />}
        </Lane>
      </section>
      <div className="pager">
        {idx > 0 && <button className="btn" onClick={() => go("timeline", DATA.episodes[idx - 1].episode_id)}>← Previous episode</button>}
        {idx < DATA.episodes.length - 1 && <button className="btn" onClick={() => go("timeline", DATA.episodes[idx + 1].episode_id)}>Next episode →</button>}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Data quality
// ----------------------------------------------------------------------------
function Quality({ ep }) {
  const dq = DATA.data_quality;
  const units = uniq(ep, "unit");
  const notes = [];
  if (dq.sat_documented_rows === 0) notes.push("No documented SAT assessments (sat_delivery_pass_fail): the SAT measure relies on the EHR phenotype only.");
  if (dq.prone_position_rows < 5) notes.push(`Only ${dq.prone_position_rows} prone position row(s) in the position table: proning measures will be near zero or empty.`);
  if (dq.semi_prone_names.length) notes.push(`Position names mapped to prone that contain "semi": ${dq.semi_prone_names.join(", ")}. Review the mCIDE mapping.`);
  if (dq.icu_rows_without_location_type) notes.push(`${dq.icu_rows_without_location_type} ICU ADT rows have no location_type: they appear as "ICU (type not mapped)".`);
  const hgt = ep.filter((e) => e.has_height).length;
  if (ep.length && hgt / ep.length < 0.9) notes.push(`Height is missing for ${ep.length - hgt} of ${ep.length} episodes, so their ventilator hours drop out of the LTVV denominator.`);
  return (
    <div>
      <div className="page-head">
        <h1>Data quality</h1>
        <p className="lede">What the data can and cannot support, so gaps are not mistaken for practice.</p>
      </div>
      {notes.length > 0 && (
        <section className="card callout">
          <h2>Things to know</h2>
          <ul>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </section>
      )}
      <section className="card scroll-x">
        <h2>Input completeness by ICU</h2>
        <table className="dtable num">
          <thead><tr><th>Input</th><th>All</th>{units.map((u) => <th key={u}>{u}</th>)}</tr></thead>
          <tbody>{COMPLETENESS.map(([k, lab]) => (
            <tr key={k}><td>{lab}</td>
              {[null, ...units].map((u) => {
                const rs = u ? ep.filter((e) => e.unit === u) : ep;
                const p = rs.length ? Math.round((100 * rs.filter((e) => e[k]).length) / rs.length) : null;
                return <td key={u || "all"} className={p != null && p < 80 ? "warn-cell" : ""}>{p == null ? "—" : `${p}%`}</td>;
              })}
            </tr>))}
          </tbody>
        </table>
      </section>
      <div className="two-col">
        <section className="card">
          <h2>Tables loaded</h2>
          <table className="dtable num"><tbody>{Object.entries(dq.row_counts).map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td>{v.toLocaleString()} rows</td><td className="muted">{(dq.outliers[k] ?? Object.entries(dq.outliers).filter(([kk]) => kk.startsWith(k + ".")).reduce((s, [, n]) => s + n, 0)) || 0} outliers set to missing</td></tr>)}</tbody></table>
        </section>
        <section className="card">
          <h2>Models</h2>
          {dq.mortality_model ? (
            <>
              <h3>Expected mortality (site-fitted)</h3>
              <table className="dtable num"><tbody>{dq.mortality_model.terms.map((t, i) => <tr key={t}><td>{t}</td><td>{dq.mortality_model.coef[i]}</td></tr>)}</tbody></table>
              <p className="muted small">Fitted on {dq.mortality_model.n} encounters with {dq.mortality_model.events} deaths (ridge-penalised logistic regression). Small samples give unstable O/E.</p>
            </>
          ) : <p className="muted small">Not enough encounters or deaths to fit the mortality model.</p>}
          {dq.proning_model && dq.proning_model.coefficients && (
            <>
              <h3>Expected proning (CLIF global coefficients)</h3>
              <table className="dtable num"><tbody>{Object.entries(dq.proning_model.coefficients).map(([k, v]) => <tr key={k}><td>{k.replace("coef_", "")}</td><td>{v}</td></tr>)}</tbody></table>
            </>
          )}
          <p className="small">Built with {DATA.meta.clifpy}. Proning logic: {DATA.meta.proning_source}.</p>
        </section>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Shell
// ----------------------------------------------------------------------------
function App() {
  const route = useRoute();
  const [F, setF] = useState({});
  const [theme, setTheme] = useState(null);
  const ep = useMemo(() => applyFilters(DATA.episodes, F), [F]);
  const pr = useMemo(() => applyFilters(DATA.proning, F), [F]);
  useEffect(() => { if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; }, [theme]);
  const tabs = [["overview", "Overview"], ["metric", "Measures"], ["units", "ICU comparison"], ["patients", "Episodes"], ["timeline", "Timeline"], ["quality", "Data quality"]];
  return (
    <div className="shell viz-root">
      <header className="top">
        <div className="brand">
          <div className="logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 3v7M12 10c-2 0-6 1-7 6s1 5 3 5 4-3 4-6M12 10c2 0 6 1 7 6s-1 5-3 5-4-3-4-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <div>
            <div className="title">ICU Respiratory Failure Quality</div>
            <div className="sub">{DATA.meta.site_name} · built {DATA.meta.generated_at} · CLIF 2.1</div>
          </div>
        </div>
        <nav className="tabs" aria-label="Pages">
          {tabs.map(([k, lab]) => (
            <a key={k} href={`#/${k}`} className={route.page === k ? "on" : ""}>{lab}</a>
          ))}
        </nav>
        <button className="btn theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle dark mode">
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </header>
      {DATA.meta.demo_reanchored && (
        <div className="banner">Demo data (MIMIC-IV in CLIF format). Dates have been shifted into recent years so monthly trends are readable; patient counts are small. Set <code>clif_dir</code> in config.yaml to your site's CLIF folder and <code>reanchor_dates: false</code> for real use.</div>
      )}
      <div className="body">
        <FilterRail F={F} setF={setF} nEp={ep.length} nTot={DATA.episodes.length} />
        <main>
          {route.page === "overview" && <Overview ep={ep} pr={pr} />}
          {route.page === "metric" && <MetricPage id={route.arg || "ltvv"} ep={ep} pr={pr} key={(route.arg || "ltvv").split("@")[0]} />}
          {route.page === "units" && <Units ep={ep} pr={pr} />}
          {route.page === "patients" && <Patients ep={ep} pr={pr} arg={route.arg} />}
          {route.page === "timeline" && <Timeline ep={ep} arg={route.arg} />}
          {route.page === "quality" && <Quality ep={ep} />}
        </main>
      </div>
      <footer className="foot">Contains patient-level data — keep this file inside your institution. Measures computed from CLIF tables with clifpy; definitions in decisions.yaml.</footer>
    </div>
  );
}

const root = document.getElementById("root");
if (!DATA) {
  root.innerHTML = "<p style='padding:2rem;font-family:system-ui'>No data embedded. Run <code>python build_dashboard.py</code> to produce the dashboard.</p>";
} else {
  createRoot(root).render(<App />);
}
