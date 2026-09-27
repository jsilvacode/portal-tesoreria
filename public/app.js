const state = {
  user: null,
  departments: [],
  dateRange: null,
  period: { start: "", end: "", year: "", months: [], preset: "all" },
  globalReport: null,
  globalQueryKey: null,
  detailReport: null,
  detailQueryKey: null,
  selectedDepartment: null,
  transactionPage: 1,
  transactionPages: 1,
  transactionTotal: 0,
  transactionLoaded: 0,
  transactionCursor: null,
  transactionLoading: false,
  transactionRequest: 0,
  transactionController: null,
  globalReportRequest: 0,
  globalReportController: null,
  detailSearchTimer: null,
  globalSearchTimer: null,
  globalSearchRequest: 0,
  globalSearchPage: 1,
  globalSearchPages: 1,
  globalSearchLoaded: 0,
  globalSearchCursor: null,
  globalSearchController: null,
  globalSearchLoading: false,
  globalFilterTimer: null,
  detailFilterTimer: null,
  auditSearchTimer: null,
  auditRequest: 0,
  auditController: null,
  auditCursor: null,
  auditLoaded: 0,
  users: [],
  detailFilterDirty: false,
  currentView: "overview",
  adminTab: "users",
  importPreview: null,
};

const $ = (selector, root) => (root || document).querySelector(selector);
const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

function escapeHTML(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function normalizedSearch(value) {
  return String(value == null ? "" : value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-CL").replace(/[^a-z0-9]+/g, " ").trim();
}

function matchesSearch(values, query) {
  const normalized = normalizedSearch(query);
  if (!normalized) return true;
  const digits = String(query).replace(/\D/g, "");
  return values.some((value) => {
    const text = String(value == null ? "" : value);
    return normalizedSearch(text).includes(normalized) ||
      (digits.length >= 3 && text.replace(/\D/g, "").includes(digits));
  });
}

function money(value) {
  const scaled = Number(value || 0);
  const pesos = scaled / 100;
  const fractional = Math.abs(scaled % 100) !== 0;
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    minimumFractionDigits: fractional ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(pesos);
}

function shortDate(value) {
  if (!value) return "—";
  const parts = String(value).slice(0, 10).split("-");
  return parts.length === 3 ? parts[2] + "/" + parts[1] + "/" + parts[0] : value;
}

function prettyMonth(value) {
  const parts = value.split("-");
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return months[Number(parts[1]) - 1] + " " + parts[0].slice(2);
}

function toast(message, kind) {
  const region = $("#toast-region");
  const item = document.createElement("div");
  item.className = "toast" + (kind ? " toast-" + kind : "");
  item.textContent = message;
  region.appendChild(item);
  window.setTimeout(() => item.remove(), 4600);
}

async function api(path, options) {
  const config = Object.assign({ credentials: "same-origin" }, options || {});
  const response = await fetch(path, config);
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error((payload && payload.error) || "No se pudo completar la solicitud.");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function setAuthMode(mode) {
  $("#login-panel").hidden = mode !== "login";
  $("#register-panel").hidden = mode !== "register";
}

function populateDepartmentOptions(departments) {
  const options = (departments || []).map((name) => '<option value="' + escapeHTML(name) + '">' + escapeHTML(name) + '</option>').join("");
  $("#detail-department").innerHTML = '<option value="">Todos los departamentos</option>' + options;
  $("#global-department").innerHTML = '<option value="">Todos los departamentos</option>' + options;
  $("#audit-department").innerHTML = '<option value="">Todos los departamentos</option>' + options;
  $("#register-department").innerHTML = '<option value="">Selecciona un departamento</option>' + options;
}

const monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const monthShortNames = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

function renderMonthOptions(prefix) {
  $("#" + prefix + "-month-options").innerHTML = monthShortNames.map((name, index) =>
    '<button type="button" data-month-view="' + prefix + '" data-month-option="' + (index + 1) + '" aria-label="' + monthNames[index] + '" aria-pressed="false">' + name + '</button>'
  ).join("");
}

function syncPeriodControls() {
  ["global", "detail"].forEach((prefix) => {
    $("#" + prefix + "-start").value = state.period.start || "";
    $("#" + prefix + "-end").value = state.period.end || "";
    $("#" + prefix + "-year").value = state.period.year || "";
    const selected = new Set(state.period.months || []);
    $$("[data-month-option]", $("#" + prefix + "-month-options")).forEach((button) => {
      button.setAttribute("aria-pressed", selected.has(Number(button.dataset.monthOption)) ? "true" : "false");
    });
    const months = state.period.months || [];
    const summary = months.length === 0 || months.length === 12
      ? "Meses · todos"
      : months.length === 1
        ? "Meses · " + monthNames[months[0] - 1]
        : "Meses · " + months.length + " seleccionados";
    $("#" + prefix + "-month-summary").textContent = summary;
    $$('[data-period-view="' + prefix + '"]').forEach((button) => {
      button.classList.toggle("is-active", state.period.preset === button.dataset.periodPreset);
    });
  });
}

function initializePeriodControls(range) {
  const start = range && range.start ? range.start : "";
  const end = range && range.end ? range.end : "";
  const firstYear = start ? Number(start.slice(0, 4)) : (new Date()).getFullYear();
  const lastYear = end ? Number(end.slice(0, 4)) : firstYear;
  const years = [];
  for (let year = lastYear; year >= firstYear; year -= 1) years.push(year);
  ["global", "detail"].forEach((prefix) => {
    const options = years.map((year) => '<option value="' + year + '">' + year + '</option>').join("");
    $("#" + prefix + "-year").innerHTML = '<option value="">Todos</option>' + options;
    renderMonthOptions(prefix);
  });
  state.period = { start, end, year: "", months: [], preset: "all" };
  syncPeriodControls();
}

function refreshPeriodRange(range) {
  const previous = state.dateRange || {};
  const wasAll = (!state.period.start || state.period.start === previous.start) &&
    (!state.period.end || state.period.end === previous.end);
  state.dateRange = range || null;
  const firstYear = range && range.start ? Number(range.start.slice(0, 4)) : (new Date()).getFullYear();
  const lastYear = range && range.end ? Number(range.end.slice(0, 4)) : firstYear;
  const options = ['<option value="">Todos</option>'];
  for (let year = lastYear; year >= firstYear; year -= 1) {
    options.push('<option value="' + year + '">' + year + '</option>');
  }
  ["global", "detail"].forEach((prefix) => {
    const select = $("#" + prefix + "-year");
    const selected = state.period.year;
    select.innerHTML = options.join("");
    if (Array.from(select.options).some((option) => option.value === selected)) select.value = selected;
  });
  if (wasAll) {
    state.period.start = range && range.start || "";
    state.period.end = range && range.end || "";
    state.period.preset = "all";
  }
  syncPeriodControls();
}

function readPeriodControls(prefix) {
  const start = $("#" + prefix + "-start").value;
  const end = $("#" + prefix + "-end").value;
  if (start && end && start > end) {
    toast("La fecha inicial debe ser anterior a la fecha final.", "error");
    return null;
  }
  const months = $$("[data-month-option][aria-pressed='true']", $("#" + prefix + "-month-options"))
    .map((button) => Number(button.dataset.monthOption));
  state.period = {
    start,
    end,
    year: $("#" + prefix + "-year").value,
    months,
    preset: state.period.preset || "custom",
  };
  syncPeriodControls();
  return state.period;
}

function isoDate(dateValue) {
  return [dateValue.getFullYear(), String(dateValue.getMonth() + 1).padStart(2, "0"), String(dateValue.getDate()).padStart(2, "0")].join("-");
}

function applyPeriodPreset(prefix, preset) {
  const availableStart = state.dateRange && state.dateRange.start ? state.dateRange.start : isoDate(new Date());
  const availableEnd = state.dateRange && state.dateRange.end ? state.dateRange.end : isoDate(new Date());
  let start = availableStart;
  let end = availableEnd;
  let year = "";
  let months = [];
  const anchor = new Date(availableEnd + "T12:00:00");
  if (preset === "30" || preset === "90") {
    anchor.setDate(anchor.getDate() - (Number(preset) - 1));
    start = isoDate(anchor);
  } else if (preset === "year") {
    const currentYear = String((new Date()).getFullYear());
    year = Array.from($("#" + prefix + "-year").options).some((option) => option.value === currentYear)
      ? currentYear : String(availableEnd.slice(0, 4));
    start = year + "-01-01";
    end = year + "-12-31";
    if (availableStart && availableStart > start) start = availableStart;
    if (availableEnd && availableEnd < end) end = availableEnd;
  }
  state.period = { start, end, year, months, preset };
  syncPeriodControls();
  if (prefix === "global") loadGlobalReport();
  else loadDepartmentReport();
}

async function showApp(user, metadata) {
  state.user = user;
  state.departments = metadata.departments || [];
  state.dateRange = metadata.dateRange;
  state.selectedDepartment = user.role === "department" ? user.department_name : null;
  $("#auth-screen").hidden = true;
  $("#app-shell").hidden = false;
  const userType = user.is_superuser ? "Superusuario" : user.role === "treasurer" ? "Tesorero" : "Usuario de departamento";
  $("#user-badge").innerHTML = '<span class="user-email">' + escapeHTML(user.email) + '</span>' +
    '<span class="user-role">' + escapeHTML(userType) + '</span>';
  $("#department-nav-label").textContent = user.role === "treasurer" ? "Detalle" : "Mi departamento";
  $$(".admin-nav").forEach((item) => { item.hidden = user.role !== "treasurer"; });
  $("#global-department-filter").hidden = user.role !== "treasurer";
  $("#detail-department-filter").hidden = user.role !== "treasurer";
  $("#global-filter-fields").classList.toggle("has-department-filter", user.role === "treasurer");
  $("#detail-filter-fields").classList.toggle("has-department-filter", user.role === "treasurer");
  populateDepartmentOptions(state.departments);
  initializePeriodControls(metadata.dateRange || {});
  $("#department-title").textContent = user.role === "treasurer" ? "Detalle de movimientos" : user.department_name;
  state.currentView = "overview";
  updateNav();
  return loadGlobalReport();
}

function showAuth() {
  resetMaintenance();
  if (state.globalReportController) state.globalReportController.abort();
  if (state.globalSearchController) state.globalSearchController.abort();
  if (state.transactionController) state.transactionController.abort();
  state.globalReportRequest += 1;
  state.globalSearchRequest += 1;
  state.transactionRequest += 1;
  state.user = null;
  state.globalReport = null;
  state.globalQueryKey = null;
  state.detailReport = null;
  state.detailQueryKey = null;
  state.users = [];
  $("#app-shell").hidden = true;
  $("#auth-screen").hidden = false;
  setAuthMode("login");
}

function updateNav() {
  $$(".nav-item").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === state.currentView);
  });
  ["overview", "department", "admin"].forEach((view) => {
    $("#" + view + "-view").hidden = state.currentView !== view;
  });
}

