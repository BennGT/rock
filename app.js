const storageKey = "marshal-data-v1";
const authTokenKey = "marshal-auth-token";
const legacyStorageKeys = ["shiftlink-demo-v1"];
const cloudApiPath = "/.netlify/functions/data";
const authApiPath = "/.netlify/functions/auth";

const state = {
  view: "dashboard",
  weekStart: startOfWeek(new Date()),
  editingShiftId: null,
  editingEmployeeId: null,
  copiedShift: null,
  deferredInstallPrompt: null,
  cloudStatus: "local",
  cloudSaveTimer: null,
  localChangedDuringCloudLoad: false,
  authToken: localStorage.getItem(authTokenKey),
  authUser: null,
  authUsers: [],
  setupRequired: false,
  data: loadData(),
};

const views = {
  dashboard: "Today",
  schedule: "Schedule",
  messages: "Messages",
  staff: "Staff",
  setup: "Setup",
};

const areaColors = {
  General: "#276ef1",
  Landscaping: "#087f72",
  Maintenance: "#9a6700",
  Construction: "#b42318",
  Admin: "#6b7280",
};

const appView = document.querySelector("#appView");
const viewTitle = document.querySelector("#viewTitle");
const todayLabel = document.querySelector("#todayLabel");
const brandFallback = document.querySelector("#brandFallback");
const brandName = document.querySelector("#brandName");
const brandSubtitle = document.querySelector("#brandSubtitle");
const userSelect = document.querySelector("#userSelect");
const saveStatus = document.querySelector("#saveStatus");
const accountStatus = document.querySelector("#accountStatus");
const signOutButton = document.querySelector("#signOutButton");
const installAppButton = document.querySelector("#installAppButton");
const notificationButton = document.querySelector("#notificationButton");
const backupFileInput = document.querySelector("#backupFileInput");
const authScreen = document.querySelector("#authScreen");
const authForm = document.querySelector("#authForm");
const authTitle = document.querySelector("#authTitle");
const authIntro = document.querySelector("#authIntro");
const authNameField = document.querySelector("#authNameField");
const authError = document.querySelector("#authError");
const authSubmitButton = document.querySelector("#authSubmitButton");
const shiftModal = document.querySelector("#shiftModal");
const shiftForm = document.querySelector("#shiftForm");
const deleteShiftButton = document.querySelector("#deleteShiftButton");
const employeeModal = document.querySelector("#employeeModal");
const employeeForm = document.querySelector("#employeeForm");
const deleteEmployeeButton = document.querySelector("#deleteEmployeeButton");

init();

function init() {
  todayLabel.textContent = formatLongDate(new Date());
  syncShell();
  syncSaveStatus();
  syncInstallButton();
  syncNotificationButton();
  hydrateUserSelect();
  registerServiceWorker();
  bindChrome();
  render();
  initAuth();
}

function bindChrome() {
  document.querySelector("#navTabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-view]");
    if (!tab) return;
    state.view = tab.dataset.view;
    render();
  });

  userSelect.addEventListener("change", () => {
    state.data.currentUserId = userSelect.value || null;
    saveData();
    render();
  });

  document.querySelector("#seedReset").addEventListener("click", () => {
    if (typeof confirm === "function" && !confirm("Clear all saved Marshal data? This will remove staff, schedules, messages, requests, setup changes, and hosted shared data.")) return;
    localStorage.removeItem(storageKey);
    legacyStorageKeys.forEach((key) => localStorage.removeItem(key));
    state.data = createSeedData();
    state.weekStart = startOfWeek(new Date());
    syncShell();
    hydrateUserSelect();
    saveData();
    render();
  });

  backupFileInput.addEventListener("change", importBackup);
  authForm.addEventListener("submit", submitAuth);
  signOutButton.addEventListener("click", signOut);
  installAppButton.addEventListener("click", installApp);
  notificationButton.addEventListener("click", requestNotifications);

  if (typeof window !== "undefined") {
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      state.deferredInstallPrompt = event;
      syncInstallButton();
    });

    window.addEventListener("appinstalled", () => {
      state.deferredInstallPrompt = null;
      state.data.appInstalled = true;
      saveData();
      syncInstallButton();
      syncSaveStatus("App installed");
    });
  }

  document.querySelector("#closeShiftModal").addEventListener("click", closeShiftModal);
  shiftModal.addEventListener("click", (event) => {
    if (event.target === shiftModal) closeShiftModal();
  });

  shiftForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state.data.employees.length) {
      syncSaveStatus("Add an employee before creating shifts", true);
      return;
    }

    const formData = new FormData(shiftForm);
    const shift = Object.fromEntries(formData.entries());
    shift.id = state.editingShiftId || crypto.randomUUID();
    const isNew = !state.editingShiftId;

    const existingIndex = state.data.shifts.findIndex((item) => item.id === shift.id);
    if (existingIndex >= 0) {
      state.data.shifts[existingIndex] = shift;
    } else {
      state.data.shifts.push(shift);
    }

    saveData();
    notifyTeam(isNew ? "New shift saved" : "Shift updated", `${findEmployee(shift.employeeId).name}: ${formatDateShort(parseDateKey(shift.date))}, ${shift.start} to ${shift.end}`);
    closeShiftModal();
    render();
  });

  deleteShiftButton.addEventListener("click", () => {
    if (!state.editingShiftId) return;
    const shift = state.data.shifts.find((item) => item.id === state.editingShiftId);
    state.data.shifts = state.data.shifts.filter((shift) => shift.id !== state.editingShiftId);
    saveData();
    if (shift) notifyTeam("Shift removed", `${findEmployee(shift.employeeId).name}: ${formatDateShort(parseDateKey(shift.date))}`);
    closeShiftModal();
    render();
  });

  document.querySelector("#closeEmployeeModal").addEventListener("click", closeEmployeeModal);
  employeeModal.addEventListener("click", (event) => {
    if (event.target === employeeModal) closeEmployeeModal();
  });

  employeeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(employeeForm);
    const employee = Object.fromEntries(formData.entries());
    const isNew = !state.editingEmployeeId;
    employee.name = employee.name.trim();
    employee.initials = (employee.initials || makeInitials(employee.name)).trim().toUpperCase();
    employee.role = employee.role.trim();
    employee.phone = employee.phone.trim();
    employee.id = state.editingEmployeeId || crypto.randomUUID();

    const existingIndex = state.data.employees.findIndex((item) => item.id === employee.id);
    if (existingIndex >= 0) {
      state.data.employees[existingIndex] = employee;
    } else {
      state.data.employees.push(employee);
    }

    state.data.currentUserId = employee.id;
    saveData();
    notifyTeam(isNew ? "Employee added" : "Employee updated", `${employee.name} - ${employee.role}`);
    hydrateUserSelect();
    closeEmployeeModal();
    render();
  });

  deleteEmployeeButton.addEventListener("click", () => {
    if (!state.editingEmployeeId) return;
    const employee = findEmployee(state.editingEmployeeId);
    if (typeof confirm === "function" && !confirm(`Delete ${employee.name}? Their shifts, messages, and requests will also be removed.`)) return;
    state.data.employees = state.data.employees.filter((item) => item.id !== state.editingEmployeeId);
    state.data.shifts = state.data.shifts.filter((shift) => shift.employeeId !== state.editingEmployeeId);
    state.data.requests = state.data.requests.filter((request) => request.employeeId !== state.editingEmployeeId);
    state.data.messages = state.data.messages.filter((message) => message.employeeId !== state.editingEmployeeId);
    state.data.currentUserId = state.data.employees[0]?.id || null;
    saveData();
    notifyTeam("Employee removed", employee.name);
    hydrateUserSelect();
    closeEmployeeModal();
    render();
  });
}

