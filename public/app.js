const state = {
  user: null,
  departments: [],
  dateRange: null,
  period: { start: "", end: "", year: "", months: [], preset: "all" },
  globalReport: null,
  detailReport: null,
  selectedDepartment: null,
  transactionPage: 1,
  transactionPages: 1,
  transactionTotal: 0,
  transactionLoading: false,
  transactionRequest: 0,
  globalReportRequest: 0,
  detailSearchTimer: null,
  globalSearchTimer: null,
  globalSearchRequest: 0,
  globalSearchPage: 1,
  globalSearchPages: 1,
  globalSearchLoading: false,
  auditSearchTimer: null,
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

function showApp(user, metadata) {
  state.user = user;
  state.departments = metadata.departments || [];
  state.dateRange = metadata.dateRange;
  state.selectedDepartment = user.role === "department" ? user.department_name : null;
  $("#auth-screen").hidden = true;
  $("#app-shell").hidden = false;
  $("#user-badge").textContent = user.role === "treasurer"
    ? user.email + " · Tesorero"
    : user.email;
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
  loadGlobalReport();
}

function showAuth() {
  state.user = null;
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
  if (!period) return;
  const requestId = ++state.globalReportRequest;
  const department = state.user.role === "treasurer" ? $("#global-department").value : "";
  const query = period + (department ? "&department=" + encodeURIComponent(department) : "");
  $("#global-metrics").innerHTML = '<div class="loading">Actualizando balance…</div>';
  try {
    const report = await api("/api/summary?" + query);
    if (requestId !== state.globalReportRequest) return;
    state.globalReport = report;
    renderMetrics($("#global-metrics"), report);
    updateBalanceNote(report);
    renderChart($("#global-chart"), report.monthly);
    renderDepartmentRows(report);
    if ($("#global-search").value.trim()) loadGlobalSearch();
  } catch (error) {
    if (requestId !== state.globalReportRequest) return;
    toast(error.message, "error");
    if (error.status === 401) showAuth();
  }
}

async function loadGlobalSearch(append = false) {
  const search = $("#global-search").value.trim();
  if (!search) {
    $("#global-search-panel").hidden = true;
    return;
  }
  const period = periodQuery("global");
  if (!period) return;
  const page = append ? state.globalSearchPage + 1 : 1;
  const requestId = ++state.globalSearchRequest;
  const department = state.user.role === "treasurer" ? $("#global-department").value : "";
  const query = period + "&page=" + page + "&q=" + encodeURIComponent(search) +
    (department ? "&department=" + encodeURIComponent(department) : "");
  const panel = $("#global-search-panel");
  panel.hidden = false;
  state.globalSearchLoading = true;
  $("#global-search-more").disabled = true;
  if (append) $("#global-search-more").textContent = "Cargando…";
  else $("#global-search-list").innerHTML = '<div class="loading">Buscando movimientos…</div>';
  try {
    const pageData = await api("/api/transactions?" + query);
    if (requestId !== state.globalSearchRequest) return;
    state.globalSearchPage = pageData.page;
    state.globalSearchPages = pageData.pages;
    const loaded = Math.min(pageData.page * pageData.pageSize, pageData.total);
    $("#global-search-count").textContent = pageData.total.toLocaleString("es-CL") + " movimientos";
    $("#global-search-page-label").textContent = loaded.toLocaleString("es-CL") + " de " + pageData.total.toLocaleString("es-CL");
    $("#global-search-more").hidden = loaded >= pageData.total;
    const list = $("#global-search-list");
    if (!pageData.transactions.length) {
      list.innerHTML = '<div class="transaction-empty">Sin coincidencias para este período.</div>';
    } else {
      const markup = pageData.transactions.map(transactionRowHTML).join("");
      if (append) list.insertAdjacentHTML("beforeend", markup);
      else list.innerHTML = markup;
    }
  } catch (error) {
    if (requestId === state.globalSearchRequest) toast(error.message, "error");
  } finally {
    if (requestId === state.globalSearchRequest) {
      state.globalSearchLoading = false;
      $("#global-search-more").disabled = state.globalSearchPage >= state.globalSearchPages;
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
  updateNav();
  loadDepartmentReport();
}

function getDetailScope() {
  return state.user.role === "department" ? state.user.department_name : state.selectedDepartment;
}

function detailQuery() {
  const period = periodQuery("detail");
  if (!period) return null;
  const department = getDetailScope();
  return period + "&view=department" + (department ? "&department=" + encodeURIComponent(department) : "");
}

async function loadDepartmentReport(append = false, refreshSummary = true) {
  if (append && state.detailFilterDirty) return;
  const query = detailQuery();
  if (!query) return;
  if (!append) state.detailFilterDirty = false;
  const requestedPage = append ? state.transactionPage + 1 : 1;
  const requestId = ++state.transactionRequest;
  const search = $("#detail-search").value.trim();
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
    const summaryPromise = append || (!refreshSummary && state.detailReport) ? Promise.resolve(state.detailReport) : api("/api/summary?" + query);
    const transactionQuery = query + "&page=" + requestedPage + (search ? "&q=" + encodeURIComponent(search) : "");
    const transactionPromise = api("/api/transactions?" + transactionQuery);
    const results = await Promise.all([summaryPromise, transactionPromise]);
    if (requestId !== state.transactionRequest) return;
    const report = results[0];
    const pageData = results[1];
    state.detailReport = report;
    state.transactionPage = pageData.page;
    state.transactionPages = pageData.pages;
    state.transactionTotal = pageData.total;
    renderMetrics($("#detail-metrics"), report);
    renderTransactions(pageData, append);
  } catch (error) {
    if (requestId !== state.transactionRequest) return;
    toast(error.message, "error");
    if (error.status === 401) showAuth();
  } finally {
    if (requestId === state.transactionRequest) {
      state.transactionLoading = false;
      button.disabled = state.detailFilterDirty || state.transactionPage >= state.transactionPages;
      button.textContent = "Mostrar más";
    }
  }
}

function renderTransactions(pageData, append = false) {
  const search = $("#detail-search").value.trim();
  $("#transaction-count").textContent = pageData.total.toLocaleString("es-CL") + (search ? " coincidencias" : " movimientos");
  const loaded = Math.min(pageData.page * pageData.pageSize, pageData.total);
  $("#page-label").textContent = loaded.toLocaleString("es-CL") + " de " + pageData.total.toLocaleString("es-CL") + " movimientos";
  $("#load-more-button").hidden = loaded >= pageData.total;
  $("#load-more-button").disabled = state.detailFilterDirty || loaded >= pageData.total;
  const container = $("#transaction-list");
  if (!pageData.transactions.length) {
    if (!append) container.innerHTML = '<div class="transaction-empty">' + (search ? "Sin coincidencias para la búsqueda." : "No hay movimientos para este período.") + '</div>';
    return;
  }
  const markup = pageData.transactions.map(transactionRowHTML).join("");
  if (append) container.insertAdjacentHTML("beforeend", markup);
  else container.innerHTML = markup;
}

function transactionRowHTML(row) {
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
      '<small>Saldo corrido ' + money(row.running_balance) + '</small></div>' +
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

async function loadAudit() {
  const params = new URLSearchParams();
  if ($("#audit-start").value) params.set("start", $("#audit-start").value);
  if ($("#audit-end").value) params.set("end", $("#audit-end").value);
  if ($("#audit-department").value) params.set("department", $("#audit-department").value);
  if ($("#audit-search").value.trim()) params.set("q", $("#audit-search").value.trim());
  const data = await api("/api/admin/audit?" + params.toString());
  $("#audit-list").innerHTML = data.events.map((row) => {
    let detail = {};
    try { detail = JSON.parse(row.detail || "{}"); } catch (_) {}
    const context = Object.entries(detail).map(([key, value]) => key + ": " + value).join(" · ");
    return '<div class="audit-row">' +
      '<span>' + escapeHTML(new Date(row.created_at).toLocaleString("es-CL")) + '</span>' +
      '<span class="audit-event">' + escapeHTML(auditLabel(row.event_type)) + '</span>' +
      '<span>' + escapeHTML(row.email || "Sistema") + (context ? " · " + escapeHTML(context) : "") + '</span>' +
      '</div>';
  }).join("") || '<div class="transaction-empty">No hay actividad registrada.</div>';
}

async function openAdminTab(tab) {
  state.adminTab = tab;
  $$(".admin-tab").forEach((button) => button.classList.toggle("is-active", button.dataset.adminTab === tab));
  $$(".admin-panel").forEach((panel) => { panel.hidden = panel.id !== "admin-" + tab + "-panel"; });
  try {
    if (tab === "users") await loadAdminUsers();
    if (tab === "audit") await loadAudit();
  } catch (error) {
    toast(error.message, "error");
  }
}

function exportReport(format, view) {
  const prefix = view === "department" ? "detail" : "global";
  const period = periodQuery(prefix);
  if (!period) return;
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
  const overlapItems = (preview.overlapping_batches || []).map((batch) =>
    '<li><strong>' + escapeHTML(batch.filename) + '</strong> · ' +
    shortDate(batch.start) + '–' + shortDate(batch.end) +
    ' <span class="muted">(se cruza ' + shortDate(batch.overlap_start) + '–' +
    shortDate(batch.overlap_end) + ')</span></li>'
  ).join("");
  const samples = (preview.match_samples || []).map((row) =>
    '<article class="import-match-card">' +
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

  if (preview.same_file_warning) {
    html += '<div class="import-warning"><strong>Archivo ya incorporado</strong><br>' +
      'El contenido completo coincide con una carga anterior. Si corresponde, podrás confirmar su incorporación.</div>';
  }

  if (overlapCount) {
    html += '<div class="import-warning"><strong>Períodos superpuestos: ' +
      overlapCount.toLocaleString("es-CL") + ' carga' + (overlapCount === 1 ? "" : "s") +
      '</strong><br>Compartir fechas no significa que los movimientos sean iguales. Revisa las cargas y las coincidencias antes de continuar.' +
      '<ul class="import-overlap-list">' + overlapItems + '</ul>' +
      (preview.overlaps_truncated ? '<small>Se muestran las 8 cargas más recientes con fechas compartidas.</small>' : "") +
      '</div>' +
      '<label class="import-confirm"><input id="confirm-import-overlap" type="checkbox">' +
      '<span>Revisé los períodos y confirmo incorporar el archivo completo.</span></label>';
  } else {
    html += '<div class="import-clear">No hay períodos superpuestos con cargas anteriores.</div>';
  }

  if (matchCount) {
    html += '<div class="import-warning"><strong>Filas para revisar</strong><ul class="import-match-counts">' +
      (exactCount ? '<li>' + exactCount.toLocaleString("es-CL") + ' coincidencia' + (exactCount === 1 ? "" : "s") +
      ' en todos los campos contables conservados.</li>' : "") +
      (similarCount ? '<li>' + similarCount.toLocaleString("es-CL") +
      ' posible' + (similarCount === 1 ? "" : "s") + ' coincidencia' + (similarCount === 1 ? "" : "s") +
      ' en los demás campos; revisar DEPARTMENT_ID.</li>' : "") +
      (repeatCount ? '<li>' + repeatCount.toLocaleString("es-CL") +
      ' fila' + (repeatCount === 1 ? "" : "s") + ' idéntica' + (repeatCount === 1 ? "" : "s") +
      ' dentro del archivo.</li>' : "") + '</ul>' +
      '<details class="import-match-details"><summary>Revisar filas detectadas' +
      (preview.samples_truncated ? ' (primeras ' + (preview.match_samples || []).length + ')' : '') +
      '</summary><div class="import-match-list">' + samples + '</div>' +
      (preview.samples_truncated ? '<small>Hay más coincidencias que las mostradas. No se excluye ni elimina ninguna fila automáticamente.</small>' : '') +
      '</details></div>' +
      '<label class="import-confirm"><input id="confirm-import-matches" type="checkbox">' +
      '<span>Revisé las filas señaladas y confirmo incorporar todo el archivo, sin excluir movimientos.</span></label>';
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
    $("#commit-import").disabled = !overlapConfirmed || !matchesConfirmed;
  };
  [$("#confirm-import-overlap"), $("#confirm-import-matches")].filter(Boolean)
    .forEach((checkbox) => checkbox.addEventListener("change", updateButton));
  updateButton();
  $("#commit-import").addEventListener("click", commitImport);
}

async function commitImport() {
  if (!state.importPreview) return;
  const commitButton = $("#commit-import");
  if (!commitButton || commitButton.disabled) return;
  let confirmSame = false;
  if (state.importPreview.same_file_warning) {
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
        confirm_same_file: confirmSame,
        confirm_overlap: !state.importPreview.overlap_count || $("#confirm-import-overlap").checked,
        confirm_matches: !(state.importPreview.exact_matches || state.importPreview.similar_matches || state.importPreview.file_repeats) ||
          $("#confirm-import-matches").checked,
      }),
    });
    toast(result.message + " Se incorporaron " + result.rows.toLocaleString("es-CL") + " filas.", "success");
    state.importPreview = null;
    $("#import-preview").hidden = true;
    $("#import-form").reset();
    const metadata = await api("/api/me");
    state.departments = metadata.departments || [];
    state.dateRange = metadata.dateRange;
    populateDepartmentOptions(state.departments);
    loadGlobalReport();
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
    const departments = await api("/api/departments");
    state.departments = departments.departments || [];
    populateDepartmentOptions(state.departments);
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
    const metadata = await api("/api/me");
    showApp(result.user, metadata);
    toast("Sesión iniciada.", "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector("button[type=submit]");
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
    event.currentTarget.reset();
    setAuthMode("login");
    toast(result.message, "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$$("[data-show-register]").forEach((button) => button.addEventListener("click", () => setAuthMode("register")));
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
    loadDepartmentReport();
  }
  if (view === "admin") openAdminTab(state.adminTab);
}));