function periodQuery(prefix) {
  const period = readPeriodControls(prefix);
  if (!period) return null;
  const params = new URLSearchParams();
  if (period.start) params.set("start", period.start);
  if (period.end) params.set("end", period.end);
  if (period.year) params.set("year", period.year);
  if (period.months.length && period.months.length < 12) params.set("months", period.months.join(","));
  return params.toString();
}

function metricHTML(label, value, tone, context) {
  const chartGlyph = '<svg class="metric-glyph" viewBox="0 0 24 20" aria-hidden="true" focusable="false">' +
    '<path class="metric-axis" d="M2 17.5H22" />' +
    '<rect class="metric-bar" x="4" y="11" width="3.5" height="6.5" rx="1" />' +
    '<rect class="metric-bar" x="10" y="8" width="3.5" height="9.5" rx="1" />' +
    '<rect class="metric-bar" x="16" y="4" width="3.5" height="13.5" rx="1" />' +
    '<path class="metric-trend" d="m2.5 9 5-3 4 1.7 7.5-5.2m-3.1.1 3.1-.1-.1 3" />' +
    '</svg>';
  return '<article class="metric-card ' + tone + '">' +
    '<span class="metric-label">' + chartGlyph + escapeHTML(label) + '</span>' +
    '<strong class="metric-value">' + money(value) + '</strong>' +
    '<span class="metric-context">' + escapeHTML(context || "Pesos chilenos · CLP") + '</span>' +
    '</article>';
}

function renderMetrics(container, report) {
  const totals = report.totals;
  container.innerHTML = [
    metricHTML("Saldo inicial", totals.opening, "metric-neutral", "Al inicio del período"),
    metricHTML("Ingresos (+)", totals.inflow, "metric-positive", "Importes positivos"),
    metricHTML("Egresos (-)", totals.outflow, "metric-negative", "Importes negativos"),
    metricHTML("Movimiento neto", totals.net, totals.net < 0 ? "metric-negative" : "metric-positive", "Suma firmada de Valor"),
    metricHTML("Saldo final", totals.closing, "metric-navy", totals.rows.toLocaleString("es-CL") + " movimientos"),
  ].join("");
}

function updateBalanceNote(report) {
  const separatedMonths = Boolean(report.filters && report.filters.nonContiguous);
  const emptySelection = Boolean(report.filters && report.filters.emptySelection);
  $("#balance-equation").hidden = separatedMonths || emptySelection;
  $("#balance-note-small").hidden = separatedMonths || emptySelection;
  $("#balance-note-text").textContent = emptySelection
    ? "No hay períodos dentro del rango de fechas con la selección de año y meses aplicada."
    : separatedMonths
      ? "El movimiento neto suma los meses seleccionados. El saldo final refleja el balance real hasta la última fecha incluida."
      : "El saldo inicial considera el balance de apertura y todos los movimientos anteriores al período seleccionado.";
}