function render() {
  document.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === state.view);
  });

  viewTitle.textContent = views[state.view];

  const renderer = {
    dashboard: renderDashboard,
    schedule: renderSchedule,
    messages: renderMessages,
    staff: renderStaff,
    setup: renderSetup,
  }[state.view];

  appView.innerHTML = renderer();
  bindViewEvents();
}

function bindViewEvents() {
  appView.querySelectorAll("[data-action='new-shift']").forEach((button) => {
    button.addEventListener("click", () => openShiftModal());
  });

  appView.querySelectorAll("[data-shift-id]").forEach((button) => {
    button.addEventListener("click", () => openShiftModal(button.dataset.shiftId));
  });

  appView.querySelectorAll("[data-copy-shift-id]").forEach((button) => {
    button.addEventListener("click", () => copyShift(button.dataset.copyShiftId));
  });

  appView.querySelectorAll("[data-paste-shift-date]").forEach((button) => {
    button.addEventListener("click", () => pasteShift(button.dataset.pasteShiftDate));
  });

  appView.querySelectorAll("[data-week]").forEach((button) => {
    button.addEventListener("click", () => {
      const step = Number(button.dataset.week);
      state.weekStart = addDays(state.weekStart, step * 7);
      render();
    });
  });

  appView.querySelectorAll("[data-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      state.data.activeChannel = button.dataset.channel;
      saveData();
      render();
    });
  });

  appView.querySelectorAll("[data-action='new-employee']").forEach((button) => {
    button.addEventListener("click", () => openEmployeeModal());
  });

  appView.querySelectorAll("[data-action='export-data']").forEach((button) => {
    button.addEventListener("click", exportBackup);
  });

  appView.querySelectorAll("[data-action='import-data']").forEach((button) => {
    button.addEventListener("click", () => backupFileInput.click());
  });

  appView.querySelectorAll("[data-action='install-app']").forEach((button) => {
    button.addEventListener("click", installApp);
  });

  appView.querySelectorAll("[data-action='enable-notifications']").forEach((button) => {
    button.addEventListener("click", requestNotifications);
  });

  appView.querySelectorAll("[data-action='test-notification']").forEach((button) => {
    button.addEventListener("click", () => notifyTeam("Marshal notifications are on", "Schedule and message alerts can appear on this device.", true));
  });

  appView.querySelectorAll("[data-delete-account-id]").forEach((button) => {
    button.addEventListener("click", () => deleteAccount(button.dataset.deleteAccountId));
  });

  appView.querySelectorAll("[data-employee-id]").forEach((button) => {
    button.addEventListener("click", () => openEmployeeModal(button.dataset.employeeId));
  });

  appView.querySelectorAll("[data-request-status]").forEach((select) => {
    select.addEventListener("change", () => {
      const request = state.data.requests.find((item) => item.id === select.dataset.requestStatus);
      if (!request) return;
      request.status = select.value;
      saveData();
      notifyTeam("Request updated", `${findEmployee(request.employeeId).name}: ${request.type} ${request.status}`);
      render();
    });
  });

  appView.querySelectorAll("[data-remove-area]").forEach((button) => {
    button.addEventListener("click", () => {
      const area = button.dataset.removeArea;
      if (isAreaInUse(area) || state.data.areas.length <= 1) return;
      state.data.areas = state.data.areas.filter((item) => item !== area);
      saveData();
      render();
    });
  });

  appView.querySelectorAll("[data-remove-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      const channelId = button.dataset.removeChannel;
      if (state.data.channels.length <= 1) return;
      const channel = state.data.channels.find((item) => item.id === channelId);
      if (!channel) return;
      if (typeof confirm === "function" && !confirm(`Delete ${channel.name}? Messages in this channel will also be removed.`)) return;
      state.data.channels = state.data.channels.filter((item) => item.id !== channelId);
      state.data.messages = state.data.messages.filter((message) => message.channel !== channelId);
      if (state.data.activeChannel === channelId) state.data.activeChannel = state.data.channels[0].id;
      saveData();
      notifyTeam("Channel removed", channel.name);
      render();
    });
  });

  const messageForm = appView.querySelector("#messageForm");
  if (messageForm) {
    messageForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!state.data.currentUserId) {
        syncSaveStatus("Add an employee before sending messages", true);
        return;
      }

      const input = messageForm.querySelector("input");
      const text = input.value.trim();
      if (!text) return;
      state.data.messages.push({
        id: crypto.randomUUID(),
        channel: state.data.activeChannel,
        employeeId: state.data.currentUserId,
        body: text,
        createdAt: new Date().toISOString(),
      });
      input.value = "";
      saveData();
      notifyTeam(`New message in ${getActiveChannel().name}`, text);
      render();
    });
  }

  const requestForm = appView.querySelector("#requestForm");
  if (requestForm) {
    requestForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!state.data.currentUserId) {
        syncSaveStatus("Add an employee before submitting requests", true);
        return;
      }

      const formData = new FormData(requestForm);
      state.data.requests.unshift({
        id: crypto.randomUUID(),
        employeeId: state.data.currentUserId,
        type: formData.get("type"),
        date: formData.get("date"),
        detail: formData.get("detail"),
        status: "Pending",
      });
      requestForm.reset();
      saveData();
      notifyTeam("Staff request submitted", `${getCurrentUser().name}: ${formData.get("type")}`);
      render();
    });
  }

  const profileForm = appView.querySelector("#profileForm");
  if (profileForm) {
    profileForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(profileForm);
      state.data.businessName = formData.get("businessName").trim() || "Marshal";
      state.data.businessSubtitle = formData.get("businessSubtitle").trim() || "Rock N Water Landscapes";
      saveData();
      syncShell();
      render();
    });
  }

  const areaForm = appView.querySelector("#areaForm");
  if (areaForm) {
    areaForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(areaForm);
      const area = formData.get("area").trim();
      if (!area || state.data.areas.includes(area)) return;
      state.data.areas.push(area);
      saveData();
      notifyTeam("Work area added", area);
      render();
    });
  }

  const channelForm = appView.querySelector("#channelForm");
  if (channelForm) {
    channelForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(channelForm);
      const name = formData.get("name").trim();
      if (!name) return;
      state.data.channels.push({
        id: uniqueSlug(name, state.data.channels.map((channel) => channel.id)),
        name,
        description: formData.get("description").trim() || "Team discussion",
      });
      saveData();
      notifyTeam("Channel added", name);
      render();
    });
  }

  appView.querySelectorAll("[data-channel-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const channel = state.data.channels.find((item) => item.id === form.dataset.channelForm);
      if (!channel) return;
      const formData = new FormData(form);
      channel.name = formData.get("name").trim() || channel.name;
      channel.description = formData.get("description").trim() || "Team discussion";
      saveData();
      notifyTeam("Channel updated", channel.name);
      render();
    });
  });

  const accountForm = appView.querySelector("#accountForm");
  if (accountForm) {
    accountForm.addEventListener("submit", createAccount);
  }
}