$("#global-filter-button").addEventListener("click", loadGlobalReport);
$("#global-department").addEventListener("change", loadGlobalReport);
$("#global-year").addEventListener("change", () => {
  state.period.preset = "custom";
  loadGlobalReport();
});
$("#detail-year").addEventListener("change", () => {
  state.period.preset = "custom";
  state.transactionPage = 1;
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
  if (prefix === "global") loadGlobalReport();
  else {
    state.transactionPage = 1;
    loadDepartmentReport();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") $$(".month-selector[open]").forEach((selector) => { selector.open = false; });
});
$("#global-start").addEventListener("change", () => { state.period.preset = "custom"; });
$("#global-end").addEventListener("change", () => { state.period.preset = "custom"; });
$("#detail-start").addEventListener("change", () => { state.period.preset = "custom"; });
$("#detail-end").addEventListener("change", () => { state.period.preset = "custom"; });
$("#global-search").addEventListener("input", () => {
  if (state.globalReport) renderDepartmentRows(state.globalReport);
  state.globalSearchRequest += 1;
  state.globalSearchPage = 1;
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
  state.detailFilterDirty = false;
  loadDepartmentReport();
});
$("#detail-start").addEventListener("change", () => {
  state.detailFilterDirty = true;
  $("#load-more-button").disabled = true;
});
$("#detail-end").addEventListener("change", () => {
  state.detailFilterDirty = true;
  $("#load-more-button").disabled = true;
});
$("#detail-department").addEventListener("change", () => {
  state.selectedDepartment = $("#detail-department").value || null;
  $("#department-title").textContent = state.selectedDepartment || "Todos los departamentos";
  state.transactionPage = 1;
  loadDepartmentReport();
});
$("#detail-search").addEventListener("input", () => {
  state.transactionRequest += 1;
  window.clearTimeout(state.detailSearchTimer);
  state.transactionPage = 1;
  $("#load-more-button").disabled = true;
  state.detailSearchTimer = window.setTimeout(() => loadDepartmentReport(false, false), 220);
});
$("#load-more-button").addEventListener("click", () => {
  if (!state.transactionLoading && !state.detailFilterDirty && state.transactionPage < state.transactionPages) {
    loadDepartmentReport(true);
  }
});
$("#global-search-more").addEventListener("click", () => {
  if (!state.globalSearchLoading && state.globalSearchPage < state.globalSearchPages) loadGlobalSearch(true);
});

$$(".export-button").forEach((button) => button.addEventListener("click", () => {
  exportReport(button.dataset.format, button.dataset.view);
}));
$$(".admin-tab").forEach((button) => button.addEventListener("click", () => openAdminTab(button.dataset.adminTab)));
$("#users-search").addEventListener("input", renderAdminUsers);
$("#audit-filter-button").addEventListener("click", () => loadAudit().catch((error) => toast(error.message, "error")));
$("#audit-start").addEventListener("change", () => loadAudit().catch((error) => toast(error.message, "error")));
$("#audit-end").addEventListener("change", () => loadAudit().catch((error) => toast(error.message, "error")));
$("#audit-department").addEventListener("change", () => loadAudit().catch((error) => toast(error.message, "error")));
$("#audit-search").addEventListener("input", () => {
  window.clearTimeout(state.auditSearchTimer);
  state.auditSearchTimer = window.setTimeout(() => loadAudit().catch((error) => toast(error.message, "error")), 220);
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