function renderChart(container, months) {
  if (!months || !months.length || months.every((row) => !row.inflow && !row.outflow)) {
    container.innerHTML = '<div class="chart-no-data">Sin movimientos en el período seleccionado.</div>';
    return;
  }
  const width = Math.max(280, Math.round(container.getBoundingClientRect().width || 680));
  const height = 194;
  const compact = width < 480;
  const shortPeriod = months.length <= 3;
  const left = compact ? 48 : 12;
  const right = 10;
  const top = shortPeriod ? 42 : 10;
  const bottom = 31;
  const chartHeight = height - top - bottom;
  const chartWidth = width - left - right;
  const maxValue = Math.max(1, ...months.map((row) => Math.max(row.inflow, row.outflow)));
  const groupWidth = chartWidth / months.length;
  const barWidth = shortPeriod
    ? Math.min(42, Math.max(22, groupWidth * 0.24))
    : Math.min(19, Math.max(5, groupWidth * 0.27));
  let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Ingresos y egresos mensuales">';
  [0, 0.5, 1].forEach((part) => {
    const y = top + chartHeight * part;
    const amount = Math.round(maxValue * (1 - part));
    svg += '<line class="chart-gridline" x1="' + left + '" y1="' + y + '" x2="' + (width - right) + '" y2="' + y + '"></line>';
    svg += '<text class="chart-axis"' + (compact ? ' text-anchor="end"' : '') + ' x="' + (compact ? left - 5 : left) + '" y="' + (y - 3) + '">' + compactMoney(amount) + '</text>';
  });
  months.forEach((row, index) => {
    const center = left + groupWidth * (index + 0.5);
    const inHeight = chartHeight * row.inflow / maxValue;
    const outHeight = chartHeight * row.outflow / maxValue;
    svg += '<rect class="chart-bar-in" x="' + (center - barWidth - 2) + '" y="' + (top + chartHeight - inHeight) +
      '" width="' + barWidth + '" height="' + Math.max(1, inHeight) + '" rx="2"><title>Ingresos ' +
      escapeHTML(prettyMonth(row.month)) + ': ' + money(row.inflow) + '</title></rect>';
    svg += '<rect class="chart-bar-out" x="' + (center + 2) + '" y="' + (top + chartHeight - outHeight) +
      '" width="' + barWidth + '" height="' + Math.max(1, outHeight) + '" rx="2"><title>Egresos ' +
      escapeHTML(prettyMonth(row.month)) + ': ' + money(row.outflow) + '</title></rect>';
    if (months.length === 1) {
      if (row.inflow > 0) {
        svg += '<text class="chart-value chart-value-in" text-anchor="middle" x="' + (center - barWidth / 2 - 2) + '" y="' +
          Math.max(13, top + chartHeight - inHeight - 5) + '">' + compactMoney(row.inflow) + '</text>';
      }
      if (row.outflow > 0) {
        svg += '<text class="chart-value chart-value-out" text-anchor="middle" x="' + (center + barWidth / 2 + 2) + '" y="' +
          Math.max(13, top + chartHeight - outHeight - 5) + '">' + compactMoney(row.outflow) + '</text>';
      }
    }
    if ((months.length <= 12 && !compact) || index === 0 || index === months.length - 1 || index % 2 === 0) {
      svg += '<text class="chart-axis" text-anchor="middle" x="' + center + '" y="' + (height - 9) + '">' +
        escapeHTML(prettyMonth(row.month)) + '</text>';
    }
  });
  svg += "</svg>";
  container.innerHTML = svg;
}

function compactMoney(value) {
  const amount = Number(value || 0) / 100;
  if (amount >= 1000000) return "$" + (amount / 1000000).toFixed(1).replace(".", ",") + "M";
  if (amount >= 1000) return "$" + Math.round(amount / 1000) + "k";
  return "$" + amount;
}

function renderDepartmentRows(report) {
  const tbody = $("#department-rows");
  const isTreasurer = state.user.role === "treasurer";
  const search = $("#global-search").value.trim();
  const rows = report.departments.filter((row) => matchesSearch([
    row.department, row.currency, row.opening, Math.trunc(row.opening / 100), money(row.opening),
    row.inflow, Math.trunc(row.inflow / 100), money(row.inflow), row.outflow, Math.trunc(row.outflow / 100), money(row.outflow),
    row.net, Math.trunc(row.net / 100), money(row.net), row.closing, Math.trunc(row.closing / 100), money(row.closing), row.rows,
    report.period.start, shortDate(report.period.start), report.period.end, shortDate(report.period.end),
  ], search));
  const focusedSearch = Boolean(search && !rows.length);
  $("#global-metrics").hidden = focusedSearch;
  $(".insight-grid").hidden = focusedSearch;
  $("#department-panel").hidden = focusedSearch;
  $("#department-count").textContent = rows.length + (rows.length === 1 ? " departamento" : " departamentos");
  tbody.innerHTML = rows.map((row) => {
    const canOpen = isTreasurer || row.department === state.user.department_name;
    const departmentCell = canOpen
      ? '<button class="dept-link" data-open-department="' + escapeHTML(row.department) + '">' + escapeHTML(row.department) + '</button>'
      : escapeHTML(row.department);
    return '<tr>' +
      '<td class="dept-name" data-label="Departamento">' + departmentCell + '</td>' +
      '<td class="num" data-label="Saldo inicial">' + money(row.opening) + '</td>' +
      '<td class="num amount-in" data-label="Ingresos (+)">' + (row.inflow ? "+" : "—") + (row.inflow ? money(row.inflow) : "") + '</td>' +
      '<td class="num amount-out" data-label="Egresos (-)">' + (row.outflow ? "−" + money(row.outflow) : "—") + '</td>' +
      '<td class="num amount-strong" data-label="Saldo final">' + money(row.closing) + '</td>' +
      '<td class="num" data-label="Movimientos">' + Number(row.rows).toLocaleString("es-CL") + '</td>' +
      '<td data-label="Detalle">' + (canOpen ? '<button class="open-detail" data-open-department="' + escapeHTML(row.department) + '" aria-label="Ver movimientos de ' + escapeHTML(row.department) + '">→</button>' : "") + '</td>' +
      '</tr>';
  }).join("") || '<tr><td colspan="7" class="table-empty">Sin coincidencias.</td></tr>';
  $$("[data-open-department]", tbody).forEach((button) => {
    button.addEventListener("click", () => openDepartment(button.dataset.openDepartment));
  });
}

async function loadGlobalReport() {
  const period = periodQuery("global");
  if (period === null) return false;
  const department = state.user.role === "treasurer" ? $("#global-department").value : "";
  const queryKey = period + "&department=" + department;
  if (state.globalReport && state.globalQueryKey === queryKey) return true;
  if (state.globalReportController) state.globalReportController.abort();
  if ($("#global-search").value.trim()) {
    if (state.globalSearchController) state.globalSearchController.abort();
    state.globalSearchRequest += 1;
    state.globalSearchCursor = null;
    state.globalSearchLoaded = 0;
    $("#global-search-more").disabled = true;
    $("#global-search-more").hidden = true;
    $("#global-search-list").innerHTML = '<div class="loading">Actualizando búsqueda…</div>';
  }
  const controller = new AbortController();
  state.globalReportController = controller;
  const requestId = ++state.globalReportRequest;
  const params = new URLSearchParams(period);
  if (department) params.set("department", department);
  const query = params.toString();
  $("#global-metrics").innerHTML = '<div class="loading">Actualizando balance…</div>';
  try {
    const report = await api("/api/summary?" + query, { signal: controller.signal });
    if (requestId !== state.globalReportRequest) return;
    state.globalReport = report;
    state.globalQueryKey = queryKey;
    renderMetrics($("#global-metrics"), report);
    updateBalanceNote(report);
    renderChart($("#global-chart"), report.monthly);
    renderDepartmentRows(report);
    if ($("#global-search").value.trim()) loadGlobalSearch();
    return true;
  } catch (error) {
    if (requestId !== state.globalReportRequest) return;
    if (error.name !== "AbortError") toast("No se pudo cargar el balance. Puedes reintentar desde el filtro.", "error");
    if (error.status === 401) showAuth();
    return false;
  }
}