function renderDashboard() {
  const currentUser = getCurrentUser();
  const todayKey = toDateKey(new Date());
  const todayShifts = shiftsForDate(todayKey);
  const currentShift = currentUser.id ? todayShifts.find((shift) => shift.employeeId === currentUser.id) : null;
  const openShifts = state.data.shifts.filter((shift) => shift.status === "Open").length;
  const pendingRequests = state.data.requests.filter((request) => request.status === "Pending").length;
  const weekEnd = toDateKey(addDays(state.weekStart, 7));
  const weekShifts = state.data.shifts.filter((shift) => shift.date >= toDateKey(state.weekStart) && shift.date < weekEnd).length;

  return `
    <div class="dashboard-grid">
      <div>
        <div class="metric-grid">
          ${metric("On today", todayShifts.length, "Scheduled shifts")}
          ${metric("Open shifts", openShifts, "Need coverage")}
          ${metric("Pending", pendingRequests, "Staff requests")}
          ${metric("This week", weekShifts, "Published shifts")}
        </div>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">Today's roster</h2>
              <p class="panel-subtitle">${formatDateShort(new Date())}</p>
            </div>
            <button class="ghost-button" data-action="new-shift" type="button">Add shift</button>
          </div>
          <div class="panel-body shift-list">
            ${
              todayShifts.length
                ? todayShifts.map(renderShiftItem).join("")
                : `<div class="empty-state">No shifts scheduled today.</div>`
            }
          </div>
        </section>
      </div>

      <div class="shift-list">
        <section class="highlight-card">
          <div class="highlight-row">
            <div>
              <span class="highlight-label">My shift today</span>
              <h2>${currentUser.id ? currentUser.name : "No employee selected"}</h2>
              <p>${currentUser.id ? (currentShift ? `${currentShift.area}, ${currentShift.start} to ${currentShift.end}` : "No shift assigned today") : "Add employees from the Staff page."}</p>
            </div>
            ${currentShift ? statusPill(currentShift.status) : statusPill("Open")}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">Latest messages</h2>
              <p class="panel-subtitle">Announcements and operations</p>
            </div>
          </div>
          <div class="panel-body message-list">
            ${state.data.messages.slice(-4).reverse().map(renderCompactMessage).join("")}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">Requests</h2>
              <p class="panel-subtitle">Leave, availability, and swaps</p>
            </div>
          </div>
          <div class="panel-body request-list">
            ${state.data.requests.slice(0, 4).map(renderRequestItem).join("")}
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderSchedule() {
  const days = Array.from({ length: 7 }, (_, index) => addDays(state.weekStart, index));
  const rangeLabel = `${formatDateShort(days[0])} to ${formatDateShort(days[6])}`;
  const copiedEmployee = state.copiedShift ? findEmployee(state.copiedShift.employeeId) : null;

  return `
    <div class="schedule-layout">
      <div class="schedule-toolbar">
        <div class="segmented" aria-label="Week controls">
          <button data-week="-1" type="button">Previous</button>
          <button data-week="0" class="active" type="button">${rangeLabel}</button>
          <button data-week="1" type="button">Next</button>
        </div>
        <button class="primary-button" data-action="new-shift" type="button">New shift</button>
      </div>

      ${
        state.copiedShift
          ? `<div class="copy-banner">
              Copied ${copiedEmployee.name}, ${state.copiedShift.start} to ${state.copiedShift.end}. Choose Paste on a day.
            </div>`
          : ""
      }

      <div class="week-grid">
        ${days
          .map((day) => {
            const key = toDateKey(day);
            const dayShifts = shiftsForDate(key);
            return `
              <section class="day-column ${key === toDateKey(new Date()) ? "today" : ""}">
                <div class="day-head">
                  <div>
                    <strong>${formatWeekday(day)}</strong>
                    <span>${formatDateShort(day)}</span>
                  </div>
                  ${state.copiedShift ? `<button class="mini-button" data-paste-shift-date="${key}" type="button">Paste</button>` : ""}
                </div>
                <div class="day-shifts">
                  ${
                    dayShifts.length
                      ? dayShifts.map(renderScheduleShift).join("")
                      : `<div class="empty-state">Open day</div>`
                  }
                </div>
              </section>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderMessages() {
  const channels = state.data.channels;
  const activeChannel = state.data.activeChannel;
  const channel = channels.find((item) => item.id === activeChannel) || channels[0];
  const messages = state.data.messages.filter((message) => message.channel === channel.id);

  return `
    <section class="messages-layout">
      <div class="channel-list">
        ${channels
          .map(
            (item) => `
              <button class="channel-button ${item.id === activeChannel ? "active" : ""}" data-channel="${item.id}" type="button">
                ${item.name}
              </button>
            `,
          )
          .join("")}
      </div>
      <div class="thread">
        <div class="thread-head">
          <h2>${channel.name}</h2>
          <p>${channel.description}</p>
        </div>
        <div class="message-list">
          ${messages.length ? messages.map(renderMessage).join("") : `<div class="empty-state">No messages yet.</div>`}
        </div>
        <form class="message-compose" id="messageForm">
          <input type="text" placeholder="${state.data.currentUserId ? "Write a message" : "Add an employee before messaging"}" aria-label="Message" autocomplete="off" ${state.data.currentUserId ? "" : "disabled"} />
          <button class="primary-button" type="submit" ${state.data.currentUserId ? "" : "disabled"}>Send</button>
        </form>
      </div>
    </section>
  `;
}

function renderStaff() {
  return `
    <div class="staff-layout">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Staff requests</h2>
            <p class="panel-subtitle">Create availability notes or leave requests</p>
          </div>
        </div>
        <div class="panel-body">
          <form class="form-stack" id="requestForm">
            <label>
              Type
              <select name="type">
                <option value="Leave">Leave</option>
                <option value="Availability">Availability</option>
                <option value="Shift swap">Shift swap</option>
              </select>
            </label>
            <label>
              Date
              <input name="date" type="date" required />
            </label>
            <label>
              Detail
              <textarea name="detail" rows="4" required placeholder="Add the request details"></textarea>
            </label>
            <button class="primary-button" type="submit">Submit request</button>
          </form>
          <div class="section-gap request-list">
            ${state.data.requests.length ? state.data.requests.map((request) => renderRequestItem(request, true)).join("") : `<div class="empty-state">No staff requests yet.</div>`}
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Team directory</h2>
            <p class="panel-subtitle">${state.data.employees.length} employees</p>
          </div>
          <button class="ghost-button" data-action="new-employee" type="button">Add employee</button>
        </div>
        <div class="panel-body staff-list">
          ${state.data.employees.length ? state.data.employees.map(renderStaffItem).join("") : `<div class="empty-state">No employees yet. Add your first employee to start building the roster.</div>`}
        </div>
      </section>
    </div>
  `;
}

function renderSetup() {
  return `
    <div class="setup-layout">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Business details</h2>
            <p class="panel-subtitle">These labels appear in the sidebar and browser tab</p>
          </div>
        </div>
        <div class="panel-body">
          <form class="form-stack" id="profileForm">
            <label>
              App or business name
              <input name="businessName" type="text" value="${escapeHtml(state.data.businessName)}" required />
            </label>
            <label>
              Sidebar subtitle
              <input name="businessSubtitle" type="text" value="${escapeHtml(state.data.businessSubtitle)}" required />
            </label>
            <button class="primary-button" type="submit">Save details</button>
          </form>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Work areas</h2>
            <p class="panel-subtitle">Areas feed shift locations</p>
          </div>
        </div>
        <div class="panel-body">
          <form class="inline-form" id="areaForm">
            <input name="area" type="text" placeholder="Add area" aria-label="Area name" />
            <button class="primary-button" type="submit">Add</button>
          </form>
          <div class="config-list">
            ${state.data.areas.map(renderAreaRow).join("")}
          </div>
        </div>
      </section>

      <section class="panel wide-panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Message channels</h2>
            <p class="panel-subtitle">Edit channel names or add a new team thread</p>
          </div>
        </div>
        <div class="panel-body">
          <form class="inline-form" id="channelForm">
            <input name="name" type="text" placeholder="Channel name" aria-label="Channel name" />
            <input name="description" type="text" placeholder="Channel description" aria-label="Channel description" />
            <button class="primary-button" type="submit">Add</button>
          </form>
          <div class="config-list">
            ${state.data.channels.map(renderChannelRow).join("")}
          </div>
        </div>
      </section>

      <section class="panel wide-panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Data backup</h2>
            <p class="panel-subtitle">Changes autosave in this browser; export a backup when you want a copy</p>
          </div>
        </div>
        <div class="panel-body backup-actions">
          <button class="primary-button" data-action="export-data" type="button">Export backup</button>
          <button class="ghost-button" data-action="import-data" type="button">Import backup</button>
        </div>
      </section>

      <section class="panel wide-panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Phone app and alerts</h2>
            <p class="panel-subtitle">Install Marshal on a phone and enable browser notifications</p>
          </div>
        </div>
        <div class="panel-body backup-actions">
          <button class="primary-button" data-action="install-app" type="button">Install app</button>
          <button class="ghost-button" data-action="enable-notifications" type="button">Enable notifications</button>
          <button class="ghost-button" data-action="test-notification" type="button">Send test</button>
        </div>
      </section>

      ${
        state.authUser?.role === "admin"
          ? `<section class="panel wide-panel">
              <div class="panel-head">
                <div>
                  <h2 class="panel-title">Login accounts</h2>
                  <p class="panel-subtitle">Create email and password access for employees</p>
                </div>
              </div>
              <div class="panel-body">
                <form class="inline-form account-form" id="accountForm">
                  <input name="name" type="text" placeholder="Name" aria-label="Name" required />
                  <input name="email" type="email" placeholder="Email" aria-label="Email" required />
                  <input name="password" type="password" placeholder="Password" aria-label="Password" minlength="8" required />
                  <select name="role" aria-label="Role">
                    <option value="employee">Employee</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button class="primary-button" type="submit">Add account</button>
                </form>
                <div class="config-list">
                  ${state.authUsers.length ? state.authUsers.map(renderAccountRow).join("") : `<div class="empty-state">No login accounts loaded.</div>`}
                </div>
              </div>
            </section>`
          : ""
      }
    </div>
  `;
}

function renderShiftItem(shift) {
  const employee = findEmployee(shift.employeeId);
  return `
    <button class="shift-item" data-shift-id="${shift.id}" type="button">
      <div class="shift-main">
        <div class="person-line">
          <span class="avatar">${employee.initials}</span>
          <div>
            <strong>${employee.name}</strong>
            <span>${shift.area}</span>
          </div>
        </div>
        ${statusPill(shift.status)}
      </div>
      <div class="shift-meta">
        <span>${shift.start} to ${shift.end}</span>
        ${shift.notes ? `<span>${escapeHtml(shift.notes)}</span>` : ""}
      </div>
    </button>
  `;
}

function renderScheduleShift(shift) {
  const employee = findEmployee(shift.employeeId);
  const className = shift.status.toLowerCase();
  return `
    <article class="schedule-shift ${className}" style="border-left-color: ${areaColors[shift.area] || "#276ef1"}">
      <div class="schedule-shift-head">
        <strong>${shift.start} to ${shift.end}</strong>
        ${statusPill(shift.status)}
      </div>
      <span>${employee.name}</span>
      <span>${shift.area}</span>
      <div class="shift-card-actions">
        <button class="ghost-button" data-shift-id="${shift.id}" type="button">Edit</button>
        <button class="ghost-button" data-copy-shift-id="${shift.id}" type="button">Copy</button>
      </div>
    </article>
  `;
}

function renderCompactMessage(message) {
  const employee = findEmployee(message.employeeId);
  return `
    <article class="message-item">
      <div class="message-head">
        <span>${employee.name}</span>
        <span>${formatTime(message.createdAt)}</span>
      </div>
      <p>${escapeHtml(message.body)}</p>
    </article>
  `;
}

function renderMessage(message) {
  const employee = findEmployee(message.employeeId);
  return `
    <article class="message-item ${message.employeeId === state.data.currentUserId ? "own" : ""}">
      <div class="message-head">
        <span>${employee.name}</span>
        <span>${formatMessageDate(message.createdAt)}</span>
      </div>
      <p>${escapeHtml(message.body)}</p>
    </article>
  `;
}

function renderRequestItem(request, editable = false) {
  const employee = findEmployee(request.employeeId);
  return `
    <article class="request-item">
      <div class="request-main">
        <div>
          <strong>${request.type}</strong>
          <div class="request-meta">${employee.name} - ${formatDateShort(parseDateKey(request.date))}</div>
        </div>
        ${
          editable
            ? `<select class="compact-select" data-request-status="${request.id}" aria-label="Request status">
                ${["Pending", "Approved", "Declined"].map((status) => `<option value="${status}" ${status === request.status ? "selected" : ""}>${status}</option>`).join("")}
              </select>`
            : statusPill(request.status)
        }
      </div>
      ${request.detail ? `<div class="request-meta">${escapeHtml(request.detail)}</div>` : ""}
    </article>
  `;
}

function renderStaffItem(employee) {
  const nextShift = state.data.shifts
    .filter((shift) => shift.employeeId === employee.id && shift.date >= toDateKey(new Date()))
    .sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`))[0];

  return `
    <article class="staff-item">
      <div class="staff-main">
        <div class="person-line">
          <span class="avatar">${employee.initials}</span>
          <div>
            <strong>${employee.name}</strong>
            <span>${employee.role}</span>
          </div>
        </div>
        ${statusPill(employee.status)}
      </div>
      <div class="staff-meta">
        <span>${employee.phone || "No phone saved"}</span>
      </div>
      <div class="staff-meta">
        <span>${nextShift ? `${formatDateShort(parseDateKey(nextShift.date))}, ${nextShift.start}` : "No upcoming shift"}</span>
      </div>
      <div class="staff-actions">
        <button class="ghost-button" data-employee-id="${employee.id}" type="button">Edit</button>
      </div>
    </article>
  `;
}

function renderAreaRow(area) {
  const usage = areaUsage(area);
  const locked = usage || state.data.areas.length <= 1;
  return `
    <div class="config-row">
      <div>
        <strong>${escapeHtml(area)}</strong>
        <span>${usage ? `${usage} linked item${usage === 1 ? "" : "s"}` : "Not in use"}</span>
      </div>
      <button class="ghost-button" data-remove-area="${escapeHtml(area)}" type="button" ${locked ? "disabled" : ""}>Remove</button>
    </div>
  `;
}

function renderChannelRow(channel) {
  return `
    <form class="config-row channel-row" data-channel-form="${channel.id}">
      <label>
        Name
        <input name="name" type="text" value="${escapeHtml(channel.name)}" required />
      </label>
      <label>
        Description
        <input name="description" type="text" value="${escapeHtml(channel.description)}" />
      </label>
      <div class="row-actions">
        <button class="ghost-button" type="submit">Save</button>
        <button class="ghost-button" data-remove-channel="${channel.id}" type="button" ${state.data.channels.length <= 1 ? "disabled" : ""}>Remove</button>
      </div>
    </form>
  `;
}

function renderAccountRow(user) {
  return `
    <div class="config-row account-row">
      <div>
        <strong>${escapeHtml(user.name)}</strong>
        <span>${escapeHtml(user.email)} - ${user.role}</span>
      </div>
      <button class="ghost-button" data-delete-account-id="${user.id}" type="button" ${user.id === state.authUser?.id ? "disabled" : ""}>Remove</button>
    </div>
  `;
}

function metric(label, value, caption) {
  return `
    <article class="metric">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${caption}</small>
    </article>
  `;
}

function statusPill(status) {
  const className = status.toLowerCase().replace(/\s+/g, "-");
  return `<span class="pill ${className}">${status}</span>`;
}

function openShiftModal(shiftId = null) {
  if (!state.data.employees.length) {
    state.view = "staff";
    syncSaveStatus("Add an employee before creating shifts", true);
    render();
    return;
  }

  state.editingShiftId = shiftId;
  const shift = shiftId
    ? state.data.shifts.find((item) => item.id === shiftId)
    : {
        employeeId: state.data.currentUserId,
        date: toDateKey(new Date()),
        start: "09:00",
        end: "17:00",
        area: state.data.areas[0],
        status: "Confirmed",
        notes: "",
      };

  document.querySelector("#shiftModalTitle").textContent = shiftId ? "Edit shift" : "New shift";
  shiftForm.elements.employeeId.innerHTML = state.data.employees
    .map((employee) => `<option value="${employee.id}">${employee.name}</option>`)
    .join("");
  shiftForm.elements.area.innerHTML = state.data.areas
    .map((area) => `<option value="${escapeHtml(area)}">${escapeHtml(area)}</option>`)
    .join("");

  Object.entries(shift).forEach(([key, value]) => {
    if (shiftForm.elements[key]) shiftForm.elements[key].value = value;
  });

  deleteShiftButton.classList.toggle("hidden", !shiftId);
  shiftModal.classList.remove("hidden");
  shiftForm.elements.employeeId.focus();
}

function closeShiftModal() {
  shiftModal.classList.add("hidden");
  state.editingShiftId = null;
  shiftForm.reset();
}

function copyShift(shiftId) {
  const shift = state.data.shifts.find((item) => item.id === shiftId);
  if (!shift) return;

  state.copiedShift = {
    employeeId: shift.employeeId,
    start: shift.start,
    end: shift.end,
    area: shift.area,
    status: shift.status,
    notes: shift.notes || "",
  };

  const employee = findEmployee(shift.employeeId);
  syncSaveStatus(`Copied ${employee.name} shift`);
  render();
}

function pasteShift(date) {
  if (!state.copiedShift) return;

  const pastedShift = {
    ...state.copiedShift,
    id: crypto.randomUUID(),
    date,
  };

  state.data.shifts.push(pastedShift);
  saveData();
  notifyTeam("Shift pasted", `${findEmployee(pastedShift.employeeId).name}: ${formatDateShort(parseDateKey(date))}, ${pastedShift.start} to ${pastedShift.end}`);
  syncSaveStatus("Shift pasted");
  render();
}

function openEmployeeModal(employeeId = null) {
  state.editingEmployeeId = employeeId;
  const employee = employeeId
    ? findEmployee(employeeId)
    : {
        name: "",
        initials: "",
        role: "Team member",
        phone: "",
        status: "Available",
      };

  document.querySelector("#employeeModalTitle").textContent = employeeId ? "Edit employee" : "New employee";

  Object.entries(employee).forEach(([key, value]) => {
    if (employeeForm.elements[key]) employeeForm.elements[key].value = value;
  });

  deleteEmployeeButton.classList.toggle("hidden", !employeeId);
  employeeModal.classList.remove("hidden");
  employeeForm.elements.name.focus();
}

function closeEmployeeModal() {
  employeeModal.classList.add("hidden");
  state.editingEmployeeId = null;
  employeeForm.reset();
}

function syncShell() {
  brandName.textContent = state.data.businessName;
  brandSubtitle.textContent = state.data.businessSubtitle;
  brandFallback.textContent = makeInitials(state.data.businessName);
  document.title = state.data.businessName;
}

function syncSaveStatus(message = null, isError = false) {
  if (!saveStatus) return;
  saveStatus.classList.toggle("error", isError);
  if (message) {
    saveStatus.textContent = message;
    return;
  }

  if (state.cloudStatus === "loading") {
    saveStatus.textContent = "Loading shared data";
    return;
  }

  if (state.cloudStatus === "syncing") {
    saveStatus.textContent = "Syncing online";
    return;
  }

  if (state.cloudStatus === "synced") {
    saveStatus.textContent = state.data.savedAt ? `Synced online ${formatTime(state.data.savedAt)}` : "Synced online";
    return;
  }

  if (state.cloudStatus === "offline") {
    saveStatus.textContent = "Saved on this device";
    saveStatus.classList.add("error");
    return;
  }

  saveStatus.textContent = state.data.savedAt ? `Saved locally ${formatTime(state.data.savedAt)}` : "Saved locally";
}

function syncAuthScreen() {
  const signedIn = Boolean(state.authUser);
  authScreen.classList.toggle("hidden", signedIn);
  accountStatus.textContent = signedIn ? `${state.authUser.name} (${state.authUser.role})` : "Signed out";
  signOutButton.classList.toggle("hidden", !signedIn);

  if (signedIn) return;

  authNameField.classList.toggle("hidden", !state.setupRequired);
  authForm.elements.name.required = state.setupRequired;
  authForm.elements.password.autocomplete = state.setupRequired ? "new-password" : "current-password";
  authTitle.textContent = state.setupRequired ? "Create owner account" : "Sign in";
  authIntro.textContent = state.setupRequired
    ? "Create the first admin account for Marshal."
    : "Use your Marshal email and password.";
  authSubmitButton.textContent = state.setupRequired ? "Create account" : "Sign in";
}

async function initAuth() {
  if (!canUseCloudSync()) {
    state.setupRequired = false;
    authError.textContent = "Sign in works after Marshal is deployed to Netlify over HTTPS.";
    syncAuthScreen();
    return;
  }

  try {
    const payload = await authRequest(null, "GET");
    state.authUser = payload.user || null;
    state.setupRequired = Boolean(payload.setupRequired);
    state.authUsers = payload.users || [];
    if (!state.authUser && state.authToken) {
      state.authToken = null;
      localStorage.removeItem(authTokenKey);
    }

    if (state.authUser) {
      syncAuthScreen();
      loadCloudData();
    } else {
      syncAuthScreen();
    }
  } catch (error) {
    state.authUser = null;
    state.setupRequired = false;
    authError.textContent = error.message || "Could not connect to sign in.";
    syncAuthScreen();
    console.error(error);
  }
}

async function submitAuth(event) {
  event.preventDefault();
  authError.textContent = "";
  authSubmitButton.disabled = true;

  try {
    const formData = new FormData(authForm);
    const action = state.setupRequired ? "setup" : "login";
    const payload = await authRequest(
      {
        action,
        name: formData.get("name"),
        email: formData.get("email"),
        password: formData.get("password"),
      },
      "POST",
    );

    state.authToken = payload.token;
    state.authUser = payload.user;
    state.authUsers = payload.users || [];
    state.setupRequired = false;
    localStorage.setItem(authTokenKey, state.authToken);
    authForm.reset();
    syncAuthScreen();
    syncSaveStatus("Signed in");
    loadCloudData();
  } catch (error) {
    authError.textContent = error.message || "Sign in failed";
  } finally {
    authSubmitButton.disabled = false;
  }
}

async function signOut() {
  try {
    if (state.authToken) {
      await authRequest({ action: "logout" }, "POST");
    }
  } catch (error) {
    console.error(error);
  }

  state.authToken = null;
  state.authUser = null;
  state.authUsers = [];
  localStorage.removeItem(authTokenKey);
  state.cloudStatus = "local";
  syncSaveStatus("Signed out");
  initAuth();
}

async function createAccount(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);

  try {
    const payload = await authRequest(
      {
        action: "create-user",
        name: formData.get("name"),
        email: formData.get("email"),
        password: formData.get("password"),
        role: formData.get("role"),
      },
      "POST",
    );

    state.authUsers = payload.users || [];
    event.currentTarget.reset();
    syncSaveStatus("Login account added");
    render();
  } catch (error) {
    syncSaveStatus(error.message || "Could not add account", true);
  }
}

