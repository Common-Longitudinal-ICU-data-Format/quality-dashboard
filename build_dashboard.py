#!/usr/bin/env python3
"""Build the ICU Respiratory Failure Quality Dashboard.

    python build_dashboard.py                 # uses config.yaml next to this file
    python build_dashboard.py --config my.yaml
    python build_dashboard.py --clif-dir /path/to/site/clif   # override the data folder

Reads CLIF 2.1 tables, computes every metric with the choices in decisions.yaml,
and writes one self-contained HTML file (no server, no internet needed to view).
Patient-level rows are embedded in that file: keep it inside your institution.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from pipeline import clif_io, metrics, prep, proning  # noqa: E402

PIPELINE_VERSION = "0.1.0"
TEMPLATE = ROOT / "web" / "dist" / "app_template.html"


def log(msg):
    print(msg, flush=True)


def _iso(t, tz):
    if t is None or pd.isna(t):
        return None
    return pd.Timestamp(t).tz_convert(tz).strftime("%Y-%m-%d %H:%M")


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return None if (o is None or math.isnan(o) or math.isinf(o)) else round(float(o), 4)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (pd.Timestamp, dt.date)):
        return str(o)
    if o is pd.NaT:
        return None
    return o


def timelines(ctx, ep, pr, tz, max_n):
    """Hourly swim-lane data for the patient timeline view."""
    w_by = {k: g for k, g in ctx["w"].groupby("encounter_block")}
    pos = ctx["T"].get("position", pd.DataFrame())
    pos = pos.merge(ctx["mapping"], on="hospitalization_id") if not pos.empty else pos
    pos_by = {k: g for k, g in pos.groupby("encounter_block")} if not pos.empty else {}
    labs = ctx["T"].get("labs", pd.DataFrame())
    abg = labs[labs["lab_category"].eq("po2_arterial")].merge(ctx["mapping"], on="hospitalization_id") if not labs.empty else labs
    abg_by = {k: g for k, g in abg.groupby("encounter_block")} if not abg.empty else {}
    out = {}
    eps = ep.sort_values("start", ascending=False).head(max_n)
    for e in eps.itertuples():
        blk = e.encounter_block
        s0 = e.start - pd.Timedelta(hours=6)
        s1 = e.end + pd.Timedelta(hours=6)
        hrs = lambda t: round((t - e.start) / pd.Timedelta(hours=1), 2)
        g = w_by[blk]
        g = g[(g["recorded_dttm"] >= s0) & (g["recorded_dttm"] <= s1)]
        sc = g[g["is_scaffold"]]
        pbw = e.pbw if e.pbw and not pd.isna(e.pbw) else None
        series = {
            "t": [hrs(t) for t in sc["recorded_dttm"]],
            "device": sc["device_category"].fillna("").tolist(),
            "mode": sc["mode_category"].fillna("").tolist(),
            "vt_pbw": [round(v / pbw, 2) if (pbw and not pd.isna(v)) else None for v in sc["tidal_volume_set"]],
            "peep": [None if pd.isna(v) else float(v) for v in sc["peep_set"]],
            "fio2": [None if pd.isna(v) else round(float(v), 2) for v in sc["fio2_set"]],
        }
        real = g[~g["is_scaffold"] & g["plateau_pressure_obs"].notna()]
        series["plateau"] = [[hrs(t), float(v)] for t, v in zip(real["recorded_dttm"], real["plateau_pressure_obs"])]
        a = abg_by.get(blk)
        pf = []
        if a is not None:
            a = a.assign(t=a["lab_result_dttm"].fillna(a["lab_collect_dttm"]))
            a = a[(a["t"] >= s0) & (a["t"] <= s1)].sort_values("t")
            if len(a):
                ws = ctx["w"][ctx["w"]["encounter_block"] == blk][["recorded_dttm", "fio2_set"]].sort_values("recorded_dttm")
                a = pd.merge_asof(a, ws, left_on="t", right_on="recorded_dttm", direction="backward")
                for t, p, f in zip(a["t"], a["lab_value_numeric"], a["fio2_set"]):
                    if not pd.isna(p) and not pd.isna(f) and f > 0:
                        pf.append([hrs(t), round(float(p) / float(f))])
        series["pf"] = pf
        pa = ctx["pa_by"].get(blk)
        if pa is not None:
            r = pa[pa["cat_l"].eq("rass") & (pa["recorded_dttm"] >= s0) & (pa["recorded_dttm"] <= s1)]
            series["rass"] = [[hrs(t), float(v)] for t, v in zip(r["recorded_dttm"], r["numerical_value"]) if not pd.isna(v)]
            ev = pa[pa["cat_l"].isin(["sat_delivery_pass_fail", "sbt_delivery_pass_fail"]) &
                    (pa["recorded_dttm"] >= s0) & (pa["recorded_dttm"] <= s1)]
            series["events"] = [[hrs(t), c.split("_")[0].upper(), str(v)] for t, c, v in
                                zip(ev["recorded_dttm"], ev["cat_l"], ev["categorical_value"])]
        else:
            series["rass"], series["events"] = [], []
        iv = ctx["iv"].get(blk)
        bands = {}
        for kind in ("sedative", "paralytic"):
            bands[kind] = [[hrs(max(a_, s0)), hrs(min(b_, s1))] for a_, b_ in prep.on_intervals(iv, kind) if b_ > s0 and a_ < s1]
        if blk in pos_by:
            ss = proning.prone_sessions(pos_by[blk], s0, s1)
            bands["prone"] = [[hrs(r.start), round(hrs(r.start) + r.hours, 2)] for r in ss.itertuples()]
        else:
            bands["prone"] = []
        series["bands"] = bands
        nee = []
        if iv is not None:
            for t in sorted(set(iv[(iv["kind"] == "vaso") & (iv["admin_dttm"] >= s0) & (iv["admin_dttm"] <= s1)]["admin_dttm"])):
                nee.append([hrs(t), round(prep.nee_at(iv, t), 3)])
        series["nee"] = nee
        series["end_h"] = hrs(e.end)
        out[e.episode_id] = series
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(ROOT / "config.yaml"))
    ap.add_argument("--clif-dir", help="override clif_dir from the config file")
    ap.add_argument("--json-only", action="store_true", help="write dashboard_data.json, skip the HTML")
    args = ap.parse_args()

    cfg_path = Path(args.config).resolve()
    cfg = yaml.safe_load(cfg_path.read_text())
    base = cfg_path.parent
    clif_dir = Path(args.clif_dir) if args.clif_dir else (base / cfg["clif_dir"])
    clif_dir = clif_dir.resolve()
    D = yaml.safe_load((base / cfg.get("decisions_file", "decisions.yaml")).read_text())
    tz = cfg.get("site_timezone", "UTC")
    sv = {d["id"]: d["value"] for d in D["shared"]}

    log(f"Loading CLIF tables from {clif_dir}")
    T = clif_io.load_tables(clif_dir, cfg.get("filetype", "parquet"), cfg.get("file_prefix", "clif_"), log)
    row_counts = {k: int(len(v)) for k, v in T.items()}
    demo = (cfg.get("demo_mode") or {})
    if demo.get("reanchor_dates"):
        prep.reanchor_dates(T, str(demo["window_start"]), str(demo["window_end"]), log)

    log("Cleaning")
    outliers = clif_io.apply_outliers(T, log)
    wf_fn, stitch_fn, clifpy_src = clif_io.clifpy_functions()
    log(f"  - using {clifpy_src}")

    log("Building encounters and ventilation episodes")
    enc, mapping, adt = prep.build_encounters(T, stitch_fn, sv["stitch_hours"], sv["age_min"], log)
    adults = enc[enc["adult"]]
    mapping_a = mapping[mapping["encounter_block"].isin(adults["encounter_block"])]
    w = prep.waterfall(T, mapping_a, wf_fn)
    runs = prep.imv_runs(w)
    ep, runs = prep.episodes_from_runs(runs, sv["episode_gap_hours"])
    funnel = [
        {"step": "Hospitalizations in CLIF", "n": int(T["hospitalization"]["hospitalization_id"].nunique())},
        {"step": f"Encounters after linking (< {sv['stitch_hours']} h apart)", "n": int(len(enc))},
        {"step": f"Adults (age ≥ {sv['age_min']})", "n": int(len(adults))},
        {"step": "Encounters with invasive ventilation", "n": int(ep["encounter_block"].nunique())},
        {"step": "IMV episodes in those encounters", "n": int(len(ep)), "unit": "episodes"},
    ]
    ep = prep.attribute_unit(ep, adt)
    if sv["require_icu"]:
        n0 = len(ep)
        ep = ep[ep["icu_overlap"]]
        funnel.append({"step": "Excluded: episode never in an ICU", "n": -(n0 - len(ep)), "unit": "episodes"})
    # outside-hospital intubation (first episode only)
    adt_first = adt.sort_values("in_dttm").groupby("encounter_block")["location_category"].first().str.lower()
    w_real = w[~w["is_scaffold"] & w["device_category"].notna()]
    dev_first = w_real.groupby("encounter_block")["device_category"].first()
    outside = (adt_first.reindex(ep["encounter_block"]).ne("ed").to_numpy()
               & dev_first.reindex(ep["encounter_block"]).eq("imv").to_numpy()
               & (ep["episode_seq"] == 1).to_numpy())
    ep["outside_intubation"] = outside
    if sv["exclude_outside_intubation"]:
        n0 = len(ep)
        ep = ep[~ep["outside_intubation"]]
        funnel.append({"step": "Excluded: intubated at outside hospital (first ADT not ED, first device IMV)",
                       "n": -(n0 - len(ep)), "unit": "episodes"})
    if cfg.get("start_date") or cfg.get("end_date"):
        n0 = len(ep)
        loc = ep["start"].dt.tz_convert(tz)
        if cfg.get("start_date"):
            ep = ep[loc.dt.date >= pd.Timestamp(str(cfg["start_date"])).date()]
            loc = ep["start"].dt.tz_convert(tz)
        if cfg.get("end_date"):
            ep = ep[loc.dt.date <= pd.Timestamp(str(cfg["end_date"])).date()]
        funnel.append({"step": "Outside the analysis window", "n": -(n0 - len(ep)), "unit": "episodes"})
    funnel.append({"step": "IMV episodes analysed", "n": int(len(ep)), "unit": "episodes"})
    log(f"  - {len(ep)} IMV episodes analysed")

    ctx = dict(T=T, enc=enc, mapping=mapping, adt=adt, w=w, runs=runs, ep=ep,
               cci=clif_io.charlson(T.get("hospital_diagnosis")))
    log("Computing metrics")
    epm = metrics.compute(T, ctx, D, tz, log)
    ctx["ep"] = epm
    log("Proning module")
    pr, pfunnel, pinfo = proning.compute(T, ctx, D, log)

    # ---- strata ---------------------------------------------------------------
    encs = enc.set_index("encounter_block")
    epm["sex"] = epm["encounter_block"].map(encs["sex_category"]).fillna("Unknown")
    epm["race_eth"] = [prep.race_eth(encs.at[b, "race_category"], encs.at[b, "ethnicity_category"]) for b in epm["encounter_block"]]
    epm["age_band"] = epm["age"].map(prep.age_band)
    epm["month"] = epm["start"].dt.tz_convert(tz).dt.strftime("%Y-%m")
    epm["label_id"] = epm["encounter_block"].map(encs["hospitalization_id"])
    epm["discharge"] = epm["encounter_block"].map(encs["discharge_category"]).fillna("Missing")

    keep = ["episode_id", "label_id", "month", "hospital", "unit", "sex", "race_eth", "age_band", "code_status",
            "trach", "n_runs", "age", "sofa", "cci", "pbw", "height_cm", "vt_hours_total",
            "ltvv_num", "ltvv_den", "vt24", "vt_pbw_median", "plat_num", "plat_den", "hdoc_num", "hdoc_den",
            "vent_days", "sat_num", "sat_doc", "sat_pheno", "sat_den", "sbt_num", "sbt_doc", "sbt_pheno", "sbt_den",
            "vfd28", "imv_days", "ext_den", "reint_num", "rass_num", "rass_den", "rass_median", "deep_num", "deep_den",
            "died", "mort_expected", "icu_los", "hosp_los", "trach_any", "readmit_num", "readmit_den", "outcome_den",
            "discharge"]
    keep += [metrics.ltvv_key(t) for t in ctx.get("ltvv_thresholds", [])]
    E = epm[keep].copy()
    E["start"] = [_iso(t, tz) for t in epm["start"]]
    E["end"] = [_iso(t, tz) for t in epm["end"]]
    E["trach"] = E["trach"].astype(bool)
    # completeness flags
    labs = T.get("labs", pd.DataFrame())
    abg_blocks = set(labs[labs["lab_category"].eq("po2_arterial")].merge(mapping, on="hospitalization_id")["encounter_block"]) if not labs.empty else set()
    E["has_abg"] = epm["encounter_block"].isin(abg_blocks).to_numpy()
    E["has_height"] = epm["height_cm"].notna().to_numpy()
    E["has_weight"] = epm["encounter_block"].isin(ctx["weights"].index).to_numpy()
    E["has_plateau"] = (epm["plat_den"] > 0).to_numpy()
    E["has_rass"] = (epm["rass_den"] + epm["deep_den"] > 0).to_numpy()
    E["has_vt"] = (epm["vt_hours_total"] > 0).to_numpy()

    P = []
    if len(pr):
        pr = pr.merge(epm[["episode_id", "label_id", "hospital", "unit", "sex", "race_eth", "age_band", "code_status"]],
                      on="episode_id", how="left")
        pr["month"] = pr["t_enroll"].dt.tz_convert(tz).dt.strftime("%Y-%m")
        pr["t_enroll"] = [_iso(t, tz) for t in pr["t_enroll"]]
        pr["t_first_abg"] = [_iso(t, tz) for t in pr["t_first_abg"]]
        P = pr.drop(columns=["encounter_block"]).to_dict("records")

    # ---- data quality ---------------------------------------------------------
    pos = T.get("position", pd.DataFrame())
    semi = []
    if not pos.empty:
        pn = pos[pos["position_category"].eq("prone")]["position_name"].astype(str)
        semi = sorted(set(pn[pn.str.contains("semi", case=False)]))
    adt_icu = T["adt"][T["adt"]["location_category"].str.lower().eq("icu")]
    dq = {
        "row_counts": row_counts,
        "outliers": outliers,
        "semi_prone_names": semi,
        "icu_rows_without_location_type": int(adt_icu["location_type"].isna().sum()),
        "prone_position_rows": int((pos["position_category"] == "prone").sum()) if not pos.empty else 0,
        "sat_documented_rows": int((T["patient_assessments"]["assessment_category"] == "sat_delivery_pass_fail").sum())
        if not T["patient_assessments"].empty else 0,
        "sbt_documented_rows": int((T["patient_assessments"]["assessment_category"] == "sbt_delivery_pass_fail").sum())
        if not T["patient_assessments"].empty else 0,
        "mortality_model": ctx.get("mort_model"),
        "proning_model": pinfo,
    }

    data = {
        "meta": {
            "site_name": cfg.get("site_name", "CLIF site"),
            "generated_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
            "data_folder": clif_dir.name,
            "timezone": tz,
            "clifpy": clifpy_src,
            "pipeline_version": PIPELINE_VERSION,
            "demo_reanchored": bool(demo.get("reanchor_dates")),
            "months": sorted(E["month"].dropna().unique().tolist()),
            "ltvv_thresholds": ctx.get("ltvv_thresholds", []),
            "proning_source": "CLIF_Proning_Incidence_Severe_ARF (commit 853338a), ported to Python",
        },
        "decisions": D,
        "funnel": funnel,
        "proning_funnel": pfunnel,
        "episodes": E.to_dict("records"),
        "proning": P,
        "data_quality": dq,
        "timelines": timelines(ctx, epm, pr, tz, int(cfg.get("timeline_max_episodes", 3000))),
    }
    data = _clean(data)
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)

    out_html = (base / cfg.get("output_html", "dist/resp_quality_dashboard.html")).resolve()
    out_html.parent.mkdir(parents=True, exist_ok=True)
    (out_html.parent / "dashboard_data.json").write_text(payload)
    if args.json_only:
        log(f"Wrote {out_html.parent / 'dashboard_data.json'}")
        return
    if not TEMPLATE.exists():
        sys.exit(f"Dashboard template not found at {TEMPLATE}. Build it with: cd web && node build.mjs")
    html = TEMPLATE.read_text()
    safe = payload.replace("</", "<\\/")
    html = html.replace("/*__DASHBOARD_DATA__*/null", safe, 1)
    out_html.write_text(html)
    log(f"Wrote {out_html} ({out_html.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