async function loadGlobalSearch(append = false) {
  const search = $("#global-search").value.trim();
  if (!search) {
    $("#global-search-panel").hidden = true;
    return;
  }
  const period = periodQuery("global");
  if (period === null) return;
  if (state.globalSearchController) state.globalSearchController.abort();
  const controller = new AbortController();
  state.globalSearchController = controller;
  const requestId = ++state.globalSearchRequest;
  const department = state.user.role === "treasurer" ? $("#global-department").value : "";
  const params = new URLSearchParams(period);
  params.set("q", search);
  params.set("page", append ? state.globalSearchPage + 1 : 1);
  if (append && state.globalSearchCursor) {
    params.set("cursor_date", state.globalSearchCursor.date);
    params.set("cursor_id", state.globalSearchCursor.id);
  }
  if (department) params.set("department", department);
  const panel = $("#global-search-panel");
  panel.hidden = false;
  state.globalSearchLoading = true;
  $("#global-search-more").disabled = true;
  if (append) $("#global-search-more").textContent = "Cargando…";
  else $("#global-search-list").innerHTML = '<div class="loading">Buscando movimientos…</div>';
  try {
    const pageData = await api("/api/transactions?" + params.toString(), { signal: controller.signal });
    if (requestId !== state.globalSearchRequest) return;
    state.globalSearchPage = pageData.page;
    state.globalSearchPages = pageData.pages;
    state.globalSearchCursor = pageData.nextCursor;
    state.globalSearchLoaded = (append ? state.globalSearchLoaded : 0) + pageData.transactions.length;
    const loaded = state.globalSearchLoaded;
    $("#global-search-count").textContent = pageData.total.toLocaleString("es-CL") + " movimientos";
    $("#global-search-page-label").textContent = loaded.toLocaleString("es-CL") + " de " + pageData.total.toLocaleString("es-CL");
    $("#global-search-more").hidden = !pageData.hasMore;
    const list = $("#global-search-list");
    if (!pageData.transactions.length) {
      list.innerHTML = '<div class="transaction-empty">Sin coincidencias para este período.</div>';
    } else {
      const markup = pageData.transactions.map((row) => transactionRowHTML(row, false)).join("");
      if (append) list.insertAdjacentHTML("beforeend", markup);
      else list.innerHTML = markup;
    }
  } catch (error) {
    if (requestId === state.globalSearchRequest && error.name !== "AbortError") toast(error.message, "error");
  } finally {
    if (requestId === state.globalSearchRequest) {
      state.globalSearchLoading = false;
      $("#global-search-more").disabled = !state.globalSearchCursor;
      $("#global-search-more").textContent = "Mostrar más";
    }
  }
}

function openDepartment(name) {
  if (!readPeriodControls(state.currentView === "overview" ? "global" : "detail")) return;
  if (state.user.role === "department" && name !== state.user.department_name) {
    toast("Tu cuenta solo tiene acceso al departamento asignado.", "error");
    return;
  }
  state.selectedDepartment = name;
  if (state.user.role === "treasurer") $("#detail-department").value = name || "";
  syncPeriodControls();
  $("#department-title").textContent = name || "Todos los departamentos";
  state.currentView = "department";
  state.transactionPage = 1;
  state.transactionLoaded = 0;
  state.transactionCursor = null;
  updateNav();
  loadDepartmentReport();
}

function getDetailScope() {
  return state.user.role === "department" ? state.user.department_name : state.selectedDepartment;
}

function detailQuery() {
  const period = periodQuery("detail");
  if (period === null) return null;
  const department = getDetailScope();
  return period + "&view=department" + (department ? "&department=" + encodeURIComponent(department) : "");
}

async function loadDepartmentReport(append = false, refreshSummary = true) {
  if (append && state.detailFilterDirty) return;
  const query = detailQuery();
  if (query === null) return;
  const search = $("#detail-search").value.trim();
  const queryKey = query + "&q=" + encodeURIComponent(search);
  if (!append && !state.detailFilterDirty && state.detailReport && state.detailQueryKey === queryKey && state.transactionLoaded) return;
  const shouldRefreshSummary = refreshSummary || state.detailFilterDirty || !state.detailReport;
  if (state.transactionController) state.transactionController.abort();
  const controller = new AbortController();
  state.transactionController = controller;
  if (!append) state.detailFilterDirty = false;
  const requestedPage = append ? state.transactionPage + 1 : 1;
  const requestId = ++state.transactionRequest;
  const button = $("#load-more-button");
  state.transactionLoading = true;
  button.disabled = true;
  if (append) button.textContent = "Cargando…";
  else {
    $("#detail-metrics").innerHTML = '<div class="loading">Actualizando detalle…</div>';
    $("#transaction-list").innerHTML = '<div class="loading">Cargando movimientos…</div>';
    $("#page-label").textContent = "";
  }
  try {
    const transactionParams = new URLSearchParams(query);
    if (search) transactionParams.set("q", search);
    if (append && state.transactionCursor) {
      transactionParams.set("cursor_date", state.transactionCursor.date);
      transactionParams.set("cursor_id", state.transactionCursor.id);
    }
    transactionParams.set("page", requestedPage);
    let report;
    let pageData;
    if (!append && shouldRefreshSummary) {
      const combined = await api("/api/detail?" + transactionParams.toString(), { signal: controller.signal });
      report = combined.report;
      pageData = combined;
    } else {
      report = shouldRefreshSummary ? await api("/api/summary?" + query, { signal: controller.signal }) : state.detailReport;
      pageData = await api("/api/transactions?" + transactionParams.toString(), { signal: controller.signal });
    }
    if (requestId !== state.transactionRequest) return;
    state.detailReport = report;
    state.detailQueryKey = queryKey;
    state.transactionPage = pageData.page;
    state.transactionPages = pageData.pages;
    state.transactionTotal = pageData.total;
    state.transactionCursor = pageData.nextCursor;
    state.transactionLoaded = (append ? state.transactionLoaded : 0) + pageData.transactions.length;
    renderMetrics($("#detail-metrics"), report);
    renderTransactions(pageData, append);
  } catch (error) {
    if (requestId !== state.transactionRequest) return;
    if (error.name !== "AbortError") toast(error.message, "error");
    if (error.status === 401) showAuth();
  } finally {
    if (requestId === state.transactionRequest) {
      state.transactionLoading = false;
      button.disabled = state.detailFilterDirty || !state.transactionCursor;
      button.textContent = "Mostrar más";
    }
  }
}

function renderTransactions(pageData, append = false) {
  const search = $("#detail-search").value.trim();
  $("#transaction-count").textContent = pageData.total.toLocaleString("es-CL") + (search ? " coincidencias" : " movimientos");
  const loaded = state.transactionLoaded;
  $("#page-label").textContent = loaded.toLocaleString("es-CL") + " de " + pageData.total.toLocaleString("es-CL") + " movimientos";
  $("#load-more-button").hidden = !pageData.hasMore;
  $("#load-more-button").disabled = state.detailFilterDirty || !pageData.hasMore;
  const container = $("#transaction-list");
  if (!pageData.transactions.length) {
    if (!append) container.innerHTML = '<div class="transaction-empty">' + (search ? "Sin coincidencias para la búsqueda." : "No hay movimientos para este período.") + '</div>';
    return;
  }
  const markup = pageData.transactions.map(transactionRowHTML).join("");
  if (append) container.insertAdjacentHTML("beforeend", markup);
  else container.innerHTML = markup;
}

function transactionRowHTML(row, allowReview = true) {
  const dateLine = '<div class="transaction-date">' + shortDate(row.movement_date) +
    '<small>Contable</small><small>Evento ' + shortDate(row.event_date) + '</small></div>';
  const donor = row.donor_name ? '<div class="transaction-donor">' + escapeHTML(row.donor_name) + '</div>' : '<div class="transaction-donor">Aportante no informado</div>';
  const observations = row.observations ? '<small class="transaction-extra">' + escapeHTML(row.observations) + '</small>' : "";
  const amountClass = row.amount < 0 ? "amount-out" : "amount-in";
  return '<article class="transaction-row">' +
    dateLine +
    '<div class="transaction-type">' + escapeHTML(row.movement_type) + '</div>' +
    '<div class="transaction-description">' + escapeHTML(row.description || "Sin glosa") + observations + '</div>' +
    donor +
    '<div class="transaction-amount ' + amountClass + '">' + (row.amount > 0 ? "+" : "") + money(row.amount) +
      '<small>Saldo acumulado ' + money(row.running_balance) + '</small>' + (allowReview ? maintenanceButton('movement', row.id) : "") + '</div>' +
    '</article>';
}