async function deleteAccount(userId) {
  if (typeof confirm === "function" && !confirm("Remove this login account?")) return;

  try {
    const payload = await authRequest({ action: "delete-user", userId }, "POST");
    state.authUsers = payload.users || [];
    syncSaveStatus("Login account removed");
    render();
  } catch (error) {
    syncSaveStatus(error.message || "Could not remove account", true);
  }
}

async function authRequest(body = null, method = "POST") {
  const options = {
    method,
    headers: {
      Accept: "application/json",
    },
  };

  if (state.authToken) {
    options.headers.Authorization = `Bearer ${state.authToken}`;
  }

  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(authApiPath, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("Sign-in service is not deployed. Check Netlify Functions.");
    }

    if (response.status === 500 || response.status === 502) {
      throw new Error(payload.detail || payload.error || "Sign-in service errored. Check Netlify Function logs.");
    }

    throw new Error(payload.error || "Sign-in request failed");
  }

  return payload;
}

function authHeaders(extraHeaders = {}) {
  return {
    ...extraHeaders,
    ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
  };
}

function syncInstallButton() {
  const installed = isStandaloneApp() || state.data.appInstalled;
  installAppButton.textContent = installed ? "Installed" : "Install app";
  installAppButton.disabled = installed;
}

function syncNotificationButton() {
  if (!supportsNotifications()) {
    notificationButton.textContent = "Notifications unavailable";
    notificationButton.disabled = true;
    state.data.notificationsEnabled = false;
    return;
  }

  const notificationApi = window.Notification;

  if (notificationApi.permission === "granted") {
    notificationButton.textContent = "Notifications on";
    notificationButton.disabled = false;
    state.data.notificationsEnabled = true;
    return;
  }

  if (notificationApi.permission === "denied") {
    notificationButton.textContent = "Notifications blocked";
    notificationButton.disabled = true;
    state.data.notificationsEnabled = false;
    return;
  }

  notificationButton.textContent = "Enable notifications";
  notificationButton.disabled = false;
}

function registerServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  navigator.serviceWorker.register("./service-worker.js").catch((error) => {
    console.error(error);
  });
}

async function installApp() {
  if (isStandaloneApp() || state.data.appInstalled) {
    syncSaveStatus("App already installed");
    syncInstallButton();
    return;
  }

  if (!state.deferredInstallPrompt) {
    syncSaveStatus("Use browser menu to add to home screen");
    return;
  }

  state.deferredInstallPrompt.prompt();
  const choice = await state.deferredInstallPrompt.userChoice;
  state.deferredInstallPrompt = null;

  if (choice.outcome === "accepted") {
    state.data.appInstalled = true;
    saveData();
    syncSaveStatus("App installed");
  } else {
    syncSaveStatus("Install cancelled");
  }

  syncInstallButton();
}

async function requestNotifications() {
  if (!supportsNotifications()) {
    syncSaveStatus("Notifications unavailable", true);
    syncNotificationButton();
    return;
  }

  const notificationApi = window.Notification;

  if (notificationApi.permission === "denied") {
    state.data.notificationsEnabled = false;
    saveData();
    syncSaveStatus("Notifications blocked", true);
    syncNotificationButton();
    return;
  }

  const permission = notificationApi.permission === "granted" ? "granted" : await notificationApi.requestPermission();
  state.data.notificationsEnabled = permission === "granted";
  saveData();
  syncNotificationButton();

  if (permission === "granted") {
    notifyTeam("Marshal notifications enabled", "This device can receive Marshal alerts.", true);
  } else {
    syncSaveStatus("Notifications not enabled");
  }
}

