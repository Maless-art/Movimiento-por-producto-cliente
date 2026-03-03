// ======================
// Config
// ======================
const DB_NAME = "historialDB";
const DB_VER  = 1;
const STORE   = "rows";
const META    = "meta";
const JSON_URL = "./historial.min.json"; // debe estar al lado

// Paginación
let state = {
  page: 1,
  pageSize: 50,
  lastQuery: null,
  lastTotal: 0
};

const $ = (id) => document.getElementById(id);
const ui = {
  status: $("status"),
  tb: $("tb"),
  info: $("info"),
  page: $("page"),
  fCodigo: $("fCodigo"),
  fRango: $("fRango"),
  fDesde: $("fDesde"),
  fHasta: $("fHasta"),
  fCampo: $("fCampo"),
  fTexto: $("fTexto"),
  btnBuscar: $("btnBuscar"),
  btnLimpiar: $("btnLimpiar"),
  btnMostrarTodo: $("btnMostrarTodo"),
  btnReimportar: $("btnReimportar"),
  prev: $("prev"),
  next: $("next"),
  pageSize: $("pageSize")
};

// ======================
// IndexedDB helpers
// ======================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;

      // store principal
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        // índices
        s.createIndex("codigo", "codigo", { unique: false });
        s.createIndex("descripcion", "descripcion", { unique: false });
        s.createIndex("cod_cliente", "cod_cliente", { unique: false });
        s.createIndex("vendedor", "vendedor", { unique: false });
        s.createIndex("cliente", "cliente", { unique: false });
        s.createIndex("fecha", "fecha", { unique: false });     // YYYY-MM-DD
        s.createIndex("factura", "factura", { unique: false });
      }

      // store meta
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "k" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txp(db, storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores = {};
    for (const n of storeNames) stores[n] = tx.objectStore(n);
    let out;
    try { out = fn(stores, tx); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error || out);
    tx.onabort = () => reject(tx.error || out);
  });
}

function reqp(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ======================
// Util
// ======================
function setStatus(msg) { ui.status.textContent = "Estado: " + msg; }

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
}