async function loadAdminUsers() {
  const data = await api("/api/admin/users");
  state.users = data.users;
  renderAdminUsers();
}

function renderAdminUsers() {
  const query = $("#users-search").value;
  const users = state.users.filter((user) => matchesSearch([
    user.email, user.role === "treasurer" ? "Tesorería" : user.department_name,
    user.status, user.created_at, shortDate(user.created_at.slice(0, 10)),
  ], query));
  const labels = { pending: "Pendiente", active: "Activo", inactive: "Desactivado" };
  const actions = {
    pending: '<button class="button button-primary" data-user-status="active">Aprobar</button>',
    active: '<button class="button button-outline" data-user-status="inactive">Desactivar</button>',
    inactive: '<button class="button button-outline" data-user-status="active">Reactivar</button>',
  };
  $("#users-list").innerHTML = users.map((user) =>
    '<div class="admin-row">' +
      '<div class="admin-primary">' + escapeHTML(user.email) +
        '<span class="admin-secondary">' + escapeHTML(user.role === "treasurer" ? "Tesorería" : user.department_name) + '</span></div>' +
      '<div class="admin-secondary admin-created">' + shortDate(user.created_at.slice(0, 10)) + '</div>' +
      '<span class="status-pill status-' + user.status + '">' + labels[user.status] + '</span>' +
      '<div class="admin-actions">' + (user.role === "treasurer" ? "" : actions[user.status]) + '</div>' +
      '<span class="admin-user-id" hidden>' + user.id + '</span>' +
    '</div>'
  ).join("") || '<div class="transaction-empty">' + (query ? "Sin coincidencias." : "Todavía no hay solicitudes.") + '</div>';
  $$("#users-list [data-user-status]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = Number(button.closest(".admin-row").querySelector(".admin-user-id").textContent);
      try {
        await api("/api/admin/users/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: id, status: button.dataset.userStatus }),
        });
        toast("Estado del usuario actualizado.", "success");
        loadAdminUsers();
      } catch (error) {
        toast(error.message, "error");
      }
    });
  });
}

function auditLabel(event) {
  const labels = {
    login_success: "Inicio de sesión",
    login_failed: "Intento de acceso fallido",
    login_pending: "Acceso pendiente de aprobación",
    login_inactive: "Intento con cuenta desactivada",
    logout: "Cierre de sesión",
    registration_submitted: "Solicitud de acceso",
    report_viewed: "Consulta de balance",
    transactions_viewed: "Consulta de movimientos",
    export_pdf: "Exportación PDF",
    export_xlsx: "Exportación Excel",
    user_approved: "Usuario aprobado",
    user_deactivated: "Usuario desactivado",
    import_previewed: "Archivo validado",
    import_completed: "Archivo importado",
    initial_data_loaded: "Carga inicial de datos",
  };
  return labels[event] || event;
}

function auditParams() {
  const params = new URLSearchParams();
  for (const [id, key] of [["audit-start", "start"], ["audit-end", "end"], ["audit-department", "department"], ["audit-user", "user_id"], ["audit-search", "q"]]) {
    const value = $("#" + id).value.trim();
    if (value) params.set(key, value);
  }
  return params;
}

async function loadAudit(append = false) {
  if (state.auditController) state.auditController.abort();
  const controller = new AbortController();
  state.auditController = controller;
  const requestId = ++state.auditRequest;
  const params = auditParams();
  if (append && state.auditCursor) params.set("cursor_id", state.auditCursor);
  if (!append) $("#audit-list").innerHTML = '<div class="loading">Cargando actividad…</div>';
  $("#audit-more").disabled = true;
  try {
    const data = await api("/api/admin/audit?" + params.toString(), { signal: controller.signal });
    if (requestId !== state.auditRequest) return;
    state.auditCursor = data.nextCursor;
    state.auditLoaded = (append ? state.auditLoaded : 0) + data.events.length;
    const markup = data.events.map((row) => {
    let detail = {};
    try { detail = JSON.parse(row.detail || "{}"); } catch (_) {}
    const context = Object.entries(detail).map(([key, value]) => key + ": " + value).join(" · ");
    return '<div class="audit-row">' +
      '<span>' + escapeHTML(new Date(row.created_at).toLocaleString("es-CL")) + '</span>' +
      '<span class="audit-event">' + escapeHTML(auditLabel(row.event_type)) + '</span>' +
      '<span>' + escapeHTML(row.email || "Sistema") + (context ? " · " + escapeHTML(context) : "") + '</span>' +
      '</div>';
    }).join("");
    const list = $("#audit-list");
    if (append) list.insertAdjacentHTML("beforeend", markup);
    else list.innerHTML = markup || '<div class="transaction-empty">No hay actividad registrada.</div>';
    $("#audit-count").textContent = state.auditLoaded.toLocaleString("es-CL") +
      " de " + data.total.toLocaleString("es-CL") + " eventos";
    $("#audit-more").hidden = !data.hasMore;
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    if (requestId === state.auditRequest) $("#audit-more").disabled = !state.auditCursor;
  }
}