function notifyTeam(title, body, force = false) {
  if (!force && !state.data.notificationsEnabled) return;
  if (!supportsNotifications() || window.Notification.permission !== "granted") {
    syncNotificationButton();
    return;
  }

  const options = {
    body,
    icon: "assets/marshal-icon-192.png",
    badge: "assets/marshal-icon-192.png",
    tag: `marshal-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  };

  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    navigator.serviceWorker.ready
      .then((registration) => registration.showNotification(title, options))
      .catch(() => new window.Notification(title, options));
    return;
  }

  new window.Notification(title, options);
}

function supportsNotifications() {
  return typeof window !== "undefined" && "Notification" in window;
}

function isStandaloneApp() {
  return (
    (typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches) ||
    (typeof navigator !== "undefined" && navigator.standalone === true)
  );
}

function hydrateUserSelect() {
  if (!state.data.employees.some((employee) => employee.id === state.data.currentUserId)) {
    state.data.currentUserId = state.data.employees[0]?.id || null;
  }

  userSelect.disabled = !state.data.employees.length;
  userSelect.innerHTML = state.data.employees.length
    ? state.data.employees.map((employee) => `<option value="${employee.id}">${employee.name}</option>`).join("")
    : `<option value="">Add employees first</option>`;
  userSelect.value = state.data.currentUserId || "";
}

function loadData() {
  let saved = localStorage.getItem(storageKey);
  let migratedFromLegacy = false;

  if (!saved) {
    const legacyKey = legacyStorageKeys.find((key) => localStorage.getItem(key));
    if (legacyKey) {
      saved = localStorage.getItem(legacyKey);
      migratedFromLegacy = true;
    }
  }

  if (!saved) return createSeedData();

  try {
    const parsed = JSON.parse(saved);
    const normalized = normalizeData(parsed);
    if (migratedFromLegacy) localStorage.setItem(storageKey, JSON.stringify(normalized));
    return normalized;
  } catch {
    return createSeedData();
  }
}

function saveData(options = {}) {
  state.data.savedAt = new Date().toISOString();
  if (options.syncCloud !== false && state.cloudStatus === "loading") {
    state.localChangedDuringCloudLoad = true;
  }

  try {
    localStorage.setItem(storageKey, JSON.stringify(state.data));
    syncSaveStatus();
    if (options.syncCloud !== false) queueCloudSave();
  } catch (error) {
    syncSaveStatus("Save failed", true);
    console.error(error);
  }
}

async function loadCloudData() {
  if (!state.authToken) {
    state.cloudStatus = "local";
    syncSaveStatus();
    return;
  }

  if (!canUseCloudSync()) {
    state.cloudStatus = "local";
    syncSaveStatus();
    return;
  }

  state.cloudStatus = "loading";
  syncSaveStatus();

  try {
    const response = await fetch(cloudApiPath, {
      method: "GET",
      cache: "no-store",
      headers: authHeaders({
        Accept: "application/json",
      }),
    });

    if (response.status === 401) {
      await handleAuthExpired();
      return;
    }

    if (!response.ok) throw new Error(`Cloud load failed: ${response.status}`);

    const payload = await response.json();
    if (payload.data) {
      if (state.localChangedDuringCloudLoad) {
        queueCloudSave();
        return;
      }

      state.data = normalizeData(payload.data);
      saveData({ syncCloud: false });
      syncShell();
      syncInstallButton();
      syncNotificationButton();
      hydrateUserSelect();
      render();
      state.cloudStatus = "synced";
      state.localChangedDuringCloudLoad = false;
      syncSaveStatus("Loaded shared data");
      return;
    }

    queueCloudSave();
  } catch (error) {
    state.cloudStatus = "offline";
    syncSaveStatus();
    console.error(error);
  }
}

function queueCloudSave() {
  if (!state.authToken) {
    state.cloudStatus = "local";
    syncSaveStatus();
    return;
  }

  if (!canUseCloudSync()) {
    state.cloudStatus = "local";
    syncSaveStatus();
    return;
  }

  state.cloudStatus = "syncing";
  syncSaveStatus();
  clearTimeout(state.cloudSaveTimer);
  state.cloudSaveTimer = setTimeout(saveCloudData, 500);
}

async function saveCloudData() {
  if (!state.authToken) return;
  if (!canUseCloudSync()) return;

  try {
    const response = await fetch(cloudApiPath, {
      method: "POST",
      headers: authHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ data: state.data }),
    });

    if (response.status === 401) {
      await handleAuthExpired();
      return;
    }

    if (!response.ok) throw new Error(`Cloud save failed: ${response.status}`);

    state.cloudStatus = "synced";
    state.localChangedDuringCloudLoad = false;
    syncSaveStatus();
  } catch (error) {
    state.cloudStatus = "offline";
    syncSaveStatus();
    console.error(error);
  }
}

async function handleAuthExpired() {
  state.authToken = null;
  state.authUser = null;
  state.authUsers = [];
  localStorage.removeItem(authTokenKey);
  state.cloudStatus = "local";
  syncSaveStatus("Session expired", true);
  await initAuth();
}

function canUseCloudSync() {
  return (
    typeof window !== "undefined" &&
    typeof fetch === "function" &&
    (window.location?.protocol === "https:" || window.location?.hostname === "localhost" || window.location?.hostname === "127.0.0.1")
  );
}

function exportBackup() {
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    app: "Marshal",
    data: state.data,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `marshal-backup-${toDateKey(new Date())}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  syncSaveStatus("Backup exported");
}

function importBackup(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const parsed = JSON.parse(reader.result);
      const importedData = parsed.data || parsed;
      state.data = normalizeData(importedData);
      saveData();
      syncShell();
      hydrateUserSelect();
      render();
      syncSaveStatus("Backup imported");
    } catch (error) {
      syncSaveStatus("Import failed", true);
      console.error(error);
    }
  });
  reader.readAsText(file);
}

