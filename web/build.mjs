// Builds web/dist/app_template.html: the React app bundled into one HTML file
// with a placeholder that build_dashboard.py fills with the data.
//
//   cd web && npm install && node build.mjs
//
// You only need this when you change the UI; refreshing data needs Python only.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extra = (process.env.NODE_PATH || "").split(":").filter(Boolean);
const nodePaths = [join(here, "node_modules"), ...extra];
const require = createRequire(join(here, "package.json"));
let esbuild;
for (const p of nodePaths) {
  try { esbuild = require(join(p, "esbuild")); break; } catch {}
}
if (!esbuild) esbuild = require("esbuild");

const result = await esbuild.build({
  entryPoints: [join(here, "src", "app.jsx")],
  bundle: true,
  minify: true,
  write: false,
  outdir: "out",
  format: "iife",
  target: ["es2020"],
  jsx: "automatic",
  loader: { ".js": "jsx" },
  nodePaths,
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
});
const js = result.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text || "";

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ICU Respiratory Failure Quality</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>window.__DASHBOARD_DATA__ = /*__DASHBOARD_DATA__*/null;</script>
<script>${js.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>
`;
mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "dist", "app_template.html"), html);
console.log(`Wrote web/dist/app_template.html (${(html.length / 1024).toFixed(0)} KB)`);
