# ICU Respiratory Failure Quality Dashboard (CLIF 2.1)

A local, single-file React dashboard of quality measures for adults on invasive
mechanical ventilation, computed from CLIF 2.1 tables with clifpy. Nothing
is sent anywhere: the pipeline runs on your machine, and the output is one
HTML file you open by double-click.

## See it first

`demo/resp_quality_dashboard_demo.html` is a prebuilt dashboard from the public
MIMIC-IV CLIF demo data (dates shifted into 2023–2026). Download it and open it in
any browser; no install needed.

## Run it

```bash
pip install clifpy pyyaml          # clifpy brings pandas, pyarrow, duckdb
python build_dashboard.py          # reads config.yaml
open dist/resp_quality_dashboard.html
```

## Point it at your site's CLIF data

Edit **`config.yaml`**:

```yaml
clif_dir: /path/to/your/clif/tables    # folder with clif_adt.parquet, clif_vitals.parquet, ...
filetype: parquet                       # or csv
site_name: My Hospital ICUs
site_timezone: America/Chicago
demo_mode:
  reanchor_dates: false                 # must be false for real data
```

Or override the folder once without editing the file:

```bash
python build_dashboard.py --clif-dir /path/to/your/clif/tables
```

Tables used: `patient`, `hospitalization`, `adt`, `respiratory_support` (required);
`vitals`, `labs`, `position`, `patient_assessments`, `medication_admin_continuous`,
`code_status`, `hospital_diagnosis` (optional; measures that need a missing table
show as unavailable).

## Change a definition

Every analytic choice lives in **`decisions.yaml`**: thresholds, windows, modes,
eligibility rules, targets. Each metric page shows these decisions in its
"How this is calculated" panel, read from the same file, so the page always
matches what was computed. Change a `value`, re-run `python build_dashboard.py`,
and log the change under `changelog`.

## What's inside

| Path | Purpose |
| --- | --- |
| `config.yaml` | Data location, site name, time zone, output path |
| `decisions.yaml` | All metric definitions and choices (shown in the dashboard) |
| `build_dashboard.py` | One command: load → clean → compute → write HTML |
| `pipeline/clif_io.py` | Table loading; clifpy waterfall, encounter stitching, outlier thresholds, Charlson |
| `pipeline/prep.py` | Encounters, IMV runs/episodes, ICU attribution, infusion timelines |
| `pipeline/metrics.py` | Measures 1–4 and 8–15 per episode; SOFA; site-fitted mortality model |
| `pipeline/proning.py` | Measures 5–7: Python port of CLIF_Proning_Incidence_Severe_ARF |
| `pipeline/vendor/clifpy/` | clifpy source files (Apache-2.0), used only if clifpy isn't installed |
| `pipeline/reference/proning_global_coefficients.csv` | CLIF proning study global model |
| `web/` | React UI source; `web/dist/app_template.html` is the prebuilt UI |
| `demo/` | Prebuilt dashboard from the public MIMIC-IV demo data |

## Changing the UI (optional)

Refreshing data needs Python only. To change the interface:

```bash
cd web && npm install && node build.mjs     # rebuilds web/dist/app_template.html
cd .. && python build_dashboard.py
```

## Notes

- The HTML embeds episode-level rows (hospitalization IDs, dates, measures). Keep it
  inside your institution.
- clifpy functions used: respiratory-support waterfall, encounter stitching, outlier
  thresholds, Charlson index. If `pip install clifpy` is unavailable, the vendored
  copies (same code, commit 39cabd6) are used and the dashboard says so.
- If pyarrow is missing, a small built-in parquet reader is used as a fallback.

## License

Copyright (C) 2026 CLIF Consortium contributors.

This project is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version (GPL-3.0-or-later). See [LICENSE](LICENSE).

Third-party material keeps its own terms:

- `pipeline/vendor/clifpy/` — files from [clifpy](https://github.com/Common-Longitudinal-ICU-data-Format/clifpy),
  Apache License 2.0 (see `pipeline/vendor/clifpy/LICENSE`).
- `pipeline/reference/proning_global_coefficients.csv` — global model coefficients from the
  CLIF proning incidence study ([CLIF_Proning_Incidence_Severe_ARF](https://github.com/Common-Longitudinal-ICU-data-Format/CLIF_Proning_Incidence_Severe_ARF)).
- `data/demo-data-2.1.0/` — the public MIMIC-IV demo data in CLIF format, distributed under
  its original terms.