async function openAdminTab(tab) {
  state.adminTab = tab;
  $$(".admin-tab").forEach((button) => button.classList.toggle("is-active", button.dataset.adminTab === tab));
  $$(".admin-panel").forEach((panel) => { panel.hidden = panel.id !== "admin-" + tab + "-panel"; });
  try {
    if (tab === "users") await loadAdminUsers();
    if (tab === "audit") {
      if (state.auditController) state.auditController.abort();
      state.auditRequest++;
      state.auditCursor = null;
      $("#audit-list").innerHTML = '<p class="muted">Selecciona los filtros y pulsa Consultar.</p>';
      $("#audit-count").textContent = "";
      $("#audit-more").hidden = true;
      const data = {users: state.users.length ? state.users : (await api("/api/admin/users")).users};
      if (!state.users.length) state.users = data.users;
      const selected = $("#audit-user").value;
      $("#audit-user").innerHTML = '<option value="">Todos los usuarios</option>' + data.users.map(u => '<option value="' + u.id + '">' + escapeHTML(u.email) + '</option>').join("");
      $("#audit-user").value = selected;
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

function exportReport(format, view) {
  const prefix = view === "department" ? "detail" : "global";
  const period = periodQuery(prefix);
  if (period === null) return;
  const params = new URLSearchParams(period);
  params.set("format", format);
  params.set("view", view);
  const department = view === "department" ? getDetailScope() :
    (view === "global" && state.user.role === "treasurer" ? $("#global-department").value : null);
  if (department) params.set("department", department);
  if (view === "all_detail" && state.user.role !== "treasurer") {
    toast("La exportación detallada global requiere acceso de tesorería.", "error");
    return;
  }
  if (view === "department" && $("#detail-search").value.trim()) {
    const onlyMatches = window.confirm(
      "La búsqueda está activa. Aceptar exporta solo las coincidencias; Cancelar exporta todos los movimientos del período."
    );
    if (onlyMatches) params.set("q", $("#detail-search").value.trim());
  }
  window.location.href = "/api/export?" + params.toString();
}

async function submitImport(event) {
  event.preventDefault();
  const file = $("#import-file").files[0];
  if (!file) return toast("Selecciona el archivo de contabilidad.", "error");
  const button = $("#import-form button[type=submit]");
  button.disabled = true;
  button.textContent = "Validando…";
  try {
    const form = new FormData();
    form.append("file", file);
    const preview = await api("/api/admin/import/preview", { method: "POST", body: form });
    state.importPreview = preview;
    renderImportPreview(preview);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Validar archivo";
  }
}

function renderImportPreview(preview) {
  const overlapCount = Number(preview.overlap_count || 0);
  const exactCount = Number(preview.exact_matches || 0);
  const similarCount = Number(preview.similar_matches || 0);
  const repeatCount = Number(preview.file_repeats || 0);
  const matchCount = exactCount + similarCount + repeatCount;
  const newDepartments = preview.new_departments || [];
  const overlapItems = (preview.overlapping_batches || []).map((batch) =>
    '<li><strong>' + escapeHTML(batch.filename) + '</strong> · ' +
    shortDate(batch.start) + '–' + shortDate(batch.end) +
    ' <span class="muted">(se cruza ' + shortDate(batch.overlap_start) + '–' +
    shortDate(batch.overlap_end) + ')</span></li>'
  ).join("");
  const matchedRows = new Set(preview.matched_rows || []);
  const samples = (preview.match_samples || []).map((row) =>
    '<article class="import-match-card">' +
    (row.comparison === 'Coincidencia exacta' && matchedRows.has(row.file_row) ? '<label><input type="checkbox" class="keep-import-row" value="' + Number(row.file_row) + '"> Conservar esta ocurrencia como nueva</label>' : '') +
      '<div class="import-match-top"><strong>Fila ' + Number(row.file_row) + ' · ' +
      escapeHTML(row.department) + '</strong><span>' + shortDate(row.date) + ' · ' +
      escapeHTML(money(row.amount)) + '</span></div>' +
      '<div class="import-match-description">' +
      escapeHTML(row.movement_type || "Movimiento") + ' · ' +
      escapeHTML(row.description || "Sin glosa") +
      (row.person ? ' · ' + escapeHTML(row.person) : "") + '</div>' +
      '<small>' + escapeHTML(row.comparison) + ' · Archivo anterior: ' +
      escapeHTML(row.previous_file) + (row.previous_row ? ' · fila ' + Number(row.previous_row) : "") +
      (row.department_id || row.previous_department_id
        ? ' · DEPARTMENT_ID: ' + escapeHTML(row.department_id || "—") +
          ' / anterior: ' + escapeHTML(row.previous_department_id || "—")
        : "") + '</small>' +
    '</article>'
  ).join("");

  let html = '<strong>Vista previa lista</strong><br>' +
    escapeHTML(preview.filename) + ' · ' + Number(preview.rows).toLocaleString("es-CL") +
    ' filas validadas.<br><span class="import-period">Período: ' +
    shortDate(preview.period.start) + '–' + shortDate(preview.period.end) + '</span>';

  html += '<label class="admin-search">Tratamiento del archivo<select id="import-mode"><option value="reconcile">Actualizar: excluir ocurrencias ya registradas</option><option value="append">Agregar todas las filas, incluidas las coincidencias</option></select></label>' +
    '<p>' + matchedRows.size.toLocaleString("es-CL") + ' ocurrencias ya registradas · ' + Number(preview.new_rows ?? preview.rows).toLocaleString("es-CL") + ' por incorporar antes de revisar excepciones.</p>';
  if (preview.same_file_warning) {
    html += '<div class="import-warning"><strong>Archivo ya incorporado</strong><br>' +
      'El contenido completo coincide con una carga anterior. En modo Actualizar se excluyen las ocurrencias ya registradas.</div>';
  }

  if (newDepartments.length) {
    html += '<div class="import-warning"><strong>Departamentos nuevos</strong><br>' +
      'Confirma que estos nombres corresponden a departamentos que deben agregarse:<ul class="import-overlap-list">' +
      newDepartments.map((name) => '<li>' + escapeHTML(name) + '</li>').join("") +
      '</ul></div><label class="import-confirm"><input id="confirm-import-new-departments" type="checkbox">' +
      '<span>Revisé y autorizo agregar estos departamentos.</span></label>';
  }

  if (overlapCount) {
    html += '<div class="import-warning"><strong>Períodos superpuestos: ' +
      overlapCount.toLocaleString("es-CL") + ' carga' + (overlapCount === 1 ? "" : "s") +
      '</strong><br>Compartir fechas no significa que los movimientos sean iguales. Revisa las cargas y las coincidencias antes de continuar.' +
      '<ul class="import-overlap-list">' + overlapItems + '</ul>' +
      (preview.overlaps_truncated ? '<small>Se muestran las 8 cargas más recientes con fechas compartidas.</small>' : "") +
      '</div>' +
      '<label class="import-confirm"><input id="confirm-import-overlap" type="checkbox">' +
      '<span>Revisé los períodos y el tratamiento seleccionado.</span></label>';
  } else {
    html += '<div class="import-clear">No hay períodos superpuestos con cargas anteriores.</div>';
  }

  if (matchCount) {
    html += '<div class="import-warning"><strong>Filas para revisar</strong><ul class="import-match-counts">' +
      (exactCount ? '<li>' + exactCount.toLocaleString("es-CL") + ' coincidencia' + (exactCount === 1 ? "" : "s") +
      ' en todos los campos contables conservados.</li>' : "") +
      (similarCount ? '<li>' + similarCount.toLocaleString("es-CL") +
      ' posible' + (similarCount === 1 ? "" : "s") + ' coincidencia' + (similarCount === 1 ? "" : "s") +
      ' parciales; revisar fechas, glosa y demás campos.</li>' : "") +
      (repeatCount ? '<li>' + repeatCount.toLocaleString("es-CL") +
      ' fila' + (repeatCount === 1 ? "" : "s") + ' idéntica' + (repeatCount === 1 ? "" : "s") +
      ' dentro del archivo.</li>' : "") + '</ul>' +
      '<details class="import-match-details"><summary>Revisar filas detectadas' +
      (preview.samples_truncated ? ' (primeras ' + (preview.match_samples || []).length + ')' : '') +
      '</summary><div class="import-match-list">' + samples + '</div>' +
      (preview.samples_truncated ? '<small>Hay más coincidencias que las mostradas. Las coincidencias completas se excluyen en modo Actualizar. Para excepciones fuera de esta muestra, divide el archivo antes de incorporarlo.</small>' : '') +
      '</details></div>' +
      '<label class="import-confirm"><input id="confirm-import-matches" type="checkbox">' +
      '<span>Revisé las coincidencias y las posibles correcciones. Confirmo incorporar según el tratamiento seleccionado.</span></label>';
  } else {
    html += '<div class="import-clear">No se encontraron coincidencias completas ni filas idénticas dentro del archivo.</div>';
  }

  html += '<p class="import-no-filter">' + escapeHTML(preview.message) + '</p>' +
    '<button id="commit-import" class="button button-primary" type="button">Incorporar ' +
    Number(preview.rows).toLocaleString("es-CL") + ' movimientos</button>';
  const container = $("#import-preview");
  container.innerHTML = html;
  container.hidden = false;
  const updateButton = () => {
    const overlapConfirmed = !overlapCount || $("#confirm-import-overlap").checked;
    const matchesConfirmed = !matchCount || $("#confirm-import-matches").checked;
    const departmentsConfirmed = !newDepartments.length || $("#confirm-import-new-departments").checked;
    const count = $("#import-mode").value === "reconcile"
      ? Number(preview.new_rows ?? preview.rows) + $$(".keep-import-row:checked").length : Number(preview.rows);
    $("#commit-import").textContent = "Incorporar " + count.toLocaleString("es-CL") + " movimientos";
    $("#commit-import").disabled = !overlapConfirmed || !matchesConfirmed || !departmentsConfirmed;
  };
  [$("#confirm-import-overlap"), $("#confirm-import-matches"), $("#confirm-import-new-departments")].filter(Boolean)
    .forEach((checkbox) => checkbox.addEventListener("change", updateButton));
  $("#import-mode").addEventListener("change", updateButton);
  $$(".keep-import-row").forEach(input => input.addEventListener("change", updateButton));
  updateButton();
  $("#commit-import").addEventListener("click", commitImport);
}

async function commitImport() {
  if (!state.importPreview) return;
  const commitButton = $("#commit-import");
  if (!commitButton || commitButton.disabled) return;
  let confirmSame = false;
  if (state.importPreview.same_file_warning && $("#import-mode").value === "append") {
    confirmSame = window.confirm("Ya se importó antes un archivo con el mismo contenido. ¿Deseas incorporar esta copia completa como un nuevo lote?");
    if (!confirmSame) return;
  }
  const originalLabel = commitButton.textContent;
  commitButton.disabled = true;
  commitButton.textContent = "Incorporando…";
  try {
    const result = await api("/api/admin/import/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preview_token: state.importPreview.preview_token,
        confirm_same_file: confirmSame || $("#import-mode").value === "reconcile",
        mode: $("#import-mode").value,
        review_signature: state.importPreview.review_signature,
        keep_rows: $$(".keep-import-row:checked").map(input => Number(input.value)),
        confirm_overlap: !state.importPreview.overlap_count || $("#confirm-import-overlap").checked,
        confirm_new_departments: !(state.importPreview.new_departments || []).length ||
          $("#confirm-import-new-departments").checked,
        confirm_matches: !(state.importPreview.exact_matches || state.importPreview.similar_matches || state.importPreview.file_repeats) ||
          $("#confirm-import-matches").checked,
      }),
    });
    state.importPreview = null;
    $("#import-preview").hidden = true;
    $("#import-form").reset();
    const metadata = await api("/api/me");
    state.departments = metadata.departments || [];
    populateDepartmentOptions(state.departments);
    refreshPeriodRange(metadata.dateRange);
    state.globalReport = null;
    state.globalQueryKey = null;
    state.detailReport = null;
    state.detailQueryKey = null;
    state.transactionLoaded = 0;
    state.transactionCursor = null;
    const reportLoaded = await loadGlobalReport();
    toast(reportLoaded
      ? result.message + " Se incorporaron " + result.rows.toLocaleString("es-CL") + " filas."
      : "Archivo incorporado. El balance no se pudo actualizar; recarga la vista.",
    reportLoaded ? "success" : "error");
  } catch (error) {
    if (error.status === 409 && error.payload && error.payload.analysis) {
      state.importPreview = Object.assign({}, state.importPreview, error.payload.analysis, {
        same_file_warning: Boolean(error.payload.same_file_warning),
      });
      renderImportPreview(state.importPreview);
      toast("La base cambió durante la revisión. Revisa las advertencias actualizadas.", "error");
      return;
    }
    toast(error.message, "error");
    if (commitButton.isConnected) {
      commitButton.disabled = false;
      commitButton.textContent = originalLabel;
    }
  }
}

