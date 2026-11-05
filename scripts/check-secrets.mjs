// Revisa que no haya llaves ni secretos en el código antes de subirlo.
// Uso: npm run check:secrets   (también corre en GitHub Actions)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".temp"]);
const SKIP_FILES = /(package-lock\.json|\.png|\.jpg|\.ico|\.woff2?)$/;
const PATTERNS = [
  ["Llave de OpenAI", /sk-(proj-)?[A-Za-z0-9_-]{24,}/],
  ["Llave de Anthropic", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["Llave de Google", /AIza[0-9A-Za-z_-]{30,}/],
  ["Secreto de OAuth de Google", /GOCSPX-[A-Za-z0-9_-]{10,}/],
  ["Secreto de webhook", /whsec_[A-Za-z0-9+/=]{20,}/],
  ["Token de GitHub", /gh[pousr]_[A-Za-z0-9]{30,}/],
  ["Llave privada", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["JWT de Supabase", /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ["Llave secreta de Supabase", /sb_secret_[A-Za-z0-9_-]{10,}/],
  ["Token de Recall/Deepgram", /(RECALL|DEEPGRAM)_API_KEY\s*=\s*['"]?[0-9a-f]{32,}/i],
];

const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(path);
    } else if (!SKIP_FILES.test(name) && st.size < 2_000_000) {
      if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
        hits.push(`${path}: archivo .env (no debe estar en el repo)`);
        continue;
      }
      const text = readFileSync(path, "utf8");
      for (const [label, re] of PATTERNS) if (re.test(text)) hits.push(`${path}: ${label}`);
    }
  }
}
walk(process.argv[2] ?? ".");
if (hits.length) {
  console.error("Posibles secretos encontrados:\n" + hits.map((h) => "  - " + h).join("\n"));
  process.exit(1);
}
console.log("Sin secretos a la vista.");