function normalizeData(data) {
  const defaults = createSeedData();
  const merged = {
    ...defaults,
    ...data,
  };

  merged.employees = Array.isArray(data.employees) ? data.employees : defaults.employees;
  merged.channels = Array.isArray(data.channels) && data.channels.length ? data.channels : defaults.channels;
  merged.shifts = Array.isArray(data.shifts) ? data.shifts : defaults.shifts;
  merged.messages = Array.isArray(data.messages) ? data.messages : defaults.messages;
  merged.requests = Array.isArray(data.requests) ? data.requests : defaults.requests;
  merged.areas = Array.isArray(data.areas) && data.areas.length ? data.areas : inferAreas(merged, defaults.areas);
  merged.businessName = !data.businessName || data.businessName === "ShiftLink" ? defaults.businessName : data.businessName;
  merged.businessSubtitle =
    !data.businessSubtitle || data.businessSubtitle === "Business workforce" ? defaults.businessSubtitle : data.businessSubtitle;
  merged.appInstalled = Boolean(data.appInstalled);
  merged.notificationsEnabled = Boolean(data.notificationsEnabled);

  merged.employees = merged.employees.map((employee) => ({
    ...employee,
    initials: employee.initials || makeInitials(employee.name),
    status: employee.status || "Available",
  }));

  if (!merged.channels.some((channel) => channel.id === merged.activeChannel)) {
    merged.activeChannel = merged.channels[0].id;
  }

  if (!merged.employees.some((employee) => employee.id === merged.currentUserId)) {
    merged.currentUserId = merged.employees[0]?.id || null;
  }

  return merged;
}