async function boot() {
  try {
    const session = await api("/api/me");
    if (session.user) showApp(session.user, session);
  } catch (error) {
    toast("No se pudo conectar con el servicio.", "error");
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    });
    const loaded = await showApp(result.user, result);
    if (loaded) toast("Sesión iniciada.", "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const button = formElement.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
        department: form.get("department"),
      }),
    });
    formElement.reset();
    setAuthMode("login");
    toast(result.message, "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$$("[data-show-register]").forEach((button) => button.addEventListener("click", async () => {
  try {
    if (!state.departments.length) {
      const data = await api("/api/departments");
      state.departments = data.departments || [];
      populateDepartmentOptions(state.departments);
    }
    setAuthMode("register");
  } catch (error) {
    toast(error.message, "error");
  }
}));
$$("[data-show-login]").forEach((button) => button.addEventListener("click", () => setAuthMode("login")));

$("#logout-button").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch (_) {}
  showAuth();
});

$$(".nav-item").forEach((button) => button.addEventListener("click", () => {
  const view = button.dataset.view;
  if (state.currentView === "overview" && !readPeriodControls("global")) return;
  else if (state.currentView === "department" && !readPeriodControls("detail")) return;
  syncPeriodControls();
  state.currentView = view;
  updateNav();
  if (view === "overview") loadGlobalReport();
  if (view === "department") {
    if (state.user.role === "department") state.selectedDepartment = state.user.department_name;
    if (state.user.role === "treasurer") state.selectedDepartment = $("#detail-department").value || null;
    $("#department-title").textContent = state.selectedDepartment || "Todos los departamentos";
    state.transactionPage = 1;
    state.transactionLoaded = 0;
    state.transactionCursor = null;
    loadDepartmentReport();
  }
  if (view === "admin") openAdminTab(state.adminTab);
}));

$("#global-filter-button").addEventListener("click", loadGlobalReport);
$("#global-department").addEventListener("change", loadGlobalReport);
$("#global-year").addEventListener("change", () => {
  state.period.preset = "custom";
  state.globalSearchCursor = null;
  state.globalSearchLoaded = 0;
  loadGlobalReport();
});
$("#detail-year").addEventListener("change", () => {
  state.period.preset = "custom";
  state.transactionPage = 1;
  state.transactionLoaded = 0;
  state.transactionCursor = null;
  loadDepartmentReport();
});
$$("[data-period-view][data-period-preset]").forEach((button) => {
  button.addEventListener("click", () => applyPeriodPreset(button.dataset.periodView, button.dataset.periodPreset));
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".month-selector")) {
    $$(".month-selector[open]").forEach((selector) => { selector.open = false; });
  }
  const monthButton = event.target.closest("[data-month-view][data-month-option]");
  const monthAction = event.target.closest("[data-month-view][data-month-action]");
  const prefix = (monthButton || monthAction || {}).dataset && (monthButton || monthAction).dataset.monthView;
  if (!prefix) return;
  state.period.preset = "custom";
  if (monthButton) {
    const pressed = monthButton.getAttribute("aria-pressed") === "true";
    monthButton.setAttribute("aria-pressed", pressed ? "false" : "true");
  } else {
    const selectAll = monthAction.dataset.monthAction === "all";
    $$("[data-month-option]", $("#" + prefix + "-month-options")).forEach((option) => option.setAttribute("aria-pressed", selectAll ? "true" : "false"));
  }
  if (prefix === "global") {
    window.clearTimeout(state.globalFilterTimer);
    state.globalFilterTimer = window.setTimeout(() => loadGlobalReport(), 180);
  }
  else {
    state.transactionPage = 1;
    state.transactionLoaded = 0;
    state.transactionCursor = null;
    window.clearTimeout(state.detailFilterTimer);
    state.detailFilterTimer = window.setTimeout(() => loadDepartmentReport(), 180);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#movement-review-panel").hidden) {
    resetMaintenance();
    return;
  }
  if (event.key === "Escape") $$(".month-selector[open]").forEach((selector) => { selector.open = false; });
});
$("#global-start").addEventListener("change", () => { state.period.preset = "custom"; });
$("#global-end").addEventListener("change", () => { state.period.preset = "custom"; });
$("#detail-start").addEventListener("change", () => { state.period.preset = "custom"; });
$("#detail-end").addEventListener("change", () => { state.period.preset = "custom"; });
$("#global-search").addEventListener("input", () => {
  if (state.globalReport) renderDepartmentRows(state.globalReport);
  state.globalSearchRequest += 1;
  if (state.globalSearchController) state.globalSearchController.abort();
  state.globalSearchPage = 1;
  state.globalSearchLoaded = 0;
  state.globalSearchCursor = null;
  window.clearTimeout(state.globalSearchTimer);
  if (!$("#global-search").value.trim()) {
    $("#global-search-panel").hidden = true;
    return;
  }
  $("#global-search-panel").hidden = false;
  $("#global-search-list").innerHTML = '<div class="loading">Buscando movimientos…</div>';
  $("#global-search-more").disabled = true;
  $("#global-search-more").hidden = true;
  state.globalSearchTimer = window.setTimeout(() => loadGlobalSearch(), 220);
});
$("#detail-filter-button").addEventListener("click", () => {
  state.transactionPage = 1;
  state.transactionLoaded = 0;
  state.transactionCursor = null;
  state.detailFilterDirty = false;
  loadDepartmentReport();
});
$("#detail-start").addEventListener("change", () => {
  state.detailFilterDirty = true;
  state.transactionLoaded = 0;
  state.transactionCursor = null;
  $("#load-more-button").disabled = true;
});
$("#detail-end").addEventListener("change", () => {
  state.detailFilterDirty = true;
  state.transactionLoaded = 0;
  state.transactionCursor = null;
  $("#load-more-button").disabled = true;
});
$("#detail-department").addEventListener("change", () => {
  state.selectedDepartment = $("#detail-department").value || null;
  $("#department-title").textContent = state.selectedDepartment || "Todos los departamentos";
  state.transactionPage = 1;
  state.transactionLoaded = 0;
  state.transactionCursor = null;
  loadDepartmentReport();
});
$("#detail-search").addEventListener("input", () => {
  state.transactionRequest += 1;
  if (state.transactionController) state.transactionController.abort();
  window.clearTimeout(state.detailSearchTimer);
  state.transactionPage = 1;
  state.transactionLoaded = 0;
  state.transactionCursor = null;
  $("#load-more-button").disabled = true;
  state.detailSearchTimer = window.setTimeout(() => loadDepartmentReport(false, false), 220);
});
$("#load-more-button").addEventListener("click", () => {
  if (!state.transactionLoading && !state.detailFilterDirty && state.transactionCursor) {
    loadDepartmentReport(true);
  }
});
$("#global-search-more").addEventListener("click", () => {
  if (!state.globalSearchLoading && state.globalSearchCursor) loadGlobalSearch(true);
});

