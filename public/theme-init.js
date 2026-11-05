// Aplica el modo (claro/oscuro) y el color guardados ANTES de pintar, para
// que no parpadee. Archivo aparte (no inline) por la política de seguridad CSP.
// El color de fábrica se define en src/config/brand.ts.
(function () {
  try {
    var m = localStorage.getItem("minuta-modo") || "system";
    var c = localStorage.getItem("minuta-color");
    var dark = m === "dark" || (m === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
    if (c) document.documentElement.dataset.color = c;
  } catch (e) {}
})();