function createSeedData() {
  const areas = ["General", "Landscaping", "Maintenance", "Construction", "Admin"];

  return {
    businessName: "Marshal",
    businessSubtitle: "Rock N Water Landscapes",
    appInstalled: false,
    notificationsEnabled: false,
    currentUserId: null,
    activeChannel: "ops",
    areas,
    employees: [],
    channels: [
      {
        id: "announcements",
        name: "Announcements",
        description: "Company-wide updates and policy notes",
      },
      {
        id: "ops",
        name: "Operations",
        description: "Daily handover and shift coordination",
      },
      {
        id: "managers",
        name: "Managers",
        description: "Roster, coverage, and approval discussion",
      },
    ],
    shifts: [],
    messages: [],
    requests: [],
  };
}

function getCurrentUser() {
  return findEmployee(state.data.currentUserId);
}

function getActiveChannel() {
  return state.data.channels.find((channel) => channel.id === state.data.activeChannel) || state.data.channels[0];
}

function findEmployee(employeeId) {
  return (
    state.data.employees.find((employee) => employee.id === employeeId) || {
      id: null,
      name: "Unassigned",
      initials: "--",
      role: "",
      phone: "",
      status: "Unavailable",
    }
  );
}

function shiftsForDate(dateKey) {
  return state.data.shifts
    .filter((shift) => shift.date === dateKey)
    .sort((a, b) => a.start.localeCompare(b.start));
}

function inferAreas(data, fallbackAreas) {
  const values = new Set(fallbackAreas);
  data.shifts.forEach((shift) => {
    if (shift.area) values.add(shift.area);
  });
  return Array.from(values);
}

function areaUsage(area) {
  return state.data.shifts.filter((shift) => shift.area === area).length;
}

function isAreaInUse(area) {
  return areaUsage(area) > 0;
}

function uniqueSlug(value, existing) {
  const base =
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "channel";
  let slug = base;
  let counter = 2;
  while (existing.includes(slug)) {
    slug = `${base}-${counter}`;
    counter += 1;
  }
  return slug;
}

function makeInitials(value) {
  const words = String(value)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "SL";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function startOfWeek(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  const day = copy.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + offset);
  return copy;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function toDateKey(date) {
  const copy = new Date(date);
  const year = copy.getFullYear();
  const month = String(copy.getMonth() + 1).padStart(2, "0");
  const day = String(copy.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatLongDate(date) {
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(date));
}

function formatDateShort(date) {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
  }).format(new Date(date));
}

function formatWeekday(date) {
  return new Intl.DateTimeFormat("en-AU", { weekday: "short" }).format(new Date(date));
}

function formatTime(date) {
  return new Intl.DateTimeFormat("en-AU", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

function formatMessageDate(date) {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