$$(".export-button").forEach((button) => button.addEventListener("click", () => {
  exportReport(button.dataset.format, button.dataset.view);
}));
$$(".admin-tab").forEach((button) => button.addEventListener("click", () => openAdminTab(button.dataset.adminTab)));
$("#users-search").addEventListener("input", renderAdminUsers);
$("#audit-filter-button").addEventListener("click", () => loadAudit().catch((error) => toast(error.message, "error")));
for (const id of ["audit-start", "audit-end", "audit-department", "audit-user", "audit-search"]) {
  $("#" + id).addEventListener("input", () => {
    if (state.auditController) state.auditController.abort();
    state.auditRequest++;
    state.auditCursor = null;
    $("#audit-more").hidden = true;
    $("#audit-count").textContent = "";
    $("#audit-list").innerHTML = '<p class="muted">Pulsa Consultar para aplicar estos filtros.</p>';
  });
}
$("#audit-export").addEventListener("click", async () => {
  const button = $("#audit-export"); button.disabled = true;
  try {
    const params = auditParams(); params.set("format", "csv");
    const response = await fetch("/api/admin/audit?" + params);
    if (!response.ok) throw new Error((await response.json()).error || "No se pudo exportar.");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = url; link.download = "actividad.csv"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
});
function maintenanceButton(kind, id) {
  if (state.user?.role !== "treasurer" || kind !== "movement") return "";
  return '<button class="text-button maintenance-link" type="button" data-maintenance-id="' + Number(id) + '">Revisar #' + Number(id) + '</button>';
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-maintenance-id]");
  if (!button || state.user?.role !== "treasurer") return;
  resetMaintenance(false);
  maintenanceReturnFocus = button;
  const selection = {kind: "movement", id: Number(button.dataset.maintenanceId)};
  const modal = $("#movement-review-panel");
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  $("#maintenance-loading").hidden = false;
  try {
    const result = await api("/api/superuser/record", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({...selection, action: "preview"})});
    maintenanceSelection = {...selection, fingerprint: result.fingerprint};
    renderMaintenanceRecord(result.record);
    $("#maintenance-loading").hidden = true;
    $("#maintenance-result").hidden = false;
    $("#maintenance-back-detail").focus();
  } catch (error) {
    resetMaintenance();
    toast(error.message, "error");
  }
});
let maintenanceSelection = null;
let maintenanceReturnFocus = null;
function resetMaintenance(restoreFocus = true) {
  maintenanceSelection = null;
  const modal = $("#movement-review-panel");
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  $("#maintenance-loading").hidden = true;
  $("#maintenance-result").hidden = true;
  $("#maintenance-password").value = "";
  const returnFocus = maintenanceReturnFocus;
  maintenanceReturnFocus = null;
  if (restoreFocus && returnFocus && returnFocus.isConnected) returnFocus.focus();
}
$("#movement-review-panel").addEventListener("click", (event) => {
  if (event.target.closest("[data-review-close]")) resetMaintenance();
});
function renderMaintenanceRecord(record) {
  const labels = {id: "ID", batch_id: "Lote", source_row: "Fila de origen", department_id: "Código de departamento", department_name: "Departamento", opening_balance: "Saldo inicial", movement_type_number: "Código de movimiento", movement_type: "Tipo", movement_date: "Fecha contable", event_date: "Fecha del evento", amount: "Importe", description: "Glosa", base_person_id: "Código de persona", server_id: "Código de servidor", donor_name: "Aportante", currency: "Moneda", total_by_currency: "Total por moneda", observations: "Observaciones", email: "Correo", role: "Rol", status: "Estado", created_at: "Creación", approved_at: "Aprobación", user_id: "ID de usuario", event_type: "Acción", detail: "Detalle"};
  $("#maintenance-record").textContent = Object.entries(record).map(([key, value]) => {
    const shown = ["amount", "opening_balance", "total_by_currency"].includes(key) && value != null ? money(value) : value ?? "—";
    return (labels[key] || key) + ": " + shown;
  }).join("\n");
  const canDelete = Boolean(state.user?.is_superuser);
  $("#maintenance-delete-controls").hidden = !canDelete;
  $("#maintenance-readonly-note").hidden = canDelete;
}
$("#maintenance-delete").addEventListener("click", async () => {
  if (!maintenanceSelection || !window.confirm("¿Eliminar permanentemente el registro revisado?")) return;
  const button = $("#maintenance-delete"); button.disabled = true;
  try {
    const result = await api("/api/superuser/record", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({...maintenanceSelection, action: "delete", password: $("#maintenance-password").value})});
    resetMaintenance();
    state.globalReport = null;
    state.globalQueryKey = null;
    state.detailReport = null;
    state.detailQueryKey = null;
    state.detailFilterDirty = true;
    toast(result.message, "success");
  } catch (error) { toast(error.message, "error"); }
  finally { $("#maintenance-password").value = ""; button.disabled = false; }
});
$("#audit-more").addEventListener("click", () => {
  if (state.auditCursor) loadAudit(true).catch((error) => toast(error.message, "error"));
});
$("#import-form").addEventListener("submit", submitImport);

window.addEventListener("resize", () => {
  if (state.globalReport && state.currentView === "overview") {
    renderChart($("#global-chart"), state.globalReport.monthly);
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

boot();