function fmtMoney(n){
  const x = Number(n)||0;
  return x.toLocaleString("es-PA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayISO(){
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

function minusDaysISO(days){
  const d = new Date();
  d.setDate(d.getDate()-days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

// ======================
// Importación JSON compacto
// Formato esperado:
// { v:1, cols:[...], data:[ [codigo,descripcion,cod_cliente,vendedor,cliente,fecha,factura,cantidad,precio], ... ] }
// ======================
async function fetchJSON() {
  const res = await fetch(JSON_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("No se pudo cargar historial.min.json");
  return await res.json();
}

async function clearDB(db) {
  await txp(db, [STORE], "readwrite", ({rows}) => rows.clear());
}

async function setMeta(db, k, v) {
  await txp(db, [META], "readwrite", ({meta}) => meta.put({k, v}));
}

async function getMeta(db, k) {
  return await txp(db, [META], "readonly", ({meta}) => reqp(meta.get(k)));
}

async function importIfNeeded(db, force=false) {
  setStatus("verificando datos…");
  const meta = await getMeta(db, "imported");
  if (meta?.v === true && !force) {
    setStatus("datos ya importados");
    return;
  }

  setStatus("cargando JSON…");
  const payload = await fetchJSON();

  if (!payload?.data?.length) throw new Error("JSON vacío o inválido.");

  setStatus(`importando ${payload.data.length.toLocaleString()} filas…`);

  await clearDB(db);

  // Insert en chunks para no reventar memoria/timeout
  const CHUNK = 2000;
  let inserted = 0;

  for (let i = 0; i < payload.data.length; i += CHUNK) {
    const slice = payload.data.slice(i, i + CHUNK);

    await txp(db, [STORE], "readwrite", ({rows}) => {
      for (const r of slice) {
        rows.add({
          codigo: r[0] ?? "",
          descripcion: r[1] ?? "",
          cod_cliente: r[2] ?? "",
          vendedor: r[3] ?? "",
          cliente: r[4] ?? "",
          fecha: r[5] ?? "",      // YYYY-MM-DD
          factura: r[6] ?? "",
          cantidad: Number(r[7]) || 0,
          precio: Number(r[8]) || 0
        });
      }
    });

    inserted += slice.length;
    setStatus(`importando… ${inserted.toLocaleString()} / ${payload.data.length.toLocaleString()}`);
  }

  await setMeta(db, "imported", true);
  await setMeta(db, "importedAt", todayISO());

  setStatus("importación completa ✅");
}

// ======================
// Query (búsqueda rápida)
// ======================
function buildQueryFromUI(){
  const codigo = ui.fCodigo.value.trim();
  const campo = ui.fCampo.value;
  const texto = ui.fTexto.value.trim();
  const rango = ui.fRango.value;

  let desde = "";
  let hasta = "";

  if (rango === "custom") {
    desde = ui.fDesde.value || "";
    hasta = ui.fHasta.value || "";
  } else if (rango === "all") {
    // nada
  } else {
    const days = Number(rango);
    desde = minusDaysISO(days);
    hasta = todayISO();
  }

  return { codigo, campo, texto, desde, hasta };
}

async function countAll(db){
  return await txp(db, [STORE], "readonly", ({rows}) => reqp(rows.count()));
}

/**
 * Estrategia:
 * - Si hay filtro por "codigo", lo usamos como índice principal.
 * - Si no, si hay texto y campo, usamos ese índice.
 * - Luego filtramos por fecha (si aplica) y por "codigo" adicional (si el índice no fue codigo).
 * - Devolvemos paginado.
 */
async function runQuery(db, q, page, pageSize){
  const store = STORE;

  return await txp(db, [store], "readonly", ({rows}) => {
    const idxName = q.codigo ? "codigo" : (q.texto ? q.campo : "fecha"); // fallback
    const idx = rows.index(idxName);

    // KeyRange exacto para indices exactos (codigo, factura, cod_cliente)
    // Para campos textuales (cliente, vendedor, descripcion) haremos "contains" en filtro en memoria (pero paginado).
    let req;
    const exactFields = new Set(["codigo","factura","cod_cliente"]);
    if (q.codigo) {
      req = idx.openCursor(IDBKeyRange.only(q.codigo));
    } else if (q.texto && exactFields.has(q.campo)) {
      req = idx.openCursor(IDBKeyRange.only(q.texto));
    } else {
      // Para texto no-exacto, iteramos el índice completo (por el campo elegido si hay texto, si no por fecha)
      req = idx.openCursor();
    }

    const results = [];
    let total = 0;

    // paginación por skip/take
    const start = (page - 1) * pageSize;
    const end = start + pageSize;

    return new Promise((resolve, reject) => {
      req.onerror = () => reject(req.error);

      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) {
          resolve({ total, results });
          return;
        }

        const row = cur.value;

        // filtros extra
        if (q.codigo && idxName !== "codigo") {
          if (String(row.codigo) !== q.codigo) { cur.continue(); return; }
        }

        // texto contains (para cliente/vendedor/descripcion/codigo si vino por openCursor general)
        if (q.texto) {
          const val = String(row[q.campo] ?? "");
          if (!val.toLowerCase().includes(q.texto.toLowerCase())) {
            cur.continue(); return;
          }
        }

        // filtro fechas
        if (q.desde && row.fecha && row.fecha < q.desde) { cur.continue(); return; }
        if (q.hasta && row.fecha && row.fecha > q.hasta) { cur.continue(); return; }

        // cuenta total
        const t = total;
        total = t + 1;

        // recolecta solo la página
        if (total > start && total <= end) {
          results.push(row);
        }

        cur.continue();
      };
    });
  });
}

function renderRows(rows){
  ui.tb.innerHTML = rows.map(r => `
    <tr>
      <td>${esc(r.codigo)}</td>
      <td>${esc(r.descripcion)}</td>
      <td>${esc(r.cod_cliente)}</td>
      <td>${esc(r.vendedor)}</td>
      <td>${esc(r.cliente)}</td>
      <td>${esc(r.fecha)}</td>
      <td>${esc(r.factura)}</td>
      <td>${esc(r.cantidad)}</td>
      <td>${fmtMoney(r.precio)}</td>
    </tr>
  `).join("");
}

async function refresh(db){
  const q = buildQueryFromUI();
  state.lastQuery = q;

  setStatus("buscando…");
  const { total, results } = await runQuery(db, q, state.page, state.pageSize);

  state.lastTotal = total;

  renderRows(results);

  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  ui.page.textContent = `Página ${state.page} / ${totalPages}`;
  ui.info.textContent = `Resultados: ${total.toLocaleString()} | Mostrando: ${results.length.toLocaleString()}`;

  ui.prev.disabled = state.page <= 1;
  ui.next.disabled = state.page >= totalPages;

  setStatus("listo");
}

// ======================
// Init + events
// ======================
(async function init(){
  const db = await openDB();

  // Rango fechas UI
  ui.fRango.addEventListener("change", () => {
    const custom = ui.fRango.value === "custom";
    ui.fDesde.disabled = !custom;
    ui.fHasta.disabled = !custom;
  });

  ui.pageSize.addEventListener("change", async () => {
    state.pageSize = Number(ui.pageSize.value);
    state.page = 1;
    await refresh(db);
  });

  ui.btnBuscar.addEventListener("click", async () => {
    state.page = 1;
    await refresh(db);
  });

  ui.btnMostrarTodo.addEventListener("click", async () => {
    ui.fCodigo.value = "";
    ui.fTexto.value = "";
    ui.fRango.value = "all";
    ui.fDesde.value = "";
    ui.fHasta.value = "";
    ui.fDesde.disabled = true;
    ui.fHasta.disabled = true;
    state.page = 1;
    await refresh(db);
  });

  ui.btnLimpiar.addEventListener("click", () => {
    ui.fCodigo.value = "";
    ui.fTexto.value = "";
  });

  ui.prev.addEventListener("click", async () => {
    state.page = Math.max(1, state.page - 1);
    await refresh(db);
  });

  ui.next.addEventListener("click", async () => {
    state.page += 1;
    await refresh(db);
  });

  ui.btnReimportar.addEventListener("click", async () => {
    if (!confirm("¿Reimportar y reconstruir la base offline?")) return;
    await importIfNeeded(db, true);
    state.page = 1;
    await refresh(db);
  });

  // Importar si hace falta
  await importIfNeeded(db, false);

  // Mostrar algo por defecto: últimos 90 días
  ui.fRango.value = "90";
  state.page = 1;
  await refresh(db);

  // Info básica
  const all = await countAll(db);
  console.log("Filas en DB:", all);
})();